import { EveError, listConnections, readCharacterData } from './eve';
import { buildCharacterRequest } from './character-data';
import { overviewDate } from './overview-summary';
import { walletActivityExpiry } from './wallet-analytics';
import { notificationTypes } from './notifications-analytics-types';
import type { NotificationCell, NotificationDaily, NotificationType, NotificationTypeCount, NotificationsAnalytics, NotificationsAnalyticsArgs, NotificationsFreshness, NotificationsStatus } from './notifications-analytics-types';

type Dependencies = {
  connections: (user: string) => Promise<{ characterId: number; scopes: string[] }[]>;
  character: (user: string, args: { characterId: number; dataset: string }, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
};
const scope = 'esi-characters.read_notifications.v1' as const, byteLimit = 2 * 1024 * 1024;
const knownTypes = new Set<string>(notificationTypes);
class NotificationsDataError extends Error {}
const invalid = (): never => { throw new NotificationsDataError(); };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const has = (value: object, key: PropertyKey) => Object.hasOwn(value, key);
const limitations = [
  'One manually loaded notification response. No automatic paging, background collection or account history is stored. A short or empty response does not establish complete history, deletion or a retention window.',
  'Counts describe only returned notifications. Omitted optional read flags mean unread under the provider contract; these are not a current global unread counter or proof that a notification still needs action.',
  'Reported timestamps are grouped by normalized UTC date. Future dates remain reported observations, not a schedule, and sparse dates are not filled with invented zero counts.',
  'Exact reviewed public notification types are retained. Safe unrecognized types share one withheld-type group and make the evidence partial; this does not count distinct future provider types.',
  'Type names do not establish severity, current structure or character state, ownership, payment, fuel, access, success or required action.',
  'The upstream response may contain private message text and sender fields. They are discarded after bounded JSON parsing, are not validated as aggregate inputs, and are never projected or retained. Notification IDs are used only for duplicate validation and are omitted from this result.',
  'Application limits are one thousand notifications and two MiB for each parsed source envelope and normalized result. Larger or malformed responses are rejected without silently truncating counts; the inherited upstream stream bound is separate.',
  'Cache freshness describes the received response, not live synchronization. No notifications are sent, marked read, deleted or organized, and no new permission or account lookup is performed.',
];

export function validateNotificationsAnalyticsArgs(input: unknown): NotificationsAnalyticsArgs {
  const fail = (): never => { throw new EveError('Choose one connected character for the notification overview.'); };
  if (!record(input)) return fail();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return fail();
  if (Reflect.ownKeys(input).some(key => key !== 'characterId' || !has(Object.getOwnPropertyDescriptor(input, key) ?? {}, 'value'))) return fail();
  for (const key in input) if (!has(input, key)) return fail();
  if (!has(input, 'characterId') || !integer(input.characterId)) return fail();
  return { characterId: input.characterId };
}
function timestamp(value: unknown): string | null { const normalized = overviewDate(value); return normalized?.length === 24 ? normalized : null; }
function headerDate(value: unknown): string | null {
  const normalized = timestamp(value); if (normalized) return normalized;
  if (typeof value !== 'string' || value.length > 100) return null;
  const at = Date.parse(value); if (!Number.isFinite(at) || new Date(at).toUTCString() !== value) return null;
  const result = new Date(at).toISOString(); return result.length === 24 ? result : null;
}
function bounded(value: unknown) {
  // Core streams at most 8 MiB; this separate limit applies after parsing, including discarded private fields.
  try { const text = JSON.stringify(value); if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > byteLimit) invalid(); }
  catch { invalid(); }
}
function blankFreshness(): NotificationsFreshness { return { state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null }; }
function blank(selected: NotificationsAnalyticsArgs, at: number, status: NotificationsStatus, message: string): NotificationsAnalytics {
  return { characterId: selected.characterId, generatedAt: new Date(at).toISOString(), status, message, scope, coverage: { kind: 'unavailable', notifications: null }, freshness: blankFreshness(), summary: null, daily: [], byType: [], cells: [], limitations: [...limitations] };
}
function envelope(value: unknown, args: { characterId: number; dataset: string }, at: number) {
  bounded(value);
  if (!record(value) || value.characterId !== args.characterId || value.dataset !== args.dataset || value.source !== 'https://esi.evetech.net' + buildCharacterRequest(args).path ||
      value.entity !== undefined && value.entity !== 'character' || value.corporationId != null || value.division != null || value.page != null) return invalid();
  const pagination = value.pagination;
  if (!record(pagination) || pagination.kind !== 'none' || ['page', 'pages', 'nextPage', 'pageLimit', 'pageLimitReached', 'morePagesAvailable', 'nextBeforeId', 'nextFromId', 'nextFromEvent', 'after', 'before'].some(key => pagination[key] != null)) return invalid();
  const retrievedAt = timestamp(value.retrievedAt); if (!retrievedAt || Date.parse(retrievedAt) > at + 60000) return invalid();
  const freshness: NotificationsFreshness = { state: 'unknown', retrievedAt, cacheExpires: timestamp(walletActivityExpiry(value, Date.parse(retrievedAt))), lastModified: headerDate(value.lastModified) };
  return { data: value.data, freshness };
}
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const compareType = (a: NotificationType | null, b: NotificationType | null) => a === b ? 0 : a === null ? 1 : b === null ? -1 : compareText(a, b);
function aggregate(data: unknown) {
  if (!Array.isArray(data) || data.length > 1000) return invalid();
  const ids = new Set<number>(), cells = new Map<string, NotificationCell>(), days = new Map<string, NotificationDaily>(), types = new Map<NotificationType | null, NotificationTypeCount>();
  let read = 0, unrecognized = 0;
  for (const raw of data) {
    if (!record(raw) || !has(raw, 'notification_id') || !integer(raw.notification_id) || ids.has(raw.notification_id) || !has(raw, 'timestamp') || !has(raw, 'type') || typeof raw.type !== 'string') return invalid();
    ids.add(raw.notification_id);
    const normalized = timestamp(raw.timestamp); if (!normalized) return invalid();
    if (has(raw, 'is_read') && typeof raw.is_read !== 'boolean') return invalid();
    const type = knownTypes.has(raw.type) ? raw.type as NotificationType : null;
    if (type === null && !/^[A-Za-z][A-Za-z0-9_ ]{0,127}$/.test(raw.type)) return invalid();
    const date = normalized.slice(0, 10), isRead = raw.is_read === true;
    if (isRead) read++; if (type === null) unrecognized++;
    const key = JSON.stringify([date, type, isRead]), cell = cells.get(key);
    if (cell) cell.notifications++; else cells.set(key, { date, type, isRead, notifications: 1 });
    const daily = days.get(date) ?? { date, notifications: 0, read: 0, unread: 0 };
    daily.notifications++; if (isRead) daily.read++; else daily.unread++; days.set(date, daily);
    const group = types.get(type) ?? { type, notifications: 0, read: 0, unread: 0 };
    group.notifications++; if (isRead) group.read++; else group.unread++; types.set(type, group);
  }
  const daily = [...days.values()].sort((a, b) => compareText(a.date, b.date));
  return {
    summary: { notifications: data.length, read, unread: data.length - read, unrecognizedTypeNotifications: unrecognized, reportedDates: daily.length, knownTypeGroups: types.size - (types.has(null) ? 1 : 0), firstDate: daily[0]?.date ?? null, lastDate: daily.at(-1)?.date ?? null },
    daily, byType: [...types.values()].sort((a, b) => compareType(a.type, b.type)),
    cells: [...cells.values()].sort((a, b) => compareText(a.date, b.date) || compareType(a.type, b.type) || Number(a.isRead) - Number(b.isRead)),
  };
}
async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let stop = () => {};
  const interrupted = new Promise<never>((_, reject) => { stop = () => reject(signal.reason); signal.addEventListener('abort', stop, { once: true }); }); void interrupted.catch(() => {});
  try { const value = await Promise.race([work(), interrupted]); signal.throwIfAborted(); return value; } finally { signal.removeEventListener('abort', stop); }
}

