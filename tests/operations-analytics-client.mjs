import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { z } from 'zod';

const compile = name => ts.transpileModule(readFileSync(`app/lib/${name}.ts`, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const code = compile('operations-analytics-client'), connectionCode = compile('connection-client');
function harness(fetch = () => { throw Error('Unexpected request'); }, timers = {}) {
  const connection = { exports: {} }, client = { exports: {} };
  vm.runInNewContext(connectionCode, { module: connection, exports: connection.exports });
  vm.runInNewContext(code, { module: client, exports: client.exports, fetch, AbortController, setTimeout, clearTimeout, ...timers, require: name => name === 'zod' ? { z } : connection.exports });
  return client.exports;
}
const client = harness(), characterId = 90000001, selected = { characterId, entity: 'character' }, stamp = '2026-01-01T00:00:00.000Z', expires = '2026-01-01T01:00:00.000Z';
const plain = value => JSON.parse(JSON.stringify(value));
const fresh = () => ({ state: 'fresh', retrievedAt: stamp, cacheExpires: expires, lastModified: null });
const blankFreshness = () => ({ state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null });
function inventoryFixture() {
  return { ...selected, corporationId: null, generatedAt: stamp, status: 'ready', message: 'Synthetic inventory projection.', scope: 'esi-assets.read_assets.v1',
    coverage: { kind: 'complete_returned_list', page: 1, pages: 1, nextPage: null, previousPage: null, pageLimitReached: false, records: 3 }, freshness: fresh(),
    summary: { records: 3, types: 2, locations: 2, singletonRecords: 1, blueprintCopyRecords: 1, blueprintCopyUnknownRecords: 1, unmappedTypeRecords: 0 },
    categories: [{ categoryId: 4, name: 'Synthetic material category', records: 3, typeCount: 2 }],
    groups: [{ groupId: 18, name: 'Synthetic material group', categoryId: 4, categoryName: 'Synthetic material category', records: 3, typeCount: 2 }],
    types: [{ typeId: 34, name: 'Synthetic material A', groupId: 18, groupName: 'Synthetic material group', categoryId: 4, categoryName: 'Synthetic material category', records: 2, quantity: 250, singletonRecords: 1, blueprintCopyRecords: 1, blueprintCopyUnknownRecords: 0 }, { typeId: 35, name: 'Synthetic material B', groupId: 18, groupName: 'Synthetic material group', categoryId: 4, categoryName: 'Synthetic material category', records: 1, quantity: 7, singletonRecords: 0, blueprintCopyRecords: 0, blueprintCopyUnknownRecords: 1 }],
    locations: [{ locationId: 60000001, kind: 'station', records: 2, typeCount: 1 }, { locationId: 70000001, kind: 'item', records: 1, typeCount: 1 }], limitations: ['One synthetic page.'] };
}
const statuses = ['active', 'cancelled', 'delivered', 'paused', 'ready', 'reverted'];
function industryFixture() {
  return { ...selected, corporationId: null, includeCompleted: false, generatedAt: stamp, status: 'ready', message: 'Synthetic jobs projection.', scope: 'esi-industry.read_character_jobs.v1',
    coverage: { kind: 'complete_returned_response', page: null, pages: null, nextPage: null, previousPage: null, pageLimitReached: false, rows: 1 }, freshness: fresh(),
    summary: { jobs: 1, active: 1, ready: 0, paused: 0, activePastEnd: 0, activeDueWithin24h: 1, unknownBlueprintNames: 0, unknownProductNames: 0 },
    statusCounts: statuses.map(status => ({ status, count: status === 'active' ? 1 : 0 })), activityCounts: [{ activityId: 1, label: 'Manufacturing', count: 1 }],
    jobs: [{ jobId: 100001, activityId: 1, activityLabel: 'Manufacturing', status: 'active', blueprintTypeId: 1001, blueprintName: 'Synthetic blueprint', productTypeId: 1002, productName: 'Synthetic product', runs: 2, startAt: '2025-12-31T23:00:00.000Z', endAt: '2026-01-01T12:00:00.000Z', durationSeconds: 46800, pauseAt: null, completedAt: null }], limitations: ['One synthetic response.'] };
}
function unavailableInventory() { const value = inventoryFixture(); Object.assign(value, { status: 'needs_permission', summary: null, types: [], categories: [], groups: [], locations: [], freshness: blankFreshness() }); Object.assign(value.coverage, { kind: 'unavailable', pages: null, records: 0 }); return value; }
function unavailableIndustry() { const value = industryFixture(); Object.assign(value, { status: 'needs_permission', summary: null, jobs: [], statusCounts: [], activityCounts: [], freshness: blankFreshness() }); Object.assign(value.coverage, { kind: 'unavailable', rows: 0 }); return value; }

test('operations clients accept projected records without adding cross-type quantity or inferred job state', () => {
  assert.deepEqual(plain(client.inventoryAnalyticsResponse(inventoryFixture(), selected)), inventoryFixture());
  assert.deepEqual(plain(client.industryAnalyticsResponse(industryFixture(), selected)), industryFixture());
  assert.equal(client.inventoryAnalyticsResponse(unavailableInventory(), selected).summary, null);
  assert.equal(client.industryAnalyticsResponse(unavailableIndustry(), selected).summary, null);
});
for (const [name, mutate] of [
  ['wrong character', v => v.characterId++], ['wrong entity', v => v.entity = 'corporation'], ['private root field', v => v.apiSettings = 'OMIT_PRIVATE'],
  ['private type field', v => v.types[0].itemNames = ['OMIT_PRIVATE']], ['total mixed quantity', v => v.summary.quantity = 257], ['wrong scope', v => v.scope = 'esi-wallet.read_character_wallet.v1'],
  ['wrong page', v => v.coverage.page = 2], ['invented next page', v => v.coverage.nextPage = 2], ['wrong previous page', v => v.coverage.previousPage = 1], ['page limit inconsistency', v => v.coverage.pageLimitReached = true],
  ['wrong row count', v => v.coverage.records++], ['wrong type count', v => v.summary.types++], ['wrong location count', v => v.summary.locations++], ['duplicate type', v => v.types[1].typeId = v.types[0].typeId],
  ['duplicate group', v => v.groups.push({ ...v.groups[0] })], ['duplicate category', v => v.categories.push({ ...v.categories[0] })], ['duplicate location', v => v.locations[1].locationId = v.locations[0].locationId],
  ['category membership', v => v.types[0].categoryId = 99], ['group membership', v => v.types[0].groupId = 99], ['group category label', v => v.groups[0].categoryName = 'Mismatch'],
  ['wrong singleton count', v => v.summary.singletonRecords = 0], ['wrong copy count', v => v.summary.blueprintCopyRecords = 0], ['wrong unknown copies', v => v.summary.blueprintCopyUnknownRecords = 0],
  ['copy overlap exceeds records', v => { v.types[0].blueprintCopyUnknownRecords = 2; v.summary.blueprintCopyUnknownRecords = 3; }], ['singleton exceeds records', v => { v.types[0].singletonRecords = 3; v.summary.singletonRecords = 3; }],
  ['negative quantity', v => v.types[0].quantity = -1], ['unsafe quantity', v => v.types[0].quantity = Number.MAX_SAFE_INTEGER + 1], ['unsafe location', v => v.locations[0].locationId = Number.MAX_SAFE_INTEGER + 1],
  ['location quantity masquerading as records', v => v.locations[0].records = 250], ['impossible location type count', v => v.locations[1].typeCount = 2], ['unknown location kind', v => v.locations[0].kind = 'container'],
  ['invented unmapped count', v => v.summary.unmappedTypeRecords = 1], ['partial missing classification', v => v.types[0].groupId = null], ['control character label', v => v.categories[0].name = 'Synthetic\u202e'],
  ['invalid date rollover', v => v.generatedAt = '2026-02-30T00:00:00Z'], ['noncanonical UTC timestamp', v => v.generatedAt = '2025-12-31T19:00:00-05:00'], ['future received timestamp', v => v.freshness.retrievedAt = '2026-01-02T00:00:00.000Z'], ['expired fresh state', v => v.freshness.cacheExpires = stamp],
  ['ready on partial page', v => { v.coverage.pages = 2; v.coverage.nextPage = 2; v.coverage.kind = 'partial'; }], ['error with charts', v => v.status = 'error'], ['unavailable with zero metrics', v => { Object.assign(v, unavailableInventory()); v.summary = inventoryFixture().summary; }],
]) test(`inventory client rejects ${name}`, () => { const value = inventoryFixture(); mutate(value); assert.throws(() => client.inventoryAnalyticsResponse(value, selected), /incomplete response/); });

test('inventory allows unknown classification, safe quantity and missing copy flags without misleading zeros', () => {
  const value = inventoryFixture(); value.status = 'partial'; value.summary.unmappedTypeRecords = 1;
  Object.assign(value.types[1], { name: 'Type 35', groupId: null, groupName: 'Unmapped group', categoryId: null, categoryName: 'Unmapped category', quantity: Number.MAX_SAFE_INTEGER });
  Object.assign(value.groups[0], { records: 2, typeCount: 1 }); Object.assign(value.categories[0], { records: 2, typeCount: 1 });
  value.groups.push({ groupId: null, name: 'Unmapped group', categoryId: null, categoryName: 'Unmapped category', records: 1, typeCount: 1 }); value.categories.push({ categoryId: null, name: 'Unmapped category', records: 1, typeCount: 1 });
  assert.equal(client.inventoryAnalyticsResponse(value, selected).types[1].quantity, Number.MAX_SAFE_INTEGER);
});

for (const [name, mutate] of [
  ['wrong character', v => v.characterId++], ['unexpected corporation', v => v.corporationId = 90000002], ['wrong completion selection', v => v.includeCompleted = true],
  ['personal pagination', v => v.coverage.page = 1], ['personal total pages', v => v.coverage.pages = 1], ['private installer', v => v.jobs[0].installerId = 90000003], ['private source URL', v => v.source = 'https://example.invalid/private'],
  ['ready with absent summary', v => v.summary = null], ['wrong summary jobs', v => v.summary.jobs++], ['wrong rows', v => v.coverage.rows++], ['duplicate job', v => v.jobs.push({ ...v.jobs[0] })],
  ['wrong status count', v => v.statusCounts[0].count = 0], ['duplicate status', v => v.statusCounts[1].status = 'active'], ['missing status', v => v.statusCounts.pop()], ['activity mismatch', v => v.activityCounts[0].activityId = 8],
  ['activity count', v => v.activityCounts[0].count = 0], ['activity label', v => v.activityCounts[0].label = 'Invention'], ['unknown activity mislabel', v => { v.jobs[0].activityId = 77; v.activityCounts[0].activityId = 77; }],
  ['active count', v => v.summary.active = 0], ['ready count', v => v.summary.ready = 1], ['paused count', v => v.summary.paused = 1], ['past end inferred', v => v.summary.activePastEnd = 1], ['due window', v => v.summary.activeDueWithin24h = 0],
  ['reversed dates', v => v.jobs[0].startAt = '2026-01-02T00:00:00.000Z'], ['rollover date', v => v.jobs[0].endAt = '2026-02-30T00:00:00Z'], ['ambiguous timestamp', v => v.jobs[0].startAt = '2025-12-31'], ['offset date would change UTC chart keys', v => v.jobs[0].endAt = '2026-01-01T07:00:00-05:00'],
  ['missing product ID with name', v => v.jobs[0].productTypeId = null], ['missing name with product ID', v => v.jobs[0].productName = null], ['unknown name count contradicts label', v => v.summary.unknownBlueprintNames = 1],
  ['expired fresh response', v => v.freshness.cacheExpires = stamp], ['future retrieval', v => v.freshness.retrievedAt = '2026-01-02T00:00:00.000Z'], ['failed with chart values', v => v.status = 'error'],
]) test(`industry client rejects ${name}`, () => { const value = industryFixture(); mutate(value); assert.throws(() => client.industryAnalyticsResponse(value, selected), /incomplete response/); });

test('industry retains unknown activity, absent product and paused state without current-completion inference', () => {
  const value = industryFixture(); Object.assign(value.jobs[0], { activityId: 77, activityLabel: 'Activity 77', status: 'paused', productTypeId: null, productName: null, endAt: stamp });
  Object.assign(value.summary, { active: 0, paused: 1, activeDueWithin24h: 0 }); value.statusCounts = statuses.map(status => ({ status, count: status === 'paused' ? 1 : 0 })); value.activityCounts = [{ activityId: 77, label: 'Activity 77', count: 1 }];
  assert.equal(client.industryAnalyticsResponse(value, selected).summary.activePastEnd, 0);
});

test('corporation selection and last-page application limits are enforced for both dashboards', () => {
  for (const [method, fixture, scope] of [['inventoryAnalyticsResponse', inventoryFixture, 'esi-assets.read_corporation_assets.v1'], ['industryAnalyticsResponse', industryFixture, 'esi-industry.read_corporation_jobs.v1']]) {
    const value = fixture(); Object.assign(value, { entity: 'corporation', corporationId: 98000001, status: 'partial', scope }); Object.assign(value.coverage, { page: 500, pages: 501, previousPage: 499, nextPage: null, pageLimitReached: true, kind: 'partial' });
    const args = { ...selected, entity: 'corporation', page: 500 }; assert.equal(client[method](value, args).coverage.pageLimitReached, true);
    value.coverage.nextPage = 501; assert.throws(() => client[method](value, args), /incomplete response/);
  }
});

test('unknown page counts and stale source metadata keep chart coverage partial', () => {
  const inventory = inventoryFixture(); inventory.status = 'partial'; Object.assign(inventory.coverage, { pages: null, kind: 'unknown' }); inventory.freshness = { ...inventory.freshness, state: 'stale', cacheExpires: stamp };
  assert.equal(client.inventoryAnalyticsResponse(inventory, selected).freshness.state, 'stale');
  const industry = industryFixture(); industry.status = 'partial'; industry.freshness = { ...industry.freshness, state: 'unknown', cacheExpires: null };
  assert.equal(client.industryAnalyticsResponse(industry, selected).freshness.state, 'unknown');
});

test('successful empty responses differ from missing permissions and preserve genuine zero counts', () => {
  const inventory = inventoryFixture(); inventory.coverage.records = 0; for (const key of Object.keys(inventory.summary)) inventory.summary[key] = 0; inventory.types = []; inventory.groups = []; inventory.categories = []; inventory.locations = [];
  assert.equal(client.inventoryAnalyticsResponse(inventory, selected).summary.records, 0);
  const industry = industryFixture(); industry.coverage.rows = 0; for (const key of Object.keys(industry.summary)) industry.summary[key] = 0; industry.jobs = []; industry.activityCounts = []; industry.statusCounts.forEach(row => row.count = 0);
  assert.equal(client.industryAnalyticsResponse(industry, selected).summary.jobs, 0);
});

for (const [operation, fixture] of [['inventory', inventoryFixture], ['industry', industryFixture]]) {
  test(`${operation} requests are explicit same-origin private POSTs with cancellation`, async () => {
    let called = 0; const h = harness(async (url, options) => { called++; assert.equal(url, `/api/eve/${operation}-analytics`); assert.equal(options.method, 'POST'); assert.equal(options.cache, 'no-store'); assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error'); assert.equal(options.headers['Content-Type'], 'application/json'); assert.deepEqual(JSON.parse(options.body), selected); assert(options.signal); return { ok: true, headers: { get: () => 'application/json' }, json: async () => fixture() }; });
    assert.equal((await h[`${operation}AnalyticsRequest`](selected)).characterId, characterId); assert.equal(called, 1);
  });
  test(`${operation} rejects invalid selections before fetching and protects private errors`, async () => {
    for (const args of [{ ...selected, characterId: 0 }, { ...selected, entity: 'all' }, { ...selected, page: 501 }, { ...selected, credential: 'OMIT_PRIVATE' }, ...(operation === 'industry' ? [{ ...selected, page: 1 }, { ...selected, includeCompleted: 'false' }] : [])]) await assert.rejects(harness()[`${operation}AnalyticsRequest`](args), /Choose one connected character/);
    for (const status of [401, 404, 500]) await assert.rejects(harness(async () => ({ ok: false, status }))[`${operation}AnalyticsRequest`](selected), error => error.status === status && !error.message.includes('OMIT_PRIVATE'));
    await assert.rejects(harness(async () => { throw Error('OMIT_PRIVATE_HOST'); })[`${operation}AnalyticsRequest`](selected), /could not be reached/);
    await assert.rejects(harness(async () => ({ ok: true, headers: { get: () => 'text/html' } }))[`${operation}AnalyticsRequest`](selected), /incomplete response/);
  });
  test(`${operation} never fetches after pre-abort and rejects late cancelled response data`, async () => {
    const before = new AbortController(); before.abort(); await assert.rejects(harness()[`${operation}AnalyticsRequest`](selected, before.signal), /cancelled or timed out/);
    const during = new AbortController(); const h = harness(async () => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => { during.abort(); return fixture(); } }));
    await assert.rejects(h[`${operation}AnalyticsRequest`](selected, during.signal), /cancelled or timed out/);
  });
}
test('operations timeout aborts a pending transport and releases its timer', async () => {
  let timeout, cleared = false;
  const h = harness(async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('abort')), { once: true })), { setTimeout: (fn, milliseconds) => { assert.equal(milliseconds, 60000); timeout = fn; return 7; }, clearTimeout: timer => { assert.equal(timer, 7); cleared = true; } });
  const pending = h.inventoryAnalyticsRequest(selected); timeout(); await assert.rejects(pending, /cancelled or timed out/); assert(cleared);
});

