import type { ManufacturingPlan } from './manufacturing-estimate';

export type ManufacturingEntity = 'character' | 'corporation';
export type ManufacturingContext = {
  characterId: number; resourceEntity: ManufacturingEntity; walletDivision?: number; hangarDivisions?: number[];
  marketRegionId: number; marketStationId: number; manufacturingSystemId: number; manufacturingStructureId?: number;
  useOwnedMaterials: boolean; stockLocationIds?: number[]; otherOwnedOrdersReviewed: boolean; additionalOwnedOrderIds?: number[];
  maxPrivatePages?: number; maxMarketPages?: number;
};
export type ManufacturingJob = { key: string; blueprintTypeId: number; blueprintSource: 'owned' | 'prospective'; blueprintItemId?: number; blueprintPage?: number; plan: ManufacturingPlan };
export type ManufacturingAssessmentInput = ManufacturingContext & Omit<ManufacturingJob, 'key'>;
export type ManufacturingBatchInput = { context: ManufacturingContext; jobs: ManufacturingJob[] };
export type ManufacturingRequest =
  | { operation: 'search'; query: string; limit?: number; offset?: number }
  | { operation: 'blueprints'; characterId: number; resourceEntity: ManufacturingEntity; page: number }
  | { operation: 'catalog' }
  | { operation: 'assess'; input: ManufacturingAssessmentInput }
  | { operation: 'compare' | 'plan'; input: ManufacturingBatchInput };
export type ManufacturingReadiness = 'conditional' | 'unconfirmed' | 'blocked';
export type ManufacturingMaterial = { typeId: number; name: string; requiredQuantity: number; ownedQuantity: number | null; usedQuantity: number | null; missingQuantity: number | null; buyISK: string | null };
export type ManufacturingCard = {
  key: string; blueprintTypeId: number; name: string; productName: string; runs: number; outputQuantity: number;
  readiness: ManufacturingReadiness; availableWalletISK: string | null; cashRequiredISK: string | null;
  economicCostISK: string | null; profitISK: string | null; listedProfitISK: string | null; affordable: boolean | null;
  recipeCurrent: boolean; stockCoverage: string; ownOrdersComplete: boolean;
  materials: ManufacturingMaterial[]; reasons: string[];
  freshness: { label: string; status: 'fresh' | 'stale' | 'unknown'; cacheExpires: string | null }[];
};
export type ManufacturingSearchResponse = { operation: 'search'; generatedAt: string; query: string; items: { typeId: number; name: string; blueprintTypeIds: number[] }[]; nextOffset: number | null; totalMatches: number };
export type ManufacturingBlueprintResponse = { operation: 'blueprints'; generatedAt: string; characterId: number; resourceEntity: ManufacturingEntity; page: number; pages: number | null; coverage: 'complete' | 'partial' | 'unknown'; cacheExpires: string | null; items: { itemId: number; typeId: number; name: string; kind: 'original' | 'copy' | 'unknown'; materialEfficiency: number | null; remainingRuns: number | null }[] };
export type ManufacturingCatalogResponse = { operation: 'catalog'; generatedAt: string; status: 'current' | 'update_required' | 'unverified'; pinnedBuild: number; latestBuild: number | null; message: string };
export type ManufacturingAssessmentResponse = { operation: 'assess'; generatedAt: string; context: ManufacturingContext; assessment: ManufacturingCard };
export type ManufacturingComparisonResponse = { operation: 'compare'; generatedAt: string; context: ManufacturingContext; candidates: ManufacturingCard[]; rankedKeys: string[]; conditions: string[] };
export type ManufacturingProductionResponse = {
  operation: 'plan'; generatedAt: string; context: ManufacturingContext; jobs: ManufacturingCard[];
  shoppingList: { typeId: number; name: string; requiredQuantity: number; ownedAllocatedQuantity: number | null; missingQuantity: number | null; purchaseISK: string | null; coverage: string }[];
  outputs: { typeId: number; name: string; quantity: number; grossRevenueISK: string | null; coverage: string }[];
  totals: { walletISK: string | null; materialCashISK: string | null; jobAndOverheadCashISK: string | null; cashRequiredISK: string | null; affordable: boolean | null; netRevenueISK: string | null; economicProfitISK: string | null };
  readiness: ManufacturingReadiness; conditions: string[];
};
export type ManufacturingResponse = ManufacturingSearchResponse | ManufacturingBlueprintResponse | ManufacturingCatalogResponse | ManufacturingAssessmentResponse | ManufacturingComparisonResponse | ManufacturingProductionResponse;
export type DemoScenario = 'complete' | 'missing' | 'scarce';
