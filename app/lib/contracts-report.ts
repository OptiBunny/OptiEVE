import { readContractsAnalytics } from './contracts-analytics';
import type { ContractRecord, ContractsAnalytics } from './contracts-analytics-types';

export type ContractsReport = Omit<ContractsAnalytics, 'contracts'> & {
  upcomingOutstandingOffers: Pick<ContractRecord, 'contractId' | 'type' | 'offerExpiresAt'>[];
  upcomingOfferLimit: 20;
  upcomingOfferTotal: number | null;
  upcomingOffersOmitted: number | null;
};

/** Project one validated page. This briefing never fetches contract items or bids. */
export function projectContractsReport(value: ContractsAnalytics): ContractsReport {
  const { coverage, freshness, summary } = value;
  const upcoming = summary === null ? [] : value.contracts
    .filter(row => row.status === 'outstanding' && Date.parse(row.offerExpiresAt) > Date.parse(value.generatedAt))
    .sort((left, right) => left.offerExpiresAt.localeCompare(right.offerExpiresAt) || left.contractId - right.contractId);
  return {
    characterId: value.characterId, entity: value.entity, corporationId: value.corporationId,
    generatedAt: value.generatedAt, status: value.status, message: value.message, scope: value.scope,
    coverage: {
      kind: coverage.kind, page: coverage.page, pages: coverage.pages, nextPage: coverage.nextPage,
      previousPage: coverage.previousPage, pageLimitReached: coverage.pageLimitReached, rows: coverage.rows,
    },
    freshness: { state: freshness.state, retrievedAt: freshness.retrievedAt, cacheExpires: freshness.cacheExpires, lastModified: freshness.lastModified },
    summary: summary === null ? null : {
      contracts: summary.contracts, outstanding: summary.outstanding, inProgress: summary.inProgress,
      outstandingPastExpiry: summary.outstandingPastExpiry, outstandingDueWithin24h: summary.outstandingDueWithin24h,
    },
    statusCounts: value.statusCounts.map(row => ({ status: row.status, count: row.count })),
    typeCounts: value.typeCounts.map(row => ({ type: row.type, count: row.count })),
    upcomingOutstandingOffers: upcoming.slice(0, 20).map(row => ({ contractId: row.contractId, type: row.type, offerExpiresAt: row.offerExpiresAt })),
    upcomingOfferLimit: 20, upcomingOfferTotal: summary === null ? null : upcoming.length,
    upcomingOffersOmitted: summary === null ? null : Math.max(0, upcoming.length - 20),
    limitations: [
      ...value.limitations,
      'Summary and status/type counts describe the whole returned page. Upcoming offers show at most twenty outstanding contracts whose reported offer expiry is after generatedAt, ordered by expiry and contract ID. Upcoming totals and omissions are unknown when the page is unavailable.',
      'Offer expiry is not an accepted courier delivery deadline. A passed date does not change the reported contract status or prove failure, fulfillment, reward or loss. No extra pages, contract items, bids, counterparties, locations or history are requested.',
    ],
  };
}

export async function readContractsReport(user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<ContractsReport> {
  const result = await readContractsAnalytics(user, input, options);
  options.signal?.throwIfAborted();
  return projectContractsReport(result);
}
