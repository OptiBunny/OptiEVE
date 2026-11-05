import { z } from 'zod';
import { ConnectionResponseError } from './connection-client';
import type { BlueprintCollection, BlueprintCollectionArgs, BlueprintCollectionProgress } from './blueprint-collection-types';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), id = count.min(1), rows = count.max(50000);
const date = z.string().length(24).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const text = z.string().max(2048), name = z.string().min(1).max(512).refine(value => value.trim() === value && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value));
const kind = z.enum(['original', 'copy', 'original_stack']);
const argsSchema = z.strictObject({ characterId: id });
const progressSchema = z.strictObject({ pagesRead: count.max(50), pagesExpected: id.nullable(), rowsReceived: rows, uniqueRecords: rows, duplicateRecords: rows, pageLimit: z.literal(50), rowLimit: z.literal(50000) });
const schema = z.strictObject({
  characterId: id, entity: z.literal('corporation'), corporationId: id.nullable(), generatedAt: date,
  status: z.enum(['ready', 'partial', 'needs_permission', 'unavailable', 'error']), message: text, scope: z.literal('esi-corporations.read_blueprints.v1'),
  coverage: z.strictObject({ kind: z.enum(['all_reported_pages', 'partial', 'unknown', 'unavailable']),
    pagesExpected: id.nullable(), pagesRead: count.max(50), completedPages: z.array(id.max(50)).max(50), rowsReceived: rows, uniqueRecords: rows, duplicateRecords: rows,
    consistency: z.enum(['consistent', 'unknown', 'inconsistent']), stopReason: z.enum(['complete', 'missing_page_count', 'page_limit', 'row_limit', 'provider_error', 'invalid_page', 'pagination_changed', 'snapshot_changed', 'corporation_changed', 'conflicting_duplicate', 'cancelled', 'deadline']),
    failedPage: id.max(50).nullable(), pageLimit: z.literal(50), rowLimit: z.literal(50000), providerCeilingPossible: z.boolean() }),
  freshness: z.strictObject({ state: z.enum(['fresh', 'stale', 'unknown']), retrievedAt: date.nullable(), cacheExpires: date.nullable(), lastModified: date.nullable() }),
  summary: z.strictObject({ records: rows, types: rows, originalRecords: rows, copyRecords: rows, originalStackRecords: rows, unknownTypeRecords: rows }).nullable(),
  kindCounts: z.array(z.strictObject({ kind, count: rows })).max(3),
  materialEfficiencyCounts: z.array(z.strictObject({ level: count, count: rows })).max(50000),
  timeEfficiencyCounts: z.array(z.strictObject({ level: count, count: rows })).max(50000),
  typeCounts: z.array(z.strictObject({ typeId: id, name, records: rows })).max(50000),
  blueprints: z.array(z.strictObject({ row: id.max(50000), typeId: id, name, catalogMapped: z.boolean(), kind, units: id, materialEfficiency: count, timeEfficiency: count, copyRuns: count.nullable() })).max(50000),
  limitations: z.array(text).max(30),
});
const invalid = () => new ConnectionResponseError('The corporation blueprint collection returned an incomplete response. Load it again to try again.');
const invalidSelection = () => new ConnectionResponseError('Choose one connected character for corporation blueprints.');
const safeError = (status: number) => new ConnectionResponseError(status === 401 ? 'Sign in again to load corporation blueprints.' : status === 404 ? 'This character is no longer connected. Reload connection status.' : status === 429 ? 'EVE is rate limiting requests. Wait before loading again.' : status === 413 ? 'The blueprint collection exceeded its response limit. No incomplete result was displayed.' : 'Corporation blueprints could not be collected. Try again or review the connection.', status);

