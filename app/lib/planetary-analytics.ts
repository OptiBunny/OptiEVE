import { EveError, listConnections, readCharacterData } from './eve';
import { overviewDate } from './overview-summary';
import { findPublishedManufacturingItem } from './manufacturing-catalog';
import type { PlanetaryAnalytics, PlanetaryAnalyticsArgs, PlanetaryExtractor, PlanetarySchedule, PlanetarySource, PlanetaryType } from './planetary-analytics-types';

type Dependencies = {
  connections: (user: string) => Promise<{ characterId: number; scopes: string[] }[]>;
  character: (user: string, args: { characterId: number; dataset: string; parameters?: Record<string, unknown> }, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
};
const scope = 'esi-planets.manage_planets.v1', day = 86400000, maximumBytes = 2 * 1024 * 1024;
const planetTypes: PlanetaryType[] = ['temperate', 'barren', 'oceanic', 'ice', 'gas', 'lava', 'storm', 'plasma'];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
class PlanetaryDataError extends Error {}
const invalid = (): never => { throw new PlanetaryDataError(); };
const limitations = [
  'One explicitly selected colony is included. Its owned colony list is checked first, then only that colony layout is requested. Other colonies are not scanned.',
  'CCP recalculates planetary information when the colony is viewed in the EVE client. A fresh HTTP cache or recent fetch does not establish current simulation state; last update is separate provider metadata.',
  'Only pins carrying extractor details are classified as extractor rows. Pins without those details are not proof of absent extractors, empty capacity or idle production.',
  'Expiry buckets compare reported dates with the load timestamp. Missing dates stay unknown; a past expiry is not confirmed completion, and a future expiry is not proof of running work. Optional program timestamps are reported separately, without an inferred interval or progress.',
  'Cycle seconds and quantity per cycle are reported inputs, not a constant production rate. No elapsed accrual, total yield, inventory, customs cost, value or profit is calculated.',
  'The colony list and layout have independent caches. Their pin counts may differ without proving either response wrong; matching counts do not establish an atomic snapshot.',
  'Extractor references identify rows only within this response. Pin IDs, coordinates, extractor-head IDs, contents, links and routes are omitted. Public type labels use the offline catalog; no name lookup or account history is requested.',
  'The application rejects oversized responses instead of silently truncating them. Limits include 1,000 colony rows or pins, 1,000 heads per extractor, and 5,000 links or routes.',
];

export function validatePlanetaryAnalyticsArgs(value: unknown): PlanetaryAnalyticsArgs {
  if (!record(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['characterId', 'planetId'].includes(key)) ||
      !Object.hasOwn(value, 'characterId') || !integer(value.characterId, 1) || !Object.hasOwn(value, 'planetId') || !integer(value.planetId, 1)) {
    throw new EveError('Choose one connected character and one colony planet.');
  }
  return { characterId: value.characterId, planetId: value.planetId };
}
function timestamp(value: unknown): string | null { const parsed = overviewDate(value); return parsed?.length === 24 ? parsed : null; }
function optionalDate(row: Record<string, unknown>, key: string): string | null { return row[key] === undefined ? null : timestamp(row[key]) ?? invalid(); }
function optionalInteger(row: Record<string, unknown>, key: string, minimum = 0): number | null { return row[key] === undefined ? null : integer(row[key], minimum) ? row[key] : invalid(); }
function headerTime(value: unknown): number | null {
  const stamp = timestamp(value); if (stamp) return Date.parse(stamp);
  if (typeof value !== 'string' || value.length > 100) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toUTCString() === value && new Date(parsed).toISOString().length === 24 ? parsed : null;
}
function cacheDirectives(value: string): string[] | null {
  const parts: string[] = [];
  let start = 0, quoted = false, escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === ',') { parts.push(value.slice(start, index)); start = index + 1; }
  }
  if (quoted) return null;
  parts.push(value.slice(start));
  return parts;
}
function expiry(value: Record<string, unknown>, received: number): string | null {
  const expires = headerTime(value.cacheExpires), date = headerTime(value.responseDate);
  if (value.cacheControl != null && (typeof value.cacheControl !== 'string' || value.cacheControl.length > 512)) return null;
  const control = cacheDirectives(typeof value.cacheControl === 'string' ? value.cacheControl : '');
  if (control === null) return null;
  if (control.some(part => /^\s*(?:no-cache|no-store)\s*$/i.test(part))) return new Date(received).toISOString();
  const age = value.cacheAge == null ? 0 : typeof value.cacheAge === 'string' && /^\d{1,10}$/.test(value.cacheAge) ? Number(value.cacheAge) : NaN;
  if (!integer(age, 0, 604800)) return null;
  const directives = control.map(part => /^\s*max-age(?=\s*(?:=|$))(.*)$/is.exec(part)).filter(match => match !== null);
  if (directives.length > 1) return null;
  const match = directives[0] && /^=(\d+)\s*$/.exec(directives[0][1]), maxAge = match ? Number(match[1]) : null;
  const cached = integer(maxAge, 0, 604800) && date !== null && date <= received + 60000 ? Math.min(date + maxAge * 1000, received + (maxAge - age) * 1000) : null;
  if (directives.length && cached === null) return null;
  const until = expires === null ? cached : cached === null ? expires : Math.min(expires, cached), normalized = until === null ? null : new Date(until).toISOString();
  return normalized?.length === 24 ? normalized : null;
}
const emptyFreshness = (): PlanetarySource['freshness'] => ({ state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null });
const notRequested = (): PlanetarySource => ({ status: 'not_requested', rows: null, message: 'This source was not requested.', freshness: emptyFreshness() });
function blank(selection: PlanetaryAnalyticsArgs, now: number): PlanetaryAnalytics {
  return { ...selection, generatedAt: new Date(now).toISOString(), status: 'unavailable', message: 'Colony evidence is unavailable.', scope,
    simulationEvidence: 'recalculated_when_viewed_in_eve_client', colony: null, sources: { colonies: notRequested(), layout: notRequested() }, summary: null, schedule: null, extractors: [], limitations: [...limitations] };
}
function bounded(value: unknown) {
  // This is a post-read serialization bound. The core EVE reader separately
  // applies its 8 MiB transport limit; no per-call tighter stream cap is claimed.
  try { if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximumBytes) return invalid(); }
  catch { return invalid(); }
}
function envelope(value: unknown, selected: PlanetaryAnalyticsArgs, dataset: 'planets' | 'planet', at: number) {
  bounded(value);
  const pagination = record(value) ? value.pagination : null;
  if (!record(value) || value.characterId !== selected.characterId || value.dataset !== dataset ||
      value.entity !== undefined && value.entity !== 'character' || value.corporationId != null ||
      value.source !== `https://esi.evetech.net/characters/${selected.characterId}/planets${dataset === 'planet' ? '/' + selected.planetId : ''}` ||
      !record(pagination) || pagination.kind !== 'none' ||
      ['page', 'pages', 'nextPage', 'nextFromId', 'nextBeforeId', 'nextFromEvent', 'after', 'before', 'pageLimit', 'morePagesAvailable', 'pageLimitReached'].some(key => pagination[key] != null)) return invalid();
  const retrievedAt = timestamp(value.retrievedAt); if (!retrievedAt || Date.parse(retrievedAt) > at + 60000) return invalid();
  const cacheExpires = expiry(value, Date.parse(retrievedAt)), modified = headerTime(value.lastModified);
  const freshness: PlanetarySource['freshness'] = { state: cacheExpires === null ? 'unknown' : Date.parse(cacheExpires) <= at ? 'stale' : 'fresh', retrievedAt, cacheExpires, lastModified: modified === null ? null : new Date(modified).toISOString() };
  return { data: value.data, freshness };
}
function colonyList(data: unknown, selected: PlanetaryAnalyticsArgs): { colony: PlanetaryAnalytics['colony']; rows: number } {
  if (!Array.isArray(data) || data.length > 1000) return invalid();
  const seen = new Set<number>(); let colony: PlanetaryAnalytics['colony'] = null;
  for (const row of data) {
    if (!record(row) || !integer(row.planet_id, 1) || seen.has(row.planet_id) || row.owner_id !== selected.characterId || !integer(row.solar_system_id, 1) ||
        typeof row.planet_type !== 'string' || !planetTypes.includes(row.planet_type as PlanetaryType) || !integer(row.upgrade_level) || !integer(row.num_pins)) return invalid();
    const lastUpdateAt = timestamp(row.last_update); if (!lastUpdateAt) return invalid(); seen.add(row.planet_id);
    if (row.planet_id === selected.planetId) colony = { solarSystemId: row.solar_system_id, planetType: row.planet_type as PlanetaryType, upgradeLevel: row.upgrade_level, reportedPins: row.num_pins, lastUpdateAt };
  }
  return { colony, rows: data.length };
}
function typeName(id: number): string {
  const name = findPublishedManufacturingItem(id)?.name;
  return typeof name === 'string' && name.length > 0 && name.length <= 512 && name.trim() === name && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(name) ? name : `Type ${id}`;
}
function layout(data: unknown) {
  if (!record(data) || !Array.isArray(data.pins) || data.pins.length > 1000 || !Array.isArray(data.links) || data.links.length > 5000 || !Array.isArray(data.routes) || data.routes.length > 5000) return invalid();
  const seen = new Set<number>(), extractors: (Omit<PlanetaryExtractor, 'reference'> & { privatePinId: number })[] = [];
  for (const pin of data.pins) {
    if (!record(pin) || !integer(pin.pin_id, 1) || seen.has(pin.pin_id) || !integer(pin.type_id, 1) || !finite(pin.latitude) || !finite(pin.longitude)) return invalid();
    seen.add(pin.pin_id);
    // Unused contents, routing and facility fields never enter the projection.
    if (pin.extractor_details === undefined) continue;
    const details = pin.extractor_details;
    if (!record(details) || !Array.isArray(details.heads) || details.heads.length > 1000) return invalid();
    const heads = new Set<number>();
    for (const head of details.heads) {
      if (!record(head) || !integer(head.head_id) || heads.has(head.head_id) || !finite(head.latitude) || !finite(head.longitude)) return invalid();
      heads.add(head.head_id);
    }
    const productTypeId = optionalInteger(details, 'product_type_id', 1);
    extractors.push({ privatePinId: pin.pin_id, typeId: pin.type_id, typeName: typeName(pin.type_id), productTypeId, productName: productTypeId === null ? null : typeName(productTypeId), headCount: heads.size,
      cycleTimeSeconds: optionalInteger(details, 'cycle_time'), quantityPerCycle: optionalInteger(details, 'qty_per_cycle'),
      installedAt: optionalDate(pin, 'install_time'), lastCycleStartedAt: optionalDate(pin, 'last_cycle_start'), expiresAt: optionalDate(pin, 'expiry_time') });
  }
  extractors.sort((left, right) => left.expiresAt === null ? right.expiresAt === null ? left.privatePinId - right.privatePinId : 1 : right.expiresAt === null ? -1 : left.expiresAt.localeCompare(right.expiresAt) || left.privatePinId - right.privatePinId);
  return { pins: data.pins.length, extractors: extractors.map(({ typeId, typeName, productTypeId, productName, headCount, cycleTimeSeconds, quantityPerCycle, installedAt, lastCycleStartedAt, expiresAt }, index) => ({
    reference: index + 1, typeId, typeName, productTypeId, productName, headCount, cycleTimeSeconds, quantityPerCycle, installedAt, lastCycleStartedAt, expiresAt,
  })) };
}
function schedule(rows: PlanetaryExtractor[], at: number): PlanetarySchedule {
  const result: PlanetarySchedule = { asOf: new Date(at).toISOString(), horizonDays: 30, pastExpiryPins: 0, next24hPins: 0, days2To7Pins: 0, days8To30Pins: 0, laterPins: 0, missingExpiryPins: 0, daily: [] }, daily = new Map<string, number>();
  for (const row of rows) {
    if (row.expiresAt === null) { result.missingExpiryPins++; continue; }
    const delta = Date.parse(row.expiresAt) - at;
    if (delta <= 0) result.pastExpiryPins++; else if (delta <= day) result.next24hPins++; else if (delta <= 7 * day) result.days2To7Pins++; else if (delta <= 30 * day) result.days8To30Pins++; else result.laterPins++;
    if (delta > 0 && delta <= 30 * day) { const date = row.expiresAt.slice(0, 10); daily.set(date, (daily.get(date) ?? 0) + 1); }
  }
  result.daily = [...daily].sort(([left], [right]) => left.localeCompare(right)).map(([date, extractorPins]) => ({ date, extractorPins })); return result;
}
function finish(value: PlanetaryAnalytics, at: number): PlanetaryAnalytics {
  value.generatedAt = new Date(at).toISOString();
  for (const source of Object.values(value.sources)) source.freshness.state = source.freshness.cacheExpires === null ? 'unknown' : Date.parse(source.freshness.cacheExpires) <= at ? 'stale' : 'fresh';
  if (value.summary) {
    value.schedule = schedule(value.extractors, at);
    value.status = Object.values(value.sources).every(source => source.status === 'ready' && source.freshness.state === 'fresh') && value.summary.pinCountMatchesListing && value.summary.missingExpiryPins === 0 && value.summary.missingProductPins === 0 ? 'ready' : 'partial';
  }
  bounded(value); return value;
}
async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let cancel: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); }); void interrupted.catch(() => {});
  try { const value = await Promise.race([work(), interrupted]); signal.throwIfAborted(); return value; } finally { signal.removeEventListener('abort', cancel); }
}

