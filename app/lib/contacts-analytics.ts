import { EveError, listConnections, readCharacterData } from './eve';
import { buildCharacterRequest } from './character-data';
import { overviewDate } from './overview-summary';
import { walletActivityExpiry } from './wallet-analytics';
import type { Contact, ContactLabel, ContactType, ContactsAnalytics, ContactsAnalyticsArgs, ContactsEvidenceStatus, ContactsFreshness } from './contacts-analytics-types';

type Dependencies = {
  connections: (user: string) => Promise<{ characterId: number; scopes: string[] }[]>;
  character: (user: string, args: { characterId: number; dataset: string; parameters?: Record<string, unknown> }, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
};
const scope = 'esi-characters.read_contacts.v1' as const, byteLimit = 2 * 1024 * 1024;
const types: ContactType[] = ['character', 'corporation', 'alliance', 'faction', 'other'];
class ContactsDataError extends Error {}
const invalid = (): never => { throw new ContactsDataError(); };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const has = (value: object, key: PropertyKey) => Object.hasOwn(value, key);
const limitations = [
  'One manually selected contacts page, with a separate label response only when explicitly requested. Loads replace this result; no background requests, automatic paging or cross-page accumulation are performed.',
  'Contact settings are separate from NPC standings. Received finite standing values are retained without clipping or arithmetic; sign counts do not establish friendliness, safety, effective standings, docking rights, taxes or online activity.',
  'An omitted blocked flag is unknown. The existing optional-boolean contract means an omitted watched flag is false. Missing label assignments remain unknown; an explicit empty array means no assignments in this response.',
  'Label presence groups overlap and count only reported assignments. Their sum is not a distinct-contact total. Optional label metadata and the selected contacts page are independently cached observations, not an atomic or complete relationship snapshot.',
  'Only a known one-page response requested at page one has complete coverage for that received response. Missing page counts, other pages and the application page limit remain partial; a short or empty page does not prove full-list completeness or deletion.',
  'Safe unrecognized contact types remain separate rows classified as other and make the evidence partial. No public-name, contact-detail or CSPA lookup is performed.',
  'Label names are bounded untrusted text, never instructions or HTML. Unsafe or oversized text is redacted; long safe text is truncated. No raw extra field is projected or retained.',
  'Application limits are one thousand contacts, one thousand label records, sixty-four assignments per contact and one thousand distinct assigned labels. Two MiB parsed-envelope and combined-projection limits may refuse otherwise row-bounded responses; no counts are silently truncated.',
  'No contact or label is created, updated or deleted, no notifications are sent, no new permission is requested, and no account history or result is stored.',
];

export function validateContactsAnalyticsArgs(input: unknown): ContactsAnalyticsArgs {
  const fail = (): never => { throw new EveError('Choose one connected character, a contacts page and whether to include label metadata.'); };
  if (!record(input)) return fail();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return fail();
  if (Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['characterId', 'page', 'includeLabels'].includes(key) || !has(Object.getOwnPropertyDescriptor(input, key) ?? {}, 'value'))) return fail();
  for (const key in input) if (!has(input, key)) return fail();
  if (!has(input, 'characterId') || !integer(input.characterId)) return fail();
  if (has(input, 'page') && (!integer(input.page) || input.page > 500)) return fail();
  if (has(input, 'includeLabels') && typeof input.includeLabels !== 'boolean') return fail();
  return { characterId: input.characterId, page: has(input, 'page') ? input.page as number : 1, includeLabels: has(input, 'includeLabels') ? input.includeLabels as boolean : false };
}
function timestamp(value: unknown): string | null { const normalized = overviewDate(value); return normalized?.length === 24 ? normalized : null; }
function headerDate(value: unknown): string | null {
  const normalized = timestamp(value); if (normalized) return normalized;
  if (typeof value !== 'string' || value.length > 100) return null;
  const at = Date.parse(value); if (!Number.isFinite(at) || new Date(at).toUTCString() !== value) return null;
  const result = new Date(at).toISOString(); return result.length === 24 ? result : null;
}
function bounded(value: unknown) {
  // The core already streams at most 8 MiB. This separately bounds parsed envelopes and the projected response.
  try { const text = JSON.stringify(value); if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > byteLimit) invalid(); }
  catch { invalid(); }
}
function blankFreshness(): ContactsFreshness { return { state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null }; }
function blank(selected: ContactsAnalyticsArgs, at: number, status: ContactsEvidenceStatus, message: string): ContactsAnalytics {
  const page = selected.page ?? 1, includeLabels = selected.includeLabels === true;
  return { characterId: selected.characterId, selected: { page, includeLabels }, generatedAt: new Date(at).toISOString(), status, message, scope,
    contacts: { status, message, freshness: blankFreshness(), coverage: { kind: 'unavailable', page, pages: null, nextPage: null, previousPage: page > 1 ? page - 1 : null, pageLimitReached: page === 500, contacts: null }, data: null },
    labels: { status: includeLabels ? status : 'not_requested', message: includeLabels ? message : 'Label metadata was not requested. Reported contact memberships remain separate evidence.', freshness: blankFreshness(), coverage: { kind: includeLabels ? 'unavailable' : 'not_requested', labels: null }, data: null }, limitations: [...limitations] };
}
function labelName(value: unknown): ContactLabel['name'] {
  if (typeof value !== 'string') return invalid();
  const redacted: ContactLabel['name'] = { text: null, state: 'redacted', truncated: false };
  if (value.length > 16384 || /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value)) return redacted;
  let prefix = '', length = 0;
  for (const character of value) { if (character.length === 1 && /[\ud800-\udfff]/.test(character)) return redacted; if (length++ < 128) prefix += character; }
  return { text: prefix, state: 'reported', truncated: length > 128 };
}
function envelope(value: unknown, args: { characterId: number; dataset: string; parameters?: Record<string, unknown> }, at: number) {
  bounded(value);
  if (!record(value) || value.characterId !== args.characterId || value.dataset !== args.dataset || value.source !== 'https://esi.evetech.net' + buildCharacterRequest(args).path ||
      value.entity !== undefined && value.entity !== 'character' || value.corporationId != null || value.division != null || value.page != null) return invalid();
  const pagination = value.pagination, paged = args.dataset === 'contacts';
  if (!record(pagination) || pagination.kind !== (paged ? 'page' : 'none') || ['nextBeforeId', 'nextFromId', 'nextFromEvent', 'after', 'before'].some(key => pagination[key] != null)) return invalid();
  const page = paged ? args.parameters?.page as number : 1;
  let pages: number | null = null;
  if (paged) {
    if (pagination.page !== page || pagination.pages !== null && (!integer(pagination.pages) || pagination.pages < page)) return invalid();
    pages = pagination.pages as number | null;
    const more = pages === null ? null : pages > page;
    if (pagination.pageLimit !== 500 || pagination.morePagesAvailable !== more || pagination.pageLimitReached !== (page === 500 && more !== false) || pagination.nextPage !== (more === true && page < 500 ? page + 1 : null)) return invalid();
  } else if (['page', 'pages', 'nextPage', 'pageLimit', 'pageLimitReached', 'morePagesAvailable'].some(key => pagination[key] != null)) return invalid();
  const retrievedAt = timestamp(value.retrievedAt); if (!retrievedAt || Date.parse(retrievedAt) > at + 60000) return invalid();
  const freshness: ContactsFreshness = { state: 'unknown', retrievedAt, cacheExpires: timestamp(walletActivityExpiry(value, Date.parse(retrievedAt))), lastModified: headerDate(value.lastModified) };
  return { data: value.data, freshness, page, pages };
}
function contactsSource(accepted: ReturnType<typeof envelope>): ContactsAnalytics['contacts'] {
  if (!Array.isArray(accepted.data) || accepted.data.length > 1000) return invalid();
  const ids = new Set<number>(), assigned = new Set<number>(); let assignments = 0;
  const rows: Contact[] = accepted.data.map((raw, index) => {
    if (!record(raw) || !integer(raw.contact_id) || !has(raw, 'contact_id') || !has(raw, 'standing') || typeof raw.standing !== 'number' || !Number.isFinite(raw.standing) || !has(raw, 'contact_type') || typeof raw.contact_type !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(raw.contact_type)) return invalid();
    if (ids.has(raw.contact_id)) return invalid(); ids.add(raw.contact_id);
    if (has(raw, 'is_blocked') && typeof raw.is_blocked !== 'boolean' || has(raw, 'is_watched') && typeof raw.is_watched !== 'boolean') return invalid();
    let labelIds: number[] | null = null;
    if (has(raw, 'label_ids')) {
      if (!Array.isArray(raw.label_ids) || raw.label_ids.length > 64) return invalid();
      const unique = new Set<number>(); labelIds = [];
      for (const id of raw.label_ids) { if (!integer(id) || unique.has(id)) return invalid(); unique.add(id); assigned.add(id); labelIds.push(id); }
      labelIds.sort((a, b) => a - b); assignments += labelIds.length;
      if (assignments > 64000 || assigned.size > 1000) return invalid();
    }
    const type = types.slice(0, 4).includes(raw.contact_type as ContactType) ? raw.contact_type as ContactType : 'other';
    return { row: index + 1, contactId: raw.contact_id, type, standing: raw.standing === 0 ? 0 : raw.standing, blocked: has(raw, 'is_blocked') ? raw.is_blocked as boolean : null, watched: raw.is_watched === true, labelIds };
  });
  const summary = { contacts: rows.length, negativeStanding: rows.filter(row => row.standing < 0).length, zeroStanding: rows.filter(row => row.standing === 0).length, positiveStanding: rows.filter(row => row.standing > 0).length,
    watched: rows.filter(row => row.watched).length, notWatched: rows.filter(row => !row.watched).length, blocked: rows.filter(row => row.blocked === true).length, notBlocked: rows.filter(row => row.blocked === false).length, unknownBlocked: rows.filter(row => row.blocked === null).length,
    missingLabelAssignments: rows.filter(row => row.labelIds === null).length, emptyLabelAssignments: rows.filter(row => row.labelIds?.length === 0).length, otherTypes: rows.filter(row => row.type === 'other').length };
  const grouped = new Map<number, number>(); for (const row of rows) for (const id of row.labelIds ?? []) grouped.set(id, (grouped.get(id) ?? 0) + 1);
  const { page, pages } = accepted;
  return { status: 'partial', message: 'Reported contact settings from one returned page. Overlapping label groups describe known assignments only.', freshness: accepted.freshness,
    coverage: { kind: 'returned_page', page, pages, nextPage: pages !== null && pages > page && page < 500 ? page + 1 : null, previousPage: page > 1 ? page - 1 : null, pageLimitReached: page === 500 && pages !== 500, contacts: rows.length },
    data: { summary, typeCounts: types.map(type => ({ type, contacts: rows.filter(row => row.type === type).length })), byLabel: [...grouped].sort((a, b) => a[0] - b[0]).map(([labelId, contacts]) => ({ labelId, contacts })), rows } };
}
function labelsSource(accepted: ReturnType<typeof envelope>): ContactsAnalytics['labels'] {
  if (!Array.isArray(accepted.data) || accepted.data.length > 1000) return invalid();
  const ids = new Set<number>();
  const rows: ContactLabel[] = accepted.data.map((raw, index) => {
    if (!record(raw) || !has(raw, 'label_id') || !integer(raw.label_id) || ids.has(raw.label_id) || !has(raw, 'label_name')) return invalid();
    ids.add(raw.label_id); return { row: index + 1, labelId: raw.label_id, name: labelName(raw.label_name) };
  });
  const summary = { returnedLabels: rows.length, emptyNames: rows.filter(row => row.name.state === 'reported' && row.name.text === '').length, redactedNames: rows.filter(row => row.name.state === 'redacted').length, truncatedNames: rows.filter(row => row.name.truncated).length };
  return { status: 'partial', message: 'Separately reported contact label metadata. An absent label here does not prove deletion or absence of contact assignments.', freshness: accepted.freshness, coverage: { kind: 'returned_response', labels: rows.length }, data: { summary, rows } };
}
function finish(result: ContactsAnalytics, at: number): ContactsAnalytics {
  result.generatedAt = new Date(at).toISOString();
  for (const source of [result.contacts, result.labels]) if (source.data !== null) source.freshness.state = source.freshness.cacheExpires === null ? 'unknown' : Date.parse(source.freshness.cacheExpires) <= at ? 'stale' : 'fresh';
  if (result.contacts.data !== null) {
    const { summary } = result.contacts.data;
    result.contacts.status = result.contacts.freshness.state === 'fresh' && result.contacts.coverage.page === 1 && result.contacts.coverage.pages === 1 && summary.otherTypes === 0 && summary.unknownBlocked === 0 && summary.missingLabelAssignments === 0 ? 'ready' : 'partial';
  }
  if (result.labels.data !== null) result.labels.status = result.labels.freshness.state === 'fresh' && result.labels.data.summary.redactedNames === 0 && result.labels.data.summary.truncatedNames === 0 ? 'ready' : 'partial';
  result.status = result.contacts.status === 'ready' && (result.labels.status === 'ready' || result.labels.status === 'not_requested') ? 'ready' : result.contacts.data !== null || result.labels.data !== null ? 'partial' : result.contacts.status === 'error' || result.labels.status === 'error' ? 'error' : 'unavailable';
  bounded(result); return result;
}
async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let stop = () => {};
  const interrupted = new Promise<never>((_, reject) => { stop = () => reject(signal.reason); signal.addEventListener('abort', stop, { once: true }); }); void interrupted.catch(() => {});
  try { const value = await Promise.race([work(), interrupted]); signal.throwIfAborted(); return value; } finally { signal.removeEventListener('abort', stop); }
}

