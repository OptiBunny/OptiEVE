import { EveError, listConnections, readCharacterData } from './eve';
import { overviewDate } from './overview-summary';
import { walletActivityDecimal, walletActivityFormat, walletActivityExpiry } from './wallet-analytics';
import type { PersonalFreelance, PersonalFreelanceJob, FreelanceJobState, FreelanceParticipationState, FreelanceFreshness } from './personal-freelance-types';

type Selection = { characterId: number; jobId: string | null };
type Dependencies = {
  connections: (user: string) => Promise<{ characterId: number; scopes: string[] }[]>;
  character: (user: string, args: { characterId: number; dataset: string; parameters?: { jobId: string } }, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
};
const scope = 'esi-characters.read_freelance_jobs.v1' as const, byteLimit = 2 * 1024 * 1024;
const jobStates: FreelanceJobState[] = ['Unspecified', 'Active', 'Closed', 'Completed', 'Expired', 'Deleted'];
const participationStates: FreelanceParticipationState[] = ['Unspecified', 'Committed', 'Kicked', 'Resigned'];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
class FreelanceDataError extends Error {}
const invalid = (): never => { throw new FreelanceDataError(); };
const limitations = [
  'One selected character’s returned list of freelance participation. Jobs are not claimed to be owned by that character or corporation, and this is not a history of every past job.',
  'An explicitly selected job is checked against the accepted list before one own participation read. Other jobs, public discovery, job descriptions and participant lists are not requested.',
  'Progress uses each job’s configured units. Current and desired values are not added across jobs. Zero targets and progress above a target do not establish completion, payment or failure.',
  'Reward reserves are job budgets, not personal earned, claimable or paid ISK or profit. Missing reward evidence is unknown, not zero; no reward total or initial-minus-remaining payout is calculated.',
  'Amounts preserve the decimal representation of each received JSON number without cent rounding. Precision lost before parsing cannot be recovered. Numeric limits are application limits, not provider precision guarantees.',
  'List and selected participation have independent caches. Job progress and your reported contribution are separate observations, not an atomic snapshot or evidence of a contribution rate.',
  'Names are untrusted plain text. Unsafe names are redacted, long safe names have a bounded preview, and no result, name or selection is retained as history.',
  'At most 1,000 jobs are accepted; larger responses are rejected rather than silently truncated. Filters and table pages operate locally on this accepted response.',
];

export function validatePersonalFreelanceArgs(value: unknown): Selection {
  const fail = (): never => { throw new EveError('Choose one connected character and, optionally, one freelance job UUID.'); };
  if (!record(value)) return fail();
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !['characterId', 'jobId'].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'))) return fail();
  for (const key in value) if (!Object.hasOwn(value, key)) return fail();
  if (!Object.hasOwn(value, 'characterId') || !integer(value.characterId, 1) || 'jobId' in value && (!Object.hasOwn(value, 'jobId') || !uuid(value.jobId))) return fail();
  return { characterId: value.characterId, jobId: Object.hasOwn(value, 'jobId') ? (value.jobId as string).toLowerCase() : null };
}
function timestamp(value: unknown): string | null { const parsed = overviewDate(value); return parsed?.length === 24 ? parsed : null; }
function headerDate(value: unknown): string | null {
  const iso = timestamp(value); if (iso) return iso;
  if (typeof value !== 'string' || value.length > 100) return null;
  const at = Date.parse(value); if (!Number.isFinite(at) || new Date(at).toUTCString() !== value) return null;
  const normalized = new Date(at).toISOString(); return normalized.length === 24 ? normalized : null;
}
const emptyFreshness = (): FreelanceFreshness => ({ state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null });
function blank(selected: Selection, at: number, status: PersonalFreelance['status'], message: string): PersonalFreelance {
  return { characterId: selected.characterId, selectedJobId: selected.jobId, generatedAt: new Date(at).toISOString(), status, scope, message,
    coverage: { kind: 'unavailable', jobs: null, rowLimit: 1000 }, listFreshness: emptyFreshness(), summary: null, stateCounts: [], jobs: [],
    participation: { status: selected.jobId === null ? 'not_requested' : 'unavailable', message: selected.jobId === null ? 'No participation read was requested.' : 'The selected participation could not be checked.', freshness: emptyFreshness(), data: null }, limitations: [...limitations] };
}
function bounded(value: unknown) {
  // Post-parse envelope/projection limit; the core reader separately bounds the
  // upstream stream at 8 MiB. This does not claim a tighter transport/heap limit.
  try { if (new TextEncoder().encode(JSON.stringify(value)).byteLength > byteLimit) return invalid(); }
  catch { return invalid(); }
}
function envelope(value: unknown, selected: Selection, dataset: 'freelance_jobs' | 'freelance_participation', at: number) {
  bounded(value);
  const pagination = record(value) ? value.pagination : null;
  const suffix = dataset === 'freelance_jobs' ? '' : '/' + selected.jobId + '/participation';
  if (!record(value) || value.characterId !== selected.characterId || value.dataset !== dataset ||
      value.entity !== undefined && value.entity !== 'character' || value.corporationId != null || value.division != null || value.page != null ||
      value.source !== `https://esi.evetech.net/characters/${selected.characterId}/freelance-jobs${suffix}` ||
      !record(pagination) || pagination.kind !== 'none' ||
      ['page', 'pages', 'nextPage', 'nextFromId', 'nextBeforeId', 'nextFromEvent', 'after', 'before', 'pageLimit', 'morePagesAvailable', 'pageLimitReached'].some(key => pagination[key] != null)) return invalid();
  const retrievedAt = timestamp(value.retrievedAt); if (!retrievedAt || Date.parse(retrievedAt) > at + 60000) return invalid();
  const cacheExpires = walletActivityExpiry(value, Date.parse(retrievedAt));
  const freshness: FreelanceFreshness = { state: cacheExpires === null ? 'unknown' : Date.parse(cacheExpires) <= at ? 'stale' : 'fresh', retrievedAt, cacheExpires, lastModified: headerDate(value.lastModified) };
  return { data: value.data, freshness };
}
function nameOf(value: unknown): Pick<PersonalFreelanceJob, 'name' | 'nameState' | 'nameTruncated'> {
  if (typeof value !== 'string' || value.length > 16384) return invalid();
  const redacted = { name: null, nameState: 'redacted' as const, nameTruncated: false };
  if (/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value)) return redacted;
  let name = '', count = 0;
  // Scan every code point even once the displayed prefix is full.
  for (const character of value) {
    if (character.length === 1 && /[\ud800-\udfff]/.test(character)) return redacted;
    if (count++ < 256) name += character;
  }
  return { name, nameState: 'reported', nameTruncated: count > 256 };
}
function reserve(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return invalid();
  return walletActivityFormat(walletActivityDecimal(value));
}
function jobsOf(value: unknown): PersonalFreelanceJob[] {
  if (!record(value) || !Array.isArray(value.freelance_jobs) || value.freelance_jobs.length > 1000) return invalid();
  const seen = new Set<string>();
  const jobs = value.freelance_jobs.map(row => {
    if (!record(row) || !uuid(row.id) || seen.has(row.id.toLowerCase()) || typeof row.state !== 'string' || !jobStates.includes(row.state as FreelanceJobState) ||
        !record(row.progress) || !integer(row.progress.current) || !integer(row.progress.desired)) return invalid();
    const jobId = row.id.toLowerCase(), updatedAt = timestamp(row.last_modified); if (!updatedAt) return invalid(); seen.add(jobId);
    let rewardReserve: PersonalFreelanceJob['rewardReserve'] = null;
    if (Object.hasOwn(row, 'reward')) { if (!record(row.reward)) return invalid(); rewardReserve = { initialISK: reserve(row.reward.initial), remainingISK: reserve(row.reward.remaining) }; }
    return { jobId, ...nameOf(row.name), state: row.state as FreelanceJobState, updatedAt, progress: { current: row.progress.current, desired: row.progress.desired }, rewardReserve };
  });
  return jobs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.jobId.localeCompare(right.jobId));
}
function participationOf(value: unknown): NonNullable<PersonalFreelance['participation']['data']> {
  if (!record(value) || typeof value.state !== 'string' || !participationStates.includes(value.state as FreelanceParticipationState) || !integer(value.contributed, Number.MIN_SAFE_INTEGER)) return invalid();
  const updatedAt = timestamp(value.last_modified); if (!updatedAt) return invalid();
  return { state: value.state as FreelanceParticipationState, contributed: value.contributed, updatedAt };
}
function finish(value: PersonalFreelance, at: number): PersonalFreelance {
  value.generatedAt = new Date(at).toISOString();
  for (const freshness of [value.listFreshness, value.participation.freshness]) freshness.state = freshness.cacheExpires === null ? 'unknown' : Date.parse(freshness.cacheExpires) <= at ? 'stale' : 'fresh';
  if (value.summary) value.status = value.listFreshness.state === 'fresh' && value.summary.redactedNames === 0 && value.summary.truncatedNames === 0 &&
    (value.participation.status === 'not_requested' || value.participation.status === 'ready' && value.participation.freshness.state === 'fresh') ? 'ready' : 'partial';
  bounded(value); return value;
}
async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let stop: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { stop = () => reject(signal.reason); signal.addEventListener('abort', stop, { once: true }); }); void interrupted.catch(() => {});
  try { const value = await Promise.race([work(), interrupted]); signal.throwIfAborted(); return value; }
  finally { signal.removeEventListener('abort', stop); }
}

