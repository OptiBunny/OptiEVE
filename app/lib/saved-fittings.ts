import { EveError, listConnections, readCharacterData } from './eve';
import { findPublishedManufacturingItem } from './manufacturing-catalog';
import { overviewDate } from './overview-summary';
import { walletActivityExpiry } from './wallet-analytics';
import type { FittingFlag, FittingFlagGroup, SavedFitting, SavedFittings, SavedFittingsArgs, SavedFittingType } from './saved-fittings-types';

type Dependencies = {
  connections: (user: string) => Promise<{ characterId: number; scopes: string[] }[]>;
  character: (user: string, args: { characterId: number; dataset: string }, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
};
const scope = 'esi-fittings.read_fittings.v1' as const, byteLimit = 8 * 1024 * 1024;
const flagGroups: FittingFlagGroup[] = ['high', 'medium', 'low', 'rig', 'subsystem', 'service', 'cargo', 'drone_bay', 'fighter_bay', 'invalid'];
const flagGroup = new Map<FittingFlag, FittingFlagGroup>([
  ['Cargo', 'cargo'], ['DroneBay', 'drone_bay'], ['FighterBay', 'fighter_bay'], ['Invalid', 'invalid'],
  ...Array.from({ length: 8 }, (_, i) => [`HiSlot${i}` as FittingFlag, 'high' as const] as const),
  ...Array.from({ length: 8 }, (_, i) => [`MedSlot${i}` as FittingFlag, 'medium' as const] as const),
  ...Array.from({ length: 8 }, (_, i) => [`LoSlot${i}` as FittingFlag, 'low' as const] as const),
  ...Array.from({ length: 3 }, (_, i) => [`RigSlot${i}` as FittingFlag, 'rig' as const] as const),
  ...Array.from({ length: 4 }, (_, i) => [`SubSystemSlot${i}` as FittingFlag, 'subsystem' as const] as const),
  ...Array.from({ length: 8 }, (_, i) => [`ServiceSlot${i}` as FittingFlag, 'service' as const] as const),
]);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, minimum = 1): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
class SavedFittingsDataError extends Error {}
const invalid = (): never => { throw new SavedFittingsDataError(); };
const limitations = [
  'One manually requested saved-fitting response for one character. These are plans, not owned ships, fitted assets, available inventory or a history of changes. No corporation library or other character is read.',
  'The provider supplies no per-fitting creation or update time and no pagination for this endpoint. Coverage describes this returned response only; cache timestamps do not date an individual plan.',
  'Item records and distinct plans listing each type are counted separately. Repeated item rows are preserved; a type counts once per plan regardless of repetitions or quantity. Type-presence counts overlap and cannot be added into a distinct-plan total.',
  'Signed safe integer quantities are reported inputs, including zero and negative values. Quantities are not added across types. Flags and record counts do not establish occupied slots, compatibility, fit validity, capacity, readiness or production.',
  'Persistent fitting IDs and descriptions are omitted. Names are untrusted plain text: unsafe or over-limit names are redacted, long safe names are truncated, and empty reported names remain distinct from redactions. Row references apply only to this load.',
  'Public type names come from the pinned catalog, with explicit Type ID fallbacks and bounded labels. No assets, dogma, prices or additional public lookup is requested; no DPS, value or profit is inferred.',
  'Application limits are 1,000 fittings, 256 item records per fitting and 10,000 item records overall. An independent 8 MiB envelope/projection limit may refuse a smaller response. No count is silently truncated to these limits.',
  'Loading, filtering and plan selection do not save account history or change EVE game state. No automatic polling, extra grants, fitting import, creation, update or deletion is performed.',
];

