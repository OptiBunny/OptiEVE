export type InventoryAnalyticsArgs = { characterId: number; entity: 'character' | 'corporation'; page?: number };
export type InventoryLocationKind = 'station' | 'solar_system' | 'item' | 'other';
export type InventoryAnalytics = {
  characterId: number;
  entity: 'character' | 'corporation';
  corporationId: number | null;
  generatedAt: string;
  status: 'ready' | 'partial' | 'needs_permission' | 'unavailable' | 'error';
  message: string;
  scope: string;
  coverage: {
    kind: 'complete_returned_list' | 'partial' | 'unknown' | 'unavailable';
    page: number; pages: number | null; nextPage: number | null; previousPage: number | null;
    pageLimitReached: boolean; records: number;
  };
  freshness: { state: 'fresh' | 'stale' | 'unknown'; retrievedAt: string | null; cacheExpires: string | null; lastModified: string | null };
  summary: {
    records: number; types: number; locations: number; singletonRecords: number;
    blueprintCopyRecords: number; blueprintCopyUnknownRecords: number; unmappedTypeRecords: number;
  } | null;
  categories: Array<{ categoryId: number | null; name: string; records: number; typeCount: number }>;
  groups: Array<{ groupId: number | null; name: string; categoryId: number | null; categoryName: string; records: number; typeCount: number }>;
  types: Array<{
    typeId: number; name: string; groupId: number | null; groupName: string; categoryId: number | null; categoryName: string;
    records: number; quantity: number; singletonRecords: number; blueprintCopyRecords: number; blueprintCopyUnknownRecords: number;
  }>;
  locations: Array<{ locationId: number; kind: InventoryLocationKind; records: number; typeCount: number }>;
  limitations: string[];
};
