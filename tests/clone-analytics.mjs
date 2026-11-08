import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const compile = name => ts.transpileModule(readFileSync(`app/lib/${name}.ts`, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const code = compile('clone-analytics'), dateCode = compile('overview-summary');
const now = Date.parse('2026-01-01T00:00:00Z'), stamp = new Date(now).toISOString(), characterId = 90000001;
const scopes = ['esi-clones.read_clones.v1', 'esi-clones.read_implants.v1'], marker = 'OMIT_PRIVATE_CLONE_TEXT';
const plain = value => JSON.parse(JSON.stringify(value));
const clone = (jump_clone_id = 70000001, extra = {}) => ({ jump_clone_id, location_id: 60000001, location_type: 'station', implants: [1001, 1002], name: marker, note: marker, ...extra });
const data = dataset => dataset === 'clones' ? { jump_clones: [clone()], home_location: { location_id: 60000002, location_type: 'structure' }, last_clone_jump_date: '2025-12-31T23:00:00Z', last_station_change_date: '2025-12-30T00:00:00Z', private_marker: marker } : [1001];
const envelope = (args, value = data(args.dataset), extra = {}) => ({ characterId: args.characterId, dataset: args.dataset, data: value, retrievedAt: stamp, cacheExpires: 'Thu, 01 Jan 2026 00:05:00 GMT', pagination: { kind: 'none', page: undefined, pages: undefined, nextPage: null, nextFromId: null, nextBeforeId: null, nextFromEvent: null, after: null, before: null }, source: marker, private_marker: marker, ...extra });
function load(source, context = {}) {
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, Date, AbortSignal, ...context });
  return module.exports;
}
const dates = load(dateCode);
function harness(options = {}) {
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const calls = [], deadline = new AbortController();
  const dependencies = {
    connections: async user => { calls.push({ operation: 'connections', user }); return options.connected ? options.connected(deadline) : options.connections ?? [{ characterId, scopes }]; },
    character: async (user, args, signal) => { calls.push({ operation: 'character', user, args, signal }); return options.read ? options.read(args, signal, EveError, deadline) : envelope(args); },
    now: options.now ?? (() => now),
  };
  const item = id => options.item ? options.item(id) : id === 1001 ? { typeId: id, name: 'Synthetic public implant' } : null;
  const module = load(code, {
    require: name => {
      if (name === './overview-summary') return dates;
      if (name === './manufacturing-catalog') return { findPublishedManufacturingItem: item };
      assert.equal(name, './eve'); return { EveError, listConnections: dependencies.connections, readCharacterData: dependencies.character };
    },
    AbortSignal: { any: AbortSignal.any.bind(AbortSignal), timeout: duration => { assert.equal(duration, 55000); return deadline.signal; } },
  });
  return { read: module.createCloneAnalyticsReader(dependencies), validate: module.validateCloneAnalyticsArgs, calls, deadline };
}
const read = h => h.read('synthetic-owner', { characterId });

