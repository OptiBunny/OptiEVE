import { z } from 'zod';
import { ConnectionResponseError } from './connection-client';
import type { IndustryAnalytics, IndustryAnalyticsArgs } from './industry-analytics-types';
import type { InventoryAnalytics, InventoryAnalyticsArgs } from './inventory-analytics-types';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const id = count.min(1);
const text = z.string().max(2048);
const name = z.string().min(1).max(512).refine(value => !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value));
// Services normalize timestamps before projection; charts rely on UTC date keys
// and lexical ordering. Reject offsets or rollover dates in the projected DTO.
const date = z.string().length(24).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const status = z.enum(['ready', 'partial', 'needs_permission', 'unavailable', 'error']);
const freshness = z.strictObject({ state: z.enum(['fresh', 'stale', 'unknown']), retrievedAt: date.nullable(), cacheExpires: date.nullable(), lastModified: date.nullable() });
const entity = z.enum(['character', 'corporation']);
const available = (value: string) => value === 'ready' || value === 'partial';
const invalid = () => new ConnectionResponseError('The operations service returned an incomplete response. Refresh and try again.');
const invalidSelection = () => new ConnectionResponseError('Choose one connected character, an owner and valid read options.');
const assetCount = count.max(1000);
const inventoryArgsSchema = z.strictObject({ characterId: id, entity, page: id.max(500).optional() });
const inventorySchema = z.strictObject({
  characterId: id, entity, corporationId: id.nullable(), generatedAt: date, status, message: text,
  scope: z.enum(['esi-assets.read_assets.v1', 'esi-assets.read_corporation_assets.v1']),
  coverage: z.strictObject({ kind: z.enum(['complete_returned_list', 'partial', 'unknown', 'unavailable']), page: id.max(500), pages: id.nullable(), nextPage: id.max(500).nullable(), previousPage: id.max(500).nullable(), pageLimitReached: z.boolean(), records: assetCount }),
  freshness,
  summary: z.strictObject({ records: assetCount, types: assetCount, locations: assetCount, singletonRecords: assetCount, blueprintCopyRecords: assetCount, blueprintCopyUnknownRecords: assetCount, unmappedTypeRecords: assetCount }).nullable(),
  categories: z.array(z.strictObject({ categoryId: id.nullable(), name, records: assetCount, typeCount: assetCount })).max(1000),
  groups: z.array(z.strictObject({ groupId: id.nullable(), name, categoryId: id.nullable(), categoryName: name, records: assetCount, typeCount: assetCount })).max(1000),
  types: z.array(z.strictObject({ typeId: id, name, groupId: id.nullable(), groupName: name, categoryId: id.nullable(), categoryName: name, records: assetCount, quantity: count, singletonRecords: assetCount, blueprintCopyRecords: assetCount, blueprintCopyUnknownRecords: assetCount })).max(1000),
  locations: z.array(z.strictObject({ locationId: id, kind: z.enum(['station', 'solar_system', 'item', 'other']), records: assetCount, typeCount: assetCount })).max(1000), limitations: z.array(text).max(20),
});
const jobStates = ['active', 'cancelled', 'delivered', 'paused', 'ready', 'reverted'] as const;
// Matches the pinned official industryActivities data; other IDs stay explicit.
const activityLabels: Record<number, string> = { 1: 'Manufacturing', 3: 'Time Efficiency Research', 4: 'Material Efficiency Research', 5: 'Copying', 8: 'Invention', 9: 'Reactions' };
const jobStatus = z.enum(jobStates);
const jobCount = count.max(5000);
const industryArgsSchema = z.strictObject({ characterId: id, entity, includeCompleted: z.boolean().optional(), page: id.max(500).optional() }).refine(value => value.entity === 'corporation' || value.page === undefined);
const industrySchema = z.strictObject({
  characterId: id, entity, corporationId: id.nullable(), includeCompleted: z.boolean(), generatedAt: date, status, message: text,
  scope: z.enum(['esi-industry.read_character_jobs.v1', 'esi-industry.read_corporation_jobs.v1']),
  coverage: z.strictObject({ kind: z.enum(['complete_returned_response', 'partial', 'unknown', 'unavailable']), page: id.max(500).nullable(), pages: id.nullable(), nextPage: id.max(500).nullable(), previousPage: id.max(500).nullable(), pageLimitReached: z.boolean(), rows: jobCount }),
  freshness,
  summary: z.strictObject({ jobs: jobCount, active: jobCount, ready: jobCount, paused: jobCount, activePastEnd: jobCount, activeDueWithin24h: jobCount, unknownBlueprintNames: jobCount, unknownProductNames: jobCount }).nullable(),
  statusCounts: z.array(z.strictObject({ status: jobStatus, count: jobCount })).max(6),
  activityCounts: z.array(z.strictObject({ activityId: id, label: name, count: jobCount })).max(5000),
  jobs: z.array(z.strictObject({ jobId: id, activityId: id, activityLabel: name, status: jobStatus, blueprintTypeId: id, blueprintName: name, productTypeId: id.nullable(), productName: name.nullable(), runs: count, startAt: date, endAt: date, durationSeconds: count, pauseAt: date.nullable(), completedAt: date.nullable() })).max(5000),
  limitations: z.array(text).max(20),
});
function blankFreshness(value: z.infer<typeof freshness>): boolean { return value.state === 'unknown' && value.retrievedAt === null && value.cacheExpires === null && value.lastModified === null; }
function validFreshness(value: z.infer<typeof freshness>, generatedAt: string): boolean {
  return value.retrievedAt !== null && Date.parse(value.retrievedAt) <= Date.parse(generatedAt) + 60000 && value.state === (value.cacheExpires === null ? 'unknown' : Date.parse(value.cacheExpires) <= Date.parse(generatedAt) ? 'stale' : 'fresh');
}
export function inventoryAnalyticsResponse(value: unknown, input: InventoryAnalyticsArgs): InventoryAnalytics {
  const args = inventoryArgsSchema.safeParse(input); if (!args.success) throw invalidSelection();
  const parsed = inventorySchema.safeParse(value); if (!parsed.success) throw invalid();
  const result = parsed.data, coverage = result.coverage, selected = args.data, corporation = selected.entity === 'corporation', page = selected.page ?? 1;
  if (result.characterId !== selected.characterId || result.entity !== selected.entity || coverage.page !== page || coverage.previousPage !== (page > 1 ? page - 1 : null) ||
      result.scope !== (corporation ? 'esi-assets.read_corporation_assets.v1' : 'esi-assets.read_assets.v1') || !corporation && result.corporationId !== null) throw invalid();
  if (!available(result.status)) {
    if (result.corporationId !== null || coverage.kind !== 'unavailable' || coverage.records !== 0 || coverage.pages !== null || coverage.nextPage !== null || coverage.pageLimitReached || result.summary !== null || result.types.length || result.categories.length || result.groups.length || result.locations.length || !blankFreshness(result.freshness)) throw invalid();
    return result;
  }
  const more = coverage.pages === null ? null : page < coverage.pages;
  const kind = coverage.pages === null ? 'unknown' : page === 1 && coverage.pages === 1 ? 'complete_returned_list' : 'partial';
  if (corporation && result.corporationId === null || !validFreshness(result.freshness, result.generatedAt) || coverage.kind !== kind || coverage.pages !== null && coverage.pages < page || coverage.nextPage !== (more && page < 500 ? page + 1 : null) || coverage.pageLimitReached !== (page === 500 && more !== false) || result.summary === null) throw invalid();
  const summary = result.summary, types = result.types;
  if (summary.records !== coverage.records || summary.types !== types.length || summary.locations !== result.locations.length ||
      new Set(types.map(row => row.typeId)).size !== types.length || new Set(result.categories.map(row => row.categoryId)).size !== result.categories.length || new Set(result.groups.map(row => row.groupId)).size !== result.groups.length || new Set(result.locations.map(row => row.locationId)).size !== result.locations.length ||
      summary.records !== types.reduce((sum, row) => sum + row.records, 0) || summary.records !== result.locations.reduce((sum, row) => sum + row.records, 0) ||
      summary.records !== result.categories.reduce((sum, row) => sum + row.records, 0) || summary.records !== result.groups.reduce((sum, row) => sum + row.records, 0) ||
      result.categories.reduce((sum, row) => sum + row.typeCount, 0) !== types.length || result.groups.reduce((sum, row) => sum + row.typeCount, 0) !== types.length ||
      result.locations.reduce((sum, row) => sum + row.typeCount, 0) < types.length ||
      (['singletonRecords', 'blueprintCopyRecords', 'blueprintCopyUnknownRecords'] as const).some(key => summary[key] !== types.reduce((sum, row) => sum + row[key], 0)) ||
      summary.unmappedTypeRecords !== types.filter(row => row.groupId === null).reduce((sum, row) => sum + row.records, 0) ||
      result.status !== (kind === 'complete_returned_list' && result.freshness.state === 'fresh' && summary.unmappedTypeRecords === 0 ? 'ready' : 'partial')) throw invalid();
  if (types.some(row => row.records === 0 || row.singletonRecords > row.records || row.blueprintCopyRecords + row.blueprintCopyUnknownRecords > row.records || (row.groupId === null) !== (row.categoryId === null) || row.groupId === null && (row.name !== `Type ${row.typeId}` || row.groupName !== 'Unmapped group' || row.categoryName !== 'Unmapped category')) ||
      result.locations.some(row => row.records === 0 || row.typeCount === 0 || row.typeCount > Math.min(types.length, row.records))) throw invalid();
  if (result.categories.some(row => {
    const members = types.filter(type => type.categoryId === row.categoryId);
    return !members.length || members.length !== row.typeCount || members.reduce((sum, type) => sum + type.records, 0) !== row.records || members.some(type => type.categoryName !== row.name);
  }) || result.groups.some(row => {
    const members = types.filter(type => type.groupId === row.groupId);
    return !members.length || members.length !== row.typeCount || members.reduce((sum, type) => sum + type.records, 0) !== row.records || members.some(type => type.groupName !== row.name || type.categoryId !== row.categoryId || type.categoryName !== row.categoryName);
  })) throw invalid();
  return result;
}
export function industryAnalyticsResponse(value: unknown, input: IndustryAnalyticsArgs): IndustryAnalytics {
  const args = industryArgsSchema.safeParse(input); if (!args.success) throw invalidSelection();
  const parsed = industrySchema.safeParse(value); if (!parsed.success) throw invalid();
  const result = parsed.data, coverage = result.coverage, selected = args.data, corporation = selected.entity === 'corporation';
  const page = corporation ? selected.page ?? 1 : null;
  if (result.characterId !== selected.characterId || result.entity !== selected.entity || result.includeCompleted !== (selected.includeCompleted ?? false) || coverage.page !== page ||
      result.scope !== (corporation ? 'esi-industry.read_corporation_jobs.v1' : 'esi-industry.read_character_jobs.v1') || coverage.previousPage !== (page !== null && page > 1 ? page - 1 : null) || !corporation && result.corporationId !== null) throw invalid();
  if (!available(result.status)) {
    if (result.corporationId !== null || coverage.kind !== 'unavailable' || coverage.rows !== 0 || coverage.pages !== null || coverage.nextPage !== null || coverage.pageLimitReached || result.summary !== null || result.jobs.length || result.statusCounts.length || result.activityCounts.length || !blankFreshness(result.freshness)) throw invalid();
    return result;
  }
  const more = coverage.pages === null || page === null ? null : page < coverage.pages;
  const kind = corporation ? coverage.pages === null ? 'unknown' : page === 1 && coverage.pages === 1 ? 'complete_returned_response' : 'partial' : 'complete_returned_response';
  if (corporation && result.corporationId === null || !validFreshness(result.freshness, result.generatedAt) || coverage.kind !== kind ||
      !corporation && coverage.pages !== null || coverage.pages !== null && page !== null && coverage.pages < page || coverage.nextPage !== (more && page !== null && page < 500 ? page + 1 : null) ||
      coverage.pageLimitReached !== (page === 500 && more !== false) || result.summary === null || coverage.rows !== result.jobs.length || result.summary.jobs !== result.jobs.length ||
      new Set(result.jobs.map(job => job.jobId)).size !== result.jobs.length || result.statusCounts.length !== 6 || new Set(result.statusCounts.map(row => row.status)).size !== 6 ||
      result.statusCounts.some(row => row.count !== result.jobs.filter(job => job.status === row.status).length) || new Set(result.activityCounts.map(row => row.activityId)).size !== result.activityCounts.length ||
      result.activityCounts.reduce((sum, row) => sum + row.count, 0) !== result.jobs.length || result.activityCounts.some(row => row.count === 0 || row.count !== result.jobs.filter(job => job.activityId === row.activityId).length || result.jobs.some(job => job.activityId === row.activityId && job.activityLabel !== row.label))) throw invalid();
  const summary = result.summary, jobs = result.jobs, generated = Date.parse(result.generatedAt);
  if (summary.active !== jobs.filter(job => job.status === 'active').length || summary.ready !== jobs.filter(job => job.status === 'ready').length || summary.paused !== jobs.filter(job => job.status === 'paused').length ||
      summary.activePastEnd !== jobs.filter(job => job.status === 'active' && Date.parse(job.endAt) <= generated).length ||
      summary.activeDueWithin24h !== jobs.filter(job => job.status === 'active' && Date.parse(job.endAt) > generated && Date.parse(job.endAt) <= generated + 86400000).length ||
      summary.unknownBlueprintNames > jobs.filter(job => job.blueprintName === `Type ${job.blueprintTypeId}`).length || summary.unknownProductNames > jobs.filter(job => job.productTypeId !== null && job.productName === `Type ${job.productTypeId}`).length ||
      result.status !== (kind === 'complete_returned_response' && result.freshness.state === 'fresh' && summary.unknownBlueprintNames === 0 && summary.unknownProductNames === 0 ? 'ready' : 'partial') ||
      jobs.some(job => job.activityLabel !== (activityLabels[job.activityId] ?? `Activity ${job.activityId}`) || Date.parse(job.endAt) < Date.parse(job.startAt) || (job.productTypeId === null) !== (job.productName === null))) throw invalid();
  return result;
}

