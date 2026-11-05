import { z } from 'zod';
import { ConnectionResponseError } from './connection-client';
import type { BlueprintAnalytics, BlueprintAnalyticsArgs } from './blueprint-analytics-types';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), id = count.min(1), rows = count.max(1000);
const text = z.string().max(2048), name = z.string().min(1).max(512).refine(value => value.trim() === value && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value));
const date = z.string().length(24).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const kind = z.enum(['original', 'copy', 'original_stack']);
const argsSchema = z.strictObject({ characterId: id, entity: z.enum(['character', 'corporation']), page: id.max(500).optional() });
const schema = z.strictObject({
  characterId: id, entity: z.enum(['character', 'corporation']), corporationId: id.nullable(), generatedAt: date,
  status: z.enum(['ready', 'partial', 'needs_permission', 'unavailable', 'error']), message: text,
  scope: z.enum(['esi-characters.read_blueprints.v1', 'esi-corporations.read_blueprints.v1']),
  coverage: z.strictObject({ kind: z.enum(['complete_returned_response', 'partial', 'unknown', 'unavailable']), page: id.max(500), pages: id.nullable(), nextPage: id.max(500).nullable(), previousPage: id.max(500).nullable(), pageLimitReached: z.boolean(), rows }),
  freshness: z.strictObject({ state: z.enum(['fresh', 'stale', 'unknown']), retrievedAt: date.nullable(), cacheExpires: date.nullable(), lastModified: date.nullable() }),
  summary: z.strictObject({ records: rows, types: rows, originalRecords: rows, copyRecords: rows, originalStackRecords: rows, unknownTypeRecords: rows }).nullable(),
  kindCounts: z.array(z.strictObject({ kind, count: rows })).max(3),
  materialEfficiencyCounts: z.array(z.strictObject({ level: count, count: rows })).max(1000),
  timeEfficiencyCounts: z.array(z.strictObject({ level: count, count: rows })).max(1000),
  typeCounts: z.array(z.strictObject({ typeId: id, name, records: rows })).max(1000),
  blueprints: z.array(z.strictObject({ row: id.max(1000), typeId: id, name, catalogMapped: z.boolean(), kind, units: id, materialEfficiency: count, timeEfficiency: count, copyRuns: count.nullable() })).max(1000),
  limitations: z.array(text).max(20),
});
const invalid = () => new ConnectionResponseError('The blueprint service returned an incomplete response. Refresh and try again.');
const invalidSelection = () => new ConnectionResponseError('Choose one connected character, a blueprint owner and a page from 1 to 500.');
export function blueprintAnalyticsResponse(value: unknown, input: BlueprintAnalyticsArgs): BlueprintAnalytics {
  const selection = argsSchema.safeParse(input); if (!selection.success) throw invalidSelection();
  const parsed = schema.safeParse(value); if (!parsed.success) throw invalid();
  const result = parsed.data, selected = selection.data, coverage = result.coverage, freshness = result.freshness, page = selected.page ?? 1, corporation = selected.entity === 'corporation';
  if (result.characterId !== selected.characterId || result.entity !== selected.entity || coverage.page !== page || coverage.previousPage !== (page > 1 ? page - 1 : null) ||
      result.scope !== (corporation ? 'esi-corporations.read_blueprints.v1' : 'esi-characters.read_blueprints.v1') || !corporation && result.corporationId !== null) throw invalid();
  if (result.status !== 'ready' && result.status !== 'partial') {
    if (result.corporationId !== null || result.summary !== null || coverage.kind !== 'unavailable' || coverage.rows !== 0 || coverage.pages !== null || coverage.nextPage !== null || coverage.pageLimitReached ||
        result.blueprints.length || result.typeCounts.length || result.kindCounts.length || result.materialEfficiencyCounts.length || result.timeEfficiencyCounts.length ||
        freshness.state !== 'unknown' || freshness.retrievedAt !== null || freshness.cacheExpires !== null || freshness.lastModified !== null) throw invalid();
    return result;
  }
  const more = coverage.pages === null ? null : page < coverage.pages;
  const coverageKind = coverage.pages === null ? 'unknown' : page === 1 && coverage.pages === 1 ? 'complete_returned_response' : 'partial';
  if (corporation && result.corporationId === null || result.summary === null || coverage.kind !== coverageKind || coverage.pages !== null && coverage.pages < page ||
      coverage.nextPage !== (more && page < 500 ? page + 1 : null) || coverage.pageLimitReached !== (page === 500 && more !== false) ||
      freshness.retrievedAt === null || Date.parse(freshness.retrievedAt) > Date.parse(result.generatedAt) + 60000 ||
      freshness.state !== (freshness.cacheExpires === null ? 'unknown' : Date.parse(freshness.cacheExpires) <= Date.parse(result.generatedAt) ? 'stale' : 'fresh')) throw invalid();
  const summary = result.summary, blueprints = result.blueprints;
  if (blueprints.length !== coverage.rows || summary.records !== blueprints.length ||
      summary.originalRecords !== blueprints.filter(row => row.kind === 'original').length || summary.copyRecords !== blueprints.filter(row => row.kind === 'copy').length ||
      summary.originalStackRecords !== blueprints.filter(row => row.kind === 'original_stack').length || summary.unknownTypeRecords !== blueprints.filter(row => !row.catalogMapped).length ||
      result.status !== (coverageKind === 'complete_returned_response' && freshness.state === 'fresh' && summary.unknownTypeRecords === 0 ? 'ready' : 'partial') ||
      blueprints.some((row, index) => row.row !== index + 1 || (row.kind === 'copy') !== (row.copyRuns !== null) || row.kind !== 'original_stack' && row.units !== 1 || !row.catalogMapped && row.name !== `Type ${row.typeId}`)) throw invalid();
  if (result.kindCounts.length !== 3 || new Set(result.kindCounts.map(row => row.kind)).size !== 3 ||
      result.kindCounts.some(row => row.count !== blueprints.filter(blueprint => blueprint.kind === row.kind).length)) throw invalid();
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
      result.typeCounts.some(row => row.records === 0 || row.records !== types.get(row.typeId)?.records || row.name !== types.get(row.typeId)?.name)) throw invalid();
  return result;
}
export async function blueprintAnalyticsRequest(input: BlueprintAnalyticsArgs, signal?: AbortSignal): Promise<BlueprintAnalytics> {
  if (!argsSchema.safeParse(input).success) throw invalidSelection();
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(abort, 60000);
  try {
    controller.signal.throwIfAborted();
    const response = await fetch('/api/eve/blueprint-analytics', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal });
    if (!response.ok) throw new ConnectionResponseError(response.status === 401 ? 'Sign in again to load blueprints.' : response.status === 404 ? 'This character is no longer connected. Reload connection status.' : 'Blueprints could not be loaded. Try again or review the connection.', response.status);
    if (!response.headers.get('content-type')?.includes('application/json')) throw invalid();
    const value: unknown = await response.json(); controller.signal.throwIfAborted(); return blueprintAnalyticsResponse(value, input);
  } catch (error) {
    if (error instanceof ConnectionResponseError) throw error;
    throw new ConnectionResponseError(controller.signal.aborted ? 'The blueprint request was cancelled or timed out.' : 'The blueprint service could not be reached. Try again.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
