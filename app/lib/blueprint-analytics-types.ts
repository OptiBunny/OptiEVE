export type BlueprintAnalyticsArgs = { characterId: number; entity: 'character' | 'corporation'; page?: number };
export type BlueprintKind = 'original' | 'copy' | 'original_stack';
export type BlueprintAnalyticsRow = {
  /** Response-local position, never an EVE item identifier. */
  row: number;
  typeId: number;
  name: string;
  catalogMapped: boolean;
  kind: BlueprintKind;
  units: number;
  materialEfficiency: number;
  timeEfficiency: number;
  /** Null means an original, whose runs are unlimited; it is not a finite count. */
  copyRuns: number | null;
};
export type BlueprintAnalytics = {
  characterId: number;
  entity: 'character' | 'corporation';
  corporationId: number | null;
  generatedAt: string;
  status: 'ready' | 'partial' | 'needs_permission' | 'unavailable' | 'error';
  message: string;
  scope: string;
  coverage: {
    kind: 'complete_returned_response' | 'partial' | 'unknown' | 'unavailable';
    page: number; pages: number | null; nextPage: number | null; previousPage: number | null;
    pageLimitReached: boolean; rows: number;
  };
  freshness: { state: 'fresh' | 'stale' | 'unknown'; retrievedAt: string | null; cacheExpires: string | null; lastModified: string | null };
  summary: { records: number; types: number; originalRecords: number; copyRecords: number; originalStackRecords: number; unknownTypeRecords: number } | null;
  kindCounts: { kind: BlueprintKind; count: number }[];
  materialEfficiencyCounts: { level: number; count: number }[];
  timeEfficiencyCounts: { level: number; count: number }[];
  typeCounts: { typeId: number; name: string; records: number }[];
  blueprints: BlueprintAnalyticsRow[];
  limitations: string[];
};
