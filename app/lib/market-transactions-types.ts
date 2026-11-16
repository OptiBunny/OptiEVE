// Normalized transaction DTO. No individual transaction or participant rows.
export type MarketTransactionsArgs = {
  characterId: number;
  entity: 'character' | 'corporation';
  /** Required for corporation; forbidden for character. */
  division?: number;
  /** Omitted for latest batch; a positive safe integer for an older batch. */
  fromId?: number;
};
export type MarketTransactionCell = {
  /** Canonical UTC YYYY-MM-DD; one unique date/type/side cell. */
  date: string;
  typeId: number;
  side: 'buy' | 'sell';
  entries: number;
  /** Canonical nonnegative integer; exact sum only for this item. */
  quantity: string;
  /** Canonical nonnegative exact decimal, minimum two fractional places. */
  grossISK: string;
};
export type MarketTransactionType = { typeId: number; name: string; mapped: boolean };
export type MarketTransactionsAnalytics = {
  characterId: number;
  entity: 'character' | 'corporation';
  corporationId: number | null;
  division: number | null;
  generatedAt: string;
  status: 'ready' | 'partial' | 'needs_permission' | 'unavailable' | 'error';
  message: string;
  scope: string;
  coverage: {
    kind: 'complete_returned_window' | 'partial' | 'unavailable';
    fromId: number | null;
    nextFromId: number | null;
    returnedEntries: number;
    includedEntries: number;
    excludedCorporationEntries: number;
    /** Count of raw rows equal to the supplied cursor, before personal filtering. */
    boundaryEntries: 0 | 1;
    /** Cursor-boundary row count actually included in the analytic cells. */
    includedBoundaryEntries: 0 | 1;
    /** Date range of included analytic cells only; excluded records never contribute. */
    firstIncludedDate: string | null;
    lastIncludedDate: string | null;
  };
  freshness: { state: 'fresh' | 'stale' | 'unknown'; retrievedAt: string | null; cacheExpires: string | null; lastModified: string | null };
  summary: {
    entries: number;
    buyEntries: number;
    sellEntries: number;
    types: number;
    unmappedTypes: number;
    grossPurchasesISK: string;
    grossSalesISK: string;
  } | null;
  cells: MarketTransactionCell[];
  types: MarketTransactionType[];
  precisionPolicy: string;
  limitations: string[];
};
