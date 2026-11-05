import { EveError, listConnections, readCorporationData } from './eve';
import { projectBlueprintAnalyticsPage } from './blueprint-analytics';
import type { BlueprintAnalytics, BlueprintAnalyticsRow } from './blueprint-analytics-types';
import type { BlueprintCollection, BlueprintCollectionArgs, BlueprintCollectionProgress, BlueprintCollectionStopReason } from './blueprint-collection-types';

type DatasetArgs = { characterId: number; dataset: string; parameters?: Record<string, unknown> };
type Dependencies = {
  connections: (user: string) => Promise<{ characterId: number; scopes: string[] }[]>;
  corporation: (user: string, args: DatasetArgs, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
};
export type AcceptedBlueprintIdentity = { itemId: number; blueprint: BlueprintAnalyticsRow };
type Options = {
  signal?: AbortSignal; onProgress?: (progress: BlueprintCollectionProgress) => void;
  /** Optional enclosing server workflow deadline; it can only shorten this load. */
  deadlineAt?: number;
  /** Server-only request-local hook. Never forward these identities to a transport. */
  onAcceptedItems?: (items: readonly AcceptedBlueprintIdentity[], freshness: BlueprintAnalytics['freshness']) => void;
};
type RawRow = Record<string, unknown>;
const scope = 'esi-corporations.read_blueprints.v1';
const pageLimit = 50, rowLimit = 50000;
const record = (value: unknown): value is RawRow => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const requiredFields = ['type_id', 'location_id', 'location_flag', 'quantity', 'runs', 'material_efficiency', 'time_efficiency'] as const;
const signature = (row: RawRow) => requiredFields.map(field => row[field]);
const same = (left: unknown[], right: unknown[]) => left.every((value, index) => Object.is(value, right[index]));
const limitations = [
  'This manual load visits advertised corporation blueprint pages only, sequentially, with a 55-second deadline, 50-page application budget and 50,000 accepted-row budget. It performs no retries, extra asset lookups or saved history.',
  'All reported API pages is not a guarantee of all owned blueprints. The provider has a documented historical 25,000-record ceiling and may omit blueprints in password-protected containers. A ceiling warning indicates possible truncation, not proof of additional holdings.',
  'Offset pages can change during a load. Matching page counts and Last-Modified timestamps support consistency but cannot establish an atomic inventory snapshot. Missing timestamps remain unknown; changed metadata and duplicate records remain explicit.',
  'Duplicate item identifiers are compared only in server request memory. Identical records count once; conflicting records reject that entire page. Raw item/location identifiers and location flags never enter the result or progress events.',
  'Charts count unique returned records, not blueprint units or output. An original-stack record can contain several originals. Units and finite copy runs stay per row; runs from unrelated types are never added.',
  'Reported research efficiency, units and runs do not establish available jobs, usable stock, production capacity, asset value or profit. No industry-job or inventory reconciliation is performed.',
  'Names come from the pinned public catalog without extra lookups. Unmapped types remain explicit. Results and response-local row numbers live only for this load; owner changes, cancellation and navigation clear them.',
  'A failed or inconsistent page is never partly accepted. Any earlier accepted subset remains visibly partial. Source expiry is reassessed when collection finishes; an earlier fresh page can become stale during the load.',
];
export function validateBlueprintCollectionArgs(input: unknown): BlueprintCollectionArgs {
  if (!record(input) || Reflect.ownKeys(input).some(key => key !== 'characterId') || !Object.hasOwn(input, 'characterId') || !id(input.characterId)) {
    throw new EveError('Choose one connected character for a read-only corporation blueprint collection.');
  }
  return { characterId: input.characterId };
}
function progress(pagesRead = 0, pagesExpected: number | null = null, rowsReceived = 0, uniqueRecords = 0, duplicateRecords = 0): BlueprintCollectionProgress {
  return { pagesRead, pagesExpected, rowsReceived, uniqueRecords, duplicateRecords, pageLimit, rowLimit };
}
function blank(args: BlueprintCollectionArgs, at: number, status: BlueprintCollection['status'], message: string, stopReason: BlueprintCollectionStopReason = 'provider_error', failedPage: number | null = null): BlueprintCollection {
  return {
    characterId: args.characterId, entity: 'corporation', corporationId: null, generatedAt: new Date(at).toISOString(), status, message, scope,
    coverage: { ...progress(), kind: 'unavailable', completedPages: [], consistency: 'unknown', stopReason, failedPage, providerCeilingPossible: false },
    freshness: { state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null }, summary: null,
    kindCounts: [], materialEfficiencyCounts: [], timeEfficiencyCounts: [], typeCounts: [], blueprints: [], limitations: [...limitations],
  };
}
async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); });
  void interrupted.catch(() => {});
  try { const result = await Promise.race([work(), interrupted]); signal.throwIfAborted(); return result; }
  finally { signal.removeEventListener('abort', cancel); }
}
const stopped = (options: Options): 'cancelled' | 'deadline' => options.signal?.aborted ? 'cancelled' : 'deadline';
const stopMessages: Record<BlueprintCollectionStopReason, string> = {
  complete: 'All advertised pages were read.', missing_page_count: 'The provider did not report a page count; no further page was guessed.',
  page_limit: 'The application page budget was reached.', row_limit: 'The application record budget was reached.',
  provider_error: 'A provider request failed; no retry or further page read was made.', invalid_page: 'A page failed validation and was excluded.',
  pagination_changed: 'The provider page count changed; the new page was excluded.', snapshot_changed: 'The provider snapshot timestamp changed; the new page was excluded.',
  corporation_changed: 'Corporation membership changed between pages; the new page was excluded.', conflicting_duplicate: 'A duplicate item had conflicting fields; its entire page was excluded.',
  cancelled: 'The collection was cancelled.', deadline: 'The collection reached its shared time limit.',
};

