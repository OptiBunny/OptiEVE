import { EveError, listConnections, readCharacterData } from './eve';
import { findPublishedManufacturingItem } from './manufacturing-catalog';
import { OverviewDataError, overviewDate } from './overview-summary';
import type { CharacterAnalytics, CharacterAnalyticsRequest, CharacterAnalyticsSection, CharacterAnalyticsStatus, CharacterAttributesAnalytics, CharacterQueueAnalytics, CharacterSkillGroup, CharacterSkillsAnalytics } from './character-analytics-types';

const skillsScope = 'esi-skills.read_skills.v1';
const queueScope = 'esi-skills.read_skillqueue.v1';
const specs = [
  { key: 'skills', dataset: 'skills', scope: skillsScope },
  { key: 'queue', dataset: 'skill_queue', scope: queueScope },
  { key: 'attributes', dataset: 'attributes', scope: skillsScope },
] as const;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const invalid = (): never => { throw new OverviewDataError(); };
const optionalNumber = (value: unknown): number | null => value === null || value === undefined ? null : integer(value) ? value : invalid();
const optionalDate = (value: unknown): string | null => value === null || value === undefined ? null : overviewDate(value) ?? invalid();
type Dependencies = {
  connections: (user: string) => Promise<{ characterId: number; scopes: string[] }[]>;
  character: (user: string, args: { characterId: number; dataset: string }, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
};
function args(value: unknown): CharacterAnalyticsRequest {
  if (!record(value) || !Object.hasOwn(value, 'characterId') || !integer(value.characterId, 1) || Object.keys(value).some(key => key !== 'characterId')) {
    throw new EveError('Choose one connected character to load skills and training.');
  }
  return { characterId: value.characterId };
}
function blank<T>(scope: string, status: CharacterAnalyticsStatus, message: string): CharacterAnalyticsSection<T> {
  return { status, scope, message, retrievedAt: null, cacheExpires: null, freshness: 'unknown', data: null };
}
function headerTime(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 100) return null;
  const iso = overviewDate(value);
  if (iso !== null) return Date.parse(iso);
  const time = Date.parse(value);
  // Date.parse alone normalizes impossible dates and accepts ambiguous input.
  return Number.isFinite(time) && new Date(time).toUTCString() === value ? time : null;
}
function cacheExpiry(response: Record<string, unknown>, received: number): string | null {
  const expires = headerTime(response.cacheExpires), date = headerTime(response.responseDate);
  const control = typeof response.cacheControl === 'string' && response.cacheControl.length <= 512 ? response.cacheControl : '';
  if (/(?:^|,)\s*(?:no-cache|no-store)(?=\s*(?:,|$))/i.test(control)) return new Date(received).toISOString();
  const age = response.cacheAge == null ? 0 : typeof response.cacheAge === 'string' && /^\d{1,10}$/.test(response.cacheAge) ? Number(response.cacheAge) : NaN;
  // Malformed age metadata cannot establish a fresh private snapshot.
  if (!integer(age, 0, 604800)) return null;
  const match = /(?:^|,)\s*max-age=(\d+)(?=\s*(?:,|$))/i.exec(control), maxAge = match ? Number(match[1]) : null;
  const cached = integer(maxAge, 0, 604800) && date !== null && date <= received + 60000
    ? Math.min(date + maxAge * 1000, received + (maxAge - age) * 1000) : null;
  // Expires can establish an absolute lifetime when max-age is absent. If
  // both are available, the earlier boundary wins; an aged cache is never new.
  const until = expires === null ? cached : cached === null ? expires : Math.min(expires, cached);
  return until === null ? null : new Date(until).toISOString();
}
async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); });
  // A reader may synchronously abort and throw before the race is attached.
  void interrupted.catch(() => {});
  try { const value = await Promise.race([work(), interrupted]); signal.throwIfAborted(); return value; }
  finally { signal.removeEventListener('abort', cancel); }
}
function skillLabel(typeId: number) {
  const item = findPublishedManufacturingItem(typeId);
  // Only public skill-category labels from the bundled SDE may enter this DTO.
  // An unknown/new type remains separate from known skill groups.
  return item?.categoryId === 16
    ? { name: item.name, groupId: item.groupId, groupName: item.groupName }
    : { name: `Type ${typeId}`, groupId: null, groupName: 'Unknown skill group' };
}
function total(left: number, right: number): number {
  const value = left + right;
  return integer(value) ? value : invalid();
}
function skills(data: unknown): CharacterSkillsAnalytics {
  if (!record(data) || !integer(data.total_sp) || !Array.isArray(data.skills) || data.skills.length > 2000) return invalid();
  const seen = new Set<number>();
  const rows = data.skills.map(row => {
    if (!record(row) || !integer(row.skill_id, 1) || seen.has(row.skill_id) || !integer(row.trained_skill_level, 0, 5) || !integer(row.active_skill_level, 0, 5) || !integer(row.skillpoints_in_skill)) return invalid();
    seen.add(row.skill_id);
    // Expert systems can make an active level higher than the trained level.
    return { typeId: row.skill_id, ...skillLabel(row.skill_id), trainedLevel: row.trained_skill_level, activeLevel: row.active_skill_level, skillpoints: row.skillpoints_in_skill };
  }).sort((a, b) => b.skillpoints - a.skillpoints || a.typeId - b.typeId);
  const groups = new Map<number | null, CharacterSkillGroup>();
  const levels = Array.from({ length: 6 }, (_, level) => ({ level, trainedCount: 0, activeCount: 0 }));
  let reportedSkillSp = 0;
  for (const row of rows) {
    reportedSkillSp = total(reportedSkillSp, row.skillpoints);
    levels[row.trainedLevel].trainedCount++;
    levels[row.activeLevel].activeCount++;
    const group = groups.get(row.groupId) ?? { groupId: row.groupId, name: row.groupName, skillCount: 0, skillpoints: 0 };
    group.skillCount++; group.skillpoints = total(group.skillpoints, row.skillpoints);
    groups.set(row.groupId, group);
  }
  return {
    totalSp: data.total_sp, unallocatedSp: optionalNumber(data.unallocated_sp), reportedSkillSp,
    skillCount: rows.length, trainedSkillCount: rows.filter(row => row.trainedLevel > 0).length,
    activeSkillCount: rows.filter(row => row.activeLevel > 0).length,
    reducedActiveSkillCount: rows.filter(row => row.activeLevel < row.trainedLevel).length,
    boostedActiveSkillCount: rows.filter(row => row.activeLevel > row.trainedLevel).length,
    levelDistribution: levels,
    groups: [...groups.values()].sort((a, b) => b.skillpoints - a.skillpoints || (a.groupId ?? Number.MAX_SAFE_INTEGER) - (b.groupId ?? Number.MAX_SAFE_INTEGER)),
    skills: rows,
  };
}
function queue(data: unknown, now: number): CharacterQueueAnalytics {
  // The API has no maxItems contract. This is a local safety limit, not the
  // game's queue capacity; reject oversized responses rather than omit rows.
  if (!Array.isArray(data) || data.length > 1000) return invalid();
  const positions = new Set<number>(), targets = new Set<string>();
  const entries = data.map(row => {
    if (!record(row) || !integer(row.queue_position) || positions.has(row.queue_position) || !integer(row.skill_id, 1) || !integer(row.finished_level, 1, 5)) return invalid();
    const target = `${row.skill_id}:${row.finished_level}`;
    if (targets.has(target)) return invalid();
    positions.add(row.queue_position); targets.add(target);
    const startAt = optionalDate(row.start_date), finishAt = optionalDate(row.finish_date);
    if (startAt !== null && finishAt !== null && Date.parse(finishAt) < Date.parse(startAt)) return invalid();
    const levelStartSp = optionalNumber(row.level_start_sp), levelEndSp = optionalNumber(row.level_end_sp);
    if (levelStartSp !== null && levelEndSp !== null && levelEndSp < levelStartSp) return invalid();
    return { position: row.queue_position, typeId: row.skill_id, name: skillLabel(row.skill_id).name, finishedLevel: row.finished_level, startAt, finishAt, levelStartSp, levelEndSp, trainingStartSp: optionalNumber(row.training_start_sp) };
  }).sort((a, b) => a.position - b.position);
  const futureFinishes = entries.flatMap(row => row.finishAt !== null && Date.parse(row.finishAt) > now ? [row.finishAt] : []).sort();
  return {
    entryCount: entries.length,
    timedEntryCount: entries.filter(row => row.startAt !== null && row.finishAt !== null).length,
    passedFinishEntryCount: entries.filter(row => row.finishAt !== null && Date.parse(row.finishAt) <= now).length,
    nextPlannedFinishAt: futureFinishes[0] ?? null,
    lastPlannedFinishAt: futureFinishes[futureFinishes.length - 1] ?? null,
    entries,
  };
}
function attributes(data: unknown): CharacterAttributesAnalytics {
  if (!record(data) || !integer(data.charisma) || !integer(data.intelligence) || !integer(data.memory) || !integer(data.perception) || !integer(data.willpower)) return invalid();
  return {
    charisma: data.charisma, intelligence: data.intelligence, memory: data.memory, perception: data.perception, willpower: data.willpower,
    bonusRemaps: optionalNumber(data.bonus_remaps), lastRemapAt: optionalDate(data.last_remap_date), accruedRemapCooldownAt: optionalDate(data.accrued_remap_cooldown_date),
  };
}
const notes = {
  skills: 'Reported skill points and active/trained levels from this response. Skill data may lag until the next character login. Active levels can be lower because of account restrictions or higher because of expert systems; account status is not inferred. Group charts sum the reported per-skill SP and do not reconcile the separately reported total SP. Missing unallocated SP is unknown. Names and groups use the bundled public SDE; new or unpublished types retain their IDs. No active SP, current in-training SP or training rate is calculated.',
  queue: 'One current queue response, ordered by its reported positions. Dates are a reported schedule, not proof that training is active or unpaused; missing dates are unknown, not proof of a paused queue. Past-finish entries may not yet be reflected in the skill snapshot. Future finish dates are planned and may change. No skill points, trained levels, completion percentage or queue edits are inferred from the schedule.',
  attributes: 'Reported attributes and optional remap metadata from this response. Missing remap values are unknown. No training rate, implant effect, account status or remap availability is inferred; these attributes alone do not establish an accurate SP/hour rate.',
};
function refreshFreshness<T>(section: CharacterAnalyticsSection<T>, completedAt: number) {
  if (section.data === null) return;
  section.freshness = section.cacheExpires === null ? 'unknown' : Date.parse(section.cacheExpires) <= completedAt ? 'stale' : 'fresh';
  if (section.freshness !== 'fresh') {
    section.status = 'partial';
    section.message += section.freshness === 'stale'
      ? ' This response has reached its reported cache expiry; load again before relying on it.'
      : ' EVE did not provide a usable cache expiry; freshness is unknown.';
  }
}