function validCounters(value: BlueprintCollectionProgress): boolean {
  return value.rowsReceived === value.uniqueRecords + value.duplicateRecords && value.rowsReceived <= value.pagesRead * 1000 &&
    (value.pagesExpected === null || value.pagesRead <= value.pagesExpected);
}
export function blueprintCollectionProgress(value: unknown, previous?: BlueprintCollectionProgress): BlueprintCollectionProgress {
  const parsed = progressSchema.safeParse(value); if (!parsed.success || !validCounters(parsed.data)) throw invalid();
  const current = parsed.data;
  if (previous && (current.pagesRead < previous.pagesRead || current.rowsReceived < previous.rowsReceived || current.uniqueRecords < previous.uniqueRecords || current.duplicateRecords < previous.duplicateRecords ||
      previous.pagesExpected !== null && current.pagesExpected !== previous.pagesExpected)) throw invalid();
  return current;
}
export function blueprintCollectionResponse(value: unknown, input: BlueprintCollectionArgs): BlueprintCollection {
  const selected = argsSchema.safeParse(input); if (!selected.success) throw invalidSelection();
  const parsed = schema.safeParse(value); if (!parsed.success) throw invalid();
  const result = parsed.data, coverage = result.coverage, freshness = result.freshness;
  if (result.characterId !== selected.data.characterId || !validCounters(coverage) || coverage.completedPages.length !== coverage.pagesRead ||
      coverage.completedPages.some((page, index) => page !== index + 1) || coverage.providerCeilingPossible !== (coverage.rowsReceived >= 25000) ||
      coverage.failedPage !== null && coverage.failedPage !== coverage.pagesRead + 1) throw invalid();
  if (result.status !== 'ready' && result.status !== 'partial') {
    if (result.corporationId !== null || result.summary !== null || coverage.kind !== 'unavailable' || coverage.pagesRead !== 0 || coverage.pagesExpected !== null || coverage.consistency !== 'unknown' || coverage.rowsReceived !== 0 ||
        result.blueprints.length || result.typeCounts.length || result.kindCounts.length || result.materialEfficiencyCounts.length || result.timeEfficiencyCounts.length ||
        freshness.state !== 'unknown' || freshness.retrievedAt !== null || freshness.cacheExpires !== null || freshness.lastModified !== null ||
        !['provider_error', 'invalid_page', 'conflicting_duplicate', 'cancelled', 'deadline'].includes(coverage.stopReason) ||
        result.status === 'needs_permission' && (coverage.stopReason !== 'provider_error' || coverage.failedPage !== null)) throw invalid();
    return result;
  }
  if (result.corporationId === null || result.summary === null || coverage.pagesRead === 0 || coverage.kind === 'unavailable' ||
      freshness.retrievedAt === null || Date.parse(freshness.retrievedAt) > Date.parse(result.generatedAt) + 60000 ||
      freshness.state !== (freshness.cacheExpires === null ? 'unknown' : Date.parse(freshness.cacheExpires) <= Date.parse(result.generatedAt) ? 'stale' : 'fresh') ||
      coverage.duplicateRecords > 0 && coverage.consistency !== 'inconsistent' || (coverage.consistency === 'consistent') !== (freshness.lastModified !== null)) throw invalid();
  const allPages = coverage.pagesExpected !== null && coverage.pagesRead === coverage.pagesExpected && coverage.stopReason === 'complete';
  const coverageKind = coverage.consistency === 'inconsistent' ? 'partial' : coverage.consistency === 'unknown' || coverage.pagesExpected === null ? 'unknown' : allPages ? 'all_reported_pages' : 'partial';
  if ((coverage.kind === 'all_reported_pages') !== (allPages && coverage.consistency === 'consistent' && coverage.duplicateRecords === 0) ||
      coverage.kind !== coverageKind || coverage.stopReason === 'complete' && (!allPages || coverage.failedPage !== null) ||
      coverage.stopReason === 'missing_page_count' && (coverage.pagesExpected !== null || coverage.pagesRead !== 1 || coverage.failedPage !== null) ||
      coverage.stopReason === 'page_limit' && (coverage.pagesRead !== 50 || coverage.pagesExpected === null || coverage.pagesExpected <= 50 || coverage.failedPage !== null) ||
      coverage.stopReason === 'row_limit' && (coverage.rowsReceived !== 50000 || coverage.pagesExpected === null || coverage.pagesRead >= coverage.pagesExpected || coverage.failedPage !== null) ||
      ['provider_error', 'invalid_page', 'pagination_changed', 'snapshot_changed', 'corporation_changed', 'conflicting_duplicate'].includes(coverage.stopReason) && coverage.failedPage !== coverage.pagesRead + 1 ||
      ['pagination_changed', 'snapshot_changed', 'corporation_changed', 'conflicting_duplicate'].includes(coverage.stopReason) && coverage.consistency !== 'inconsistent') throw invalid();
  const expectedReady = coverage.kind === 'all_reported_pages' && freshness.state === 'fresh' && result.summary.unknownTypeRecords === 0 && !coverage.providerCeilingPossible;
  if (result.status !== (expectedReady ? 'ready' : 'partial')) throw invalid();
  const summary = result.summary, blueprints = result.blueprints;
  if (blueprints.length !== coverage.uniqueRecords || summary.records !== blueprints.length ||
      summary.originalRecords !== blueprints.filter(row => row.kind === 'original').length || summary.copyRecords !== blueprints.filter(row => row.kind === 'copy').length ||
      summary.originalStackRecords !== blueprints.filter(row => row.kind === 'original_stack').length || summary.unknownTypeRecords !== blueprints.filter(row => !row.catalogMapped).length ||
      blueprints.some((row, index) => row.row !== index + 1 || (row.kind === 'copy') !== (row.copyRuns !== null) || row.kind !== 'original_stack' && row.units !== 1 || !row.catalogMapped && row.name !== `Type ${row.typeId}`)) throw invalid();
  if (result.kindCounts.length !== 3 || new Set(result.kindCounts.map(row => row.kind)).size !== 3 || result.kindCounts.some(row => row.count !== blueprints.filter(blueprint => blueprint.kind === row.kind).length)) throw invalid();
  for (const [key, values] of [['materialEfficiency', result.materialEfficiencyCounts], ['timeEfficiency', result.timeEfficiencyCounts]] as const) {
    const expected = new Map<number, number>();
    for (const row of blueprints) expected.set(row[key], (expected.get(row[key]) ?? 0) + 1);
    if (values.length !== expected.size || new Set(values.map(row => row.level)).size !== values.length || values.some((row, index) => row.count === 0 || row.count !== expected.get(row.level) || index > 0 && row.level <= values[index - 1].level)) throw invalid();
  }
  const types = new Map<number, { name: string; mapped: boolean; records: number }>();
  for (const row of blueprints) {
    const type = types.get(row.typeId) ?? { name: row.name, mapped: row.catalogMapped, records: 0 };
    if (type.name !== row.name || type.mapped !== row.catalogMapped) throw invalid();
    type.records++; types.set(row.typeId, type);
  }
  if (summary.types !== types.size || result.typeCounts.length !== types.size || new Set(result.typeCounts.map(row => row.typeId)).size !== types.size ||
      result.typeCounts.some((row, index) => row.records === 0 || row.records !== types.get(row.typeId)?.records || row.name !== types.get(row.typeId)?.name ||
        index > 0 && (row.records > result.typeCounts[index - 1].records || row.records === result.typeCounts[index - 1].records && row.typeId < result.typeCounts[index - 1].typeId))) throw invalid();
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
export async function blueprintCollectionRequest(input: BlueprintCollectionArgs, options: { signal?: AbortSignal; onProgress?: (progress: BlueprintCollectionProgress) => void } = {}): Promise<BlueprintCollection> {
  if (!argsSchema.safeParse(input).success) throw invalidSelection();
  const controller = new AbortController(), abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, 60000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await abortable(() => fetch('/api/eve/blueprint-collection', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal }), controller.signal);
    if (!response.ok) throw safeError(response.status);
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-ndjson' || !response.body) throw invalid();
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true }), encoder = new TextEncoder();
    let received = 0, buffer = '', progressCount = 0, previous: BlueprintCollectionProgress | undefined, result: BlueprintCollection | undefined;
    function line(value: string) {
      controller.signal.throwIfAborted();
      if (result) throw invalid();
      const bytes = encoder.encode(value).byteLength;
      if (!value || bytes > 16 * 1024 * 1024) throw invalid();
      const event: unknown = JSON.parse(value);
      const progress = progressEvent.safeParse(event);
      if (progress.success) {
        if (bytes > 4096 || ++progressCount > 128) throw invalid();
        previous = blueprintCollectionProgress(progress.data.progress, previous); options.onProgress?.(previous); return;
      }
      const failure = errorEvent.safeParse(event); if (failure.success) throw safeError(failure.data.status);
      const terminal = resultEvent.safeParse(event); if (!terminal.success) throw invalid();
      result = blueprintCollectionResponse(terminal.data.result, input);
      if (previous && (previous.pagesRead > result.coverage.pagesRead || previous.rowsReceived > result.coverage.rowsReceived || previous.uniqueRecords > result.coverage.uniqueRecords || previous.duplicateRecords > result.coverage.duplicateRecords || previous.pagesExpected !== null && previous.pagesExpected !== result.coverage.pagesExpected)) throw invalid();
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
    const cancelled = controller.signal.aborted;
    controller.abort();
    if (error instanceof ConnectionResponseError) throw error;
    throw new ConnectionResponseError(cancelled ? 'The blueprint collection was cancelled or timed out.' : 'The corporation blueprint collection could not be read safely. Load it again to try again.');
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
    if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch {} }
  }
}