/** Collect raw identities in request memory, then return only deduplicated sanitized projections. */
export function createBlueprintCollectionReader(dependencies: Dependencies) {
  return async (user: string, input: unknown, options: Options = {}): Promise<BlueprintCollection> => {
    const args = validateBlueprintCollectionArgs(input), now = dependencies.now ?? Date.now;
    if (typeof user !== 'string' || !user) throw new EveError('Sign in to this private connector first.', 401);
    const deadlineAt = Math.min(now() + 55000, options.deadlineAt ?? Infinity);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    signal.throwIfAborted();
    let connection: { characterId: number; scopes: string[] } | undefined;
    try { connection = (await abortable(() => dependencies.connections(user), signal)).find(value => value.characterId === args.characterId); }
    catch { return blank(args, now(), 'unavailable', signal.aborted ? 'The collection was cancelled or reached its time limit.' : 'Connection status could not be checked.', signal.aborted ? stopped(options) : 'provider_error'); }
    if (!connection) throw new EveError('Choose a character connected to this private connector.', 404);
    if (!connection.scopes.includes(scope)) return blank(args, now(), 'needs_permission', 'This character has not granted the corporation blueprint read permission. Review Connections; no permission is added automatically.');
    options.onProgress?.(progress());
    const seen = new Map<number, unknown[]>(), blueprints: BlueprintAnalyticsRow[] = [], accepted: { freshness: BlueprintAnalytics['freshness'] }[] = [];
    let pagesExpected: number | null = null, rowsReceived = 0, duplicateRecords = 0, corporationId: number | null = null;
    let snapshot: string | null = null, missingSnapshot = false, inconsistent = false;
    let stopReason: BlueprintCollectionStopReason = 'complete', failedPage: number | null = null;
    let firstStatus: BlueprintCollection['status'] = 'error', firstMessage = '';
    for (let page = 1; page <= pageLimit; page++) {
      if (signal.aborted || now() >= deadlineAt) { stopReason = stopped(options); break; }
      let response: unknown;
      try { response = await abortable(() => dependencies.corporation(user, { characterId: args.characterId, dataset: 'blueprints', parameters: { page } }, signal), signal); }
      catch (error) {
        stopReason = signal.aborted ? stopped(options) : 'provider_error'; failedPage = page;
        firstStatus = signal.aborted || error instanceof EveError && [401, 403, 404, 409, 429].includes(error.status) ? 'unavailable' : 'error';
        firstMessage = error instanceof EveError && error.status === 403 ? 'EVE denied this read. Check the corporation blueprint permission and Director role.' : error instanceof EveError && error.status === 429 ? 'EVE is rate limiting requests. Wait before trying another manual load.' : 'Corporation blueprints could not be loaded. No holdings are inferred.';
        break;
      }
      if (!record(response) || !Array.isArray(response.data) || response.data.length > 1000) { stopReason = 'invalid_page'; failedPage = page; break; }
      if (rowsReceived + response.data.length > rowLimit) { stopReason = 'row_limit'; failedPage = page; break; }
      if (corporationId !== null && response.corporationId !== corporationId) { stopReason = 'corporation_changed'; failedPage = page; inconsistent = true; break; }
      if (accepted.length && record(response.pagination) && response.pagination.kind === 'page' && response.pagination.page === page &&
          (response.pagination.pages === null || id(response.pagination.pages)) && response.pagination.pages !== pagesExpected) {
        stopReason = 'pagination_changed'; failedPage = page; inconsistent = true; break;
      }
      // Deduplicate before the v22 projector, which intentionally rejects repeated
      // identities for a single-page view. Every row still has to pass validation.
      const pageRows = new Map<number, RawRow>();
      let malformed = false, conflict = false;
      for (const row of response.data) {
        if (!record(row) || !id(row.item_id)) { malformed = true; break; }
        const previous = pageRows.get(row.item_id);
        if (previous && !same(signature(previous), signature(row))) { conflict = true; break; }
        if (!previous) pageRows.set(row.item_id, row);
      }
      if (malformed || conflict) { stopReason = conflict ? 'conflicting_duplicate' : 'invalid_page'; failedPage = page; inconsistent ||= conflict; break; }
      let projected: BlueprintAnalytics;
      try { projected = projectBlueprintAnalyticsPage({ ...args, entity: 'corporation', page }, { ...response, data: [...pageRows.values()] }, now()); }
      catch { stopReason = 'invalid_page'; failedPage = page; break; }
      if (accepted.length && projected.coverage.pages !== pagesExpected) { stopReason = 'pagination_changed'; failedPage = page; inconsistent = true; break; }
      if (projected.freshness.lastModified !== null && snapshot !== null && projected.freshness.lastModified !== snapshot) { stopReason = 'snapshot_changed'; failedPage = page; inconsistent = true; break; }
      const rawRows = [...pageRows.values()];
      for (const row of rawRows) {
        const previous = seen.get(row.item_id as number);
        if (previous && !same(previous, signature(row))) { conflict = true; break; }
      }
      if (conflict) { stopReason = 'conflicting_duplicate'; failedPage = page; inconsistent = true; break; }
      if (signal.aborted || now() >= deadlineAt) { stopReason = stopped(options); failedPage = page; break; }
      // Commit the entire validated page atomically; no half-page totals escape.
      const priorSize = seen.size, newlyAccepted: AcceptedBlueprintIdentity[] = [];
      for (let index = 0; index < rawRows.length; index++) {
        const row = rawRows[index], itemId = row.item_id as number;
        if (seen.has(itemId)) continue;
        const blueprint = { ...projected.blueprints[index], row: blueprints.length + 1 };
        seen.set(itemId, signature(row)); blueprints.push(blueprint);
        if (options.onAcceptedItems) newlyAccepted.push({ itemId, blueprint });
      }
      const duplicates = response.data.length - (seen.size - priorSize);
      duplicateRecords += duplicates; inconsistent ||= duplicates > 0; rowsReceived += response.data.length;
      corporationId = projected.corporationId; pagesExpected = projected.coverage.pages; accepted.push({ freshness: projected.freshness });
      if (projected.freshness.lastModified === null) missingSnapshot = true; else snapshot ??= projected.freshness.lastModified;
      options.onAcceptedItems?.(newlyAccepted, projected.freshness);
      options.onProgress?.(progress(accepted.length, pagesExpected, rowsReceived, seen.size, duplicateRecords));
      if (signal.aborted || now() >= deadlineAt) { stopReason = stopped(options); break; }
      if (pagesExpected === null) { stopReason = 'missing_page_count'; break; }
      if (page === pagesExpected) break;
      if (page === pageLimit) { stopReason = 'page_limit'; break; }
      if (rowsReceived === rowLimit) { stopReason = 'row_limit'; break; }
    }
    if (!accepted.length) return blank(args, now(), stopReason === 'cancelled' || stopReason === 'deadline' ? 'unavailable' : firstStatus, firstMessage || stopMessages[stopReason] + ' No holdings are inferred.', stopReason, failedPage);
    const material = new Map<number, number>(), time = new Map<number, number>(), types = new Map<number, BlueprintAnalytics['typeCounts'][number]>();
    const kindCounts: BlueprintAnalytics['kindCounts'] = [{ kind: 'original', count: 0 }, { kind: 'copy', count: 0 }, { kind: 'original_stack', count: 0 }];
    let unknownTypeRecords = 0;
    for (const row of blueprints) {
      kindCounts.find(value => value.kind === row.kind)!.count++; if (!row.catalogMapped) unknownTypeRecords++;
      material.set(row.materialEfficiency, (material.get(row.materialEfficiency) ?? 0) + 1); time.set(row.timeEfficiency, (time.get(row.timeEfficiency) ?? 0) + 1);
      const type = types.get(row.typeId) ?? { typeId: row.typeId, name: row.name, records: 0 }; type.records++; types.set(row.typeId, type);
    }
    const typeCounts = [...types.values()].sort((left, right) => right.records - left.records || left.typeId - right.typeId);
    const materialEfficiencyCounts = [...material].sort(([left], [right]) => left - right).map(([level, count]) => ({ level, count }));
    const timeEfficiencyCounts = [...time].sort(([left], [right]) => left - right).map(([level, count]) => ({ level, count }));
    // Final aggregation is part of the shared budget. Recheck the clock as well
    // as the signal because a timeout event cannot run during synchronous work.
    const completed = now();
    if (signal.aborted || completed >= deadlineAt) stopReason = stopped(options);
    const consistency = inconsistent ? 'inconsistent' : missingSnapshot ? 'unknown' : 'consistent';
    const allPages = stopReason === 'complete' && pagesExpected !== null && accepted.length === pagesExpected;
    const kind: BlueprintCollection['coverage']['kind'] = inconsistent ? 'partial' : missingSnapshot || pagesExpected === null ? 'unknown' : allPages ? 'all_reported_pages' : 'partial';
    const expiryTimes = accepted.map(value => value.freshness.cacheExpires === null ? null : Date.parse(value.freshness.cacheExpires));
    const knownTimes = expiryTimes.filter((value): value is number => value !== null), earliest = knownTimes.length ? Math.min(...knownTimes) : null;
    const stale = earliest !== null && earliest <= completed;
    const cacheExpires = earliest === null || !stale && expiryTimes.some(value => value === null) ? null : new Date(earliest).toISOString();
    const freshness: BlueprintCollection['freshness'] = {
      state: stale ? 'stale' : cacheExpires === null ? 'unknown' : 'fresh',
      retrievedAt: accepted[0].freshness.retrievedAt, cacheExpires, lastModified: consistency === 'consistent' ? snapshot : null,
    };
    const providerCeilingPossible = rowsReceived >= 25000;
    const ready = kind === 'all_reported_pages' && freshness.state === 'fresh' && unknownTypeRecords === 0 && !providerCeilingPossible;
    return {
      ...blank(args, completed, ready ? 'ready' : 'partial', `${stopMessages[stopReason]} ${accepted.length} accepted pages, ${blueprints.length} unique returned records. Snapshot consistency is ${consistency}; source freshness is ${freshness.state}.` + (duplicateRecords ? ` ${duplicateRecords} repeated records were counted once; missing records cannot be ruled out.` : '') + (providerCeilingPossible ? ' The known historical provider ceiling may hide additional owned blueprints.' : '')),
      corporationId,
      coverage: { ...progress(accepted.length, pagesExpected, rowsReceived, blueprints.length, duplicateRecords), kind, completedPages: accepted.map((_value, index) => index + 1), consistency, stopReason, failedPage, providerCeilingPossible },
      freshness, summary: { records: blueprints.length, types: types.size, originalRecords: kindCounts[0].count, copyRecords: kindCounts[1].count, originalStackRecords: kindCounts[2].count, unknownTypeRecords },
      kindCounts, blueprints, typeCounts, materialEfficiencyCounts, timeEfficiencyCounts,
    };
  };
}
export const readBlueprintCollection = createBlueprintCollectionReader({ connections: listConnections, corporation: readCorporationData });
