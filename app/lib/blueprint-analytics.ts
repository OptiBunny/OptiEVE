import { EveError, listConnections, readCharacterData, readCorporationData } from './eve';
import { overviewDate } from './overview-summary';
import { findPublishedManufacturingItem } from './manufacturing-catalog';
import type { BlueprintAnalytics, BlueprintAnalyticsRow, BlueprintKind } from './blueprint-analytics-types';

type DatasetArgs = { characterId: number; dataset: string; parameters?: Record<string, unknown> };
type Dependencies = {
  connections: (user: string) => Promise<{ characterId: number; scopes: string[] }[]>;
  character: (user: string, args: DatasetArgs, signal?: AbortSignal) => Promise<unknown>;
  corporation: (user: string, args: DatasetArgs, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
};
type Selection = { characterId: number; entity: 'character' | 'corporation'; page: number };
const scopes = { character: 'esi-characters.read_blueprints.v1', corporation: 'esi-corporations.read_blueprints.v1' };
const kinds: BlueprintKind[] = ['original', 'copy', 'original_stack'];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
class BlueprintDataError extends Error {}
const invalid = (): never => { throw new BlueprintDataError(); };
const limitations = [
  'Only the selected returned blueprint page is included. Each load replaces the previous page; pages and owners are never combined or saved.',
  'All composition, efficiency and type charts count records, not blueprint units or manufacturing output. One original-stack record can contain multiple blueprint originals.',
  'Quantity -1 is an original, -2 is a copy and a positive quantity is a fresh-original stack. Finite remaining copy runs stay per row; original runs are unlimited, never a numeric total.',
  'Reported efficiency and copy runs do not establish available job slots, blueprint availability, usable materials, production capacity, profit or asset value. No inventory or job cross-check is performed.',
  'Names come from the pinned public catalog. Unmapped types keep their numeric type ID and an explicit unknown label. No private names or extra location lookups are requested.',
  'Item identifiers, location identifiers and location flags are omitted. Row numbers are positions in this response only and cannot track a blueprint across loads.',
  'The application accepts at most 1,000 records per response. Invalid, duplicate, unsafe or contradictory blueprint records reject the entire response rather than silently truncating charts.',
];
export function validateBlueprintAnalyticsArgs(value: unknown): Selection {
  if (!record(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['characterId', 'entity', 'page'].includes(key)) ||
      !Object.hasOwn(value, 'characterId') || !integer(value.characterId, 1) || !Object.hasOwn(value, 'entity') ||
      value.entity !== 'character' && value.entity !== 'corporation' || Object.hasOwn(value, 'page') && !integer(value.page, 1, 500)) {
    throw new EveError('Choose one connected character, a blueprint owner and a page from 1 to 500.');
  }
  return { characterId: value.characterId, entity: value.entity, page: value.page as number | undefined ?? 1 };
}
function timestamp(value: unknown): string | null {
  const stamp = overviewDate(value);
  return stamp?.length === 24 ? stamp : null;
}
function headerTime(value: unknown): number | null {
  const stamp = timestamp(value);
  if (stamp) return Date.parse(stamp);
  if (typeof value !== 'string' || value.length > 100) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toUTCString() === value ? parsed : null;
}
function expiry(response: Record<string, unknown>, received: number): string | null {
  const expires = headerTime(response.cacheExpires), date = headerTime(response.responseDate);
  const control = typeof response.cacheControl === 'string' && response.cacheControl.length <= 512 ? response.cacheControl : '';
  if (/(?:^|,)\s*(?:no-cache|no-store)(?=\s*(?:,|$))/i.test(control)) return new Date(received).toISOString();
  const age = response.cacheAge == null ? 0 : typeof response.cacheAge === 'string' && /^\d{1,10}$/.test(response.cacheAge) ? Number(response.cacheAge) : NaN;
  if (!integer(age, 0, 604800)) return null;
  const match = /(?:^|,)\s*max-age=(\d+)(?=\s*(?:,|$))/i.exec(control), maxAge = match ? Number(match[1]) : null;
  const cached = integer(maxAge, 0, 604800) && date !== null && date <= received + 60000 ? Math.min(date + maxAge * 1000, received + (maxAge - age) * 1000) : null;
  const until = expires === null ? cached : cached === null ? expires : Math.min(expires, cached);
  return until === null ? null : new Date(until).toISOString();
}
async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); });
  void interrupted.catch(() => {});
  try { const result = await Promise.race([work(), interrupted]); signal.throwIfAborted(); return result; }
  finally { signal.removeEventListener('abort', cancel); }
}
function typeName(typeId: number): { name: string; known: boolean } {
  const item = findPublishedManufacturingItem(typeId), name = item?.name;
  return typeof name === 'string' && name.trim() === name && name.length > 0 && name.length <= 512 && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(name)
    ? { name, known: true } : { name: `Type ${typeId}`, known: false };
}
function blank(selection: Selection, at: number, status: BlueprintAnalytics['status'], message: string): BlueprintAnalytics {
  return {
    characterId: selection.characterId, entity: selection.entity, corporationId: null, generatedAt: new Date(at).toISOString(), status, message, scope: scopes[selection.entity],
    coverage: { kind: 'unavailable', page: selection.page, pages: null, nextPage: null, previousPage: selection.page > 1 ? selection.page - 1 : null, pageLimitReached: false, rows: 0 },
    freshness: { state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null }, summary: null,
    kindCounts: [], materialEfficiencyCounts: [], timeEfficiencyCounts: [], typeCounts: [], blueprints: [], limitations: [...limitations],
  };
}
function coverage(selection: Selection, pagination: unknown, rows: number): BlueprintAnalytics['coverage'] {
  const page = selection.page;
  if (!record(pagination) || pagination.kind !== 'page' || pagination.page !== page ||
      ['after', 'before', 'nextFromId', 'nextBeforeId', 'nextFromEvent'].some(key => pagination[key] != null) ||
      pagination.pages !== null && !integer(pagination.pages, 1) || typeof pagination.pages === 'number' && pagination.pages < page) return invalid();
  const pages = pagination.pages as number | null, more = pages === null ? null : page < pages;
  const nextPage = more === true && page < 500 ? page + 1 : null, pageLimitReached = page === 500 && more !== false;
  if (pagination.nextPage !== nextPage || pagination.pageLimit !== undefined && pagination.pageLimit !== 500 ||
      pagination.morePagesAvailable !== undefined && pagination.morePagesAvailable !== more || pagination.pageLimitReached !== undefined && pagination.pageLimitReached !== pageLimitReached) return invalid();
  return { kind: pages === null ? 'unknown' : page === 1 && pages === 1 ? 'complete_returned_response' : 'partial', page, pages, nextPage, previousPage: page > 1 ? page - 1 : null, pageLimitReached, rows };
}
function summarize(selection: Selection, response: unknown, completed: number): BlueprintAnalytics {
  if (!record(response) || response.characterId !== selection.characterId || response.dataset !== 'blueprints' ||
      selection.entity === 'corporation' && (response.entity !== 'corporation' || !integer(response.corporationId, 1)) ||
      selection.entity === 'character' && (response.entity !== undefined && response.entity !== 'character' || response.corporationId != null) ||
      !Array.isArray(response.data) || response.data.length > 1000) return invalid();
  const retrievedAt = timestamp(response.retrievedAt);
  if (!retrievedAt || Date.parse(retrievedAt) > completed + 60000) return invalid();
  const selectedCoverage = coverage(selection, response.pagination, response.data.length);
  const seen = new Set<number>(), material = new Map<number, number>(), time = new Map<number, number>();
  const types = new Map<number, BlueprintAnalytics['typeCounts'][number]>(), kindCounts = kinds.map(kind => ({ kind, count: 0 }));
  let unknownTypeRecords = 0;
  const blueprints: BlueprintAnalyticsRow[] = response.data.map((row, index) => {
    if (!record(row) || !integer(row.item_id, 1) || seen.has(row.item_id) || !integer(row.type_id, 1) || !integer(row.location_id, 1) ||
        !integer(row.quantity, -2) || row.quantity === 0 || !integer(row.runs, -1) || (row.quantity === -2 ? row.runs < 0 : row.runs !== -1) ||
        !integer(row.material_efficiency) || !integer(row.time_efficiency) || typeof row.location_flag !== 'string' ||
        !row.location_flag.trim() || row.location_flag.length > 80 || /[\x00-\x1f\x7f]/.test(row.location_flag)) return invalid();
    seen.add(row.item_id);
    const kind: BlueprintKind = row.quantity === -2 ? 'copy' : row.quantity === -1 ? 'original' : 'original_stack';
    const type = typeName(row.type_id);
    if (!type.known) unknownTypeRecords++;
    kindCounts.find(value => value.kind === kind)!.count++;
    material.set(row.material_efficiency, (material.get(row.material_efficiency) ?? 0) + 1);
    time.set(row.time_efficiency, (time.get(row.time_efficiency) ?? 0) + 1);
    const item = types.get(row.type_id) ?? { typeId: row.type_id, name: type.name, records: 0 };
    item.records++; types.set(row.type_id, item);
    return { row: index + 1, typeId: row.type_id, name: type.name, catalogMapped: type.known, kind,
      units: row.quantity < 0 ? 1 : row.quantity, materialEfficiency: row.material_efficiency, timeEfficiency: row.time_efficiency, copyRuns: kind === 'copy' ? row.runs : null };
  });
  const summary = { records: blueprints.length, types: types.size, originalRecords: kindCounts[0].count, copyRecords: kindCounts[1].count, originalStackRecords: kindCounts[2].count, unknownTypeRecords };
  const cacheExpires = expiry(response, Date.parse(retrievedAt));
  const freshness: BlueprintAnalytics['freshness'] = { state: cacheExpires === null ? 'unknown' : Date.parse(cacheExpires) <= completed ? 'stale' : 'fresh', retrievedAt, cacheExpires,
    lastModified: headerTime(response.lastModified) === null ? null : new Date(headerTime(response.lastModified)!).toISOString() };
  const complete = selectedCoverage.kind === 'complete_returned_response' && freshness.state === 'fresh' && unknownTypeRecords === 0;
  const message = `Selected blueprint page ${selection.page}${selectedCoverage.pages === null ? '; provider page count unknown' : ` of ${selectedCoverage.pages}`}. Charts count returned records. Source freshness is ${freshness.state}.` +
    (unknownTypeRecords ? ` ${unknownTypeRecords} records have types absent from the pinned public catalog.` : '');
  return { ...blank(selection, completed, complete ? 'ready' : 'partial', message), corporationId: selection.entity === 'corporation' ? response.corporationId as number : null,
    coverage: selectedCoverage, freshness, summary, kindCounts, blueprints,
    materialEfficiencyCounts: [...material].sort(([a], [b]) => a - b).map(([level, count]) => ({ level, count })),
    timeEfficiencyCounts: [...time].sort(([a], [b]) => a - b).map(([level, count]) => ({ level, count })),
    typeCounts: [...types.values()].sort((a, b) => b.records - a.records || a.typeId - b.typeId) };
}

