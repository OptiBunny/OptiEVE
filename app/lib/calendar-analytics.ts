import { EveError, listConnections, readCharacterData } from './eve';
import { overviewDate } from './overview-summary';
import { walletActivityExpiry } from './wallet-analytics';
import type { CalendarAnalytics, CalendarEvent, CalendarEventResponse, CalendarSchedule } from './calendar-analytics-types';

type Selection = { characterId: number; fromEvent: number | null };
type Dependencies = {
  connections: (user: string) => Promise<{ characterId: number; scopes: string[] }[]>;
  character: (user: string, args: { characterId: number; dataset: string; parameters: { fromEvent?: number } }, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
};
const scope = 'esi-calendar.read_calendar_events.v1' as const, DAY = 86400000, BYTE_LIMIT = 256 * 1024;
const responseStates: (CalendarEventResponse | null)[] = ['accepted', 'declined', 'tentative', 'not_responded', null];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min = 1): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
class CalendarDataError extends Error {}
const invalid = (): never => { throw new CalendarDataError(); };
const limitations = [
  'One manually selected batch of up to fifty calendar summaries. With no cursor EVE returns the next chronological summaries; a cursor continues after that event. An empty or short batch is not proof of complete calendar history or every future event.',
  'Continuation uses only the last provider row’s event ID, never the largest numeric ID. Missing or unchanged final IDs suppress continuation. Changing batches replaces the result; no additional batch is fetched automatically.',
  'All summary fields are optional in the dated ESI schema. Missing values remain unknown. Unsafe title text is explicitly redacted; reported empty titles remain distinct from missing or redacted titles. Safe titles are plain text limited to 256 Unicode characters with a truncation flag.',
  'Date windows use the load completion clock and reported event dates, not event duration, completion, attendance or readiness. Response states are reported choices, not proof of attendance. Importance is reported as an integer without an invented priority scale.',
  'No event details, descriptions, attendees, owner names or location lookup is requested. Event selection and continuation IDs remain private request context; no result or history is retained and no event response or game state is changed.',
];
export function validateCalendarAnalyticsArgs(value: unknown): Selection {
  if (!record(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['characterId', 'fromEvent'].includes(key)) ||
      !Object.hasOwn(value, 'characterId') || !integer(value.characterId) ||
      'fromEvent' in value && !Object.hasOwn(value, 'fromEvent') || Object.hasOwn(value, 'fromEvent') && !integer(value.fromEvent)) {
    throw new EveError('Choose one connected character and an optional positive calendar continuation cursor.');
  }
  return { characterId: value.characterId, fromEvent: value.fromEvent as number | undefined ?? null };
}
function timestamp(value: unknown): string | null { const parsed = overviewDate(value); return parsed?.length === 24 ? parsed : null; }
function headerDate(value: unknown): string | null {
  const iso = timestamp(value); if (iso) return iso;
  if (typeof value !== 'string' || value.length > 100) return null;
  const time = Date.parse(value); if (!Number.isFinite(time) || new Date(time).toUTCString() !== value) return null;
  const normalized = new Date(time).toISOString(); return normalized.length === 24 ? normalized : null;
}
async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let stop: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { stop = () => reject(signal.reason); signal.addEventListener('abort', stop, { once: true }); });
  void interrupted.catch(() => {});
  try { const value = await Promise.race([work(), interrupted]); signal.throwIfAborted(); return value; }
  finally { signal.removeEventListener('abort', stop); }
}
function blank(selected: Selection, at: number, status: CalendarAnalytics['status'], message: string): CalendarAnalytics {
  return { characterId: selected.characterId, generatedAt: new Date(at).toISOString(), status, message, scope,
    coverage: { kind: 'unavailable', fromEvent: selected.fromEvent, nextFromEvent: null, continuation: 'unavailable', events: 0 },
    freshness: { state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null }, summary: null, responseCounts: [], schedule: null, events: [], limitations: [...limitations] };
}
function title(row: Record<string, unknown>): Pick<CalendarEvent, 'title' | 'titleState' | 'titleTruncated'> {
  if (!Object.hasOwn(row, 'title')) return { title: null, titleState: 'missing', titleTruncated: false };
  if (typeof row.title !== 'string') return invalid();
  const redacted = { title: null, titleState: 'redacted' as const, titleTruncated: false };
  if (/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(row.title)) return redacted;
  let text = '', characters = 0;
  for (const character of row.title) {
    if (character.length === 1 && /[\ud800-\udfff]/.test(character)) return redacted;
    if (characters++ < 256) text += character;
  }
  return { title: text, titleState: 'reported', titleTruncated: characters > 256 };
}
function eventsOf(data: unknown): CalendarEvent[] {
  if (!Array.isArray(data) || data.length > 50) return invalid();
  const seen = new Set<number>();
  return data.map((raw, index) => {
    if (!record(raw)) return invalid();
    let eventId: number | null = null, date: string | null = null, response: CalendarEventResponse | null = null, importance: number | null = null;
    if (Object.hasOwn(raw, 'event_id')) { if (!integer(raw.event_id) || seen.has(raw.event_id)) return invalid(); eventId = raw.event_id; seen.add(eventId); }
    if (Object.hasOwn(raw, 'event_date')) { date = timestamp(raw.event_date); if (date === null) return invalid(); }
    if (Object.hasOwn(raw, 'event_response')) { if (typeof raw.event_response !== 'string' || !responseStates.includes(raw.event_response as CalendarEventResponse)) return invalid(); response = raw.event_response as CalendarEventResponse; }
    if (Object.hasOwn(raw, 'importance')) { if (!integer(raw.importance, Number.MIN_SAFE_INTEGER)) return invalid(); importance = raw.importance; }
    return { row: index + 1, eventId, date, response, importance, ...title(raw) };
  });
}
/** Disjoint date buckets over the whole accepted batch; daily bins cover (asOf, asOf + 30 days]. */
export function calendarSchedule(events: CalendarEvent[], asOf: string): CalendarSchedule {
  const at = Date.parse(asOf), daily = new Map<string, number>();
  const result: CalendarSchedule = { asOf, horizonDays: 30, pastOrNowEvents: 0, next24hEvents: 0, days2To7Events: 0, days8To30Events: 0, laterEvents: 0, missingDateEvents: 0, daily: [] };
  for (const event of events) {
    if (event.date === null) { result.missingDateEvents++; continue; }
    const offset = Date.parse(event.date) - at;
    if (offset <= 0) result.pastOrNowEvents++;
    else if (offset <= DAY) result.next24hEvents++;
    else if (offset <= 7 * DAY) result.days2To7Events++;
    else if (offset <= 30 * DAY) result.days8To30Events++;
    else result.laterEvents++;
    if (offset > 0 && offset <= 30 * DAY) { const day = event.date.slice(0, 10); daily.set(day, (daily.get(day) ?? 0) + 1); }
  }
  result.daily = [...daily].sort(([left], [right]) => left.localeCompare(right)).map(([date, events]) => ({ date, events }));
  return result;
}
function accept(selected: Selection, value: unknown) {
  if (!record(value) || value.characterId !== selected.characterId || value.dataset !== 'calendar' || value.entity !== undefined && value.entity !== 'character' ||
      value.corporationId != null || value.division != null || value.page != null || new TextEncoder().encode(JSON.stringify(value)).byteLength > BYTE_LIMIT) return invalid();
  const retrievedAt = timestamp(value.retrievedAt); if (retrievedAt === null) return invalid();
  const events = eventsOf(value.data), pagination = value.pagination, lastId = events.at(-1)?.eventId ?? null;
  if (!record(pagination) || pagination.kind !== 'calendar' || pagination.nextFromEvent !== lastId ||
      ['page', 'pages', 'nextPage', 'nextFromId', 'nextBeforeId', 'after', 'before'].some(key => pagination[key] != null)) return invalid();
  const continuation: CalendarAnalytics['coverage']['continuation'] = !events.length ? 'empty' : lastId === null ? 'missing_last_id' : lastId === selected.fromEvent ? 'unchanged_cursor' : 'available';
  return { events, retrievedAt, cacheExpires: timestamp(walletActivityExpiry(value, Date.parse(retrievedAt))), lastModified: headerDate(value.lastModified),
    coverage: { kind: 'returned_batch' as const, fromEvent: selected.fromEvent, nextFromEvent: continuation === 'available' ? lastId : null, continuation, events: events.length } };
}
function project(selected: Selection, accepted: ReturnType<typeof accept>, completed: number): CalendarAnalytics {
  if (Date.parse(accepted.retrievedAt) > completed + 60000) return invalid();
  const { events, coverage, retrievedAt, cacheExpires, lastModified } = accepted;
  const state = cacheExpires === null ? 'unknown' : Date.parse(cacheExpires) <= completed ? 'stale' : 'fresh';
  const result = blank(selected, completed, state === 'fresh' ? 'ready' : 'partial', `One returned calendar-summary batch; source freshness is ${state}. Event dates and response states do not establish attendance or completion. No history is saved.`);
  result.coverage = coverage; result.freshness = { state, retrievedAt, cacheExpires, lastModified }; result.events = events;
  result.summary = { events: events.length, datedEvents: events.filter(row => row.date !== null).length, missingEventIds: events.filter(row => row.eventId === null).length,
    missingTitles: events.filter(row => row.titleState === 'missing').length, emptyTitles: events.filter(row => row.titleState === 'reported' && row.title === '').length,
    redactedTitles: events.filter(row => row.titleState === 'redacted').length, missingImportance: events.filter(row => row.importance === null).length };
  result.responseCounts = responseStates.map(response => ({ response, events: events.filter(row => row.response === response).length }));
  result.schedule = calendarSchedule(events, result.generatedAt);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > BYTE_LIMIT) return invalid();
  return result;
}
/** One owned calendar-summary batch using the existing read grant. No event-detail or attendee read. */
export function createCalendarAnalyticsReader(dependencies: Dependencies) {
  return async (user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<CalendarAnalytics> => {
    const selected = validateCalendarAnalyticsArgs(input), now = dependencies.now ?? Date.now;
    if (typeof user !== 'string' || !user) throw new EveError('Sign in to this private connector first.', 401);
    const deadline = now() + 55000, signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    signal.throwIfAborted(); let connection: { characterId: number; scopes: string[] } | undefined;
    try { connection = (await abortable(() => dependencies.connections(user), signal)).find(row => row.characterId === selected.characterId); }
    catch { return blank(selected, now(), 'unavailable', signal.aborted ? 'The calendar request was cancelled or reached its time limit.' : 'Connection status could not be checked. Refresh to try again.'); }
    if (!connection) throw new EveError('Choose a character connected to this private connector.', 404);
    if (signal.aborted || now() >= deadline) return blank(selected, now(), 'unavailable', 'The calendar request was cancelled or reached its time limit.');
    if (!connection.scopes.includes(scope)) return blank(selected, now(), 'needs_permission', 'This character has not granted the existing calendar read permission. No additional access is requested automatically.');
    try {
      const args = { characterId: selected.characterId, dataset: 'calendar', parameters: selected.fromEvent === null ? {} : { fromEvent: selected.fromEvent } };
      const response = await abortable(() => dependencies.character(user, args, signal), signal);
      const accepted = accept(selected, response), completed = now(); signal.throwIfAborted();
      if (completed >= deadline) return blank(selected, completed, 'unavailable', 'The calendar request was cancelled or reached its time limit.');
      const result = project(selected, accepted, completed); signal.throwIfAborted();
      if (now() >= deadline) return blank(selected, now(), 'unavailable', 'The calendar request was cancelled or reached its time limit.');
      return result;
    } catch (error) {
      if (signal.aborted || now() >= deadline) return blank(selected, now(), 'unavailable', 'The calendar request was cancelled or reached its time limit.');
      if (error instanceof EveError && [401, 404, 409].includes(error.status)) return blank(selected, now(), 'unavailable', 'The connection changed or its authorization expired. Reload connection status before trying again.');
      if (error instanceof EveError && error.status === 403) return blank(selected, now(), 'unavailable', 'EVE denied this calendar read. Check the saved read permission; no access is added automatically.');
      if (error instanceof EveError && error.status === 429) return blank(selected, now(), 'unavailable', 'EVE is rate limiting reads. Wait before loading again; no automatic retry was made.');
      return blank(selected, now(), 'error', 'Calendar summaries could not be validated or loaded safely. Missing data is unknown, not zero.');
    }
  };
}
export const readCalendarAnalytics = createCalendarAnalyticsReader({ connections: listConnections, character: readCharacterData });
