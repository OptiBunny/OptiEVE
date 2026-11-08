import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';

const compile = name => ts.transpileModule(readFileSync(`app/lib/${name}.ts`, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const code = compile('clone-analytics-client'), connectionCode = compile('connection-client');
function harness(fetch = () => { throw Error('Unexpected request'); }, timers = {}) {
  const connection = { exports: {} }, client = { exports: {} };
  vm.runInNewContext(connectionCode, { module: connection, exports: connection.exports });
  vm.runInNewContext(code, { module: client, exports: client.exports, fetch, AbortController, TextDecoder, setTimeout, clearTimeout, ...timers, require: name => name === 'zod' ? { z } : connection.exports });
  return client.exports;
}
const client = harness(), args = { characterId: 90000001 }, stamp = '2026-01-02T00:00:00.000Z', expires = '2026-01-02T01:00:00.000Z';
const plain = value => JSON.parse(JSON.stringify(value));
const implant = (typeId = 1001, mapped = true) => ({ typeId, name: mapped ? `Synthetic implant ${typeId}` : `Type ${typeId}`, mapped });
const section = (data, scope) => ({ data, scope, status: 'ready', message: 'Synthetic source.', retrievedAt: stamp, cacheExpires: expires, freshness: 'fresh' });
const blank = (scope, status = 'needs_permission') => ({ data: null, scope, status, message: 'Synthetic unavailable source.', retrievedAt: null, cacheExpires: null, freshness: 'unknown' });
function fixture() {
  return {
    ...args, generatedAt: stamp, status: 'ready', message: 'Synthetic clone snapshots.',
    clones: section({ homeLocation: { locationId: null, locationType: 'station' }, lastCloneJumpAt: null, lastHomeStationChangeAt: '2026-01-01T00:00:00.000Z', cloneCount: 2, totalStoredImplants: 2, unmappedImplants: 0, clones: [
      { row: 1, locationId: 60000001, locationType: 'station', implants: [implant(), implant()] },
      { row: 2, locationId: 1000000000001, locationType: 'structure', implants: [] },
    ] }, 'esi-clones.read_clones.v1'),
    implants: section({ implantCount: 2, unmappedImplants: 1, implants: [implant(), implant(9999, false)] }, 'esi-clones.read_implants.v1'),
  };
}
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8' } });

test('clone client preserves independent feeds, partial optional home fields and repeated type occurrences', () => {
  const value = fixture(), result = plain(client.cloneAnalyticsResponse(value, args));
  assert.deepEqual(result, value); assert.equal(result.clones.data.totalStoredImplants, 2); assert.equal(result.implants.data.implantCount, 2);
  assert.equal(result.clones.data.clones[0].implants.length, 2); assert.equal(result.clones.data.homeLocation.locationId, null);
  assert.equal(result.implants.data.implants[1].name, 'Type 9999');
});

for (const [label, change] of [
  ['wrong character', value => value.characterId++], ['unexpected root fields', value => value.privateNote = 'OMIT_PRIVATE'],
  ['wrong clone scope', value => value.clones.scope = 'esi-assets.read_assets.v1'], ['raw clone identity', value => value.clones.data.clones[0].jump_clone_id = 70000001],
  ['custom clone name', value => value.clones.data.clones[0].name = 'OMIT_PRIVATE'], ['invalid location kind', value => value.clones.data.clones[0].locationType = 'space'],
  ['invalid location identity', value => value.clones.data.clones[0].locationId = 0], ['extra home field', value => value.clones.data.homeLocation.name = 'OMIT_PRIVATE'],
  ['nonsequential row', value => value.clones.data.clones[1].row = 3], ['duplicate row', value => value.clones.data.clones[1].row = 1],
  ['wrong clone count', value => value.clones.data.cloneCount = 3], ['wrong stored count', value => value.clones.data.totalStoredImplants = 1],
  ['wrong active count', value => value.implants.data.implantCount = 3], ['wrong unknown count', value => value.implants.data.unmappedImplants = 0],
  ['wrong stored unknown count', value => value.clones.data.unmappedImplants = 1], ['unknown label invention', value => value.implants.data.implants[1].name = 'Invented implant'],
  ['catalog mismatch across feeds', value => value.clones.data.clones[0].implants[0].name = 'Other catalog label'], ['invalid type ID', value => value.implants.data.implants[0].typeId = 1.5],
  ['control label', value => value.implants.data.implants[0].name = 'bad\nlabel'], ['bidi label', value => value.implants.data.implants[0].name = 'bad\u202elabel'],
  ['private implant fields', value => value.implants.data.implants[0].owner = 90009999], ['oversized implant list', value => value.implants.data.implants = Array.from({ length: 65 }, () => implant())],
  ['oversized clone list', value => value.clones.data.clones = Array.from({ length: 101 }, (_, i) => ({ row: i + 1, locationId: 60000001, locationType: 'station', implants: [] }))],
  ['invalid generated date', value => value.generatedAt = '2026-02-30T00:00:00.000Z'], ['unnormalized date', value => value.generatedAt = '2026-01-02T00:00:00Z'],
  ['future retrieval', value => value.clones.retrievedAt = '2026-01-02T00:02:00.000Z'], ['future reported jump', value => value.clones.data.lastCloneJumpAt = '2026-01-03T00:00:00.000Z'],
  ['invalid reported station date', value => value.clones.data.lastHomeStationChangeAt = '2026-01-01T24:00:00.000Z'],
  ['ready missing data', value => value.clones.data = null], ['error with data', value => value.clones.status = 'error'], ['invalid freshness', value => value.clones.freshness = 'stale'],
  ['wrong aggregate status', value => value.status = 'partial'], ['missing required optional slot', value => delete value.clones.data.homeLocation],
]) test(`clone client rejects ${label}`, () => {
  const value = fixture(); change(value); assert.throws(() => client.cloneAnalyticsResponse(value, args), /incomplete response/);
});

test('empty successful sources differ from missing permission, errors and unknown freshness', () => {
  const value = fixture(); Object.assign(value.clones.data, { cloneCount: 0, totalStoredImplants: 0, clones: [], homeLocation: null }); Object.assign(value.implants.data, { implantCount: 0, unmappedImplants: 0, implants: [] });
  assert.equal(client.cloneAnalyticsResponse(value, args).status, 'ready');
  value.clones = blank('esi-clones.read_clones.v1'); value.status = 'partial'; assert.equal(client.cloneAnalyticsResponse(value, args).clones.data, null);
  value.implants = blank('esi-clones.read_implants.v1'); value.status = 'needs_permission'; assert.equal(client.cloneAnalyticsResponse(value, args).status, 'needs_permission');
  value.implants.status = 'error'; value.status = 'error'; assert.equal(client.cloneAnalyticsResponse(value, args).status, 'error');
  value.implants.status = 'unavailable'; value.status = 'unavailable'; assert.equal(client.cloneAnalyticsResponse(value, args).status, 'unavailable');
});

test('data freshness is checked at response completion while sources remain independent', () => {
  for (const expiry of [null, stamp]) {
    const value = fixture(); Object.assign(value.clones, { cacheExpires: expiry, freshness: expiry === null ? 'unknown' : 'stale', status: 'partial' }); value.status = 'partial';
    const result = client.cloneAnalyticsResponse(value, args); assert.equal(result.implants.freshness, 'fresh'); assert.equal(result.clones.freshness, expiry === null ? 'unknown' : 'stale');
  }
  const value = fixture(); value.clones = blank('esi-clones.read_clones.v1'); value.clones.retrievedAt = stamp; value.status = 'partial';
  assert.throws(() => client.cloneAnalyticsResponse(value, args), /incomplete response/);
});

test('invalid selections fail before a network request', async () => {
  let calls = 0; const h = harness(() => { calls++; });
  for (const value of [null, {}, { characterId: 0 }, { characterId: 1.5 }, { ...args, corporationId: 98000001 }, { ...args, page: 2 }, Object.create(args)]) await assert.rejects(h.fetchCloneAnalytics(value), /Choose one/);
  assert.equal(calls, 0);
});

test('request is same-origin, no-store, redirect-rejecting and bound to a captured selection', async () => {
  const input = { ...args }, calls = [];
  const h = harness(async (url, options) => { calls.push({ url, options }); input.characterId++; return response(fixture()); });
  const value = await h.fetchCloneAnalytics(input); assert.equal(value.characterId, args.characterId);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/eve/clone-analytics');
  assert.equal(calls[0].options.method, 'POST'); assert.equal(calls[0].options.credentials, 'same-origin'); assert.equal(calls[0].options.cache, 'no-store'); assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].options.body), args);
});

