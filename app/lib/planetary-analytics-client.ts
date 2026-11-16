import { z } from 'zod';
import { ConnectionResponseError } from './connection-client';
import type { PlanetaryAnalytics, PlanetaryAnalyticsArgs } from './planetary-analytics-types';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), id = count.min(1), rows = count.max(1000);
const date = z.string().length(24).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const dayDate = z.string().length(10).regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
const text = z.string().max(2048), label = z.string().min(1).max(512).refine(value => value.trim() === value && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value));
const argsSchema = z.strictObject({ characterId: id, planetId: id });
const source = z.strictObject({ status: z.enum(['not_requested', 'ready', 'unavailable', 'error']), message: text, rows: rows.nullable(), freshness: z.strictObject({ state: z.enum(['fresh', 'stale', 'unknown']), retrievedAt: date.nullable(), cacheExpires: date.nullable(), lastModified: date.nullable() }) });
const schema = z.strictObject({
  characterId: id, planetId: id, generatedAt: date, status: z.enum(['ready', 'partial', 'needs_permission', 'unavailable', 'error']), message: text,
  scope: z.literal('esi-planets.manage_planets.v1'), simulationEvidence: z.literal('recalculated_when_viewed_in_eve_client'),
  colony: z.strictObject({ solarSystemId: id, planetType: z.enum(['temperate', 'barren', 'oceanic', 'ice', 'gas', 'lava', 'storm', 'plasma']), upgradeLevel: count, reportedPins: count, lastUpdateAt: date }).nullable(),
  sources: z.strictObject({ colonies: source, layout: source }),
  summary: z.strictObject({ pins: rows, extractorPins: rows, pinsWithoutExtractorDetails: rows, missingExpiryPins: rows, missingProductPins: rows, pinCountMatchesListing: z.boolean() }).nullable(),
  schedule: z.strictObject({ asOf: date, horizonDays: z.literal(30), pastExpiryPins: rows, next24hPins: rows, days2To7Pins: rows, days8To30Pins: rows, laterPins: rows, missingExpiryPins: rows, daily: z.array(z.strictObject({ date: dayDate, extractorPins: rows.min(1) })).max(31) }).nullable(),
  extractors: z.array(z.strictObject({ reference: rows.min(1), typeId: id, typeName: label, productTypeId: id.nullable(), productName: label.nullable(), headCount: rows, cycleTimeSeconds: count.nullable(), quantityPerCycle: count.nullable(), installedAt: date.nullable(), lastCycleStartedAt: date.nullable(), expiresAt: date.nullable() })).max(1000),
  limitations: z.array(text).max(20),
});
const invalid = () => new ConnectionResponseError('The colony service returned incomplete evidence. Refresh and try again.');
const selectionError = () => new ConnectionResponseError('Choose one connected character and one displayed colony planet.');
export function planetaryAnalyticsResponse(value: unknown, input: PlanetaryAnalyticsArgs): PlanetaryAnalytics {
  const selected = argsSchema.safeParse(input); if (!selected.success) throw selectionError();
  const parsed = schema.safeParse(value); if (!parsed.success) throw invalid();
  const result = parsed.data, now = Date.parse(result.generatedAt), { colonies, layout } = result.sources;
  if (result.characterId !== selected.data.characterId || result.planetId !== selected.data.planetId) throw invalid();
  for (const item of [colonies, layout]) {
    const fresh = item.freshness;
    if (item.status === 'ready') {
      if (item.rows === null || fresh.retrievedAt === null || Date.parse(fresh.retrievedAt) > now + 60000 || fresh.state !== (fresh.cacheExpires === null ? 'unknown' : Date.parse(fresh.cacheExpires) <= now ? 'stale' : 'fresh')) throw invalid();
    } else if (item.rows !== null || fresh.state !== 'unknown' || fresh.retrievedAt !== null || fresh.cacheExpires !== null || fresh.lastModified !== null) throw invalid();
  }
  if (colonies.status !== 'ready' && (result.colony !== null || layout.status !== 'not_requested') || result.colony !== null && colonies.rows === 0 || result.colony === null && layout.status !== 'not_requested') throw invalid();
  if (result.status !== 'ready' && result.status !== 'partial') {
    if (result.summary !== null || result.schedule !== null || result.extractors.length || layout.status === 'ready' || result.status === 'needs_permission' && (colonies.status !== 'not_requested' || layout.status !== 'not_requested')) throw invalid();
    return result;
  }
  const summary = result.summary, schedule = result.schedule;
  if (!summary || !schedule || !result.colony || colonies.status !== 'ready' || layout.status !== 'ready' || schedule.asOf !== result.generatedAt) throw invalid();
  const entries = result.extractors, missingExpiry = entries.filter(row => row.expiresAt === null).length, missingProduct = entries.filter(row => row.productTypeId === null).length;
  if (layout.rows !== summary.pins || summary.extractorPins !== entries.length || summary.pinsWithoutExtractorDetails !== summary.pins - entries.length || summary.missingExpiryPins !== missingExpiry || summary.missingProductPins !== missingProduct || summary.pinCountMatchesListing !== (summary.pins === result.colony.reportedPins) ||
      entries.some((row, index) => row.reference !== index + 1 || (row.productTypeId === null) !== (row.productName === null) || index > 0 && entries[index - 1].expiresAt !== null && row.expiresAt !== null && entries[index - 1].expiresAt! > row.expiresAt || index > 0 && entries[index - 1].expiresAt === null && row.expiresAt !== null)) throw invalid();
  const counts = [0, 0, 0, 0, 0, missingExpiry], daily = new Map<string, number>();
  for (const row of entries) {
    if (row.expiresAt === null) continue;
    const delta = Date.parse(row.expiresAt) - now;
    counts[delta <= 0 ? 0 : delta <= 86400000 ? 1 : delta <= 604800000 ? 2 : delta <= 2592000000 ? 3 : 4]++;
    if (delta > 0 && delta <= 2592000000) { const day = row.expiresAt.slice(0, 10); daily.set(day, (daily.get(day) ?? 0) + 1); }
  }
  const received = [schedule.pastExpiryPins, schedule.next24hPins, schedule.days2To7Pins, schedule.days8To30Pins, schedule.laterPins, schedule.missingExpiryPins], expectedDays = [...daily].sort(([a], [b]) => a.localeCompare(b));
  if (counts.some((value, index) => value !== received[index]) || schedule.daily.length !== expectedDays.length || expectedDays.some(([day, value], index) => schedule.daily[index].date !== day || schedule.daily[index].extractorPins !== value) ||
      result.status !== ([colonies, layout].every(item => item.freshness.state === 'fresh') && summary.pinCountMatchesListing && !missingExpiry && !missingProduct ? 'ready' : 'partial')) throw invalid();
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
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }
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
export async function planetaryAnalyticsRequest(args: PlanetaryAnalyticsArgs, signal?: AbortSignal): Promise<PlanetaryAnalytics> {
  if (!argsSchema.safeParse(args).success) throw selectionError();
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(abort, 60000); let response: Response | undefined;
  try {
    controller.signal.throwIfAborted();
    response = await fetch('/api/eve/planetary-analytics', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: controller.signal });
    controller.signal.throwIfAborted();
    if (!response.ok) throw new ConnectionResponseError(response.status === 401 ? 'Sign in again to read the selected colony.' : response.status === 404 ? 'This character is no longer connected. Reload connection status.' : 'The selected colony could not be loaded. Try again or review the connection.', response.status);
    if (!response.headers.get('content-type')?.includes('application/json')) throw invalid();
    return planetaryAnalyticsResponse(await readBody(response, controller.signal), args);
  } catch (error) {
    if (error instanceof ConnectionResponseError) throw error;
    throw new ConnectionResponseError(controller.signal.aborted ? 'The colony request was cancelled or timed out.' : 'The colony service could not be reached. Try again.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
}
