import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const compile = name => ts.transpileModule(readFileSync(`app/lib/${name}.ts`, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const source = compile('blueprint-analytics'), summaryModule = { exports: {} };
vm.runInNewContext(compile('overview-summary'), { module: summaryModule, exports: summaryModule.exports, Date });
const stamp = '2026-01-01T00:00:00.000Z', now = Date.parse(stamp), characterId = 90000001, corporationId = 98000001;
const scopes = { character: 'esi-characters.read_blueprints.v1', corporation: 'esi-corporations.read_blueprints.v1' }, args = { characterId, entity: 'character' };
const plain = value => JSON.parse(JSON.stringify(value)), marker = 'OMIT_PRIVATE_BLUEPRINT';
const row = (item_id = 70000001, extra = {}) => ({ item_id, type_id: 10001, quantity: -1, runs: -1, material_efficiency: 10, time_efficiency: 20, location_id: 60000001, location_flag: 'Hangar', name: marker, owner_id: 90009999, ...extra });
const envelope = (entity, input, data = [row()], extra = {}) => ({ characterId: input.characterId, dataset: 'blueprints', ...(entity === 'corporation' ? { entity, corporationId } : {}), data,
  retrievedAt: stamp, cacheExpires: 'Thu, 01 Jan 2026 01:00:00 GMT', responseDate: 'Thu, 01 Jan 2026 00:00:00 GMT', cacheControl: 'private, max-age=3600', cacheAge: '0', lastModified: 'Wed, 31 Dec 2025 23:00:00 GMT',
  pagination: { kind: 'page', page: input.parameters.page, pages: 1, nextPage: null, pageLimit: 500, morePagesAvailable: false, pageLimitReached: false, after: null, before: null }, source: marker, ...extra });
function harness(options = {}) {
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const calls = [], deadline = new AbortController();
  const read = entity => async (user, input, signal) => { calls.push({ entity, user, input, signal }); return options.read ? options.read(entity, input, signal, EveError, deadline) : envelope(entity, input); };
  const deps = { connections: async user => { calls.push({ operation: 'connections', user }); return options.connect ? options.connect(deadline) : options.connections ?? [{ characterId, scopes: Object.values(scopes) }]; }, character: read('character'), corporation: read('corporation'), now: options.now ?? (() => now) };
  const service = { exports: {} };
  vm.runInNewContext(source, { module: service, exports: service.exports, Date, AbortSignal: { any: AbortSignal.any.bind(AbortSignal), timeout: ms => { assert.equal(ms, 55000); return deadline.signal; } }, require: name => name === './overview-summary' ? summaryModule.exports : name === './manufacturing-catalog' ? { findPublishedManufacturingItem: options.item ?? (id => id === 10001 || id === 10002 ? { name: `Synthetic blueprint ${id}` } : null) } : { EveError, listConnections: deps.connections, readCharacterData: deps.character, readCorporationData: deps.corporation } });
  return { read: service.exports.createBlueprintAnalyticsReader(deps), calls, deadline };
}
const get = (h, selection = args, options) => h.read('synthetic-owner', selection, options);

test('selectors reject unexpected IDs, owner, page, inherited inputs and extra fields before reads', async () => {
  for (const selected of [null, [], {}, Object.create(args), { ...args, characterId: 0 }, { ...args, characterId: '90000001' }, { ...args, characterId: Number.MAX_SAFE_INTEGER + 1 }, { ...args, entity: 'all' }, { ...args, page: 0 }, { ...args, page: 501 }, { ...args, page: 1.5 }, { ...args, page: undefined }, { ...args, page: null }, { ...args, corporationId }, { ...args, locationId: 60000001 }, { ...args, write: true }, { ...args, [Symbol('extra')]: true }]) {
    const h = harness(); await assert.rejects(get(h, selected), error => error.status === 400); assert.equal(h.calls.length, 0);
  }
});
test('sign-in, ownership and exact existing read grant gate all dataset calls', async () => {
  for (const user of ['', null, 1]) { const h = harness(); await assert.rejects(h.read(user, args), error => error.status === 401); assert.equal(h.calls.length, 0); }
  const foreign = harness({ connections: [{ characterId: characterId + 1, scopes: Object.values(scopes) }] }); await assert.rejects(get(foreign), error => error.status === 404); assert.equal(foreign.calls.length, 1);
  for (const entity of ['character', 'corporation']) {
    const h = harness({ connections: [{ characterId, scopes: [scopes[entity === 'character' ? 'corporation' : 'character']] }] }), value = await get(h, { characterId, entity });
    assert.equal(value.status, 'needs_permission'); assert.equal(value.scope, scopes[entity]); assert.equal(value.summary, null); assert.deepEqual(plain(value.blueprints), []); assert.equal(h.calls.length, 1);
  }
});
test('personal blueprints use exactly one explicit page and public labels without follow-up reads', async () => {
  const h = harness(), value = await get(h);
  assert.equal(value.status, 'ready'); assert.equal(value.corporationId, null); assert.equal(value.coverage.rows, 1); assert.equal(value.coverage.kind, 'complete_returned_response');
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].entity, 'character'); assert.equal(h.calls[1].user, 'synthetic-owner'); assert.equal(h.calls[1].signal, h.deadline.signal);
  assert.deepEqual(plain(h.calls[1].input), { characterId, dataset: 'blueprints', parameters: { page: 1 } });
  assert.deepEqual(plain(value.blueprints[0]), { row: 1, typeId: 10001, name: 'Synthetic blueprint 10001', catalogMapped: true, kind: 'original', units: 1, materialEfficiency: 10, timeEfficiency: 20, copyRuns: null });
});
test('corporation read uses its scoped adapter and reports its current derived corporation', async () => {
  const h = harness({ read: (entity, input) => envelope(entity, input, [row()], { corporationId: corporationId + 1, pagination: { kind: 'page', page: 2, pages: 4, nextPage: 3 } }) });
  const value = await get(h, { ...args, entity: 'corporation', page: 2 });
  assert.equal(h.calls[1].entity, 'corporation'); assert.deepEqual(plain(h.calls[1].input), { characterId, dataset: 'blueprints', parameters: { page: 2 } });
  assert.equal(value.corporationId, corporationId + 1); assert.equal(value.status, 'partial'); assert.equal(value.coverage.nextPage, 3); assert.equal(value.coverage.previousPage, 1);
});
test('kind, ME, TE and type charts count records while units and copy runs remain per row', async () => {
  const data = [row(), row(70000002, { quantity: -2, runs: 0, material_efficiency: 0, time_efficiency: 0 }), row(70000003, { type_id: 10002, quantity: -2, runs: 100, material_efficiency: 5, time_efficiency: 10 }), row(70000004, { quantity: 10000, material_efficiency: 0, time_efficiency: 0 })];
  const value = await get(harness({ read: (entity, input) => envelope(entity, input, data) }));
  assert.deepEqual(plain(value.summary), { records: 4, types: 2, originalRecords: 1, copyRecords: 2, originalStackRecords: 1, unknownTypeRecords: 0 });
  assert.deepEqual(plain(value.kindCounts), [{ kind: 'original', count: 1 }, { kind: 'copy', count: 2 }, { kind: 'original_stack', count: 1 }]);
  assert.deepEqual(plain(value.materialEfficiencyCounts), [{ level: 0, count: 2 }, { level: 5, count: 1 }, { level: 10, count: 1 }]);
  assert.deepEqual(plain(value.timeEfficiencyCounts), [{ level: 0, count: 2 }, { level: 10, count: 1 }, { level: 20, count: 1 }]);
  assert.equal(value.typeCounts[0].records, 3); assert.equal(value.blueprints[3].units, 10000); assert.equal(value.blueprints[3].kind, 'original_stack');
  assert.equal(value.blueprints[1].copyRuns, 0); assert.equal(value.blueprints[2].copyRuns, 100); assert(!Object.hasOwn(value.summary, 'runs')); assert(!Object.hasOwn(value.summary, 'units'));
});
test('empty returned page has zero counts, distinct from unavailable reads', async () => {
  const value = await get(harness({ read: (entity, input) => envelope(entity, input, []) }));
  assert.equal(value.status, 'ready'); assert.equal(value.summary.records, 0); assert.equal(value.summary.types, 0); assert.equal(value.typeCounts.length, 0); assert.equal(value.materialEfficiencyCounts.length, 0); assert.equal(value.kindCounts.length, 3);
});
test('unmapped or unsafe public names stay explicit and never request personal names', async () => {
  for (const name of [undefined, '', ' padded ', 'bad\u202ename', 'x'.repeat(513)]) {
    const h = harness({ item: () => name === undefined ? null : { name } }), value = await get(h);
    assert.equal(value.status, 'partial'); assert.equal(value.summary.unknownTypeRecords, 1); assert.equal(value.blueprints[0].catalogMapped, false); assert.equal(value.blueprints[0].name, 'Type 10001'); assert.equal(h.calls.length, 2);
  }
});
test('projection omits item/location identifiers, flags, owner IDs and upstream text', async () => {
  const value = await get(harness()), json = JSON.stringify(value);
  for (const secret of [marker, '70000001', '60000001', '90009999', 'location_flag', 'location_id', 'item_id', 'owner_id', '"source"']) assert(!json.includes(secret), secret);
  assert.equal(value.blueprints[0].row, 1); assert.match(value.limitations.join(' '), /positions in this response/);
});
test('unknown page counts and the 500-page limit remain partial without automatic requests', async () => {
  for (const [page, pages, nextPage, morePagesAvailable, pageLimitReached] of [[1, null, null, null, false], [500, null, null, null, true], [500, 501, null, true, true], [500, 500, null, false, false]]) {
    const h = harness({ read: (entity, input) => envelope(entity, input, [], { pagination: { kind: 'page', page, pages, nextPage, morePagesAvailable, pageLimitReached } }) }), value = await get(h, { ...args, page });
    assert.equal(value.status, 'partial'); assert.equal(value.coverage.kind, pages === null ? 'unknown' : 'partial'); assert.equal(value.coverage.pageLimitReached, pageLimitReached); assert.equal(h.calls.length, 2);
  }
});
test('mismatched response identity, dataset, pagination and dates cannot produce charts', async () => {
  const bad = [{ characterId: characterId + 1 }, { dataset: 'assets' }, { entity: 'corporation' }, { corporationId }, { retrievedAt: '2026-02-30T00:00:00Z' }, { retrievedAt: '2026-01-01T00:01:01Z' }, { pagination: { kind: 'none' } }, { pagination: { kind: 'page', page: 2, pages: 2, nextPage: null } }, { pagination: { kind: 'page', page: 1, pages: 2, nextPage: null } }, { pagination: { kind: 'page', page: 1, pages: 1, nextPage: null, after: 'opaque' } }, { pagination: { kind: 'page', page: 1, pages: 1, nextPage: null, pageLimit: 1000 } }, { data: {} }];
  for (const extra of bad) {
    const value = await get(harness({ read: (entity, input) => envelope(entity, input, [row()], extra) }));
    assert.equal(value.status, 'error'); assert.equal(value.summary, null); assert.equal(value.blueprints.length, 0);
  }
  const corp = await get(harness({ read: (entity, input) => envelope(entity, input, [], { corporationId: null }) }), { ...args, entity: 'corporation' }); assert.equal(corp.status, 'error');
});
test('malformed, duplicate and contradictory blueprint records reject the whole page', async () => {
  for (const extra of [{ item_id: 0 }, { type_id: '10001' }, { location_id: 0 }, { quantity: -3 }, { quantity: 0 }, { quantity: -2, runs: -1 }, { quantity: -1, runs: 0 }, { quantity: 10, runs: 3 }, { quantity: 1.5 }, { quantity: Number.MAX_SAFE_INTEGER + 1 }, { runs: 1.5, quantity: -2 }, { material_efficiency: -1 }, { time_efficiency: NaN }, { material_efficiency: Number.MAX_SAFE_INTEGER + 1 }, { location_flag: '' }, { location_flag: 'bad\nflag' }]) {
    const value = await get(harness({ read: (entity, input) => envelope(entity, input, [row(70000001), row(70000002, extra)]) })); assert.equal(value.status, 'error'); assert.equal(value.summary, null);
  }
  const duplicate = await get(harness({ read: (entity, input) => envelope(entity, input, [row(), row()]) })); assert.equal(duplicate.status, 'error');
});
test('bounded rows accept exactly 1000 but never silently truncate an oversized page', async () => {
  for (const count of [1000, 1001]) {
    const data = Array.from({ length: count }, (_, index) => row(70000001 + index)), value = await get(harness({ read: (entity, input) => envelope(entity, input, data) }));
    assert.equal(value.status, count === 1000 ? 'ready' : 'error'); assert.equal(value.blueprints.length, count === 1000 ? 1000 : 0);
  }
});
test('cache expiry honors Age and the earliest Expires/max-age evidence at completion', async () => {
  const value = await get(harness({ now: () => now + 2000, read: (entity, input) => envelope(entity, input, [], { cacheAge: '3599' }) }));
  assert.equal(value.freshness.cacheExpires, '2026-01-01T00:00:01.000Z'); assert.equal(value.freshness.state, 'stale'); assert.equal(value.status, 'partial');
  const early = await get(harness({ read: (entity, input) => envelope(entity, input, [], { cacheExpires: 'Thu, 01 Jan 2026 00:05:00 GMT' }) })); assert.equal(early.freshness.cacheExpires, '2026-01-01T00:05:00.000Z');
});
test('unknown, no-store and malformed cache evidence never claim fresh totals', async () => {
  for (const extra of [{ cacheExpires: null, responseDate: null, cacheControl: null }, { cacheControl: 'private, no-store' }, { cacheAge: 'invalid' }, { cacheAge: '-1' }]) {
    const value = await get(harness({ read: (entity, input) => envelope(entity, input, [row()], extra) })); assert.equal(value.status, 'partial'); assert.notEqual(value.freshness.state, 'fresh');
  }
});
test('valid offset timestamps normalize to UTC and generic errors never disclose source text', async () => {
  const value = await get(harness({ read: (entity, input) => envelope(entity, input, [], { retrievedAt: '2026-01-01T01:00:00+01:00' }) })); assert.equal(value.freshness.retrievedAt, stamp);
  const failed = await get(harness({ read: async () => { throw Error(marker); } })); assert.equal(failed.status, 'error'); assert(!JSON.stringify(failed).includes(marker)); assert.equal(failed.summary, null);
});
test('role denial, revoked authorization and rate limits retain specific safe guidance', async () => {
  for (const status of [401, 403, 404, 409, 429]) {
    const h = harness({ read: async (_entity, _input, _signal, EveError) => { throw new EveError(marker, status); } }), value = await get(h, { ...args, entity: 'corporation' });
    assert.equal(value.status, 'unavailable'); assert.equal(value.summary, null); assert(!JSON.stringify(value).includes(marker)); assert.equal(h.calls.length, 2);
    if (status === 403) assert.match(value.message, /Director/);
    if (status === 429) assert.match(value.message, /no automatic retry/);
  }
});
test('connection failures are safe and no data request starts after cancellation', async () => {
  const failed = harness({ connect: async () => { throw Error(marker); } }); assert.equal((await get(failed)).status, 'unavailable'); assert.equal(failed.calls.length, 1);
  const h = harness(), cancel = new AbortController(); cancel.abort(); await assert.rejects(get(h, args, { signal: cancel.signal })); assert.equal(h.calls.length, 0);
});
test('deadline and caller cancellation race uncooperative connection or data promises', async () => {
  const connection = harness({ connect: deadline => { queueMicrotask(() => deadline.abort()); return new Promise(() => {}); } });
  assert.equal((await get(connection)).status, 'unavailable'); assert.equal(connection.calls.length, 1);
  const data = harness({ read: (_entity, _input, _signal, _EveError, deadline) => { queueMicrotask(() => deadline.abort()); return new Promise(() => {}); } });
  assert.equal((await get(data)).status, 'unavailable'); assert.equal(data.calls.length, 2);
  const cancel = new AbortController(), h = harness({ read: () => { queueMicrotask(() => cancel.abort()); return new Promise(() => {}); } });
  assert.equal((await get(h, args, { signal: cancel.signal })).status, 'unavailable');
});
