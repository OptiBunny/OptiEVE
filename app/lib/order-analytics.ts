import { EveError, listConnections, readEve, type ReadArgs } from './eve';
import { overviewDate } from './overview-summary';
import { findPublishedManufacturingItem } from './manufacturing-catalog';
import type { AnalyticsOrder, OrderAnalytics, OrderAnalyticsArgs } from './order-analytics-types';

type Dependencies = { connections: (user: string) => Promise<{ characterId: number; scopes: string[] }[]>; orders: (user: string, args: ReadArgs, signal?: AbortSignal) => Promise<unknown>; now?: () => number };
type Selection = { characterId: number; entity: 'character' | 'corporation'; page: number | null };
const scopes = { character: 'esi-markets.read_character_orders.v1', corporation: 'esi-markets.read_corporation_orders.v1' };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
class OrderDataError extends Error {}
const invalid = (): never => { throw new OrderDataError(); };
const limitations = [
  'Only this returned response is included. Corporation orders use one explicit page; each load replaces the previous results. No account or order history is saved.',
  'The personal view excludes orders explicitly marked as corporation orders. An omitted buy/sell flag has no documented default and remains Unknown; unknown-side orders are never treated as sells.',
  'Charts count orders, not item quantities or ISK. Remaining and original quantities are shown separately per order; their difference is not established sales or fills.',
  'Reported expiry is issued time plus duration in days, normalized to UTC. A past expiry can reflect delayed data and does not prove cancellation, disappearance or completion. Dates are a snapshot, not a live countdown.',
  'Unit prices show the decimal representation of the received JSON number without further rounding. This cannot recover precision already lost before or during JSON parsing. No portfolio value, escrow total, notional, profit or wallet balance is calculated.',
  'Public item names come from the pinned catalog; unmapped types retain their IDs. Issuer, location, wallet-division, escrow, private names and raw source URLs are omitted; no extra lookups are performed.',
  'The application rejects responses above 5,000 order rows, unsafe quantities, duplicate IDs or inconsistent metadata rather than silently truncating charts. Filters affect the table only; charts describe the full included response.',
];
export function validateOrderAnalyticsArgs(value: unknown): Selection {
  if (!record(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['characterId', 'entity', 'page'].includes(key)) ||
      !Object.hasOwn(value, 'characterId') || !integer(value.characterId, 1) || !Object.hasOwn(value, 'entity') || value.entity !== 'character' && value.entity !== 'corporation' ||
      value.entity === 'character' && Object.hasOwn(value, 'page') || value.entity === 'corporation' && Object.hasOwn(value, 'page') && !integer(value.page, 1, 500)) {
    throw new EveError('Choose one connected character and an order owner. Only corporation orders accept a page from 1 to 500.');
  }
  return { characterId: value.characterId, entity: value.entity, page: value.entity === 'corporation' ? value.page as number | undefined ?? 1 : null };
}
function timestamp(value: unknown): string | null { const stamp = overviewDate(value); return stamp?.length === 24 ? stamp : null; }
function headerTime(value: unknown): number | null {
  const stamp = timestamp(value); if (stamp) return Date.parse(stamp);
  if (typeof value !== 'string' || value.length > 100) return null;
  const parsed = Date.parse(value); return Number.isFinite(parsed) && new Date(parsed).toUTCString() === value ? parsed : null;
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
  signal.throwIfAborted(); let cancel: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); });
  void interrupted.catch(() => {});
  try { const result = await Promise.race([work(), interrupted]); signal.throwIfAborted(); return result; }
  finally { signal.removeEventListener('abort', cancel); }
}
function typeName(typeId: number): { name: string; mapped: boolean } {
  const item = findPublishedManufacturingItem(typeId), name = item?.name;
  return typeof name === 'string' && name.trim() === name && name.length > 0 && name.length <= 512 && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(name) ? { name, mapped: true } : { name: `Type ${typeId}`, mapped: false };
}
function blank(selected: Selection, now: number, status: OrderAnalytics['status'], message: string): OrderAnalytics {
  return { characterId: selected.characterId, entity: selected.entity, corporationId: null, generatedAt: new Date(now).toISOString(), status, message, scope: scopes[selected.entity],
    coverage: { kind: 'unavailable', page: selected.page, pages: null, nextPage: null, previousPage: selected.page !== null && selected.page > 1 ? selected.page - 1 : null, pageLimitReached: false, rows: 0 },
    freshness: { state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null }, summary: null, orders: [], limitations: [...limitations] };
}
function coverage(selected: Selection, response: Record<string, unknown>): OrderAnalytics['coverage'] {
  if (response.division != null || response.nextFromId != null) return invalid();
  if (selected.entity === 'character') {
    if (response.page != null || response.pages !== 1 || response.nextPage !== null || ['pageLimit', 'morePagesAvailable', 'pageLimitReached'].some(key => response[key] != null)) return invalid();
    return { kind: 'complete_returned_response', page: null, pages: null, nextPage: null, previousPage: null, pageLimitReached: false, rows: 0 };
  }
  const page = selected.page!;
  if (response.page !== page || response.pages !== null && !integer(response.pages, 1) || typeof response.pages === 'number' && response.pages < page) return invalid();
  const pages = response.pages as number | null, more = pages === null ? null : page < pages;
  const nextPage = more === true && page < 500 ? page + 1 : null, pageLimitReached = page === 500 && more !== false;
  if (response.nextPage !== nextPage || response.pageLimit !== undefined && response.pageLimit !== 500 || response.morePagesAvailable !== undefined && response.morePagesAvailable !== more || response.pageLimitReached !== undefined && response.pageLimitReached !== pageLimitReached) return invalid();
  return { kind: pages === null ? 'unknown' : page === 1 && pages === 1 ? 'complete_returned_response' : 'partial', page, pages, nextPage, previousPage: page > 1 ? page - 1 : null, pageLimitReached, rows: 0 };
}
function summarize(selected: Selection, response: unknown, completed: number): OrderAnalytics {
  if (!record(response) || response.characterId !== selected.characterId || response.entity !== selected.entity || response.dataset !== 'orders' ||
      selected.entity === 'corporation' && !integer(response.corporationId, 1) || selected.entity === 'character' && response.corporationId != null || !Array.isArray(response.data) || response.data.length > 5000) return invalid();
  const retrievedAt = timestamp(response.retrievedAt); if (!retrievedAt || Date.parse(retrievedAt) > completed + 60000) return invalid();
  const selectedCoverage = coverage(selected, response), seen = new Set<number>(), orders: AnalyticsOrder[] = [];
  let excludedCorporationOrders = 0;
  for (const row of response.data) {
    if (!record(row) || !integer(row.order_id, 1) || seen.has(row.order_id) || selected.entity === 'character' && typeof row.is_corporation !== 'boolean') return invalid();
    seen.add(row.order_id);
    // The character endpoint can include corporation orders. Exclude their data
    // before projection; they cannot establish the personal portfolio.
    if (selected.entity === 'character' && row.is_corporation === true) { excludedCorporationOrders++; continue; }
    if (!integer(row.type_id, 1) || !integer(row.volume_remain) || !integer(row.volume_total, 1) || row.volume_remain > row.volume_total || !integer(row.duration, 1, 36500) ||
        typeof row.price !== 'number' || !Number.isFinite(row.price) || row.price < 0 || row.price > Number.MAX_SAFE_INTEGER ||
        row.is_buy_order !== undefined && typeof row.is_buy_order !== 'boolean' || row.min_volume !== undefined && !integer(row.min_volume, 1)) return invalid();
    const issuedAt = timestamp(row.issued), ends = issuedAt === null ? NaN : Date.parse(issuedAt) + row.duration * 86400000;
    if (!issuedAt || !Number.isSafeInteger(ends) || Math.abs(ends) > 8640000000000000) return invalid();
    const expiresAt = new Date(ends).toISOString(); if (expiresAt.length !== 24) return invalid();
    orders.push({ orderId: row.order_id, typeId: row.type_id, ...typeName(row.type_id), side: row.is_buy_order === true ? 'buy' : row.is_buy_order === false ? 'sell' : 'unknown',
      unitPrice: String(row.price), remainingQuantity: row.volume_remain, originalQuantity: row.volume_total, minimumVolume: row.min_volume as number | undefined ?? null, issuedAt, durationDays: row.duration, expiresAt });
  }
  orders.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt) || a.orderId - b.orderId);
  const summary = { orders: orders.length, types: new Set(orders.map(row => row.typeId)).size, buy: orders.filter(row => row.side === 'buy').length, sell: orders.filter(row => row.side === 'sell').length,
    unknownSide: orders.filter(row => row.side === 'unknown').length, excludedCorporationOrders,
    pastReportedExpiry: orders.filter(row => Date.parse(row.expiresAt) <= completed).length, dueWithin24h: orders.filter(row => Date.parse(row.expiresAt) > completed && Date.parse(row.expiresAt) <= completed + 86400000).length,
    unmappedTypes: orders.filter(row => !row.mapped).length };
  const cacheExpires = expiry(response, Date.parse(retrievedAt));
  const freshness: OrderAnalytics['freshness'] = { state: cacheExpires === null ? 'unknown' : Date.parse(cacheExpires) <= completed ? 'stale' : 'fresh', retrievedAt, cacheExpires, lastModified: headerTime(response.lastModified) === null ? null : new Date(headerTime(response.lastModified)!).toISOString() };
  const complete = selectedCoverage.kind === 'complete_returned_response' && freshness.state === 'fresh' && summary.unknownSide === 0 && summary.unmappedTypes === 0;
  return { ...blank(selected, completed, complete ? 'ready' : 'partial', (selected.entity === 'character' ? 'One personal order response. ' : `Corporation order page ${selected.page}${selectedCoverage.pages === null ? '; page count unknown' : ` of ${selectedCoverage.pages}`}. `) + `Charts cover ${orders.length} included orders; source freshness is ${freshness.state}.`),
    corporationId: selected.entity === 'corporation' ? response.corporationId as number : null, coverage: { ...selectedCoverage, rows: response.data.length }, freshness, summary, orders };
}
/** One manual, owner-scoped read; no follow-up data, persistence or game actions. */
export function createOrderAnalyticsReader(dependencies: Dependencies) {
  return async (user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<OrderAnalytics> => {
    const selected = validateOrderAnalyticsArgs(input), now = dependencies.now ?? Date.now;
    if (typeof user !== 'string' || !user) throw new EveError('Sign in to this private connector first.', 401);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    signal.throwIfAborted(); let connection: { characterId: number; scopes: string[] } | undefined;
    try { connection = (await abortable(() => dependencies.connections(user), signal)).find(row => row.characterId === selected.characterId); }
    catch { return blank(selected, now(), 'unavailable', signal.aborted ? 'The order request was cancelled or reached its time limit.' : 'Connection status could not be checked. Refresh to try again.'); }
    if (!connection) throw new EveError('Choose a character connected to this private connector.', 404);
    if (!connection.scopes.includes(scopes[selected.entity])) return blank(selected, now(), 'needs_permission', 'This character has not granted the required order read permission. Review Connections; no access is added automatically.');
    try {
      const args: ReadArgs = { characterId: selected.characterId, entity: selected.entity, dataset: 'orders', ...(selected.page !== null ? { page: selected.page } : {}) };
      return summarize(selected, await abortable(() => dependencies.orders(user, args, signal), signal), now());
    } catch (error) {
      if (signal.aborted) return blank(selected, now(), 'unavailable', 'The order request was cancelled or reached its time limit. Refresh to try again.');
      if (error instanceof EveError && [401, 404, 409].includes(error.status)) return blank(selected, now(), 'unavailable', 'The connection changed or its authorization expired. Reload connection status before trying again.');
      if (error instanceof EveError && error.status === 403) return blank(selected, now(), 'unavailable', selected.entity === 'corporation' ? 'EVE denied this read. Check the corporation order permission and Accountant or Trader role.' : 'EVE denied this read. Check the character order permission.');
      if (error instanceof EveError && error.status === 429) return blank(selected, now(), 'unavailable', 'EVE is rate limiting requests. Wait before refreshing; no automatic retry was made.');
      return blank(selected, now(), 'error', error instanceof OrderDataError ? 'EVE returned orders that could not be summarized safely. No order counts are inferred.' : 'Open orders could not be loaded. No order counts are assumed.');
    }
  };
}
export const readOrderAnalytics = createOrderAnalyticsReader({ connections: listConnections, orders: readEve });
