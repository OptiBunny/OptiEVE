import { z } from 'zod';
import { ConnectionResponseError } from './connection-client';
import { blueprintCollectionProgress, blueprintCollectionResponse } from './blueprint-collection-client';
import type { BlueprintCollectionProgress } from './blueprint-collection-types';
import type { BlueprintAssetStage, BlueprintReconciliation, BlueprintReconciliationArgs, BlueprintReconciliationProgress } from './blueprint-reconciliation-types';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), id = count.min(1), rows = count.max(50000);
const date = z.string().length(24).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const text = z.string().max(2048), name = z.string().min(1).max(512).refine(value => value.trim() === value && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value));
const status = z.enum(['ready', 'partial', 'needs_permission', 'unavailable', 'error']), copyStatus = z.enum(['copy', 'not_copy', 'unknown']);
const argsSchema = z.strictObject({ characterId: id });
const progressSchema = z.strictObject({ phase: z.enum(['blueprints', 'assets']), blueprints: z.unknown(), assets: z.unknown() });
const schema = z.strictObject({
  characterId: id, entity: z.literal('corporation'), corporationId: id.nullable(), generatedAt: date, status, message: text, blueprints: z.unknown(),
  assets: z.strictObject({ status, message: text, scope: z.literal('esi-assets.read_corporation_assets.v1'),
    coverage: z.strictObject({ kind: z.enum(['all_reported_pages', 'partial', 'unknown', 'unavailable']), pagesRead: count.max(50), pagesExpected: id.nullable(),
      rowsReceived: rows, uniqueRecords: rows, duplicateRecords: rows, pageLimit: z.literal(50), rowLimit: z.literal(50000), resultLimit: z.literal(50000),
      completedPages: z.array(id.max(50)).max(50), consistency: z.enum(['consistent', 'unknown', 'inconsistent']),
      stopReason: z.enum(['complete', 'missing_page_count', 'page_limit', 'row_limit', 'provider_error', 'invalid_page', 'pagination_changed', 'snapshot_changed', 'corporation_changed', 'conflicting_duplicate', 'cancelled', 'deadline', 'result_limit', 'not_started']), failedPage: id.max(50).nullable() }),
    freshness: z.strictObject({ state: z.enum(['fresh', 'stale', 'unknown']), retrievedAt: date.nullable(), cacheExpires: date.nullable(), lastModified: date.nullable() }) }),
  assetsOnly: z.array(z.strictObject({ row: id.max(50000), typeId: id, name, catalogMapped: z.literal(true), copyStatus, quantity: count, isSingleton: z.boolean() })).max(50000),
  relationships: z.array(z.strictObject({ row: id.max(50000), status: z.enum(['matched', 'conflict']) })).max(50000),
  summary: z.strictObject({ blueprintRecords: rows, assetBlueprintRecords: rows, matchedRecords: rows, conflictingRecords: rows, blueprintOnlyRecords: rows, assetOnlyRecords: rows, unclassifiedAssetRecords: rows, nonBlueprintAssetRecords: rows, unionRecords: rows }),
  typeCounts: z.array(z.strictObject({ typeId: id, name, blueprintRecords: rows, assetOnlyRecords: rows, records: rows })).max(50000),
  kindCounts: z.array(z.strictObject({ copyStatus, count: rows })).max(3), limitations: z.array(text).max(30),
});
const invalid = () => new ConnectionResponseError('The corporation blueprint comparison returned an incomplete response. Load it again to try again.');
const invalidSelection = () => new ConnectionResponseError('Choose one connected character for corporation blueprints.');
const safeError = (status: number) => new ConnectionResponseError(status === 401 ? 'Sign in again to load corporation blueprints.' : status === 404 ? 'This character is no longer connected. Reload connection status.' : status === 429 ? 'EVE is rate limiting requests. Wait before loading again.' : status === 413 ? 'The blueprint comparison exceeded its response limit. No incomplete result was displayed.' : 'Corporation blueprints and assets could not be compared. Try again or review the connection.', status);
function sourceProgress(value: BlueprintCollectionProgress, previous?: BlueprintCollectionProgress) {
  const { pagesRead, pagesExpected, rowsReceived, uniqueRecords, duplicateRecords, pageLimit, rowLimit } = value;
  return blueprintCollectionProgress({ pagesRead, pagesExpected, rowsReceived, uniqueRecords, duplicateRecords, pageLimit, rowLimit }, previous);
}
function sameProgress(left: BlueprintCollectionProgress, right: BlueprintCollectionProgress) {
  return left.pagesRead === right.pagesRead && left.pagesExpected === right.pagesExpected && left.rowsReceived === right.rowsReceived && left.uniqueRecords === right.uniqueRecords && left.duplicateRecords === right.duplicateRecords;
}
export function blueprintReconciliationProgress(value: unknown, previous?: BlueprintReconciliationProgress): BlueprintReconciliationProgress {
  const parsed = progressSchema.safeParse(value); if (!parsed.success) throw invalid();
  const blueprints = blueprintCollectionProgress(parsed.data.blueprints, previous?.blueprints), assets = blueprintCollectionProgress(parsed.data.assets, previous?.assets);
  if (parsed.data.phase === 'blueprints' && (previous?.phase === 'assets' || assets.pagesRead !== 0 || assets.pagesExpected !== null || assets.rowsReceived !== 0) ||
      previous?.phase === 'assets' && !sameProgress(blueprints, previous.blueprints)) throw invalid();
  return { phase: parsed.data.phase, blueprints, assets };
}
function validateAssets(stage: BlueprintAssetStage, generatedAt: string) {
  const c = stage.coverage, f = stage.freshness; sourceProgress(c);
  if (c.completedPages.length !== c.pagesRead || c.completedPages.some((page, index) => page !== index + 1) || c.failedPage !== null && c.failedPage !== c.pagesRead + 1) throw invalid();
  if (stage.status !== 'ready' && stage.status !== 'partial') {
    if (c.kind !== 'unavailable' || c.pagesRead !== 0 || c.pagesExpected !== null || c.consistency !== 'unknown' || c.rowsReceived !== 0 ||
        f.state !== 'unknown' || f.retrievedAt !== null || f.cacheExpires !== null || f.lastModified !== null ||
        ['complete', 'missing_page_count', 'page_limit', 'row_limit', 'pagination_changed', 'snapshot_changed'].includes(c.stopReason) ||
        c.stopReason === 'not_started' && c.failedPage !== null || stage.status === 'needs_permission' && c.failedPage !== null) throw invalid();
    return;
  }
  if (c.pagesRead === 0 || c.kind === 'unavailable' || c.stopReason === 'not_started' || f.retrievedAt === null || Date.parse(f.retrievedAt) > Date.parse(generatedAt) + 60000 ||
      f.state !== (f.cacheExpires === null ? 'unknown' : Date.parse(f.cacheExpires) <= Date.parse(generatedAt) ? 'stale' : 'fresh') ||
      c.duplicateRecords > 0 && c.consistency !== 'inconsistent' || (c.consistency === 'consistent') !== (f.lastModified !== null)) throw invalid();
  const all = c.stopReason === 'complete' && c.pagesExpected !== null && c.pagesRead === c.pagesExpected;
  const kind = c.consistency === 'inconsistent' ? 'partial' : c.consistency === 'unknown' || c.pagesExpected === null ? 'unknown' : all ? 'all_reported_pages' : 'partial';
  if (c.kind !== kind || c.stopReason === 'complete' && (!all || c.failedPage !== null) ||
      c.stopReason === 'missing_page_count' && (c.pagesExpected !== null || c.pagesRead !== 1 || c.failedPage !== null) ||
      c.stopReason === 'page_limit' && (c.pagesRead !== 50 || c.pagesExpected === null || c.pagesExpected <= 50 || c.failedPage !== null) ||
      c.stopReason === 'row_limit' && (c.rowsReceived !== 50000 || c.pagesExpected === null || c.pagesRead >= c.pagesExpected || c.failedPage !== null) ||
      ['provider_error', 'invalid_page', 'pagination_changed', 'snapshot_changed', 'corporation_changed', 'conflicting_duplicate', 'result_limit'].includes(c.stopReason) && c.failedPage !== c.pagesRead + 1 ||
      ['pagination_changed', 'snapshot_changed', 'corporation_changed', 'conflicting_duplicate'].includes(c.stopReason) && c.consistency !== 'inconsistent') throw invalid();
  if (stage.status !== (c.kind === 'all_reported_pages' && f.state === 'fresh' ? 'ready' : 'partial')) throw invalid();
}
export function blueprintReconciliationResponse(value: unknown, input: BlueprintReconciliationArgs): BlueprintReconciliation {
  if (!argsSchema.safeParse(input).success) throw invalidSelection();
  const parsed = schema.safeParse(value); if (!parsed.success) throw invalid();
  const result = { ...parsed.data, blueprints: blueprintCollectionResponse(parsed.data.blueprints, input) }, b = result.blueprints, a = result.assets, s = result.summary;
  if (result.characterId !== input.characterId || b.characterId !== result.characterId || b.corporationId !== null && b.corporationId !== result.corporationId ||
      b.generatedAt !== result.generatedAt || result.corporationId === null && (b.coverage.pagesRead > 0 || a.coverage.pagesRead > 0)) throw invalid();
  validateAssets(a, result.generatedAt);
  if (s.blueprintRecords !== b.blueprints.length || s.assetOnlyRecords !== result.assetsOnly.length || s.unionRecords !== s.blueprintRecords + s.assetOnlyRecords ||
      s.matchedRecords !== result.relationships.filter(row => row.status === 'matched').length || s.conflictingRecords !== result.relationships.filter(row => row.status === 'conflict').length ||
      s.blueprintOnlyRecords !== s.blueprintRecords - result.relationships.length || s.assetBlueprintRecords !== result.relationships.length + result.assetsOnly.length ||
      a.coverage.uniqueRecords !== s.assetBlueprintRecords + s.nonBlueprintAssetRecords + s.unclassifiedAssetRecords ||
      new Set(result.relationships.map(row => row.row)).size !== result.relationships.length || result.relationships.some(row => row.row > b.blueprints.length) ||
      result.assetsOnly.some((row, index) => row.row !== index + 1)) throw invalid();
  if (a.coverage.pagesRead === 0 && (result.assetsOnly.length || result.relationships.length || s.unclassifiedAssetRecords || s.nonBlueprintAssetRecords)) throw invalid();
  const expectedStatus = b.status === 'ready' && a.status === 'ready' && s.conflictingRecords === 0 && s.unclassifiedAssetRecords === 0 ? 'ready' :
    b.coverage.pagesRead > 0 || a.coverage.pagesRead > 0 ? 'partial' : b.status === 'needs_permission' && a.status === 'needs_permission' ? 'needs_permission' :
    b.status === 'error' || a.status === 'error' ? 'error' : 'unavailable';
  if (result.status !== expectedStatus || (result.corporationId !== null) !== (b.coverage.pagesRead > 0 || a.coverage.pagesRead > 0)) throw invalid();
  if (result.kindCounts.length !== 3 || new Set(result.kindCounts.map(row => row.copyStatus)).size !== 3 ||
      result.kindCounts.some(row => row.count !== result.assetsOnly.filter(asset => asset.copyStatus === row.copyStatus).length)) throw invalid();
  const types = new Map<number, { name: string; blueprintRecords: number; assetOnlyRecords: number }>();
  for (const row of b.blueprints) {
    const type = types.get(row.typeId) ?? { name: row.name, blueprintRecords: 0, assetOnlyRecords: 0 };
    if (type.name !== row.name) throw invalid(); type.blueprintRecords++; types.set(row.typeId, type);
  }
  for (const row of result.assetsOnly) {
    const type = types.get(row.typeId) ?? { name: row.name, blueprintRecords: 0, assetOnlyRecords: 0 };
    if (type.name !== row.name) throw invalid(); type.assetOnlyRecords++; types.set(row.typeId, type);
  }
  if (result.typeCounts.length !== types.size || new Set(result.typeCounts.map(row => row.typeId)).size !== types.size ||
      result.typeCounts.some((row, index) => { const expected = types.get(row.typeId); return !expected || row.name !== expected.name || row.blueprintRecords !== expected.blueprintRecords ||
        row.assetOnlyRecords !== expected.assetOnlyRecords || row.records !== row.blueprintRecords + row.assetOnlyRecords || row.records === 0 ||
        index > 0 && (row.records > result.typeCounts[index - 1].records || row.records === result.typeCounts[index - 1].records && row.typeId < result.typeCounts[index - 1].typeId); })) throw invalid();
  return result;
}

