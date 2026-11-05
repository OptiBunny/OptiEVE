import { EveError, listConnections, readCharacterData, readCorporationData } from './eve';
import { overviewDate } from './overview-summary';
import { findPublishedManufacturingItem } from './manufacturing-catalog';
import type { IndustryAnalytics, IndustryAnalyticsArgs, IndustryJob, IndustryJobStatus } from './industry-analytics-types';

type DatasetArgs = { characterId: number; dataset: string; parameters?: Record<string, unknown> };
type Dependencies = {
  connections: (user: string) => Promise<{ characterId: number; scopes: string[] }[]>;
  character: (user: string, args: DatasetArgs, signal?: AbortSignal) => Promise<unknown>;
  corporation: (user: string, args: DatasetArgs, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
};
type Selection = { characterId: number; entity: 'character' | 'corporation'; includeCompleted: boolean; page: number | null };
const scopes = { character: 'esi-industry.read_character_jobs.v1', corporation: 'esi-industry.read_corporation_jobs.v1' };
const statuses: IndustryJobStatus[] = ['active', 'cancelled', 'delivered', 'paused', 'ready', 'reverted'];
// CCP SDE build 3670638, industryActivities.jsonl. Unknown numeric IDs stay explicit.
// https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-3670638-jsonl.zip
const activities: Record<number, string> = { 1: 'Manufacturing', 3: 'Time Efficiency Research', 4: 'Material Efficiency Research', 5: 'Copying', 8: 'Invention', 9: 'Reactions' };
const activityLabel = (id: number) => activities[id] ?? `Activity ${id}`;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
class IndustryDataError extends Error {}
const invalid = (): never => { throw new IndustryDataError(); };
const limitations = [
  'Only the selected response is included. Corporation jobs are one page at a time; changing pages replaces the chart and pages are never combined.',
  'Completed jobs are included only when explicitly requested, within EVE’s available past-90-day window. This is not a lifetime history or a complete calendar-period report.',
  'Status counts are reported by EVE. An active job past its reported end can reflect delayed data; it is not proof of readiness, delivery, success or output ownership.',
  'Timeline bars use reported start and end dates, including paused or historical jobs. They do not establish current progress, a guaranteed finish, parallel capacity or available job slots.',
  'Runs mean different things for manufacturing, copying and other activities. They are shown per job and never summed into a common output quantity. Costs, profit and output value are not calculated.',
  'Blueprint and product names come from the pinned public catalog. Unknown types retain their numeric ID; an omitted product is not invented. No personal item names or facility lookups are requested.',
  'No installer, completing-character, location, blueprint-item, cost or probability fields are returned. Nothing is saved. The application rejects responses above 5,000 job rows rather than truncating summaries.',
];

export function validateIndustryAnalyticsArgs(value: unknown): Selection {
  if (!record(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['characterId', 'entity', 'includeCompleted', 'page'].includes(key)) ||
      !Object.hasOwn(value, 'characterId') || !integer(value.characterId, 1) || !Object.hasOwn(value, 'entity') ||
      value.entity !== 'character' && value.entity !== 'corporation' ||
      Object.hasOwn(value, 'includeCompleted') && typeof value.includeCompleted !== 'boolean' ||
      value.entity === 'character' && Object.hasOwn(value, 'page') ||
      value.entity === 'corporation' && Object.hasOwn(value, 'page') && !integer(value.page, 1, 500)) {
    throw new EveError('Choose one connected character, a job owner and whether to include completed jobs. Only corporation jobs accept a page from 1 to 500.');
  }
  return { characterId: value.characterId, entity: value.entity, includeCompleted: value.includeCompleted === true, page: value.entity === 'corporation' ? value.page as number | undefined ?? 1 : null };
}
function timestamp(value: unknown): string | null {
  const stamp = overviewDate(value);
  return stamp?.length === 24 ? stamp : null;
}
function optionalDate(value: unknown): string | null { return value == null ? null : timestamp(value) ?? invalid(); }
function headerTime(value: unknown): number | null {
  const stamp = timestamp(value);
  if (stamp) return Date.parse(stamp);
  if (typeof value !== 'string' || value.length > 100) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toUTCString() === value ? parsed : null;
}
function expiry(response: Record<string, unknown>, received: number): string | null {
  const expires = headerTime(response.cacheExpires), date = headerTime(response.responseDate);
  const control = typeof response.cacheControl === 'string' && response.cacheControl.length <= 512 ? response.cacheControl : '';
  if (/(?:^|,)\s*(?:no-cache|no-store)(?=\s*(?:,|$))/i.test(control)) return new Date(received).toISOString();
  const age = response.cacheAge == null ? 0 : typeof response.cacheAge === 'string' && /^\d{1,10}$/.test(response.cacheAge) ? Number(response.cacheAge) : NaN;
  if (!integer(age, 0, 604800)) return null;
  const match = /(?:^|,)\s*max-age=(\d+)(?=\s*(?:,|$))/i.exec(control), maxAge = match ? Number(match[1]) : null;
  const cached = integer(maxAge, 0, 604800) && date !== null && date <= received + 60000 ? Math.min(date + maxAge * 1000, received + (maxAge - age) * 1000) : null;
  const until = expires === null ? cached : cached === null ? expires : Math.min(expires, cached);
  return until === null ? null : new Date(until).toISOString();
}
async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); });
  void interrupted.catch(() => {});
  try { const result = await Promise.race([work(), interrupted]); signal.throwIfAborted(); return result; }
  finally { signal.removeEventListener('abort', cancel); }
}
function typeName(typeId: number): { name: string; known: boolean } {
  const item = findPublishedManufacturingItem(typeId), name = item?.name;
  return typeof name === 'string' && name.trim() === name && name.length > 0 && name.length <= 512 && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(name)
    ? { name, known: true } : { name: `Type ${typeId}`, known: false };
}
function blank(selection: Selection, now: number, status: IndustryAnalytics['status'], message: string): IndustryAnalytics {
  return {
    characterId: selection.characterId, entity: selection.entity, corporationId: null, includeCompleted: selection.includeCompleted,
    generatedAt: new Date(now).toISOString(), status, message, scope: scopes[selection.entity],
    coverage: { kind: 'unavailable', page: selection.page, pages: null, nextPage: null, previousPage: selection.page !== null && selection.page > 1 ? selection.page - 1 : null, pageLimitReached: false, rows: 0 },
    freshness: { state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null }, summary: null, statusCounts: [], activityCounts: [], jobs: [], limitations: [...limitations],
  };
}
function coverage(selection: Selection, pagination: unknown, rows: number): IndustryAnalytics['coverage'] {
  if (!record(pagination) || ['after', 'before', 'nextFromId', 'nextBeforeId', 'nextFromEvent'].some(key => pagination[key] != null)) return invalid();
  if (selection.entity === 'character') {
    if (pagination.kind !== 'none' || ['page', 'pages', 'nextPage', 'pageLimit', 'morePagesAvailable', 'pageLimitReached'].some(key => pagination[key] != null)) return invalid();
    return { kind: 'complete_returned_response', page: null, pages: null, nextPage: null, previousPage: null, pageLimitReached: false, rows };
  }
  const page = selection.page!;
  if (pagination.kind !== 'page' || pagination.page !== page || pagination.pages !== null && !integer(pagination.pages, 1) || typeof pagination.pages === 'number' && pagination.pages < page) return invalid();
  const pages = pagination.pages as number | null, more = pages === null ? null : page < pages;
  const nextPage = more === true && page < 500 ? page + 1 : null, pageLimitReached = page === 500 && more !== false;
  if (pagination.nextPage !== nextPage || pagination.pageLimit !== undefined && pagination.pageLimit !== 500 ||
      pagination.morePagesAvailable !== undefined && pagination.morePagesAvailable !== more || pagination.pageLimitReached !== undefined && pagination.pageLimitReached !== pageLimitReached) return invalid();
  return { kind: pages === null ? 'unknown' : page === 1 && pages === 1 ? 'complete_returned_response' : 'partial', page, pages, nextPage, previousPage: page > 1 ? page - 1 : null, pageLimitReached, rows };
}
function summarize(selection: Selection, response: unknown, completed: number): IndustryAnalytics {
  if (!record(response) || response.characterId !== selection.characterId || response.dataset !== 'industry_jobs' ||
      selection.entity === 'corporation' && (response.entity !== 'corporation' || !integer(response.corporationId, 1)) ||
      selection.entity === 'character' && (response.entity !== undefined && response.entity !== 'character' || response.corporationId != null) ||
      !Array.isArray(response.data) || response.data.length > 5000) return invalid();
  const retrievedAt = timestamp(response.retrievedAt);
  if (!retrievedAt || Date.parse(retrievedAt) > completed + 60000) return invalid();
  const selectedCoverage = coverage(selection, response.pagination, response.data.length);
  const seen = new Set<number>(), activityCounts = new Map<number, { activityId: number; label: string; count: number }>();
  const statusCounts = statuses.map(status => ({ status, count: 0 }));
  let unknownBlueprintNames = 0, unknownProductNames = 0;
  const jobs: IndustryJob[] = response.data.map(row => {
    if (!record(row) || !integer(row.job_id, 1) || seen.has(row.job_id) || !integer(row.activity_id, 1) || !integer(row.blueprint_type_id, 1) ||
        !integer(row.runs) || !integer(row.duration) || typeof row.status !== 'string' || !statuses.includes(row.status as IndustryJobStatus) ||
        row.product_type_id != null && !integer(row.product_type_id, 1)) return invalid();
    seen.add(row.job_id);
    const startAt = timestamp(row.start_date), endAt = timestamp(row.end_date);
    if (!startAt || !endAt || Date.parse(endAt) < Date.parse(startAt)) return invalid();
    const blueprint = typeName(row.blueprint_type_id), product = row.product_type_id == null ? null : typeName(row.product_type_id as number);
    if (!blueprint.known) unknownBlueprintNames++;
    if (product && !product.known) unknownProductNames++;
    const activity = activityCounts.get(row.activity_id) ?? { activityId: row.activity_id, label: activityLabel(row.activity_id), count: 0 };
    activity.count++; activityCounts.set(row.activity_id, activity);
    statusCounts.find(value => value.status === row.status)!.count++;
    return { jobId: row.job_id, activityId: row.activity_id, activityLabel: activity.label, status: row.status as IndustryJobStatus,
      blueprintTypeId: row.blueprint_type_id, blueprintName: blueprint.name, productTypeId: row.product_type_id as number | null | undefined ?? null, productName: product?.name ?? null,
      runs: row.runs, durationSeconds: row.duration, startAt, endAt, pauseAt: optionalDate(row.pause_date), completedAt: optionalDate(row.completed_date) };
  }).sort((left, right) => left.endAt.localeCompare(right.endAt) || left.jobId - right.jobId);
  const active = jobs.filter(row => row.status === 'active');
  const summary = { jobs: jobs.length, active: active.length, ready: statusCounts.find(row => row.status === 'ready')!.count, paused: statusCounts.find(row => row.status === 'paused')!.count,
    activePastEnd: active.filter(row => Date.parse(row.endAt) <= completed).length,
    activeDueWithin24h: active.filter(row => Date.parse(row.endAt) > completed && Date.parse(row.endAt) <= completed + 86400000).length,
    unknownBlueprintNames, unknownProductNames };
  const cacheExpires = expiry(response, Date.parse(retrievedAt));
  const freshness: IndustryAnalytics['freshness'] = { state: cacheExpires === null ? 'unknown' : Date.parse(cacheExpires) <= completed ? 'stale' : 'fresh', retrievedAt, cacheExpires,
    lastModified: headerTime(response.lastModified) === null ? null : new Date(headerTime(response.lastModified)!).toISOString() };
  const complete = selectedCoverage.kind === 'complete_returned_response' && freshness.state === 'fresh' && unknownBlueprintNames === 0 && unknownProductNames === 0;
  const message = (selection.entity === 'character' ? 'One character industry response. ' : `Corporation industry page ${selection.page}${selectedCoverage.pages === null ? '; page count unknown' : ` of ${selectedCoverage.pages}`}. `) +
    (selection.includeCompleted ? 'Completed jobs were requested within EVE’s available past-90-day window. ' : 'Completed jobs were not requested. ') +
    `Counts describe returned records; source freshness is ${freshness.state}. No history is saved.`;
  return { ...blank(selection, completed, complete ? 'ready' : 'partial', message), corporationId: selection.entity === 'corporation' ? response.corporationId as number : null,
    coverage: selectedCoverage, freshness, summary, statusCounts, activityCounts: [...activityCounts.values()].sort((left, right) => right.count - left.count || left.activityId - right.activityId), jobs };
}

