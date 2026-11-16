export type CalendarAnalyticsArgs = { characterId: number; fromEvent?: number };
export type CalendarEventResponse = 'accepted' | 'declined' | 'tentative' | 'not_responded';
export type CalendarEvent = {
  /** Response-local row number, not a persistent event identity. */
  row: number;
  eventId: number | null;
  date: string | null;
  response: CalendarEventResponse | null;
  importance: number | null;
  title: string | null;
  titleState: 'missing' | 'reported' | 'redacted';
  titleTruncated: boolean;
};
export type CalendarSchedule = {
  asOf: string;
  horizonDays: 30;
  pastOrNowEvents: number;
  next24hEvents: number;
  days2To7Events: number;
  days8To30Events: number;
  laterEvents: number;
  missingDateEvents: number;
  daily: { date: string; events: number }[];
};
export type CalendarAnalytics = {
  characterId: number;
  generatedAt: string;
  status: 'ready' | 'partial' | 'needs_permission' | 'unavailable' | 'error';
  message: string;
  scope: 'esi-calendar.read_calendar_events.v1';
  coverage: {
    kind: 'returned_batch' | 'unavailable';
    fromEvent: number | null;
    nextFromEvent: number | null;
    continuation: 'available' | 'empty' | 'missing_last_id' | 'unchanged_cursor' | 'unavailable';
    events: number;
  };
  freshness: { state: 'fresh' | 'stale' | 'unknown'; retrievedAt: string | null; cacheExpires: string | null; lastModified: string | null };
  summary: {
    events: number;
    datedEvents: number;
    missingEventIds: number;
    missingTitles: number;
    emptyTitles: number;
    redactedTitles: number;
    missingImportance: number;
  } | null;
  responseCounts: { response: CalendarEventResponse | null; events: number }[];
  schedule: CalendarSchedule | null;
  events: CalendarEvent[];
  limitations: string[];
};