test('HTTP failures and malformed responses expose only bounded safe errors', async () => {
  for (const status of [400, 401, 403, 404, 409, 413, 429, 500, 502, 504]) await assert.rejects(harness(async () => new Response('OMIT_PRIVATE', { status })).fetchCloneAnalytics(args), error => error.status === status && !error.message.includes('OMIT_PRIVATE'));
  for (const r of [new Response('OMIT_PRIVATE', { headers: { 'content-type': 'application/json' } }), new Response('{}', { headers: { 'content-type': 'text/html' } }), new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'content-type': 'application/json' } }), { ok: true, headers: new Headers({ 'content-type': 'application/json' }), body: null }]) await assert.rejects(harness(async () => r).fetchCloneAnalytics(args), error => !error.message.includes('OMIT_PRIVATE'));
});

test('JSON response has a hard byte bound and oversized streams are cancelled', async () => {
  let cancelled = 0, released = 0, reads = 0;
  const r = { ok: true, headers: new Headers({ 'content-type': 'application/json' }), body: { getReader: () => ({ read: async () => { reads++; return { done: false, value: new Uint8Array(16 * 1024 * 1024 + 1) }; }, cancel: async () => { cancelled++; }, releaseLock: () => { released++; } }) } };
  await assert.rejects(harness(async () => r).fetchCloneAnalytics(args), /incomplete response/); assert.equal(reads, 1); assert.equal(cancelled, 1); assert.equal(released, 1);
});

