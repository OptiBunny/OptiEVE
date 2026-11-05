import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { z } from 'zod';

const compile = name => ts.transpileModule(readFileSync(`app/lib/${name}.ts`, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const code = compile('blueprint-analytics-client'), connectionCode = compile('connection-client');
function harness(fetch = () => { throw Error('Unexpected request'); }, timers = {}) {
  const connection = { exports: {} }, module = { exports: {} };
  vm.runInNewContext(connectionCode, { module: connection, exports: connection.exports });
  vm.runInNewContext(code, { module, exports: module.exports, fetch, AbortController, Date, setTimeout, clearTimeout, ...timers, require: name => name === 'zod' ? { z } : connection.exports });
  return module.exports;
}
const client = harness(), characterId = 90000001, selected = { characterId, entity: 'character' }, stamp = '2026-01-01T00:00:00.000Z';
const plain = value => JSON.parse(JSON.stringify(value));
function fixture() {
  return { ...selected, corporationId: null, generatedAt: stamp, status: 'ready', message: 'Synthetic blueprint page.', scope: 'esi-characters.read_blueprints.v1',
    coverage: { kind: 'complete_returned_response', page: 1, pages: 1, nextPage: null, previousPage: null, pageLimitReached: false, rows: 3 },
    freshness: { state: 'fresh', retrievedAt: stamp, cacheExpires: '2026-01-01T01:00:00.000Z', lastModified: null },
    summary: { records: 3, types: 2, originalRecords: 1, copyRecords: 1, originalStackRecords: 1, unknownTypeRecords: 0 },
    kindCounts: [{ kind: 'original', count: 1 }, { kind: 'copy', count: 1 }, { kind: 'original_stack', count: 1 }],
    materialEfficiencyCounts: [{ level: 0, count: 1 }, { level: 10, count: 2 }], timeEfficiencyCounts: [{ level: 0, count: 1 }, { level: 20, count: 2 }],
    typeCounts: [{ typeId: 10001, name: 'Synthetic blueprint A', records: 2 }, { typeId: 10002, name: 'Synthetic blueprint B', records: 1 }],
    blueprints: [{ row: 1, typeId: 10001, name: 'Synthetic blueprint A', catalogMapped: true, kind: 'original', units: 1, materialEfficiency: 10, timeEfficiency: 20, copyRuns: null },
      { row: 2, typeId: 10001, name: 'Synthetic blueprint A', catalogMapped: true, kind: 'copy', units: 1, materialEfficiency: 10, timeEfficiency: 20, copyRuns: 0 },
      { row: 3, typeId: 10002, name: 'Synthetic blueprint B', catalogMapped: true, kind: 'original_stack', units: 10000, materialEfficiency: 0, timeEfficiency: 0, copyRuns: null }], limitations: ['Synthetic fixture; no live account data.'] };
}
function blank(status = 'unavailable') {
  const value = fixture(); Object.assign(value, { status, summary: null, blueprints: [], typeCounts: [], kindCounts: [], materialEfficiencyCounts: [], timeEfficiencyCounts: [] });
  Object.assign(value.coverage, { kind: 'unavailable', pages: null, rows: 0 }); value.freshness = { state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null }; return value;
}
test('strict client accepts valid original, copy-zero and original-stack projections', () => {
  const result = client.blueprintAnalyticsResponse(fixture(), selected);
  assert.equal(result.summary.records, 3); assert.equal(result.blueprints[1].copyRuns, 0); assert.equal(result.blueprints[2].units, 10000); assert.equal(result.blueprints[0].copyRuns, null);
});
test('client accepts genuinely empty charts and separate unavailable states', () => {
  const value = fixture(); Object.assign(value.summary, { records: 0, types: 0, originalRecords: 0, copyRecords: 0, originalStackRecords: 0, unknownTypeRecords: 0 });
  value.coverage.rows = 0; value.blueprints = []; value.typeCounts = []; value.materialEfficiencyCounts = []; value.timeEfficiencyCounts = []; value.kindCounts.forEach(row => row.count = 0);
  assert.equal(client.blueprintAnalyticsResponse(value, selected).summary.records, 0);
  for (const status of ['needs_permission', 'unavailable', 'error']) assert.equal(client.blueprintAnalyticsResponse(blank(status), selected).summary, null);
});
test('corporation page bindings, unknown totals and last application page stay explicit', () => {
  for (const [page, pages, reached] of [[2, 4, false], [500, 501, true], [500, null, true]]) {
    const value = fixture(); Object.assign(value, { entity: 'corporation', corporationId: 98000001, status: 'partial', scope: 'esi-corporations.read_blueprints.v1' });
    Object.assign(value.coverage, { page, pages, nextPage: page < 500 && pages !== null ? page + 1 : null, previousPage: page - 1, pageLimitReached: reached, kind: pages === null ? 'unknown' : 'partial' });
    assert.equal(client.blueprintAnalyticsResponse(value, { ...selected, entity: 'corporation', page }).coverage.pageLimitReached, reached);
  }
});
test('unmapped public types and stale snapshots remain partial', () => {
  const value = fixture(); value.status = 'partial'; value.blueprints[2].catalogMapped = false; value.blueprints[2].name = 'Type 10002'; value.typeCounts[1].name = 'Type 10002'; value.summary.unknownTypeRecords = 1;
  assert.equal(client.blueprintAnalyticsResponse(value, selected).summary.unknownTypeRecords, 1);
  const stale = fixture(); stale.status = 'partial'; stale.freshness.cacheExpires = stamp; stale.freshness.state = 'stale'; assert.equal(client.blueprintAnalyticsResponse(stale, selected).freshness.state, 'stale');
});

const badMutations = [
  ['wrong character', value => value.characterId++], ['wrong owner', value => value.entity = 'corporation'], ['personal corporation ID', value => value.corporationId = 98000001],
  ['wrong scope', value => value.scope = 'esi-assets.read_assets.v1'], ['extra top-level private field', value => value.privateSecret = 'DO_NOT_RENDER'],
  ['missing summary', value => value.summary = null], ['records disagree', value => value.summary.records++], ['types disagree', value => value.summary.types++],
  ['original count disagree', value => value.summary.originalRecords++], ['copy count disagree', value => value.summary.copyRecords++], ['stack count disagree', value => value.summary.originalStackRecords++],
  ['unknown count disagree', value => value.summary.unknownTypeRecords++], ['unknown name mismatch', value => { value.blueprints[2].catalogMapped = false; value.summary.unknownTypeRecords = 1; value.status = 'partial'; }],
  ['inconsistent type labels', value => value.blueprints[1].name = 'Other name'], ['inconsistent type mappings', value => value.blueprints[1].catalogMapped = false],
  ['duplicate kind', value => value.kindCounts[1].kind = 'original'], ['missing kind', value => value.kindCounts.pop()], ['wrong kind count', value => value.kindCounts[0].count++],
  ['wrong ME count', value => value.materialEfficiencyCounts[0].count++], ['duplicate ME level', value => value.materialEfficiencyCounts[0].level = 10],
  ['wrong TE count', value => value.timeEfficiencyCounts[0].count++], ['missing TE level', value => value.timeEfficiencyCounts.pop()],
  ['unsorted efficiency', value => value.timeEfficiencyCounts.reverse()], ['extra efficiency bucket', value => value.materialEfficiencyCounts.push({ level: 99, count: 0 })],
  ['duplicate type count', value => value.typeCounts[1].typeId = 10001], ['type count mismatch', value => value.typeCounts[0].records++],
  ['type label mismatch', value => value.typeCounts[0].name = 'Wrong label'], ['duplicate row key', value => value.blueprints[1].row = 1], ['raw item ID row key', value => value.blueprints[0].row = 70000001],
  ['raw private row field', value => value.blueprints[0].item_id = 70000001], ['copy without finite runs', value => value.blueprints[1].copyRuns = null],
  ['original with finite runs', value => value.blueprints[0].copyRuns = 0], ['negative copy runs', value => value.blueprints[1].copyRuns = -1], ['copy multiple units', value => value.blueprints[1].units = 2],
  ['zero stack units', value => value.blueprints[2].units = 0], ['unsafe units', value => value.blueprints[2].units = Number.MAX_SAFE_INTEGER + 1],
  ['negative ME', value => value.blueprints[0].materialEfficiency = -1], ['non-integer TE', value => value.blueprints[0].timeEfficiency = 2.5],
  ['unsafe public name', value => value.blueprints[0].name = 'bad\u202ename'], ['wrong response page', value => value.coverage.page = 2],
  ['unknown coverage claimed complete', value => value.coverage.pages = null], ['missing next page', value => { value.coverage.pages = 2; value.coverage.kind = 'partial'; value.status = 'partial'; }],
  ['inconsistent previous page', value => value.coverage.previousPage = 1], ['spurious page limit', value => value.coverage.pageLimitReached = true],
  ['row coverage mismatch', value => value.coverage.rows++], ['freshness mismatch', value => value.freshness.state = 'stale'],
  ['unknown cache claim', value => value.freshness.cacheExpires = null], ['future retrieval', value => value.freshness.retrievedAt = '2026-01-01T00:01:01.000Z'],
  ['noncanonical generated date', value => value.generatedAt = '2026-01-01T00:00:00Z'], ['offset generated date', value => value.generatedAt = '2026-01-01T01:00:00+01:00'],
  ['invalid date rollover', value => value.generatedAt = '2026-02-30T00:00:00.000Z'], ['ready marked unavailable', value => value.status = 'unavailable'],
  ['overstated ready', value => { value.status = 'ready'; value.freshness.state = 'unknown'; value.freshness.cacheExpires = null; }],
];
for (const [label, mutate] of badMutations) test(`client rejects ${label}`, () => { const value = fixture(); mutate(value); assert.throws(() => client.blueprintAnalyticsResponse(value, selected)); });
test('unavailable shapes cannot carry holdings, freshness or source identifiers', () => {
  for (const mutate of [value => value.blueprints.push(fixture().blueprints[0]), value => value.corporationId = 98000001, value => value.coverage.rows = 1, value => value.coverage.pages = 1, value => value.freshness.lastModified = stamp, value => value.summary = fixture().summary, value => value.kindCounts = fixture().kindCounts]) {
    const value = blank(); mutate(value); assert.throws(() => client.blueprintAnalyticsResponse(value, selected));
  }
});
test('client validates selection before performing any request', async () => {
  let calls = 0; const h = harness(() => { calls++; });
  for (const input of [null, {}, { ...selected, characterId: 0 }, { ...selected, entity: 'all' }, { ...selected, page: 0 }, { ...selected, page: 501 }, { ...selected, corporationId: 98000001 }]) await assert.rejects(h.blueprintAnalyticsRequest(input));
  assert.equal(calls, 0);
});
test('request uses protected same-origin POST with no storage, redirects or persistence', async () => {
  const calls = [], h = harness(async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(fixture()), { headers: { 'content-type': 'application/json' } }); });
  const result = await h.blueprintAnalyticsRequest(selected);
  assert.equal(result.summary.records, 3); assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/eve/blueprint-analytics');
  assert.equal(calls[0].options.method, 'POST'); assert.equal(calls[0].options.credentials, 'same-origin'); assert.equal(calls[0].options.cache, 'no-store'); assert.equal(calls[0].options.redirect, 'error'); assert.deepEqual(JSON.parse(calls[0].options.body), selected);
});
test('HTTP errors preserve only safe status guidance without raw response contents', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const h = harness(async () => new Response('PRIVATE_FAILURE_TEXT', { status }));
    await assert.rejects(h.blueprintAnalyticsRequest(selected), error => error.status === status && !error.message.includes('PRIVATE_FAILURE_TEXT'));
  }
});
test('non-JSON, broken JSON and invalid projections are rejected safely', async () => {
  for (const response of [new Response('PRIVATE_HTML', { headers: { 'content-type': 'text/html' } }), new Response('PRIVATE_BAD_JSON', { headers: { 'content-type': 'application/json' } }), new Response('{}', { headers: { 'content-type': 'application/json' } })]) {
    await assert.rejects(harness(async () => response).blueprintAnalyticsRequest(selected), error => !error.message.includes('PRIVATE'));
  }
});
test('abort before load, during fetch and after response body never returns holdings', async () => {
  const cancelled = new AbortController(); cancelled.abort(); let calls = 0;
  await assert.rejects(harness(async () => { calls++; }).blueprintAnalyticsRequest(selected, cancelled.signal)); assert.equal(calls, 0);
  const during = new AbortController(), h = harness(async (_url, options) => new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(Error('aborted'))); queueMicrotask(() => during.abort()); }));
  await assert.rejects(h.blueprintAnalyticsRequest(selected, during.signal), /cancelled/);
  const late = new AbortController(), final = harness(async () => ({ ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: async () => { late.abort(); return fixture(); } }));
  await assert.rejects(final.blueprintAnalyticsRequest(selected, late.signal), /cancelled/);
});
test('client sets and clears the bounded 60-second timeout', async () => {
  let callback, cleared = 0;
  const h = harness(async (_url, options) => new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(Error('aborted'))); queueMicrotask(callback); }), { setTimeout: (fn, ms) => { assert.equal(ms, 60000); callback = fn; return 7; }, clearTimeout: timer => { assert.equal(timer, 7); cleared++; } });
  await assert.rejects(h.blueprintAnalyticsRequest(selected), /timed out/); assert.equal(cleared, 1);
});
test('actual service projections pass strict client for both owners and all coverage states', async () => {
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const summary = { exports: {} }; vm.runInNewContext(compile('overview-summary'), { module: summary, exports: summary.exports, Date });
  const module = { exports: {} }; vm.runInNewContext(compile('blueprint-analytics'), { module, exports: module.exports, Date, AbortSignal, require: name => name === './overview-summary' ? summary.exports : name === './manufacturing-catalog' ? { findPublishedManufacturingItem: () => null } : { EveError } });
  for (const entity of ['character', 'corporation']) for (const pages of [1, 2, null]) {
    const input = { characterId, entity, page: 1 }, data = [{ item_id: 70000001, type_id: 10001, location_id: 60000001, location_flag: 'Hangar', quantity: -2, runs: 0, material_efficiency: 0, time_efficiency: 0 }];
    const read = async (_user, args) => ({ characterId, dataset: 'blueprints', ...(entity === 'corporation' ? { entity, corporationId: 98000001 } : {}), data, retrievedAt: stamp, cacheExpires: 'Thu, 01 Jan 2026 01:00:00 GMT', pagination: { kind: 'page', page: args.parameters.page, pages, nextPage: pages === 2 ? 2 : null } });
    const service = module.exports.createBlueprintAnalyticsReader({ connections: async () => [{ characterId, scopes: ['esi-characters.read_blueprints.v1', 'esi-corporations.read_blueprints.v1'] }], character: read, corporation: read, now: () => Date.parse(stamp) });
    const actual = await service('synthetic-owner', input), parsed = client.blueprintAnalyticsResponse(plain(actual), input);
    assert.equal(parsed.status, 'partial'); assert.equal(parsed.summary.unknownTypeRecords, 1); assert.equal(parsed.blueprints[0].copyRuns, 0);
  }
});
