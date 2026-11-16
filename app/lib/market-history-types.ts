export type MarketHistoryArgs = { regionId: number; typeId: number; days?: number };
export type MarketHistoryRow = { date: string; volume: number; orderCount: number; lowestISK: string; highestISK: string; averageISK: string };
/** One public region/type response; missing dates are not zero observations. */
export type MarketHistoryResponse = {
  regionId: number; typeId: number; generatedAt: string;
  window: { days: number; startUTC: string; endExclusiveUTC: string; reportedDays: number; missingDays: number };
  rows: MarketHistoryRow[];
  totalReportedVolume: string; totalReportedOrderCount: string; averageVolumePerReportedDay: string | null;
  sourceFreshness: 'fresh' | 'stale' | 'unknown';
  sources: { url: string; retrievedAt: string; cacheExpires: string | null; lastModified: string | null; cacheControl: string | null }[];
  limitations: string[];
};