test('UTF8 may be split across chunks without corrupting permitted public labels', async () => {
  const value = fixture(); value.implants.data.implants[0].name = 'Synthetic α implant'; for (const row of value.clones.data.clones[0].implants) row.name = 'Synthetic α implant';
  const bytes = new TextEncoder().encode(JSON.stringify(value)), split = bytes.indexOf(0xce) + 1;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)); controller.close(); } });
  const result = await harness(async () => new Response(stream, { headers: { 'content-type': 'application/json' } })).fetchCloneAnalytics(args);
  assert.equal(result.implants.data.implants[0].name, 'Synthetic α implant');
});

test('pre-cancelled, in-flight and late responses cannot expose stale results', async () => {
  let calls = 0; const early = new AbortController(); early.abort();
  await assert.rejects(harness(() => { calls++; }).fetchCloneAnalytics(args, early.signal), /cancelled/); assert.equal(calls, 0);
  const controller = new AbortController(); let cancelled = 0, released = 0;
  const h = harness(async () => ({ ok: true, headers: new Headers({ 'content-type': 'application/json' }), body: { getReader: () => ({ read: () => { queueMicrotask(() => controller.abort()); return new Promise(() => {}); }, cancel: async () => { cancelled++; }, releaseLock: () => { released++; } }) } }));
  await assert.rejects(h.fetchCloneAnalytics(args, controller.signal), /cancelled/); assert.equal(cancelled, 1); assert.equal(released, 1);
  const late = new AbortController(); await assert.rejects(harness(async () => { late.abort(); return response(fixture()); }).fetchCloneAnalytics(args, late.signal), /cancelled/);
});

test('60-second client deadline races an uncooperative fetch and clears its timer', async () => {
  let callback, cleared = 0;
  const h = harness(() => { queueMicrotask(callback); return new Promise(() => {}); }, { setTimeout: (fn, ms) => { assert.equal(ms, 60000); callback = fn; return 3; }, clearTimeout: id => { assert.equal(id, 3); cleared++; } });
  await assert.rejects(h.fetchCloneAnalytics(args), /timed out/); assert.equal(cleared, 1);
});

test('actual server projections round-trip across optional data, permissions, failures and freshness', async () => {
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const dates = { exports: {} }, service = { exports: {} };
  vm.runInNewContext(compile('overview-summary'), { module: dates, exports: dates.exports, Date });
  vm.runInNewContext(compile('clone-analytics'), { module: service, exports: service.exports, Date, AbortSignal, require: name => {
    if (name === './overview-summary') return dates.exports;
    if (name === './manufacturing-catalog') return { findPublishedManufacturingItem: typeId => typeId === 1001 ? { name: 'Synthetic public implant' } : null };
    assert.equal(name, './eve'); return { EveError };
  } });
  for (const mode of ['normal', 'empty', 'homeAbsent', 'homePartial', 'missingClones', 'missingImplants', 'missingBoth', 'unknownFreshness', 'stale', 'malformed', 'changedAuthorization', 'rateLimited']) {
    const scopes = ['esi-clones.read_clones.v1', 'esi-clones.read_implants.v1'].filter((_, index) => mode !== 'missingBoth' && !(mode === 'missingClones' && index === 0) && !(mode === 'missingImplants' && index === 1));
    const reader = service.exports.createCloneAnalyticsReader({ now: () => Date.parse(stamp), connections: async () => [{ characterId: args.characterId, scopes }], character: async (_user, request) => {
      if (request.dataset === 'implants' && mode === 'changedAuthorization') throw new EveError('OMIT_PRIVATE', 409);
      if (request.dataset === 'implants' && mode === 'rateLimited') throw new EveError('OMIT_PRIVATE', 429);
      const data = request.dataset === 'clones' ? { jump_clones: mode === 'empty' ? [] : [{ jump_clone_id: 70000001, location_id: 60000001, location_type: 'station', implants: [1001, 1001, 9999], name: 'OMIT_PRIVATE' }], ...(mode === 'homeAbsent' ? {} : { home_location: mode === 'homePartial' ? {} : { location_type: 'station' } }) } : mode === 'empty' ? [] : mode === 'malformed' ? null : [1001, 9999];
      return { characterId: args.characterId, dataset: request.dataset, retrievedAt: stamp, cacheExpires: mode === 'unknownFreshness' ? null : mode === 'stale' ? stamp : expires, pagination: { kind: 'none' }, data };
    } });
    const result = await reader('synthetic-owner', args);
    assert.deepEqual(plain(client.cloneAnalyticsResponse(result, args)), plain(result), mode);
    assert(!JSON.stringify(result).includes('OMIT_PRIVATE'), mode);
  }
});
