import { EveError, listConnections, readCorporationData } from './eve';
import { createBlueprintCollectionReader, validateBlueprintCollectionArgs, type AcceptedBlueprintIdentity } from './blueprint-collection';
import { projectInventoryAnalyticsPage } from './inventory-analytics';
import { findPublishedManufacturingItem } from './manufacturing-catalog';
import type { BlueprintAnalytics } from './blueprint-analytics-types';
import type { BlueprintCollection, BlueprintCollectionProgress } from './blueprint-collection-types';
import type { AssetBlueprintRow, BlueprintAssetStage, BlueprintReconciliation, BlueprintReconciliationProgress } from './blueprint-reconciliation-types';

type DatasetArgs = { characterId: number; dataset: string; parameters?: Record<string, unknown> };
type Dependencies = {
  connections: (user: string) => Promise<{ characterId: number; scopes: string[] }[]>;
  corporation: (user: string, args: DatasetArgs, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
};
type Options = { signal?: AbortSignal; onProgress?: (progress: BlueprintReconciliationProgress) => void };
type Raw = Record<string, unknown>;
const scope = 'esi-assets.read_corporation_assets.v1' as const;
const limit = 50000, pageLimit = 50;
const record = (value: unknown): value is Raw => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const assetFields = ['type_id', 'quantity', 'is_singleton', 'is_blueprint_copy', 'location_id', 'location_type', 'location_flag'] as const;
const signature = (row: Raw) => assetFields.map(field => row[field]);
const same = (left: unknown[], right: unknown[]) => left.every((value, index) => Object.is(value, right[index]));
const progress = (): BlueprintCollectionProgress => ({ pagesRead: 0, pagesExpected: null, rowsReceived: 0, uniqueRecords: 0, duplicateRecords: 0, pageLimit, rowLimit: limit });
const unknownFreshness = (): BlueprintAnalytics['freshness'] => ({ state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null });
const limitations = [
  'Two bounded read-only feeds are reconciled by item identifier in server request memory. Identifiers, locations, location flags and non-blueprint asset rows never leave this projection or enter a history store.',
  'The shared load has a 55-second deadline, at most 50 pages and 50,000 raw rows per feed, and at most 50,000 distinct blueprint records in the union. Reads are sequential without retries; a page exceeding a budget is excluded in full.',
  'An asset-only record is identified as a blueprint only by category 9 in the pinned public SDE. Unknown catalog types and contradictory copy flags on known non-blueprints remain unclassified, not invented holdings.',
  'Asset-only blueprint records have reported quantities and optional copy flags, but no research efficiency or remaining runs. Missing flags mean unknown. A false flag means reported not-copy, not researched original or guaranteed usable stock.',
  'Blueprint endpoint records are retained even when absent from assets. Matching item IDs count once; contradictory type, copy flag, singleton or physical quantity is marked as a source conflict and the blueprint endpoint evidence is retained separately.',
  'A compatible match compares only item type, physical quantity, singleton state and any reported copy flag. Cross-source locations are not compared or verified; matching does not establish location consistency or availability.',
  'The two endpoints have independent caches and timestamps. Agreement is not an atomic inventory snapshot, and absence from either feed is not proof of disposal. All advertised pages still do not guarantee all owned blueprints or recover missing ME, TE or copy runs.',
  'Blueprint endpoint ME/TE, kind and run charts cover only its accepted records. Reconciled type and overlap charts count distinct records, not physical blueprint units, production capacity, asset value or profit.',
  'Public type names and classifications use the pinned catalog without extra names, locations, containers or jobs queries. All results remain in memory for the current load and clear when the owner changes or the view closes.',
];
export const validateBlueprintReconciliationArgs = validateBlueprintCollectionArgs;
function blankAssets(status: BlueprintAssetStage['status'], message: string, stopReason: BlueprintAssetStage['coverage']['stopReason'] = 'not_started'): BlueprintAssetStage {
  return { status, message, scope, coverage: { ...progress(), kind: 'unavailable', completedPages: [], consistency: 'unknown', stopReason, failedPage: null, resultLimit: limit }, freshness: unknownFreshness() };
}
async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let cancel = () => {};
  const interrupted = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); });
  void interrupted.catch(() => {});
  try { const value = await Promise.race([work(), interrupted]); signal.throwIfAborted(); return value; }
  finally { signal.removeEventListener('abort', cancel); }
}
function weakestFreshness(pages: BlueprintAnalytics['freshness'][], completed: number, consistency: BlueprintAssetStage['coverage']['consistency']): BlueprintAnalytics['freshness'] {
  if (!pages.length) return unknownFreshness();
  const times = pages.map(value => value.cacheExpires === null ? null : Date.parse(value.cacheExpires));
  const known = times.filter((value): value is number => value !== null), earliest = known.length ? Math.min(...known) : null;
  const stale = earliest !== null && earliest <= completed;
  const cacheExpires = earliest === null || !stale && times.some(value => value === null) ? null : new Date(earliest).toISOString();
  return { state: stale ? 'stale' : cacheExpires === null ? 'unknown' : 'fresh', retrievedAt: pages[0].retrievedAt, cacheExpires, lastModified: consistency === 'consistent' ? pages[0].lastModified : null };
}
function finish(blueprints: BlueprintCollection, assets: BlueprintAssetStage, assetsOnly: AssetBlueprintRow[], relationships: BlueprintReconciliation['relationships'], unclassifiedAssetRecords: number, nonBlueprintAssetRecords: number, corporationId: number | null, completed: number): BlueprintReconciliation {
  blueprints = { ...blueprints, generatedAt: new Date(completed).toISOString() };
  if (blueprints.freshness.cacheExpires !== null && Date.parse(blueprints.freshness.cacheExpires) <= completed && blueprints.freshness.state !== 'stale') {
    blueprints = { ...blueprints, status: blueprints.status === 'ready' ? 'partial' : blueprints.status, freshness: { ...blueprints.freshness, state: 'stale' }, message: 'Blueprint endpoint pages were collected; source freshness at reconciliation completion is stale.' };
  }
  const blueprintRecords = blueprints.blueprints.length, matchedRecords = relationships.filter(value => value.status === 'matched').length, conflictingRecords = relationships.length - matchedRecords;
  const summary = { blueprintRecords, assetBlueprintRecords: relationships.length + assetsOnly.length, matchedRecords, conflictingRecords, blueprintOnlyRecords: blueprintRecords - relationships.length, assetOnlyRecords: assetsOnly.length, unclassifiedAssetRecords, nonBlueprintAssetRecords, unionRecords: blueprintRecords + assetsOnly.length };
  const types = new Map<number, BlueprintReconciliation['typeCounts'][number]>();
  for (const row of blueprints.typeCounts) types.set(row.typeId, { typeId: row.typeId, name: row.name, blueprintRecords: row.records, assetOnlyRecords: 0, records: row.records });
  const kindCounts: BlueprintReconciliation['kindCounts'] = [{ copyStatus: 'copy', count: 0 }, { copyStatus: 'not_copy', count: 0 }, { copyStatus: 'unknown', count: 0 }];
  for (const row of assetsOnly) {
    const type = types.get(row.typeId) ?? { typeId: row.typeId, name: row.name, blueprintRecords: 0, assetOnlyRecords: 0, records: 0 };
    type.assetOnlyRecords++; type.records++; types.set(row.typeId, type); kindCounts.find(value => value.copyStatus === row.copyStatus)!.count++;
  }
  const ready = blueprints.status === 'ready' && assets.status === 'ready' && conflictingRecords === 0 && unclassifiedAssetRecords === 0;
  const anyAccepted = blueprints.coverage.pagesRead > 0 || assets.coverage.pagesRead > 0;
  const status: BlueprintReconciliation['status'] = ready ? 'ready' : anyAccepted ? 'partial' : blueprints.status === 'needs_permission' && assets.status === 'needs_permission' ? 'needs_permission' : blueprints.status === 'error' || assets.status === 'error' ? 'error' : 'unavailable';
  return { characterId: blueprints.characterId, entity: 'corporation', corporationId, generatedAt: new Date(completed).toISOString(), status,
    message: `Reconciled accepted records from two independent API feeds. ${assetsOnly.length} asset-only blueprint records supplement ${blueprintRecords} blueprint endpoint records. Missing research details remain unknown; complete owned-library coverage is not established.`,
    blueprints, assets, assetsOnly, relationships: relationships.sort((a, b) => a.row - b.row), summary,
    typeCounts: [...types.values()].sort((a, b) => b.records - a.records || a.typeId - b.typeId), kindCounts, limitations: [...limitations] };
}

