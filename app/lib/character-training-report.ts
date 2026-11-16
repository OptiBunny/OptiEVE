import { readCharacterAnalytics } from './character-analytics';
import type { CharacterAnalytics, CharacterAnalyticsSection, CharacterAttributesAnalytics, CharacterQueueAnalytics, CharacterQueueEntry, CharacterSkillGroup, CharacterSkillsAnalytics, CharacterTrainingSchedule } from './character-analytics-types';

type SkillBriefing = Omit<CharacterSkillsAnalytics, 'skills' | 'groups'> & {
  groupCount: number;
  topGroups: CharacterSkillGroup[];
  omittedGroups: number;
};
type UpcomingEntry = Pick<CharacterQueueEntry, 'position' | 'typeId' | 'name' | 'finishedLevel' | 'startAt'> & { finishAt: string };
type QueueBriefing = Omit<CharacterQueueAnalytics, 'entries'> & {
  upcoming: UpcomingEntry[];
  omittedFutureEntries: number;
};
export type CharacterTrainingReport = Pick<CharacterAnalytics, 'characterId' | 'generatedAt' | 'status' | 'message'> & {
  skills: CharacterAnalyticsSection<SkillBriefing>;
  queue: CharacterAnalyticsSection<QueueBriefing>;
  attributes: CharacterAnalyticsSection<CharacterAttributesAnalytics>;
  limits: { topSkillGroups: 10; upcomingQueueEntries: 20 };
  limitations: string[];
};

function section<Source, Target>(source: CharacterAnalyticsSection<Source>, data: Target | null): CharacterAnalyticsSection<Target> {
  return { status: source.status, scope: source.scope, message: source.message, retrievedAt: source.retrievedAt, cacheExpires: source.cacheExpires, freshness: source.freshness, data };
}
function schedule(value: CharacterTrainingSchedule): CharacterTrainingSchedule {
  return {
    asOf: value.asOf, elapsedEntries: value.elapsedEntries, next24hEntries: value.next24hEntries,
    days2To7Entries: value.days2To7Entries, days8To30Entries: value.days8To30Entries,
    laterEntries: value.laterEntries, missingFinishEntries: value.missingFinishEntries,
    daily: value.daily.map(row => ({ date: row.date, entries: row.entries })),
  };
}

/** Compact whitelist projection of the validated dashboard response; no additional reads. */
export function projectCharacterTrainingReport(value: CharacterAnalytics): CharacterTrainingReport {
  const skills = value.skills.data, queue = value.queue.data, attributes = value.attributes.data;
  const groups = skills ? [...skills.groups].sort((left, right) => right.skillpoints - left.skillpoints || (left.groupId ?? Number.MAX_SAFE_INTEGER) - (right.groupId ?? Number.MAX_SAFE_INTEGER)) : [];
  const future = queue ? queue.entries.filter((entry): entry is CharacterQueueEntry & { finishAt: string } => entry.finishAt !== null && Date.parse(entry.finishAt) > Date.parse(value.generatedAt))
    .sort((left, right) => Date.parse(left.finishAt) - Date.parse(right.finishAt) || left.position - right.position) : [];
  return {
    characterId: value.characterId, generatedAt: value.generatedAt, status: value.status, message: value.message,
    skills: section(value.skills, skills === null ? null : {
      totalSp: skills.totalSp, unallocatedSp: skills.unallocatedSp, reportedSkillSp: skills.reportedSkillSp,
      skillCount: skills.skillCount, trainedSkillCount: skills.trainedSkillCount, activeSkillCount: skills.activeSkillCount,
      reducedActiveSkillCount: skills.reducedActiveSkillCount, boostedActiveSkillCount: skills.boostedActiveSkillCount,
      levelDistribution: skills.levelDistribution.map(row => ({ level: row.level, trainedCount: row.trainedCount, activeCount: row.activeCount })),
      groupCount: groups.length,
      topGroups: groups.slice(0, 10).map(row => ({ groupId: row.groupId, name: row.name, skillCount: row.skillCount, skillpoints: row.skillpoints })),
      omittedGroups: Math.max(0, groups.length - 10),
    }),
    queue: section(value.queue, queue === null ? null : {
      entryCount: queue.entryCount, timedEntryCount: queue.timedEntryCount, passedFinishEntryCount: queue.passedFinishEntryCount,
      nextPlannedFinishAt: queue.nextPlannedFinishAt, lastPlannedFinishAt: queue.lastPlannedFinishAt,
      schedule: schedule(queue.schedule),
      upcoming: future.slice(0, 20).map(row => ({ position: row.position, typeId: row.typeId, name: row.name, finishedLevel: row.finishedLevel, startAt: row.startAt, finishAt: row.finishAt })),
      omittedFutureEntries: Math.max(0, future.length - 20),
    }),
    attributes: section(value.attributes, attributes === null ? null : {
      charisma: attributes.charisma, intelligence: attributes.intelligence, memory: attributes.memory, perception: attributes.perception, willpower: attributes.willpower,
      bonusRemaps: attributes.bonusRemaps, lastRemapAt: attributes.lastRemapAt, accruedRemapCooldownAt: attributes.accruedRemapCooldownAt,
    }),
    limits: { topSkillGroups: 10, upcomingQueueEntries: 20 },
    limitations: [
      'One owned character and at most three existing granted reads. Sections have independent cache times and are not an atomic snapshot or a training history. Missing or denied data stays unavailable.',
      'Group ranking covers reported per-skill SP, which need not equal separately reported total SP. At most ten groups are shown; omittedGroups counts the remainder. No individual skill list is returned.',
      'Schedule buckets partition the returned queue at generatedAt. Daily counts include only future finishes within 30 rolling days, grouped by UTC date; missing dates are not filled with zero.',
      'Upcoming entries are the first twenty future reported finishes, ordered by finish instant then queue position. omittedFutureEntries includes all later future entries, including those beyond 30 days. An entry without a start may still have a reported finish.',
      'Dates are plans, not evidence of active training, completed levels, current SP or training rate. No account status, implant effects or remap availability is inferred. No history is saved and no skills or queue settings are changed.',
    ],
  };
}

export async function readCharacterTrainingReport(user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<CharacterTrainingReport> {
  const result = await readCharacterAnalytics(user, input, options);
  options.signal?.throwIfAborted();
  return projectCharacterTrainingReport(result);
}
