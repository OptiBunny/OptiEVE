import type { BlueprintAnalytics } from './blueprint-analytics-types';
import type { BlueprintCollection, BlueprintCollectionProgress, BlueprintCollectionStopReason } from './blueprint-collection-types';

export type BlueprintReconciliationArgs = { characterId: number };
export type AssetBlueprintCopyStatus = 'copy' | 'not_copy' | 'unknown';
export type AssetBlueprintRow = {
  /** Position among this response's asset-only rows, never an item identifier. */
  row: number; typeId: number; name: string; catalogMapped: true;
  copyStatus: AssetBlueprintCopyStatus; quantity: number; isSingleton: boolean;
};
export type BlueprintReconciliationProgress = {
  phase: 'blueprints' | 'assets';
  blueprints: BlueprintCollectionProgress;
  assets: BlueprintCollectionProgress;
};
export type BlueprintAssetStage = {
  status: BlueprintAnalytics['status']; message: string; scope: 'esi-assets.read_corporation_assets.v1';
  coverage: BlueprintCollectionProgress & {
    kind: 'all_reported_pages' | 'partial' | 'unknown' | 'unavailable';
    completedPages: number[];
    consistency: 'consistent' | 'unknown' | 'inconsistent';
    stopReason: BlueprintCollectionStopReason | 'result_limit' | 'not_started';
    failedPage: number | null; resultLimit: 50000;
  };
  freshness: BlueprintAnalytics['freshness'];
};
export type BlueprintReconciliation = {
  characterId: number; entity: 'corporation'; corporationId: number | null; generatedAt: string;
  status: BlueprintAnalytics['status']; message: string;
  blueprints: BlueprintCollection; assets: BlueprintAssetStage;
  assetsOnly: AssetBlueprintRow[];
  /** Matches refer only to a response-local row in blueprints.blueprints. */
  relationships: { row: number; status: 'matched' | 'conflict' }[];
  summary: {
    blueprintRecords: number; assetBlueprintRecords: number; matchedRecords: number;
    conflictingRecords: number; blueprintOnlyRecords: number; assetOnlyRecords: number;
    unclassifiedAssetRecords: number; nonBlueprintAssetRecords: number; unionRecords: number;
  };
  /** Union counts use the blueprint endpoint's type for conflicting matches. */
  typeCounts: { typeId: number; name: string; blueprintRecords: number; assetOnlyRecords: number; records: number }[];
  /** Copy flags of asset-only blueprint records, not blueprint endpoint kinds. */
  kindCounts: { copyStatus: AssetBlueprintCopyStatus; count: number }[];
  limitations: string[];
};
