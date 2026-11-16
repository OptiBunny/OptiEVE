import { EveError, listConnections, readCharacterData } from './eve';
import { buildCharacterRequest } from './character-data';
import { overviewDate } from './overview-summary';
import { walletActivityExpiry } from './wallet-analytics';
import type { MailAnalytics, MailAnalyticsArgs, MailDaily, MailEvidenceStatus, MailFreshness, MailHeader, MailHeaderLabel, MailLabel, MailText } from './mail-analytics-types';

type Dependencies = {
  connections: (user: string) => Promise<{ characterId: number; scopes: string[] }[]>;
  character: (user: string, args: { characterId: number; dataset: string; parameters?: Record<string, unknown> }, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
};
const scope = 'esi-mail.read_mail.v1' as const, byteLimit = 2 * 1024 * 1024;
class MailDataError extends Error {}
const invalid = (): never => { throw new MailDataError(); };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, minimum = 1): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const has = (value: object, key: PropertyKey) => Object.hasOwn(value, key);
const limitations = [
  'One manually requested label-counter response and one batch of at most fifty mail headers. A short or empty batch does not establish complete mailbox history or absence of deleted mail. Older loads replace this batch; no background continuation is performed.',
  'Mailbox total unread and per-label unread counters are independent of the returned header batch. Labels overlap: never sum their counters or header-presence counts into distinct-mail totals. Independent caches are not one atomic mailbox snapshot.',
  'The existing optional-boolean contract means an omitted is_read field is false. Other missing IDs, timestamps, label assignments, subjects and unread counters remain unknown. Explicit empty arrays and zero counters remain distinct from missing evidence.',
  'A beforeId query includes only smaller mail IDs. Missing IDs disable continuation; invalid, duplicate or non-progressing IDs reject the header feed. Persistent per-message IDs are omitted, except the selected and next pagination cursors. Response-local rows apply only to this load.',
  'Known label assignments must match an explicit OR-label query. Missing assignments remain unknown. A label absent from the separate metadata response is not proof of deletion; no sender, recipient or label-name lookup is performed.',
  'Subjects and label names are bounded untrusted text, never instructions or HTML. Unsafe or over-limit text is redacted and long safe text is truncated. No message body, correspondent identity, description or raw extra field is projected or retained.',
  'Application limits are fifty headers, one thousand label records, one hundred twenty-eight assignments per header and one thousand distinct assigned labels. A two MiB envelope/projection bound can refuse smaller responses; no counts are silently truncated.',
  'No message is sent, marked read, organized or deleted. No label is created or changed, no extra grants are requested, and no account history or results are stored. Read flags and reported dates are observations, not proof of human attention, delivery or future events.',
];

