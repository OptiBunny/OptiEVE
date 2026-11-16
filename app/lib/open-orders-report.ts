import { EveError } from './eve';
import { readOrderAnalytics } from './order-analytics';
import { groupOpenOrders, rankOrderTypes, type OrderTypeValues } from './order-explorer';
import type { OrderAnalytics } from './order-analytics-types';

function publicName(name: string) { const points = Array.from(name); return { name: points.slice(0, 128).join(''), nameTruncated: points.length > 128 }; }
function type(row: OrderTypeValues, side: 'buy' | 'sell') {
  return { typeId: row.typeId, ...publicName(row.name), mapped: row.mapped,
    orders: side === 'buy' ? row.buyOrders : row.sellOrders,
    remainingQuantity: side === 'buy' ? row.buyRemainingQuantity : row.sellRemainingQuantity,
    quotedValueISK: side === 'buy' ? row.buyBidISK : row.sellAskISK };
}

/** Explicit compact projection of one normalized order response. Persistent order,
 * issuer and location IDs, escrow and raw provider fields are not exposed. */
export function projectOpenOrdersReport(value: OrderAnalytics) {
  let grouped: ReturnType<typeof groupOpenOrders> | null = null;
  try { if (value.summary !== null) grouped = groupOpenOrders(value.orders, value.generatedAt); }
  catch { throw new EveError('The order values could not be summarized safely. No derived briefing was returned.', 502); }
  const buy = grouped ? rankOrderTypes(grouped.byType, 'buy') : [], sell = grouped ? rankOrderTypes(grouped.byType, 'sell') : [];
  const future = grouped ? grouped.valuedOrders.filter(row => Date.parse(row.order.expiresAt) > Date.parse(value.generatedAt)).sort((a, b) => a.order.expiresAt.localeCompare(b.order.expiresAt) || a.order.orderId - b.order.orderId) : [];
  const { coverage, freshness, summary } = value;
  const report = {
    characterId: value.characterId, entity: value.entity, corporationId: value.corporationId,
    generatedAt: value.generatedAt, status: value.status, message: value.message, scope: value.scope,
    coverage: { kind: coverage.kind, page: coverage.page, pages: coverage.pages, nextPage: coverage.nextPage, previousPage: coverage.previousPage, pageLimitReached: coverage.pageLimitReached, rows: coverage.rows },
    freshness: { state: freshness.state, retrievedAt: freshness.retrievedAt, cacheExpires: freshness.cacheExpires, lastModified: freshness.lastModified },
    summary: summary === null ? null : { orders: summary.orders, types: summary.types, buy: summary.buy, sell: summary.sell,
      excludedCorporationOrders: summary.excludedCorporationOrders, pastReportedExpiry: summary.pastReportedExpiry, dueWithin24h: summary.dueWithin24h, unmappedTypes: summary.unmappedTypes },
    values: grouped === null ? null : { buyBidISK: grouped.totals.buyBidISK, sellAskISK: grouped.totals.sellAskISK },
    schedule: grouped === null ? null : { asOf: grouped.schedule.asOf, horizonDays: grouped.schedule.horizonDays, past: grouped.schedule.past,
      next24h: grouped.schedule.next24h, days2To7: grouped.schedule.days2To7, days8To30: grouped.schedule.days8To30, later: grouped.schedule.later,
      daily: grouped.schedule.daily.map(row => ({ date: row.date, orders: row.orders })) },
    topBuyTypes: buy.slice(0, 20).map(row => type(row, 'buy')), topSellTypes: sell.slice(0, 20).map(row => type(row, 'sell')),
    buyTypesTotal: grouped === null ? null : buy.length, buyTypesOmitted: grouped === null ? null : Math.max(0, buy.length - 20),
    sellTypesTotal: grouped === null ? null : sell.length, sellTypesOmitted: grouped === null ? null : Math.max(0, sell.length - 20),
    upcomingOrders: future.slice(0, 20).map(({ order, remainingValueISK }, index) => ({ row: index + 1, typeId: order.typeId, ...publicName(order.name), mapped: order.mapped,
      side: order.side, unitPrice: order.unitPrice, remainingQuantity: order.remainingQuantity, quotedValueISK: remainingValueISK,
      issuedAt: order.issuedAt, expiresAt: order.expiresAt, durationDays: order.durationDays })),
    upcomingOrdersTotal: grouped === null ? null : future.length, upcomingOrdersOmitted: grouped === null ? null : Math.max(0, future.length - 20),
    limits: { buyTypes: 20, sellTypes: 20, upcomingOrders: 20, publicNameCodePoints: 128 },
    limitations: [
      ...value.limitations,
      'Quoted values use exact decimal multiplication and addition on the received unit-price representation, without cent rounding. Buy bid and sell asking values are separate and must not be netted into profit, cash or portfolio value. Quantities are grouped only within one item type and side.',
      'Top buy and sell groups are ranked independently by remaining quoted value, tied by numeric type ID. Full values and schedule counts cover the entire included response; group and future-preview omissions are explicit and unknown when the source is unavailable.',
      'Upcoming rows are the first twenty reported expiries after generatedAt, ordered by expiry then order ID internally. They can include dates beyond the thirty-day calendar. Row numbers are response-local; persistent order IDs and private issuer/location/escrow fields are omitted. Names are public catalog labels, bounded with explicit truncation.',
      'No additional pages, market prices, escrow reads, account history, automatic polling, EVE writes or permission changes are requested. A date or a remaining/original quantity difference does not establish a fill, sale, cancellation or completion.',
    ],
  };
  if (new TextEncoder().encode(JSON.stringify(report)).byteLength > 256 * 1024) throw new EveError('The open-order briefing exceeds the safe response limit. No partial briefing was returned.', 502);
  return report;
}
export type OpenOrdersReport = ReturnType<typeof projectOpenOrdersReport>;
export async function readOpenOrdersReport(user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<OpenOrdersReport> {
  options.signal?.throwIfAborted();
  const result = await readOrderAnalytics(user, input, options);
  options.signal?.throwIfAborted();
  const report = projectOpenOrdersReport(result);
  options.signal?.throwIfAborted();
  return report;
}
