import type { WalletActivityBucket, WalletActivityCategoryId, WalletActivityTotals } from './wallet-analytics-types';

export type WalletHistoryDays = 30 | 90 | 365;
export type WalletHistoryArgs = { characterId: number } & (
  { operation: 'status' | 'capture' } |
  { operation: 'configure'; enabled: boolean; retentionDays?: WalletHistoryDays } |
  { operation: 'report'; days?: WalletHistoryDays } |
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
    days: WalletHistoryDays;
    entries: number;
    amountEntries: number;
    missingAmountEntries: number;
    earliest: string | null;
    latest: string | null;
    totals: WalletActivityTotals | null;
    daily: Array<WalletActivityBucket & { date: string }>;
    categories: Array<WalletActivityBucket & { id: WalletActivityCategoryId; label: string }>;
  };
  lastCapture: WalletHistoryCapture | null;
  limits: { maxPages: 4; maxEvents: 10000 };
  precisionPolicy: string;
  limitations: string[];
};
