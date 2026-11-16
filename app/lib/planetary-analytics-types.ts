export type PlanetaryAnalyticsArgs = { characterId: number; planetId: number };
export type PlanetaryType = 'temperate' | 'barren' | 'oceanic' | 'ice' | 'gas' | 'lava' | 'storm' | 'plasma';
export type PlanetarySource = {
  status: 'not_requested' | 'ready' | 'unavailable' | 'error';
  message: string;
  rows: number | null;
  freshness: { state: 'fresh' | 'stale' | 'unknown'; retrievedAt: string | null; cacheExpires: string | null; lastModified: string | null };
};
export type PlanetaryExtractor = {
  /** Ephemeral row reference within this response, not a private pin ID. */
  reference: number;
  typeId: number;
  typeName: string;
  productTypeId: number | null;
  productName: string | null;
  headCount: number;
  cycleTimeSeconds: number | null;
  quantityPerCycle: number | null;
  installedAt: string | null;
  lastCycleStartedAt: string | null;
  expiresAt: string | null;
};
export type PlanetarySchedule = {
  asOf: string;
  horizonDays: 30;
  pastExpiryPins: number;
  next24hPins: number;
  days2To7Pins: number;
  days8To30Pins: number;
  laterPins: number;
  missingExpiryPins: number;
  /** Future reported expiries in (asOf, asOf + 30 days], grouped by UTC day. */
  daily: { date: string; extractorPins: number }[];
};
export type PlanetaryAnalytics = {
  characterId: number;
  planetId: number;
  generatedAt: string;
  status: 'ready' | 'partial' | 'needs_permission' | 'unavailable' | 'error';
  message: string;
  scope: 'esi-planets.manage_planets.v1';
  /** Cache freshness does not establish that the simulation was recalculated. */
  simulationEvidence: 'recalculated_when_viewed_in_eve_client';
  colony: { solarSystemId: number; planetType: PlanetaryType; upgradeLevel: number; reportedPins: number; lastUpdateAt: string } | null;
  sources: { colonies: PlanetarySource; layout: PlanetarySource };
  summary: {
    pins: number;
    extractorPins: number;
    pinsWithoutExtractorDetails: number;
    missingExpiryPins: number;
    missingProductPins: number;
    /** Comparison of independent responses, not proof of an atomic snapshot. */
    pinCountMatchesListing: boolean;
  } | null;
  schedule: PlanetarySchedule | null;
  extractors: PlanetaryExtractor[];
  limitations: string[];
};