export function validateMailAnalyticsArgs(input: unknown): MailAnalyticsArgs {
  const fail = (): never => { throw new EveError('Choose one connected character and an optional mail cursor or label query.'); };
  if (!record(input)) return fail();
  if (Reflect.ownKeys(input).some(key => !['characterId', 'beforeId', 'labels'].includes(String(key)) || typeof key !== 'string' || !has(Object.getOwnPropertyDescriptor(input, key) ?? {}, 'value'))) return fail();
  for (const key in input) if (!has(input, key)) return fail();
  if (!has(input, 'characterId') || !integer(input.characterId)) return fail();
  if (has(input, 'beforeId') && !integer(input.beforeId)) return fail();
  let labels: number[] | undefined;
  if (has(input, 'labels')) {
    if (!Array.isArray(input.labels) || input.labels.length < 1 || input.labels.length > 25 || Reflect.ownKeys(input.labels).length !== input.labels.length + 1) return fail();
    labels = [];
    for (let index = 0; index < input.labels.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(input.labels, String(index));
      if (!entry || !has(entry, 'value') || !integer(entry.value)) return fail(); labels.push(entry.value);
    }
    if (new Set(labels).size !== labels.length) return fail(); labels.sort((a, b) => a - b);
  }
  return { characterId: input.characterId, ...(has(input, 'beforeId') ? { beforeId: input.beforeId as number } : {}), ...(labels ? { labels } : {}) };
}
function timestamp(value: unknown): string | null { const date = overviewDate(value); return date?.length === 24 ? date : null; }
function headerDate(value: unknown): string | null {
  const normalized = timestamp(value); if (normalized) return normalized;
  if (typeof value !== 'string' || value.length > 100) return null;
  const time = Date.parse(value); if (!Number.isFinite(time) || new Date(time).toUTCString() !== value) return null;
  const date = new Date(time).toISOString(); return date.length === 24 ? date : null;
}
function bounded(value: unknown) {
  // This bounds the parsed envelope/projection, not the inherited 8 MiB core stream.
  try { const text = JSON.stringify(value); if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > byteLimit) invalid(); }
  catch { invalid(); }
}
function blankFreshness(): MailFreshness { return { state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null }; }
function blank(selected: MailAnalyticsArgs, at: number, status: MailEvidenceStatus, message: string): MailAnalytics {
  return { characterId: selected.characterId, selected: { beforeId: selected.beforeId ?? null, labels: selected.labels?.slice() ?? [] }, generatedAt: new Date(at).toISOString(), status, message, scope,
    headers: { status, message, freshness: blankFreshness(), coverage: { kind: 'unavailable', headers: null, nextBeforeId: null, continuation: 'unavailable' }, data: null },
    labels: { status, message, freshness: blankFreshness(), coverage: { kind: 'unavailable', labels: null }, data: null }, limitations: [...limitations] };
}
function optionalInteger(row: Record<string, unknown>, key: string, minimum = 1): number | null {
  if (!has(row, key)) return null; if (!integer(row[key], minimum)) return invalid(); return row[key];
}
function optionalTimestamp(row: Record<string, unknown>, key: string): string | null {
  if (!has(row, key)) return null; const parsed = timestamp(row[key]); return parsed ?? invalid();
}
function text(row: Record<string, unknown>, key: string, maximum: number): MailText {
  if (!has(row, key)) return { text: null, state: 'missing', truncated: false };
  const value = row[key]; if (typeof value !== 'string') return invalid();
  const redacted: MailText = { text: null, state: 'redacted', truncated: false };
  if (value.length > 16384 || /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value)) return redacted;
  let prefix = '', length = 0;
  for (const character of value) { if (character.length === 1 && /[\ud800-\udfff]/.test(character)) return redacted; if (length++ < maximum) prefix += character; }
  return { text: prefix, state: 'reported', truncated: length > maximum };
}
function envelope(value: unknown, args: { characterId: number; dataset: string; parameters?: Record<string, unknown> }, at: number) {
  bounded(value);
  if (!record(value) || value.characterId !== args.characterId || value.dataset !== args.dataset || value.source !== 'https://esi.evetech.net' + buildCharacterRequest(args).path ||
      value.entity !== undefined && value.entity !== 'character' || value.corporationId != null || value.division != null || value.page != null) return invalid();
  const pagination = value.pagination;
  if (!record(pagination) || pagination.kind !== (args.dataset === 'mail' ? 'mail' : 'none') ||
      ['page', 'pages', 'nextPage', 'nextFromId', 'nextFromEvent', 'after', 'before', 'pageLimit', 'pageLimitReached', 'morePagesAvailable'].some(key => pagination[key] != null) ||
      args.dataset !== 'mail' && pagination.nextBeforeId != null) return invalid();
  const retrievedAt = timestamp(value.retrievedAt); if (!retrievedAt || Date.parse(retrievedAt) > at + 60000) return invalid();
  const freshness: MailFreshness = { state: 'unknown', retrievedAt, cacheExpires: timestamp(walletActivityExpiry(value, Date.parse(retrievedAt))), lastModified: headerDate(value.lastModified) };
  return { data: value.data, freshness, nextBeforeId: pagination.nextBeforeId ?? null };
}
function labelSource(accepted: ReturnType<typeof envelope>): MailAnalytics['labels'] {
  if (!record(accepted.data)) return invalid();
  const totalUnread = optionalInteger(accepted.data, 'total_unread_count', 0), ids = new Set<number>();
  let rows: MailLabel[] | null = null;
  if (has(accepted.data, 'labels')) {
    if (!Array.isArray(accepted.data.labels) || accepted.data.labels.length > 1000) return invalid();
    rows = accepted.data.labels.map((raw, index) => {
      if (!record(raw)) return invalid(); const labelId = optionalInteger(raw, 'label_id');
      if (labelId !== null) { if (ids.has(labelId)) return invalid(); ids.add(labelId); }
      return { row: index + 1, labelId, name: text(raw, 'name', 128), unreadCount: optionalInteger(raw, 'unread_count', 0) };
    });
  }
  const summary = { returnedLabels: rows?.length ?? null, missingLabelIds: rows?.filter(row => row.labelId === null).length ?? null,
    missingUnreadCounts: rows?.filter(row => row.unreadCount === null).length ?? null, missingNames: rows?.filter(row => row.name.state === 'missing').length ?? null,
    emptyNames: rows?.filter(row => row.name.state === 'reported' && row.name.text === '').length ?? null, redactedNames: rows?.filter(row => row.name.state === 'redacted').length ?? null,
    truncatedNames: rows?.filter(row => row.name.truncated).length ?? null };
  return { status: 'partial', message: 'Reported mailbox and overlapping label unread counters. These are independent of the selected header batch.', freshness: accepted.freshness,
    coverage: { kind: 'returned_response', labels: rows?.length ?? null }, data: { totalUnread, summary, rows } };
}
function headerSource(accepted: ReturnType<typeof envelope>, selected: MailAnalyticsArgs): MailAnalytics['headers'] {
  if (!Array.isArray(accepted.data) || accepted.data.length > 50) return invalid();
  const ids = new Set<number>(), assigned = new Set<number>(); let assignments = 0;
  const rows: MailHeader[] = accepted.data.map((raw, index) => {
    if (!record(raw)) return invalid(); const id = optionalInteger(raw, 'mail_id');
    if (id !== null) { if (ids.has(id) || selected.beforeId !== undefined && id >= selected.beforeId) return invalid(); ids.add(id); }
    if (has(raw, 'is_read') && typeof raw.is_read !== 'boolean') return invalid();
    let labelIds: number[] | null = null;
    if (has(raw, 'labels')) {
      if (!Array.isArray(raw.labels) || raw.labels.length > 128 || !raw.labels.every(value => integer(value)) || new Set(raw.labels).size !== raw.labels.length) return invalid();
      labelIds = (raw.labels as number[]).slice().sort((a, b) => a - b); assignments += labelIds.length;
      for (const id of labelIds) assigned.add(id); if (assignments > 6400 || assigned.size > 1000) return invalid();
      if (selected.labels && !labelIds.some(id => selected.labels!.includes(id))) return invalid();
    }
    return { row: index + 1, mailIdReported: id !== null, timestamp: optionalTimestamp(raw, 'timestamp'), isRead: raw.is_read === true, labelIds, subject: text(raw, 'subject', 256) };
  });
  const minimum = ids.size ? Math.min(...ids) : null; if (accepted.nextBeforeId !== minimum) return invalid();
  const summary = { headers: rows.length, read: rows.filter(row => row.isRead).length, unread: rows.filter(row => !row.isRead).length, dated: rows.filter(row => row.timestamp !== null).length,
    missingMailIds: rows.filter(row => !row.mailIdReported).length, missingTimestamps: rows.filter(row => row.timestamp === null).length,
    missingLabelAssignments: rows.filter(row => row.labelIds === null).length, emptyLabelAssignments: rows.filter(row => row.labelIds?.length === 0).length,
    missingSubjects: rows.filter(row => row.subject.state === 'missing').length, emptySubjects: rows.filter(row => row.subject.state === 'reported' && row.subject.text === '').length,
    redactedSubjects: rows.filter(row => row.subject.state === 'redacted').length, truncatedSubjects: rows.filter(row => row.subject.truncated).length };
  const days = new Map<string, MailDaily>(), labels = new Map<number, MailHeaderLabel>();
  for (const row of rows) {
    if (row.timestamp !== null) { const date = row.timestamp.slice(0, 10), item = days.get(date) ?? { date, headers: 0, read: 0, unread: 0 }; item.headers++; item[row.isRead ? 'read' : 'unread']++; days.set(date, item); }
    for (const labelId of row.labelIds ?? []) { const item = labels.get(labelId) ?? { labelId, headers: 0, read: 0, unread: 0 }; item.headers++; item[row.isRead ? 'read' : 'unread']++; labels.set(labelId, item); }
  }
  return { status: 'partial', message: 'One returned header batch. Read flags, reported dates and overlapping label memberships describe this batch only.', freshness: accepted.freshness,
    coverage: { kind: 'returned_batch', headers: rows.length, nextBeforeId: summary.missingMailIds ? null : minimum, continuation: !rows.length ? 'empty' : summary.missingMailIds ? 'missing_mail_ids' : 'available' },
    data: { summary, daily: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), byLabel: [...labels.values()].sort((a, b) => a.labelId - b.labelId), rows } };
}
function finish(result: MailAnalytics, at: number): MailAnalytics {
  result.generatedAt = new Date(at).toISOString();
  for (const source of [result.labels, result.headers]) if (source.data !== null) source.freshness.state = source.freshness.cacheExpires === null ? 'unknown' : Date.parse(source.freshness.cacheExpires) <= at ? 'stale' : 'fresh';
  if (result.labels.data !== null) {
    const { summary } = result.labels.data;
    result.labels.status = result.labels.freshness.state === 'fresh' && result.labels.data.totalUnread !== null && result.labels.data.rows !== null &&
      ['missingLabelIds', 'missingUnreadCounts', 'missingNames', 'redactedNames', 'truncatedNames'].every(key => summary[key as keyof typeof summary] === 0) ? 'ready' : 'partial';
  }
  if (result.headers.data !== null) {
    const { summary } = result.headers.data;
    result.headers.status = result.headers.freshness.state === 'fresh' && ['missingMailIds', 'missingTimestamps', 'missingLabelAssignments', 'missingSubjects', 'redactedSubjects', 'truncatedSubjects'].every(key => summary[key as keyof typeof summary] === 0) ? 'ready' : 'partial';
  }
  result.status = result.headers.status === 'ready' && result.labels.status === 'ready' ? 'ready' : result.headers.data !== null || result.labels.data !== null ? 'partial' : result.headers.status === 'error' || result.labels.status === 'error' ? 'error' : 'unavailable';
  bounded(result); return result;
}
async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let stop = () => {};
  const interrupted = new Promise<never>((_, reject) => { stop = () => reject(signal.reason); signal.addEventListener('abort', stop, { once: true }); }); void interrupted.catch(() => {});
  try { const value = await Promise.race([work(), interrupted]); signal.throwIfAborted(); return value; } finally { signal.removeEventListener('abort', stop); }
}

