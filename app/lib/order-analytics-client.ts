import { z } from 'zod';
import { ConnectionResponseError } from './connection-client';
import type { OrderAnalytics, OrderAnalyticsArgs } from './order-analytics-types';
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), id = count.min(1), rows = count.max(5000);
const date = z.string().length(24).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const name = z.string().min(1).max(512).refine(value => value.trim() === value && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value));
const text = z.string().max(2048), entity = z.enum(['character', 'corporation']);
const argsSchema = z.strictObject({ characterId: id, entity, page: id.max(500).optional() }).refine(value => !Object.hasOwn(value, 'page') || value.entity === 'corporation' && value.page !== undefined);
const price = z.string().min(1).max(32).refine(value => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= Number.MAX_SAFE_INTEGER && String(Number(value)) === value);
const schema = z.strictObject({
  characterId: id, entity, corporationId: id.nullable(), generatedAt: date, status: z.enum(['ready', 'partial', 'needs_permission', 'unavailable', 'error']), message: text,
  scope: z.enum(['esi-markets.read_character_orders.v1', 'esi-markets.read_corporation_orders.v1']),
  coverage: z.strictObject({ kind: z.enum(['complete_returned_response', 'partial', 'unknown', 'unavailable']), page: id.max(500).nullable(), pages: id.nullable(), nextPage: id.max(500).nullable(), previousPage: id.max(500).nullable(), pageLimitReached: z.boolean(), rows }),
  freshness: z.strictObject({ state: z.enum(['fresh', 'stale', 'unknown']), retrievedAt: date.nullable(), cacheExpires: date.nullable(), lastModified: date.nullable() }),
  summary: z.strictObject({ orders: rows, types: rows, buy: rows, sell: rows, unknownSide: rows, excludedCorporationOrders: rows, pastReportedExpiry: rows, dueWithin24h: rows, unmappedTypes: rows }).nullable(),
  orders: z.array(z.strictObject({ orderId: id, typeId: id, name, mapped: z.boolean(), side: z.enum(['buy', 'sell', 'unknown']), unitPrice: price, remainingQuantity: count, originalQuantity: id, minimumVolume: id.nullable(), issuedAt: date, durationDays: id.max(36500), expiresAt: date })).max(5000),
  limitations: z.array(text).max(20),
});
const invalid = () => new ConnectionResponseError('The order service returned an incomplete response. Refresh and try again.');
const invalidSelection = () => new ConnectionResponseError('Choose one connected character and a valid order owner or page.');
export function orderAnalyticsResponse(value: unknown, input: OrderAnalyticsArgs): OrderAnalytics {
  const selected = argsSchema.safeParse(input); if (!selected.success) throw invalidSelection();
  const parsed = schema.safeParse(value); if (!parsed.success) throw invalid();
  const result = parsed.data, args = selected.data, corporation = args.entity === 'corporation', page = corporation ? args.page ?? 1 : null, coverage = result.coverage, fresh = result.freshness;
  if (result.characterId !== args.characterId || result.entity !== args.entity || result.scope !== (corporation ? 'esi-markets.read_corporation_orders.v1' : 'esi-markets.read_character_orders.v1') || coverage.page !== page || coverage.previousPage !== (page !== null && page > 1 ? page - 1 : null) || !corporation && result.corporationId !== null) throw invalid();
  if (result.status !== 'ready' && result.status !== 'partial') {
    if (result.corporationId !== null || coverage.kind !== 'unavailable' || coverage.rows !== 0 || coverage.pages !== null || coverage.nextPage !== null || coverage.pageLimitReached || result.summary !== null || result.orders.length || fresh.state !== 'unknown' || fresh.retrievedAt !== null || fresh.cacheExpires !== null || fresh.lastModified !== null) throw invalid();
    return result;
  }
  const more = coverage.pages === null || page === null ? null : page < coverage.pages;
  const kind = corporation ? coverage.pages === null ? 'unknown' : page === 1 && coverage.pages === 1 ? 'complete_returned_response' : 'partial' : 'complete_returned_response';
  if (corporation && result.corporationId === null || !corporation && coverage.pages !== null || coverage.kind !== kind || coverage.pages !== null && page !== null && coverage.pages < page || coverage.nextPage !== (more && page !== null && page < 500 ? page + 1 : null) || coverage.pageLimitReached !== (page === 500 && more !== false) ||
      fresh.retrievedAt === null || Date.parse(fresh.retrievedAt) > Date.parse(result.generatedAt) + 60000 || fresh.state !== (fresh.cacheExpires === null ? 'unknown' : Date.parse(fresh.cacheExpires) <= Date.parse(result.generatedAt) ? 'stale' : 'fresh') || result.summary === null) throw invalid();
  const summary = result.summary, orders = result.orders, now = Date.parse(result.generatedAt);
  const catalog = new Map<number, { name: string; mapped: boolean }>();
  for (const row of orders) { const known = catalog.get(row.typeId); if (known && (known.name !== row.name || known.mapped !== row.mapped)) throw invalid(); catalog.set(row.typeId, row); }
  if (summary.orders !== orders.length || coverage.rows !== orders.length + summary.excludedCorporationOrders || corporation && summary.excludedCorporationOrders !== 0 || new Set(orders.map(row => row.orderId)).size !== orders.length ||
      summary.types !== new Set(orders.map(row => row.typeId)).size || summary.buy !== orders.filter(row => row.side === 'buy').length || summary.sell !== orders.filter(row => row.side === 'sell').length || summary.unknownSide !== orders.filter(row => row.side === 'unknown').length ||
      summary.pastReportedExpiry !== orders.filter(row => Date.parse(row.expiresAt) <= now).length || summary.dueWithin24h !== orders.filter(row => Date.parse(row.expiresAt) > now && Date.parse(row.expiresAt) <= now + 86400000).length || summary.unmappedTypes !== orders.filter(row => !row.mapped).length ||
      orders.some(row => row.remainingQuantity > row.originalQuantity || Date.parse(row.expiresAt) !== Date.parse(row.issuedAt) + row.durationDays * 86400000 || !row.mapped && row.name !== `Type ${row.typeId}`) ||
      result.status !== (kind === 'complete_returned_response' && fresh.state === 'fresh' && summary.unknownSide === 0 && summary.unmappedTypes === 0 ? 'ready' : 'partial')) throw invalid();
  return result;
}
export async function orderAnalyticsRequest(args: OrderAnalyticsArgs, signal?: AbortSignal): Promise<OrderAnalytics> {
  if (!argsSchema.safeParse(args).success) throw invalidSelection();
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(abort, 60000);
  try {
    controller.signal.throwIfAborted();
    const response = await fetch('/api/eve/order-analytics', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: controller.signal });
    if (!response.ok) throw new ConnectionResponseError(response.status === 401 ? 'Sign in again to load open orders.' : response.status === 404 ? 'This character is no longer connected. Reload connection status.' : 'Open orders could not be loaded. Try again or review the connection.', response.status);
    if (!response.headers.get('content-type')?.includes('application/json')) throw invalid();
    const value: unknown = await response.json(); controller.signal.throwIfAborted(); return orderAnalyticsResponse(value, args);
  } catch (error) {
    if (error instanceof ConnectionResponseError) throw error;
    throw new ConnectionResponseError(controller.signal.aborted ? 'The order request was cancelled or timed out.' : 'The order service could not be reached. Try again.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
