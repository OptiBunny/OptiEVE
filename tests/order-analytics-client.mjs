import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';
const compile = file => ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const args = { characterId: 90000001, entity: 'character' }, corp = { ...args, entity: 'corporation' };
const scopes = ['esi-markets.read_character_orders.v1', 'esi-markets.read_corporation_orders.v1'];
const stamp = '2026-01-02T00:00:00.000Z', now = Date.parse(stamp), plain = value => JSON.parse(JSON.stringify(value));
class ConnectionResponseError extends Error { constructor(message, status) { super(message); this.status = status; } }
function client(options = {}) {
  const mod = { exports: {} }, calls = [], timers = [], clears = [];
  vm.runInNewContext(compile('app/lib/order-analytics-client.ts'), { module: mod, exports: mod.exports, Date, AbortController, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: value => clears.push(value), fetch: async (...values) => { calls.push(values); return options.fetch ? options.fetch(...values, timers) : Response.json(await service(args)); }, require: path => { if (path === 'zod') return { z }; assert.equal(path, './connection-client'); return { ConnectionResponseError }; } });
  return { ...mod.exports, calls, timers, clears };
}
async function service(input = args, extra = {}, options = {}) {
  const mod = { exports: {} }, dates = { exports: {} };
  vm.runInNewContext(compile('app/lib/overview-summary.ts'), { module: dates, exports: dates.exports, Date });
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const deps = { now: () => now, connections: async () => [{ characterId: args.characterId, scopes: options.scopes ?? scopes }], orders: async (_user, selected) => ({ ...selected, ...(selected.entity === 'corporation' ? { corporationId: 98000001, page: selected.page, pageLimit: 500, morePagesAvailable: false, pageLimitReached: false } : {}), pages: 1, nextPage: null, retrievedAt: stamp, cacheExpires: 'Fri, 02 Jan 2026 01:00:00 GMT', cacheAge: '0', data: [
    { order_id: 70000001, type_id: 34, is_corporation: false, is_buy_order: true, price: 12.34, volume_remain: 30, volume_total: 50, duration: 3, issued: '2026-01-01T00:00:00Z' },
    { order_id: 70000002, type_id: 34, is_corporation: false, is_buy_order: false, price: 0, volume_remain: 0, volume_total: 50, min_volume: 3, duration: 3, issued: '2026-01-01T00:00:00Z' },
  ], ...extra }) };
  vm.runInNewContext(compile('app/lib/order-analytics.ts'), { module: mod, exports: mod.exports, Date, AbortSignal, require: path => path === './eve' ? { EveError, listConnections: deps.connections, readEve: deps.orders } : path === './overview-summary' ? dates.exports : { findPublishedManufacturingItem: id => id === 34 ? { name: 'Synthetic mineral' } : null } });
  return plain(await mod.exports.createOrderAnalyticsReader(deps)('synthetic-owner', input));
}
test('actual personal and corporation service DTOs satisfy strict client validation', async () => {
  for (const input of [args, corp]) { const result = await service(input); assert.deepEqual(plain(client().orderAnalyticsResponse(result, input)), result); }
  for (const extra of [{ data: [] }, { cacheExpires: null }, { pages: null, morePagesAvailable: null }]) { const result = await service(corp, extra); assert.deepEqual(plain(client().orderAnalyticsResponse(result, corp)), result); }
  const missing = await service(args, {}, { scopes: [] }); assert.equal(client().orderAnalyticsResponse(missing, args).status, 'needs_permission');
});
test('omitted optional side reaches both clients as Sell with consistent chart counts', async () => {
  const data = [{ order_id: 70000001, type_id: 34, is_corporation: false, price: 12.34, volume_remain: 30, volume_total: 50, duration: 3, issued: '2026-01-01T00:00:00Z' }];
  for (const input of [args, corp]) {
    const value = client().orderAnalyticsResponse(await service(input, { data }), input);
    assert.equal(value.status, 'ready'); assert.equal(value.orders[0].side, 'sell');
    assert.equal(value.summary.sell, 1); assert.equal(value.summary.buy, 0); assert.equal(value.summary.unknownSide, 0);
  }
});
const mutations = {
  'wrong character': value => { value.characterId++; }, 'wrong owner': value => { value.entity = 'corporation'; }, 'unexpected private field': value => { value.source = 'private'; }, 'wrong scope': value => { value.scope = scopes[1]; },
  'character corporation ID': value => { value.corporationId = 98000001; }, 'character page': value => { value.coverage.page = 1; }, 'character page count': value => { value.coverage.pages = 1; }, 'extra page': value => { value.coverage.nextPage = 2; },
  'wrong row count': value => { value.coverage.rows++; }, 'wrong summary': value => { value.summary.buy++; }, 'wrong types': value => { value.summary.types++; }, 'wrong side count': value => { value.summary.unknownSide++; }, 'wrong expiry count': value => { value.summary.pastReportedExpiry++; },
  'wrong next-day count': value => { value.summary.dueWithin24h++; }, 'wrong exclusions': value => { value.summary.excludedCorporationOrders++; }, 'wrong unmapped count': value => { value.summary.unmappedTypes++; },
  'duplicate orders': value => { value.orders[1].orderId = value.orders[0].orderId; }, 'unsafe quantity': value => { value.orders[0].originalQuantity = Number.MAX_SAFE_INTEGER + 1; }, 'excess remaining': value => { value.orders[0].remainingQuantity = 51; },
  'unknown side value': value => { value.orders[0].side = 'bid'; }, 'zero minimum': value => { value.orders[0].minimumVolume = 0; }, 'numeric price': value => { value.orders[0].unitPrice = 12.34; }, 'padded price': value => { value.orders[0].unitPrice = '12.340'; },
  'negative price': value => { value.orders[0].unitPrice = '-1'; }, 'nonfinite price': value => { value.orders[0].unitPrice = 'Infinity'; }, 'unsafe price': value => { value.orders[0].unitPrice = '9007199254740992'; }, 'extra order metadata': value => { value.orders[0].issuerId = 90009999; },
  'wrong expiry arithmetic': value => { value.orders[0].durationDays++; }, 'noncanonical timestamp': value => { value.orders[0].issuedAt = '2026-01-01T01:00:00+01:00'; }, 'date rollover': value => { value.orders[0].issuedAt = '2026-02-30T00:00:00.000Z'; },
  'future retrieval': value => { value.freshness.retrievedAt = '2026-01-03T00:00:00.000Z'; }, 'false stale state': value => { value.freshness.state = 'stale'; }, 'wrong ready status': value => { value.status = 'partial'; },
  'contradictory same-type catalog name': value => { value.orders[1].name = 'Another name'; }, 'contradictory same-type mapped flag': value => { value.orders[1].mapped = false; value.orders[1].name = 'Type 34'; value.summary.unmappedTypes = 1; value.status = 'partial'; },
  'private label control': value => { value.orders[0].name = 'Synthetic\u202ename'; },
};
for (const [name, mutate] of Object.entries(mutations)) test(`rejects ${name}`, async () => { const value = await service(); mutate(value); assert.throws(() => client().orderAnalyticsResponse(value, args), ConnectionResponseError); });
test('unknown side and missing catalog remain valid partial DTOs', async () => {
  const source = await service(); source.orders[0].side = 'unknown'; source.summary.buy--; source.summary.unknownSide++; source.status = 'partial';
  assert.equal(client().orderAnalyticsResponse(source, args).summary.unknownSide, 1);
  for (const row of source.orders) { row.mapped = false; row.name = 'Type 34'; } source.summary.unmappedTypes = 2;
  assert.equal(client().orderAnalyticsResponse(source, args).summary.unmappedTypes, 2);
});
test('unavailable states cannot carry cached private results or counts', async () => {
  for (const mutate of [v => { v.orders = (awaitableOrders); }, v => { v.summary = {}; }, v => { v.coverage.rows = 1; }, v => { v.freshness.cacheExpires = stamp; }, v => { v.corporationId = 1; }]) {
    const value = await service(args, {}, { scopes: [] }); mutate(value); assert.throws(() => client().orderAnalyticsResponse(value, args));
  }
});
const awaitableOrders = [{ orderId: 1 }];
test('corp pagination must bind page, total and ceiling metadata consistently', async () => {
  const input = { ...corp, page: 2 }, value = await service(input, { pages: 3, nextPage: 3, morePagesAvailable: true });
  assert.equal(client().orderAnalyticsResponse(value, input).coverage.previousPage, 1);
  for (const mutate of [v => { v.coverage.nextPage = null; }, v => { v.coverage.previousPage = null; }, v => { v.coverage.pages = 1; }, v => { v.summary.excludedCorporationOrders = 1; v.coverage.rows++; }, v => { v.corporationId = null; }]) { const changed = plain(value); mutate(changed); assert.throws(() => client().orderAnalyticsResponse(changed, input)); }
});
test('strict input rejects pages on personal requests and extra or invalid options before fetching', async () => {
  const h = client(); for (const input of [{ ...args, page: 1 }, { ...args, page: undefined }, { ...corp, page: undefined }, { ...corp, page: 501 }, { ...corp, page: 0 }, { ...args, scope: 'extra' }]) await assert.rejects(h.orderAnalyticsRequest(input)); assert.equal(h.calls.length, 0);
});
test('request uses authenticated same-origin no-store POST and clears the timeout', async () => {
  const h = client(); const result = await h.orderAnalyticsRequest(args); assert.equal(result.orders.length, 2); assert.equal(h.calls.length, 1);
  const [url, options] = h.calls[0]; assert.equal(url, '/api/eve/order-analytics'); assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error'); assert.deepEqual(JSON.parse(options.body), args); assert.equal(h.timers[0].ms, 60000); assert.equal(h.clears.length, 1);
});
test('HTTP failures, non-JSON and malformed bodies produce bounded generic errors', async () => {
  for (const status of [401, 403, 404, 429, 500]) { const h = client({ fetch: async () => new Response('PRIVATE_BODY', { status }) }); await assert.rejects(h.orderAnalyticsRequest(args), error => error.status === status && !error.message.includes('PRIVATE')); }
  for (const response of [new Response('PRIVATE_BODY'), Response.json({ secret: 'PRIVATE_BODY' })]) await assert.rejects(client({ fetch: async () => response }).orderAnalyticsRequest(args), error => !error.message.includes('PRIVATE'));
});
test('pre-cancelled and in-flight cancelled reads cannot publish late results', async () => {
  const controller = new AbortController(); controller.abort(); const before = client(); await assert.rejects(before.orderAnalyticsRequest(args, controller.signal), /cancelled/); assert.equal(before.calls.length, 0);
  const late = new AbortController(), h = client({ fetch: async () => { late.abort(); return Response.json(await service()); } }); await assert.rejects(h.orderAnalyticsRequest(args, late.signal), /cancelled/); assert.equal(h.clears.length, 1);
  const timeout = client({ fetch: async (_u, _o, timers) => { timers[0].fn(); return Response.json(await service()); } }); await assert.rejects(timeout.orderAnalyticsRequest(args), /timed out/);
});
