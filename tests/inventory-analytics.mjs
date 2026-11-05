import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const compile = file => ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const code = compile('app/lib/inventory-analytics.ts'), summaryModule = { exports: {} };
vm.runInNewContext(compile('app/lib/overview-summary.ts'), { module: summaryModule, exports: summaryModule.exports, Date });
const now = Date.parse('2026-01-02T00:00:00Z'), stamp = new Date(now).toISOString();
const args = { characterId: 90000001, entity: 'character' }, corporation = { ...args, entity: 'corporation' };
const scopes = ['esi-assets.read_assets.v1', 'esi-assets.read_corporation_assets.v1'];
const plain = value => JSON.parse(JSON.stringify(value));
const row = (itemId, typeId = 34, quantity = 1, overrides = {}) => ({ item_id: itemId, type_id: typeId, quantity, location_id: 60000001, location_type: 'station', location_flag: 'Hangar', is_singleton: false, is_blueprint_copy: false, name: 'OMIT_PRIVATE_NAME', note: 'OMIT_PRIVATE_NOTE', owner_id: 90009999, ...overrides });
const catalog = typeId => typeId === 34 || typeId === 35 ? { typeId, name: `Synthetic mineral ${typeId}`, groupId: 18, groupName: 'Synthetic minerals', categoryId: 4, categoryName: 'Synthetic materials' } : typeId === 10001 ? { typeId, name: 'Synthetic ship', groupId: 25, groupName: 'Synthetic ships', categoryId: 6, categoryName: 'Synthetic vessels' } : null;
function response(input, overrides = {}) {
  return { ...input, ...(input.entity === 'corporation' ? { corporationId: 98000001 } : {}), data: [row(70000001)], retrievedAt: stamp, cacheExpires: 'Fri, 02 Jan 2026 01:00:00 GMT', cacheControl: 'private, max-age=3600', responseDate: 'Fri, 02 Jan 2026 00:00:00 GMT', cacheAge: '0', lastModified: 'Thu, 01 Jan 2026 23:59:00 GMT', pages: 1, nextPage: null, pageLimit: 500, morePagesAvailable: false, pageLimitReached: false, source: 'OMIT_PRIVATE_SOURCE', ...overrides };
}
function harness(options = {}) {
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const calls = [], deadline = new AbortController();
  const deps = {
    connections: async user => { calls.push({ operation: 'connections', user }); return options.connections ? options.connections(user, deadline) : [{ characterId: args.characterId, scopes }]; },
    assets: async (user, input, signal) => { calls.push({ operation: 'assets', user, input, signal }); return options.assets ? options.assets(user, input, signal, EveError, deadline) : response(input, options.result); },
    now: () => typeof options.now === 'function' ? options.now() : options.now ?? now,
  };
  const fixtureModule = { exports: {} };
  vm.runInNewContext(code, { module: fixtureModule, exports: fixtureModule.exports, Date, AbortSignal: { any: AbortSignal.any.bind(AbortSignal), timeout: ms => { assert.equal(ms, 55000); return deadline.signal; } }, require: path => {
    if (path === './overview-summary') return summaryModule.exports;
    if (path === './manufacturing-catalog') return { findPublishedManufacturingItem: catalog };
    assert.equal(path, './eve'); return { EveError, listConnections: deps.connections, readEve: deps.assets };
  } });
  return { read: fixtureModule.exports.createInventoryAnalyticsReader(deps), calls, deadline };
}