/** Reuse the exact bounded page validation/projection in request-local collections. */
export function projectBlueprintAnalyticsPage(input: unknown, response: unknown, completed: number): BlueprintAnalytics {
  return summarize(validateBlueprintAnalyticsArgs(input), response, completed);
}

/** One selected owned page; no follow-up reads, private identifiers, history or game writes. */
export function createBlueprintAnalyticsReader(dependencies: Dependencies) {
  return async (user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<BlueprintAnalytics> => {
    const selection = validateBlueprintAnalyticsArgs(input), now = dependencies.now ?? Date.now;
    if (typeof user !== 'string' || !user) throw new EveError('Sign in to this private connector first.', 401);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    signal.throwIfAborted();
    let connection: { characterId: number; scopes: string[] } | undefined;
    try { connection = (await abortable(() => dependencies.connections(user), signal)).find(row => row.characterId === selection.characterId); }
    catch { return blank(selection, now(), 'unavailable', signal.aborted ? 'The blueprint request was cancelled or reached its time limit.' : 'Connection status could not be checked. Refresh to try again.'); }
    if (!connection) throw new EveError('Choose a character connected to this private connector.', 404);
    if (!connection.scopes.includes(scopes[selection.entity])) return blank(selection, now(), 'needs_permission', 'This character has not granted the required blueprint read permission. Review Connections; no extra access is requested automatically.');
    try {
      const read = selection.entity === 'corporation' ? dependencies.corporation : dependencies.character;
      const response = await abortable(() => read(user, { characterId: selection.characterId, dataset: 'blueprints', parameters: { page: selection.page } }, signal), signal);
      return summarize(selection, response, now());
    } catch (error) {
      if (signal.aborted) return blank(selection, now(), 'unavailable', 'The blueprint request was cancelled or reached its time limit. Refresh to try again.');
      if (error instanceof EveError && [401, 404, 409].includes(error.status)) return blank(selection, now(), 'unavailable', 'The connection changed or its authorization expired. Reload connection status before trying again.');
      if (error instanceof EveError && error.status === 403) return blank(selection, now(), 'unavailable', selection.entity === 'corporation' ? 'EVE denied this read. Check the character’s corporation blueprint permission and Director role.' : 'EVE denied this read. Check the character’s blueprint read permission.');
      if (error instanceof EveError && error.status === 429) return blank(selection, now(), 'unavailable', 'EVE is rate limiting requests. Wait before refreshing; no automatic retry was made.');
      return blank(selection, now(), 'error', error instanceof BlueprintDataError ? 'EVE returned blueprints that could not be summarized safely. Missing data is unknown, not zero.' : 'Blueprints could not be loaded. No counts are assumed.');
    }
  };
}
export const readBlueprintAnalytics = createBlueprintAnalyticsReader({ connections: listConnections, character: readCharacterData, corporation: readCorporationData });
