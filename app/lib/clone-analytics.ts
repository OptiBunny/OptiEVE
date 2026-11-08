import { EveError, listConnections, readCharacterData } from './eve';
import { findPublishedManufacturingItem } from './manufacturing-catalog';
import { overviewDate } from './overview-summary';
import type { ActiveImplantsData, CloneAnalytics, CloneAnalyticsRequest, CloneAnalyticsSection, CloneAnalyticsStatus, CloneImplant, JumpClonesData } from './clone-analytics-types';

type Dependencies = {
  connections: (user: string) => Promise<{ characterId: number; scopes: string[] }[]>;
  character: (user: string, args: { characterId: number; dataset: string }, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
};
const scopes = { clones: 'esi-clones.read_clones.v1', implants: 'esi-clones.read_implants.v1' } as const;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
class CloneDataError extends Error {}
function invalid(): never { throw new CloneDataError(); }
const notes = {
  clones: 'One returned jump-clone list. Row numbers apply only to this response. Custom clone names and persistent clone IDs are omitted. Location IDs and kinds are reported, not resolved or proof of access. Stored implant occurrences are separate from active implants; repeated type IDs are retained. Dates do not establish jump readiness, cooldown duration, clone capacity or safe travel.',
  implants: 'One returned active-implant list, separate from stored jump clones. Reported type occurrences are retained, including repetitions. Labels use the pinned public catalog; an unmapped type remains an explicit ID. No bonuses, slot compatibility, prices, training rate or value are inferred.',
};

export function validateCloneAnalyticsArgs(value: unknown): CloneAnalyticsRequest {
  if (!record(value) || !Object.hasOwn(value, 'characterId') || !integer(value.characterId) || Object.keys(value).some(key => key !== 'characterId')) {
    throw new EveError('Choose one connected character to load clones and implants.');
  }
  return { characterId: value.characterId };
}
function blank<T>(scope: string, status: CloneAnalyticsStatus, message: string): CloneAnalyticsSection<T> {
  return { status, scope, message, retrievedAt: null, cacheExpires: null, freshness: 'unknown', data: null };
}
function date(value: unknown): string {
  const parsed = overviewDate(value);
  return parsed?.length === 24 ? parsed : invalid();
}
function optionalDate(data: Record<string, unknown>, key: string, received: number): string | null {
  if (!Object.hasOwn(data, key)) return null;
  const parsed = date(data[key]);
  return Date.parse(parsed) <= received + 60000 ? parsed : invalid();
}
function headerTime(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 100) return null;
  const iso = overviewDate(value);
  if (iso !== null && iso.length === 24) return Date.parse(iso);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toUTCString() === value ? parsed : null;
}
function expiry(response: Record<string, unknown>, received: number): string | null {
  const expires = headerTime(response.cacheExpires), responseDate = headerTime(response.responseDate);
  const control = typeof response.cacheControl === 'string' && response.cacheControl.length <= 512 ? response.cacheControl : '';
  if (/(?:^|,)\s*(?:no-cache|no-store)(?=\s*(?:,|$))/i.test(control)) return new Date(received).toISOString();
  const age = response.cacheAge == null ? 0 : typeof response.cacheAge === 'string' && /^\d{1,10}$/.test(response.cacheAge) ? Number(response.cacheAge) : NaN;
  if (!integer(age, 0, 604800)) return null;
  const match = /(?:^|,)\s*max-age=(\d+)(?=\s*(?:,|$))/i.exec(control), maxAge = match ? Number(match[1]) : null;
  const cached = integer(maxAge, 0, 604800) && responseDate !== null && responseDate <= received + 60000
    ? Math.min(responseDate + maxAge * 1000, received + (maxAge - age) * 1000) : null;
  const until = expires === null ? cached : cached === null ? expires : Math.min(expires, cached);
  return until === null ? null : new Date(until).toISOString();
}
async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); });
  void interrupted.catch(() => {});
  try { const value = await Promise.race([work(), interrupted]); signal.throwIfAborted(); return value; }
  finally { signal.removeEventListener('abort', cancel); }
}
function implants(data: unknown): CloneImplant[] {
  // These are type occurrences, not item identities. The schema does not promise
  // uniqueness; preserving repeated types avoids inventing a deduplicated count.
  if (!Array.isArray(data) || data.length > 64) return invalid();
  return data.map(typeId => {
    if (!integer(typeId)) return invalid();
    const item = findPublishedManufacturingItem(typeId);
    const safeName = item && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 512 && item.name.trim() === item.name && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(item.name);
    return { typeId, name: safeName ? item.name : `Type ${typeId}`, mapped: Boolean(safeName) };
  });
}
function activeImplants(data: unknown): ActiveImplantsData {
  const rows = implants(data);
  return { implantCount: rows.length, unmappedImplants: rows.filter(row => !row.mapped).length, implants: rows };
}
function locationType(value: unknown): 'station' | 'structure' {
  return value === 'station' || value === 'structure' ? value : invalid();
}
function jumpClones(data: unknown, received: number): JumpClonesData {
  if (!record(data) || !Array.isArray(data.jump_clones) || data.jump_clones.length > 100) return invalid();
  let homeLocation: JumpClonesData['homeLocation'] = null;
  // The dated schema makes both home-location fields optional, even when the
  // object exists. Missing means unknown; null/malformed present values fail.
  if (Object.hasOwn(data, 'home_location')) {
    if (!record(data.home_location)) return invalid();
    const home = data.home_location;
    homeLocation = {
      locationId: Object.hasOwn(home, 'location_id') ? integer(home.location_id) ? home.location_id : invalid() : null,
      locationType: Object.hasOwn(home, 'location_type') ? locationType(home.location_type) : null,
    };
  }
  const seen = new Set<number>();
  const clones = data.jump_clones.map((row, index) => {
    if (!record(row) || !integer(row.jump_clone_id) || seen.has(row.jump_clone_id) || !integer(row.location_id)) return invalid();
    seen.add(row.jump_clone_id);
    return { row: index + 1, locationId: row.location_id, locationType: locationType(row.location_type), implants: implants(row.implants) };
  });
  return {
    homeLocation, lastCloneJumpAt: optionalDate(data, 'last_clone_jump_date', received), lastHomeStationChangeAt: optionalDate(data, 'last_station_change_date', received),
    cloneCount: clones.length, totalStoredImplants: clones.reduce((sum, row) => sum + row.implants.length, 0),
    unmappedImplants: clones.reduce((sum, row) => sum + row.implants.filter(item => !item.mapped).length, 0), clones,
  };
}
function refreshFreshness<T>(section: CloneAnalyticsSection<T>, completed: number) {
  if (section.data === null) return;
  section.freshness = section.cacheExpires === null ? 'unknown' : Date.parse(section.cacheExpires) <= completed ? 'stale' : 'fresh';
  if (section.freshness !== 'fresh') {
    section.status = 'partial';
    section.message += section.freshness === 'stale' ? ' This response has reached its reported cache expiry; refresh before relying on it.' : ' A usable cache expiry was not reported; freshness is unknown.';
  }
}

