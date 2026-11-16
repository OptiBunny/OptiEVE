import type { MarketTransactionCell, MarketTransactionType, MarketTransactionsAnalytics } from './market-transactions-types';

type Decimal = { units: bigint; scale: number };
const zero = (): Decimal => ({ units: 0n, scale: 2 });
function decimal(value: string): Decimal {
  if (value.length > 361 || !/^(?:0|[1-9]\d{0,35})\.\d{2,324}$/.test(value) || value.split('.')[1].length > 2 && value.endsWith('0')) throw new RangeError('Invalid exact market amount.');
  const [whole, fraction] = value.split('.'); return { units: BigInt(whole + fraction), scale: fraction.length };
}
function add(target: Decimal, value: Decimal) {
  const scale = Math.max(target.scale, value.scale);
  target.units = target.units * 10n ** BigInt(scale - target.scale) + value.units * 10n ** BigInt(scale - value.scale); target.scale = scale;
}
function format(value: Decimal): string {
  const digits = value.units.toString().padStart(value.scale + 1, '0'), whole = digits.slice(0, -value.scale), fraction = digits.slice(-value.scale).replace(/0+$/, '').padEnd(2, '0');
  return whole + '.' + fraction;
}
export function compareMarketISK(left: string, right: string): number {
  const a = decimal(left), b = decimal(right), scale = Math.max(a.scale, b.scale), first = a.units * 10n ** BigInt(scale - a.scale), second = b.units * 10n ** BigInt(scale - b.scale);
  return first < second ? -1 : first > second ? 1 : 0;
}
export type MarketValueGroup = { entries: number; buyEntries: number; sellEntries: number; grossPurchasesISK: string; grossSalesISK: string };
type Accumulator = { entries: number; buyEntries: number; sellEntries: number; buy: Decimal; sell: Decimal; buyQuantity: bigint; sellQuantity: bigint };
const accumulator = (): Accumulator => ({ entries: 0, buyEntries: 0, sellEntries: 0, buy: zero(), sell: zero(), buyQuantity: 0n, sellQuantity: 0n });
function include(group: Accumulator, cell: MarketTransactionCell, amount: Decimal, quantity: bigint) {
  group.entries += cell.entries;
  if (cell.side === 'buy') { group.buyEntries += cell.entries; group.buyQuantity += quantity; add(group.buy, amount); }
  else { group.sellEntries += cell.entries; group.sellQuantity += quantity; add(group.sell, amount); }
}
const values = (group: Accumulator): MarketValueGroup => ({ entries: group.entries, buyEntries: group.buyEntries, sellEntries: group.sellEntries, grossPurchasesISK: format(group.buy), grossSalesISK: format(group.sell) });

/** Aggregate already validated cells, including a locally filtered subset.
 * Quantities are exposed only within one type, never across unlike items. */
export function groupMarketTransactionCells(cells: MarketTransactionCell[], types: MarketTransactionType[]): {
  summary: NonNullable<MarketTransactionsAnalytics['summary']>;
  daily: (MarketValueGroup & { date: string })[];
  byType: (MarketValueGroup & MarketTransactionType & { buyQuantity: string; sellQuantity: string; grossTradeISK: string })[];
} {
  if (cells.length > 2500 || types.length > 2500) throw new RangeError('Market grouping limit exceeded.');
  const labels = new Map(types.map(type => [type.typeId, type])), days = new Map<string, Accumulator>(), items = new Map<number, Accumulator>(), total = accumulator();
  for (const cell of cells) {
    if (!labels.has(cell.typeId) || !Number.isSafeInteger(cell.entries) || cell.entries < 1 || cell.entries > 2500 || !/^(?:0|[1-9]\d{0,19})$/.test(cell.quantity) || cell.side !== 'buy' && cell.side !== 'sell') throw new RangeError('Invalid market grouping evidence.');
    const amount = decimal(cell.grossISK), quantity = BigInt(cell.quantity), day = days.get(cell.date) ?? accumulator(), item = items.get(cell.typeId) ?? accumulator();
    include(total, cell, amount, 0n); include(day, cell, amount, 0n); include(item, cell, amount, quantity); days.set(cell.date, day); items.set(cell.typeId, item);
  }
  const byType = [...items].sort(([a], [b]) => a - b).map(([typeId, group]) => { const combined = { ...group.buy }; add(combined, group.sell); return { ...labels.get(typeId)!, ...values(group), buyQuantity: group.buyQuantity.toString(), sellQuantity: group.sellQuantity.toString(), grossTradeISK: format(combined) }; });
  const totals = values(total);
  return { summary: { entries: totals.entries, buyEntries: totals.buyEntries, sellEntries: totals.sellEntries, types: byType.length, unmappedTypes: byType.filter(type => !type.mapped).length, grossPurchasesISK: totals.grossPurchasesISK, grossSalesISK: totals.grossSalesISK },
    daily: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, group]) => ({ date, ...values(group) })), byType };
}