export function validateSavedFittingsArgs(value: unknown): SavedFittingsArgs {
  const fail = (): never => { throw new EveError('Choose one connected character to read saved fitting plans.'); };
  if (!record(value)) return fail();
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => key !== 'characterId' || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'))) return fail();
  for (const key in value) if (!Object.hasOwn(value, key)) return fail();
  if (!Object.hasOwn(value, 'characterId') || !integer(value.characterId)) return fail();
  return { characterId: value.characterId };
}
function timestamp(value: unknown): string | null { const parsed = overviewDate(value); return parsed?.length === 24 ? parsed : null; }
function headerDate(value: unknown): string | null {
  const iso = timestamp(value); if (iso) return iso;
  if (typeof value !== 'string' || value.length > 100) return null;
  const time = Date.parse(value); if (!Number.isFinite(time) || new Date(time).toUTCString() !== value) return null;
  const normalized = new Date(time).toISOString(); return normalized.length === 24 ? normalized : null;
}
function bounded(value: unknown) {
  // This is a post-read envelope/projection bound. readCharacterData separately
  // limits actual upstream bytes to 8 MiB; this is not a tighter stream/heap cap.
  try { if (new TextEncoder().encode(JSON.stringify(value)).byteLength > byteLimit) return invalid(); }
  catch { return invalid(); }
}
function blank(selected: SavedFittingsArgs, at: number, status: SavedFittings['status'], message: string): SavedFittings {
  return { characterId: selected.characterId, generatedAt: new Date(at).toISOString(), status, message, scope,
    coverage: { kind: 'unavailable', fittings: null, itemRecords: null },
    freshness: { state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null },
    summary: null, types: [], hullCounts: [], itemPresence: [], flagCounts: [], fittings: [], limitations: [...limitations] };
}
function textPrefix(value: string, maximum: number): { text: string; truncated: boolean } | null {
  if (value.length > 16384 || /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value)) return null;
  let text = '', length = 0;
  // Check the whole original, including text beyond the displayed prefix.
  for (const character of value) {
    if (character.length === 1 && /[\ud800-\udfff]/.test(character)) return null;
    if (length++ < maximum) text += character;
  }
  return { text, truncated: length > maximum };
}
function nameOf(value: string): Pick<SavedFitting, 'name' | 'nameState' | 'nameTruncated'> {
  const accepted = textPrefix(value, 256);
  return accepted ? { name: accepted.text, nameState: 'reported', nameTruncated: accepted.truncated } : { name: null, nameState: 'redacted', nameTruncated: false };
}
function typeOf(typeId: number): SavedFittingType {
  const source = findPublishedManufacturingItem(typeId), accepted = source && textPrefix(source.name, 128);
  return accepted ? { typeId, name: accepted.text, mapped: true, nameTruncated: accepted.truncated } : { typeId, name: `Type ${typeId}`, mapped: false, nameTruncated: false };
}
function fittingsOf(value: unknown): SavedFitting[] {
  if (!Array.isArray(value) || value.length > 1000) return invalid();
  const ids = new Set<number>(); let itemRecords = 0;
  return value.map((raw, index) => {
    if (!record(raw) || !integer(raw.fitting_id) || ids.has(raw.fitting_id) || !integer(raw.ship_type_id) ||
        typeof raw.name !== 'string' || typeof raw.description !== 'string' || !Array.isArray(raw.items) || raw.items.length > 256) return invalid();
    ids.add(raw.fitting_id); itemRecords += raw.items.length; if (itemRecords > 10000) return invalid();
    const items = raw.items.map((item, position) => {
      if (!record(item) || !integer(item.type_id) || !integer(item.quantity, Number.MIN_SAFE_INTEGER) || typeof item.flag !== 'string' || !flagGroup.has(item.flag as FittingFlag)) return invalid();
      return { row: position + 1, typeId: item.type_id, flag: item.flag as FittingFlag, quantity: item.quantity };
    });
    return { row: index + 1, shipTypeId: raw.ship_type_id, ...nameOf(raw.name), items };
  });
}
function accept(selected: SavedFittingsArgs, value: unknown, at: number) {
  bounded(value);
  if (!record(value) || value.characterId !== selected.characterId || value.dataset !== 'fittings' || value.entity !== undefined && value.entity !== 'character' ||
      value.corporationId != null || value.division != null || value.page != null || value.source !== `https://esi.evetech.net/characters/${selected.characterId}/fittings`) return invalid();
  const pagination = value.pagination;
  if (!record(pagination) || pagination.kind !== 'none' ||
      ['page', 'pages', 'nextPage', 'nextFromId', 'nextBeforeId', 'nextFromEvent', 'after', 'before', 'pageLimit', 'morePagesAvailable', 'pageLimitReached'].some(key => pagination[key] != null)) return invalid();
  const retrievedAt = timestamp(value.retrievedAt); if (!retrievedAt || Date.parse(retrievedAt) > at + 60000) return invalid();
  return { fittings: fittingsOf(value.data), retrievedAt,
    cacheExpires: timestamp(walletActivityExpiry(value, Date.parse(retrievedAt))), lastModified: headerDate(value.lastModified) };
}
function project(selected: SavedFittingsArgs, accepted: ReturnType<typeof accept>, at: number): SavedFittings {
  const { fittings } = accepted, hulls = new Map<number, number>(), presence = new Map<number, { fittings: number; itemRecords: number }>();
  const flagCounts = new Map(flagGroups.map(group => [group, 0])), typeIds = new Set<number>(); let itemRecords = 0;
  for (const fitting of fittings) {
    hulls.set(fitting.shipTypeId, (hulls.get(fitting.shipTypeId) ?? 0) + 1); typeIds.add(fitting.shipTypeId);
    const seen = new Set<number>();
    for (const item of fitting.items) {
      itemRecords++; typeIds.add(item.typeId);
      const value = presence.get(item.typeId) ?? { fittings: 0, itemRecords: 0 };
      value.itemRecords++; if (!seen.has(item.typeId)) { value.fittings++; seen.add(item.typeId); } presence.set(item.typeId, value);
      const group = flagGroup.get(item.flag)!; flagCounts.set(group, flagCounts.get(group)! + 1);
    }
  }
  const types = [...typeIds].sort((left, right) => left - right).map(typeOf), unmapped = new Set(types.filter(type => !type.mapped).map(type => type.typeId));
  const result = blank(selected, at, 'partial', 'Saved fitting plans from one returned character response. Plan and item-record counts do not establish owned equipment, valid fits or readiness.');
  result.coverage = { kind: 'returned_response', fittings: fittings.length, itemRecords };
  result.freshness = { state: 'unknown', retrievedAt: accepted.retrievedAt, cacheExpires: accepted.cacheExpires, lastModified: accepted.lastModified };
  result.summary = { fittings: fittings.length, itemRecords, shipTypes: hulls.size, itemTypes: presence.size,
    emptyFittings: fittings.filter(row => row.items.length === 0).length, emptyNames: fittings.filter(row => row.nameState === 'reported' && row.name === '').length,
    redactedNames: fittings.filter(row => row.nameState === 'redacted').length, truncatedNames: fittings.filter(row => row.nameTruncated).length,
    unmappedShipTypes: [...hulls.keys()].filter(id => unmapped.has(id)).length, unmappedItemTypes: [...presence.keys()].filter(id => unmapped.has(id)).length };
  result.types = types; result.fittings = fittings;
  result.hullCounts = [...hulls].sort(([left], [right]) => left - right).map(([typeId, count]) => ({ typeId, fittings: count }));
  result.itemPresence = [...presence].sort(([left], [right]) => left - right).map(([typeId, counts]) => ({ typeId, fittings: counts.fittings, itemRecords: counts.itemRecords }));
  result.flagCounts = flagGroups.map(group => ({ group, itemRecords: flagCounts.get(group)! }));
  return result;
}
function finish(result: SavedFittings, at: number): SavedFittings {
  result.generatedAt = new Date(at).toISOString();
  result.freshness.state = result.freshness.cacheExpires === null ? 'unknown' : Date.parse(result.freshness.cacheExpires) <= at ? 'stale' : 'fresh';
  result.status = result.freshness.state === 'fresh' && result.summary?.redactedNames === 0 && result.summary.truncatedNames === 0 ? 'ready' : 'partial';
  bounded(result); return result;
}
async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let stop: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { stop = () => reject(signal.reason); signal.addEventListener('abort', stop, { once: true }); }); void interrupted.catch(() => {});
  try { const value = await Promise.race([work(), interrupted]); signal.throwIfAborted(); return value; }
  finally { signal.removeEventListener('abort', stop); }
}

