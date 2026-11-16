// Browser-safe contract summaries. Raw parties, titles, locations and money are excluded.
export type ContractsAnalyticsArgs = { characterId: number; entity: 'character' | 'corporation'; page?: number };
export type ContractType = 'unknown' | 'item_exchange' | 'auction' | 'courier' | 'loan';
export type ContractStatus = 'outstanding' | 'in_progress' | 'finished_issuer' | 'finished_contractor' | 'finished' | 'cancelled' | 'rejected' | 'failed' | 'deleted' | 'reversed';
export type ContractRecord = {
  contractId: number;
  type: ContractType;
  status: ContractStatus;
  issuedAt: string;
  offerExpiresAt: string;
  acceptedAt: string | null;
  daysToComplete: number | null;
};
export type ContractsAnalytics = {
  characterId: number;
  entity: 'character' | 'corporation';
  corporationId: number | null;
  generatedAt: string;
  status: 'ready' | 'partial' | 'needs_permission' | 'unavailable' | 'error';
  message: string;
  scope: string;
  coverage: {
    kind: 'complete_returned_response' | 'partial' | 'unknown' | 'unavailable';
    page: number;
    pages: number | null;
    nextPage: number | null;
    previousPage: number | null;
    pageLimitReached: boolean;
    rows: number;
  };
  freshness: {
    state: 'fresh' | 'stale' | 'unknown';
    retrievedAt: string | null;
    cacheExpires: string | null;
    lastModified: string | null;
  };
  summary: {
    contracts: number;
    outstanding: number;
    inProgress: number;
    outstandingPastExpiry: number;
    outstandingDueWithin24h: number;
  } | null;
  statusCounts: { status: ContractStatus; count: number }[];
  typeCounts: { type: ContractType; count: number }[];
  contracts: ContractRecord[];
  limitations: string[];
};
