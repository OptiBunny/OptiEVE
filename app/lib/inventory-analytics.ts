import { EveError, listConnections, readEve, type ReadArgs } from './eve';
import { findPublishedManufacturingItem } from './manufacturing-catalog';
import { overviewDate } from './overview-summary';
import type { InventoryAnalytics, InventoryAnalyticsArgs, InventoryLocationKind } from './inventory-analytics-types';

type Dependencies = {
  connections: (user: string) => Promise<{ characterId: number; scopes: string[] }[]>;
  assets: (user: string, args: ReadArgs, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
};
type Selection = InventoryAnalyticsArgs & { page: number };
const scopes = { character: 'esi-assets.read_assets.v1', corporation: 'esi-assets.read_corporation_assets.v1' };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
class InventoryDataError extends Error {}
const invalid = (): never => { throw new InventoryDataError(); };
const limitations = [
  'Only the selected returned asset page is included. Each load replaces the previous page; pages and accounts are never combined or saved.',
  'Category, group and location charts count asset records, not physical item units. A record can represent a stack. Quantities are added only within the same inventory type.',
  'Reported locations are source IDs and location kinds, not resolved stations, container ancestry, docking access or available manufacturing stock. Nested containers and other pages are not followed.',
  'Type labels and classifications come from the pinned public catalog. Unmapped types keep their type ID and an explicit unknown classification. No private item names or public player lookups are requested.',
  'No price, volume, net worth, profit, blueprint runs or usable stock is inferred. Blueprint-copy flags are counted as reported; missing flags remain unknown.',
  'The application accepts at most 1,000 asset rows per response. Unsupported negative quantities, unsafe sums or malformed responses are rejected, never truncated or replaced by zero.',
];
export function validateInventoryAnalyticsArgs(value: unknown): Selection {
  if (!record(value) || Object.keys(value).some(key => !['characterId', 'entity', 'page'].includes(key)) ||
      !Object.hasOwn(value, 'characterId') || !integer(value.characterId) || !Object.hasOwn(value, 'entity') ||
      value.entity !== 'character' && value.entity !== 'corporation' || Object.hasOwn(value, 'page') && !integer(value.page, 1, 500)) {
    throw new EveError('Choose one connected character, a character or corporation inventory, and a page from 1 to 500.');
  }
  return { characterId: value.characterId, entity: value.entity, page: Object.hasOwn(value, 'page') ? value.page as number : 1 };
}
function headerTime(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 100) return null;
  const iso = overviewDate(value);
  if (iso !== null) return Date.parse(iso);
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) && new Date(stamp).toUTCString() === value ? stamp : null;
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
  try { const value = await Promise.race([work(), interrupted]); signal.throwIfAborted(); return value; }
  finally { signal.removeEventListener('abort', cancel); }
}
function blank(selected: Selection, at: number, status: InventoryAnalytics['status'], message: string): InventoryAnalytics {
  return {
    characterId: selected.characterId, entity: selected.entity, corporationId: null, generatedAt: new Date(at).toISOString(), status, message, scope: scopes[selected.entity],
    coverage: { kind: 'unavailable', page: selected.page, pages: null, nextPage: null, previousPage: selected.page > 1 ? selected.page - 1 : null, pageLimitReached: false, records: 0 },
    freshness: { state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null }, summary: null, categories: [], groups: [], types: [], locations: [], limitations: [...limitations],
  };
}
function summarize(selected: Selection, response: unknown, completed: number): InventoryAnalytics {
  if (!record(response) || response.characterId !== selected.characterId || response.entity !== selected.entity || response.dataset !== 'assets' || response.page !== selected.page ||
      response.division != null || selected.entity === 'corporation' && !integer(response.corporationId) || selected.entity === 'character' && response.corporationId != null ||
      response.pages !== null && !integer(response.pages) || typeof response.pages === 'number' && response.pages < selected.page ||
      !Array.isArray(response.data) || response.data.length > 1000) return invalid();
  const retrievedAt = overviewDate(response.retrievedAt);
  if (!retrievedAt || Date.parse(retrievedAt) > completed + 60000) return invalid();
  const pages = response.pages as number | null, more = pages === null ? null : selected.page < pages, nextPage = more === true && selected.page < 500 ? selected.page + 1 : null;
  if (response.nextPage !== nextPage || response.pageLimit !== undefined && response.pageLimit !== 500 || response.morePagesAvailable !== undefined && response.morePagesAvailable !== more || response.pageLimitReached !== undefined && response.pageLimitReached !== (selected.page === 500 && more !== false)) return invalid();
  const ids = new Set<number>(), types = new Map<number, InventoryAnalytics['types'][number]>();
  const locations = new Map<number, InventoryAnalytics['locations'][number] & { typeIds: Set<number> }>();
  let singletonRecords = 0, blueprintCopyRecords = 0, blueprintCopyUnknownRecords = 0, unmappedTypeRecords = 0;
  for (const row of response.data) {
    if (!record(row) || !integer(row.item_id) || ids.has(row.item_id) || !integer(row.type_id) || !integer(row.location_id) || !integer(row.quantity, 0) || typeof row.is_singleton !== 'boolean' ||
        row.is_blueprint_copy !== undefined && typeof row.is_blueprint_copy !== 'boolean' || typeof row.location_type !== 'string' || !['station', 'solar_system', 'item', 'other'].includes(row.location_type) ||
        typeof row.location_flag !== 'string' || !row.location_flag.trim() || row.location_flag.length > 80 || /[\x00-\x1f\x7f]/.test(row.location_flag)) return invalid();
    ids.add(row.item_id);
    const known = findPublishedManufacturingItem(row.type_id);
    if (!known) unmappedTypeRecords++;
    const type = types.get(row.type_id) ?? {
      typeId: row.type_id, name: known?.name ?? `Type ${row.type_id}`, groupId: known?.groupId ?? null, groupName: known?.groupName ?? 'Unmapped group', categoryId: known?.categoryId ?? null, categoryName: known?.categoryName ?? 'Unmapped category',
      records: 0, quantity: 0, singletonRecords: 0, blueprintCopyRecords: 0, blueprintCopyUnknownRecords: 0,
    };
    if (type.quantity > Number.MAX_SAFE_INTEGER - row.quantity) return invalid();
    type.records++; type.quantity += row.quantity;
    if (row.is_singleton) { type.singletonRecords++; singletonRecords++; }
    if (row.is_blueprint_copy === true) { type.blueprintCopyRecords++; blueprintCopyRecords++; }
    if (row.is_blueprint_copy === undefined) { type.blueprintCopyUnknownRecords++; blueprintCopyUnknownRecords++; }
    types.set(row.type_id, type);
    const location = locations.get(row.location_id) ?? { locationId: row.location_id, kind: row.location_type as InventoryLocationKind, records: 0, typeCount: 0, typeIds: new Set<number>() };
    if (location.kind !== row.location_type) return invalid();
    location.records++; location.typeIds.add(row.type_id); location.typeCount = location.typeIds.size; locations.set(row.location_id, location);
  }
  const categories = new Map<number | null, InventoryAnalytics['categories'][number]>(), groups = new Map<number | null, InventoryAnalytics['groups'][number]>();
  for (const type of types.values()) {
    const category = categories.get(type.categoryId) ?? { categoryId: type.categoryId, name: type.categoryName, records: 0, typeCount: 0 };
    category.records += type.records; category.typeCount++; categories.set(type.categoryId, category);
    const group = groups.get(type.groupId) ?? { groupId: type.groupId, name: type.groupName, categoryId: type.categoryId, categoryName: type.categoryName, records: 0, typeCount: 0 };
    group.records += type.records; group.typeCount++; groups.set(type.groupId, group);
  }
  const cacheExpires = expiry(response, Date.parse(retrievedAt)), state = cacheExpires === null ? 'unknown' : Date.parse(cacheExpires) <= completed ? 'stale' : 'fresh';
  const kind = pages === null ? 'unknown' : pages === 1 && selected.page === 1 ? 'complete_returned_list' : 'partial';
  const complete = kind === 'complete_returned_list' && state === 'fresh' && unmappedTypeRecords === 0;
  return {
    ...blank(selected, completed, complete ? 'ready' : 'partial', `Selected inventory page ${selected.page}${pages === null ? '; provider page count is unknown' : ` of ${pages}`}. Charts count returned records only. Source freshness is ${state}.` + (unmappedTypeRecords ? ` ${unmappedTypeRecords} records have types absent from the pinned public catalog.` : '')),
    corporationId: selected.entity === 'corporation' ? response.corporationId as number : null,
    coverage: { kind, page: selected.page, pages, nextPage, previousPage: selected.page > 1 ? selected.page - 1 : null, pageLimitReached: selected.page === 500 && more !== false, records: ids.size },
    freshness: { state, retrievedAt, cacheExpires, lastModified: headerTime(response.lastModified) === null ? null : new Date(headerTime(response.lastModified)!).toISOString() },
    summary: { records: ids.size, types: types.size, locations: locations.size, singletonRecords, blueprintCopyRecords, blueprintCopyUnknownRecords, unmappedTypeRecords },
    types: [...types.values()].sort((a, b) => b.records - a.records || a.typeId - b.typeId),
    categories: [...categories.values()].sort((a, b) => b.records - a.records || (a.categoryId ?? Number.MAX_SAFE_INTEGER) - (b.categoryId ?? Number.MAX_SAFE_INTEGER)),
    groups: [...groups.values()].sort((a, b) => b.records - a.records || (a.groupId ?? Number.MAX_SAFE_INTEGER) - (b.groupId ?? Number.MAX_SAFE_INTEGER)),
    locations: [...locations.values()].map(({ typeIds: _typeIds, ...location }) => location).sort((a, b) => b.records - a.records || a.locationId - b.locationId),
  };
}
/** Server-only reuse of the bounded asset page validator; callers must project private IDs away. */
export function projectInventoryAnalyticsPage(input: unknown, response: unknown, completed: number): InventoryAnalytics {
  return summarize(validateInventoryAnalyticsArgs(input), response, completed);
}

