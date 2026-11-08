// Browser projection: custom clone names and raw jump-clone identities are omitted.
export type CloneAnalyticsRequest = { characterId: number };
export type CloneAnalyticsStatus = 'ready' | 'partial' | 'needs_permission' | 'unavailable' | 'error';
export type CloneAnalyticsSection<T> = {
  status: CloneAnalyticsStatus;
  scope: string;
  message: string;
  retrievedAt: string | null;
  cacheExpires: string | null;
  freshness: 'fresh' | 'stale' | 'unknown';
  data: T | null;
};
export type CloneImplant = { typeId: number; name: string; mapped: boolean };
export type ActiveImplantsData = {
  implantCount: number;
  /** Unmapped reported occurrences, not distinct types. Repeated types are retained. */
  unmappedImplants: number;
  implants: CloneImplant[];
};
export type JumpClonesData = {
  homeLocation: { locationId: number | null; locationType: 'station' | 'structure' | null } | null;
  lastCloneJumpAt: string | null;
  lastHomeStationChangeAt: string | null;
  cloneCount: number;
  totalStoredImplants: number;
  /** Unmapped reported occurrences across stored clones, not distinct types. */
  unmappedImplants: number;
  clones: {
    /** Response-local row number, never a persistent jump-clone identity. */
    row: number;
    locationId: number;
    locationType: 'station' | 'structure';
    implants: CloneImplant[];
  }[];
};
export type CloneAnalytics = {
  characterId: number;
  generatedAt: string;
  status: CloneAnalyticsStatus;
  message: string;
  clones: CloneAnalyticsSection<JumpClonesData>;
  implants: CloneAnalyticsSection<ActiveImplantsData>;
};
