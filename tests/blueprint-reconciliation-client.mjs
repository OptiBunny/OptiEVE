import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { z } from 'zod';
const compile = name => ts.transpileModule(readFileSync('app/lib/' + name + '.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const source = new Map(['blueprint-reconciliation-client', 'blueprint-collection-client', 'connection-client'].map(name => [name, compile(name)]));
function harness(fetch = () => { throw Error('Unexpected fetch'); }, timers = {}) {
  const modules = new Map();
  function load(name) {
    if (modules.has(name)) return modules.get(name).exports;
    const module = { exports: {} }; modules.set(name, module);
    vm.runInNewContext(source.get(name), { module, exports: module.exports, Date, AbortController, TextDecoder, TextEncoder, fetch, setTimeout, clearTimeout, ...timers, require: spec => spec === 'zod' ? { z } : load(spec.slice(2)) });
    return module.exports;
  }
  return load('blueprint-reconciliation-client');
}
const client = harness(), selected = { characterId: 90000001 }, stamp = '2026-01-01T00:00:00.000Z';
const clone = value => JSON.parse(JSON.stringify(value)), encoder = new TextEncoder(), event = value => JSON.stringify(value) + '\n';
const sourceProgress = (pagesRead = 0, pagesExpected = null, rowsReceived = 0, uniqueRecords = rowsReceived, duplicateRecords = rowsReceived - uniqueRecords) => ({ pagesRead, pagesExpected, rowsReceived, uniqueRecords, duplicateRecords, pageLimit: 50, rowLimit: 50000 });
const progress = (phase = 'blueprints', blueprints = sourceProgress(), assets = sourceProgress()) => ({ phase, blueprints, assets });
function blueprintFixture() {
  return { ...selected, entity: 'corporation', corporationId: 98000001, generatedAt: stamp, status: 'ready', message: 'Synthetic collection.', scope: 'esi-corporations.read_blueprints.v1',
    coverage: { ...sourceProgress(2, 2, 3), kind: 'all_reported_pages', completedPages: [1, 2], consistency: 'consistent', stopReason: 'complete', failedPage: null, providerCeilingPossible: false },
    freshness: { state: 'fresh', retrievedAt: stamp, cacheExpires: '2026-01-01T01:00:00.000Z', lastModified: '2025-12-31T23:59:00.000Z' },
    summary: { records: 3, types: 2, originalRecords: 1, copyRecords: 1, originalStackRecords: 1, unknownTypeRecords: 0 },
    kindCounts: [{ kind: 'original', count: 1 }, { kind: 'copy', count: 1 }, { kind: 'original_stack', count: 1 }],
    materialEfficiencyCounts: [{ level: 0, count: 1 }, { level: 10, count: 2 }], timeEfficiencyCounts: [{ level: 0, count: 1 }, { level: 20, count: 2 }],
    typeCounts: [{ typeId: 10001, name: 'Synthetic blueprint A', records: 2 }, { typeId: 10002, name: 'Synthetic blueprint B', records: 1 }],
    blueprints: [{ row: 1, typeId: 10001, name: 'Synthetic blueprint A', catalogMapped: true, kind: 'original', units: 1, materialEfficiency: 10, timeEfficiency: 20, copyRuns: null },
      { row: 2, typeId: 10001, name: 'Synthetic blueprint A', catalogMapped: true, kind: 'copy', units: 1, materialEfficiency: 10, timeEfficiency: 20, copyRuns: 0 },
      { row: 3, typeId: 10002, name: 'Synthetic blueprint B', catalogMapped: true, kind: 'original_stack', units: 10000, materialEfficiency: 0, timeEfficiency: 0, copyRuns: null }], limitations: ['Synthetic data only.'] };
}
function fixture() {
  const blueprints = blueprintFixture();
  return { ...selected, entity: 'corporation', corporationId: blueprints.corporationId, generatedAt: stamp, status: 'partial', message: 'Synthetic comparison.', blueprints,
    assets: { status: 'ready', message: 'Synthetic assets.', scope: 'esi-assets.read_corporation_assets.v1',
      coverage: { ...sourceProgress(1, 1, 8), kind: 'all_reported_pages', completedPages: [1], consistency: 'consistent', stopReason: 'complete', failedPage: null, resultLimit: 50000 },
      freshness: { ...blueprints.freshness, lastModified: '2025-12-31T23:58:00.000Z' } },
    assetsOnly: [{ row: 1, typeId: 10001, name: 'Synthetic blueprint A', catalogMapped: true, copyStatus: 'copy', quantity: 1, isSingleton: true },
      { row: 2, typeId: 10002, name: 'Synthetic blueprint B', catalogMapped: true, copyStatus: 'not_copy', quantity: 20, isSingleton: false },
      { row: 3, typeId: 10003, name: 'Synthetic blueprint C', catalogMapped: true, copyStatus: 'unknown', quantity: 1, isSingleton: true }],
    relationships: [{ row: 1, status: 'matched' }, { row: 2, status: 'conflict' }],
    summary: { blueprintRecords: 3, assetBlueprintRecords: 5, matchedRecords: 1, conflictingRecords: 1, blueprintOnlyRecords: 1, assetOnlyRecords: 3, unclassifiedAssetRecords: 1, nonBlueprintAssetRecords: 2, unionRecords: 6 },
    typeCounts: [{ typeId: 10001, name: 'Synthetic blueprint A', blueprintRecords: 2, assetOnlyRecords: 1, records: 3 }, { typeId: 10002, name: 'Synthetic blueprint B', blueprintRecords: 1, assetOnlyRecords: 1, records: 2 }, { typeId: 10003, name: 'Synthetic blueprint C', blueprintRecords: 0, assetOnlyRecords: 1, records: 1 }],
    kindCounts: [{ copyStatus: 'copy', count: 1 }, { copyStatus: 'not_copy', count: 1 }, { copyStatus: 'unknown', count: 1 }], limitations: ['Synthetic comparison limits.'] };
}
const response = content => new Response(content, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } }), resultLine = value => event({ type: 'result', result: value });
test('reconciled projections preserve separate evidence, source counts and unknown metadata', () => {
  const value = client.blueprintReconciliationResponse(fixture(), selected);
  assert.equal(value.summary.unionRecords, 6); assert.equal(value.assetsOnly[2].copyStatus, 'unknown');
  assert.equal(value.assetsOnly[1].copyStatus, 'not_copy'); assert.equal(value.assetsOnly[1].quantity, 20);
  assert.notEqual(value.assets.freshness.lastModified, value.blueprints.freshness.lastModified);
  assert.ok(!Object.hasOwn(value.assetsOnly[0], 'materialEfficiency')); assert.ok(!Object.hasOwn(value.assetsOnly[0], 'copyRuns'));
});
const mutations = [
  ['different character', v => v.characterId++], ['different owner', v => v.entity = 'character'], ['different corporation', v => v.corporationId++],
  ['missing corporation', v => v.corporationId = null], ['different nested character', v => v.blueprints.characterId++],
  ['private field at root', v => v.raw = 'PRIVATE_TEXT'], ['private item identity', v => v.assetsOnly[0].item_id = 70000001],
  ['private location', v => v.assetsOnly[0].location_id = 60000001], ['invented research', v => v.assetsOnly[0].materialEfficiency = 0],
  ['invented unlimited runs', v => v.assetsOnly[0].copyRuns = null], ['unclassified type marked blueprint', v => v.assetsOnly[0].catalogMapped = false],
  ['bad name', v => v.assetsOnly[0].name += '\u202e'], ['unknown copy as original', v => v.assetsOnly[2].copyStatus = 'original'],
  ['negative asset sentinel', v => v.assetsOnly[0].quantity = -2], ['unsafe quantity', v => v.assetsOnly[0].quantity = Number.MAX_SAFE_INTEGER + 1],
  ['nonlocal additional row', v => v.assetsOnly[0].row = 70000001], ['duplicate additional row', v => v.assetsOnly[1].row = 1],
  ['duplicate relationship', v => v.relationships[1].row = 1], ['missing relationship target', v => v.relationships[0].row = 4],
  ['raw relationship identity', v => v.relationships[0].itemId = 70000001], ['invented match', v => v.relationships[0].status = 'verified'],
  ['wrong asset scope', v => v.assets.scope = 'esi-assets.read_assets.v1'], ['wrong kind count', v => v.kindCounts[0].count++],
  ['missing unknown bucket', v => v.kindCounts.pop()], ['duplicate copy bucket', v => v.kindCounts[1].copyStatus = 'copy'],
  ['wrong blueprint count', v => v.summary.blueprintRecords++], ['wrong asset blueprint count', v => v.summary.assetBlueprintRecords++],
  ['wrong matched count', v => v.summary.matchedRecords++], ['wrong conflict count', v => v.summary.conflictingRecords++],
  ['wrong blueprint-only count', v => v.summary.blueprintOnlyRecords++], ['wrong assets-only count', v => v.summary.assetOnlyRecords++],
  ['wrong unresolved count', v => v.summary.unclassifiedAssetRecords++], ['wrong nonblueprint count', v => v.summary.nonBlueprintAssetRecords++],
  ['wrong union count', v => v.summary.unionRecords++], ['unsafe union count', v => v.summary.unionRecords = 50001],
  ['type count inflation', v => v.typeCounts[0].records++], ['type source count swap', v => { v.typeCounts[0].blueprintRecords--; v.typeCounts[0].assetOnlyRecords++; }],
  ['unsorted types', v => v.typeCounts.reverse()], ['duplicate type', v => v.typeCounts[1].typeId = v.typeCounts[0].typeId],
  ['conflicting public name', v => v.assetsOnly[0].name = 'Wrong'], ['type count label mismatch', v => v.typeCounts[0].name = 'Wrong'],
  ['unknown snapshot claimed consistent', v => v.assets.freshness.lastModified = null], ['changed final blueprint time', v => v.blueprints.generatedAt = '2025-12-31T23:59:59.000Z'],
  ['stale asset claimed fresh', v => v.assets.freshness.cacheExpires = stamp], ['unknown asset expiry claimed fresh', v => v.assets.freshness.cacheExpires = null],
  ['future asset retrieval', v => v.assets.freshness.retrievedAt = '2026-01-01T00:01:01.000Z'], ['missing completed page', v => v.assets.coverage.completedPages = []],
  ['wrong completed page', v => v.assets.coverage.completedPages = [2]], ['wrong accepted rows', v => v.assets.coverage.rowsReceived++],
  ['missing expected count', v => v.assets.coverage.pagesExpected = null], ['extra accepted page', v => v.assets.coverage.pagesRead++],
  ['too many asset rows per page', v => { v.assets.coverage.rowsReceived = 1001; v.assets.coverage.duplicateRecords = 993; }],
  ['changed output budget', v => v.assets.coverage.resultLimit = 100000], ['complete with failed page', v => v.assets.coverage.failedPage = 2],
  ['assets blank while containing data', v => v.assets.status = 'unavailable'], ['ready despite conflicts', v => v.status = 'ready'],
  ['partial assets labeled ready', v => { v.assets.coverage.kind = 'partial'; v.assets.coverage.stopReason = 'provider_error'; v.assets.coverage.failedPage = 2; v.assets.coverage.pagesExpected = 2; }],
  ['zero-copy-bucket assumption', v => { v.kindCounts[2].count = 0; v.kindCounts[1].count++; }],
];
for (const [label, change] of mutations) test('comparison rejects ' + label, () => { const value = fixture(); change(value); assert.throws(() => client.blueprintReconciliationResponse(value, selected)); });
test('freshness is judged at final comparison time for both sources', () => {
  const value = fixture(); value.generatedAt = value.blueprints.generatedAt = '2026-01-01T01:00:01.000Z';
  assert.throws(() => client.blueprintReconciliationResponse(value, selected));
  for (const stage of [value.blueprints, value.assets]) { stage.status = 'partial'; stage.freshness.state = 'stale'; }
  assert.equal(client.blueprintReconciliationResponse(value, selected).blueprints.freshness.state, 'stale');
});
test('ready requires both fresh stages and no conflicts or unclassified assets', () => {
  const value = fixture(); value.relationships[1].status = 'matched'; value.summary.matchedRecords++; value.summary.conflictingRecords = 0;
  value.summary.unclassifiedAssetRecords = 0; value.summary.nonBlueprintAssetRecords++; value.status = 'ready';
  assert.equal(client.blueprintReconciliationResponse(value, selected).status, 'ready');
  value.summary.unclassifiedAssetRecords++; value.summary.nonBlueprintAssetRecords--; assert.throws(() => client.blueprintReconciliationResponse(value, selected));
});
test('progress accepts both phases and keeps blueprint counters frozen during assets', () => {
  const first = client.blueprintReconciliationProgress(progress());
  const second = client.blueprintReconciliationProgress(progress('blueprints', sourceProgress(2, 2, 3)), first);
  const third = client.blueprintReconciliationProgress(progress('assets', sourceProgress(2, 2, 3), sourceProgress(1, 2, 8)), second);
  assert.equal(third.assets.rowsReceived, 8);
  for (const value of [progress('blueprints', third.blueprints, third.assets), progress('assets', sourceProgress(2, 2, 4), third.assets), progress('assets', third.blueprints, sourceProgress()), { ...third, raw: 'PRIVATE_TEXT' }]) assert.throws(() => client.blueprintReconciliationProgress(value, third));
  assert.throws(() => client.blueprintReconciliationProgress(progress('blueprints', sourceProgress(), sourceProgress(1, 1, 1))));
});
test('selection validation happens before fetching', async () => {
  let calls = 0; const h = harness(() => { calls++; });
  for (const value of [null, {}, { characterId: 0 }, { ...selected, corporationId: 98000001 }, { ...selected, page: 2 }, { ...selected, entity: 'corporation' }]) await assert.rejects(h.blueprintReconciliationRequest(value));
  assert.equal(calls, 0);
});
test('same-origin one-click request streams both phase updates before final output', async () => {
  const calls = [], updates = [], b = sourceProgress(2, 2, 3), content = event({ type: 'progress', progress: progress() }) + event({ type: 'progress', progress: progress('blueprints', b) }) + event({ type: 'progress', progress: progress('assets', b, sourceProgress(1, 1, 8)) }) + resultLine(fixture());
  const h = harness(async (url, options) => { calls.push({ url, options }); return response(content); });
  const value = await h.blueprintReconciliationRequest(selected, { onProgress: value => updates.push(clone(value)) });
  assert.equal(value.summary.assetOnlyRecords, 3); assert.equal(updates.length, 3); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/eve/blueprint-reconciliation'); assert.equal(calls[0].options.method, 'POST'); assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.cache, 'no-store'); assert.equal(calls[0].options.redirect, 'error'); assert.deepEqual(JSON.parse(calls[0].options.body), selected);
});
const protocol = [
  ['missing terminal', event({ type: 'progress', progress: progress() })], ['invalid JSON', 'PRIVATE_TEXT\n'], ['blank line', '\n' + resultLine(fixture())],
  ['extra event field', event({ type: 'result', result: fixture(), raw: 'PRIVATE_TEXT' })], ['double terminal', resultLine(fixture()) + resultLine(fixture())],
  ['late progress', resultLine(fixture()) + event({ type: 'progress', progress: progress() })], ['unknown error status', event({ type: 'error', status: 418, message: 'PRIVATE_TEXT' })],
  ['assets without phase change', event({ type: 'progress', progress: progress() }) + resultLine(fixture())],
  ['regressed final assets', event({ type: 'progress', progress: progress('assets', sourceProgress(2, 2, 3), sourceProgress(1, 1, 9)) }) + resultLine(fixture())],
  ['changed final blueprints', event({ type: 'progress', progress: progress('assets', sourceProgress(1, 2, 1)) }) + resultLine(fixture())],
  ['changed expected asset pages', event({ type: 'progress', progress: progress('assets', sourceProgress(2, 2, 3), sourceProgress(1, 2, 8)) }) + resultLine(fixture())],
];
for (const [label, content] of protocol) test('stream rejects ' + label + ' safely', async () => {
  await assert.rejects(harness(async () => response(content)).blueprintReconciliationRequest(selected), error => !error.message.includes('PRIVATE_TEXT'));
});
test('progress event count, line bytes and total stream limits are bounded', async () => {
  for (const content of [event({ type: 'progress', progress: progress(), padding: 'x'.repeat(4096) }), Array.from({ length: 257 }, () => event({ type: 'progress', progress: progress() })).join(''), ' '.repeat(16 * 1024 * 1024 + 1) + '\n', new Uint8Array(17 * 1024 * 1024 + 1)]) await assert.rejects(harness(async () => response(content)).blueprintReconciliationRequest(selected));
});
test('safe errors retain useful HTTP statuses without provider text', async () => {
  for (const status of [400, 401, 403, 404, 409, 413, 429, 500, 502, 504]) for (const r of [new Response('PRIVATE_TEXT', { status }), response(event({ type: 'error', status, message: 'PRIVATE_TEXT' }))]) await assert.rejects(harness(async () => r).blueprintReconciliationRequest(selected), error => error.status === status && !error.message.includes('PRIVATE'));
});
test('invalid UTF8 and content types are rejected', async () => {
  for (const r of [response(new Uint8Array([0xc3, 0x28, 10])), new Response(resultLine(fixture()), { headers: { 'content-type': 'application/json' } }), { ok: true, headers: new Headers({ 'content-type': 'application/x-ndjson' }), body: null }]) await assert.rejects(harness(async () => r).blueprintReconciliationRequest(selected));
});
test('incremental asset progress arrives before final result with split UTF8', async () => {
  let controller, notify; const update = new Promise(resolve => { notify = resolve; });
  const h = harness(async () => new Response(new ReadableStream({ start(value) { controller = value; controller.enqueue(encoder.encode(event({ type: 'progress', progress: progress('assets', sourceProgress(2, 2, 3)) }))); } }), { headers: { 'content-type': 'application/x-ndjson' } }));
  let resolved = false; const pending = h.blueprintReconciliationRequest(selected, { onProgress: value => { assert.equal(value.phase, 'assets'); notify(); } }).then(value => { resolved = true; return value; });
  await update; assert.equal(resolved, false); const value = fixture(); value.message += ' β'; const bytes = encoder.encode(resultLine(value)), split = bytes.indexOf(0xce) + 1;
  controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)); controller.close(); assert.equal((await pending).message, value.message);
});
test('cancellation suppresses late results and cancels uncooperative reads', async () => {
  let calls = 0; const early = new AbortController(); early.abort();
  await assert.rejects(harness(() => { calls++; }).blueprintReconciliationRequest(selected, { signal: early.signal }), /cancelled/); assert.equal(calls, 0);
  const controller = new AbortController(); let cancelled = 0, released = 0;
  const h = harness(async () => ({ ok: true, headers: new Headers({ 'content-type': 'application/x-ndjson' }), body: { getReader: () => ({ read: () => { queueMicrotask(() => controller.abort()); return new Promise(() => {}); }, cancel: async () => { cancelled++; }, releaseLock: () => { released++; } }) } }));
  await assert.rejects(h.blueprintReconciliationRequest(selected, { signal: controller.signal }), /cancelled/); assert.equal(cancelled, 1); assert.equal(released, 1);
  const late = new AbortController(), stream = event({ type: 'progress', progress: progress() }) + resultLine(fixture());
  await assert.rejects(harness(async () => response(stream)).blueprintReconciliationRequest(selected, { signal: late.signal, onProgress: () => late.abort() }), /cancelled/);
});
test('shared client timeout races uncooperative fetch and clears its timer', async () => {
  let callback, cleared = 0;
  const h = harness(() => { queueMicrotask(callback); return new Promise(() => {}); }, { setTimeout: (fn, ms) => { assert.equal(ms, 60000); callback = fn; return 7; }, clearTimeout: id => { assert.equal(id, 7); cleared++; } });
  await assert.rejects(h.blueprintReconciliationRequest(selected), /timed out/); assert.equal(cleared, 1);
});