/** Two fixed owned GETs under one existing read grant. No body, correspondent lookup, write or retained result. */
export function createMailAnalyticsReader(dependencies: Dependencies) {
  return async (user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<MailAnalytics> => {
    const selected = validateMailAnalyticsArgs(input), now = dependencies.now ?? Date.now;
    if (typeof user !== 'string' || !user) throw new EveError('Sign in to this private connector first.', 401);
    const deadline = now() + 55000, signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    const cancelled = () => blank(selected, now(), 'unavailable', 'The mail request was cancelled or reached its time limit. Load again when ready.');
    const budget = () => { signal.throwIfAborted(); if (now() >= deadline) throw new MailDataError(); };
    let connection: { characterId: number; scopes: string[] } | undefined;
    try { budget(); connection = (await abortable(() => dependencies.connections(user), signal)).find(row => row.characterId === selected.characterId); budget(); }
    catch { return signal.aborted || now() >= deadline ? cancelled() : blank(selected, now(), 'unavailable', 'Connection status could not be checked. Reload Connections before trying again.'); }
    if (!connection) throw new EveError('Choose a character connected to this private connector.', 404);
    if (!connection.scopes.includes(scope)) return blank(selected, now(), 'needs_permission', 'This character has not granted the existing mail read permission. No access is added automatically.');
    const result = blank(selected, now(), 'unavailable', 'Mail label counters and one header batch are independent returned observations, not a complete or synchronized mailbox.');
    for (const dataset of ['mail_labels', 'mail'] as const) {
      const key = dataset === 'mail_labels' ? 'labels' : 'headers';
      const parameters = { ...(selected.beforeId === undefined ? {} : { beforeId: selected.beforeId }), ...(selected.labels ? { labels: selected.labels.slice() } : {}) };
      const args = { characterId: selected.characterId, dataset, ...(dataset === 'mail' && Object.keys(parameters).length ? { parameters } : {}) };
      try {
        budget(); const raw = await abortable(() => dependencies.character(user, args, signal), signal); budget();
        const accepted = envelope(raw, args, now());
        if (dataset === 'mail_labels') result.labels = labelSource(accepted); else result.headers = headerSource(accepted, selected);
        budget();
      } catch (error) {
        if (signal.aborted || now() >= deadline) return cancelled();
        if (error instanceof EveError && [401, 409].includes(error.status)) return blank(selected, now(), 'unavailable', 'Mail authorization or identity changed during this request. No account evidence was retained; reload Connections before trying again.');
        const unavailable = error instanceof EveError && [403, 404, 429].includes(error.status);
        result[key].status = unavailable ? 'unavailable' : 'error'; result[key].message = unavailable ? 'This mail source could not be read with the current authorization or provider availability. No empty result is assumed.' : 'This mail source could not be validated within the accepted format and limits. Missing evidence is unknown, not zero.';
        if (error instanceof EveError && error.status === 429) { if (dataset === 'mail_labels') result.headers.message = 'A provider rate limit stopped the remaining mail read. No header count is assumed.'; break; }
      }
    }
    try { budget(); const completed = finish(result, now()); budget(); return completed; }
    catch { return signal.aborted || now() >= deadline ? cancelled() : blank(selected, now(), 'error', 'Mail evidence exceeded the accepted response format or limits. No partial projection was returned.'); }
  };
}
export const getMailAnalytics = createMailAnalyticsReader({ connections: listConnections, character: readCharacterData });
