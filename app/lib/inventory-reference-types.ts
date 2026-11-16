import type { InventoryAnalytics, InventoryAnalyticsArgs } from './inventory-analytics-types';

export type InventoryReferenceArgs = InventoryAnalyticsArgs;
export type InventoryReferenceState = 'priced' | 'missing_price' | 'excluded_blueprint' | 'excluded_unknown_type' | 'price_unavailable';
export type InventoryReferenceAnalytics = {
  generatedAt: string;
  status: InventoryAnalytics['status'];
  message: string;
  basis: 'esi_average_price';
  /** Existing one-page inventory response; location IDs never go to the public price request. */
  inventory: InventoryAnalytics;
  prices: {
    status: 'available' | 'not_requested' | 'unavailable' | 'error';
    message: string;
    sourceUrl: 'https://esi.evetech.net/markets/prices';
    returnedTypes: number | null;
    freshness: InventoryAnalytics['freshness'];
  };
  summary: {
    /** Sum of priced types only; null when nonempty inventory has no priced types. */
    referenceSubtotalISK: string | null;
    pricedTypes: number;
    pricedRecords: number;
    zeroAveragePriceTypes: number;
    singletonBearingPricedTypes: number;
  } | null;
  /** Fixed order: priced, missing_price, excluded_blueprint, excluded_unknown_type, price_unavailable. */
  coverage: Array<{ state: InventoryReferenceState; types: number; records: number }>;
  /** One entry for every returned inventory type, sorted by numeric type ID. */
  types: Array<{ typeId: number; state: InventoryReferenceState; averagePriceISK: string | null; referenceISK: string | null }>;
  /** Every returned category, sorted by numeric category ID with unknown last. */
  categories: Array<{ categoryId: number | null; name: string; types: number; records: number; pricedTypes: number; pricedRecords: number; referenceSubtotalISK: string | null }>;
  precisionPolicy: string;
  limitations: string[];
};
