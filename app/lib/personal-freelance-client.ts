import { z } from 'zod';
import { ConnectionResponseError } from './connection-client';
import type { PersonalFreelance, PersonalFreelanceArgs, FreelanceFreshness } from './personal-freelance-types';

const id = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), count = z.number().int().min(0).max(1000);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const timestamp = z.string().length(24).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const states = ['Unspecified', 'Active', 'Closed', 'Completed', 'Expired', 'Deleted'] as const;
const text = z.string().max(2048);
const name = z.string().max(512).refine(value => Array.from(value).length <= 256 && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value) && !Array.from(value).some(character => character.length === 1 && /[\ud800-\udfff]/.test(character)));
const money = z.string().max(341).regex(/^(?:0|[1-9]\d{0,15})\.\d{2,324}$/).refine(value => {
  if (!/^(?:0|[1-9]\d{0,15})\.\d{2,324}$/.test(value)) return false;
  const [whole, fraction] = value.split('.');
  return (fraction.length === 2 || !fraction.endsWith('0')) && (BigInt(whole) < BigInt(Number.MAX_SAFE_INTEGER) || BigInt(whole) === BigInt(Number.MAX_SAFE_INTEGER) && /^0+$/.test(fraction));
});
const freshness = z.strictObject({ state: z.enum(['fresh', 'stale', 'unknown']), retrievedAt: timestamp.nullable(), cacheExpires: timestamp.nullable(), lastModified: timestamp.nullable() });
const schema = z.strictObject({
  characterId: id, selectedJobId: uuid.nullable(), generatedAt: timestamp, status: z.enum(['ready', 'partial', 'needs_permission', 'unavailable', 'error']), scope: z.literal('esi-characters.read_freelance_jobs.v1'), message: text,
  coverage: z.strictObject({ kind: z.enum(['returned_list', 'unavailable']), jobs: count.nullable(), rowLimit: z.literal(1000) }), listFreshness: freshness,
  summary: z.strictObject({ jobs: count, withRewardReserve: count, withoutRewardReserve: count, redactedNames: count, truncatedNames: count }).nullable(),
  stateCounts: z.array(z.strictObject({ state: z.enum(states), jobs: count })).max(6),
  jobs: z.array(z.strictObject({ jobId: uuid, name: name.nullable(), nameState: z.enum(['reported', 'redacted']), nameTruncated: z.boolean(), state: z.enum(states), updatedAt: timestamp,
    progress: z.strictObject({ current: integer, desired: integer }), rewardReserve: z.strictObject({ initialISK: money, remainingISK: money }).nullable() })).max(1000),
  participation: z.strictObject({ status: z.enum(['not_requested', 'not_listed', 'ready', 'unavailable', 'error']), message: text, freshness,
    data: z.strictObject({ state: z.enum(['Unspecified', 'Committed', 'Kicked', 'Resigned']), contributed: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), updatedAt: timestamp }).nullable() }),
  limitations: z.array(text).max(16),
});
const invalid = () => new ConnectionResponseError('The freelance response could not be validated safely. Load it again.');
function selection(value: unknown): PersonalFreelanceArgs {
  const fail = () => new ConnectionResponseError('Choose one connected character and, optionally, one freelance job UUID.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail();
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !['characterId', 'jobId'].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'))) throw fail();
  for (const key in value) if (!Object.hasOwn(value, key)) throw fail();
  if (!Object.hasOwn(value, 'characterId') || !id.safeParse((value as PersonalFreelanceArgs).characterId).success) throw fail();
  const selected = value as PersonalFreelanceArgs;
  if ('jobId' in value && (!Object.hasOwn(value, 'jobId') || typeof selected.jobId !== 'string' || !uuid.safeParse(selected.jobId.toLowerCase()).success)) throw fail();
  return { characterId: selected.characterId, ...(selected.jobId === undefined ? {} : { jobId: selected.jobId.toLowerCase() }) };
}
const emptyFreshness = (value: FreelanceFreshness) => value.state === 'unknown' && value.retrievedAt === null && value.cacheExpires === null && value.lastModified === null;
function validFreshness(value: FreelanceFreshness, now: number): boolean {
  return value.retrievedAt !== null && Date.parse(value.retrievedAt) <= now + 60000 && value.state === (value.cacheExpires === null ? 'unknown' : Date.parse(value.cacheExpires) <= now ? 'stale' : 'fresh');
}
export function personalFreelanceResponse(value: unknown, input: PersonalFreelanceArgs): PersonalFreelance {
  const selected = selection(input), parsed = schema.safeParse(value); if (!parsed.success) throw invalid();
  const result = parsed.data, detail = result.participation, now = Date.parse(result.generatedAt), jobId = selected.jobId ?? null;
  if (result.characterId !== selected.characterId || result.selectedJobId !== jobId) throw invalid();
  if (!['ready', 'partial'].includes(result.status)) {
    if (result.summary !== null || result.coverage.kind !== 'unavailable' || result.coverage.jobs !== null || result.jobs.length || result.stateCounts.length || !emptyFreshness(result.listFreshness) || detail.status !== (jobId === null ? 'not_requested' : 'unavailable') || detail.data !== null || !emptyFreshness(detail.freshness)) throw invalid();
    return result;
  }
  const rows = result.jobs, summary = result.summary;
  if (!summary || result.coverage.kind !== 'returned_list' || result.coverage.jobs !== rows.length || !validFreshness(result.listFreshness, now)) throw invalid();
  if (new Set(rows.map(row => row.jobId)).size !== rows.length || rows.some((row, index) => index > 0 && (rows[index - 1].updatedAt < row.updatedAt || rows[index - 1].updatedAt === row.updatedAt && rows[index - 1].jobId > row.jobId) || (row.nameState === 'redacted' ? row.name !== null || row.nameTruncated : row.name === null || row.nameTruncated && Array.from(row.name).length !== 256))) throw invalid();
  const expected = { jobs: rows.length, withRewardReserve: rows.filter(row => row.rewardReserve !== null).length, withoutRewardReserve: rows.filter(row => row.rewardReserve === null).length, redactedNames: rows.filter(row => row.nameState === 'redacted').length, truncatedNames: rows.filter(row => row.nameTruncated).length };
  if (Object.entries(expected).some(([key, count]) => summary[key as keyof typeof expected] !== count) || result.stateCounts.length !== 6 || states.some((state, index) => result.stateCounts[index].state !== state || result.stateCounts[index].jobs !== rows.filter(row => row.state === state).length)) throw invalid();
  const listed = jobId !== null && rows.some(row => row.jobId === jobId);
  if (jobId === null ? detail.status !== 'not_requested' : !listed ? detail.status !== 'not_listed' : !['ready', 'unavailable', 'error'].includes(detail.status)) throw invalid();
  if (detail.status === 'ready' ? detail.data === null || !validFreshness(detail.freshness, now) : detail.data !== null || !emptyFreshness(detail.freshness)) throw invalid();
  const ready = result.listFreshness.state === 'fresh' && !summary.redactedNames && !summary.truncatedNames && (detail.status === 'not_requested' || detail.status === 'ready' && detail.freshness.state === 'fresh');
  if (result.status !== (ready ? 'ready' : 'partial')) throw invalid();
  return result;
}

async function readBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw invalid();
  const limit = 2 * 1024 * 1024, reader = response.body.getReader(); let buffer = new Uint8Array(16384), length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) { abort(); return; }
        reader.read().then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
      });
      signal.throwIfAborted(); if (part.done) break;
      if (!(part.value instanceof Uint8Array) || part.value.byteLength > limit - length) throw invalid();
      if (length + part.value.byteLength > buffer.length) { const next = new Uint8Array(Math.min(limit, Math.max(buffer.length * 2, length + part.value.byteLength))); next.set(buffer.subarray(0, length)); buffer = next; }
      buffer.set(part.value, length); length += part.value.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))); signal.throwIfAborted(); return value;
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function personalFreelanceRequest(args: PersonalFreelanceArgs, signal?: AbortSignal): Promise<PersonalFreelance> {
  const selected = selection(args), controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(abort, 60000); let response: Response | undefined;
  try {
    controller.signal.throwIfAborted(); response = await fetch('/api/eve/personal-freelance', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selected), signal: controller.signal }); controller.signal.throwIfAborted();
    if (!response.ok) throw new ConnectionResponseError(response.status === 401 ? 'Sign in again to read freelance participation.' : response.status === 404 ? 'This character is no longer connected. Reload connection status.' : 'Freelance evidence could not be loaded. Try again or review the connection.', response.status);
    if (!response.headers.get('content-type')?.includes('application/json')) throw invalid();
    return personalFreelanceResponse(await readBody(response, controller.signal), selected);
  } catch (error) {
    if (error instanceof ConnectionResponseError) throw error;
    throw new ConnectionResponseError(controller.signal.aborted ? 'The freelance request was cancelled or timed out.' : 'The freelance service could not be reached. Try again.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
}
