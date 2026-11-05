import type { BlueprintAnalytics } from './blueprint-analytics-types';

export type BlueprintCollectionArgs = { characterId: number };
export type BlueprintCollectionStopReason = 'complete' | 'missing_page_count' | 'page_limit' | 'row_limit' | 'provider_error' | 'invalid_page' | 'pagination_changed' | 'snapshot_changed' | 'corporation_changed' | 'conflicting_duplicate' | 'cancelled' | 'deadline';
export type BlueprintCollectionProgress = {
  pagesRead: number;
  pagesExpected: number | null;
  /** Rows in validated, transactionally accepted pages, before deduplication. */
  rowsReceived: number;
  uniqueRecords: number;
  duplicateRecords: number;
  pageLimit: 50;
  rowLimit: 50000;
};
export type BlueprintCollection = Omit<BlueprintAnalytics, 'entity' | 'coverage'> & {
  entity: 'corporation';
  coverage: BlueprintCollectionProgress & {
    kind: 'all_reported_pages' | 'partial' | 'unknown' | 'unavailable';
    completedPages: number[];
    consistency: 'consistent' | 'unknown' | 'inconsistent';
    stopReason: BlueprintCollectionStopReason;
    failedPage: number | null;
    /** A known historical provider ceiling may hide further owned records. */
    providerCeilingPossible: boolean;
  };
};