test('clone analytics accepts only one explicit owned-character selector before reads', async () => {
  for (const input of [null, [], {}, { characterId: 0 }, { characterId: -1 }, { characterId: 1.5 }, { characterId: '90000001' }, { characterId: NaN }, { characterId: Infinity }, { characterId: Number.MAX_SAFE_INTEGER + 1 }, { characterId, dataset: 'mail' }, { characterId, page: 1 }, { characterId, resolveNames: true }, { characterId, scopes }, Object.create({ characterId })]) {
    const h = harness(); await assert.rejects(h.read('synthetic-owner', input), error => error.status === 400); assert.equal(h.calls.length, 0);
  }
});
test('sign-in and saved connection ownership precede grant and clone reads', async () => {
  for (const user of ['', null, 7]) {
    const h = harness(); await assert.rejects(h.read(user, { characterId }), error => error.status === 401); assert.equal(h.calls.length, 0);
  }
  const h = harness({ connections: [{ characterId: characterId + 1, scopes }] });
  await assert.rejects(read(h), error => error.status === 404); assert.equal(h.calls.length, 1);
});
test('two sequential reads preserve separate scopes, snapshots and minimized projection', async () => {
  const h = harness(), result = await read(h);
  assert.equal(result.status, 'ready'); assert.equal(result.generatedAt, stamp);
  assert.deepEqual(plain(h.calls.slice(1).map(row => row.args)), [{ characterId, dataset: 'clones' }, { characterId, dataset: 'implants' }]);
  assert(h.calls.slice(1).every(row => row.user === 'synthetic-owner' && row.signal === h.deadline.signal));
  assert.equal(result.clones.scope, scopes[0]); assert.equal(result.implants.scope, scopes[1]);
  assert.equal(result.clones.data.cloneCount, 1); assert.equal(result.clones.data.totalStoredImplants, 2); assert.equal(result.clones.data.unmappedImplants, 1);
  assert.equal(result.implants.data.implantCount, 1); assert.equal(result.implants.data.unmappedImplants, 0);
  assert.deepEqual(plain(result.clones.data.homeLocation), { locationId: 60000002, locationType: 'structure' });
  assert.deepEqual(plain(result.clones.data.clones[0]), { row: 1, locationId: 60000001, locationType: 'station', implants: [{ typeId: 1001, name: 'Synthetic public implant', mapped: true }, { typeId: 1002, name: 'Type 1002', mapped: false }] });
  assert.equal(result.clones.data.lastCloneJumpAt, '2025-12-31T23:00:00.000Z');
  assert.equal(result.clones.data.lastHomeStationChangeAt, '2025-12-30T00:00:00.000Z');
  for (const section of [result.clones, result.implants]) { assert.equal(section.freshness, 'fresh'); assert.equal(section.cacheExpires, '2026-01-01T00:05:00.000Z'); }
  for (const omitted of [marker, '70000001', 'jump_clone_id', 'private_marker', '"source":']) assert(!JSON.stringify(result).includes(omitted));
  for (const omitted of ['readyToJump', 'capacity', 'bonus', 'price', 'slot', 'skillpoints']) assert(!Object.hasOwn(result.clones.data, omitted));
  assert.match(result.message, /independent ESI snapshots/); assert.match(result.clones.message, /do not establish jump readiness/); assert.match(result.implants.message, /No bonuses/);
});
test('missing clone and implant grants remain independent without upstream reads or invented zeros', async () => {
  for (const granted of [[], [scopes[0]], [scopes[1]]]) {
    const h = harness({ connections: [{ characterId, scopes: granted }] }), result = await read(h);
    assert.equal(h.calls.length, 1 + granted.length); assert.equal(result.status, granted.length ? 'partial' : 'needs_permission');
    for (const section of [result.clones, result.implants]) if (!granted.includes(section.scope)) {
      assert.equal(section.status, 'needs_permission'); assert.equal(section.data, null); assert.equal(section.retrievedAt, null); assert.match(section.message, /No additional access/);
    }
  }
});
test('verified empty responses differ from unavailable data and preserve absent optional metadata', async () => {
  const result = await read(harness({ read: args => envelope(args, args.dataset === 'clones' ? { jump_clones: [] } : []) }));
  assert.equal(result.status, 'ready'); assert.deepEqual(plain(result.implants.data), { implantCount: 0, unmappedImplants: 0, implants: [] });
  assert.deepEqual(plain(result.clones.data), { homeLocation: null, lastCloneJumpAt: null, lastHomeStationChangeAt: null, cloneCount: 0, totalStoredImplants: 0, unmappedImplants: 0, clones: [] });
});
test('optional home-location fields stay separately unknown and dates normalize to UTC', async () => {
  for (const [home, expected] of [[{}, { locationId: null, locationType: null }], [{ location_id: 60000002 }, { locationId: 60000002, locationType: null }], [{ location_type: 'structure' }, { locationId: null, locationType: 'structure' }]]) {
    const result = await read(harness({ read: args => envelope(args, args.dataset === 'clones' ? { jump_clones: [], home_location: home, last_clone_jump_date: '2025-12-31T23:00:00-01:00' } : []) }));
    assert.equal(result.clones.status, 'ready'); assert.deepEqual(plain(result.clones.data.homeLocation), expected);
    assert.equal(result.clones.data.lastCloneJumpAt, stamp); assert.equal(result.clones.data.lastHomeStationChangeAt, null);
  }
});
test('implant type repetitions are occurrences, not duplicate clone identities or merged active inventory', async () => {
  const result = await read(harness({ read: args => envelope(args, args.dataset === 'clones' ? { jump_clones: [clone(70000001, { implants: [1001, 1002, 1002] }), clone(70000002, { implants: [1002] })] } : [1002, 1002, 1001]) }));
  assert.equal(result.clones.data.cloneCount, 2); assert.equal(result.clones.data.totalStoredImplants, 4); assert.equal(result.clones.data.unmappedImplants, 3);
  assert.equal(result.implants.data.implantCount, 3); assert.equal(result.implants.data.unmappedImplants, 2);
  assert.deepEqual(plain(result.implants.data.implants.map(row => row.typeId)), [1002, 1002, 1001]);
  assert.deepEqual(plain(result.clones.data.clones.map(row => row.row)), [1, 2]);
  assert(!Object.hasOwn(result, 'totalImplants'));
});
test('unknown or unsafe public catalog labels keep explicit type IDs without extra lookup', async () => {
  for (const name of ['', ' leading', 'bad\nname', '\u202eunsafe', 'x'.repeat(513)]) {
    const h = harness({ item: () => ({ name }) }), result = await read(h);
    assert.equal(result.implants.data.implants[0].name, 'Type 1001'); assert.equal(result.implants.data.implants[0].mapped, false);
    assert.equal(result.implants.data.unmappedImplants, 1); assert.equal(h.calls.length, 3);
  }
});
test('malformed clone rows, duplicate identities and optional present values reject their entire section', async () => {
  const bad = [null, [], {}, { jump_clones: null }, { jump_clones: [clone(), clone()] },
    ...[null, {}, clone(0), clone(1.5), clone(Number.MAX_SAFE_INTEGER + 1), clone(70000001, { location_id: 0 }), clone(70000001, { location_type: 'solar_system' }), clone(70000001, { implants: null }), clone(70000001, { implants: [0] }), clone(70000001, { implants: ['1001'] })].map(row => ({ jump_clones: [row] })),
    ...[null, [], { location_id: null }, { location_type: null }, { location_id: 0 }, { location_type: 'station_name' }].map(home_location => ({ jump_clones: [], home_location })),
    ...[null, '2026-02-30T00:00:00Z', '2026-01-01', '2026-01-02T00:00:00Z'].flatMap(value => [{ jump_clones: [], last_clone_jump_date: value }, { jump_clones: [], last_station_change_date: value }])];
  for (const value of bad) {
    const result = await read(harness({ read: args => envelope(args, args.dataset === 'clones' ? value : [1001]) }));
    assert.equal(result.clones.status, 'error'); assert.equal(result.clones.data, null); assert.equal(result.clones.retrievedAt, null);
    assert.equal(result.implants.status, 'ready'); assert.equal(result.status, 'partial'); assert.match(result.clones.message, /unknown, not zero/);
  }
});
test('malformed active type arrays cannot produce plausible empty or partial implants', async () => {
  for (const value of [null, {}, [0], [-1], [1.5], ['1001'], [null], [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1]]) {
    const result = await read(harness({ read: args => envelope(args, args.dataset === 'implants' ? value : data(args.dataset)) }));
    assert.equal(result.implants.status, 'error'); assert.equal(result.implants.data, null); assert.equal(result.clones.status, 'ready');
  }
});
test('application bounds accept complete limit-sized lists and reject excess instead of truncating', async () => {
  for (const count of [100, 101]) {
    const result = await read(harness({ read: args => envelope(args, args.dataset === 'clones' ? { jump_clones: Array.from({ length: count }, (_, i) => clone(70000001 + i, { implants: Array(64).fill(1001) })) } : []) }));
    assert.equal(result.clones.status, count === 100 ? 'ready' : 'error');
    assert.equal(result.clones.data?.totalStoredImplants ?? null, count === 100 ? 6400 : null);
  }
  for (const count of [64, 65]) for (const dataset of ['clones', 'implants']) {
    const value = dataset === 'clones' ? { jump_clones: [clone(70000001, { implants: Array(count).fill(1001) })] } : Array(count).fill(1001);
    const result = await read(harness({ read: args => envelope(args, args.dataset === dataset ? value : data(args.dataset)) }));
    assert.equal(result[dataset].status, count === 64 ? 'ready' : 'error');
    assert.equal(result[dataset].data !== null, count === 64);
  }
});
test('wrong owner, dataset, entity, paging and retrieval envelopes fail before accepting clone rows', async () => {
  const bad = [{ characterId: characterId + 1 }, { dataset: 'mail' }, { entity: 'corporation' }, { corporationId: 98000001 }, { division: 1 }, { page: 1 }, { retrievedAt: 'not-a-date' }, { retrievedAt: '2026-01-01T00:02:00Z' }, { pagination: { kind: 'page' } },
    ...['page', 'pages', 'nextPage', 'nextFromId', 'nextBeforeId', 'nextFromEvent', 'after', 'before'].map(key => ({ pagination: { kind: 'none', [key]: 1 } }))];
  for (const extra of bad) {
    const result = await read(harness({ read: args => envelope(args, data(args.dataset), args.dataset === 'clones' ? extra : {}) }));
    assert.equal(result.clones.status, 'error'); assert.equal(result.clones.data, null); assert.equal(result.implants.status, 'ready');
  }
});
test('freshness uses expiry, response date, age, no-store and final completion time', async () => {
  const cases = [
    [{ cacheExpires: null }, null, 'unknown'],
    [{ cacheExpires: 'Thu, 01 Jan 2026 00:00:00 GMT' }, stamp, 'stale'],
    [{ cacheControl: 'private, no-store' }, stamp, 'stale'],
    [{ responseDate: 'Thu, 01 Jan 2026 00:00:00 GMT', cacheControl: 'private, max-age=300', cacheAge: '400' }, '2025-12-31T23:58:20.000Z', 'stale'],
    [{ cacheAge: '-1' }, null, 'unknown'],
    [{ cacheExpires: 'not-a-time' }, null, 'unknown'],
    [{ cacheExpires: null, responseDate: 'Thu, 01 Jan 2026 00:00:00 GMT', cacheControl: 'max-age=300', cacheAge: '20' }, '2026-01-01T00:04:40.000Z', 'fresh'],
  ];
  for (const [extra, expectedExpiry, freshness] of cases) {
    const result = await read(harness({ read: args => envelope(args, data(args.dataset), extra) }));
    assert.equal(result.clones.cacheExpires, expectedExpiry); assert.equal(result.clones.freshness, freshness);
    assert.equal(result.status, freshness === 'fresh' ? 'ready' : 'partial'); assert(result.clones.data);
  }
  let clock = now;
  const result = await read(harness({ now: () => clock, read: args => { if (args.dataset === 'implants') clock += 10000; return envelope(args, data(args.dataset), { cacheExpires: 'Thu, 01 Jan 2026 00:00:05 GMT' }); } }));
  assert.equal(result.clones.freshness, 'stale'); assert.equal(result.implants.freshness, 'stale'); assert.equal(result.generatedAt, '2026-01-01T00:00:10.000Z');
});
test('403 and malformed/provider failures affect only their section and never expose upstream text', async () => {
  for (const status of [403, 500, null]) {
    const result = await read(harness({ read: (args, _signal, EveError) => { if (args.dataset === 'clones') throw status ? new EveError(marker, status) : new Error(marker); return envelope(args); } }));
    assert.equal(result.clones.status, status === 403 ? 'unavailable' : 'error'); assert.equal(result.clones.data, null); assert.equal(result.implants.status, 'ready');
    assert(!JSON.stringify(result).includes(marker));
  }
});
test('connection-changing failures stop reads and discard previously accepted private sections', async () => {
  for (const status of [401, 404, 409]) for (const failed of ['clones', 'implants']) {
    const h = harness({ read: (args, _signal, EveError) => { if (args.dataset === failed) throw new EveError(marker, status); return envelope(args); } }), result = await read(h);
    assert.equal(h.calls.length, failed === 'clones' ? 2 : 3); assert.equal(result.status, 'unavailable');
    assert.equal(result.clones.data, null); assert.equal(result.implants.data, null); assert(!JSON.stringify(result).includes(marker));
  }
});
test('rate limits stop later reads without retry and retain earlier evidence only as partial', async () => {
  for (const failed of ['clones', 'implants']) {
    const h = harness({ read: (args, _signal, EveError) => { if (args.dataset === failed) throw new EveError(marker, 429); return envelope(args); } }), result = await read(h);
    assert.equal(h.calls.length, failed === 'clones' ? 2 : 3); assert.equal(result.status, failed === 'clones' ? 'unavailable' : 'partial');
    assert.equal(result.implants.data, null); assert.match(result.implants.message, /no automatic retry/);
  }
});
test('connection errors and uncooperative lookup cancellation settle with a generic bounded error', async () => {
  const h = harness({ connected: () => { throw new Error(marker); } });
  await assert.rejects(read(h), error => error.status === 503 && !error.message.includes(marker)); assert.equal(h.calls.length, 1);
  const hanging = harness({ connected: deadline => { deadline.abort(); return new Promise(() => {}); } });
  await assert.rejects(read(hanging), error => error.status === 503); assert.equal(hanging.calls.length, 1);
});
test('pre-cancelled requests read nothing and in-flight cancellation discards all section results', async () => {
  const signal = new AbortController(); signal.abort(); const h = harness();
  await assert.rejects(h.read('synthetic-owner', { characterId }, { signal: signal.signal })); assert.equal(h.calls.length, 0);
  for (const dataset of ['clones', 'implants']) {
    const h = harness({ read: (args, _signal, _EveError, deadline) => { if (args.dataset === dataset) { deadline.abort(); return new Promise(() => {}); } return envelope(args); } }), result = await read(h);
    assert.equal(result.status, 'unavailable'); assert.equal(result.clones.data, null); assert.equal(result.implants.data, null);
    assert.equal(h.calls.length, dataset === 'clones' ? 2 : 3);
  }
});
test('shared deadline includes connection lookup and synchronous projection/finalization', async () => {
  let clock = now;
  const h = harness({ now: () => clock, connected: () => { clock += 55000; return [{ characterId, scopes }]; } }), result = await read(h);
  assert.equal(h.calls.length, 1); assert.equal(result.status, 'unavailable');
  for (const late of ['clones', 'implants']) {
    clock = now;
    const h = harness({ now: () => clock, read: args => { if (args.dataset === late) clock += 55000; return envelope(args); } }), result = await read(h);
    assert.equal(result.status, 'unavailable'); assert.equal(result.clones.data, null); assert.equal(result.implants.data, null);
    assert.equal(h.calls.length, late === 'clones' ? 2 : 3);
  }
});
