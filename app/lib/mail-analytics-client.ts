import { z } from 'zod';
import { ConnectionResponseError } from './connection-client';
import type { MailAnalytics, MailAnalyticsArgs, MailFreshness, MailText } from './mail-analytics-types';

const id = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().length(24).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const date = z.string().length(10).regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value + 'T00:00:00.000Z')) && new Date(value + 'T00:00:00.000Z').toISOString().slice(0, 10) === value);
const safeText = (points: number) => z.string().max(points * 2).refine(value => Array.from(value).length <= points && !/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value) && !Array.from(value).some(character => character.length === 1 && /[\ud800-\udfff]/.test(character)));
const display = (points: number) => z.strictObject({ text: safeText(points).nullable(), state: z.enum(['missing', 'reported', 'redacted']), truncated: z.boolean() });
const text = z.string().max(2048), status = z.enum(['ready', 'partial', 'needs_permission', 'unavailable', 'error']);
const freshness = z.strictObject({ state: z.enum(['fresh', 'stale', 'unknown']), retrievedAt: timestamp.nullable(), cacheExpires: timestamp.nullable(), lastModified: timestamp.nullable() });
const headerCount = z.number().int().min(0).max(50), labelCount = z.number().int().min(0).max(1000);
const schema = z.strictObject({
  characterId: id, selected: z.strictObject({ beforeId: id.nullable(), labels: z.array(id).max(25) }), generatedAt: timestamp, status, message: text, scope: z.literal('esi-mail.read_mail.v1'),
  headers: z.strictObject({ status, message: text, freshness,
    coverage: z.strictObject({ kind: z.enum(['returned_batch', 'unavailable']), headers: headerCount.nullable(), nextBeforeId: id.nullable(), continuation: z.enum(['available', 'empty', 'missing_mail_ids', 'unavailable']) }),
    data: z.strictObject({
      summary: z.strictObject({ headers: headerCount, read: headerCount, unread: headerCount, dated: headerCount, missingMailIds: headerCount, missingTimestamps: headerCount, missingLabelAssignments: headerCount, emptyLabelAssignments: headerCount, missingSubjects: headerCount, emptySubjects: headerCount, redactedSubjects: headerCount, truncatedSubjects: headerCount }),
      daily: z.array(z.strictObject({ date, headers: headerCount, read: headerCount, unread: headerCount })).max(50),
      byLabel: z.array(z.strictObject({ labelId: id, headers: headerCount, read: headerCount, unread: headerCount })).max(1000),
      rows: z.array(z.strictObject({ row: z.number().int().min(1).max(50), mailIdReported: z.boolean(), timestamp: timestamp.nullable(), isRead: z.boolean(), labelIds: z.array(id).max(128).nullable(), subject: display(256) })).max(50),
    }).nullable(),
  }),
  labels: z.strictObject({ status, message: text, freshness,
    coverage: z.strictObject({ kind: z.enum(['returned_response', 'unavailable']), labels: labelCount.nullable() }),
    data: z.strictObject({ totalUnread: count.nullable(), summary: z.strictObject({ returnedLabels: labelCount.nullable(), missingLabelIds: labelCount.nullable(), missingUnreadCounts: labelCount.nullable(), missingNames: labelCount.nullable(), emptyNames: labelCount.nullable(), redactedNames: labelCount.nullable(), truncatedNames: labelCount.nullable() }), rows: z.array(z.strictObject({ row: z.number().int().min(1).max(1000), labelId: id.nullable(), name: display(128), unreadCount: count.nullable() })).max(1000).nullable() }).nullable(),
  }),
  limitations: z.array(text).max(20),
});
const invalid = () => new ConnectionResponseError('The mail response could not be validated safely. Load it again.');
const sortedIds = (values: number[]) => values.every((value, index) => !index || value > values[index - 1]);
function selection(value: unknown): MailAnalyticsArgs {
  const fail = () => new ConnectionResponseError('Choose one connected character and a valid mail query.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail();
  for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || !['characterId', 'beforeId', 'labels'].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value')) throw fail();
  for (const key in value) if (!Object.hasOwn(value, key)) throw fail();
  const input = value as MailAnalyticsArgs;
  if (!Object.hasOwn(input, 'characterId') || !id.safeParse(input.characterId).success || Object.hasOwn(input, 'beforeId') && !id.safeParse(input.beforeId).success) throw fail();
  const out: MailAnalyticsArgs = { characterId: input.characterId };
  if (Object.hasOwn(input, 'beforeId')) out.beforeId = input.beforeId;
  if (Object.hasOwn(input, 'labels')) {
    const values = input.labels;
    if (!Array.isArray(values) || !values.length || values.length > 25 || Reflect.ownKeys(values).length !== values.length + 1 || Reflect.ownKeys(values).some(key => typeof key !== 'string' || key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) throw fail();
    const labels: number[] = [];
    for (let index = 0; index < values.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !id.safeParse(descriptor.value).success) throw fail();
      labels.push(descriptor.value);
    }
    labels.sort((a, b) => a - b); if (!sortedIds(labels)) throw fail(); out.labels = labels;
  }
  return out;
}
function validText(value: MailText, points: number) { return value.state === 'reported' ? value.text !== null && (!value.truncated || Array.from(value.text).length === points) : value.text === null && !value.truncated; }
function validFreshness(value: MailFreshness, accepted: boolean, now: number) {
  return accepted ? value.retrievedAt !== null && Date.parse(value.retrievedAt) <= now + 60000 && value.state === (value.cacheExpires === null ? 'unknown' : Date.parse(value.cacheExpires) <= now ? 'stale' : 'fresh') : value.state === 'unknown' && value.retrievedAt === null && value.cacheExpires === null && value.lastModified === null;
}
export function mailAnalyticsResponse(value: unknown, input: MailAnalyticsArgs): MailAnalytics {
  const selected = selection(input), parsed = schema.safeParse(value); if (!parsed.success) throw invalid();
  const result = parsed.data, h = result.headers, l = result.labels, now = Date.parse(result.generatedAt);
  if (result.characterId !== selected.characterId || result.selected.beforeId !== (selected.beforeId ?? null) || JSON.stringify(result.selected.labels) !== JSON.stringify(selected.labels ?? []) || new TextEncoder().encode(JSON.stringify(result)).byteLength > 2 * 1024 * 1024) throw invalid();
  if (!validFreshness(h.freshness, h.data !== null, now) || !validFreshness(l.freshness, l.data !== null, now)) throw invalid();
  if (h.data === null) {
    if (['ready', 'partial'].includes(h.status) || h.coverage.kind !== 'unavailable' || h.coverage.headers !== null || h.coverage.nextBeforeId !== null || h.coverage.continuation !== 'unavailable') throw invalid();
  } else {
    const rows = h.data.rows, summary = { headers: rows.length, read: 0, unread: 0, dated: 0, missingMailIds: 0, missingTimestamps: 0, missingLabelAssignments: 0, emptyLabelAssignments: 0, missingSubjects: 0, emptySubjects: 0, redactedSubjects: 0, truncatedSubjects: 0 }, days = new Map<string, { headers: number; read: number; unread: number }>(), labels = new Map<number, { headers: number; read: number; unread: number }>();
    let memberships = 0;
    const increment = (counts: { headers: number; read: number; unread: number }, read: boolean) => { counts.headers++; counts[read ? 'read' : 'unread']++; };
    for (const [index, row] of rows.entries()) {
      if (row.row !== index + 1 || !validText(row.subject, 256) || row.labelIds !== null && !sortedIds(row.labelIds)) throw invalid();
      summary[row.isRead ? 'read' : 'unread']++; summary.missingMailIds += row.mailIdReported ? 0 : 1;
      if (row.timestamp === null) summary.missingTimestamps++; else { summary.dated++; const day = row.timestamp.slice(0, 10), counts = days.get(day) ?? { headers: 0, read: 0, unread: 0 }; increment(counts, row.isRead); days.set(day, counts); }
      if (row.labelIds === null) summary.missingLabelAssignments++; else {
        if (!row.labelIds.length) summary.emptyLabelAssignments++;
        if (result.selected.labels.length && !row.labelIds.some(label => result.selected.labels.includes(label))) throw invalid();
        memberships += row.labelIds.length; if (memberships > 6400) throw invalid();
        for (const label of row.labelIds) { const counts = labels.get(label) ?? { headers: 0, read: 0, unread: 0 }; increment(counts, row.isRead); labels.set(label, counts); }
      }
      summary.missingSubjects += row.subject.state === 'missing' ? 1 : 0; summary.emptySubjects += row.subject.text === '' ? 1 : 0; summary.redactedSubjects += row.subject.state === 'redacted' ? 1 : 0; summary.truncatedSubjects += row.subject.truncated ? 1 : 0;
    }
    const daily = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, counts]) => ({ date, ...counts })), byLabel = [...labels].sort(([a], [b]) => a - b).map(([labelId, counts]) => ({ labelId, ...counts }));
    if (labels.size > 1000 || Object.entries(summary).some(([key, total]) => h.data!.summary[key as keyof typeof summary] !== total) || JSON.stringify(h.data.daily) !== JSON.stringify(daily) || JSON.stringify(h.data.byLabel) !== JSON.stringify(byLabel) || h.coverage.kind !== 'returned_batch' || h.coverage.headers !== rows.length) throw invalid();
    const continuation = rows.length === 0 ? 'empty' : summary.missingMailIds ? 'missing_mail_ids' : 'available';
    if (h.coverage.continuation !== continuation || (continuation === 'available' ? h.coverage.nextBeforeId === null || selected.beforeId !== undefined && h.coverage.nextBeforeId >= selected.beforeId : h.coverage.nextBeforeId !== null)) throw invalid();
    const ready = h.freshness.state === 'fresh' && !summary.missingMailIds && !summary.missingTimestamps && !summary.missingLabelAssignments && !summary.missingSubjects && !summary.redactedSubjects && !summary.truncatedSubjects;
    if (h.status !== (ready ? 'ready' : 'partial')) throw invalid();
  }
  if (l.data === null) {
    if (['ready', 'partial'].includes(l.status) || l.coverage.kind !== 'unavailable' || l.coverage.labels !== null) throw invalid();
  } else {
    const rows = l.data.rows, summary = { returnedLabels: rows?.length ?? null, missingLabelIds: rows === null ? null : 0, missingUnreadCounts: rows === null ? null : 0, missingNames: rows === null ? null : 0, emptyNames: rows === null ? null : 0, redactedNames: rows === null ? null : 0, truncatedNames: rows === null ? null : 0 }, ids = new Set<number>();
    for (const [index, row] of (rows ?? []).entries()) {
      if (row.row !== index + 1 || !validText(row.name, 128) || row.labelId !== null && ids.has(row.labelId)) throw invalid();
      if (row.labelId === null) summary.missingLabelIds!++; else ids.add(row.labelId);
      summary.missingUnreadCounts! += row.unreadCount === null ? 1 : 0; summary.missingNames! += row.name.state === 'missing' ? 1 : 0; summary.emptyNames! += row.name.text === '' ? 1 : 0; summary.redactedNames! += row.name.state === 'redacted' ? 1 : 0; summary.truncatedNames! += row.name.truncated ? 1 : 0;
    }
    if (Object.entries(summary).some(([key, total]) => l.data!.summary[key as keyof typeof summary] !== total) || l.coverage.kind !== 'returned_response' || l.coverage.labels !== (rows?.length ?? null)) throw invalid();
    const ready = l.freshness.state === 'fresh' && l.data.totalUnread !== null && rows !== null && !summary.missingLabelIds && !summary.missingUnreadCounts && !summary.missingNames && !summary.redactedNames && !summary.truncatedNames;
    if (l.status !== (ready ? 'ready' : 'partial')) throw invalid();
  }
  const any = h.data !== null || l.data !== null;
  const expectedStatus = any ? h.status === 'ready' && l.status === 'ready' ? 'ready' : 'partial' : h.status === 'needs_permission' && l.status === 'needs_permission' ? 'needs_permission' : h.status === 'error' || l.status === 'error' ? 'error' : 'unavailable';
  if (result.status !== expectedStatus || (h.status === 'needs_permission' || l.status === 'needs_permission') && expectedStatus !== 'needs_permission') throw invalid();
  return result;
}

