import { readWalletAnalytics } from './wallet-analytics';
import type { WalletActivityBucket, WalletActivityTotals, WalletAnalytics } from './wallet-analytics-types';

export type WalletActivityReport = WalletAnalytics & {
  dailyLimit: 30;
  /** All distinct UTC dates in the selected provider page, before this projection. */
  dailyTotalDays: number;
  dailyOmittedDays: number;
};

function totals(value: WalletActivityTotals | null): WalletActivityTotals | null {
  return value === null ? null : { incomingISK: value.incomingISK, outgoingISK: value.outgoingISK, netISK: value.netISK };
}
function bucket(value: WalletActivityBucket): WalletActivityBucket {
  return { entries: value.entries, amountEntries: value.amountEntries, missingAmountEntries: value.missingAmountEntries, totals: totals(value.totals) };
}

/** Whitelist an already validated dashboard response without retaining raw rows. */
export function projectWalletActivityReport(value: WalletAnalytics): WalletActivityReport {
  const coverage = value.coverage, freshness = value.freshness;
  return {
    characterId: value.characterId, entity: value.entity, division: value.division, corporationId: value.corporationId,
    generatedAt: value.generatedAt, status: value.status, message: value.message, scope: value.scope,
    coverage: {
      kind: coverage.kind, page: coverage.page, pages: coverage.pages, nextPage: coverage.nextPage, previousPage: coverage.previousPage,
      pageLimitReached: coverage.pageLimitReached, entries: coverage.entries, amountEntries: coverage.amountEntries,
      missingAmountEntries: coverage.missingAmountEntries, earliest: coverage.earliest, latest: coverage.latest,
    },
    freshness: { state: freshness.state, retrievedAt: freshness.retrievedAt, cacheExpires: freshness.cacheExpires, lastModified: freshness.lastModified },
    totals: totals(value.totals),
    // The service sorts dates ascending. Do not change the full-page totals or
    // coverage when bounding this daily subset for the calling chat.
    daily: value.daily.slice(-30).map(row => ({ date: row.date, ...bucket(row) })),
    dailyLimit: 30, dailyTotalDays: value.daily.length, dailyOmittedDays: Math.max(0, value.daily.length - 30),
    categories: value.categories.map(row => ({ id: row.id, label: row.label, ...bucket(row) })),
    precisionPolicy: value.precisionPolicy,
    limitations: [
      ...value.limitations,
      'Page totals, category totals and coverage describe all returned rows. Daily buckets show only the latest thirty returned UTC dates; dailyTotalDays and dailyOmittedDays identify the subset. Gaps are not filled, and daily buckets must not be summed as if they cover an omitted portion of the page.',
      'This is current on-demand journal evidence, not saved wallet history, lifetime income, a balance curve or profit. A verified empty page has zero observed activity; unavailable or entirely unreported amounts remain null. No history capture or additional pages are requested.',
    ],
  };
}

export async function readWalletActivityReport(user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<WalletActivityReport> {
  const result = await readWalletAnalytics(user, input, options);
  options.signal?.throwIfAborted();
  return projectWalletActivityReport(result);
}
