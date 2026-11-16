import type { WalletActivityBucket, WalletActivityCategoryId, WalletActivityTotals } from './wallet-analytics-types';

export type WalletHistoryDays = 30 | 90 | 365;
/** Report duration is independent of the permitted storage-retention choices. */
export type WalletHistoryReportDays = 7 | WalletHistoryDays;
export type WalletHistoryArgs = { characterId: number } & (
  { operation: 'status' | 'capture' } |
  { operation: 'configure'; enabled: boolean; retentionDays?: WalletHistoryDays } |
  { operation: 'report'; days?: WalletHistoryReportDays; comparePrevious?: boolean } |
  { operation: 'clear'; confirm: 'delete_wallet_history' }
);
export type WalletHistoryCapture = {
  /** Last journal read completion, before encrypting and committing history. */
  at: string;
  pagesRead: number;
  pagesAdvertised: number | null;
  entriesRead: number;
  addedEntries: number;
  /** All advertised pages still do not establish a complete calendar period. */
  coverage: 'returned_pages' | 'partial' | 'unknown';
  freshness: 'fresh' | 'stale' | 'unknown';
  retrievedAt: string;
  cacheExpires: string | null;
};
export type WalletHistoryView = {
  characterId: number;
  generatedAt: string;
  status: 'disabled' | 'ready' | 'partial' | 'empty';
  message: string;
  settings: { enabled: boolean; retentionDays: WalletHistoryDays };
  report: {
    days: WalletHistoryReportDays;
    entries: number;
    amountEntries: number;
    missingAmountEntries: number;
    earliest: string | null;
    latest: string | null;
    totals: WalletActivityTotals | null;
    daily: Array<WalletActivityBucket & { date: string }>;
    categories: Array<WalletActivityBucket & { id: WalletActivityCategoryId; label: string }>;
  };
  /** Included only for an explicitly requested report comparison.
   * Comparison reports exclude future timestamps; legacy reports retain their
   * existing bounded clock-skew tolerance. Both periods contain observations,
   * not proof of complete calendar coverage. */
  comparison?: {
    current: { startsAt: string; endsAt: string; retentionClipped: boolean };
    previous: WalletActivityBucket & {
      startsAt: string; endsBefore: string; retentionClipped: boolean;
      earliest: string | null; latest: string | null;
    };
    /** Signed differences of observed amounts; null when either period has no
     * known totals, missing amounts or a retention-clipped requested window. */
    observedDelta: { incomingISK: string; outgoingISK: string; netISK: string } | null;
  };
  lastCapture: WalletHistoryCapture | null;
  limits: { maxPages: 4; maxEvents: 10000 };
  precisionPolicy: string;
  limitations: string[];
};
