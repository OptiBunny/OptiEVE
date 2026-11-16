import { z } from 'zod';
import { ConnectionResponseError } from './connection-client';
import type { CalendarAnalytics, CalendarAnalyticsArgs } from './calendar-analytics-types';

const count = z.number().int().min(0).max(50), id = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().length(24).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const day = z.string().length(10).regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value);
const response = z.enum(['accepted', 'declined', 'tentative', 'not_responded']).nullable();
const responseOrder = ['accepted', 'declined', 'tentative', 'not_responded', null] as const;
const text = z.string().max(2048), argsSchema = z.strictObject({ characterId: id, fromEvent: id.optional() });
const safeTitle = z.string().max(512).refine(value => Array.from(value).length <= 256 && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value) && !Array.from(value).some(character => character.length === 1 && /[\ud800-\udfff]/.test(character)));
const schema = z.strictObject({
  characterId: id, generatedAt: timestamp, status: z.enum(['ready', 'partial', 'needs_permission', 'unavailable', 'error']), message: text, scope: z.literal('esi-calendar.read_calendar_events.v1'),
  coverage: z.strictObject({ kind: z.enum(['returned_batch', 'unavailable']), fromEvent: id.nullable(), nextFromEvent: id.nullable(), continuation: z.enum(['available', 'empty', 'missing_last_id', 'unchanged_cursor', 'unavailable']), events: count }),
  freshness: z.strictObject({ state: z.enum(['fresh', 'stale', 'unknown']), retrievedAt: timestamp.nullable(), cacheExpires: timestamp.nullable(), lastModified: timestamp.nullable() }),
  summary: z.strictObject({ events: count, datedEvents: count, missingEventIds: count, missingTitles: count, emptyTitles: count, redactedTitles: count, missingImportance: count }).nullable(),
  responseCounts: z.array(z.strictObject({ response, events: count })).max(5),
  schedule: z.strictObject({ asOf: timestamp, horizonDays: z.literal(30), pastOrNowEvents: count, next24hEvents: count, days2To7Events: count, days8To30Events: count, laterEvents: count, missingDateEvents: count, daily: z.array(z.strictObject({ date: day, events: count.min(1) })).max(31) }).nullable(),
  events: z.array(z.strictObject({ row: count.min(1), eventId: id.nullable(), date: timestamp.nullable(), response, importance: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(), title: safeTitle.nullable(), titleState: z.enum(['missing', 'reported', 'redacted']), titleTruncated: z.boolean() })).max(50),
  limitations: z.array(text).max(16),
});
const invalid = () => new ConnectionResponseError('The calendar response could not be validated safely. Load it again.');
const invalidSelection = () => new ConnectionResponseError('Choose one connected character and an optional positive calendar cursor.');
function selection(value: unknown): CalendarAnalyticsArgs {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'characterId') || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['characterId', 'fromEvent'].includes(key)) || 'fromEvent' in value && (!Object.hasOwn(value, 'fromEvent') || value.fromEvent === undefined)) throw invalidSelection();
  const parsed = argsSchema.safeParse(value); if (!parsed.success) throw invalidSelection(); return parsed.data;
}
export function calendarAnalyticsResponse(value: unknown, input: CalendarAnalyticsArgs): CalendarAnalytics {
  const selected = selection(input), parsed = schema.safeParse(value); if (!parsed.success) throw invalid();
  const result = parsed.data, coverage = result.coverage, fresh = result.freshness, now = Date.parse(result.generatedAt), from = selected.fromEvent ?? null;
  if (result.characterId !== selected.characterId || coverage.fromEvent !== from) throw invalid();
  if (!['ready', 'partial'].includes(result.status)) {
    if (coverage.kind !== 'unavailable' || coverage.continuation !== 'unavailable' || coverage.events !== 0 || coverage.nextFromEvent !== null || result.summary !== null || result.schedule !== null || result.events.length || result.responseCounts.length || fresh.state !== 'unknown' || fresh.retrievedAt !== null || fresh.cacheExpires !== null || fresh.lastModified !== null) throw invalid();
    return result;
  }
  const events = result.events, summary = result.summary, schedule = result.schedule, lastId = events.at(-1)?.eventId ?? null;
  const continuation = events.length === 0 ? 'empty' : lastId === null ? 'missing_last_id' : lastId === from ? 'unchanged_cursor' : 'available';
  const freshness = fresh.cacheExpires === null ? 'unknown' : Date.parse(fresh.cacheExpires) <= now ? 'stale' : 'fresh';
  if (coverage.kind !== 'returned_batch' || coverage.events !== events.length || coverage.continuation !== continuation || coverage.nextFromEvent !== (continuation === 'available' ? lastId : null) || fresh.retrievedAt === null || Date.parse(fresh.retrievedAt) > now + 60000 || fresh.state !== freshness || result.status !== (freshness === 'fresh' ? 'ready' : 'partial') || summary === null || schedule === null || schedule.asOf !== result.generatedAt) throw invalid();
  const ids = events.filter(row => row.eventId !== null).map(row => row.eventId);
  if (new Set(ids).size !== ids.length || events.some((row, index) => row.row !== index + 1 || (row.titleState === 'reported' ? row.title === null || row.titleTruncated && Array.from(row.title).length !== 256 : row.title !== null || row.titleTruncated))) throw invalid();
  const expected = { events: events.length, datedEvents: events.filter(row => row.date !== null).length, missingEventIds: events.filter(row => row.eventId === null).length,
    missingTitles: events.filter(row => row.titleState === 'missing').length, emptyTitles: events.filter(row => row.titleState === 'reported' && row.title === '').length, redactedTitles: events.filter(row => row.titleState === 'redacted').length, missingImportance: events.filter(row => row.importance === null).length };
  if (Object.entries(expected).some(([key, value]) => summary[key as keyof typeof expected] !== value) || result.responseCounts.length !== responseOrder.length || responseOrder.some((response, index) => result.responseCounts[index].response !== response || result.responseCounts[index].events !== events.filter(row => row.response === response).length)) throw invalid();
  const offsets = events.filter(row => row.date !== null).map(row => Date.parse(row.date!) - now), dayMs = 86400000;
  if (schedule.pastOrNowEvents !== offsets.filter(value => value <= 0).length || schedule.next24hEvents !== offsets.filter(value => value > 0 && value <= dayMs).length || schedule.days2To7Events !== offsets.filter(value => value > dayMs && value <= 7 * dayMs).length || schedule.days8To30Events !== offsets.filter(value => value > 7 * dayMs && value <= 30 * dayMs).length || schedule.laterEvents !== offsets.filter(value => value > 30 * dayMs).length || schedule.missingDateEvents !== events.length - offsets.length) throw invalid();
  const future = events.filter(row => row.date !== null && Date.parse(row.date) > now && Date.parse(row.date) <= now + 30 * dayMs);
  const dates = [...new Set(future.map(row => row.date!.slice(0, 10)))].sort();
  if (schedule.daily.length !== dates.length || dates.some((date, index) => schedule.daily[index].date !== date || schedule.daily[index].events !== future.filter(row => row.date!.slice(0, 10) === date).length)) throw invalid();
  return result;
}

async function readBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw invalid();
  const limit = 256 * 1024, reader = response.body.getReader(); let buffer = new Uint8Array(16384), length = 0;
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
export async function calendarAnalyticsRequest(args: CalendarAnalyticsArgs, signal?: AbortSignal): Promise<CalendarAnalytics> {
  const selected = selection(args), controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(abort, 60000); let response: Response | undefined;
  try {
    controller.signal.throwIfAborted(); response = await fetch('/api/eve/calendar-analytics', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selected), signal: controller.signal }); controller.signal.throwIfAborted();
    if (!response.ok) throw new ConnectionResponseError(response.status === 401 ? 'Sign in again to read calendar summaries.' : response.status === 404 ? 'This character is no longer connected. Reload connection status.' : 'Calendar summaries could not be loaded. Try again or review the connection.', response.status);
    if (!response.headers.get('content-type')?.includes('application/json')) throw invalid();
    return calendarAnalyticsResponse(await readBody(response, controller.signal), selected);
  } catch (error) {
    if (error instanceof ConnectionResponseError) throw error;
    throw new ConnectionResponseError(controller.signal.aborted ? 'The calendar request was cancelled or timed out.' : 'The calendar service could not be reached. Try again.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
}
