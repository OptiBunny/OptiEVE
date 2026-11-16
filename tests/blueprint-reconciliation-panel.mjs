import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { z } from 'zod';

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


const clientModules = new Map();
function client(name) {
  if (clientModules.has(name)) return clientModules.get(name).exports;
  const module = { exports: {} }; clientModules.set(name, module);
  vm.runInNewContext(compile(name), { module, exports: module.exports, Date, AbortController, TextDecoder, TextEncoder, setTimeout, clearTimeout, require: spec => spec === 'zod' ? { z } : client(spec.slice(2)) });
  return module.exports;
}
const compileUi = file => ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const operation = { exports: {} }, charts = { exports: {} }, panel = { exports: {} };
vm.runInNewContext(compileUi('app/operations-charts.tsx'), { module: operation, exports: operation.exports, require: spec => spec === 'react' ? React : jsxRuntime });
vm.runInNewContext(compileUi('app/analytics-charts.tsx'), { module: charts, exports: charts.exports, require: spec => spec === 'react' ? React : spec === 'react/jsx-runtime' ? jsxRuntime : {} });
vm.runInNewContext(compileUi('app/blueprint-reconciliation-panel.tsx'), { module: panel, exports: panel.exports, require: spec => spec === 'react' ? React : spec === 'react/jsx-runtime' ? jsxRuntime : spec === './operations-charts' ? operation.exports : charts.exports });
async function render(options) {
  const h = harness(options), result = client('blueprint-reconciliation-client').blueprintReconciliationResponse(await get(h), { characterId });
  const html = renderToStaticMarkup(React.createElement(panel.exports.default, { result }));
  return { result, html, overlap: html.slice(html.indexOf('<h3>Source overlap'), html.indexOf('<h3>Research metadata coverage')), reads: h.calls.filter(row => row.op !== 'connections').map(row => row.op) };
}

test('blueprint-only evidence stays visible without a false zero-overlap chart', async () => {
  const { result, html, overlap, reads } = await render({ scopes: [bpScope] });
  assert.deepEqual(reads, ['blueprints']); assert.equal(result.blueprints.coverage.pagesRead, 1); assert.equal(result.assets.coverage.pagesRead, 0);
  assert.match(html, /Accepted blueprint endpoint records<\/dt><dd>1<\/dd>/); assert.doesNotMatch(html, /Assets-only accepted records|Unknown for assets-only records|Top 12 assets-only|Blueprints found across both sources|Reconciled accepted records/); assert.match(html, /Unknown — not read/); assert.match(html, /Not compared/); assert.match(html, /Research metadata coverage/);
  assert.match(overlap, /Source overlap is unknown/); assert.doesNotMatch(overlap, /<svg|<table|[0-9]\.[0-9]%/);
});

test('asset-only evidence keeps known records and unknown research without asserting exclusivity', async () => {
  const { result, html, overlap, reads } = await render({ scopes: [assetScope] });
  assert.deepEqual(reads, ['assets']); assert.equal(result.blueprints.coverage.pagesRead, 0); assert.equal(result.assets.coverage.pagesRead, 1);
  assert.match(html, /Accepted asset blueprint records<\/dt><dd>2<\/dd>/); assert.doesNotMatch(html, /Assets-only|assets-only|Additional blueprint|additional blueprint|Reported by blueprint endpoint|Blueprints found across both sources|Reconciled accepted records/); assert.match(html, /Accepted asset blueprint types/); assert.match(html, /Accepted asset copy flags/); assert.match(html, /Accepted assets<\/th>/); assert.match(html, /Synthetic blueprint 10002/); assert.match(html, /Unknown — not read/);
  assert.match(overlap, /Source overlap is unknown/); assert.doesNotMatch(overlap, /<svg|<table|[0-9]\.[0-9]%/);
});

test('no accepted source pages remain unavailable with no inferred charts or holdings', async () => {
  const { result, html, reads } = await render({ scopes: [] }); assert.deepEqual(reads, []); assert.equal(result.summary.unionRecords, 0);
  assert.match(html, /No source pages were accepted/); assert.match(html, /holdings and additional-item counts are unknown/); assert.doesNotMatch(html, /<svg|<table|Source overlap/);
});

test('two accepted empty feeds preserve measured zero returned records', async () => {
  const { result, overlap, reads } = await render({ read: args => envelope(args, []) }); assert.deepEqual(reads, ['blueprints', 'assets']);
  assert.equal(result.blueprints.coverage.pagesRead, 1); assert.equal(result.assets.coverage.pagesRead, 1); assert.equal(result.summary.unionRecords, 0);
  assert.doesNotMatch(overlap, /Source overlap is unknown/); assert.match(overlap, /No records returned in this response/); assert.match(overlap, /Matched without field conflicts<\/th><td>0<\/td>/);
  assert.match(overlap, /Overlap compares accepted records only/);
});

test('paired partial feeds compare accepted records while preserving incomplete-coverage caveats', async () => {
  const { result, overlap } = await render({ read: args => envelope(args, args.dataset === 'blueprints' ? [bp()] : [asset(), asset(70000002, { type_id: 10002 })], null) });
  assert.equal(result.status, 'partial'); assert.equal(result.blueprints.coverage.pagesRead, 1); assert.equal(result.assets.coverage.pagesRead, 1); assert.equal(result.summary.unionRecords, 2);
  assert.match(overlap, /Matched without field conflicts<\/th><td>1<\/td><td>50\.0%/); assert.match(overlap, /Assets only<\/th><td>1<\/td><td>50\.0%/);
  assert.match(overlap, /Either source may be partial/); assert.doesNotMatch(overlap, /Source overlap is unknown/);
});


test('one accepted empty feed does not invent zero research coverage for its unread peer', async () => {
  for (const scope of [bpScope, assetScope]) {
    const { html, overlap } = await render({ scopes: [scope], read: args => envelope(args, []) });
    assert.match(overlap, /Source overlap is unknown/); assert.match(html, /No records returned in this response/);
    assert.doesNotMatch(html, /Assets-only|assets-only|Additional blueprint|additional blueprint/);
    if (scope === bpScope) { assert.match(html, /Reported by blueprint endpoint<\/th><td>0<\/td>/); assert.doesNotMatch(html, /Unknown for accepted asset records/); }
    else { assert.match(html, /Unknown for accepted asset records<\/th><td>0<\/td>/); assert.doesNotMatch(html, /Reported by blueprint endpoint/); }
    assert.match(html, /A source with no accepted pages contributes no bucket, not a measured zero/);
  }
});

test('rejected source pages never produce exclusive-source or measured-zero claims', async () => {
  for (const failed of ['blueprints', 'assets']) {
    const { result, html, overlap } = await render({ read: args => envelope(args, args.dataset === failed ? [{}] : args.dataset === 'blueprints' ? [bp()] : [asset()]) });
    assert.equal(result[failed].coverage.pagesRead, 0); if (failed === 'blueprints') { assert.equal(result.assets.coverage.pagesRead, 0); assert.match(html, /No source pages were accepted/); } else assert.match(overlap, /Source overlap is unknown/);
    assert.doesNotMatch(html, /Assets-only accepted records|Top 12 assets-only|Blueprints found across both sources|Reconciled accepted records/);
    if (failed === 'blueprints') assert.doesNotMatch(html, /Assets-only|assets-only|Additional blueprint|additional blueprint|Reported by blueprint endpoint/);
  }
});