/** One owned saved-fitting GET under an existing grant. No additional lookup, write or retained result. */
export function createSavedFittingsReader(dependencies: Dependencies) {
  return async (user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<SavedFittings> => {
    const selected = validateSavedFittingsArgs(input), now = dependencies.now ?? Date.now;
    if (typeof user !== 'string' || !user) throw new EveError('Sign in to this private connector first.', 401);
    const deadline = now() + 55000, signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    const checkBudget = () => { signal.throwIfAborted(); if (now() >= deadline) throw new SavedFittingsDataError(); };
    const cancelled = () => blank(selected, now(), 'unavailable', 'The saved-fitting request was cancelled or reached its time limit. Load again when ready.');
    checkBudget(); let connection: { characterId: number; scopes: string[] } | undefined;
    try { connection = (await abortable(() => dependencies.connections(user), signal)).find(row => row.characterId === selected.characterId); }
    catch { return signal.aborted || now() >= deadline ? cancelled() : blank(selected, now(), 'unavailable', 'Connection status could not be checked. Reload Connections before trying again.'); }
    if (!connection) throw new EveError('Choose a character connected to this private connector.', 404);
    if (signal.aborted || now() >= deadline) return cancelled();
    if (!connection.scopes.includes(scope)) return blank(selected, now(), 'needs_permission', 'This character has not granted the existing fittings read permission. No access is added automatically.');
    try {
      checkBudget(); const response = await abortable(() => dependencies.character(user, { characterId: selected.characterId, dataset: 'fittings' }, signal), signal);
      const accepted = accept(selected, response, now()); checkBudget();
      const result = project(selected, accepted, now()); checkBudget();
      const completed = finish(result, now()); checkBudget(); return completed;
    } catch (error) {
      if (signal.aborted || now() >= deadline) return cancelled();
      const unavailable = error instanceof EveError && [401, 403, 404, 409, 429].includes(error.status);
      return blank(selected, now(), unavailable ? 'unavailable' : 'error', unavailable ?
        'The selected saved-fitting source could not be read with the current authorization or provider availability. No access was added or retry made.' :
        'Saved fitting plans could not be validated within the accepted format and limits. Missing data is unknown, not zero.');
    }
  };
}
export const getSavedFittings = createSavedFittingsReader({ connections: listConnections, character: readCharacterData });