/** One owned contacts GET plus an explicitly requested label GET. No lookups, writes or retained account data. */
export function createContactsAnalyticsReader(dependencies: Dependencies) {
  return async (user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<ContactsAnalytics> => {
    const selected = validateContactsAnalyticsArgs(input), now = dependencies.now ?? Date.now;
    if (typeof user !== 'string' || !user) throw new EveError('Sign in to this private connector first.', 401);
    const deadline = now() + 55000, signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    const cancelled = () => blank(selected, now(), 'unavailable', 'The contacts request was cancelled or reached its time limit. Load again when ready.');
    const budget = () => { signal.throwIfAborted(); if (now() >= deadline) throw new ContactsDataError(); };
    let connection: { characterId: number; scopes: string[] } | undefined;
    try { budget(); connection = (await abortable(() => dependencies.connections(user), signal)).find(row => row.characterId === selected.characterId); budget(); }
    catch { return signal.aborted || now() >= deadline ? cancelled() : blank(selected, now(), 'unavailable', 'Connection status could not be checked. Reload Connections before trying again.'); }
    if (!connection) throw new EveError('Choose a character connected to this private connector.', 404);
    if (!connection.scopes.includes(scope)) return blank(selected, now(), 'needs_permission', 'This character has not granted the existing contacts read permission. No access is added automatically.');
    const result = blank(selected, now(), 'unavailable', 'One contacts page and optional label metadata are independent returned observations, not a complete or synchronized contact history.');
    const datasets = selected.includeLabels ? ['contacts', 'contact_labels'] as const : ['contacts'] as const;
    for (const dataset of datasets) {
      const key = dataset === 'contacts' ? 'contacts' : 'labels';
      const args = { characterId: selected.characterId, dataset, ...(dataset === 'contacts' ? { parameters: { page: selected.page ?? 1 } } : {}) };
      try {
        budget(); const raw = await abortable(() => dependencies.character(user, args, signal), signal); budget();
        const accepted = envelope(raw, args, now());
        if (dataset === 'contacts') result.contacts = contactsSource(accepted); else result.labels = labelsSource(accepted);
        budget();
      } catch (error) {
        if (signal.aborted || now() >= deadline) return cancelled();
        if (error instanceof EveError && [401, 409].includes(error.status)) return blank(selected, now(), 'unavailable', 'Contacts authorization or identity changed during this request. No account evidence was retained; reload Connections before trying again.');
        const unavailable = error instanceof EveError && [403, 404, 429].includes(error.status);
        result[key].status = unavailable ? 'unavailable' : 'error'; result[key].message = unavailable ? 'This contacts source could not be read with the current authorization or provider availability. No empty result is assumed.' : 'This contacts source could not be validated within the accepted format and limits. Missing evidence is unknown, not zero.';
        if (error instanceof EveError && error.status === 429) { if (dataset === 'contacts' && selected.includeLabels) result.labels.message = 'A provider rate limit stopped the remaining label read. No label count is assumed.'; break; }
      }
    }
    try { budget(); const completed = finish(result, now()); budget(); return completed; }
    catch { return signal.aborted || now() >= deadline ? cancelled() : blank(selected, now(), 'error', 'Contacts evidence exceeded the accepted response format or limits. No partial projection was returned.'); }
  };
}
export const getContactsAnalytics = createContactsAnalyticsReader({ connections: listConnections, character: readCharacterData });
