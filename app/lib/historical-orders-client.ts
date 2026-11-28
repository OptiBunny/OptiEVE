import { z } from 'zod';
import { ConnectionResponseError } from './connection-client';
import type { HistoricalOrders, HistoricalOrdersArgs } from './historical-orders-types';

const bytesLimit = 4 * 1024 * 1024;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = count.min(1);
const rows = count.max(5000);
const stamp = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  .refine(s => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s);
const text = z.string().max(2048);
const selection = z.strictObject({ characterId: id, page: id.max(500).optional() });
const price = z.string().max(326).regex(/^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/)
  .refine(value => {
    const [whole, fraction] = value.split('.');
    const limit = String(Number.MAX_SAFE_INTEGER);
    return whole.length < limit.length || whole.length === limit.length && (whole < limit || whole === limit && !fraction);
  });
const schema = z.strictObject({
  characterId: id, generatedAt: stamp, status: z.enum(['ready','partial','needs_permission','unavailable','error']),
  scope: z.literal('esi-markets.read_character_orders.v1'), message: text,
  coverage: z.strictObject({
    kind: z.enum(['returned_page','unavailable']), page: id.max(500), pages: id.nullable(),
    previousPage: id.max(500).nullable(), nextPage: id.max(500).nullable(), pageLimitReached: z.boolean(),
    returnedRows: rows.nullable(), includedRows: rows.nullable(), excludedCorporationRows: rows.nullable(),
  }),
  freshness: z.strictObject({ state: z.enum(['fresh','stale','unknown']), retrievedAt: stamp.nullable(), cacheExpires: stamp.nullable(), lastModified: stamp.nullable() }),
  summary: z.strictObject({ orders: rows, types: rows, buy: rows, sell: rows, cancelled: rows, expired: rows,
    other: rows, unmappedTypes: rows, earliestIssuedAt: stamp.nullable(), latestIssuedAt: stamp.nullable() }).nullable(),
  orders: z.array(z.strictObject({ row: id.max(5000), typeId: id, side: z.enum(['buy','sell']), state: z.enum(['cancelled','expired','other']),
    issuedAt: stamp, unitPriceISK: price, originalQuantity: count, remainingQuantity: count })).max(5000),
  types: z.array(z.strictObject({ typeId: id, name: z.string().min(1).max(128).refine(v =>
    v.trim() === v && !/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(v)), mapped: z.boolean() })).max(5000),
  limitations: z.array(text).max(20),
});
const invalid = () => new ConnectionResponseError('Historical orders could not be verified. Load the page again.');

export function historicalOrdersResponse(value: unknown, args: HistoricalOrdersArgs): HistoricalOrders {
  if (!selection.safeParse(args).success) throw invalid();
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid();
  const result = parsed.data;
  const { coverage, freshness, summary, orders, types } = result;
  const page = args.page ?? 1;
  if (result.characterId !== args.characterId || coverage.page !== page || coverage.previousPage !== (page > 1 ? page - 1 : null)) throw invalid();
  if (result.status !== 'ready' && result.status !== 'partial') {
    if (summary !== null || orders.length || types.length || coverage.kind !== 'unavailable' || coverage.pages !== null ||
        coverage.nextPage !== null || coverage.pageLimitReached || coverage.returnedRows !== null || coverage.includedRows !== null ||
        coverage.excludedCorporationRows !== null || freshness.state !== 'unknown' || freshness.retrievedAt !== null ||
        freshness.cacheExpires !== null || freshness.lastModified !== null) throw invalid();
    return result;
  }
  if (!summary || coverage.kind !== 'returned_page' || coverage.includedRows !== orders.length || coverage.excludedCorporationRows === null ||
      coverage.returnedRows !== orders.length + coverage.excludedCorporationRows || (coverage.pages !== null && coverage.pages < page) ||
      coverage.nextPage !== (coverage.pages !== null && page < coverage.pages && page < 500 ? page + 1 : null) ||
      coverage.pageLimitReached !== (page === 500 && (coverage.pages === null || coverage.pages > page)) ||
      freshness.retrievedAt === null || Date.parse(freshness.retrievedAt) > Date.parse(result.generatedAt) + 60000 ||
      freshness.state !== (freshness.cacheExpires === null ? 'unknown' : freshness.cacheExpires <= result.generatedAt ? 'stale' : 'fresh')) throw invalid();
  const used = new Set(orders.map(order => order.typeId));
  if (types.length !== used.size || types.some((type, index) => !used.has(type.typeId) ||
      (index > 0 && types[index-1].typeId >= type.typeId) || (!type.mapped && type.name !== 'Type ' + type.typeId))) throw invalid();
  let buy = 0, cancelled = 0, expired = 0;
  for (const [index, order] of orders.entries()) {
    if (order.row !== index + 1 || order.remainingQuantity > order.originalQuantity || (index > 0 && orders[index-1].issuedAt < order.issuedAt)) throw invalid();
    if (order.side === 'buy') buy++;
    if (order.state === 'cancelled') cancelled++;
    if (order.state === 'expired') expired++;
  }
  const other = orders.length - cancelled - expired;
  if (summary.orders !== orders.length || summary.types !== used.size || summary.buy !== buy || summary.sell !== orders.length - buy ||
      summary.cancelled !== cancelled || summary.expired !== expired || summary.other !== other ||
      summary.unmappedTypes !== types.filter(type => !type.mapped).length || summary.earliestIssuedAt !== (orders.at(-1)?.issuedAt ?? null) ||
      summary.latestIssuedAt !== (orders[0]?.issuedAt ?? null) ||
      result.status !== (page === 1 && coverage.pages === 1 && freshness.state === 'fresh' && other === 0 ? 'ready' : 'partial')) throw invalid();
  return result;
}

async function readPage(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw invalid();
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let buffer = new Uint8Array(16 * 1024), length = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (value.byteLength > bytesLimit - length) throw invalid();
      if (length + value.byteLength > buffer.length) {
        const next = new Uint8Array(Math.min(bytesLimit, Math.max(buffer.length * 2, length + value.byteLength)));
        next.set(buffer.subarray(0, length)); buffer = next;
      }
      buffer.set(value, length); length += value.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel(); reader.releaseLock();
  }
}

export async function historicalOrdersRequest(args: HistoricalOrdersArgs, signal: AbortSignal) {
  const input = selection.safeParse(args);
  if (!input.success) throw invalid();
  const controller = new AbortController(), abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timeout = setTimeout(abort, 60000);
  let response: Response | undefined;
  try {
    controller.signal.throwIfAborted();
    response = await fetch('/api/eve/historical-orders', { method: 'POST', credentials: 'same-origin',
      cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input.data), signal: controller.signal });
    if (!response.ok) throw new ConnectionResponseError(response.status === 401 ? 'Sign in again to load historical orders.' :
      response.status === 404 ? 'Reload connections and select a connected character.' : 'Historical orders could not be loaded.', response.status);
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw invalid();
    return historicalOrdersResponse(await readPage(response, controller.signal), input.data);
  } catch (error) {
    if (error instanceof ConnectionResponseError) throw error;
    throw new ConnectionResponseError(controller.signal.aborted ? 'The historical orders request was cancelled or timed out.' : 'Historical orders could not be read.');
  } finally {
    clearTimeout(timeout); signal.removeEventListener('abort', abort);
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
  }
}
