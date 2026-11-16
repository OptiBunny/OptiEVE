import { EveError } from './eve';
import { readCalendarAnalytics } from './calendar-analytics';
import type { CalendarAnalytics } from './calendar-analytics-types';

export type CharacterCalendarReport = Omit<CalendarAnalytics, 'events' | 'limitations'> & {
  events: { row: number; date: string | null; response: CalendarAnalytics['events'][number]['response']; importance: number | null }[];
  preview: { limit: 20; totalEvents: number | null; shownEvents: number | null; omittedEvents: number | null };
  limitations: string[];
};
/** Accepted batch summary; title text and individual event identities do not enter chat output. */
export function projectCharacterCalendarReport(value: CalendarAnalytics): CharacterCalendarReport {
  const result: CharacterCalendarReport = {
    characterId: value.characterId, generatedAt: value.generatedAt, status: value.status, message: value.message, scope: value.scope,
    coverage: { kind: value.coverage.kind, fromEvent: value.coverage.fromEvent, nextFromEvent: value.coverage.nextFromEvent, continuation: value.coverage.continuation, events: value.coverage.events },
    freshness: { state: value.freshness.state, retrievedAt: value.freshness.retrievedAt, cacheExpires: value.freshness.cacheExpires, lastModified: value.freshness.lastModified },
    summary: value.summary === null ? null : { events: value.summary.events, datedEvents: value.summary.datedEvents, missingEventIds: value.summary.missingEventIds, missingTitles: value.summary.missingTitles, emptyTitles: value.summary.emptyTitles, redactedTitles: value.summary.redactedTitles, missingImportance: value.summary.missingImportance },
    responseCounts: value.responseCounts.map(row => ({ response: row.response, events: row.events })),
    schedule: value.schedule === null ? null : { asOf: value.schedule.asOf, horizonDays: 30, pastOrNowEvents: value.schedule.pastOrNowEvents, next24hEvents: value.schedule.next24hEvents, days2To7Events: value.schedule.days2To7Events, days8To30Events: value.schedule.days8To30Events, laterEvents: value.schedule.laterEvents, missingDateEvents: value.schedule.missingDateEvents, daily: value.schedule.daily.map(row => ({ date: row.date, events: row.events })) },
    events: value.events.slice(0, 20).map(row => ({ row: row.row, date: row.date, response: row.response, importance: row.importance })),
    preview: { limit: 20, totalEvents: value.summary === null ? null : value.events.length, shownEvents: value.summary === null ? null : Math.min(value.events.length, 20), omittedEvents: value.summary === null ? null : Math.max(0, value.events.length - 20) },
    limitations: [
      'One returned summary batch, not complete calendar history or a guarantee of every upcoming event. Counts and schedule cover the full accepted batch; the first twenty provider-order rows form the preview, with explicit omissions.',
      'Titles and individual event IDs are omitted from preview rows. Selected and next event cursors remain private pagination context so a separately requested batch can continue; no event IDs or results are saved in application history.',
      'Dates and response states do not establish attendance, completion, duration, readiness or a numeric priority scale. Missing, stale, denied and unsafe-title evidence stays explicit. Independent batches are not an atomic calendar.',
      'Only the existing calendar-summary read is used. No event details, attendees, owner names, locations, background refresh, write access or event-response action is requested.',
    ],
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 256 * 1024) throw new EveError('The calendar briefing exceeds the safe response limit. No partial briefing was returned.', 502);
  return result;
}
export async function readCharacterCalendarReport(user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<CharacterCalendarReport> {
  options.signal?.throwIfAborted();
  const value = await readCalendarAnalytics(user, input, options); options.signal?.throwIfAborted();
  const result = projectCharacterCalendarReport(value); options.signal?.throwIfAborted(); return result;
}
