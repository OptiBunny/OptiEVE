export type HistoricalOrdersArgs = { characterId: number; page?: number };
export type HistoricalOrderState = 'cancelled' | 'expired' | 'other';
export type HistoricalOrder = {
  row: number;
  typeId: number;
  side: 'buy' | 'sell';
  state: HistoricalOrderState;
  issuedAt: string;
  unitPriceISK: string;
  originalQuantity: number;
  remainingQuantity: number;
};
export type HistoricalOrderType = { typeId: number; name: string; mapped: boolean };
export type HistoricalOrders = {
  characterId: number;
  generatedAt: string;
  status: 'ready' | 'partial' | 'needs_permission' | 'unavailable' | 'error';
  message: string;
  scope: string;
  coverage: {
    kind: 'returned_page' | 'unavailable';
    page: number; pages: number | null; previousPage: number | null; nextPage: number | null;
    pageLimitReached: boolean;
    returnedRows: number | null; includedRows: number | null; excludedCorporationRows: number | null;
  };
  freshness: { state: 'fresh' | 'stale' | 'unknown'; retrievedAt: string | null; cacheExpires: string | null; lastModified: string | null };
  summary: {
    orders: number; types: number; buy: number; sell: number; cancelled: number; expired: number;
    other: number; unmappedTypes: number; earliestIssuedAt: string | null; latestIssuedAt: string | null;
  } | null;
  orders: HistoricalOrder[];
  types: HistoricalOrderType[];
  limitations: string[];
};
