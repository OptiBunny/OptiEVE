export type OrderAnalyticsArgs = { characterId: number; entity: 'character' | 'corporation'; page?: number };
export type OrderSide = 'buy' | 'sell' | 'unknown';
export type AnalyticsOrder = {
  orderId: number; typeId: number; name: string; mapped: boolean; side: OrderSide;
  unitPrice: string; remainingQuantity: number; originalQuantity: number; minimumVolume: number | null;
  issuedAt: string; durationDays: number; expiresAt: string;
};
export type OrderAnalytics = {
  characterId: number; entity: 'character' | 'corporation'; corporationId: number | null;
  generatedAt: string; status: 'ready' | 'partial' | 'needs_permission' | 'unavailable' | 'error'; message: string; scope: string;
  coverage: { kind: 'complete_returned_response' | 'partial' | 'unknown' | 'unavailable'; page: number | null; pages: number | null; nextPage: number | null; previousPage: number | null; pageLimitReached: boolean; rows: number };
  freshness: { state: 'fresh' | 'stale' | 'unknown'; retrievedAt: string | null; cacheExpires: string | null; lastModified: string | null };
  summary: { orders: number; types: number; buy: number; sell: number; unknownSide: number; excludedCorporationOrders: number; pastReportedExpiry: number; dueWithin24h: number; unmappedTypes: number } | null;
  orders: AnalyticsOrder[]; limitations: string[];
};