/** Personal list plus at most one explicitly selected participation; no fanout or retention. */
export function createPersonalFreelanceReader(dependencies: Dependencies) {
  return async (user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<PersonalFreelance> => {
    const selected = validatePersonalFreelanceArgs(input), now = dependencies.now ?? Date.now;
    if (typeof user !== 'string' || !user) throw new EveError('Sign in to this private connector first.', 401);
    const deadline = now() + 55000, signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    const checkBudget = () => { signal.throwIfAborted(); if (now() >= deadline) throw new FreelanceDataError(); };
    const cancelled = () => blank(selected, now(), 'unavailable', 'The freelance request was cancelled or reached its time limit. Load again when ready.');
    checkBudget(); let connection: { characterId: number; scopes: string[] } | undefined;
    try { connection = (await abortable(() => dependencies.connections(user), signal)).find(row => row.characterId === selected.characterId); }
    catch { return signal.aborted || now() >= deadline ? cancelled() : blank(selected, now(), 'unavailable', 'Connection status could not be checked. Reload Connections before trying again.'); }
    if (!connection) throw new EveError('Choose a character connected to this private connector.', 404);
    if (signal.aborted || now() >= deadline) return cancelled();
    if (!connection.scopes.includes(scope)) return blank(selected, now(), 'needs_permission', 'This character has not granted the existing freelance read permission. No access is added automatically.');
    const result = blank(selected, now(), 'unavailable', 'Freelance evidence is unavailable.'); let stage: 'list' | 'participation' = 'list';
    try {
      checkBudget();
      const listing = envelope(await abortable(() => dependencies.character(user, { characterId: selected.characterId, dataset: 'freelance_jobs' }, signal), signal), selected, 'freelance_jobs', now());
      const jobs = jobsOf(listing.data); checkBudget();
      result.jobs = jobs; result.listFreshness = listing.freshness; result.coverage = { kind: 'returned_list', jobs: jobs.length, rowLimit: 1000 };
      result.summary = { jobs: jobs.length, withRewardReserve: jobs.filter(row => row.rewardReserve !== null).length, withoutRewardReserve: jobs.filter(row => row.rewardReserve === null).length, redactedNames: jobs.filter(row => row.nameState === 'redacted').length, truncatedNames: jobs.filter(row => row.nameTruncated).length };
      result.stateCounts = jobStates.map(state => ({ state, jobs: jobs.filter(row => row.state === state).length }));
      result.message = 'Reported freelance jobs for this character’s participation. Progress and reward reserves belong to each job; personal earnings are not inferred.';
      if (selected.jobId !== null) {
        if (!jobs.some(row => row.jobId === selected.jobId)) result.participation = { status: 'not_listed', message: 'This job is not in the character’s returned list. No participation detail was requested.', freshness: emptyFreshness(), data: null };
        else {
          stage = 'participation'; checkBudget();
          const detail = envelope(await abortable(() => dependencies.character(user, { characterId: selected.characterId, dataset: 'freelance_participation', parameters: { jobId: selected.jobId! } }, signal), signal), selected, 'freelance_participation', now());
          const data = participationOf(detail.data); checkBudget();
          result.participation = { status: 'ready', message: 'Your reported participation for the explicitly selected job, with its own cache evidence.', freshness: detail.freshness, data };
        }
      }
      const completed = finish(result, now()); checkBudget(); return completed;
    } catch (error) {
      if (signal.aborted || now() >= deadline) return cancelled();
      const unavailable = error instanceof EveError && [401, 403, 404, 409, 429].includes(error.status), state = unavailable ? 'unavailable' : 'error';
      const message = unavailable ? 'The selected source could not be read with the current authorization or provider availability. No access was added or retry made.' : 'Freelance evidence could not be validated within the accepted format and limits. Missing data is unknown, not zero.';
      if (stage === 'list') return blank(selected, now(), state, message);
      result.participation = { status: state, message, freshness: emptyFreshness(), data: null }; result.message = 'The job list is available; selected participation evidence is unavailable. The two reads are not an atomic snapshot.';
      try { return finish(result, now()); } catch { return blank(selected, now(), 'error', 'The freelance response exceeded the accepted output limits. No partial count or reward is assumed.'); }
    }
  };
}
export const readPersonalFreelance = createPersonalFreelanceReader({ connections: listConnections, character: readCharacterData });