/** Only the owned list and explicitly selected colony; no write, fanout or storage. */
export function createPlanetaryAnalyticsReader(dependencies: Dependencies) {
  return async (user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<PlanetaryAnalytics> => {
    const selected = validatePlanetaryAnalyticsArgs(input), now = dependencies.now ?? Date.now;
    if (typeof user !== 'string' || !user) throw new EveError('Sign in to this private connector first.', 401);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000); signal.throwIfAborted();
    const result = blank(selected, now()); let connection: { characterId: number; scopes: string[] } | undefined;
    try { connection = (await abortable(() => dependencies.connections(user), signal)).find(row => row.characterId === selected.characterId); }
    catch { result.message = 'Connection status could not be checked or the request was cancelled. Refresh to try again.'; return finish(result, now()); }
    if (!connection) throw new EveError('Choose a character connected to this private connector.', 404);
    if (!connection.scopes.includes(scope)) { result.status = 'needs_permission'; result.message = 'This character has not granted the existing planetary read permission. Review Connections; no extra access is requested automatically.'; return finish(result, now()); }
    let stage: 'colonies' | 'layout' = 'colonies';
    try {
      const listResponse = envelope(await abortable(() => dependencies.character(user, { characterId: selected.characterId, dataset: 'planets' }, signal), signal), selected, 'planets', now());
      const listed = colonyList(listResponse.data, selected);
      result.sources.colonies = { status: 'ready', message: 'The owned colony list was accepted; only the selected colony is shown.', rows: listed.rows, freshness: listResponse.freshness };
      result.colony = listed.colony;
      if (!result.colony) { result.message = 'The selected planet is not in this character’s returned colony list. No layout was requested.'; return finish(result, now()); }
      stage = 'layout';
      const layoutResponse = envelope(await abortable(() => dependencies.character(user, { characterId: selected.characterId, dataset: 'planet', parameters: { planetId: selected.planetId } }, signal), signal), selected, 'planet', now());
      const projected = layout(layoutResponse.data);
      result.sources.layout = { status: 'ready', message: 'One selected colony layout was accepted. HTTP freshness does not establish current simulation state.', rows: projected.pins, freshness: layoutResponse.freshness };
      result.extractors = projected.extractors;
      result.summary = { pins: projected.pins, extractorPins: projected.extractors.length, pinsWithoutExtractorDetails: projected.pins - projected.extractors.length,
        missingExpiryPins: projected.extractors.filter(row => row.expiresAt === null).length, missingProductPins: projected.extractors.filter(row => row.productTypeId === null).length,
        pinCountMatchesListing: projected.pins === result.colony.reportedPins };
      result.message = 'Reported extractor evidence for one selected colony. View the colony in EVE to update its simulation; no running state, completion or yield is inferred.';
      return finish(result, now());
    } catch (error) {
      const unavailable = signal.aborted || error instanceof EveError && [401, 403, 404, 409, 429].includes(error.status);
      result.status = unavailable ? 'unavailable' : 'error';
      result.message = signal.aborted ? 'The colony request was cancelled or reached its time limit. No extractor schedule is assumed.' : unavailable ? 'The selected colony source could not be read with the current authorization or provider availability. Refresh Connections before retrying.' : 'Colony data could not be summarized within the accepted format and limits. Missing evidence is unknown, not zero.';
      result.sources[stage] = { status: unavailable ? 'unavailable' : 'error', message: result.message, rows: null, freshness: emptyFreshness() };
      result.summary = null; result.schedule = null; result.extractors = [];
      return finish(result, now());
    }
  };
}
export const readPlanetaryAnalytics = createPlanetaryAnalyticsReader({ connections: listConnections, character: readCharacterData });
