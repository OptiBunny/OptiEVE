import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { z } from 'zod';
const compile = name => ts.transpileModule(readFileSync(`app/lib/${name}.ts`, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const code = compile('blueprint-collection-client'), connectionCode = compile('connection-client');
function harness(fetch = () => { throw Error('Unexpected fetch'); }, timers = {}) {
  const connection = { exports: {} }, module = { exports: {} };
  vm.runInNewContext(connectionCode, { module: connection, exports: connection.exports });
  vm.runInNewContext(code, { module, exports: module.exports, Date, AbortController, TextDecoder, TextEncoder, fetch, setTimeout, clearTimeout, ...timers, require: name => name === 'zod' ? { z } : connection.exports });
  return module.exports;
}
const client = harness(), selected = { characterId: 90000001 }, stamp = '2026-01-01T00:00:00.000Z';
const clone = value => JSON.parse(JSON.stringify(value));
const encoder = new TextEncoder(), event = value => JSON.stringify(value) + '\n';
const progress = (pagesRead = 0, pagesExpected = null, rowsReceived = 0, uniqueRecords = rowsReceived, duplicateRecords = rowsReceived - uniqueRecords) => ({ pagesRead, pagesExpected, rowsReceived, uniqueRecords, duplicateRecords, pageLimit: 50, rowLimit: 50000 });
function fixture() {
  return { ...selected, entity: 'corporation', corporationId: 98000001, generatedAt: stamp, status: 'ready', message: 'Synthetic collection.', scope: 'esi-corporations.read_blueprints.v1',
    coverage: { ...progress(2, 2, 3), kind: 'all_reported_pages', completedPages: [1, 2], consistency: 'consistent', stopReason: 'complete', failedPage: null, providerCeilingPossible: false },
    freshness: { state: 'fresh', retrievedAt: stamp, cacheExpires: '2026-01-01T01:00:00.000Z', lastModified: '2025-12-31T23:59:00.000Z' },
    summary: { records: 3, types: 2, originalRecords: 1, copyRecords: 1, originalStackRecords: 1, unknownTypeRecords: 0 },
    kindCounts: [{ kind: 'original', count: 1 }, { kind: 'copy', count: 1 }, { kind: 'original_stack', count: 1 }],
    materialEfficiencyCounts: [{ level: 0, count: 1 }, { level: 10, count: 2 }], timeEfficiencyCounts: [{ level: 0, count: 1 }, { level: 20, count: 2 }],
    typeCounts: [{ typeId: 10001, name: 'Synthetic blueprint A', records: 2 }, { typeId: 10002, name: 'Synthetic blueprint B', records: 1 }],
    blueprints: [{ row: 1, typeId: 10001, name: 'Synthetic blueprint A', catalogMapped: true, kind: 'original', units: 1, materialEfficiency: 10, timeEfficiency: 20, copyRuns: null },
      { row: 2, typeId: 10001, name: 'Synthetic blueprint A', catalogMapped: true, kind: 'copy', units: 1, materialEfficiency: 10, timeEfficiency: 20, copyRuns: 0 },
      { row: 3, typeId: 10002, name: 'Synthetic blueprint B', catalogMapped: true, kind: 'original_stack', units: 10000, materialEfficiency: 0, timeEfficiency: 0, copyRuns: null }], limitations: ['Synthetic data only.'] };
}
function blank() {
  const value = fixture(); Object.assign(value, { corporationId: null, status: 'unavailable', summary: null, blueprints: [], typeCounts: [], kindCounts: [], materialEfficiencyCounts: [], timeEfficiencyCounts: [] });
  value.coverage = { ...progress(), kind: 'unavailable', completedPages: [], consistency: 'unknown', stopReason: 'provider_error', failedPage: null, providerCeilingPossible: false };
  value.freshness = { state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null }; return value;
}
const response = lines => new Response(lines, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } });
const resultLine = value => event({ type: 'result', result: value });