// No result is persisted. The caller must require private authentication, an
// explicit same-origin action and private/no-store response headers.
export function createCharacterAnalyticsReader(dependencies: Dependencies) {
  return async function read(user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<CharacterAnalytics> {
    const selected = args(input), now = dependencies.now ?? Date.now;
    if (!user || typeof user !== 'string') throw new EveError('Sign in to this private connector first.', 401);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    signal.throwIfAborted();
    const connection = (await abortable(() => dependencies.connections(user), signal)).find(row => row.characterId === selected.characterId);
    if (!connection) throw new EveError('Choose a character connected to this private connector.', 404);
    signal.throwIfAborted();
    const unavailable = 'Load skills and training explicitly to read this character’s current data.';
    const result: CharacterAnalytics = {
      characterId: selected.characterId, generatedAt: new Date(now()).toISOString(), status: 'unavailable',
      message: 'One selected connected character. Sections are separate ESI snapshots with independent freshness; they are not a synchronized training history. Nothing is saved.',
      skills: blank(skillsScope, 'unavailable', unavailable), queue: blank(queueScope, 'unavailable', unavailable), attributes: blank(skillsScope, 'unavailable', unavailable),
    };
    let blocked = '';
    // Sequential reads avoid token-refresh contention and stop after a rate
    // limit, changed authorization or the shared request deadline.
    for (const spec of specs) {
      if (!connection.scopes.includes(spec.scope)) {
        result[spec.key] = blank(spec.scope, 'needs_permission', 'This character has not granted this existing read permission. No additional access is requested automatically.');
        continue;
      }
      if (signal.aborted || blocked) {
        result[spec.key] = blank(spec.scope, 'unavailable', blocked || 'The request was cancelled or reached its time limit. Load again to retry.');
        continue;
      }
      try {
        const response = await abortable(() => dependencies.character(user, { characterId: selected.characterId, dataset: spec.dataset }, signal), signal);
        signal.throwIfAborted();
        if (!record(response) || response.characterId !== selected.characterId || response.dataset !== spec.dataset || response.entity !== undefined && response.entity !== 'character' || !overviewDate(response.retrievedAt) || !record(response.pagination) || response.pagination.kind !== 'none' || ['nextPage', 'after', 'before'].some(key => response.pagination && (response.pagination as Record<string, unknown>)[key] != null)) return invalid();
        const retrievedAt = overviewDate(response.retrievedAt)!;
        if (Date.parse(retrievedAt) > now() + 60000) return invalid();
        const metadata = { status: 'ready' as const, scope: spec.scope, message: notes[spec.key], retrievedAt, cacheExpires: cacheExpiry(response, Date.parse(retrievedAt)), freshness: 'unknown' as const };
        if (spec.key === 'skills') result.skills = { ...metadata, data: skills(response.data) };
        else if (spec.key === 'queue') result.queue = { ...metadata, data: queue(response.data, now()) };
        else result.attributes = { ...metadata, data: attributes(response.data) };
      } catch (error) {
        let status: CharacterAnalyticsStatus = 'unavailable', message: string;
        if (signal.aborted) blocked = message = 'The request was cancelled or reached its time limit. Load again to retry.';
        else if (error instanceof EveError && [401, 404, 409].includes(error.status)) blocked = message = 'The character connection changed or its authorization expired. Reload connection status and reconnect if needed.';
        else if (error instanceof EveError && error.status === 429) blocked = message = 'EVE is rate limiting requests. Wait before loading again; no automatic retry was made.';
        else if (error instanceof EveError && error.status === 403) message = 'EVE denied this read. Check the character’s granted read permission; no additional access is requested automatically.';
        else {
          status = 'error';
          message = error instanceof OverviewDataError ? 'EVE returned data that could not be displayed safely. Missing data is unknown, not zero.' : 'This EVE read could not be loaded. Missing data is unknown, not zero.';
        }
        result[spec.key] = blank(spec.scope, status, message);
      }
    }
    // Reclassify every source at the same completion time. A later slow read
    // must not leave an earlier expired snapshot marked fresh.
    const completedAt = now();
    result.generatedAt = new Date(completedAt).toISOString();
    refreshFreshness(result.skills, completedAt); refreshFreshness(result.queue, completedAt); refreshFreshness(result.attributes, completedAt);
    if (result.queue.data !== null) {
      // Horizon metrics also share the completion clock, without changing the
      // provider's reported dates or claiming that training is active.
      const entries = result.queue.data.entries;
      const future = entries.flatMap(row => row.finishAt !== null && Date.parse(row.finishAt) > completedAt ? [row.finishAt] : []).sort();
      result.queue.data.passedFinishEntryCount = entries.filter(row => row.finishAt !== null && Date.parse(row.finishAt) <= completedAt).length;
      result.queue.data.nextPlannedFinishAt = future[0] ?? null;
      result.queue.data.lastPlannedFinishAt = future[future.length - 1] ?? null;
    }
    const sections = [result.skills, result.queue, result.attributes];
    result.status = sections.every(section => section.status === 'ready') ? 'ready'
      : sections.some(section => section.data !== null) ? 'partial'
      : sections.every(section => section.status === 'needs_permission') ? 'needs_permission'
      : sections.some(section => section.status === 'error') ? 'error' : 'unavailable';
    return result;
  };
}

export const readCharacterAnalytics = createCharacterAnalyticsReader({ connections: listConnections, character: readCharacterData });
