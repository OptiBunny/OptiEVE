import { EveError } from './eve';
import { readBlueprintCollection, validateBlueprintCollectionArgs } from './blueprint-collection';

const resultLimit = 16 * 1024 * 1024;
const totalLimit = 17 * 1024 * 1024;
class StreamLimitError extends Error {}
type Reader = typeof readBlueprintCollection;

/** One request-local stream. Only bounded progress and sanitized final data leave it. */
export function createBlueprintCollectionResponder(read: Reader) {
  return (user: string, input: unknown, signal?: AbortSignal): Response => {
    if (typeof user !== 'string' || !user) throw new EveError('Sign in to this private connector first.', 401);
    const args = validateBlueprintCollectionArgs(input);
    signal?.throwIfAborted();
    const cancellation = new AbortController();
    const combined = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
    const encoder = new TextEncoder();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let bytes = 0, progressEvents = 0, transportError: unknown;
        const emit = (value: unknown, maximum: number) => {
          if (cancelled || combined.aborted) return;
          const line = JSON.stringify(value) + '\n';
          // UTF-8 bytes are never fewer than UTF-16 code units for JSON text.
          if (line.length > maximum) throw new StreamLimitError();
          const chunk = encoder.encode(line);
          if (chunk.byteLength > maximum || bytes + chunk.byteLength > totalLimit) throw new StreamLimitError();
          bytes += chunk.byteLength;
          controller.enqueue(chunk);
        };
        const run = async () => {
          try {
            const result = await read(user, args, { signal: combined, onProgress(progress) {
              if (cancelled || combined.aborted) return;
              try {
                if (++progressEvents > 128) throw new StreamLimitError();
                emit({ type: 'progress', progress }, 4096);
              } catch (error) {
                transportError = error;
                cancellation.abort();
                throw error;
              }
            } });
            if (transportError) throw transportError;
            emit({ type: 'result', result }, resultLimit);
          } catch (error) {
            // Aborted consumers receive no late result. A transport budget
            // failure still gets one small, fixed error when the reader is open.
            if (!cancelled && (!combined.aborted || transportError)) {
              const allowed = [400, 401, 403, 404, 409, 413, 429, 500, 502, 504];
              const status = error instanceof StreamLimitError ? 413 : error instanceof EveError && allowed.includes(error.status) ? error.status : 502;
              const message = status === 413 ? 'The blueprint response exceeded the safe display limit.' : 'Blueprint collection could not be completed. Review the connection and try again.';
              const chunk = encoder.encode(JSON.stringify({ type: 'error', message, status }) + '\n');
              controller.enqueue(chunk);
            }
          } finally {
            if (!cancelled) controller.close();
          }
        };
        // The task owns its rejection path; nothing is detached to a background service.
        void run();
      },
      cancel() { cancelled = true; cancellation.abort(); },
    });
    return new Response(body, { headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'Vary': 'oai-authenticated-user-id, Cookie',
      'X-Content-Type-Options': 'nosniff',
    } });
  };
}

export const blueprintCollectionResponse = createBlueprintCollectionResponder(readBlueprintCollection);