/** Current-page summaries only; no private raw rows or derived history are persisted. */
export function createInventoryAnalyticsReader(dependencies: Dependencies) {
  return async (user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<InventoryAnalytics> => {
    const selected = validateInventoryAnalyticsArgs(input), now = dependencies.now ?? Date.now;
    if (!user || typeof user !== 'string') throw new EveError('Sign in to this private connector first.', 401);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    signal.throwIfAborted();
    let connection: { characterId: number; scopes: string[] } | undefined;
    try { connection = (await abortable(() => dependencies.connections(user), signal)).find(row => row.characterId === selected.characterId); }
    catch { return blank(selected, now(), 'unavailable', signal.aborted ? 'The inventory request was cancelled or reached its time limit.' : 'Connection status could not be checked. Refresh to try again.'); }
    if (!connection) throw new EveError('Choose a character connected to this private connector.', 404);
    if (!connection.scopes.includes(scopes[selected.entity])) return blank(selected, now(), 'needs_permission', 'The selected character has not granted the required inventory read permission. Review Connections; permissions are never added automatically.');
    try {
      const response = await abortable(() => dependencies.assets(user, { ...selected, dataset: 'assets' }, signal), signal);
      return summarize(selected, response, now());
    } catch (error) {
      if (signal.aborted) return blank(selected, now(), 'unavailable', 'The inventory request was cancelled or reached its time limit. Refresh to try again.');
      if (error instanceof EveError && [401, 404, 409].includes(error.status)) return blank(selected, now(), 'unavailable', 'The connection changed or its authorization expired. Reload connection status before trying again.');
      if (error instanceof EveError && error.status === 403) return blank(selected, now(), 'unavailable', selected.entity === 'corporation' ? 'EVE denied this read. Check the character’s inventory permission and required corporation role.' : 'EVE denied this inventory read. Check the character’s granted permission.');
      if (error instanceof EveError && error.status === 429) return blank(selected, now(), 'unavailable', 'EVE is rate limiting requests. Wait before refreshing the selected page.');
      return blank(selected, now(), 'error', error instanceof InventoryDataError ? 'EVE returned a page that could not be summarized safely. No inventory totals are shown.' : 'The selected inventory page could not be loaded. No totals are assumed.');
    }
  };
}
export const readInventoryAnalytics = createInventoryAnalyticsReader({ connections: listConnections, assets: readEve });