test('one inventory page counts records by category/group/location and quantities only within each type', async () => {
  const h = harness({ result: { data: [row(70000001, 34, 10), row(70000002, 34, 20), row(70000003, 35, 500, { location_id: 70000004, location_type: 'item', location_flag: 'InfrastructureHangar' }), row(70000004, 10001, 1, { is_singleton: true })] } });
  const result = await h.read('synthetic-owner', args);
  assert.equal(result.status, 'ready'); assert.equal(result.coverage.kind, 'complete_returned_list');
  assert.deepEqual(plain(result.summary), { records: 4, types: 3, locations: 2, singletonRecords: 1, blueprintCopyRecords: 0, blueprintCopyUnknownRecords: 0, unmappedTypeRecords: 0 });
  assert.equal(result.types[0].typeId, 34); assert.equal(result.types[0].records, 2); assert.equal(result.types[0].quantity, 30);
  assert.deepEqual(plain(result.categories), [{ categoryId: 4, name: 'Synthetic materials', records: 3, typeCount: 2 }, { categoryId: 6, name: 'Synthetic vessels', records: 1, typeCount: 1 }]);
  assert.equal(result.groups[0].records, 3); assert.equal(result.locations[0].records, 3); assert.equal(result.locations[0].typeCount, 2);
  assert.equal(result.locations[1].kind, 'item'); assert.equal(result.locations[1].locationId, 70000004);
  assert(h.calls.every(call => call.user === 'synthetic-owner')); assert(h.calls[1].signal instanceof AbortSignal);
  assert.deepEqual(plain(h.calls[1].input), { ...args, page: 1, dataset: 'assets' });
  for (const secret of ['OMIT_PRIVATE', '90009999', '70000001', 'owner_id', 'location_flag', '"source":']) assert(!JSON.stringify(result).includes(secret), secret);
  for (const list of [result.categories, result.groups, result.locations]) assert(list.every(value => !Object.hasOwn(value, 'quantity')));
  assert.match(result.limitations.join(' '), /not physical item units/); assert.match(result.limitations.join(' '), /net worth/);
});

test('unmapped published catalog types remain explicit and missing copy flags are unknown', async () => {
  const omitted = row(70000001, 999999999, 8); delete omitted.is_blueprint_copy;
  const result = await harness({ result: { data: [omitted, row(70000002, 999999999, 3, { is_singleton: true, is_blueprint_copy: true }), row(70000003, 34, 1)] } }).read('synthetic-owner', args);
  assert.equal(result.status, 'partial'); assert.equal(result.summary.unmappedTypeRecords, 2);
  assert.equal(result.summary.blueprintCopyRecords, 1); assert.equal(result.summary.blueprintCopyUnknownRecords, 1);
  assert.equal(result.types[0].name, 'Type 999999999'); assert.equal(result.types[0].groupId, null); assert.equal(result.types[0].categoryId, null);
  assert.equal(result.types[0].quantity, 11); assert.equal(result.types[0].blueprintCopyUnknownRecords, 1);
  assert.equal(result.categories[0].name, 'Unmapped category'); assert.equal(result.groups[0].name, 'Unmapped group');
  assert.match(result.message, /absent from the pinned public catalog/);
});

test('empty returned list and explicitly reported zero quantities remain distinct from failure', async () => {
  const result = await harness({ result: { data: [] } }).read('synthetic-owner', args);
  assert.equal(result.status, 'ready'); assert.equal(result.summary.records, 0); assert.equal(result.types.length, 0); assert.equal(result.locations.length, 0);
  const zero = await harness({ result: { data: [row(70000001, 34, 0)] } }).read('synthetic-owner', args);
  assert.equal(zero.types[0].quantity, 0); assert.equal(zero.summary.records, 1);
});

test('corporation selection stays in its current corporation and uses its own scope', async () => {
  const h = harness(), result = await h.read('synthetic-owner', corporation);
  assert.equal(result.entity, 'corporation'); assert.equal(result.corporationId, 98000001); assert.equal(result.scope, scopes[1]);
  assert.deepEqual(plain(h.calls[1].input), { ...corporation, page: 1, dataset: 'assets' });
  for (const data of [{ corporationId: undefined }, { corporationId: -1 }, { division: 1 }, { entity: 'character' }, { characterId: args.characterId + 1 }]) {
    const failed = await harness({ result: data }).read('synthetic-owner', corporation); assert.equal(failed.status, 'error'); assert.equal(failed.summary, null);
  }
  assert.equal((await harness({ result: { corporationId: 98000001 } }).read('synthetic-owner', args)).status, 'error');
});

