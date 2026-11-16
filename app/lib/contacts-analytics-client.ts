import { z } from 'zod';
import { ConnectionResponseError } from './connection-client';
import type { ContactsAnalytics, ContactsAnalyticsArgs, ContactsFreshness } from './contacts-analytics-types';

const id = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), page = z.number().int().min(1).max(500), count = z.number().int().min(0).max(1000);
const date = z.string().length(24).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const text = z.string().max(2048), status = z.enum(['ready', 'partial', 'needs_permission', 'unavailable', 'error']);
const types = ['character', 'corporation', 'alliance', 'faction', 'other'] as const;
const freshness = z.strictObject({ state: z.enum(['fresh', 'stale', 'unknown']), retrievedAt: date.nullable(), cacheExpires: date.nullable(), lastModified: date.nullable() });
const safeName = z.string().max(256).refine(value => Array.from(value).length <= 128 && !/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value) && !Array.from(value).some(char => char.length === 1 && /[\ud800-\udfff]/.test(char)));
const schema = z.strictObject({
  characterId: id, selected: z.strictObject({ page, includeLabels: z.boolean() }), generatedAt: date, status, message: text, scope: z.literal('esi-characters.read_contacts.v1'),
  contacts: z.strictObject({ status, message: text, freshness,
    coverage: z.strictObject({ kind: z.enum(['returned_page', 'unavailable']), page, pages: id.nullable(), nextPage: page.nullable(), previousPage: page.nullable(), pageLimitReached: z.boolean(), contacts: count.nullable() }),
    data: z.strictObject({
      summary: z.strictObject({ contacts: count, negativeStanding: count, zeroStanding: count, positiveStanding: count, watched: count, notWatched: count, blocked: count, notBlocked: count, unknownBlocked: count, missingLabelAssignments: count, emptyLabelAssignments: count, otherTypes: count }),
      typeCounts: z.array(z.strictObject({ type: z.enum(types), contacts: count })).length(5),
      byLabel: z.array(z.strictObject({ labelId: id, contacts: count.min(1) })).max(1000),
      rows: z.array(z.strictObject({ row: count.min(1), contactId: id, type: z.enum(types), standing: z.number().finite().refine(value => !Object.is(value, -0)), blocked: z.boolean().nullable(), watched: z.boolean(), labelIds: z.array(id).max(64).nullable() })).max(1000),
    }).nullable(),
  }),
  labels: z.strictObject({ status: z.enum(['ready', 'partial', 'needs_permission', 'unavailable', 'error', 'not_requested']), message: text, freshness,
    coverage: z.strictObject({ kind: z.enum(['returned_response', 'not_requested', 'unavailable']), labels: count.nullable() }),
    data: z.strictObject({ summary: z.strictObject({ returnedLabels: count, emptyNames: count, redactedNames: count, truncatedNames: count }), rows: z.array(z.strictObject({ row: count.min(1), labelId: id, name: z.strictObject({ text: safeName.nullable(), state: z.enum(['reported', 'redacted']), truncated: z.boolean() }) })).max(1000) }).nullable(),
  }), limitations: z.array(text).max(20),
});
const invalid = () => new ConnectionResponseError('The contacts response could not be validated safely. Load it again.');
function selection(value: unknown): ContactsAnalyticsArgs {
  const fail = () => new ConnectionResponseError('Choose one connected character, a page from 1 to 500 and a valid label option.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) throw fail();
  for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || !['characterId', 'page', 'includeLabels'].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value')) throw fail();
  for (const key in value) if (!Object.hasOwn(value, key)) throw fail();
  const input = value as ContactsAnalyticsArgs;
  if (!Object.hasOwn(input, 'characterId') || !id.safeParse(input.characterId).success || Object.hasOwn(input, 'page') && !page.safeParse(input.page).success || Object.hasOwn(input, 'includeLabels') && typeof input.includeLabels !== 'boolean') throw fail();
  return { characterId: input.characterId, page: Object.hasOwn(input, 'page') ? input.page : 1, includeLabels: Object.hasOwn(input, 'includeLabels') ? input.includeLabels : false };
}
function validFreshness(value: ContactsFreshness, accepted: boolean, now: number) {
  return accepted ? value.retrievedAt !== null && Date.parse(value.retrievedAt) <= now + 60000 && value.state === (value.cacheExpires === null ? 'unknown' : Date.parse(value.cacheExpires) <= now ? 'stale' : 'fresh') : value.state === 'unknown' && value.retrievedAt === null && value.cacheExpires === null && value.lastModified === null;
}
export function contactsAnalyticsResponse(value: unknown, input: ContactsAnalyticsArgs): ContactsAnalytics {
  const selected = selection(input), parsed = schema.safeParse(value); if (!parsed.success) throw invalid();
  const result = parsed.data, c = result.contacts, l = result.labels, now = Date.parse(result.generatedAt);
  if (result.characterId !== selected.characterId || result.selected.page !== selected.page || result.selected.includeLabels !== selected.includeLabels || new TextEncoder().encode(JSON.stringify(result)).byteLength > 2 * 1024 * 1024) throw invalid();
  if (!validFreshness(c.freshness, c.data !== null, now) || !validFreshness(l.freshness, l.data !== null, now)) throw invalid();
  const coverage = c.coverage;
  if (coverage.page !== selected.page || coverage.previousPage !== (coverage.page > 1 ? coverage.page - 1 : null)) throw invalid();
  if (c.data === null) {
    if (['ready', 'partial'].includes(c.status) || coverage.kind !== 'unavailable' || coverage.pages !== null || coverage.nextPage !== null || coverage.contacts !== null || coverage.pageLimitReached !== (coverage.page === 500)) throw invalid();
  } else {
    const rows = c.data.rows, ids = new Set<number>(), groups = new Map<number, number>(), typeCounts = types.map(type => ({ type, contacts: 0 })); let memberships = 0;
    const summary = { contacts: rows.length, negativeStanding: 0, zeroStanding: 0, positiveStanding: 0, watched: 0, notWatched: 0, blocked: 0, notBlocked: 0, unknownBlocked: 0, missingLabelAssignments: 0, emptyLabelAssignments: 0, otherTypes: 0 };
    for (const [index, row] of rows.entries()) {
      if (row.row !== index + 1 || ids.has(row.contactId)) throw invalid(); ids.add(row.contactId);
      summary[row.standing < 0 ? 'negativeStanding' : row.standing > 0 ? 'positiveStanding' : 'zeroStanding']++;
      summary[row.watched ? 'watched' : 'notWatched']++; summary[row.blocked === null ? 'unknownBlocked' : row.blocked ? 'blocked' : 'notBlocked']++;
      typeCounts[types.indexOf(row.type)].contacts++; if (row.type === 'other') summary.otherTypes++;
      if (row.labelIds === null) summary.missingLabelAssignments++; else {
        if (!row.labelIds.length) summary.emptyLabelAssignments++;
        if (row.labelIds.some((value, at) => at > 0 && value <= row.labelIds![at - 1])) throw invalid();
        memberships += row.labelIds.length; if (memberships > 64000) throw invalid();
        for (const label of row.labelIds) groups.set(label, (groups.get(label) ?? 0) + 1);
      }
    }
    const byLabel = [...groups].sort(([a], [b]) => a - b).map(([labelId, contacts]) => ({ labelId, contacts }));
    if (groups.size > 1000 || Object.entries(summary).some(([key, total]) => c.data!.summary[key as keyof typeof summary] !== total) || JSON.stringify(typeCounts) !== JSON.stringify(c.data.typeCounts) || JSON.stringify(byLabel) !== JSON.stringify(c.data.byLabel)) throw invalid();
    if (coverage.kind !== 'returned_page' || coverage.contacts !== rows.length || coverage.pages !== null && coverage.pages < coverage.page || coverage.nextPage !== (coverage.pages !== null && coverage.pages > coverage.page && coverage.page < 500 ? coverage.page + 1 : null) || coverage.pageLimitReached !== (coverage.page === 500 && coverage.pages !== 500)) throw invalid();
    const ready = c.freshness.state === 'fresh' && coverage.page === 1 && coverage.pages === 1 && summary.otherTypes === 0 && summary.unknownBlocked === 0 && summary.missingLabelAssignments === 0;
    if (c.status !== (ready ? 'ready' : 'partial')) throw invalid();
  }
  if (!result.selected.includeLabels) {
    if (l.status !== 'not_requested' || l.coverage.kind !== 'not_requested' || l.coverage.labels !== null || l.data !== null) throw invalid();
  } else if (l.data === null) {
    if (['ready', 'partial', 'not_requested'].includes(l.status) || l.coverage.kind !== 'unavailable' || l.coverage.labels !== null) throw invalid();
  } else {
    const summary = { returnedLabels: l.data.rows.length, emptyNames: 0, redactedNames: 0, truncatedNames: 0 }, ids = new Set<number>();
    for (const [index, row] of l.data.rows.entries()) {
      if (row.row !== index + 1 || ids.has(row.labelId)) throw invalid(); ids.add(row.labelId);
      if (row.name.state === 'reported' ? row.name.text === null || row.name.truncated && Array.from(row.name.text).length !== 128 : row.name.text !== null || row.name.truncated) throw invalid();
      summary.emptyNames += row.name.text === '' ? 1 : 0; summary.redactedNames += row.name.state === 'redacted' ? 1 : 0; summary.truncatedNames += row.name.truncated ? 1 : 0;
    }
    if (Object.entries(summary).some(([key, total]) => l.data!.summary[key as keyof typeof summary] !== total) || l.coverage.kind !== 'returned_response' || l.coverage.labels !== summary.returnedLabels) throw invalid();
    if (l.status !== (l.freshness.state === 'fresh' && !summary.redactedNames && !summary.truncatedNames ? 'ready' : 'partial')) throw invalid();
  }
  const any = c.data !== null || l.data !== null;
  const expected = any ? c.status === 'ready' && (l.status === 'ready' || l.status === 'not_requested') ? 'ready' : 'partial' : c.status === 'needs_permission' && (l.status === 'needs_permission' || l.status === 'not_requested') ? 'needs_permission' : c.status === 'error' || l.status === 'error' ? 'error' : 'unavailable';
  if (result.status !== expected || (c.status === 'needs_permission' || l.status === 'needs_permission') && expected !== 'needs_permission') throw invalid();
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
export async function contactsAnalyticsRequest(args: ContactsAnalyticsArgs, signal?: AbortSignal): Promise<ContactsAnalytics> {
  const selected = selection(args), controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(abort, 60000); let response: Response | undefined;
  try {
    controller.signal.throwIfAborted(); response = await fetch('/api/eve/contacts-analytics', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selected), signal: controller.signal }); controller.signal.throwIfAborted();
    if (!response.ok) throw new ConnectionResponseError(response.status === 401 ? 'Sign in again to read contacts.' : response.status === 404 ? 'This character is no longer connected. Reload connection status.' : 'Contacts could not be loaded. Try again or review the connection.', response.status);
    if (!response.headers.get('content-type')?.includes('application/json')) throw invalid();
    const result = contactsAnalyticsResponse(await readBody(response, controller.signal), selected); controller.signal.throwIfAborted(); return result;
  } catch (error) {
    if (error instanceof ConnectionResponseError) throw error;
    throw new ConnectionResponseError(controller.signal.aborted ? 'The contacts request was cancelled or timed out.' : 'The contacts service could not be reached. Try again.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
}
