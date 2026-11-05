// Browser-safe projection. Journal rows, participants and descriptions never leave the service.
export type WalletAnalyticsArgs = {
  characterId: number;
  entity: 'character' | 'corporation';
  division?: number;
  page?: number;
};
export type WalletActivityTotals = {
  /** Nonnegative exact decimal strings from the reported numeric amounts. */
  incomingISK: string;
  outgoingISK: string;
  /** Signed incoming minus outgoing; cash flow, never profit. */
  netISK: string;
};
export type WalletActivityBucket = {
  entries: number;
  amountEntries: number;
  missingAmountEntries: number;
  /** Null when rows exist but none report an amount. */
  totals: WalletActivityTotals | null;
};
export type WalletActivityCategoryId = 'market' | 'transfers' | 'rewards' | 'fees' | 'industry' | 'contracts' | 'other';
export type WalletAnalytics = {
  characterId: number;
  entity: 'character' | 'corporation';
  division: number | null;
  corporationId: number | null;
  generatedAt: string;
  status: 'ready' | 'partial' | 'needs_permission' | 'unavailable' | 'error';
  message: string;
  scope: string;
  coverage: {
    kind: 'complete_returned_window' | 'partial' | 'unknown' | 'unavailable';
    page: number;
    pages: number | null;
    nextPage: number | null;
    previousPage: number | null;
    pageLimitReached: boolean;
    entries: number;
    amountEntries: number;
    missingAmountEntries: number;
    earliest: string | null;
    latest: string | null;
  };
  freshness: {
    state: 'fresh' | 'stale' | 'unknown';
    retrievedAt: string | null;
    cacheExpires: string | null;
    lastModified: string | null;
  };
  totals: WalletActivityTotals | null;
  daily: Array<WalletActivityBucket & { date: string }>;
  categories: Array<WalletActivityBucket & { id: WalletActivityCategoryId; label: string }>;
  precisionPolicy: string;
  limitations: string[];
};
