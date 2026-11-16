import { z } from 'zod';
import { ConnectionResponseError } from './connection-client';
import type { SavedFittings, SavedFittingsArgs, FittingFlagGroup } from './saved-fittings-types';

const id = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().min(0).max(1000), records = z.number().int().min(0).max(10000);
const timestamp = z.string().length(24).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const safeText = (points: number) => z.string().max(points * 2).refine(value => Array.from(value).length <= points && !/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value) && !Array.from(value).some(character => character.length === 1 && /[\ud800-\udfff]/.test(character)));
const flags = ['Cargo', 'DroneBay', 'FighterBay', 'Invalid', 'HiSlot0', 'HiSlot1', 'HiSlot2', 'HiSlot3', 'HiSlot4', 'HiSlot5', 'HiSlot6', 'HiSlot7', 'LoSlot0', 'LoSlot1', 'LoSlot2', 'LoSlot3', 'LoSlot4', 'LoSlot5', 'LoSlot6', 'LoSlot7', 'MedSlot0', 'MedSlot1', 'MedSlot2', 'MedSlot3', 'MedSlot4', 'MedSlot5', 'MedSlot6', 'MedSlot7', 'RigSlot0', 'RigSlot1', 'RigSlot2', 'ServiceSlot0', 'ServiceSlot1', 'ServiceSlot2', 'ServiceSlot3', 'ServiceSlot4', 'ServiceSlot5', 'ServiceSlot6', 'ServiceSlot7', 'SubSystemSlot0', 'SubSystemSlot1', 'SubSystemSlot2', 'SubSystemSlot3'] as const;
const groups = ['high', 'medium', 'low', 'rig', 'subsystem', 'service', 'cargo', 'drone_bay', 'fighter_bay', 'invalid'] as const;
const text = z.string().max(2048);
const schema = z.strictObject({
  characterId: id, generatedAt: timestamp, status: z.enum(['ready', 'partial', 'needs_permission', 'unavailable', 'error']), message: text, scope: z.literal('esi-fittings.read_fittings.v1'),
  coverage: z.strictObject({ kind: z.enum(['returned_response', 'unavailable']), fittings: count.nullable(), itemRecords: records.nullable() }),
  freshness: z.strictObject({ state: z.enum(['fresh', 'stale', 'unknown']), retrievedAt: timestamp.nullable(), cacheExpires: timestamp.nullable(), lastModified: timestamp.nullable() }),
  summary: z.strictObject({ fittings: count, itemRecords: records, shipTypes: count, itemTypes: records, emptyFittings: count, emptyNames: count, redactedNames: count, truncatedNames: count, unmappedShipTypes: count, unmappedItemTypes: records }).nullable(),
  types: z.array(z.strictObject({ typeId: id, name: safeText(128), mapped: z.boolean(), nameTruncated: z.boolean() })).max(11000),
  hullCounts: z.array(z.strictObject({ typeId: id, fittings: count })).max(1000),
  itemPresence: z.array(z.strictObject({ typeId: id, fittings: count, itemRecords: records })).max(10000),
  flagCounts: z.array(z.strictObject({ group: z.enum(groups), itemRecords: records })).max(10),
  fittings: z.array(z.strictObject({ row: z.number().int().min(1).max(1000), shipTypeId: id, name: safeText(256).nullable(), nameState: z.enum(['reported', 'redacted']), nameTruncated: z.boolean(), items: z.array(z.strictObject({ row: z.number().int().min(1).max(256), typeId: id, flag: z.enum(flags), quantity: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) })).max(256) })).max(1000),
  limitations: z.array(text).max(16),
});
const invalid = () => new ConnectionResponseError('The saved-fittings response could not be validated safely. Load it again.');
function selection(value: unknown): SavedFittingsArgs {
  const fail = () => new ConnectionResponseError('Choose one connected character to read saved fittings.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== 'characterId' || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, 'characterId') ?? {}, 'value')) throw fail();
  for (const key in value) if (!Object.hasOwn(value, key)) throw fail();
  const selected = value as SavedFittingsArgs; if (!id.safeParse(selected.characterId).success) throw fail();
  return { characterId: selected.characterId };
}
function group(flag: string): FittingFlagGroup {
  return flag.startsWith('HiSlot') ? 'high' : flag.startsWith('MedSlot') ? 'medium' : flag.startsWith('LoSlot') ? 'low' : flag.startsWith('RigSlot') ? 'rig' : flag.startsWith('SubSystemSlot') ? 'subsystem' : flag.startsWith('ServiceSlot') ? 'service' : flag === 'Cargo' ? 'cargo' : flag === 'DroneBay' ? 'drone_bay' : flag === 'FighterBay' ? 'fighter_bay' : 'invalid';
}
export function savedFittingsResponse(value: unknown, input: SavedFittingsArgs): SavedFittings {
  const selected = selection(input), parsed = schema.safeParse(value); if (!parsed.success) throw invalid();
  const result = parsed.data, fresh = result.freshness, now = Date.parse(result.generatedAt);
  if (result.characterId !== selected.characterId || new TextEncoder().encode(JSON.stringify(result)).byteLength > 8 * 1024 * 1024) throw invalid();
  if (!['ready', 'partial'].includes(result.status)) {
    if (result.summary !== null || result.coverage.kind !== 'unavailable' || result.coverage.fittings !== null || result.coverage.itemRecords !== null || result.fittings.length || result.types.length || result.hullCounts.length || result.itemPresence.length || result.flagCounts.length || fresh.state !== 'unknown' || fresh.retrievedAt !== null || fresh.cacheExpires !== null || fresh.lastModified !== null) throw invalid();
    return result;
  }
  if (!result.summary || result.coverage.kind !== 'returned_response' || fresh.retrievedAt === null || Date.parse(fresh.retrievedAt) > now + 60000 || fresh.state !== (fresh.cacheExpires === null ? 'unknown' : Date.parse(fresh.cacheExpires) <= now ? 'stale' : 'fresh')) throw invalid();
  const hulls = new Map<number, number>(), itemTypes = new Map<number, { fittings: number; itemRecords: number }>(), flagTotals = new Map<FittingFlagGroup, number>(groups.map(key => [key, 0]));
  let itemRecords = 0, emptyFittings = 0, emptyNames = 0, redactedNames = 0, truncatedNames = 0;
  for (const [index, fitting] of result.fittings.entries()) {
    if (fitting.row !== index + 1 || (fitting.nameState === 'redacted' ? fitting.name !== null || fitting.nameTruncated : fitting.name === null || fitting.nameTruncated && Array.from(fitting.name).length !== 256)) throw invalid();
    hulls.set(fitting.shipTypeId, (hulls.get(fitting.shipTypeId) ?? 0) + 1);
    emptyFittings += fitting.items.length === 0 ? 1 : 0; emptyNames += fitting.name === '' ? 1 : 0; redactedNames += fitting.nameState === 'redacted' ? 1 : 0; truncatedNames += fitting.nameTruncated ? 1 : 0;
    const seen = new Set<number>();
    for (const [position, item] of fitting.items.entries()) {
      if (item.row !== position + 1 || ++itemRecords > 10000) throw invalid();
      const totals = itemTypes.get(item.typeId) ?? { fittings: 0, itemRecords: 0 };
      totals.itemRecords++; if (!seen.has(item.typeId)) { totals.fittings++; seen.add(item.typeId); } itemTypes.set(item.typeId, totals);
      const key = group(item.flag); flagTotals.set(key, flagTotals.get(key)! + 1);
    }
  }
  const allTypes = [...new Set([...hulls.keys(), ...itemTypes.keys()])].sort((a, b) => a - b), hullIds = [...hulls.keys()].sort((a, b) => a - b), itemIds = [...itemTypes.keys()].sort((a, b) => a - b);
  if (result.types.length !== allTypes.length || result.types.some((row, index) => row.typeId !== allTypes[index] || (row.mapped ? !row.name || row.nameTruncated && Array.from(row.name).length !== 128 : row.name !== 'Type ' + row.typeId || row.nameTruncated))) throw invalid();
  if (result.hullCounts.length !== hullIds.length || result.hullCounts.some((row, index) => row.typeId !== hullIds[index] || row.fittings !== hulls.get(row.typeId))) throw invalid();
  if (result.itemPresence.length !== itemIds.length || result.itemPresence.some((row, index) => row.typeId !== itemIds[index] || row.fittings !== itemTypes.get(row.typeId)?.fittings || row.itemRecords !== itemTypes.get(row.typeId)?.itemRecords)) throw invalid();
  if (result.flagCounts.length !== groups.length || result.flagCounts.some((row, index) => row.group !== groups[index] || row.itemRecords !== flagTotals.get(row.group))) throw invalid();
  const labels = new Map(result.types.map(row => [row.typeId, row]));
  const expected = { fittings: result.fittings.length, itemRecords, shipTypes: hulls.size, itemTypes: itemTypes.size, emptyFittings, emptyNames, redactedNames, truncatedNames, unmappedShipTypes: hullIds.filter(typeId => !labels.get(typeId)!.mapped).length, unmappedItemTypes: itemIds.filter(typeId => !labels.get(typeId)!.mapped).length };
  if (Object.entries(expected).some(([key, total]) => result.summary![key as keyof typeof expected] !== total) || result.coverage.fittings !== result.fittings.length || result.coverage.itemRecords !== itemRecords || result.status !== (fresh.state === 'fresh' && !redactedNames && !truncatedNames ? 'ready' : 'partial')) throw invalid();
  return result;
}

async function readBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw invalid();
  const limit = 8 * 1024 * 1024, reader = response.body.getReader(); let buffer = new Uint8Array(16384), length = 0;
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
export async function savedFittingsRequest(args: SavedFittingsArgs, signal?: AbortSignal): Promise<SavedFittings> {
  const selected = selection(args), controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(abort, 60000); let response: Response | undefined;
  try {
    controller.signal.throwIfAborted(); response = await fetch('/api/eve/saved-fittings', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selected), signal: controller.signal }); controller.signal.throwIfAborted();
    if (!response.ok) throw new ConnectionResponseError(response.status === 401 ? 'Sign in again to read saved fittings.' : response.status === 404 ? 'This character is no longer connected. Reload connection status.' : 'Saved fittings could not be loaded. Try again or review the connection.', response.status);
    if (!response.headers.get('content-type')?.includes('application/json')) throw invalid();
    return savedFittingsResponse(await readBody(response, controller.signal), selected);
  } catch (error) {
    if (error instanceof ConnectionResponseError) throw error;
    throw new ConnectionResponseError(controller.signal.aborted ? 'The saved-fittings request was cancelled or timed out.' : 'The saved-fittings service could not be reached. Try again.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
}
