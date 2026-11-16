export type IndustryAnalyticsArgs = {
  characterId: number;
  entity: 'character' | 'corporation';
  includeCompleted?: boolean;
  /** Corporation jobs only; personal jobs are not paginated. */
  page?: number;
};
export type IndustryJobStatus = 'active' | 'cancelled' | 'delivered' | 'paused' | 'ready' | 'reverted';
export type IndustryJob = {
  jobId: number;
  activityId: number;
  activityLabel: string;
  status: IndustryJobStatus;
  blueprintTypeId: number;
  blueprintName: string;
  productTypeId: number | null;
  productName: string | null;
  runs: number;
  startAt: string;
  endAt: string;
  durationSeconds: number;
  pauseAt: string | null;
  completedAt: string | null;
};
/** Partition of reported-active jobs at one load timestamp, never inferred status. */
export type IndustrySchedule = {
  asOf: string;
  horizonDays: 30;
  activePastEndJobs: number;
  activeNext24hJobs: number;
  activeDays2To7Jobs: number;
  activeDays8To30Jobs: number;
  activeLaterJobs: number;
  /** Future reported ends within thirty rolling days, grouped by UTC date. */
  daily: { date: string; activeJobs: number }[];
};
export type IndustryAnalytics = {
  characterId: number;
  entity: 'character' | 'corporation';
  corporationId: number | null;
  includeCompleted: boolean;
  generatedAt: string;
  status: 'ready' | 'partial' | 'needs_permission' | 'unavailable' | 'error';
  message: string;
  scope: string;
  coverage: {
    kind: 'complete_returned_response' | 'partial' | 'unknown' | 'unavailable';
    page: number | null;
    pages: number | null;
    nextPage: number | null;
    previousPage: number | null;
    pageLimitReached: boolean;
    rows: number;
  };
  freshness: {
    state: 'fresh' | 'stale' | 'unknown';
    retrievedAt: string | null;
    cacheExpires: string | null;
    lastModified: string | null;
  };
  summary: {
    jobs: number;
    active: number;
    ready: number;
    paused: number;
    activePastEnd: number;
    activeDueWithin24h: number;
    unknownBlueprintNames: number;
    unknownProductNames: number;
  } | null;
  schedule: IndustrySchedule | null;
  statusCounts: { status: IndustryJobStatus; count: number }[];
  activityCounts: { activityId: number; label: string; count: number }[];
  jobs: IndustryJob[];
  limitations: string[];
};
