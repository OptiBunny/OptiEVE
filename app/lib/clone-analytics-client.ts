import { z } from 'zod';
import { ConnectionResponseError } from './connection-client';
import type { CloneAnalytics, CloneAnalyticsRequest, CloneImplant } from './clone-analytics-types';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const id = count.min(1);
const text = z.string().max(2048);
const name = z.string().min(1).max(512).refine(value => value.trim() === value && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value));
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const status = z.enum(['ready', 'partial', 'needs_permission', 'unavailable', 'error']);
const freshness = z.enum(['fresh', 'stale', 'unknown']);
const locationType = z.enum(['station', 'structure']);
const implant = z.strictObject({ typeId: id, name, mapped: z.boolean() }).refine(value => value.mapped || value.name === `Type ${value.typeId}`);
const implants = z.array(implant).max(64);
const active = z.strictObject({ implantCount: count.max(64), unmappedImplants: count.max(64), implants });
const clones = z.strictObject({
  homeLocation: z.strictObject({ locationId: id.nullable(), locationType: locationType.nullable() }).nullable(),
  lastCloneJumpAt: date.nullable(), lastHomeStationChangeAt: date.nullable(),
  cloneCount: count.max(100), totalStoredImplants: count.max(6400), unmappedImplants: count.max(6400),
  clones: z.array(z.strictObject({ row: id.max(100), locationId: id, locationType, implants })).max(100),
});
const section = <T extends z.ZodType>(data: T, scope: string) => z.strictObject({ status, scope: z.literal(scope), message: text, retrievedAt: date.nullable(), cacheExpires: date.nullable(), freshness, data: data.nullable() });
const schema = z.strictObject({
  characterId: id, generatedAt: date, status, message: text,
  clones: section(clones, 'esi-clones.read_clones.v1'), implants: section(active, 'esi-clones.read_implants.v1'),
});
const argsSchema = z.strictObject({ characterId: id });
const invalid = () => new ConnectionResponseError('The clone service returned an incomplete response. Refresh and try again.');
const invalidSelection = () => new ConnectionResponseError('Choose one connected character before loading clones.');
function selectedArgs(input: unknown): CloneAnalyticsRequest {
  const parsed = argsSchema.safeParse(input);
  if (input === null || typeof input !== 'object' || !Object.hasOwn(input, 'characterId') || !parsed.success) throw invalidSelection();
  return parsed.data;
}

export function cloneAnalyticsResponse(value: unknown, args: CloneAnalyticsRequest): CloneAnalytics {
  const selected = selectedArgs(args);
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data.characterId !== selected.characterId) throw invalid();
  const result = parsed.data, generated = Date.parse(result.generatedAt), sections = [result.clones, result.implants];
  for (const part of sections) {
    if (part.data === null) {
      if (['ready', 'partial'].includes(part.status) || part.retrievedAt !== null || part.cacheExpires !== null || part.freshness !== 'unknown') throw invalid();
    } else if (part.retrievedAt === null || Date.parse(part.retrievedAt) > generated + 60000 ||
        part.freshness !== (part.cacheExpires === null ? 'unknown' : Date.parse(part.cacheExpires) <= generated ? 'stale' : 'fresh') ||
        part.status !== (part.freshness === 'fresh' ? 'ready' : 'partial')) throw invalid();
  }
  const expectedStatus = sections.every(part => part.status === 'ready') ? 'ready' : sections.some(part => part.data !== null) ? 'partial'
    : sections.every(part => part.status === 'needs_permission') ? 'needs_permission' : sections.some(part => part.status === 'error') ? 'error' : 'unavailable';
  if (result.status !== expectedStatus) throw invalid();
  const all: CloneImplant[] = [];
  if (result.implants.data) {
    const data = result.implants.data;
    if (data.implantCount !== data.implants.length || data.unmappedImplants !== data.implants.filter(row => !row.mapped).length) throw invalid();
    all.push(...data.implants);
  }
  if (result.clones.data) {
    const data = result.clones.data, stored = data.clones.flatMap(row => row.implants);
    if (data.cloneCount !== data.clones.length || data.clones.some((row, index) => row.row !== index + 1) ||
        data.totalStoredImplants !== stored.length || data.unmappedImplants !== stored.filter(row => !row.mapped).length ||
        [data.lastCloneJumpAt, data.lastHomeStationChangeAt].some(value => value !== null && Date.parse(value) > Date.parse(result.clones.retrievedAt!) + 60000)) throw invalid();
    all.push(...stored);
  }
  // Type IDs can repeat: they identify types, not unique physical implants.
  // Their catalog labels must remain consistent throughout one projection.
  const labels = new Map<number, CloneImplant>();
  for (const row of all) {
    const prior = labels.get(row.typeId);
    if (prior && (prior.name !== row.name || prior.mapped !== row.mapped)) throw invalid();
    labels.set(row.typeId, row);
  }
  return result;
}

async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let cancel: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); });
  void interrupted.catch(() => {});
  try { const value = await Promise.race([work(), interrupted]); signal.throwIfAborted(); return value; }
  finally { signal.removeEventListener('abort', cancel); }
}

/** One explicit read, bounded in time and response bytes; nothing is persisted. */
export async function fetchCloneAnalytics(input: CloneAnalyticsRequest, signal?: AbortSignal): Promise<CloneAnalytics> {
  const args = selectedArgs(input), controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(abort, 60000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await abortable(() => fetch('/api/eve/clone-analytics', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: controller.signal }), controller.signal);
    if (!response.ok) throw new ConnectionResponseError(response.status === 401 ? 'Sign in again to load clones and implants.' : response.status === 404 ? 'This character is no longer connected. Reload connection status.' : 'Clones and implants could not be loaded. Try again or review the connection.', response.status);
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || !response.body) throw invalid();
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let received = 0, body = '';
    while (true) {
      const chunk = await abortable(() => reader!.read(), controller.signal);
      if (chunk.done) { body += decoder.decode(); break; }
      received += chunk.value.byteLength;
      if (received > 16 * 1024 * 1024) throw invalid();
      body += decoder.decode(chunk.value, { stream: true });
    }
    controller.signal.throwIfAborted();
    return cloneAnalyticsResponse(JSON.parse(body), args);
  } catch (error) {
    const cancelled = controller.signal.aborted; controller.abort();
    if (error instanceof ConnectionResponseError) throw error;
    throw new ConnectionResponseError(cancelled ? 'The clone request was cancelled or timed out.' : 'The clone response could not be read safely. Refresh and try again.');
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* A pending read can already have released the lock. */ } }
  }
}
