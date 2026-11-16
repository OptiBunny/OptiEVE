import { readMarketTransactions } from './market-transactions';
import { compareMarketISK, groupMarketTransactionCells } from './market-transactions-grouping';
import type { MarketTransactionsAnalytics } from './market-transactions-types';

type Groups = ReturnType<typeof groupMarketTransactionCells>;
export type MarketTransactionsReport = Omit<MarketTransactionsAnalytics, 'cells' | 'types'> & {
  daily: Groups['daily'];
  dailyLimit: 30;
  dailyTotal: number | null;
  dailyOmitted: number | null;
  topTypes: Groups['byType'];
  typeLimit: 20;
  typeTotal: number | null;
  typesOmitted: number | null;
};

/** Project a single validated batch; never joins cursors or reads another feed. */
export function projectMarketTransactionsReport(value: MarketTransactionsAnalytics): MarketTransactionsReport {
  const groups = value.summary === null ? null : groupMarketTransactionCells(value.cells, value.types);
  const { coverage, freshness, summary } = value;
  const ranked = groups?.byType.slice().sort((a, b) => compareMarketISK(b.grossTradeISK, a.grossTradeISK) || a.typeId - b.typeId) ?? [];
  return {
    characterId: value.characterId, entity: value.entity, corporationId: value.corporationId, division: value.division,
    generatedAt: value.generatedAt, status: value.status, message: value.message, scope: value.scope,
    coverage: {
      kind: coverage.kind, fromId: coverage.fromId, nextFromId: coverage.nextFromId,
      returnedEntries: coverage.returnedEntries, includedEntries: coverage.includedEntries,
      excludedCorporationEntries: coverage.excludedCorporationEntries, boundaryEntries: coverage.boundaryEntries,
      includedBoundaryEntries: coverage.includedBoundaryEntries,
      firstIncludedDate: coverage.firstIncludedDate, lastIncludedDate: coverage.lastIncludedDate,
    },
    freshness: { state: freshness.state, retrievedAt: freshness.retrievedAt, cacheExpires: freshness.cacheExpires, lastModified: freshness.lastModified },
    summary: summary === null ? null : {
      entries: summary.entries, buyEntries: summary.buyEntries, sellEntries: summary.sellEntries, types: summary.types,
      unmappedTypes: summary.unmappedTypes, grossPurchasesISK: summary.grossPurchasesISK, grossSalesISK: summary.grossSalesISK,
    },
    daily: (groups?.daily.slice(-30) ?? []).map(row => ({ date: row.date, entries: row.entries, buyEntries: row.buyEntries, sellEntries: row.sellEntries, grossPurchasesISK: row.grossPurchasesISK, grossSalesISK: row.grossSalesISK })),
    dailyLimit: 30, dailyTotal: groups?.daily.length ?? null, dailyOmitted: groups === null ? null : Math.max(0, groups.daily.length - 30),
    topTypes: ranked.slice(0, 20).map(row => ({ typeId: row.typeId, name: row.name, mapped: row.mapped, entries: row.entries,
      buyEntries: row.buyEntries, sellEntries: row.sellEntries, buyQuantity: row.buyQuantity, sellQuantity: row.sellQuantity,
      grossPurchasesISK: row.grossPurchasesISK, grossSalesISK: row.grossSalesISK, grossTradeISK: row.grossTradeISK })),
    typeLimit: 20, typeTotal: groups?.byType.length ?? null, typesOmitted: groups === null ? null : Math.max(0, groups.byType.length - 20),
    precisionPolicy: value.precisionPolicy,
    limitations: [
      ...value.limitations,
      'Summary describes the entire returned batch. Daily groups show at most the latest thirty included UTC dates, without filling missing dates with zero. Type groups show at most twenty types ranked by gross purchases plus gross sales, with type ID as a tie breaker. Totals and omissions are explicit; unavailable counts remain unknown.',
      'Gross trade activity combines purchases and sales only for ranking. It is not profit, margin, wallet balance, cost basis or net worth. Quantities remain per type and side, never summed across unlike items. Fees, taxes and other wallet events are not included.',
      'This report does not return individual transaction rows, counterparties, locations or journal references. A cursor-boundary row can repeat in another batch; batches are not combined or saved, and a terminal cursor does not prove complete history.',
    ],
  };
}

export async function readMarketTransactionsReport(user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<MarketTransactionsReport> {
  const result = await readMarketTransactions(user, input, options);
  options.signal?.throwIfAborted();
  return projectMarketTransactionsReport(result);
}