test('explicit paging replaces the response and records incomplete or unknown coverage', async () => {
  const first = await harness({ result: { pages: 3, nextPage: 2, morePagesAvailable: true } }).read('synthetic-owner', args);
  assert.equal(first.status, 'partial'); assert.equal(first.coverage.kind, 'partial'); assert.equal(first.coverage.nextPage, 2); assert.equal(first.coverage.previousPage, null);
  const second = await harness({ result: { pages: 3, nextPage: 3, morePagesAvailable: true } }).read('synthetic-owner', { ...args, page: 2 });
  assert.equal(second.coverage.page, 2); assert.equal(second.coverage.previousPage, 1); assert.equal(second.summary.records, 1);
  const unknown = await harness({ result: { pages: null, nextPage: null, morePagesAvailable: null } }).read('synthetic-owner', args);
  assert.equal(unknown.coverage.kind, 'unknown'); assert.equal(unknown.coverage.nextPage, null);
  const cap = await harness({ result: { pages: 501, nextPage: null, morePagesAvailable: true, pageLimitReached: true } }).read('synthetic-owner', { ...args, page: 500 });
  assert.equal(cap.coverage.pageLimitReached, true); assert.equal(cap.coverage.nextPage, null);
  for (const data of [{ pages: 0 }, { pages: undefined }, { pages: 3, nextPage: 3 }, { page: 2 }, { pageLimit: 100 }, { pageLimitReached: true }, { morePagesAvailable: true }]) assert.equal((await harness({ result: data }).read('synthetic-owner', args)).status, 'error');
});

test('only a selected owned connection and existing permission can cause an asset read', async () => {
  const noUser = harness(); await assert.rejects(noUser.read('', args), error => error.status === 401); assert.equal(noUser.calls.length, 0);
  const missing = harness({ connections: async () => [] }); await assert.rejects(missing.read('synthetic-owner', args), error => error.status === 404); assert.equal(missing.calls.length, 1);
  const scoped = harness({ connections: async () => [{ characterId: args.characterId, scopes: [scopes[0]] }] });
  const result = await scoped.read('synthetic-owner', corporation); assert.equal(result.status, 'needs_permission'); assert.equal(result.summary, null); assert.equal(scoped.calls.length, 1);
  const wrong = harness({ connections: async () => [{ characterId: args.characterId + 1, scopes }] }); await assert.rejects(wrong.read('synthetic-owner', args), error => error.status === 404); assert.equal(wrong.calls.length, 1);
});

test('invalid selection never checks connection state or makes an upstream call', async () => {
  for (const input of [null, [], {}, { ...args, entity: 'all' }, { ...args, characterId: 0 }, { ...args, page: 0 }, { ...args, page: 501 }, { ...args, page: 1.5 }, { ...args, page: undefined }, { ...args, division: 1 }, { ...args, write: true }, { ...args, characterId: '90000001' }]) {
    const h = harness(); await assert.rejects(h.read('synthetic-owner', input)); assert.equal(h.calls.length, 0);
  }
});

test('malformed, duplicate, oversized and unsafe quantities reject the entire page', async () => {
  const invalidRows = [
    [row(1), row(1)], Array.from({ length: 1001 }, (_, i) => row(i + 1)), [row(1, 34, -1)], [row(1, 34, 1.5)], [row(1, 34, Number.MAX_SAFE_INTEGER), row(2, 34, 1)],
    [row(1, 34, 1, { item_id: '1' })], [row(1, 34, 1, { type_id: 0 })], [row(1, 34, 1, { location_id: Number.MAX_SAFE_INTEGER + 1 })],
    [row(1, 34, 1, { location_type: 'secret_location' })], [row(1, 34, 1, { is_singleton: null })], [row(1, 34, 1, { is_blueprint_copy: null })],
    [row(1, 34, 1, { location_flag: '' })], [row(1, 34, 1, { location_flag: 'x'.repeat(81) })], [row(1, 34, 1, { location_flag: 'bad\nflag' })],
    [row(1), row(2, 35, 1, { location_type: 'item' })],
  ];
  for (const data of invalidRows) { const result = await harness({ result: { data } }).read('synthetic-owner', args); assert.equal(result.status, 'error'); assert.equal(result.summary, null); assert.equal(result.types.length, 0); assert.equal(result.locations.length, 0); }
  const max = await harness({ result: { data: [row(1, 34, Number.MAX_SAFE_INTEGER), row(2, 35, Number.MAX_SAFE_INTEGER)] } }).read('synthetic-owner', args);
  assert.equal(max.status, 'ready'); assert(max.types.every(type => type.quantity === Number.MAX_SAFE_INTEGER));
});

