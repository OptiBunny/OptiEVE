import type { AnalyticsOrder } from './order-analytics-types';

type Decimal = { units: bigint; scale: number };
export type OrderWindow = 'past' | 'next24h' | 'days2To7' | 'days8To30' | 'later';
export type OrderValueTotals = { orders: number; buyOrders: number; sellOrders: number; buyBidISK: string; sellAskISK: string };
export type OrderTypeValues = OrderValueTotals & { typeId: number; name: string; mapped: boolean; buyRemainingQuantity: string; sellRemainingQuantity: string };
export type OrderExpirySchedule = { asOf: string; horizonDays: 30; past: number; next24h: number; days2To7: number; days8To30: number; later: number; daily: { date: string; orders: number }[] };
const zero = (): Decimal => ({ units: 0n, scale: 2 });
const integer = (value: number, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
function receivedPrice(value: string): Decimal {
  // Number is used only to validate the existing received-number contract.
  // Products and additions below never use floating-point arithmetic.
  if (typeof value !== 'string' || value.length > 32 || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > Number.MAX_SAFE_INTEGER || String(Number(value)) !== value) throw new RangeError('Invalid order price.');
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(value);
  if (!match) throw new RangeError('Invalid order price.');
  const fraction = match[2] ?? '', exponent = Number(match[3] ?? 0), scale = fraction.length - exponent;
  if (scale > 324 || scale < -16) throw new RangeError('Invalid order precision.');
  return { units: BigInt(match[1] + fraction) * (scale < 0 ? 10n ** BigInt(-scale) : 1n), scale: Math.max(0, scale) };
}
function add(target: Decimal, amount: Decimal) {
  const scale = Math.max(target.scale, amount.scale);
  target.units = target.units * 10n ** BigInt(scale - target.scale) + amount.units * 10n ** BigInt(scale - amount.scale); target.scale = scale;
}
function format(value: Decimal): string {
  const scale = Math.max(2, value.scale), digits = (value.units * 10n ** BigInt(scale - value.scale)).toString().padStart(scale + 1, '0');
  return digits.slice(0, -scale) + '.' + digits.slice(-scale).replace(/0+$/, '').padEnd(2, '0');
}
export function compareOrderISK(left: string, right: string): number {
  const parse = (value: string): Decimal => { if (value.length > 361 || !/^(?:0|[1-9]\d{0,35})\.\d{2,324}$/.test(value)) throw new RangeError('Invalid order value.'); const [whole, fraction] = value.split('.'); return { units: BigInt(whole + fraction), scale: fraction.length }; };
  const a = parse(left), b = parse(right), scale = Math.max(a.scale, b.scale), x = a.units * 10n ** BigInt(scale - a.scale), y = b.units * 10n ** BigInt(scale - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}
export function orderExpiryWindow(expiresAt: string, asOf: number): OrderWindow {
  const remaining = Date.parse(expiresAt) - asOf;
  return remaining <= 0 ? 'past' : remaining <= 86400000 ? 'next24h' : remaining <= 7 * 86400000 ? 'days2To7' : remaining <= 30 * 86400000 ? 'days8To30' : 'later';
}
type Accumulator = { orders: number; buyOrders: number; sellOrders: number; buy: Decimal; sell: Decimal; buyQuantity: bigint; sellQuantity: bigint };
const accumulator = (): Accumulator => ({ orders: 0, buyOrders: 0, sellOrders: 0, buy: zero(), sell: zero(), buyQuantity: 0n, sellQuantity: 0n });
function include(target: Accumulator, order: AnalyticsOrder, value: Decimal, quantities: boolean) {
  target.orders++;
  if (order.side === 'buy') { target.buyOrders++; add(target.buy, value); if (quantities) target.buyQuantity += BigInt(order.remainingQuantity); }
  else { target.sellOrders++; add(target.sell, value); if (quantities) target.sellQuantity += BigInt(order.remainingQuantity); }
}
const totals = (value: Accumulator): OrderValueTotals => ({ orders: value.orders, buyOrders: value.buyOrders, sellOrders: value.sellOrders, buyBidISK: format(value.buy), sellAskISK: format(value.sell) });

/** Derive values from one already validated response. No price/quantity rounding,
 * cross-type quantity total, additional lookup or persistence is performed. */
export function groupOpenOrders(orders: AnalyticsOrder[], generatedAt: string) {
  if (orders.length > 5000 || typeof generatedAt !== 'string' || generatedAt.length !== 24 || !Number.isFinite(Date.parse(generatedAt)) || new Date(generatedAt).toISOString() !== generatedAt) throw new RangeError('Invalid order evidence.');
  const asOf = Date.parse(generatedAt), all = accumulator(), types = new Map<number, { row: AnalyticsOrder; amounts: Accumulator }>(), seen = new Set<number>(), days = new Map<string, number>();
  const schedule: OrderExpirySchedule = { asOf: generatedAt, horizonDays: 30, past: 0, next24h: 0, days2To7: 0, days8To30: 0, later: 0, daily: [] };
  const valuedOrders = orders.map(order => {
    if (!integer(order.orderId, 1) || seen.has(order.orderId) || !integer(order.typeId, 1) || !integer(order.remainingQuantity) || !integer(order.originalQuantity, 1) || order.remainingQuantity > order.originalQuantity || order.side !== 'buy' && order.side !== 'sell' || typeof order.expiresAt !== 'string' || order.expiresAt.length !== 24 || !Number.isFinite(Date.parse(order.expiresAt)) || new Date(order.expiresAt).toISOString() !== order.expiresAt) throw new RangeError('Invalid order evidence.');
    seen.add(order.orderId);
    const amount = receivedPrice(order.unitPrice); amount.units *= BigInt(order.remainingQuantity);
    const group = types.get(order.typeId) ?? { row: order, amounts: accumulator() };
    include(all, order, amount, false); include(group.amounts, order, amount, true); types.set(order.typeId, group);
    const window = orderExpiryWindow(order.expiresAt, asOf); schedule[window]++;
    if (window !== 'past' && window !== 'later') { const day = order.expiresAt.slice(0, 10); days.set(day, (days.get(day) ?? 0) + 1); }
    return { order, remainingValueISK: format(amount) };
  });
  schedule.daily = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, orders]) => ({ date, orders }));
  const byType: OrderTypeValues[] = [...types].sort(([a], [b]) => a - b).map(([typeId, value]) => ({ typeId, name: value.row.name, mapped: value.row.mapped, ...totals(value.amounts), buyRemainingQuantity: value.amounts.buyQuantity.toString(), sellRemainingQuantity: value.amounts.sellQuantity.toString() }));
  return { totals: totals(all), byType, schedule, valuedOrders };
}
export function rankOrderTypes(rows: OrderTypeValues[], side: 'buy' | 'sell'): OrderTypeValues[] {
  const money = side === 'buy' ? 'buyBidISK' : 'sellAskISK', count = side === 'buy' ? 'buyOrders' : 'sellOrders';
  return rows.filter(row => row[count] > 0).sort((a, b) => compareOrderISK(b[money], a[money]) || a.typeId - b.typeId);
}