function service(name) {
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const overview = { exports: {} }, module = { exports: {} };
  vm.runInNewContext(compile('overview-summary'), { module: overview, exports: overview.exports });
  const catalog = { findPublishedManufacturingItem: typeId => {
    if (![34, 35, 1001, 1002].includes(typeId)) return null;
    return { typeId, name: `Synthetic public type ${typeId}`, groupId: 18, groupName: 'Synthetic public group', categoryId: 4, categoryName: 'Synthetic public category' };
  } };
  vm.runInNewContext(compile(name), { module, exports: module.exports, Date, AbortSignal, setTimeout, clearTimeout, require: name => {
    if (name === './overview-summary') return overview.exports;
    if (name === './manufacturing-catalog') return catalog;
    if (name === './eve') return { EveError, listConnections: async () => [], readEve: async () => { throw Error('Unexpected default read'); }, readCharacterData: async () => { throw Error('Unexpected default read'); }, readCorporationData: async () => { throw Error('Unexpected default read'); } };
    throw Error(`Unexpected service import: ${name}`);
  } });
  return { ...module.exports, EveError };
}

test('inventory client accepts actual service projections across page, unknown, missing, empty and failure cases', async () => {
  const backend = service('inventory-analytics');
  for (const mode of ['ready', 'corporation', 'offsetDates', 'unknownType', 'unknownPages', 'lastPage', 'stale', 'zero', 'missing', 'malformed', 'error']) {
    const corporation = ['corporation', 'lastPage'].includes(mode), page = mode === 'lastPage' ? 500 : 1;
    const args = { ...selected, entity: corporation ? 'corporation' : 'character', page };
    const reader = backend.createInventoryAnalyticsReader({ now: () => Date.parse(stamp), connections: async () => [{ characterId, scopes: mode === 'missing' ? [] : ['esi-assets.read_assets.v1', 'esi-assets.read_corporation_assets.v1'] }], assets: async (_user, request) => {
      if (mode === 'error') throw Error('OMIT_PRIVATE_UPSTREAM');
      const pages = mode === 'unknownPages' ? null : mode === 'lastPage' ? 501 : 1;
      return { ...request, corporationId: corporation ? 98000001 : undefined, retrievedAt: mode === 'offsetDates' ? '2025-12-31T19:00:00-05:00' : stamp, cacheExpires: mode === 'stale' ? stamp : expires, pages, nextPage: null,
        data: mode === 'zero' ? [] : [{ item_id: 70000001, type_id: mode === 'unknownType' ? 9999999 : 34, location_id: 60000001, location_type: 'station', location_flag: 'Hangar', quantity: mode === 'malformed' ? -1 : 12, is_singleton: false }] };
    } });
    const result = await reader('synthetic-user', args); assert.deepEqual(plain(client.inventoryAnalyticsResponse(result, args)), plain(result), mode);
    assert(!JSON.stringify(result).includes('OMIT_PRIVATE'), mode);
  }
});