async function read(path: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(abort, 60000);
  try {
    controller.signal.throwIfAborted();
    const response = await fetch('/api/eve/' + path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: controller.signal });
    if (!response.ok) throw new ConnectionResponseError(response.status === 401 ? 'Sign in again to load your operations.' : response.status === 404 ? 'This character is no longer connected. Reload connection status.' : 'Operations could not be loaded. Try again or review the connection.', response.status);
    if (!response.headers.get('content-type')?.includes('application/json')) throw invalid();
    const value: unknown = await response.json(); controller.signal.throwIfAborted(); return value;
  } catch (error) {
    if (error instanceof ConnectionResponseError) throw error;
    throw new ConnectionResponseError(controller.signal.aborted ? 'The operations request was cancelled or timed out.' : 'The operations service could not be reached. Try again.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export async function industryAnalyticsRequest(args: IndustryAnalyticsArgs, signal?: AbortSignal) {
  if (!industryArgsSchema.safeParse(args).success) throw invalidSelection();
  return industryAnalyticsResponse(await read('industry-analytics', args, signal), args);
}
export async function inventoryAnalyticsRequest(args: InventoryAnalyticsArgs, signal?: AbortSignal) {
  if (!inventoryArgsSchema.safeParse(args).success) throw invalidSelection();
  return inventoryAnalyticsResponse(await read('inventory-analytics', args, signal), args);
}
