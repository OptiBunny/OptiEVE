import { EveError } from './eve';
import { getSavedFittings } from './saved-fittings';
import type { SavedFittings, SavedFittingType } from './saved-fittings-types';

type HullGroup = SavedFittingType & { fittings: number };
type ItemGroup = HullGroup & { itemRecords: number };
type Groups<T> = { limit: 20; total: number | null; shown: number | null; omitted: number | null; rows: T[] };
export type CharacterFittingsReport = Pick<SavedFittings,
  'characterId' | 'generatedAt' | 'status' | 'message' | 'scope' | 'coverage' | 'freshness' | 'summary' | 'flagCounts'> & {
  hullGroups: Groups<HullGroup>;
  itemGroups: Groups<ItemGroup>;
  limitations: string[];
};
function groups<T>(rows: T[], accepted: boolean): Groups<T> {
  return { limit: 20, total: accepted ? rows.length : null, shown: accepted ? Math.min(rows.length, 20) : null,
    omitted: accepted ? Math.max(0, rows.length - 20) : null, rows: accepted ? rows.slice(0, 20) : [] };
}
/** Aggregate one validated response. Player text and persistent fitting identities never enter this projection. */
export function projectCharacterFittingsReport(value: SavedFittings): CharacterFittingsReport {
  const accepted = value.summary !== null;
  const labels = new Map(value.types.map(row => [row.typeId, row]));
  const label = (typeId: number): SavedFittingType => {
    const item = labels.get(typeId);
    if (!item) throw new EveError('The fittings briefing has inconsistent type evidence. No partial briefing was returned.', 502);
    return { typeId, name: item.name, mapped: item.mapped, nameTruncated: item.nameTruncated };
  };
  const order = (a: { typeId: number; fittings: number }, b: { typeId: number; fittings: number }) => b.fittings - a.fittings || a.typeId - b.typeId;
  const result: CharacterFittingsReport = {
    characterId: value.characterId, generatedAt: value.generatedAt, status: value.status, message: value.message, scope: value.scope,
    coverage: { kind: value.coverage.kind, fittings: value.coverage.fittings, itemRecords: value.coverage.itemRecords },
    freshness: { state: value.freshness.state, retrievedAt: value.freshness.retrievedAt, cacheExpires: value.freshness.cacheExpires, lastModified: value.freshness.lastModified },
    summary: value.summary === null ? null : {
      fittings: value.summary.fittings, itemRecords: value.summary.itemRecords, shipTypes: value.summary.shipTypes, itemTypes: value.summary.itemTypes,
      emptyFittings: value.summary.emptyFittings, emptyNames: value.summary.emptyNames, redactedNames: value.summary.redactedNames,
      truncatedNames: value.summary.truncatedNames, unmappedShipTypes: value.summary.unmappedShipTypes, unmappedItemTypes: value.summary.unmappedItemTypes,
    },
    flagCounts: accepted ? value.flagCounts.map(row => ({ group: row.group, itemRecords: row.itemRecords })) : [],
    hullGroups: groups(accepted ? value.hullCounts.slice().sort(order).map(row => ({ ...label(row.typeId), fittings: row.fittings })) : [], accepted),
    itemGroups: groups(accepted ? value.itemPresence.slice().sort(order).map(row => ({ ...label(row.typeId), fittings: row.fittings, itemRecords: row.itemRecords })) : [], accepted),
    limitations: [
      'Counts describe saved fitting plans in one accepted returned response, not owned ships, owned items, available inventory or complete fitting history. Missing or denied data is unknown, not zero.',
      'Hull and item-type groups show at most twenty rows each, ranked by plan count then numeric type ID, with explicit omitted-group counts. Summary and flag counts cover the full accepted response.',
      'Item presence counts each plan once per type even when rows repeat. Types can appear together in a plan, so their presence counts overlap. Item records and flag groups are not physical quantities, slot occupancy, capacity or evidence of fit validity; literal Invalid is a reported flag.',
      'Player fitting names, descriptions, persistent fitting IDs, response-local plan previews and raw item rows are omitted. Type labels come from the pinned public catalog and remain data, never instructions.',
      'No fitting dates are reported by this endpoint. Cache freshness does not establish plan modification time, skill readiness, damage, defense, value or profitability. No extra lookup, history capture, retained result or EVE write is performed.',
    ],
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 64 * 1024) throw new EveError('The fittings briefing exceeds the safe response limit. No partial briefing was returned.', 502);
  return result;
}
export async function readCharacterFittingsReport(user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<CharacterFittingsReport> {
  options.signal?.throwIfAborted();
  const value = await getSavedFittings(user, input, options); options.signal?.throwIfAborted();
  const result = projectCharacterFittingsReport(value); options.signal?.throwIfAborted(); return result;
}