test('collection validates global blueprint record/type/efficiency counts and per-row semantics', () => {
  const value = client.blueprintCollectionResponse(fixture(), selected);
  assert.equal(value.summary.records, 3); assert.equal(value.blueprints[1].copyRuns, 0); assert.equal(value.blueprints[2].units, 10000);
  assert.equal(value.coverage.kind, 'all_reported_pages');
});
test('validated partial, unknown snapshot, duplicate and failure states remain honest', () => {
  for (const reason of ['provider_error', 'invalid_page', 'pagination_changed', 'snapshot_changed', 'corporation_changed', 'conflicting_duplicate', 'deadline', 'cancelled']) {
    const value = fixture(); value.status = 'partial'; Object.assign(value.coverage, { kind: 'partial', pagesExpected: 3, stopReason: reason, failedPage: 3 });
    if (['pagination_changed', 'snapshot_changed', 'corporation_changed', 'conflicting_duplicate'].includes(reason)) { value.coverage.consistency = 'inconsistent'; value.freshness.lastModified = null; }
    assert.equal(client.blueprintCollectionResponse(value, selected).coverage.stopReason, reason);
  }
  const unknown = fixture(); unknown.status = 'partial'; Object.assign(unknown.coverage, { kind: 'unknown', consistency: 'unknown' }); unknown.freshness.lastModified = null;
  assert.equal(client.blueprintCollectionResponse(unknown, selected).coverage.kind, 'unknown');
  const duplicate = fixture(); duplicate.status = 'partial'; Object.assign(duplicate.coverage, { kind: 'partial', consistency: 'inconsistent', rowsReceived: 4, duplicateRecords: 1 }); duplicate.freshness.lastModified = null;
  assert.equal(client.blueprintCollectionResponse(duplicate, selected).coverage.duplicateRecords, 1);
});
test('blank projections and first-page failures carry no holdings', () => {
  for (const status of ['needs_permission', 'unavailable', 'error']) {
    const value = blank(); value.status = status; assert.equal(client.blueprintCollectionResponse(value, selected).summary, null);
    if (status !== 'needs_permission') { value.coverage.failedPage = 1; assert.equal(client.blueprintCollectionResponse(value, selected).coverage.failedPage, 1); }
  }
});
const mutations = [
  ['different character', v => v.characterId++], ['different owner', v => v.entity = 'character'], ['wrong scope', v => v.scope = 'esi-assets.read_assets.v1'], ['missing corporation', v => v.corporationId = null],
  ['raw private field', v => v.raw = 'DO_NOT_RENDER'], ['raw row identifier', v => v.blueprints[0].item_id = 70000001], ['nonlocal row number', v => v.blueprints[0].row = 70000001],
  ['duplicate row number', v => v.blueprints[1].row = 1], ['unknown mapped name', v => { v.blueprints[0].catalogMapped = false; v.summary.unknownTypeRecords = 1; v.status = 'partial'; }],
  ['contradictory type name', v => v.blueprints[1].name = 'Other'], ['contradictory type mapping', v => v.blueprints[1].catalogMapped = false], ['unsafe name', v => v.blueprints[0].name += '\u202e'],
  ['copy missing runs', v => v.blueprints[1].copyRuns = null], ['original finite runs', v => v.blueprints[0].copyRuns = 2], ['copy stack units', v => v.blueprints[1].units = 2],
  ['negative copy runs', v => v.blueprints[1].copyRuns = -1], ['zero original stack', v => v.blueprints[2].units = 0], ['unsafe units', v => v.blueprints[2].units = Number.MAX_SAFE_INTEGER + 1],
  ['mixed summary count', v => v.summary.records++], ['wrong type count', v => v.summary.types++], ['wrong original count', v => v.summary.originalRecords++],
  ['wrong copy count', v => v.summary.copyRecords++], ['wrong stack count', v => v.summary.originalStackRecords++], ['wrong unmapped count', v => v.summary.unknownTypeRecords++],
  ['wrong kind total', v => v.kindCounts[0].count++], ['missing kind', v => v.kindCounts.pop()], ['duplicate kind', v => v.kindCounts[1].kind = 'original'],
  ['wrong ME total', v => v.materialEfficiencyCounts[0].count++], ['wrong TE total', v => v.timeEfficiencyCounts[1].count++], ['duplicated ME bucket', v => v.materialEfficiencyCounts[1].level = 0],
  ['unsorted TE buckets', v => v.timeEfficiencyCounts.reverse()], ['duplicate type total', v => v.typeCounts[1].typeId = 10001], ['wrong type label', v => v.typeCounts[0].name = 'Wrong'],
  ['wrong aggregate type count', v => v.typeCounts[0].records++], ['unsorted top types', v => v.typeCounts.reverse()], ['inconsistent received count', v => v.coverage.rowsReceived++],
  ['inconsistent unique count', v => v.coverage.uniqueRecords++], ['too many rows for pages', v => { v.coverage.rowsReceived = 3000; v.coverage.duplicateRecords = 2997; }],
  ['noncontiguous pages', v => v.coverage.completedPages = [1, 3]], ['wrong page count', v => v.coverage.pagesRead = 3], ['wrong completed count', v => v.coverage.completedPages.pop()],
  ['unadvertised accepted pages', v => v.coverage.pagesExpected = 1], ['invented provider warning', v => v.coverage.providerCeilingPossible = true], ['wrong failed page', v => v.coverage.failedPage = 4],
  ['changed page budget', v => v.coverage.pageLimit = 500], ['changed row budget', v => v.coverage.rowLimit = 500000], ['complete with unknown pages', v => v.coverage.pagesExpected = null],
  ['complete snapshot missing modification time', v => v.freshness.lastModified = null], ['duplicate claimed consistent', v => { v.coverage.rowsReceived++; v.coverage.duplicateRecords++; }],
  ['changed snapshot claimed consistent', v => { v.status = 'partial'; v.coverage.kind = 'partial'; v.coverage.stopReason = 'snapshot_changed'; v.coverage.pagesExpected = 3; }],
  ['stopped while marked all-pages', v => v.coverage.stopReason = 'provider_error'], ['ready with stale expiry', v => { v.freshness.state = 'stale'; v.freshness.cacheExpires = stamp; }],
  ['freshness mismatch', v => v.freshness.state = 'unknown'], ['unknown expiry claimed fresh', v => v.freshness.cacheExpires = null], ['future retrieval', v => v.freshness.retrievedAt = '2026-01-01T00:01:01.000Z'],
  ['offset date', v => v.generatedAt = '2026-01-01T01:00:00+01:00'], ['rollover date', v => v.generatedAt = '2026-02-30T00:00:00.000Z'], ['unavailable with holdings', v => v.status = 'unavailable'],
];
for (const [label, mutate] of mutations) test(`collection rejects ${label}`, () => { const value = fixture(); mutate(value); assert.throws(() => client.blueprintCollectionResponse(value, selected)); });
test('unavailable projection rejects hidden collection metadata and data arrays', () => {
  for (const mutate of [v => v.corporationId = 98000001, v => v.coverage.pagesExpected = 2, v => v.coverage.consistency = 'inconsistent', v => v.summary = fixture().summary, v => v.typeCounts = fixture().typeCounts, v => v.freshness.lastModified = stamp]) {
    const value = blank(); mutate(value); assert.throws(() => client.blueprintCollectionResponse(value, selected));
  }
});
test('progress validation reconciles counters and forbids regressions or page-count changes', () => {
  const first = client.blueprintCollectionProgress(progress(1, 3, 10)); assert.equal(first.uniqueRecords, 10);
  assert.equal(client.blueprintCollectionProgress(progress(2, 3, 20, 18, 2), first).duplicateRecords, 2);
  for (const value of [progress(0, 3, 0), progress(2, 4, 20), progress(2, 3, 9), progress(2, 1, 10), progress(1, 3, 1001), { ...progress(2, 3, 20), uniqueRecords: 19 }, { ...progress(), private: 'DO_NOT_RENDER' }]) assert.throws(() => client.blueprintCollectionProgress(value, first));
});
test('selection fails before fetch and forbids caller corporation IDs or page controls', async () => {
  let calls = 0; const h = harness(() => { calls++; });
  for (const args of [null, {}, { characterId: 0 }, { ...selected, corporationId: 98000001 }, { ...selected, page: 1 }, { ...selected, entity: 'corporation' }]) await assert.rejects(h.blueprintCollectionRequest(args));
  assert.equal(calls, 0);
});
test('stream request uses same-origin POST, validates progress before callback and returns final projection', async () => {
  const calls = [], updates = [], content = event({ type: 'progress', progress: progress() }) + event({ type: 'progress', progress: progress(1, 2, 1) }) + resultLine(fixture());
  const h = harness(async (url, options) => { calls.push({ url, options }); return response(content); });
  const result = await h.blueprintCollectionRequest(selected, { onProgress: value => updates.push(clone(value)) });
  assert.equal(result.summary.records, 3); assert.equal(updates.length, 2); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/eve/blueprint-collection'); assert.equal(calls[0].options.method, 'POST'); assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.cache, 'no-store'); assert.equal(calls[0].options.redirect, 'error'); assert.deepEqual(JSON.parse(calls[0].options.body), selected);
});
test('incremental progress arrives before final result and split UTF-8/chunks are decoded safely', async () => {
  let streamController, notify; const received = new Promise(resolve => { notify = resolve; });
  const content = fixture(); content.message = 'Synthetic β collection';
  const h = harness(async () => new Response(new ReadableStream({ start(controller) { streamController = controller; controller.enqueue(encoder.encode(event({ type: 'progress', progress: progress() }))); } }), { headers: { 'content-type': 'application/x-ndjson' } }));
  let resolved = false; const pending = h.blueprintCollectionRequest(selected, { onProgress: value => { assert.equal(value.pagesRead, 0); notify(); } }).then(value => { resolved = true; return value; });
  await received; assert.equal(resolved, false);
  const bytes = encoder.encode(resultLine(content)), split = bytes.indexOf(0xce) + 1;
  streamController.enqueue(bytes.slice(0, split)); streamController.enqueue(bytes.slice(split)); streamController.close();
  assert.equal((await pending).message, content.message);
});
const protocolCases = [
  ['missing terminal result', event({ type: 'progress', progress: progress() })], ['invalid JSON', 'PRIVATE_BAD_JSON\n'], ['HTML body', '<html>PRIVATE</html>\n'],
  ['wrong event type', event({ type: 'unknown', result: fixture() })], ['extra event property', event({ type: 'result', result: fixture(), private: 'DO_NOT_RENDER' })],
  ['double terminal', resultLine(fixture()) + resultLine(fixture())], ['progress after terminal', resultLine(fixture()) + event({ type: 'progress', progress: progress() })],
  ['blank event line', '\n' + resultLine(fixture())], ['regressed progress', event({ type: 'progress', progress: progress(1, 2, 2) }) + event({ type: 'progress', progress: progress() }) + resultLine(fixture())],
  ['final less than reported progress', event({ type: 'progress', progress: progress(2, 2, 4) }) + resultLine(fixture())], ['final different expected pages', event({ type: 'progress', progress: progress(1, 3, 1) }) + resultLine(fixture())],
  ['unknown terminal error status', event({ type: 'error', status: 418, message: 'PRIVATE_TEXT' })], ['truncated result JSON', resultLine(fixture()).slice(0, -5)],
];
for (const [label, content] of protocolCases) test(`stream rejects ${label} without exposing payload text`, async () => {
  await assert.rejects(harness(async () => response(content)).blueprintCollectionRequest(selected), error => !error.message.includes('PRIVATE') && !error.message.includes('DO_NOT_RENDER'));
});
test('progress line size/count and total/result byte budgets are enforced', async () => {
  for (const content of [event({ type: 'progress', progress: progress(), padding: 'x'.repeat(4096) }), Array.from({ length: 129 }, () => event({ type: 'progress', progress: progress() })).join(''), ' '.repeat(16 * 1024 * 1024 + 1) + '\n', new Uint8Array(17 * 1024 * 1024 + 1)]) {
    await assert.rejects(harness(async () => response(content)).blueprintCollectionRequest(selected));
  }
});
test('invalid UTF-8 and wrong content types fail before any result is used', async () => {
  for (const r of [response(new Uint8Array([0xc3, 0x28, 10])), new Response(resultLine(fixture()), { headers: { 'content-type': 'application/json' } }), { ok: true, headers: new Headers({ 'content-type': 'application/x-ndjson' }), body: null }]) await assert.rejects(harness(async () => r).blueprintCollectionRequest(selected));
});
test('HTTP and terminal errors preserve safe status guidance only', async () => {
  for (const status of [400, 401, 403, 404, 409, 413, 429, 500, 502, 504]) {
    for (const r of [new Response('PRIVATE_PROVIDER_TEXT', { status }), response(event({ type: 'error', status, message: 'PRIVATE_PROVIDER_TEXT' }))]) await assert.rejects(harness(async () => r).blueprintCollectionRequest(selected), error => error.status === status && !error.message.includes('PRIVATE'));
  }
});
test('cancel before start and uncooperative fetch abort without returning data', async () => {
  let calls = 0; const early = new AbortController(); early.abort();
  await assert.rejects(harness(async () => { calls++; }).blueprintCollectionRequest(selected, { signal: early.signal }), /cancelled/); assert.equal(calls, 0);
  const controller = new AbortController(), h = harness(() => { queueMicrotask(() => controller.abort()); return new Promise(() => {}); });
  await assert.rejects(h.blueprintCollectionRequest(selected, { signal: controller.signal }), /cancelled/);
});
test('cancel during an uncooperative stream read cancels the reader and releases its lock', async () => {
  const controller = new AbortController(); let cancelled = 0, released = 0;
  const h = harness(async () => ({ ok: true, headers: new Headers({ 'content-type': 'application/x-ndjson' }), body: { getReader: () => ({ read: () => { queueMicrotask(() => controller.abort()); return new Promise(() => {}); }, cancel: async () => { cancelled++; }, releaseLock: () => { released++; } }) } }));
  await assert.rejects(h.blueprintCollectionRequest(selected, { signal: controller.signal }), /cancelled/); assert.equal(cancelled, 1); assert.equal(released, 1);
});
test('bounded timeout aborts an uncooperative reader and cleanup always clears its timer', async () => {
  let callback, cleared = 0;
  const h = harness(async () => ({ ok: true, headers: new Headers({ 'content-type': 'application/x-ndjson' }), body: { getReader: () => ({ read: () => { queueMicrotask(callback); return new Promise(() => {}); }, cancel: async () => {}, releaseLock: () => {} }) } }), { setTimeout: (fn, ms) => { assert.equal(ms, 60000); callback = fn; return 42; }, clearTimeout: id => { assert.equal(id, 42); cleared++; } });
  await assert.rejects(h.blueprintCollectionRequest(selected), /timed out/); assert.equal(cleared, 1);
});
test('cancel from progress callback suppresses a final result in the same chunk', async () => {
  const controller = new AbortController(), h = harness(async () => response(event({ type: 'progress', progress: progress() }) + resultLine(fixture())));
  await assert.rejects(h.blueprintCollectionRequest(selected, { signal: controller.signal, onProgress: () => controller.abort() }), /cancelled/);
});
test('actual collection service projections pass client across success, partial and unknown evidence', async () => {
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const modules = new Map(), eve = { EveError };
  function load(name) {
    if (!modules.has(name)) { const module = { exports: {} }; modules.set(name, module);
      vm.runInNewContext(compile(name), { module, exports: module.exports, Date, AbortSignal, require: spec => spec === './eve' ? eve : spec === './manufacturing-catalog' ? { findPublishedManufacturingItem: typeId => ({ name: `Synthetic blueprint ${typeId}` }) } : load(spec.slice(2)) }); }
    return modules.get(name).exports;
  }
  const row = (id, type = 10001) => ({ item_id: id, type_id: type, location_id: 60000001, location_flag: 'Hangar', quantity: -2, runs: 2, material_efficiency: 10, time_efficiency: 20 });
  for (const mode of ['good', 'duplicate', 'missing_pages', 'missing_modified', 'changed_pages', 'changed_modified', 'changed_corporation', 'failed', 'conflict', 'stale', 'empty', 'first_failed', 'missing_scope']) {
    const read = load('blueprint-collection').createBlueprintCollectionReader({ connections: async () => [{ ...selected, scopes: mode === 'missing_scope' ? [] : ['esi-corporations.read_blueprints.v1'] }], now: () => Date.parse(stamp), corporation: async (_user, input) => {
      const page = input.parameters.page;
      if (mode === 'first_failed' || page === 2 && mode === 'failed') throw new EveError('PRIVATE_PROVIDER_TEXT', 403);
      const pages = mode === 'missing_pages' ? null : mode === 'changed_pages' && page === 2 ? 3 : 2;
      const data = mode === 'empty' ? [] : page === 1 ? [row(70000001)] : [row(mode === 'duplicate' || mode === 'conflict' ? 70000001 : 70000002, mode === 'conflict' ? 10002 : 10001)];
      return { ...selected, entity: 'corporation', corporationId: mode === 'changed_corporation' && page === 2 ? 98000002 : 98000001, dataset: 'blueprints', data, retrievedAt: stamp,
        cacheExpires: mode === 'stale' ? 'Thu, 01 Jan 2026 00:00:00 GMT' : 'Thu, 01 Jan 2026 01:00:00 GMT', lastModified: mode === 'missing_modified' ? null : mode === 'changed_modified' && page === 2 ? 'Wed, 31 Dec 2025 23:58:00 GMT' : 'Wed, 31 Dec 2025 23:59:00 GMT',
        pagination: { kind: 'page', page, pages, nextPage: pages !== null && page < pages ? page + 1 : null, pageLimit: 500, morePagesAvailable: pages === null ? null : page < pages, pageLimitReached: false } };
    } });
    const actual = clone(await read('synthetic-owner', selected));
    const parsed = client.blueprintCollectionResponse(actual, selected); assert.equal(parsed.coverage.stopReason, actual.coverage.stopReason, mode);
  }
});

