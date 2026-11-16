export type CharacterAnalyticsRequest = { characterId: number };
export type CharacterAnalyticsStatus = 'ready' | 'partial' | 'needs_permission' | 'unavailable' | 'error';
export type CharacterAnalyticsSection<T> = {
  status: CharacterAnalyticsStatus;
  scope: string;
  message: string;
  retrievedAt: string | null;
  cacheExpires: string | null;
  freshness: 'fresh' | 'stale' | 'unknown';
  data: T | null;
};
export type CharacterSkill = {
  typeId: number;
  name: string;
  groupId: number | null;
  groupName: string;
  trainedLevel: number;
  activeLevel: number;
  skillpoints: number;
};
export type CharacterSkillGroup = {
  groupId: number | null;
  name: string;
  skillCount: number;
  skillpoints: number;
};
export type CharacterSkillsAnalytics = {
  totalSp: number;
  unallocatedSp: number | null;
  reportedSkillSp: number;
  skillCount: number;
  trainedSkillCount: number;
  activeSkillCount: number;
  reducedActiveSkillCount: number;
  boostedActiveSkillCount: number;
  levelDistribution: { level: number; trainedCount: number; activeCount: number }[];
  groups: CharacterSkillGroup[];
  skills: CharacterSkill[];
};
export type CharacterQueueEntry = {
  position: number;
  typeId: number;
  name: string;
  finishedLevel: number;
  startAt: string | null;
  finishAt: string | null;
  levelStartSp: number | null;
  levelEndSp: number | null;
  trainingStartSp: number | null;
};
export type CharacterTrainingSchedule = {
  /** The shared request-completion clock; these are reported dates, not completions. */
  asOf: string;
  elapsedEntries: number;
  next24hEntries: number;
  days2To7Entries: number;
  days8To30Entries: number;
  laterEntries: number;
  missingFinishEntries: number;
  /** Future finishes within 30 rolling days, grouped by UTC date. Gaps stay omitted. */
  daily: { date: string; entries: number }[];
};
export type CharacterQueueAnalytics = {
  entryCount: number;
  timedEntryCount: number;
  passedFinishEntryCount: number;
  nextPlannedFinishAt: string | null;
  lastPlannedFinishAt: string | null;
  schedule: CharacterTrainingSchedule;
  entries: CharacterQueueEntry[];
};
export type CharacterAttributesAnalytics = {
  charisma: number;
  intelligence: number;
  memory: number;
  perception: number;
  willpower: number;
  bonusRemaps: number | null;
  lastRemapAt: string | null;
  accruedRemapCooldownAt: string | null;
};
export type CharacterAnalytics = {
  characterId: number;
  generatedAt: string;
  status: CharacterAnalyticsStatus;
  message: string;
  skills: CharacterAnalyticsSection<CharacterSkillsAnalytics>;
  queue: CharacterAnalyticsSection<CharacterQueueAnalytics>;
  attributes: CharacterAnalyticsSection<CharacterAttributesAnalytics>;
};
