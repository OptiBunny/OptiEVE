import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const compile = name => ts.transpileModule(readFileSync(`app/lib/${name}.ts`, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const compiled = Object.fromEntries(['overview-summary', 'blueprint-analytics', 'blueprint-collection', 'inventory-analytics', 'blueprint-reconciliation'].map(name => [name, compile(name)]));
const stamp = '2026-01-01T00:00:00.000Z', epoch = Date.parse(stamp), characterId = 90000001, corporationId = 98000001;
const bpScope = 'esi-corporations.read_blueprints.v1', assetScope = 'esi-assets.read_corporation_assets.v1', marker = 'PRIVATE_RECONCILIATION_MARKER';
const plain = value => JSON.parse(JSON.stringify(value));
const bp = (item_id = 70000001, extra = {}) => ({ item_id, type_id: 10001, quantity: -1, runs: -1, material_efficiency: 10, time_efficiency: 20, location_id: 60000001, location_flag: 'Hangar', name: marker, ...extra });
const asset = (item_id = 70000001, extra = {}) => ({ item_id, type_id: 10001, quantity: 1, is_singleton: true, location_id: 60000001, location_type: 'station', location_flag: 'Hangar', name: marker, ...extra });
const pagination = (page, pages) => ({ kind: 'page', page, pages, nextPage: pages !== null && page < pages && page < 500 ? page + 1 : null, pageLimit: 500, morePagesAvailable: pages === null ? null : page < pages, pageLimitReached: page === 500 && pages !== page, after: null, before: null });
const envelope = (args, data, pages = 1, extra = {}) => ({ characterId: args.characterId, entity: 'corporation', corporationId, dataset: args.dataset, data,
  retrievedAt: stamp, cacheExpires: 'Thu, 01 Jan 2026 01:00:00 GMT', responseDate: 'Thu, 01 Jan 2026 00:00:00 GMT', cacheControl: 'private, max-age=3600', cacheAge: '0', lastModified: args.dataset === 'blueprints' ? 'Wed, 31 Dec 2025 23:00:00 GMT' : 'Wed, 31 Dec 2025 23:30:00 GMT',
  pagination: pagination(args.parameters.page, pages), source: marker, ...extra });
const catalogItem = id => id === 10001 || id === 10002 || id === 10003 ? { typeId: id, name: `Synthetic blueprint ${id}`, categoryId: 9, categoryName: 'Blueprint', groupId: id === 10003 ? 1888 : 100, groupName: 'Synthetic', manufacturingBlueprintTypeIds: [] } : id === 20001 ? { typeId: id, name: 'Blueprint-looking non-blueprint', categoryId: 6, categoryName: 'Ship', groupId: 25, groupName: 'Frigate', manufacturingBlueprintTypeIds: [10001] } : null;
function harness(options = {}) {
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  let clock = epoch, active = 0, maxActive = 0; const calls = [], timeout = new AbortController();
  const deps = {
    connections: async user => { calls.push({ op: 'connections', user }); return options.connections ? options.connections({ advance: ms => clock += ms, timeout }) : [{ characterId, scopes: options.scopes ?? [bpScope, assetScope] }]; },
    corporation: async (user, args, signal) => { calls.push({ op: args.dataset, user, args, signal }); active++; maxActive = Math.max(active, maxActive);
      try { return options.read ? await options.read(args, { EveError, advance: ms => clock += ms, timeout, signal }) : envelope(args, args.dataset === 'blueprints' ? [bp()] : [asset(), asset(70000002, { type_id: 10002 })]); } finally { active--; }
    }, now: options.now ?? (() => clock),
  };
  const eve = { EveError, listConnections: deps.connections, readCorporationData: deps.corporation, readCharacterData: () => { throw Error('Unexpected character read'); }, readEve: () => { throw Error('Unexpected legacy read'); } };
  const modules = {}, signal = { any: AbortSignal.any.bind(AbortSignal), timeout: ms => { assert.equal(ms, 55000); return timeout.signal; } };
  for (const name of Object.keys(compiled)) {
    const mod = { exports: {} }; modules[name] = mod;
    vm.runInNewContext(compiled[name], { module: mod, exports: mod.exports, Date, AbortSignal: signal, require: name => name === './eve' ? eve : name === './manufacturing-catalog' ? { findPublishedManufacturingItem: options.item ?? catalogItem } : modules[name.replace('./', '')].exports });
  }
  return { read: modules['blueprint-reconciliation'].exports.createBlueprintReconciliationReader(deps), validate: modules['blueprint-reconciliation'].exports.validateBlueprintReconciliationArgs, calls, timeout, maxActive: () => maxActive };
}
const get = (h, options, input = { characterId }) => h.read('synthetic-owner', input, options);
const reads = h => h.calls.filter(value => value.op !== 'connections').map(value => `${value.op}:${value.args.parameters.page}`);
function invariants(value) {
  const s = value.summary, b = value.blueprints, a = value.assets, c = a.coverage;
  assert.equal(value.generatedAt, b.generatedAt); assert.equal(s.blueprintRecords, b.blueprints.length); assert.equal(s.assetOnlyRecords, value.assetsOnly.length);
  assert.equal(s.unionRecords, s.blueprintRecords + s.assetOnlyRecords); assert(s.unionRecords <= 50000);
  assert.equal(s.matchedRecords, value.relationships.filter(row => row.status === 'matched').length); assert.equal(s.conflictingRecords, value.relationships.filter(row => row.status === 'conflict').length);
  assert.equal(s.blueprintOnlyRecords, s.blueprintRecords - s.matchedRecords - s.conflictingRecords);
  assert.equal(s.assetBlueprintRecords, s.matchedRecords + s.conflictingRecords + s.assetOnlyRecords);
  assert.equal(c.uniqueRecords, s.assetBlueprintRecords + s.nonBlueprintAssetRecords + s.unclassifiedAssetRecords);
  assert.equal(c.rowsReceived, c.uniqueRecords + c.duplicateRecords); assert(c.rowsReceived <= c.pagesRead * 1000 && c.pagesRead <= 50 && c.rowsReceived <= 50000);
  assert.deepEqual(plain(c.completedPages), Array.from({ length: c.pagesRead }, (_, i) => i + 1));
  assert.deepEqual(plain(value.assetsOnly.map(row => row.row)), Array.from({ length: s.assetOnlyRecords }, (_, i) => i + 1));
  assert.equal(new Set(value.relationships.map(row => row.row)).size, value.relationships.length);
  assert(value.relationships.every(row => row.row >= 1 && row.row <= s.blueprintRecords));
  assert.equal(value.typeCounts.reduce((sum, row) => sum + row.records, 0), s.unionRecords);
  assert.equal(value.typeCounts.reduce((sum, row) => sum + row.blueprintRecords, 0), s.blueprintRecords);
  assert.equal(value.typeCounts.reduce((sum, row) => sum + row.assetOnlyRecords, 0), s.assetOnlyRecords);
  assert.equal(value.kindCounts.reduce((sum, row) => sum + row.count, 0), s.assetOnlyRecords);
  if (c.kind === 'all_reported_pages') { assert.equal(c.pagesRead, c.pagesExpected); assert.equal(c.consistency, 'consistent'); assert.equal(c.stopReason, 'complete'); assert.equal(c.failedPage, null); }
  if (value.status === 'ready') { assert.equal(b.status, 'ready'); assert.equal(a.status, 'ready'); assert.equal(s.conflictingRecords + s.unclassifiedAssetRecords, 0); }
  const json = JSON.stringify(value); for (const forbidden of [marker, 'item_id', 'location_id', 'location_flag', '70000001', '60000001']) assert(!json.includes(forbidden), forbidden);
  for (const row of value.assetsOnly) for (const forbidden of ['materialEfficiency', 'timeEfficiency', 'copyRuns', 'runs', 'units', 'itemId', 'locationId']) assert(!Object.hasOwn(row, forbidden));
}

test('only an owned character and signed-in caller can reconcile; input cannot request scopes or arbitrary reads', async () => {
  for (const args of [null, [], {}, { characterId: 0 }, { characterId: '90000001' }, { characterId, corporationId }, { characterId, page: 2 }, { characterId, assets: true }, { characterId, [Symbol('extra')]: true }]) { const h = harness(); await assert.rejects(get(h, undefined, args), error => error.status === 400); assert.equal(h.calls.length, 0); }
  for (const user of ['', null, 123]) { const h = harness(); await assert.rejects(h.read(user, { characterId }), error => error.status === 401); assert.equal(h.calls.length, 0); }
  const h = harness({ connections: async () => [{ characterId: characterId + 1, scopes: [bpScope, assetScope] }] }); await assert.rejects(get(h), error => error.status === 404); assert.deepEqual(reads(h), []);
});
test('sequential union preserves blueprint-only rows and supplements asset-only records without invented research', async () => {
  const h = harness({ read: args => envelope(args, args.dataset === 'blueprints' ? [bp(), bp(70000003, { type_id: 10003 })] : [asset(), asset(70000002, { type_id: 10002, is_blueprint_copy: true })]) }), events = [], result = await get(h, { onProgress: value => events.push(plain(value)) }); invariants(result);
  assert.equal(result.status, 'ready'); assert.deepEqual(reads(h), ['blueprints:1', 'assets:1']); assert.equal(h.maxActive(), 1); assert.equal(h.calls.filter(x => x.op === 'connections').length, 1);
  assert.deepEqual(plain(result.summary), { blueprintRecords: 2, assetBlueprintRecords: 2, matchedRecords: 1, conflictingRecords: 0, blueprintOnlyRecords: 1, assetOnlyRecords: 1, unclassifiedAssetRecords: 0, nonBlueprintAssetRecords: 0, unionRecords: 3 });
  assert.deepEqual(events.map(x => x.phase), ['blueprints', 'blueprints', 'assets', 'assets']); assert.equal(result.assetsOnly[0].copyStatus, 'copy');
  assert.notEqual(result.blueprints.freshness.lastModified, result.assets.freshness.lastModified);
});
test('classification uses category 9 including reaction formula without recipe; names and reverse product recipes do not qualify', async () => {
  const h = harness({ read: args => envelope(args, args.dataset === 'blueprints' ? [] : [asset(70000002, { type_id: 10003 }), asset(70000003, { type_id: 20001 }), asset(70000004, { type_id: 99999, is_blueprint_copy: true }), asset(70000005, { type_id: 20001, is_blueprint_copy: true })]) }), result = await get(h); invariants(result);
  assert.equal(result.assetsOnly.length, 1); assert.equal(result.assetsOnly[0].typeId, 10003); assert.equal(result.summary.nonBlueprintAssetRecords, 1); assert.equal(result.summary.unclassifiedAssetRecords, 2); assert.equal(result.status, 'partial');
});
test('asset-only copy flags true, false and absent retain exact uncertainty and physical quantities', async () => {
  const h = harness({ read: args => envelope(args, args.dataset === 'blueprints' ? [] : [asset(70000002, { is_blueprint_copy: true }), asset(70000003, { is_blueprint_copy: false, quantity: 4, is_singleton: false }), asset(70000004)]) }), result = await get(h); invariants(result);
  assert.deepEqual(plain(result.assetsOnly.map(x => [x.copyStatus, x.quantity, x.isSingleton])), [['copy', 1, true], ['not_copy', 4, false], ['unknown', 1, true]]); assert.equal(result.kindCounts.every(x => x.count === 1), true);
});
test('matched unknown catalog types retain blueprint endpoint evidence without fabricating an asset-only type', async () => {
  const h = harness({ read: args => envelope(args, args.dataset === 'blueprints' ? [bp(70000001, { type_id: 99999 })] : [asset(70000001, { type_id: 99999 })]) }), result = await get(h); invariants(result);
  assert.equal(result.summary.matchedRecords, 1); assert.equal(result.summary.unclassifiedAssetRecords, 0); assert.equal(result.summary.assetOnlyRecords, 0); assert.equal(result.blueprints.blueprints[0].catalogMapped, false); assert.equal(result.status, 'partial');
});
test('cross-source type, copy flag, singleton or physical quantity mismatches are explicit and never replace blueprint evidence', async () => {
  for (const extra of [{ type_id: 10002 }, { type_id: 20001 }, { is_blueprint_copy: true }, { quantity: 2 }, { is_singleton: false }]) {
    const h = harness({ read: args => envelope(args, args.dataset === 'blueprints' ? [bp()] : [asset(70000001, extra)]) }), result = await get(h); invariants(result);
    assert.equal(result.summary.conflictingRecords, 1); assert.equal(result.summary.assetOnlyRecords, 0); assert.equal(result.summary.unionRecords, 1); assert.equal(result.typeCounts[0].typeId, 10001); assert.equal(result.blueprints.blueprints[0].materialEfficiency, 10); assert.equal(result.status, 'partial');
  }
});
test('matching originals, copies and original stacks compare physical quantities, not blueprint sentinel values', async () => {
  const h = harness({ read: args => envelope(args, args.dataset === 'blueprints' ? [bp(), bp(70000002, { quantity: -2, runs: 3 }), bp(70000003, { quantity: 4 })] : [asset(70000001, { is_blueprint_copy: false }), asset(70000002, { is_blueprint_copy: true }), asset(70000003, { quantity: 4, is_singleton: false })]) }), result = await get(h); invariants(result);
  assert.equal(result.summary.matchedRecords, 3); assert.equal(result.summary.conflictingRecords, 0);
});
test('compatible matches do not claim cross-source location consistency or trigger location queries', async () => {
  const h = harness({ read: args => envelope(args, args.dataset === 'blueprints' ? [bp()] : [asset(70000001, { location_id: 60000002, location_flag: 'CorpSAG1', location_type: 'item' })]) }), result = await get(h); invariants(result);
  assert.equal(result.summary.matchedRecords, 1); assert.deepEqual(reads(h), ['blueprints:1', 'assets:1']); assert(result.limitations.some(value => value.includes('locations are not compared')));
});
test('identical duplicate asset IDs count once across and within accepted pages with consistency warning', async () => {
  const h = harness({ read: args => args.dataset === 'blueprints' ? envelope(args, [bp()]) : envelope(args, args.parameters.page === 1 ? [asset(), asset(), asset(70000002)] : [asset(70000002), asset(70000003)], 2) }), result = await get(h); invariants(result);
  assert.equal(result.assets.coverage.rowsReceived, 5); assert.equal(result.assets.coverage.uniqueRecords, 3); assert.equal(result.assets.coverage.duplicateRecords, 2); assert.equal(result.assets.coverage.consistency, 'inconsistent'); assert.equal(result.assets.coverage.kind, 'partial'); assert.equal(result.relationships.length, 1);
});
test('conflicting duplicate asset page is rejected transactionally, including changes to private location fields', async () => {
  for (const extra of [{ type_id: 10002 }, { quantity: 5 }, { location_id: 60000002 }, { location_flag: 'CorpSAG1' }, { is_blueprint_copy: false }]) {
    const h = harness({ read: args => args.dataset === 'blueprints' ? envelope(args, [bp()]) : envelope(args, args.parameters.page === 1 ? [asset()] : [asset(70000003), asset(70000001, extra)], 3) }), result = await get(h); invariants(result);
    assert.equal(result.assets.coverage.stopReason, 'conflicting_duplicate'); assert.equal(result.assets.coverage.pagesRead, 1); assert.equal(result.assets.coverage.failedPage, 2); assert.equal(result.assetsOnly.length, 0); assert.deepEqual(reads(h), ['blueprints:1', 'assets:1', 'assets:2']);
  }
});
test('malformed asset pages reject entirely and cannot produce plausible zero totals', async () => {
  for (const change of [{ quantity: -1 }, { item_id: 0 }, { type_id: 0 }, { is_singleton: 'true' }, { is_blueprint_copy: null }, { location_type: 'moon' }, { location_flag: '' }]) {
    const h = harness({ read: args => envelope(args, args.dataset === 'blueprints' ? [bp()] : [asset(70000002), asset(70000003, change)]) }), result = await get(h); invariants(result);
    assert.equal(result.assets.coverage.pagesRead, 0); assert.equal(result.assets.coverage.stopReason, 'invalid_page'); assert.equal(result.assets.status, 'error'); assert.equal(result.summary.assetOnlyRecords, 0); assert.equal(result.summary.blueprintOnlyRecords, 1);
  }
});
test('wrong selected character, dataset, entity and corporation envelopes fail without accepting an asset page', async () => {
  for (const extra of [{ characterId: characterId + 1 }, { dataset: 'orders' }, { entity: 'character' }, { corporationId: corporationId + 1 }, { division: 1 }]) {
    const h = harness({ read: args => envelope(args, args.dataset === 'blueprints' ? [bp()] : [asset()], 1, args.dataset === 'assets' ? extra : {}) }), result = await get(h); invariants(result); assert.equal(result.assets.coverage.pagesRead, 0); assert.equal(result.assetsOnly.length, 0);
  }
});
test('assets-only access remains useful when blueprint grant is absent, with source coverage visible', async () => {
  const h = harness({ scopes: [assetScope] }), result = await get(h); invariants(result);
  assert.deepEqual(reads(h), ['assets:1']); assert.equal(result.blueprints.status, 'needs_permission'); assert.equal(result.summary.assetOnlyRecords, 2); assert.equal(result.corporationId, corporationId); assert.equal(result.status, 'partial');
});
test('missing asset grant preserves accepted blueprints and does not try another permission', async () => {
  const h = harness({ scopes: [bpScope] }), result = await get(h); invariants(result);
  assert.deepEqual(reads(h), ['blueprints:1']); assert.equal(result.assets.status, 'needs_permission'); assert.equal(result.summary.blueprintOnlyRecords, 1); assert.equal(result.status, 'partial');
  const none = harness({ scopes: [] }), empty = await get(none); invariants(empty); assert.deepEqual(reads(none), []); assert.equal(empty.status, 'needs_permission');
});
test('connection lookup failure issues no private reads and emits no upstream message', async () => {
  const h = harness({ connections: () => { throw Error(marker); } }), result = await get(h); invariants(result); assert.equal(result.status, 'unavailable'); assert.deepEqual(reads(h), []);
});
test('blueprint failures, denied reads and inconsistent source stop before assets without retry', async () => {
  for (const code of [401, 403, 404, 409, 429, 500]) {
    const h = harness({ read: (args, { EveError }) => { throw new EveError(marker, code); } }), result = await get(h); invariants(result); assert.deepEqual(reads(h), ['blueprints:1']); assert.equal(result.assets.coverage.stopReason, 'not_started');
  }
  const h = harness({ read: args => envelope(args, [bp(70000000 + args.parameters.page)], 3, args.parameters.page === 2 ? { corporationId: corporationId + 1 } : {}) }), result = await get(h); invariants(result); assert.deepEqual(reads(h), ['blueprints:1', 'blueprints:2']); assert.equal(result.assets.coverage.stopReason, 'not_started');
});
test('asset permission errors and rate limits retain blueprint evidence and make no further request', async () => {
  for (const code of [401, 403, 404, 409, 429, 500]) {
    const h = harness({ read: (args, { EveError }) => { if (args.dataset === 'assets') throw new EveError(marker, code); return envelope(args, [bp()]); } }), result = await get(h); invariants(result);
    assert.deepEqual(reads(h), ['blueprints:1', 'assets:1']); assert.equal(result.summary.blueprintOnlyRecords, 1); assert.equal(result.assets.coverage.failedPage, 1); assert.equal(result.assets.coverage.stopReason, 'provider_error');
  }
});
test('asset page counts and Last-Modified must stay internally stable, with changes excluded', async () => {
  for (const changed of ['pages', 'snapshot']) {
    const h = harness({ read: args => args.dataset === 'blueprints' ? envelope(args, [bp()]) : envelope(args, [asset(70000001 + args.parameters.page)], changed === 'pages' && args.parameters.page === 2 ? 4 : 3, changed === 'snapshot' && args.parameters.page === 2 ? { lastModified: 'Wed, 31 Dec 2025 23:40:00 GMT' } : {}) }), result = await get(h); invariants(result);
    assert.equal(result.assets.coverage.pagesRead, 1); assert.equal(result.assets.coverage.failedPage, 2); assert.equal(result.assets.coverage.stopReason, changed === 'pages' ? 'pagination_changed' : 'snapshot_changed'); assert.equal(result.assets.coverage.consistency, 'inconsistent'); assert.equal(result.assetsOnly.length, 1);
  }
});
test('unknown page count stops after one accepted asset page instead of guessing', async () => {
  const h = harness({ read: args => envelope(args, args.dataset === 'blueprints' ? [bp()] : [asset(70000002)], args.dataset === 'assets' ? null : 1) }), result = await get(h); invariants(result);
  assert.deepEqual(reads(h), ['blueprints:1', 'assets:1']); assert.equal(result.assets.coverage.kind, 'unknown'); assert.equal(result.assets.coverage.stopReason, 'missing_page_count');
});
test('missing snapshot timestamps make coverage unknown despite complete advertised pages', async () => {
  const h = harness({ read: args => envelope(args, args.dataset === 'blueprints' ? [bp()] : [asset(70000002)], 1, args.dataset === 'assets' ? { lastModified: null } : {}) }), result = await get(h); invariants(result);
  assert.equal(result.assets.coverage.kind, 'unknown'); assert.equal(result.assets.coverage.consistency, 'unknown'); assert.equal(result.assets.status, 'partial');
});
test('the asset feed stops at 50 pages, retaining explicit partial coverage', async () => {
  const h = harness({ read: args => envelope(args, args.dataset === 'blueprints' ? [] : [asset(70000000 + args.parameters.page)], args.dataset === 'assets' ? 51 : 1) }), result = await get(h); invariants(result);
  assert.equal(result.assets.coverage.pagesRead, 50); assert.equal(result.assets.coverage.stopReason, 'page_limit'); assert.equal(result.assetsOnly.length, 50); assert.equal(reads(h).length, 51);
});
test('union budget excludes an entire asset page above 50000 and never clips accepted blueprints', async () => {
  const h = harness({ read: args => args.dataset === 'blueprints' ? envelope(args, Array.from({ length: 1000 }, (_, i) => bp(71000000 + (args.parameters.page - 1) * 1000 + i)), 50) : envelope(args, [asset(72000001)], 1) }), result = await get(h); invariants(result);
  assert.equal(result.summary.blueprintRecords, 50000); assert.equal(result.assets.coverage.stopReason, 'result_limit'); assert.equal(result.assets.coverage.pagesRead, 0); assert.equal(result.assets.coverage.failedPage, 1); assert.equal(result.assetsOnly.length, 0); assert.equal(result.blueprints.coverage.providerCeilingPossible, true);
});
test('asset raw-row budget includes nonblueprint noise, with no unbounded scans', async () => {
  const h = harness({ read: args => args.dataset === 'blueprints' ? envelope(args, []) : envelope(args, Array.from({ length: 1000 }, (_, i) => asset(71000000 + (args.parameters.page - 1) * 1000 + i, { type_id: 20001 })), 51) }), result = await get(h); invariants(result);
  assert.equal(result.assets.coverage.rowsReceived, 50000); assert.equal(result.summary.nonBlueprintAssetRecords, 50000); assert.equal(result.assets.coverage.stopReason, 'page_limit'); assert.equal(result.summary.unionRecords, 0);
});
test('more than 1000 raw asset rows is rejected even if duplicate deduplication would be small', async () => {
  const h = harness({ read: args => envelope(args, args.dataset === 'blueprints' ? [bp()] : Array.from({ length: 1001 }, () => asset())) }), result = await get(h); invariants(result); assert.equal(result.assets.coverage.stopReason, 'invalid_page'); assert.equal(result.assets.coverage.pagesRead, 0);
});
test('cancellation after accepted asset page prevents later requests while keeping explicit partial evidence', async () => {
  const cancel = new AbortController(), h = harness({ read: args => envelope(args, args.dataset === 'blueprints' ? [bp()] : [asset(70000001 + args.parameters.page)], args.dataset === 'assets' ? 3 : 1) });
  const result = await get(h, { signal: cancel.signal, onProgress: value => { if (value.phase === 'assets' && value.assets.pagesRead === 1) cancel.abort(); } }); invariants(result);
  assert.deepEqual(reads(h), ['blueprints:1', 'assets:1']); assert.equal(result.assets.coverage.stopReason, 'cancelled'); assert.equal(result.assets.coverage.pagesRead, 1);
});
test('abort during a provider that ignores cancellation settles without awaiting that provider', async () => {
  const cancel = new AbortController(), h = harness({ read: (args) => { if (args.dataset === 'blueprints') return envelope(args, [bp()]); cancel.abort(); return new Promise(() => {}); } });
  const result = await get(h, { signal: cancel.signal }); invariants(result); assert.equal(result.assets.coverage.stopReason, 'cancelled'); assert.equal(result.assets.coverage.pagesRead, 0); assert.equal(result.assets.status, 'unavailable');
});
test('the shared wall-clock deadline includes connection lookup and prevents nested blueprint reads after it', async () => {
  const h = harness({ connections: ({ advance }) => { advance(55000); return [{ characterId, scopes: [bpScope, assetScope] }]; } }), result = await get(h); invariants(result);
  assert.deepEqual(reads(h), []); assert.equal(result.blueprints.coverage.stopReason, 'deadline'); assert.equal(result.assets.coverage.stopReason, 'deadline'); assert.equal(result.status, 'unavailable');
});
test('time spent in blueprint reads reduces the asset budget; late asset pages are excluded atomically', async () => {
  const h = harness({ read: (args, { advance }) => { advance(args.dataset === 'blueprints' ? 40000 : 16000); return envelope(args, args.dataset === 'blueprints' ? [bp()] : [asset(70000002)]); } }), result = await get(h); invariants(result);
  assert.equal(result.blueprints.coverage.pagesRead, 1); assert.equal(result.assets.coverage.pagesRead, 0); assert.equal(result.assets.coverage.stopReason, 'deadline'); assert.equal(result.assetsOnly.length, 0);
});
test('known blueprint expiry becomes stale during assets even when another blueprint page had unknown expiry', async () => {
  const h = harness({ read: (args, { advance }) => {
    if (args.dataset === 'assets') { advance(20000); return envelope(args, [asset(70000004)]); }
    return envelope(args, [bp(70000000 + args.parameters.page)], 2, args.parameters.page === 1 ? { cacheExpires: 'Thu, 01 Jan 2026 00:00:10 GMT', cacheControl: null, responseDate: null } : { cacheExpires: null, cacheControl: null, responseDate: null });
  } }), result = await get(h); invariants(result);
  assert.equal(result.blueprints.freshness.state, 'stale'); assert.equal(result.blueprints.freshness.cacheExpires, '2026-01-01T00:00:10.000Z'); assert.equal(result.status, 'partial');
});
test('final asset freshness uses the earliest known expiry even alongside unknown source metadata', async () => {
  const h = harness({ read: (args, { advance }) => {
    if (args.dataset === 'blueprints') return envelope(args, [bp()]);
    if (args.parameters.page === 2) advance(20000);
    return envelope(args, [asset(70000001 + args.parameters.page)], 2, args.parameters.page === 1 ? { cacheExpires: 'Thu, 01 Jan 2026 00:00:10 GMT', cacheControl: null, responseDate: null } : { cacheExpires: null, cacheControl: null, responseDate: null });
  } }), result = await get(h); invariants(result); assert.equal(result.assets.freshness.state, 'stale'); assert.equal(result.assets.status, 'partial');
});
test('empty accepted responses establish empty returned feeds without inventing global holdings', async () => {
  const h = harness({ read: args => envelope(args, []) }), result = await get(h); invariants(result); assert.equal(result.status, 'ready'); assert.equal(result.summary.unionRecords, 0); assert.equal(result.assets.coverage.pagesRead, 1); assert.match(result.message, /complete owned-library coverage is not established/);
});
test('no-asset-permission early finalization preserves partial coverage after time expires', async () => {
  let advance;
  const h = harness({ scopes: [bpScope], read: (args, context) => { advance = context.advance; return envelope(args, [bp()]); } });
  const result = await get(h, { onProgress: value => { if (value.phase === 'blueprints' && value.blueprints.pagesRead) advance(55000); } }); invariants(result);
  assert.equal(result.assets.status, 'needs_permission'); assert.equal(result.assets.coverage.stopReason, 'deadline'); assert.equal(result.status, 'partial'); assert.deepEqual(reads(h), ['blueprints:1']);
});
test('inconsistent duplicate assets remain partial, not unknown, when page count is absent and time expires', async () => {
  let advance;
  const h = harness({ read: (args, context) => { advance = context.advance; return envelope(args, args.dataset === 'blueprints' ? [bp()] : [asset(70000002), asset(70000002)], args.dataset === 'assets' ? null : 1); } });
  const result = await get(h, { onProgress: value => { if (value.phase === 'assets' && value.assets.pagesRead) advance(55000); } }); invariants(result);
  assert.equal(result.assets.coverage.consistency, 'inconsistent'); assert.equal(result.assets.coverage.kind, 'partial'); assert.equal(result.assets.coverage.stopReason, 'deadline'); assert.equal(result.status, 'partial');
});
