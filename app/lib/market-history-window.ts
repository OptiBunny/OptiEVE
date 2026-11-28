import type { MarketHistoryResponse } from './market-history-types';

const DAY = 86_400_000;

/** Input rows have already passed the public history reader's UTC and decimal checks. */
export function marketHistoryGaps({ rows, window }: MarketHistoryResponse) {
  const observed = new Set(rows.map(row => row.date));
  const gaps: { start: string; end: string }[] = [];
  let gap: { start: string; end: string } | undefined;
  const start = Date.parse(window.startUTC + 'T00:00:00Z');
  for (let i = 0; i < window.days; i++) {
    const date = new Date(start + i * DAY).toISOString().slice(0, 10);
    if (observed.has(date)) {
      gap = undefined;
    } else if (gap) {
      gap.end = date;
    } else {
      gap = { start: date, end: date };
      gaps.push(gap);
    }
  }
  return gaps;
}

export function trailingMarketPrice({ rows, window }: MarketHistoryResponse, days: 7 | 30) {
  const end = Date.parse(window.endExclusiveUTC + 'T00:00:00Z');
  const start = end - days * DAY;
  const observations = rows.filter(row => Date.parse(row.date + 'T00:00:00Z') >= start);
  const count = observations.length;
  if (!count) return { count, price: null };

  // Add the reported decimals exactly before rounding the quotient for display.
  const parts = observations.map(row => row.averageISK.split('.'));
  const scale = Math.max(8, ...parts.map(([, fraction = '']) => fraction.length));
  const total = parts.reduce((sum, [whole, fraction = '']) =>
    sum + BigInt(whole + fraction.padEnd(scale, '0')), 0n);
  const divisor = BigInt(count) * 10n ** BigInt(scale - 8);
  const units = (total + divisor / 2n) / divisor;
  if (total > 0n && units === 0n) return { count, price: '<0.00000001' };
  const digits = units.toString().padStart(9, '0');
  const fraction = digits.slice(-8).replace(/0+$/, '');
  const price = digits.slice(0, -8) + (fraction && '.' + fraction);
  return { count, price };
}
