import { readHistoricalOrders } from './historical-orders';
import type { HistoricalOrders } from './historical-orders-types';

export function projectHistoricalOrdersReport(result: HistoricalOrders) {
  const { summary, coverage, freshness } = result;
  const byType = new Map<number, number>(), byDay = new Map<string, number>();
  for (const { typeId, issuedAt } of result.orders) {
    byType.set(typeId, (byType.get(typeId) ?? 0) + 1);
    const day = issuedAt.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const topTypes = result.types.map(({ typeId, name, mapped }) => ({ typeId, name, mapped, orders: byType.get(typeId) ?? 0 }))
    .sort((a, b) => b.orders - a.orders || a.typeId - b.typeId).slice(0, 20);
  const latestIssuedDates = [...byDay].sort(([a], [b]) => b.localeCompare(a)).slice(0, 30).map(([date, orders]) => ({ date, orders }));
  const report = {
    characterId: result.characterId, generatedAt: result.generatedAt, status: result.status, message: result.message, scope: result.scope,
    coverage: {
      kind: coverage.kind, page: coverage.page, pages: coverage.pages, previousPage: coverage.previousPage, nextPage: coverage.nextPage,
      pageLimitReached: coverage.pageLimitReached, returnedRows: coverage.returnedRows, includedRows: coverage.includedRows, excludedCorporationRows: coverage.excludedCorporationRows,
    },
    freshness: { state: freshness.state, retrievedAt: freshness.retrievedAt, cacheExpires: freshness.cacheExpires, lastModified: freshness.lastModified },
    summary: summary && {
      orders: summary.orders, types: summary.types, buy: summary.buy, sell: summary.sell, cancelled: summary.cancelled, expired: summary.expired,
      other: summary.other, unmappedTypes: summary.unmappedTypes, earliestIssuedAt: summary.earliestIssuedAt, latestIssuedAt: summary.latestIssuedAt,
    },
    topTypes, typeGroups: { total: summary ? byType.size : null, shown: summary ? topTypes.length : null, omitted: summary ? byType.size - topTypes.length : null },
    latestIssuedDates, issueDays: { total: summary ? byDay.size : null, shown: summary ? latestIssuedDates.length : null, omitted: summary ? byDay.size - latestIssuedDates.length : null },
    limitations: [...result.limitations],
  };
  if (new TextEncoder().encode(JSON.stringify(report)).byteLength > 65536) throw new Error('The historical order report exceeded its size limit.');
  return report;
}

export async function readHistoricalOrdersReport(user: string, input: unknown, options: { signal?: AbortSignal } = {}) {
  options.signal?.throwIfAborted();
  const result = await readHistoricalOrders(user, input, options);
  options.signal?.throwIfAborted();
  return projectHistoricalOrdersReport(result);
}