/** Two explicitly requested, owner-bound read feeds; no extra lookups or persistence. */
export function createCloneAnalyticsReader(dependencies: Dependencies) {
  return async (user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<CloneAnalytics> => {
    const selected = validateCloneAnalyticsArgs(input), now = dependencies.now ?? Date.now;
    if (typeof user !== 'string' || !user) throw new EveError('Sign in to this private connector first.', 401);
    const started = now(), deadlineAt = started + 55000;
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    signal.throwIfAborted();
    let connection: { characterId: number; scopes: string[] } | undefined;
    try { connection = (await abortable(() => dependencies.connections(user), signal)).find(row => row.characterId === selected.characterId); }
    catch { throw new EveError('Connection status could not be checked. Refresh to try again.', 503); }
    if (!connection) throw new EveError('Choose a character connected to this private connector.', 404);
    const result: CloneAnalytics = {
      characterId: selected.characterId, generatedAt: new Date(started).toISOString(), status: 'unavailable',
      message: 'One selected connected character. Active implants and stored jump clones are independent ESI snapshots with separate freshness. They are not combined into a single inventory or synchronized history. Nothing is saved.',
      clones: blank(scopes.clones, 'unavailable', 'Load clones and implants explicitly.'), implants: blank(scopes.implants, 'unavailable', 'Load clones and implants explicitly.'),
    };
    let blocked = '', discard = false;
    const cancelled = 'The request was cancelled or reached its time limit. Load again to retry.';
    for (const key of ['clones', 'implants'] as const) {
      if (signal.aborted || now() >= deadlineAt) { blocked = cancelled; discard = true; }
      if (blocked) { result[key] = blank(scopes[key], 'unavailable', blocked); continue; }
      if (!connection.scopes.includes(scopes[key])) {
        result[key] = blank(scopes[key], 'needs_permission', 'This character has not granted this existing read permission. No additional access is requested automatically.');
        continue;
      }
      try {
        const response = await abortable(() => dependencies.character(user, { characterId: selected.characterId, dataset: key }, signal), signal);
        signal.throwIfAborted();
        if (!record(response) || response.characterId !== selected.characterId || response.dataset !== key || response.entity !== undefined && response.entity !== 'character' ||
            response.corporationId != null || response.division != null || response.page != null || !record(response.pagination) || response.pagination.kind !== 'none' ||
            ['page', 'pages', 'nextPage', 'nextFromId', 'nextBeforeId', 'nextFromEvent', 'after', 'before'].some(field => (response.pagination as Record<string, unknown>)[field] != null)) invalid();
        const retrievedAt = date(response.retrievedAt), received = Date.parse(retrievedAt);
        if (received > now() + 60000) invalid();
        const metadata = { status: 'ready' as const, scope: scopes[key], message: notes[key], retrievedAt, cacheExpires: expiry(response, received), freshness: 'unknown' as const };
        if (key === 'clones') result.clones = { ...metadata, data: jumpClones(response.data, received) };
        else result.implants = { ...metadata, data: activeImplants(response.data) };
      } catch (error) {
        let status: CloneAnalyticsStatus = 'unavailable', message: string;
        if (signal.aborted || now() >= deadlineAt) { blocked = message = cancelled; discard = true; }
        else if (error instanceof EveError && [401, 404, 409].includes(error.status)) { blocked = message = 'The character connection changed or its authorization expired. Reload connection status before trying again.'; discard = true; }
        else if (error instanceof EveError && error.status === 429) blocked = message = 'EVE is rate limiting requests. Wait before loading again; no automatic retry was made.';
        else if (error instanceof EveError && error.status === 403) message = 'EVE denied this read. Check the character’s existing read permission; no access is added automatically.';
        else { status = 'error'; message = error instanceof CloneDataError ? 'EVE returned data that could not be displayed safely. Missing data is unknown, not zero.' : 'This EVE read could not be loaded. Missing data is unknown, not zero.'; }
        result[key] = blank(scopes[key], status, message);
      }
    }
    const completed = now();
    result.generatedAt = new Date(completed).toISOString();
    if (signal.aborted || completed >= deadlineAt) { blocked = cancelled; discard = true; }
    if (discard) {
      result.clones = blank(scopes.clones, 'unavailable', blocked);
      result.implants = blank(scopes.implants, 'unavailable', blocked);
    }
    refreshFreshness(result.clones, completed); refreshFreshness(result.implants, completed);
    const sections = [result.clones, result.implants];
    result.status = sections.every(section => section.status === 'ready') ? 'ready'
      : sections.some(section => section.data !== null) ? 'partial'
      : sections.every(section => section.status === 'needs_permission') ? 'needs_permission'
      : sections.some(section => section.status === 'error') ? 'error' : 'unavailable';
    return result;
  };
}
export const readCloneAnalytics = createCloneAnalyticsReader({ connections: listConnections, character: readCharacterData });
