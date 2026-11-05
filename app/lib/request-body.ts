export class RequestBodyTooLargeError extends Error {
  constructor() { super('Request too large.'); }
}

// Read in bytes, retaining at most the configured limit. Drain overflow instead
// of cancelling: an unread transferred body can break the next Wrangler request
// on Windows. A sender that keeps uploading can still delay the response.
export async function readRequestBody(request: Request, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('Invalid request body limit.');
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0, exceeded = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (exceeded) continue;
      if (value.byteLength > maxBytes - size) {
        exceeded = true;
        chunks.length = 0;
        continue;
      }
      size += value.byteLength;
      if (value.byteLength) chunks.push(value.slice());
    }
  } finally { reader.releaseLock(); }
  if (exceeded) throw new RequestBodyTooLargeError();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function drainRequestBody(request: Request): Promise<void> {
  if (request.body === null || request.bodyUsed) return;
  try {
    const reader = request.body.getReader();
    try { while (!(await reader.read()).done) { /* Discard without retaining content. */ } }
    finally { reader.releaseLock(); }
  } catch {
    // A disconnected sender must not replace the intended HTTP response.
  }
}
