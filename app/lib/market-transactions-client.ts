import { z } from 'zod';
import { ConnectionResponseError } from './connection-client';
import { compareMarketISK, groupMarketTransactionCells } from './market-transactions-grouping';
import type { MarketTransactionsAnalytics, MarketTransactionsArgs } from './market-transactions-types';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), id = count.min(1), rows = count.max(2500), boundary = z.union([z.literal(0), z.literal(1)]);
const iso = z.string().length(24).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const day = z.string().length(10).regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value);
const maximumQuantity = 22517998136852477500n, maximumGross = '202824096036516659203476239155202500.00', maxSafe = BigInt(Number.MAX_SAFE_INTEGER), byteLimit = 3 * 1024 * 1024;
const quantityPattern = /^(?:0|[1-9]\d{0,19})$/, moneyPattern = /^(?:0|[1-9]\d{0,35})\.\d{2,324}$/;
const quantity = z.string().max(20).regex(quantityPattern).refine(value => quantityPattern.test(value) && BigInt(value) <= maximumQuantity);
const money = z.string().max(361).regex(moneyPattern).refine(value => moneyPattern.test(value) && (value.split('.')[1].length === 2 || !value.endsWith('0')) && compareMarketISK(value, maximumGross) <= 0);
const name = z.string().min(1).max(512).refine(value => value.trim() === value && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value)), text = z.string().max(2048), entity = z.enum(['character', 'corporation']);
const argsSchema = z.strictObject({ characterId: id, entity, division: id.max(7).optional(), fromId: id.optional() }).refine(value => (value.entity === 'corporation' ? value.division !== undefined : !Object.hasOwn(value, 'division')) && (!Object.hasOwn(value, 'fromId') || value.fromId !== undefined));
const schema = z.strictObject({
  characterId: id, entity, corporationId: id.nullable(), division: id.max(7).nullable(), generatedAt: iso, status: z.enum(['ready', 'partial', 'needs_permission', 'unavailable', 'error']), message: text,
  scope: z.enum(['esi-wallet.read_character_wallet.v1', 'esi-wallet.read_corporation_wallets.v1']),
  coverage: z.strictObject({ kind: z.enum(['complete_returned_window', 'partial', 'unavailable']), fromId: id.nullable(), nextFromId: id.nullable(), returnedEntries: rows, includedEntries: rows, excludedCorporationEntries: rows, boundaryEntries: boundary, includedBoundaryEntries: boundary, firstIncludedDate: day.nullable(), lastIncludedDate: day.nullable() }),
  freshness: z.strictObject({ state: z.enum(['fresh', 'stale', 'unknown']), retrievedAt: iso.nullable(), cacheExpires: iso.nullable(), lastModified: iso.nullable() }),
  summary: z.strictObject({ entries: rows, buyEntries: rows, sellEntries: rows, types: rows, unmappedTypes: rows, grossPurchasesISK: money, grossSalesISK: money }).nullable(),
  cells: z.array(z.strictObject({ date: day, typeId: id, side: z.enum(['buy', 'sell']), entries: rows.min(1), quantity, grossISK: money })).max(2500),
  types: z.array(z.strictObject({ typeId: id, name, mapped: z.boolean() })).max(2500), precisionPolicy: text, limitations: z.array(text).max(20),
});
const invalid = () => new ConnectionResponseError('The market transactions service returned an incomplete response. Refresh and try again.');
const invalidSelection = () => new ConnectionResponseError('Choose a connected character and transaction feed. Corporation wallets require an explicit division from 1 to 7.');
function selection(value: unknown) {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'characterId') || !Object.hasOwn(value, 'entity') || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['characterId', 'entity', 'division', 'fromId'].includes(key)) || ['division', 'fromId'].some(key => key in value && !Object.hasOwn(value, key))) throw invalidSelection();
  const parsed = argsSchema.safeParse(value); if (!parsed.success) throw invalidSelection(); return parsed.data;
}
export function marketTransactionsResponse(value: unknown, input: MarketTransactionsArgs): MarketTransactionsAnalytics {
  const args = selection(input), parsed = schema.safeParse(value); if (!parsed.success) throw invalid();
  const result = parsed.data, c = result.coverage, f = result.freshness, corporation = args.entity === 'corporation', cursor = args.fromId ?? null;
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > byteLimit || result.characterId !== args.characterId || result.entity !== args.entity || result.division !== (corporation ? args.division : null) || result.scope !== (corporation ? 'esi-wallet.read_corporation_wallets.v1' : 'esi-wallet.read_character_wallet.v1') || c.fromId !== cursor || !corporation && result.corporationId !== null) throw invalid();
  if (!['ready', 'partial'].includes(result.status)) {
    if (result.corporationId !== null || result.summary !== null || result.cells.length || result.types.length || c.kind !== 'unavailable' || c.nextFromId !== null || c.returnedEntries || c.includedEntries || c.excludedCorporationEntries || c.boundaryEntries || c.includedBoundaryEntries || c.firstIncludedDate !== null || c.lastIncludedDate !== null || f.state !== 'unknown' || f.retrievedAt !== null || f.cacheExpires !== null || f.lastModified !== null) throw invalid();
    return result;
  }
  if (corporation && result.corporationId === null || result.summary === null || f.retrievedAt === null || Date.parse(f.retrievedAt) > Date.parse(result.generatedAt) + 60000 || f.state !== (f.cacheExpires === null ? 'unknown' : Date.parse(f.cacheExpires) <= Date.parse(result.generatedAt) ? 'stale' : 'fresh') ||
      c.includedEntries + c.excludedCorporationEntries !== c.returnedEntries || corporation && c.excludedCorporationEntries !== 0 || c.boundaryEntries > c.returnedEntries || c.includedBoundaryEntries > c.includedEntries || c.includedBoundaryEntries > c.boundaryEntries || c.boundaryEntries - c.includedBoundaryEntries > c.excludedCorporationEntries) throw invalid();
  if (cursor === null ? c.boundaryEntries !== 0 || c.includedBoundaryEntries !== 0 || (c.returnedEntries === 0) !== (c.nextFromId === null) :
      c.nextFromId !== null ? c.nextFromId >= cursor || c.returnedEntries <= c.boundaryEntries : c.returnedEntries !== 0 && (c.returnedEntries !== 1 || c.boundaryEntries !== 1)) throw invalid();
  const kind = cursor === null && c.returnedEntries === 0 ? 'complete_returned_window' : 'partial';
  if (c.kind !== kind || result.status !== (kind === 'complete_returned_window' && f.state === 'fresh' ? 'ready' : 'partial')) throw invalid();
  const latestAllowedTime = Date.parse(f.retrievedAt) + 60000, cellTypes = new Set<number>();
  for (let index = 0; index < result.cells.length; index++) {
    const cell = result.cells[index], prior = result.cells[index - 1]; cellTypes.add(cell.typeId);
    if (Date.parse(cell.date + 'T00:00:00Z') > latestAllowedTime || BigInt(cell.quantity) > BigInt(cell.entries) * maxSafe || compareMarketISK(cell.grossISK, (BigInt(cell.quantity) * maxSafe).toString() + '.00') > 0 ||
        prior && (prior.date > cell.date || prior.date === cell.date && (prior.typeId > cell.typeId || prior.typeId === cell.typeId && (prior.side === 'sell' || cell.side === 'buy')))) throw invalid();
  }
  if (result.types.length !== cellTypes.size || result.types.some((type, index) => !cellTypes.has(type.typeId) || index > 0 && result.types[index - 1].typeId >= type.typeId || !type.mapped && type.name !== `Type ${type.typeId}`) ||
      c.firstIncludedDate !== (result.cells[0]?.date ?? null) || c.lastIncludedDate !== (result.cells[result.cells.length - 1]?.date ?? null)) throw invalid();
  let actual: NonNullable<MarketTransactionsAnalytics['summary']>; try { actual = groupMarketTransactionCells(result.cells, result.types).summary; } catch { throw invalid(); }
  if (actual.entries !== c.includedEntries || (Object.keys(actual) as (keyof typeof actual)[]).some(key => actual[key] !== result.summary![key])) throw invalid();
  return result;
}
async function boundedJSON(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw invalid();
  const cancel = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true }); let bytes = 0, text = '', complete = false;
  try { for (;;) { signal.throwIfAborted(); const chunk = await reader.read(); signal.throwIfAborted(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > byteLimit) throw invalid(); text += decoder.decode(chunk.value, { stream: true }); } text += decoder.decode(); complete = true; return JSON.parse(text); }
  finally { signal.removeEventListener('abort', cancel); if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function marketTransactionsRequest(args: MarketTransactionsArgs, signal?: AbortSignal): Promise<MarketTransactionsAnalytics> {
  const selected = selection(args), controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); const timer = setTimeout(abort, 60000);
  let response: Response | undefined;
  try {
    controller.signal.throwIfAborted();
    response = await fetch('/api/eve/market-transactions', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selected), signal: controller.signal });
    if (!response.ok) throw new ConnectionResponseError(response.status === 401 ? 'Sign in again to load market transactions.' : response.status === 404 ? 'This character is no longer connected. Reload connection status.' : 'Market transactions could not be loaded. Try again or review the connection.', response.status);
    if (!response.headers.get('content-type')?.includes('application/json')) throw invalid();
    const value = await boundedJSON(response, controller.signal); controller.signal.throwIfAborted(); return marketTransactionsResponse(value, selected);
  } catch (error) { if (error instanceof ConnectionResponseError) throw error; throw new ConnectionResponseError(controller.signal.aborted ? 'The market transactions request was cancelled or timed out.' : 'The market transactions service could not be reached. Try again.'); }
  finally { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