test('coverage stop reasons reconcile failed pages, missing metadata and application budgets', () => {
  const completeFailed = fixture(); completeFailed.coverage.failedPage = 3; assert.throws(() => client.blueprintCollectionResponse(completeFailed, selected));
  const missing = fixture(); missing.status = 'partial'; Object.assign(missing.coverage, { kind: 'unknown', pagesExpected: null, pagesRead: 1, completedPages: [1], stopReason: 'missing_page_count' });
  assert.equal(client.blueprintCollectionResponse(missing, selected).coverage.kind, 'unknown');
  for (const change of [v => v.coverage.failedPage = 2, v => { v.coverage.pagesRead = 2; v.coverage.completedPages = [1, 2]; }, v => v.coverage.kind = 'partial']) { const v = clone(missing); change(v); assert.throws(() => client.blueprintCollectionResponse(v, selected)); }
  const limit = fixture(); limit.status = 'partial'; Object.assign(limit.coverage, { kind: 'partial', pagesRead: 50, completedPages: Array.from({ length: 50 }, (_, i) => i + 1), pagesExpected: 51, stopReason: 'page_limit' });
  assert.equal(client.blueprintCollectionResponse(limit, selected).coverage.stopReason, 'page_limit');
  for (const change of [v => { v.coverage.pagesRead = 49; v.coverage.completedPages.pop(); }, v => v.coverage.pagesExpected = 50, v => v.coverage.stopReason = 'row_limit']) { const v = clone(limit); change(v); assert.throws(() => client.blueprintCollectionResponse(v, selected)); }
  for (const reason of ['provider_error', 'invalid_page', 'pagination_changed', 'snapshot_changed', 'corporation_changed', 'conflicting_duplicate']) {
    const value = fixture(); value.status = 'partial'; Object.assign(value.coverage, { kind: 'partial', pagesExpected: 3, stopReason: reason, failedPage: 3 });
    if (['pagination_changed', 'snapshot_changed', 'corporation_changed', 'conflicting_duplicate'].includes(reason)) { value.coverage.consistency = 'inconsistent'; value.freshness.lastModified = null; }
    assert.equal(client.blueprintCollectionResponse(value, selected).coverage.failedPage, 3); value.coverage.failedPage = null; assert.throws(() => client.blueprintCollectionResponse(value, selected));
  }
});
test('large collection respects historical ceiling without declaring the owned library complete', async () => {
  const value = fixture(), size = 25000; value.status = 'partial';
  Object.assign(value.coverage, { pagesRead: 25, pagesExpected: 25, completedPages: Array.from({ length: 25 }, (_, index) => index + 1), rowsReceived: size, uniqueRecords: size, providerCeilingPossible: true });
  value.blueprints = Array.from({ length: size }, (_, index) => ({ row: index + 1, typeId: 10001, name: 'Synthetic blueprint A', catalogMapped: true, kind: 'original', units: 1, materialEfficiency: 0, timeEfficiency: 0, copyRuns: null }));
  value.summary = { records: size, types: 1, originalRecords: size, copyRecords: 0, originalStackRecords: 0, unknownTypeRecords: 0 };
  value.kindCounts = [{ kind: 'original', count: size }, { kind: 'copy', count: 0 }, { kind: 'original_stack', count: 0 }];
  value.typeCounts = [{ typeId: 10001, name: 'Synthetic blueprint A', records: size }]; value.materialEfficiencyCounts = [{ level: 0, count: size }]; value.timeEfficiencyCounts = [{ level: 0, count: size }];
  const parsed = await harness(async () => response(resultLine(value))).blueprintCollectionRequest(selected);
  assert.equal(parsed.summary.records, size); assert.equal(parsed.status, 'partial'); assert.equal(parsed.coverage.kind, 'all_reported_pages');
  value.coverage.providerCeilingPossible = false; assert.throws(() => client.blueprintCollectionResponse(value, selected));
});