/** Request-local union. The accepted identity hook is never serialized to clients. */
export function createBlueprintReconciliationReader(dependencies: Dependencies) {
  return async (user: string, input: unknown, options: Options = {}): Promise<BlueprintReconciliation> => {
    const args = validateBlueprintCollectionArgs(input), now = dependencies.now ?? Date.now;
    if (typeof user !== 'string' || !user) throw new EveError('Sign in to this private connector first.', 401);
    const deadlineAt = now() + 55000, signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    signal.throwIfAborted();
    const stop = (): 'cancelled' | 'deadline' => options.signal?.aborted ? 'cancelled' : 'deadline';
    let connectionRows: { characterId: number; scopes: string[] }[] = [], connectionError: unknown;
    try { connectionRows = await abortable(() => dependencies.connections(user), signal); } catch (error) { connectionError = error; }
    const identities = new Map<number, AcceptedBlueprintIdentity>(), blueprintFreshness: BlueprintAnalytics['freshness'][] = [], assetFreshness: BlueprintAnalytics['freshness'][] = []; let bpProgress = progress();
    const blueprintReader = createBlueprintCollectionReader({ ...dependencies,
      connections: async () => { if (connectionError) throw connectionError; return connectionRows; },
      corporation: async (owner, selected, requestSignal) => {
        if (signal.aborted || now() >= deadlineAt) throw new EveError('The shared collection time limit was reached.', 408);
        return dependencies.corporation(owner, selected, requestSignal);
      },
    });
    const blueprints = await blueprintReader(user, args, { signal, deadlineAt,
      onAcceptedItems: (items, freshness) => { for (const item of items) identities.set(item.itemId, item); blueprintFreshness.push(freshness); },
      onProgress: value => { bpProgress = value; options.onProgress?.({ phase: 'blueprints', blueprints: value, assets: progress() }); },
    });
    bpProgress = { pagesRead: blueprints.coverage.pagesRead, pagesExpected: blueprints.coverage.pagesExpected, rowsReceived: blueprints.coverage.rowsReceived, uniqueRecords: blueprints.coverage.uniqueRecords, duplicateRecords: blueprints.coverage.duplicateRecords, pageLimit, rowLimit: limit };
    let corporationId = blueprints.corporationId;
    const finalize = (assets: BlueprintAssetStage, assetsOnly: AssetBlueprintRow[] = [], relationships: BlueprintReconciliation['relationships'] = [], unclassified = 0, other = 0): BlueprintReconciliation => {
      const result = finish(blueprints, assets, assetsOnly, relationships, unclassified, other, corporationId, now());
      // All return paths account for synchronous aggregation and each known page
      // expiry, even when another page had unknown cache metadata.
      const completed = now();
      result.blueprints.freshness = weakestFreshness(blueprintFreshness, completed, result.blueprints.coverage.consistency);
      result.assets.freshness = weakestFreshness(assetFreshness, completed, result.assets.coverage.consistency);
      if (result.blueprints.status === 'ready' && result.blueprints.freshness.state !== 'fresh') result.blueprints.status = 'partial';
      if (result.assets.status === 'ready' && result.assets.freshness.state !== 'fresh') result.assets.status = 'partial';
      if (result.blueprints.freshness.state === 'stale') result.blueprints.message = 'Blueprint endpoint pages were collected; source freshness at reconciliation completion is stale.';
      if (result.status === 'ready' && (result.blueprints.status !== 'ready' || result.assets.status !== 'ready')) result.status = 'partial';
      if (signal.aborted || completed >= deadlineAt) {
        result.assets.coverage.stopReason = stop();
        result.assets.message = 'The reconciliation reached its shared time limit or was cancelled. Only accepted pages remain visible.';
        if (result.assets.coverage.pagesRead) { result.assets.coverage.kind = result.assets.coverage.consistency === 'inconsistent' ? 'partial' : result.assets.coverage.consistency === 'unknown' || result.assets.coverage.pagesExpected === null ? 'unknown' : 'partial'; result.assets.status = 'partial'; }
        else if (result.assets.status !== 'needs_permission') result.assets.status = 'unavailable';
      }
      const ready = result.blueprints.status === 'ready' && result.assets.status === 'ready' && result.summary.conflictingRecords === 0 && result.summary.unclassifiedAssetRecords === 0;
      const anyAccepted = result.blueprints.coverage.pagesRead > 0 || result.assets.coverage.pagesRead > 0;
      result.status = ready ? 'ready' : anyAccepted ? 'partial' : result.blueprints.status === 'needs_permission' && result.assets.status === 'needs_permission' ? 'needs_permission' : result.blueprints.status === 'error' || result.assets.status === 'error' ? 'error' : 'unavailable';
      result.generatedAt = new Date(completed).toISOString(); result.blueprints.generatedAt = result.generatedAt;
      return result;
    };
    const connection = connectionRows.find(value => value.characterId === args.characterId);
    if (!connection?.scopes.includes(scope)) return finalize(blankAssets(connectionError ? 'unavailable' : 'needs_permission', connectionError ? 'Connection status could not be checked; assets were not read.' : 'The corporation asset read permission is missing. No permission is added automatically.'));
    if (signal.aborted || now() >= deadlineAt) return finalize(blankAssets('unavailable', 'The shared collection was cancelled or reached its time limit before assets were read.', stop()));
    if (blueprints.status !== 'needs_permission' && !['complete', 'missing_page_count', 'page_limit', 'row_limit'].includes(blueprints.coverage.stopReason)) {
      return finalize(blankAssets('unavailable', 'Asset reads were not started because the blueprint stage stopped on a failed or inconsistent read.'));
    }
    options.onProgress?.({ phase: 'assets', blueprints: bpProgress, assets: progress() });
    const seen = new Map<number, unknown[]>(), assetsOnly: AssetBlueprintRow[] = [], relationships: BlueprintReconciliation['relationships'] = [], accepted = assetFreshness;
    const catalog = new Map<number, ReturnType<typeof findPublishedManufacturingItem>>();
    let pagesExpected: number | null = null, rowsReceived = 0, duplicateRecords = 0, unclassified = 0, nonBlueprints = 0, snapshot: string | null = null, missingSnapshot = false, inconsistent = false;
    let stopReason: BlueprintAssetStage['coverage']['stopReason'] = 'complete', failedPage: number | null = null, firstStatus: BlueprintAssetStage['status'] = 'error';
    const assetsProgress = (): BlueprintCollectionProgress => ({ pagesRead: accepted.length, pagesExpected, rowsReceived, uniqueRecords: seen.size, duplicateRecords, pageLimit, rowLimit: limit });
    for (let page = 1; page <= pageLimit; page++) {
      if (signal.aborted || now() >= deadlineAt) { stopReason = stop(); break; }
      let response: unknown;
      try { response = await abortable(() => dependencies.corporation(user, { characterId: args.characterId, dataset: 'assets', parameters: { page } }, signal), signal); }
      catch (error) { stopReason = signal.aborted ? stop() : 'provider_error'; failedPage = page; firstStatus = signal.aborted || error instanceof EveError && [401, 403, 404, 409, 429].includes(error.status) ? 'unavailable' : 'error'; break; }
      if (!record(response) || !Array.isArray(response.data) || response.data.length > 1000 || !record(response.pagination)) { stopReason = 'invalid_page'; failedPage = page; break; }
      if (corporationId !== null && response.corporationId !== corporationId) { stopReason = 'corporation_changed'; failedPage = page; inconsistent = true; break; }
      const pagination = response.pagination;
      if (pagination.kind !== 'page' || pagination.page !== page || ['after', 'before', 'nextFromId', 'nextBeforeId', 'nextFromEvent'].some(key => pagination[key] != null) || pagination.pages !== null && !id(pagination.pages)) { stopReason = 'invalid_page'; failedPage = page; break; }
      if (accepted.length && pagination.pages !== pagesExpected) { stopReason = 'pagination_changed'; failedPage = page; inconsistent = true; break; }
      if (rowsReceived + response.data.length > limit) { stopReason = 'row_limit'; failedPage = page; break; }
      const uniquePage = new Map<number, Raw>(); let malformed = false, conflict = false;
      for (const row of response.data) {
        if (!record(row) || !id(row.item_id)) { malformed = true; break; }
        const prior = uniquePage.get(row.item_id), earlier = seen.get(row.item_id);
        if (prior && !same(signature(prior), signature(row)) || earlier && !same(earlier, signature(row))) { conflict = true; break; }
        if (!prior) uniquePage.set(row.item_id, row);
      }
      if (malformed || conflict) { stopReason = conflict ? 'conflicting_duplicate' : 'invalid_page'; failedPage = page; inconsistent ||= conflict; break; }
      let projected: ReturnType<typeof projectInventoryAnalyticsPage>;
      try { projected = projectInventoryAnalyticsPage({ characterId: args.characterId, entity: 'corporation', page }, { ...response, data: [...uniquePage.values()], page, pages: pagination.pages, nextPage: pagination.nextPage, pageLimit: pagination.pageLimit, morePagesAvailable: pagination.morePagesAvailable, pageLimitReached: pagination.pageLimitReached }, now()); }
      catch { stopReason = 'invalid_page'; failedPage = page; break; }
      if (projected.freshness.lastModified !== null && snapshot !== null && projected.freshness.lastModified !== snapshot) { stopReason = 'snapshot_changed'; failedPage = page; inconsistent = true; break; }
      const additions: AssetBlueprintRow[] = [], matches: BlueprintReconciliation['relationships'] = []; let unknown = 0, other = 0;
      for (const [itemId, row] of uniquePage) {
        if (seen.has(itemId)) continue;
        const match = identities.get(itemId), typeId = row.type_id as number;
        if (match) {
          const blueprint = match.blueprint;
          const mismatch = blueprint.typeId !== typeId || blueprint.units !== row.quantity || row.is_blueprint_copy !== undefined && row.is_blueprint_copy !== (blueprint.kind === 'copy') ||
            row.is_singleton !== (blueprint.kind !== 'original_stack');
          matches.push({ row: blueprint.row, status: mismatch ? 'conflict' : 'matched' }); continue;
        }
        if (!catalog.has(typeId)) catalog.set(typeId, findPublishedManufacturingItem(typeId));
        const item = catalog.get(typeId);
        if (!item || item.categoryId !== 9 && row.is_blueprint_copy === true) { unknown++; continue; }
        if (item.categoryId !== 9) { other++; continue; }
        const name = item.name;
        if (typeof name !== 'string' || !name || name.length > 512 || name.trim() !== name || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(name)) { unknown++; continue; }
        additions.push({ row: assetsOnly.length + additions.length + 1, typeId, name, catalogMapped: true, copyStatus: row.is_blueprint_copy === true ? 'copy' : row.is_blueprint_copy === false ? 'not_copy' : 'unknown', quantity: row.quantity as number, isSingleton: row.is_singleton as boolean });
      }
      if (blueprints.blueprints.length + assetsOnly.length + additions.length > limit) { stopReason = 'result_limit'; failedPage = page; break; }
      if (signal.aborted || now() >= deadlineAt) { stopReason = stop(); failedPage = page; break; }
      const priorSize = seen.size;
      for (const [itemId, row] of uniquePage) if (!seen.has(itemId)) seen.set(itemId, signature(row));
      assetsOnly.push(...additions); relationships.push(...matches); unclassified += unknown; nonBlueprints += other;
      const duplicates = response.data.length - (seen.size - priorSize); duplicateRecords += duplicates; inconsistent ||= duplicates > 0; rowsReceived += response.data.length;
      corporationId = projected.corporationId; pagesExpected = projected.coverage.pages; accepted.push(projected.freshness);
      if (projected.freshness.lastModified === null) missingSnapshot = true; else snapshot ??= projected.freshness.lastModified;
      options.onProgress?.({ phase: 'assets', blueprints: bpProgress, assets: assetsProgress() });
      if (signal.aborted || now() >= deadlineAt) { stopReason = stop(); break; }
      if (pagesExpected === null) { stopReason = 'missing_page_count'; break; }
      if (page === pagesExpected) break;
      if (page === pageLimit) { stopReason = 'page_limit'; break; }
      if (rowsReceived === limit) { stopReason = 'row_limit'; break; }
    }
    const completed = now(); if (signal.aborted || completed >= deadlineAt) stopReason = stop();
    const consistency = inconsistent ? 'inconsistent' : missingSnapshot ? 'unknown' : 'consistent';
    const allPages = stopReason === 'complete' && pagesExpected !== null && accepted.length === pagesExpected;
    const kind: BlueprintAssetStage['coverage']['kind'] = !accepted.length ? 'unavailable' : inconsistent ? 'partial' : missingSnapshot || pagesExpected === null ? 'unknown' : allPages ? 'all_reported_pages' : 'partial';
    const freshness = weakestFreshness(accepted, completed, consistency);
    const assets: BlueprintAssetStage = { status: accepted.length ? kind === 'all_reported_pages' && freshness.state === 'fresh' ? 'ready' : 'partial' : stopReason === 'cancelled' || stopReason === 'deadline' ? 'unavailable' : firstStatus,
      message: `Asset collection ${stopReason === 'complete' ? 'read all advertised pages' : 'stopped: ' + stopReason.replaceAll('_', ' ')}. Only validated accepted pages contribute; unclassified types remain explicit and missing research fields are not inferred.`, scope,
      coverage: { ...assetsProgress(), kind, completedPages: accepted.map((_value, index) => index + 1), consistency: accepted.length ? consistency : 'unknown', stopReason, failedPage, resultLimit: limit }, freshness };
    return finalize(assets, assetsOnly, relationships, unclassified, nonBlueprints);
  };
}
export const readBlueprintReconciliation = createBlueprintReconciliationReader({ connections: listConnections, corporation: readCorporationData });