test('industry client accepts actual service projections without inventing missing products or paused progress', async () => {
  const backend = service('industry-analytics');
  for (const mode of ['ready', 'corporation', 'offsetDates', 'unknownName', 'unknownActivity', 'unknownPages', 'lastPage', 'stale', 'paused', 'pastActive', 'zero', 'missing', 'malformed', 'error']) {
    const corporation = ['corporation', 'unknownPages', 'lastPage'].includes(mode), page = mode === 'lastPage' ? 500 : 1;
    const args = { ...selected, entity: corporation ? 'corporation' : 'character', includeCompleted: true, ...(corporation ? { page } : {}) };
    const response = async (_user, request) => {
      if (mode === 'error') throw Error('OMIT_PRIVATE_UPSTREAM');
      const pages = mode === 'unknownPages' ? null : mode === 'lastPage' ? 501 : 1;
      return { characterId, dataset: 'industry_jobs', ...(corporation ? { entity: 'corporation', corporationId: 98000001 } : {}), retrievedAt: stamp, cacheExpires: mode === 'stale' ? stamp : expires,
        pagination: corporation ? { kind: 'page', page: request.parameters.page, pages, nextPage: null } : { kind: 'none' },
        data: mode === 'zero' ? [] : [{ job_id: 70000001, activity_id: mode === 'unknownActivity' ? 77 : 1, blueprint_type_id: mode === 'unknownName' ? 9999999 : 1001, product_type_id: mode === 'paused' ? undefined : 1002, status: mode === 'paused' ? 'paused' : 'active', runs: 2, duration: 3600,
          start_date: mode === 'malformed' ? 'invalid' : '2025-12-31T23:00:00.000Z', end_date: mode === 'pastActive' ? stamp : mode === 'offsetDates' ? '2026-01-01T07:00:00-05:00' : '2026-01-01T12:00:00.000Z' }] };
    };
    const reader = backend.createIndustryAnalyticsReader({ now: () => Date.parse(stamp), connections: async () => [{ characterId, scopes: mode === 'missing' ? [] : ['esi-industry.read_character_jobs.v1', 'esi-industry.read_corporation_jobs.v1'] }], character: response, corporation: response });
    const result = await reader('synthetic-user', args); assert.deepEqual(plain(client.industryAnalyticsResponse(result, args)), plain(result), mode);
    assert(!JSON.stringify(result).includes('OMIT_PRIVATE'), mode);
  }
});
