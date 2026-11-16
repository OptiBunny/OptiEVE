// Browser-safe personal freelance evidence. No raw provider data or credentials.
export type PersonalFreelanceArgs = { characterId: number; jobId?: string };
export type FreelanceJobState = 'Unspecified' | 'Active' | 'Closed' | 'Completed' | 'Expired' | 'Deleted';
export type FreelanceParticipationState = 'Unspecified' | 'Committed' | 'Kicked' | 'Resigned';
export type FreelanceFreshness = {
  state: 'fresh' | 'stale' | 'unknown'; retrievedAt: string | null;
  cacheExpires: string | null; lastModified: string | null;
};
export type PersonalFreelanceJob = {
  jobId: string;
  name: string | null; nameState: 'reported' | 'redacted'; nameTruncated: boolean;
  state: FreelanceJobState; updatedAt: string;
  progress: { current: number; desired: number };
  // Exact received-number decimal strings, at least two fractional digits, no rounding.
  // Null is an omitted reward object; present zero amounts remain "0.00".
  rewardReserve: { initialISK: string; remainingISK: string } | null;
};
export type PersonalFreelance = {
  characterId: number; selectedJobId: string | null; generatedAt: string;
  status: 'ready' | 'partial' | 'needs_permission' | 'unavailable' | 'error';
  scope: 'esi-characters.read_freelance_jobs.v1'; message: string;
  coverage: { kind: 'returned_list' | 'unavailable'; jobs: number | null; rowLimit: 1000 };
  listFreshness: FreelanceFreshness;
  summary: { jobs: number; withRewardReserve: number; withoutRewardReserve: number; redactedNames: number; truncatedNames: number } | null;
  stateCounts: Array<{ state: FreelanceJobState; jobs: number }>;
  jobs: PersonalFreelanceJob[];
  participation: {
    status: 'not_requested' | 'not_listed' | 'ready' | 'unavailable' | 'error';
    message: string; freshness: FreelanceFreshness;
    data: { state: FreelanceParticipationState; contributed: number; updatedAt: string } | null;
  };
  limitations: string[];
};