test('actual reader projections round-trip across both source permissions, coverage and freshness states', async () => {
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const modules = new Map(), eve = { EveError };
  const catalog = { findPublishedManufacturingItem: typeId => typeId === 10004 ? null : ({ typeId, name: 'Synthetic type ' + typeId, categoryId: typeId === 10003 ? 6 : 9, categoryName: typeId === 10003 ? 'Ship' : 'Blueprint', groupId: 1, groupName: 'Synthetic group' }) };
  function load(name) {
    if (!modules.has(name)) { const module = { exports: {} }; modules.set(name, module);
      vm.runInNewContext(compile(name), { module, exports: module.exports, Date, AbortSignal, require: spec => spec === './eve' ? eve : spec === './manufacturing-catalog' ? catalog : load(spec.slice(2)) }); }
    return modules.get(name).exports;
  }
  const bp = (item_id, type_id = 10001) => ({ item_id, type_id, location_id: 60000001, location_flag: 'Hangar', quantity: -1, runs: -1, material_efficiency: 10, time_efficiency: 20 });
  const asset = (item_id, type_id = 10001, flag) => ({ item_id, type_id, location_id: 60000001, location_type: 'station', location_flag: 'Hangar', quantity: 1, is_singleton: true, ...(flag === undefined ? {} : { is_blueprint_copy: flag }) });
  for (const mode of ['normal', 'no_bp_scope', 'no_asset_scope', 'no_scopes', 'empty', 'first_asset_failure', 'later_asset_failure', 'duplicate', 'conflict', 'unknown_pages', 'unknown_snapshot', 'changed_pages', 'changed_snapshot', 'changed_corporation', 'stale_at_completion', 'deadline_at_completion']) {
    let clock = Date.parse(stamp);
    const scopes = [mode !== 'no_bp_scope' && mode !== 'no_scopes' ? 'esi-corporations.read_blueprints.v1' : null, mode !== 'no_asset_scope' && mode !== 'no_scopes' ? 'esi-assets.read_corporation_assets.v1' : null].filter(Boolean);
    const updates = [];
    const read = load('blueprint-reconciliation').createBlueprintReconciliationReader({ now: () => clock, connections: async () => [{ ...selected, scopes }], corporation: async (_user, args) => {
      const page = args.parameters.page, isAssets = args.dataset === 'assets';
      if (isAssets && (mode === 'first_asset_failure' || mode === 'later_asset_failure' && page === 2)) throw new EveError('PRIVATE_PROVIDER_TEXT', 403);
      const pages = !isAssets ? 1 : mode === 'unknown_pages' ? null : mode === 'changed_pages' && page === 2 ? 3 : 2;
      let data = !isAssets ? [bp(70000001), bp(70000002, 10002)] : page === 1 ? [asset(70000001, 10001, false), asset(70000003, 10002, true)] :
        [asset(mode === 'duplicate' ? 70000003 : mode === 'conflict' ? 70000001 : 70000004, 10002), asset(70000005, 10003), asset(70000006, 10004)];
      if (mode === 'duplicate' && isAssets && page === 2) data[0] = asset(70000003, 10002, true);
      if (mode === 'empty') data = [];
      if (isAssets && page === 2 && mode === 'stale_at_completion') clock += 2000;
      if (isAssets && page === 2 && mode === 'deadline_at_completion') clock += 55000;
      return { ...selected, entity: 'corporation', corporationId: isAssets && page === 2 && mode === 'changed_corporation' ? 98000002 : 98000001, dataset: args.dataset, data, retrievedAt: stamp,
        cacheExpires: mode === 'stale_at_completion' ? 'Thu, 01 Jan 2026 00:00:01 GMT' : 'Thu, 01 Jan 2026 01:00:00 GMT',
        lastModified: isAssets && mode === 'unknown_snapshot' ? null : isAssets && page === 2 && mode === 'changed_snapshot' ? 'Wed, 31 Dec 2025 23:57:00 GMT' : isAssets ? 'Wed, 31 Dec 2025 23:58:00 GMT' : 'Wed, 31 Dec 2025 23:59:00 GMT',
        pagination: { kind: 'page', page, pages, nextPage: pages !== null && page < pages ? page + 1 : null, pageLimit: 500, morePagesAvailable: pages === null ? null : page < pages, pageLimitReached: false } };
    } });
    const actual = clone(await read('synthetic-owner', selected, { onProgress: value => updates.push(clone(value)) }));
    const parsed = client.blueprintReconciliationResponse(actual, selected);
    assert.equal(parsed.status, actual.status, mode); assert.equal(parsed.summary.unionRecords, actual.summary.unionRecords, mode);
    if (mode === 'stale_at_completion') assert.equal(parsed.blueprints.freshness.state, 'stale');
    if (mode === 'no_bp_scope') { assert.equal(parsed.blueprints.summary, null); assert.ok(parsed.assetsOnly.length > 0); }
    const content = updates.map(value => event({ type: 'progress', progress: value })).join('') + resultLine(actual);
    assert.equal((await harness(async () => response(content)).blueprintReconciliationRequest(selected)).summary.unionRecords, actual.summary.unionRecords, mode);
  }
});