test('freshness respects cache age, no-store, strict calendar dates and final completion time', async () => {
  for (const [data, state] of [
    [{ cacheAge: '7200' }, 'stale'], [{ cacheAge: '-1' }, 'unknown'], [{ cacheControl: 'no-store' }, 'stale'], [{ cacheControl: 'no-cache' }, 'stale'],
    [{ cacheExpires: null, cacheControl: '', responseDate: null }, 'unknown'], [{ cacheExpires: '2026-02-30T00:00:00Z', cacheControl: '', responseDate: null }, 'unknown'],
    [{ cacheExpires: null, cacheAge: '0', cacheControl: 'max-age=600' }, 'fresh'],
  ]) { const result = await harness({ result: data }).read('synthetic-owner', args); assert.equal(result.freshness.state, state); if (state !== 'fresh') assert.equal(result.status, 'partial'); }
  const late = await harness({ now: now + 7200000 }).read('synthetic-owner', args); assert.equal(late.status, 'partial'); assert.equal(late.freshness.state, 'stale');
  for (const retrievedAt of ['2026-02-30T00:00:00Z', new Date(now + 61000).toISOString(), null]) assert.equal((await harness({ result: { retrievedAt } }).read('synthetic-owner', args)).status, 'error');
});

test('upstream errors are redacted and cannot fabricate an empty successful inventory', async () => {
  for (const status of [401, 403, 404, 409, 429, 500]) {
    const h = harness({ assets: async (_user, _args, _signal, EveError) => { throw new EveError('OMIT_PRIVATE_UPSTREAM', status); } });
    const result = await h.read('synthetic-owner', args); assert.equal(result.summary, null); assert.equal(result.coverage.kind, 'unavailable'); assert(!JSON.stringify(result).includes('OMIT_PRIVATE')); assert(!['ready', 'partial'].includes(result.status)); assert.equal(h.calls.length, 2);
  }
});

test('cancellation and deadline release even uncooperative connection and asset readers', async () => {
  const cancelled = new AbortController(); cancelled.abort(); const none = harness(); await assert.rejects(none.read('synthetic-owner', args, { signal: cancelled.signal })); assert.equal(none.calls.length, 0);
  for (const during of ['connections', 'assets']) {
    const h = harness({ [during]: async (...input) => { input.at(-1).abort(); return new Promise(() => {}); } });
    const result = await h.read('synthetic-owner', args); assert.equal(result.status, 'unavailable'); assert.equal(result.summary, null);
    assert.match(result.message, /cancelled or reached its time limit/);
  }
  const controller = new AbortController(), h = harness({ assets: async () => { controller.abort(); return new Promise(() => {}); } });
  assert.equal((await h.read('synthetic-owner', args, { signal: controller.signal })).status, 'unavailable');
});

test('successive requests never retain or combine prior pages', async () => {
  let count = 0;
  const h = harness({ assets: async (_user, input) => response(input, { data: count++ ? [row(2, 35, 4)] : [row(1, 34, 2)] }) });
  const first = await h.read('synthetic-owner', args), second = await h.read('synthetic-owner', args);
  assert.equal(first.types[0].typeId, 34); assert.equal(second.types.length, 1); assert.equal(second.types[0].typeId, 35); assert.equal(second.types[0].quantity, 4);
});