/** One owned response; no follow-up page, public lookup, persistence or game mutation. */
export function createIndustryAnalyticsReader(dependencies: Dependencies) {
  return async (user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<IndustryAnalytics> => {
    const selection = validateIndustryAnalyticsArgs(input), now = dependencies.now ?? Date.now;
    if (typeof user !== 'string' || !user) throw new EveError('Sign in to this private connector first.', 401);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    signal.throwIfAborted();
    let connection: { characterId: number; scopes: string[] } | undefined;
    try { connection = (await abortable(() => dependencies.connections(user), signal)).find(row => row.characterId === selection.characterId); }
    catch { return blank(selection, now(), 'unavailable', signal.aborted ? 'The industry request was cancelled or reached its time limit.' : 'Connection status could not be checked. Refresh to try again.'); }
    if (!connection) throw new EveError('Choose a character connected to this private connector.', 404);
    if (!connection.scopes.includes(scopes[selection.entity])) return blank(selection, now(), 'needs_permission', 'This character has not granted the required industry read permission. Review Connections; no extra access is requested automatically.');
    try {
      const args: DatasetArgs = { characterId: selection.characterId, dataset: 'industry_jobs', parameters: { includeCompleted: selection.includeCompleted, ...(selection.entity === 'corporation' ? { page: selection.page } : {}) } };
      const read = selection.entity === 'corporation' ? dependencies.corporation : dependencies.character;
      const response = await abortable(() => read(user, args, signal), signal);
      return summarize(selection, response, now());
    } catch (error) {
      if (signal.aborted) return blank(selection, now(), 'unavailable', 'The industry request was cancelled or reached its time limit. Refresh to try again.');
      if (error instanceof EveError && [401, 404, 409].includes(error.status)) return blank(selection, now(), 'unavailable', 'The connection changed or its authorization expired. Reload connection status before trying again.');
      if (error instanceof EveError && error.status === 403) return blank(selection, now(), 'unavailable', selection.entity === 'corporation' ? 'EVE denied this read. Check the character’s corporation industry permission and Factory Manager role.' : 'EVE denied this read. Check the character’s industry read permission.');
      if (error instanceof EveError && error.status === 429) return blank(selection, now(), 'unavailable', 'EVE is rate limiting requests. Wait before refreshing; no automatic retry was made.');
      return blank(selection, now(), 'error', error instanceof IndustryDataError ? 'EVE returned jobs that could not be summarized safely. Missing data is unknown, not zero.' : 'Industry jobs could not be loaded. No counts are assumed.');
    }
  };
}
export const readIndustryAnalytics = createIndustryAnalyticsReader({ connections: listConnections, character: readCharacterData, corporation: readCorporationData });
