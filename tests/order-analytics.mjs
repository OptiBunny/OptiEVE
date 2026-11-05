import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const compile = file => ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const code = compile('app/lib/order-analytics.ts'), dates = { exports: {} };
vm.runInNewContext(compile('app/lib/overview-summary.ts'), { module: dates, exports: dates.exports, Date });
const now = Date.parse('2026-01-02T00:00:00Z'), stamp = new Date(now).toISOString();
const args = { characterId: 90000001, entity: 'character' }, corp = { ...args, entity: 'corporation' };
const scopes = ['esi-markets.read_character_orders.v1', 'esi-markets.read_corporation_orders.v1'];
const plain = value => JSON.parse(JSON.stringify(value));
const row = (id = 70000001, extra = {}) => ({ order_id: id, type_id: 34, is_corporation: false, is_buy_order: true, price: 12.34, volume_remain: 30, volume_total: 50, duration: 3, issued: '2026-01-01T00:00:00Z', location_id: 60000001, issued_by: 90009999, wallet_division: 7, escrow: 999, private_name: 'OMIT_PRIVATE_NAME', ...extra });
function response(input, extra = {}) { return { ...input, ...(input.entity === 'corporation' ? { corporationId: 98000001, page: input.page, pages: 1, nextPage: null, pageLimit: 500, morePagesAvailable: false, pageLimitReached: false } : { pages: 1, nextPage: null }), data: [row()], retrievedAt: stamp, cacheExpires: 'Fri, 02 Jan 2026 01:00:00 GMT', responseDate: 'Fri, 02 Jan 2026 00:00:00 GMT', cacheControl: 'private, max-age=3600', cacheAge: '0', lastModified: 'Thu, 01 Jan 2026 23:59:00 GMT', nextFromId: null, source: 'OMIT_PRIVATE_SOURCE', ...extra }; }
function harness(options = {}) {
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const calls = [], deadline = new AbortController();
  const dependencies = {
    connections: async user => { calls.push({ kind: 'connections', user }); return options.connections ? options.connections(user, deadline) : [{ characterId: args.characterId, scopes }]; },
    orders: async (user, input, signal) => { calls.push({ kind: 'orders', user, input, signal }); return options.orders ? options.orders(user, input, signal, EveError, deadline) : response(input, options.result); },
    now: () => typeof options.now === 'function' ? options.now() : options.now ?? now,
  };
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, Date, AbortSignal: { any: AbortSignal.any.bind(AbortSignal), timeout: milliseconds => { assert.equal(milliseconds, 55000); return deadline.signal; } }, require: path => {
    if (path === './overview-summary') return dates.exports;
    if (path === './manufacturing-catalog') return { findPublishedManufacturingItem: id => [34, 35].includes(id) ? { name: `Synthetic mineral ${id}` } : null };
    assert.equal(path, './eve'); return { EveError, listConnections: dependencies.connections, readEve: dependencies.orders };
  } });
  return { read: mod.exports.createOrderAnalyticsReader(dependencies), validate: mod.exports.validateOrderAnalyticsArgs, calls, deadline };
}
test('personal response counts omitted optional side as sell and excludes corporation orders', async () => {
  const omitted = row(70000003, { type_id: 35 }); delete omitted.is_buy_order;
  const h = harness({ result: { data: [row(), row(70000002, { is_buy_order: false }), omitted, row(70000004, { is_corporation: true, type_id: 999 })] } });
  const result = await h.read('synthetic-owner', args);
  assert.equal(result.status, 'ready'); assert.equal(result.coverage.rows, 4); assert.equal(result.summary.orders, 3); assert.equal(result.summary.types, 2);
  assert.equal(result.summary.buy, 1); assert.equal(result.summary.sell, 2); assert.equal(result.summary.unknownSide, 0); assert.equal(result.summary.excludedCorporationOrders, 1);
  assert.equal(result.orders[0].unitPrice, '12.34'); assert.equal(result.orders[0].expiresAt, '2026-01-04T00:00:00.000Z'); assert.equal(result.orders[0].minimumVolume, null);
  assert.deepEqual(plain(h.calls[1].input), { ...args, dataset: 'orders' }); assert(h.calls[1].signal instanceof AbortSignal);
  for (const forbidden of ['OMIT_PRIVATE', '90009999', '60000001', '70000004', 'location_id', 'issued_by', 'escrow', 'wallet_division', '"source":']) assert(!JSON.stringify(result.orders).includes(forbidden));
  assert.match(result.limitations.join(' '), /not established sales or fills/); assert.match(result.limitations.join(' '), /omitted buy-order flag means Sell/);
  assert.deepEqual(plain(result.orders.map(row => row.side)), ['buy', 'sell', 'sell']);
});
test('empty personal results and corporation-only personal results are explicit', async () => {
  for (const data of [[], [row(70000001, { is_corporation: true })]]) {
    const result = await harness({ result: { data } }).read('synthetic-owner', args);
    assert.equal(result.status, 'ready'); assert.equal(result.summary.orders, 0); assert.equal(result.summary.excludedCorporationOrders, data.length); assert.equal(result.orders.length, 0);
  }
});
test('corporation requests preserve owner, page and role scope without personal substitution', async () => {
  const h = harness({ result: { pages: 3, nextPage: 3, morePagesAvailable: true } });
  const result = await h.read('synthetic-owner', { ...corp, page: 2 });
  assert.equal(result.corporationId, 98000001); assert.equal(result.coverage.kind, 'partial'); assert.equal(result.coverage.previousPage, 1); assert.equal(result.coverage.nextPage, 3); assert.equal(result.summary.excludedCorporationOrders, 0);
  assert.deepEqual(plain(h.calls[1].input), { ...corp, page: 2, dataset: 'orders' }); assert.equal(result.scope, scopes[1]);
});
test('corporation order sides follow optional ESI boolean semantics after field validation', async () => {
  const omitted = row(70000001); delete omitted.is_buy_order;
  const result = await harness({ result: { data: [omitted, row(70000002, { is_buy_order: false }), row(70000003)] } }).read('synthetic-owner', corp);
  assert.equal(result.status, 'ready'); assert.equal(result.summary.orders, 3);
  assert.equal(result.summary.buy, 1); assert.equal(result.summary.sell, 2); assert.equal(result.summary.unknownSide, 0);
  assert.deepEqual(plain(result.orders.map(row => row.side)), ['sell', 'sell', 'buy']);
});
test('present malformed optional order sides are rejected for both owners', async () => {
  for (const input of [args, corp]) for (const is_buy_order of [null, 'false', 0, 1, [], {}]) {
    const result = await harness({ result: { data: [row(70000001, { is_buy_order })] } }).read('synthetic-owner', input);
    assert.equal(result.status, 'error'); assert.equal(result.summary, null); assert.equal(result.orders.length, 0);
  }
});
test('unknown pages and page-limit coverage remain partial', async () => {
  const result = await harness({ result: { pages: null, nextPage: null, morePagesAvailable: null, pageLimitReached: true } }).read('synthetic-owner', { ...corp, page: 500 });
  assert.equal(result.coverage.kind, 'unknown'); assert.equal(result.coverage.pageLimitReached, true); assert.equal(result.coverage.nextPage, null);
});
test('unknown public types retain explicit IDs and mark partial', async () => {
  const result = await harness({ result: { data: [row(70000001, { type_id: 999999999 })] } }).read('synthetic-owner', args);
  assert.equal(result.orders[0].name, 'Type 999999999'); assert.equal(result.orders[0].mapped, false); assert.equal(result.summary.unmappedTypes, 1); assert.equal(result.status, 'partial');
});
test('zero quantities and prices remain explicit and large integer units stay exact', async () => {
  const result = await harness({ result: { data: [row(70000001, { price: 0, volume_remain: 0, volume_total: Number.MAX_SAFE_INTEGER, min_volume: 5 }), row(70000002, { price: 1e-7 })] } }).read('synthetic-owner', args);
  assert.equal(result.orders[0].unitPrice, '0'); assert.equal(result.orders[0].originalQuantity, Number.MAX_SAFE_INTEGER); assert.equal(result.orders[0].remainingQuantity, 0); assert.equal(result.orders[0].minimumVolume, 5); assert.equal(result.orders[1].unitPrice, '1e-7');
});
test('expiry dates normalize offset time and classify past and next-day endpoints at completion', async () => {
  const result = await harness({ result: { data: [row(70000001, { issued: '2026-01-01T01:00:00+01:00', duration: 1 }), row(70000002, { issued: '2026-01-02T00:00:00Z', duration: 1 }), row(70000003)] } }).read('synthetic-owner', args);
  assert.equal(result.orders[0].issuedAt, '2026-01-01T00:00:00.000Z'); assert.equal(result.summary.pastReportedExpiry, 1); assert.equal(result.summary.dueWithin24h, 1);
});
for (const [name, change] of Object.entries({ duplicate: { data: [row(), row()] }, side: { data: [row(70000001, { is_buy_order: null })] }, ownership: { data: [row(70000001, { is_corporation: undefined })] }, negative: { data: [row(70000001, { volume_remain: -1 })] }, unsafe: { data: [row(70000001, { volume_total: Number.MAX_SAFE_INTEGER + 1 })] }, excess: { data: [row(70000001, { volume_remain: 51 })] }, date: { data: [row(70000001, { issued: '2026-02-30T00:00:00Z' })] }, overflow: { data: [row(70000001, { issued: '9999-12-31T00:00:00Z', duration: 1 })] }, duration: { data: [row(70000001, { duration: 0 })] }, price: { data: [row(70000001, { price: Infinity })] }, minimum: { data: [row(70000001, { min_volume: 0 })] }, oversized: { data: Array.from({ length: 5001 }, (_, index) => row(70000001 + index)) } })) {
  test(`rejects malformed ${name} response without partial summaries`, async () => { const result = await harness({ result: change }).read('synthetic-owner', args); assert.equal(result.status, 'error'); assert.equal(result.summary, null); assert.equal(result.orders.length, 0); });
}
test('rejects mismatched owner, dataset, pagination and future retrieval metadata', async () => {
  for (const extra of [{ characterId: 2 }, { entity: 'corporation' }, { dataset: 'assets' }, { corporationId: 3 }, { page: 1 }, { pages: null }, { nextPage: 2 }, { retrievedAt: '2026-01-03T00:00:00Z' }]) assert.equal((await harness({ result: extra }).read('synthetic-owner', args)).status, 'error');
  for (const extra of [{ pages: 1 }, { nextPage: 8 }, { pageLimit: 50 }, { morePagesAvailable: false }]) assert.equal((await harness({ result: { pages: 3, nextPage: 3, morePagesAvailable: true, ...extra } }).read('synthetic-owner', { ...corp, page: 2 })).status, 'error');
});
test('cache age, no-store and stale-at-completion remain visible', async () => {
  const aged = await harness({ result: { cacheAge: '3600' } }).read('synthetic-owner', args); assert.equal(aged.freshness.state, 'stale');
  const noStore = await harness({ result: { cacheControl: 'no-store' } }).read('synthetic-owner', args); assert.equal(noStore.freshness.state, 'stale');
  const unknown = await harness({ result: { cacheExpires: null, cacheControl: null, responseDate: null } }).read('synthetic-owner', args); assert.equal(unknown.freshness.state, 'unknown');
  const invalidAge = await harness({ result: { cacheAge: '-1' } }).read('synthetic-owner', args); assert.equal(invalidAge.freshness.state, 'unknown');
});
test('strict selections fail before any read and character pages are disallowed', async () => {
  const h = harness(); for (const value of [{ ...args, page: 1 }, { ...corp, page: 0 }, { ...corp, page: 501 }, { ...corp, page: undefined }, { ...args, extra: true }, { ...args, characterId: 0 }, { ...args, entity: 'all' }]) await assert.rejects(h.read('synthetic-owner', value)); assert.equal(h.calls.length, 0);
  await assert.rejects(h.read('', args), error => error.status === 401);
});
test('missing connection and grant avoid data access', async () => {
  const missing = harness({ connections: async () => [] }); await assert.rejects(missing.read('synthetic-owner', args), error => error.status === 404); assert.equal(missing.calls.length, 1);
  const grants = harness({ connections: async () => [{ characterId: args.characterId, scopes: [] }] }); const result = await grants.read('synthetic-owner', args); assert.equal(result.status, 'needs_permission'); assert.equal(grants.calls.length, 1);
});
test('provider errors are generic, do not leak private messages and never retry', async () => {
  for (const status of [401, 403, 404, 409, 429, 500]) { const h = harness({ orders: async (_u, _a, _s, E) => { throw new E('OMIT_PRIVATE_TOKEN', status); } }); const result = await h.read('synthetic-owner', args); assert(['unavailable', 'error'].includes(result.status)); assert(!JSON.stringify(result).includes('OMIT_PRIVATE')); assert.equal(h.calls.length, 2); }
});
test('shared deadline races uncooperative connection and data promises', async () => {
  for (const stage of ['connections', 'orders']) { const h = harness({ [stage]: async (...values) => { values.at(-1).abort(); return new Promise(() => {}); } }); const result = await h.read('synthetic-owner', args); assert.equal(result.status, 'unavailable'); assert.match(result.message, /time limit/); }
  const controller = new AbortController(); controller.abort(); await assert.rejects(harness().read('synthetic-owner', args, { signal: controller.signal }));
});