async function readBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw invalid();
  const limit = 2 * 1024 * 1024, reader = response.body.getReader(); let buffer = new Uint8Array(16384), length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) { abort(); return; }
        reader.read().then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
      });
      signal.throwIfAborted(); if (part.done) break;
      if (!(part.value instanceof Uint8Array) || part.value.byteLength > limit - length) throw invalid();
      if (length + part.value.byteLength > buffer.length) { const next = new Uint8Array(Math.min(limit, Math.max(buffer.length * 2, length + part.value.byteLength))); next.set(buffer.subarray(0, length)); buffer = next; }
      buffer.set(part.value, length); length += part.value.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))); signal.throwIfAborted(); return value;
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function mailAnalyticsRequest(args: MailAnalyticsArgs, signal?: AbortSignal): Promise<MailAnalytics> {
  const selected = selection(args), controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(abort, 60000); let response: Response | undefined;
  try {
    controller.signal.throwIfAborted(); response = await fetch('/api/eve/mail-analytics', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selected), signal: controller.signal }); controller.signal.throwIfAborted();
    if (!response.ok) throw new ConnectionResponseError(response.status === 401 ? 'Sign in again to read mail headers.' : response.status === 404 ? 'This character is no longer connected. Reload connection status.' : 'Mail headers could not be loaded. Try again or review the connection.', response.status);
    if (!response.headers.get('content-type')?.includes('application/json')) throw invalid();
    const result = mailAnalyticsResponse(await readBody(response, controller.signal), selected); controller.signal.throwIfAborted(); return result;
  } catch (error) {
    if (error instanceof ConnectionResponseError) throw error;
    throw new ConnectionResponseError(controller.signal.aborted ? 'The mail request was cancelled or timed out.' : 'The mail service could not be reached. Try again.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
}
