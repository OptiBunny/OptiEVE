import { EveError } from './eve';
import { getNotificationsAnalytics } from './notifications-analytics';
import type { NotificationsAnalytics, NotificationTypeCount } from './notifications-analytics-types';

const textOrder = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const typeOrder = (a: NotificationTypeCount, b: NotificationTypeCount) => b.notifications - a.notifications || (a.type === null ? b.type === null ? 0 : 1 : b.type === null ? -1 : textOrder(a.type, b.type));

/** Whitelist aggregate evidence only. No access to raw records or grouped cells. */
export function projectCharacterNotificationsReport(value: NotificationsAnalytics) {
  const accepted = value.summary !== null;
  const days = accepted ? [...value.daily].sort((a, b) => textOrder(a.date, b.date)) : [];
  const types = accepted ? [...value.byType].sort(typeOrder) : [];
  const s = value.summary;
  const report = {
    characterId: value.characterId, generatedAt: value.generatedAt, status: value.status, message: value.message, scope: value.scope,
    coverage: { kind: value.coverage.kind, notifications: value.coverage.notifications },
    freshness: { state: value.freshness.state, retrievedAt: value.freshness.retrievedAt, cacheExpires: value.freshness.cacheExpires, lastModified: value.freshness.lastModified },
    summary: s === null ? null : { notifications: s.notifications, read: s.read, unread: s.unread,
      unrecognizedTypeNotifications: s.unrecognizedTypeNotifications, reportedDates: s.reportedDates, knownTypeGroups: s.knownTypeGroups, firstDate: s.firstDate, lastDate: s.lastDate },
    daily: { limit: 30, total: accepted ? days.length : null, shown: accepted ? Math.min(days.length, 30) : null, omitted: accepted ? Math.max(0, days.length - 30) : null,
      rows: days.slice(-30).map(row => ({ date: row.date, notifications: row.notifications, read: row.read, unread: row.unread })) },
    types: { limit: 20, total: accepted ? types.length : null, shown: accepted ? Math.min(types.length, 20) : null, omitted: accepted ? Math.max(0, types.length - 20) : null,
      rows: types.slice(0, 20).map(row => ({ type: row.type, notifications: row.notifications, read: row.read, unread: row.unread })) },
    limitations: [
      'Counts cover one returned notifications response, not complete history, current alerts or game state. No page, cursor, retention interval or older-data request is inferred.',
      'Read and unread are the reported API flag; an omitted optional is_read means false under the provider contract. These counts do not establish human attention, urgency, delivery, risk or an obligation.',
      'Dates are observed UTC dates, including future reported dates. No gaps are filled. The latest thirty date groups and twenty largest type groups are shown with explicit omissions; full-response counts remain intact.',
      'Type previews rank by count, then exact public token in code-unit order with the unrecognized bucket last on ties. A null type withholds one or more safe future tokens; that bucket is not a count of distinct unknown provider types. Reviewed type spelling, including trailing spaces, is preserved.',
      'Notification IDs, exact per-message timestamps, sender data, text, raw records and date/type/read-state cells are omitted. Unused upstream fields are received by the bounded parser before being discarded; they are not interpreted or retained.',
      'This report performs one manual read with the existing saved scope. It does not mark notifications read, change EVE state, request extra grants, poll in the background or collect history.',
    ],
  };
  if (new TextEncoder().encode(JSON.stringify(report)).byteLength > 64 * 1024) throw new EveError('The notifications briefing exceeds the safe response limit. No partial briefing was returned.', 502);
  return report;
}
export type CharacterNotificationsReport = ReturnType<typeof projectCharacterNotificationsReport>;
export async function readCharacterNotificationsReport(user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<CharacterNotificationsReport> {
  options.signal?.throwIfAborted();
  const value = await getNotificationsAnalytics(user, input, options);
  options.signal?.throwIfAborted();
  const report = projectCharacterNotificationsReport(value);
  options.signal?.throwIfAborted();
  return report;
}