async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let cancel: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); });
  void interrupted.catch(() => {});
  try { const result = await Promise.race([work(), interrupted]); signal.throwIfAborted(); return result; }
  finally { signal.removeEventListener('abort', cancel); }
}
const errorEvent = z.strictObject({ type: z.literal('error'), message: text, status: z.union([z.literal(400), z.literal(401), z.literal(403), z.literal(404), z.literal(409), z.literal(413), z.literal(429), z.literal(500), z.literal(502), z.literal(504)]) });
const progressEvent = z.strictObject({ type: z.literal('progress'), progress: z.unknown() });
const resultEvent = z.strictObject({ type: z.literal('result'), result: z.unknown() });
export async function blueprintReconciliationRequest(input: BlueprintReconciliationArgs, options: { signal?: AbortSignal; onProgress?: (progress: BlueprintReconciliationProgress) => void } = {}): Promise<BlueprintReconciliation> {
  if (!argsSchema.safeParse(input).success) throw invalidSelection();
  const controller = new AbortController(), abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, 60000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await abortable(() => fetch('/api/eve/blueprint-reconciliation', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal }), controller.signal);
    if (!response.ok) throw safeError(response.status);
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-ndjson' || !response.body) throw invalid();
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true }), encoder = new TextEncoder();
    let received = 0, buffer = '', progressCount = 0, previous: BlueprintReconciliationProgress | undefined, result: BlueprintReconciliation | undefined;
    function line(value: string) {
      controller.signal.throwIfAborted();
      if (result) throw invalid();
      const bytes = encoder.encode(value).byteLength;
      if (!value || bytes > 16 * 1024 * 1024) throw invalid();
      const event: unknown = JSON.parse(value), progress = progressEvent.safeParse(event);
      if (progress.success) {
        if (bytes > 4096 || ++progressCount > 256) throw invalid();
        previous = blueprintReconciliationProgress(progress.data.progress, previous); options.onProgress?.(previous); return;
      }
      const failure = errorEvent.safeParse(event); if (failure.success) throw safeError(failure.data.status);
      const terminal = resultEvent.safeParse(event); if (!terminal.success) throw invalid();
      result = blueprintReconciliationResponse(terminal.data.result, input);
      if (previous) {
        sourceProgress(result.blueprints.coverage, previous.blueprints); sourceProgress(result.assets.coverage, previous.assets);
        if (previous.phase === 'assets' && !sameProgress(result.blueprints.coverage, previous.blueprints)) throw invalid();
        if (previous.phase === 'blueprints' && result.assets.coverage.pagesRead > 0) throw invalid();
      }
    }
    while (true) {
      const chunk = await abortable(() => reader!.read(), controller.signal);
      if (chunk.done) { buffer += decoder.decode(); break; }
      received += chunk.value.byteLength; if (received > 17 * 1024 * 1024) throw invalid();
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) { const value = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1); line(value); }
      if (buffer.length > 16 * 1024 * 1024) throw invalid();
    }
    if (buffer) line(buffer.replace(/\r$/, ''));
    controller.signal.throwIfAborted(); if (!result) throw invalid(); return result;
  } catch (error) {
    const cancelled = controller.signal.aborted; controller.abort();
    if (error instanceof ConnectionResponseError) throw error;
    throw new ConnectionResponseError(cancelled ? 'The blueprint comparison was cancelled or timed out.' : 'The corporation blueprint comparison could not be read safely. Load it again to try again.');
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
    if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch {} }
  }
}

