import { z } from 'zod';
import { ConnectionResponseError } from './connection-client';
import type { ContractsAnalytics, ContractsAnalyticsArgs } from './contracts-analytics-types';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), id = count.min(1), rows = count.max(1000);
const date = z.string().length(24).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const statuses = ['outstanding', 'in_progress', 'finished_issuer', 'finished_contractor', 'finished', 'cancelled', 'rejected', 'failed', 'deleted', 'reversed'] as const;
const types = ['unknown', 'item_exchange', 'auction', 'courier', 'loan'] as const;
const text = z.string().max(2048), entity = z.enum(['character', 'corporation']);
const argsSchema = z.strictObject({ characterId: id, entity, page: id.max(500).optional() }).refine(value => !Object.hasOwn(value, 'page') || value.page !== undefined);
const schema = z.strictObject({
  characterId: id, entity, corporationId: id.nullable(), generatedAt: date, status: z.enum(['ready', 'partial', 'needs_permission', 'unavailable', 'error']), message: text,
  scope: z.enum(['esi-contracts.read_character_contracts.v1', 'esi-contracts.read_corporation_contracts.v1']),
  coverage: z.strictObject({ kind: z.enum(['complete_returned_response', 'partial', 'unknown', 'unavailable']), page: id.max(500), pages: id.nullable(), nextPage: id.max(500).nullable(), previousPage: id.max(500).nullable(), pageLimitReached: z.boolean(), rows }),
  freshness: z.strictObject({ state: z.enum(['fresh', 'stale', 'unknown']), retrievedAt: date.nullable(), cacheExpires: date.nullable(), lastModified: date.nullable() }),
  summary: z.strictObject({ contracts: rows, outstanding: rows, inProgress: rows, outstandingPastExpiry: rows, outstandingDueWithin24h: rows }).nullable(),
  statusCounts: z.array(z.strictObject({ status: z.enum(statuses), count: rows })).max(statuses.length),
  typeCounts: z.array(z.strictObject({ type: z.enum(types), count: rows })).max(types.length),
  contracts: z.array(z.strictObject({ contractId: id, type: z.enum(types), status: z.enum(statuses), issuedAt: date, offerExpiresAt: date, acceptedAt: date.nullable(), daysToComplete: count.nullable() })).max(1000),
  limitations: z.array(text).max(20),
});
const invalid = () => new ConnectionResponseError('The contracts service returned an incomplete response. Refresh and try again.');
const invalidSelection = () => new ConnectionResponseError('Choose one connected character, an available contract feed and a page from 1 to 500.');
export function contractsAnalyticsResponse(value: unknown, input: ContractsAnalyticsArgs): ContractsAnalytics {
  const selected = argsSchema.safeParse(input); if (!selected.success) throw invalidSelection();
  const parsed = schema.safeParse(value); if (!parsed.success) throw invalid();
  const result = parsed.data, args = selected.data, page = args.page ?? 1, corporation = args.entity === 'corporation', coverage = result.coverage, fresh = result.freshness;
  if (result.characterId !== args.characterId || result.entity !== args.entity || result.scope !== (corporation ? 'esi-contracts.read_corporation_contracts.v1' : 'esi-contracts.read_character_contracts.v1') || coverage.page !== page || coverage.previousPage !== (page > 1 ? page - 1 : null) || !corporation && result.corporationId !== null) throw invalid();
  if (result.status !== 'ready' && result.status !== 'partial') {
    if (result.corporationId !== null || coverage.kind !== 'unavailable' || coverage.rows !== 0 || coverage.pages !== null || coverage.nextPage !== null || coverage.pageLimitReached || result.summary !== null || result.contracts.length || result.statusCounts.length || result.typeCounts.length || fresh.state !== 'unknown' || fresh.retrievedAt !== null || fresh.cacheExpires !== null || fresh.lastModified !== null) throw invalid();
    return result;
  }
  const more = coverage.pages === null ? null : page < coverage.pages, kind = coverage.pages === null ? 'unknown' : page === 1 && coverage.pages === 1 ? 'complete_returned_response' : 'partial';
  if (corporation && result.corporationId === null || coverage.kind !== kind || coverage.pages !== null && coverage.pages < page || coverage.nextPage !== (more && page < 500 ? page + 1 : null) || coverage.pageLimitReached !== (page === 500 && more !== false) ||
      fresh.retrievedAt === null || Date.parse(fresh.retrievedAt) > Date.parse(result.generatedAt) + 60000 || fresh.state !== (fresh.cacheExpires === null ? 'unknown' : Date.parse(fresh.cacheExpires) <= Date.parse(result.generatedAt) ? 'stale' : 'fresh') || result.summary === null) throw invalid();
  const contracts = result.contracts, summary = result.summary, now = Date.parse(result.generatedAt), outstanding = contracts.filter(row => row.status === 'outstanding');
  if (coverage.rows !== contracts.length || summary.contracts !== contracts.length || new Set(contracts.map(row => row.contractId)).size !== contracts.length ||
      summary.outstanding !== outstanding.length || summary.inProgress !== contracts.filter(row => row.status === 'in_progress').length ||
      summary.outstandingPastExpiry !== outstanding.filter(row => Date.parse(row.offerExpiresAt) <= now).length || summary.outstandingDueWithin24h !== outstanding.filter(row => Date.parse(row.offerExpiresAt) > now && Date.parse(row.offerExpiresAt) <= now + 86400000).length ||
      contracts.some((row, index) => row.offerExpiresAt < row.issuedAt || row.acceptedAt !== null && row.acceptedAt < row.issuedAt || index > 0 && (contracts[index - 1].offerExpiresAt > row.offerExpiresAt || contracts[index - 1].offerExpiresAt === row.offerExpiresAt && contracts[index - 1].contractId >= row.contractId)) ||
      result.statusCounts.length !== statuses.length || statuses.some((status, index) => result.statusCounts[index].status !== status || result.statusCounts[index].count !== contracts.filter(row => row.status === status).length) ||
      result.typeCounts.length !== types.length || types.some((type, index) => result.typeCounts[index].type !== type || result.typeCounts[index].count !== contracts.filter(row => row.type === type).length) ||
      result.status !== (kind === 'complete_returned_response' && fresh.state === 'fresh' ? 'ready' : 'partial')) throw invalid();
  return result;
}
export async function contractsAnalyticsRequest(args: ContractsAnalyticsArgs, signal?: AbortSignal): Promise<ContractsAnalytics> {
  if (!argsSchema.safeParse(args).success) throw invalidSelection();
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(abort, 60000);
  let response: Response | undefined;
  try {
    controller.signal.throwIfAborted();
    response = await fetch('/api/eve/contracts-analytics', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: controller.signal });
    if (!response.ok) throw new ConnectionResponseError(response.status === 401 ? 'Sign in again to load available contracts.' : response.status === 404 ? 'This character is no longer connected. Reload connection status.' : 'Contracts could not be loaded. Try again or review the connection.', response.status);
    if (!response.headers.get('content-type')?.includes('application/json')) throw invalid();
    const value: unknown = await response.json(); controller.signal.throwIfAborted(); return contractsAnalyticsResponse(value, args);
  } catch (error) {
    if (error instanceof ConnectionResponseError) throw error;
    throw new ConnectionResponseError(controller.signal.aborted ? 'The contracts request was cancelled or timed out.' : 'The contracts service could not be reached. Try again.');
  } finally { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