/** One existing owned notification GET, projected into aggregate observations without private messages or identities. */
export function createNotificationsAnalyticsReader(dependencies: Dependencies) {
  return async (user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<NotificationsAnalytics> => {
    const selected = validateNotificationsAnalyticsArgs(input), now = dependencies.now ?? Date.now;
    if (typeof user !== 'string' || !user) throw new EveError('Sign in to this private connector first.', 401);
    const deadline = now() + 55000, signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    const cancelled = () => blank(selected, now(), 'unavailable', 'The notification request was cancelled or reached its time limit. Load again when ready.');
    const budget = () => { signal.throwIfAborted(); if (now() >= deadline) throw new NotificationsDataError(); };
    let connection: { characterId: number; scopes: string[] } | undefined;
    try { budget(); connection = (await abortable(() => dependencies.connections(user), signal)).find(row => row.characterId === selected.characterId); budget(); }
    catch { return signal.aborted || now() >= deadline ? cancelled() : blank(selected, now(), 'unavailable', 'Connection status could not be checked. Reload Connections before trying again.'); }
    if (!connection) throw new EveError('Choose a character connected to this private connector.', 404);
    if (!connection.scopes.includes(scope)) return blank(selected, now(), 'needs_permission', 'This character has not granted the existing notifications read permission. No access is added automatically.');
    try {
      budget(); const args = { characterId: selected.characterId, dataset: 'notifications' };
      const raw = await abortable(() => dependencies.character(user, args, signal), signal); budget();
      const accepted = envelope(raw, args, now()), grouped = aggregate(accepted.data); budget();
      const at = now(), freshness = accepted.freshness;
      freshness.state = freshness.cacheExpires === null ? 'unknown' : Date.parse(freshness.cacheExpires) <= at ? 'stale' : 'fresh';
      const result: NotificationsAnalytics = { characterId: selected.characterId, generatedAt: new Date(at).toISOString(), scope,
        status: freshness.state === 'fresh' && grouped.summary.unrecognizedTypeNotifications === 0 ? 'ready' : 'partial',
        message: 'Date, type and read-state counts from one returned notification response; no complete-history or current-state claim.',
        coverage: { kind: 'returned_response', notifications: grouped.summary.notifications }, freshness, ...grouped, limitations: [...limitations] };
      bounded(result); budget(); return result;
    } catch (error) {
      if (signal.aborted || now() >= deadline) return cancelled();
      if (error instanceof EveError && [401, 409].includes(error.status)) return blank(selected, now(), 'unavailable', 'Notification authorization or identity changed during this request. No account evidence was retained; reload Connections before trying again.');
      const unavailable = error instanceof EveError && [403, 404, 429].includes(error.status);
      return blank(selected, now(), unavailable ? 'unavailable' : 'error', unavailable ? 'Notifications could not be read with the current authorization or provider availability. No empty response is assumed.' : 'Notification evidence could not be validated within the accepted format or limits. Missing evidence is unknown, not zero.');
    }
  };
}
export const getNotificationsAnalytics = createNotificationsAnalyticsReader({ connections: listConnections, character: readCharacterData });
