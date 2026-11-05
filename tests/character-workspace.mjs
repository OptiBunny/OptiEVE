import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const compile = name => ts.transpileModule(readFileSync(`app/lib/${name}.ts`, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const code = compile('character-workspace'), summaryCode = compile('overview-summary');
const now = Date.parse('2026-01-01T00:00:00Z'), stamp = new Date(now).toISOString(), characterId = 90000001;
const scopes = { standings: 'esi-characters.read_standings.v1', loyalty_points: 'esi-characters.read_loyalty.v1', faction_warfare: 'esi-characters.read_fw_stats.v1', blueprints: 'esi-characters.read_blueprints.v1', research: 'esi-characters.read_agents_research.v1', planets: 'esi-planets.manage_planets.v1', mining: 'esi-industry.read_character_mining.v1' };
const requests = Object.keys(scopes).map(view => ({ characterId, view }));
const plain = value => JSON.parse(JSON.stringify(value));
const standing = (from_id = 1001, override = {}) => ({ from_id, from_type: 'faction', standing: 5.123, private_marker: 'OMIT_PRIVATE_FIELDS', ...override });
const loyalty = (corporation_id = 1001, override = {}) => ({ corporation_id, loyalty_points: 12345, private_marker: 'OMIT_PRIVATE_FIELDS', ...override });
const warfare = (override = {}) => ({ kills: { yesterday: 2, last_week: 7, total: 25 }, victory_points: { yesterday: 100, last_week: 500, total: 2500 }, faction_id: 500001, enlisted_on: '2025-12-01T12:00:00Z', current_rank: 0, highest_rank: 2, private_marker: 'OMIT_PRIVATE_FIELDS', ...override });
const blueprint = (item_id = 1001, override = {}) => ({ item_id, type_id: 100, location_id: 60000001, location_flag: 'Hangar', quantity: -2, material_efficiency: 10, time_efficiency: 20, runs: 12, private_marker: 'OMIT_PRIVATE_FIELDS', ...override });
const researchAgent = (agent_id = 3001, override = {}) => ({ agent_id, skill_type_id: 4001, started_at: stamp, points_per_day: 12.5, remainder_points: -1.25, private_marker: 'OMIT_PRIVATE_FIELDS', ...override });
const planet = (planet_id = 40000001, override = {}) => ({ planet_id, solar_system_id: 30000001, planet_type: 'temperate', owner_id: characterId, last_update: stamp, upgrade_level: 3, num_pins: 5, private_marker: 'OMIT_PRIVATE_FIELDS', ...override });
const miningRecord = (type_id = 34, override = {}) => ({ date: '2025-12-31', type_id, solar_system_id: 30000001, quantity: 1234, private_marker: 'OMIT_PRIVATE_FIELDS', ...override });
function load(source, context = {}) {
  const fixtureModule = { exports: {} };
  vm.runInNewContext(source, { module: fixtureModule, exports: fixtureModule.exports, Date, AbortSignal, ...context });
  return fixtureModule.exports;
}
const summary = load(summaryCode);
// Match readCharacterData's actual envelope: it does not expose an entity field.
function response(args, data) {
  return { dataset: args.dataset, characterId: args.characterId, data: data ?? (args.dataset === 'standings' ? [standing()] : args.dataset === 'loyalty_points' ? [loyalty()] : args.dataset === 'blueprints' ? [blueprint()] : args.dataset === 'research' ? [researchAgent()] : args.dataset === 'planets' ? [planet()] : args.dataset === 'mining' ? [miningRecord()] : warfare()), source: 'https://example.invalid/OMIT_PRIVATE_FIELDS', retrievedAt: stamp, cacheExpires: 'Thu, 01 Jan 2026 00:05:00 GMT', pagination: ['blueprints', 'mining'].includes(args.dataset) ? { kind: 'page', page: args.parameters?.page ?? 1, pages: 1, nextPage: null } : { kind: 'none', nextPage: null, after: null, before: null }, private_marker: 'OMIT_PRIVATE_FIELDS' };
}
function harness(options = {}) {
  class EveError extends Error { constructor(message, status = 400, reason, upstreamStatus) { super(message); this.status = status; this.reason = reason; this.upstreamStatus = upstreamStatus; } }
  const calls = [], deadline = new AbortController();
  const deps = {
    connections: async user => { calls.push({ operation: 'connections', user }); if (options.connected) return options.connected(deadline); return options.connections ?? [{ characterId, scopes: Object.values(scopes) }]; },
    character: async (user, args, signal) => { calls.push({ operation: 'character', user, args, signal }); return options.read ? options.read(args, signal, EveError, deadline) : response(args); },
    publicNames: async (ids, signal) => { calls.push({ operation: 'publicNames', ids, signal }); return options.publicNames ? options.publicNames(ids, signal, EveError, deadline) : { data: ids.map(id => ({ id, category: id >= 30000000 ? 'solar_system' : 'inventory_type', name: 'Synthetic public name ' + id })), retrievedAt: stamp, cacheExpires: 'Thu, 01 Jan 2026 00:05:00 GMT' }; },
    now: options.now ?? (() => now),
  };
  const service = load(code, { require: name => name === './overview-summary' ? summary : { EveError, listConnections: deps.connections, readCharacterData: deps.character, readPublicNames: deps.publicNames }, AbortSignal: { any: AbortSignal.any.bind(AbortSignal), timeout: milliseconds => { assert.equal(milliseconds, 55000); return deadline.signal; } } });
  return { read: service.createCharacterWorkspaceReader(deps), calls, deadline };
}

test('reputation selectors reject arbitrary identity, dataset, paging and enrichment arguments before reads', async () => {
  for (const input of [null, [], {}, { characterId, view: 'contacts' }, { characterId: 0, view: 'standings' }, { characterId: '90000001', view: 'standings' }, { characterId, view: ['standings'] }, { characterId, view: 'standings', page: 1 }, { characterId, view: 'standings', after: 'cursor' }, { characterId, view: 'standings', offset: 1 }, { characterId, view: 'standings', offset: -100 }, { characterId, view: 'loyalty_points', offset: 10000 }, { characterId, view: 'faction_warfare', offset: 0 }, { characterId, view: 'standings', includeNames: true }, { characterId, view: 'loyalty_points', corporationId: 1001 }, { characterId, view: 'faction_warfare', factionId: 500001 }, { characterId, view: 'standings', dataset: 'mail' }]) {
    const h = harness(); await assert.rejects(h.read('synthetic-owner', input), error => error.status === 400); assert.equal(h.calls.length, 0);
  }
});

test('all character views require sign-in, owned connection and their exact existing grant', async () => {
  for (const request of requests) {
    const signedOut = harness(); await assert.rejects(signedOut.read('', request), error => error.status === 401); assert.equal(signedOut.calls.length, 0);
    const other = harness({ connections: [{ characterId: characterId + 1, scopes: Object.values(scopes) }] }); await assert.rejects(other.read('synthetic-owner', request), error => error.status === 404); assert.equal(other.calls.length, 1);
    const missing = harness({ connections: [{ characterId, scopes: Object.values(scopes).filter(scope => scope !== scopes[request.view]) }] });
    const result = await missing.read('synthetic-owner', request); assert.equal(result.status, 'needs_permission'); assert.equal(missing.calls.length, 1); assert.deepEqual(plain(result.rows), []); assert.deepEqual(plain(result.metrics), []); assert.equal(result.scope, scopes[request.view]);
  }
});

test('each supported view makes only one scoped character read with no extra provider options', async () => {
  for (const request of requests) {
    const h = harness(), result = await h.read('synthetic-owner', request);
    assert.equal(result.status, 'ready'); assert.equal(result.coverage, 'complete'); assert.equal(h.calls.length, 2);
    assert.deepEqual(plain(h.calls[1].args), { characterId, dataset: request.view, ...(['blueprints', 'mining'].includes(request.view) ? { parameters: { page: 1 } } : {}) }); assert.equal(h.calls[1].user, 'synthetic-owner'); assert(h.calls[1].signal instanceof AbortSignal);
    assert(!JSON.stringify(result).includes('OMIT_PRIVATE_FIELDS')); assert.equal(result.source, undefined); assert.equal(result.corporationId, undefined); assert.equal(result.offset, undefined); assert.equal(result.next, null);
    assert.equal(result.retrievedAt, stamp); assert.equal(result.cacheExpires, '2026-01-01T00:05:00.000Z');
  }
});

test('standings preserve signed fractional provider values, explicit source types and missing-entry limits', async () => {
  const data = [standing(1003, { from_type: 'agent', standing: 0 }), standing(1001, { from_type: 'faction', standing: -2.25 }), standing(1002, { from_type: 'npc_corp', standing: 5.123 }), standing(1004, { from_type: 'agent', standing: -1e-10 })];
  const result = await harness({ read: async args => response(args, data) }).read('synthetic-owner', requests[0]);
  assert.deepEqual(plain(result.rows.map(row => row.cells.kind)), ['Faction', 'NPC corporation', 'Agent', 'Agent']);
  assert.deepEqual(plain(result.rows.map(row => row.cells.standing)), [-2.25, 5.123, 0, -1e-10]);
  assert.deepEqual(plain(result.metrics.map(metric => metric.value)), [4, 1, 2, 1]);
  assert.equal(result.columns[2].label, 'Reported standing'); assert.equal(result.columns[2].unit, 'standing');
  assert.match(result.message, /No skills-based adjustment/); assert.match(result.message, /do not guarantee/); assert.match(result.message, /not neutral/);
});

test('loyalty points remain per corporation; no exchange rate, combined currency or ISK estimate', async () => {
  const result = await harness({ read: async args => response(args, [loyalty(1002, { loyalty_points: 0 }), loyalty(1001)]) }).read('synthetic-owner', requests[1]);
  assert.deepEqual(plain(result.rows.map(row => row.cells)), [{ corporationId: 1001, points: 12345 }, { corporationId: 1002, points: 0 }]);
  assert.deepEqual(plain(result.metrics), [{ label: 'NPC corporations returned', value: 2, unit: 'count' }, { label: 'Corporations with LP', value: 1, unit: 'count' }]);
  assert.equal(result.columns[1].unit, 'LP'); assert.match(result.message, /not added across corporations/); assert.match(result.message, /Missing corporations are not zero/);
});

for (const view of ['standings', 'loyalty_points', 'research', 'planets']) {
  test(`${view} bounds displayed slices and rereads one unpaginated dataset`, async () => {
    const make = { standings: standing, loyalty_points: loyalty, research: researchAgent, planets: planet }[view];
    const h = harness({ read: async args => response(args, Array.from({ length: 201 }, (_, index) => make(index + 1))) });
    const first = await h.read('synthetic-owner', { characterId, view });
    assert.equal(first.rows.length, 100); assert.equal(first.coverage, 'partial'); assert.equal(first.metrics[0].value, 201); assert.deepEqual(plain(first.next), { characterId, view, offset: 100 });
    const second = await h.read('synthetic-owner', first.next); assert.equal(second.rows.length, 100); assert.deepEqual(plain(second.next), { characterId, view, offset: 200 });
    const last = await h.read('synthetic-owner', second.next); assert.equal(last.rows.length, 1); assert.equal(last.next, null); assert.equal(last.coverage, 'partial');
    assert.equal(h.calls.filter(call => call.operation === 'character').length, 3);
    for (const call of h.calls.filter(call => call.operation === 'character')) assert.deepEqual(plain(call.args), { characterId, dataset: view });
    assert.match(first.message, /Summary counts cover the 201 entries/); assert.match(first.message, /not a saved history/);
  });
  test(`${view} empty responses and obsolete slices are distinct`, async () => {
    const h = harness({ read: async args => response(args, []) });
    const empty = await h.read('synthetic-owner', { characterId, view }); assert.equal(empty.status, 'ready'); assert.equal(empty.coverage, 'complete'); assert.equal(empty.metrics[0].value, 0); assert.equal(empty.rows.length, 0); assert.equal(empty.next, null);
    const obsolete = await h.read('synthetic-owner', { characterId, view, offset: 100 }); assert.equal(obsolete.status, 'partial'); assert.equal(obsolete.coverage, 'unknown'); assert.equal(obsolete.metrics.length, 0); assert.equal(obsolete.rows.length, 0); assert.equal(obsolete.next, null); assert.match(obsolete.message, /no longer available/);
  });
  test(`${view} accepts final safety-bounded slice and rejects oversized provider lists`, async () => {
    const make = { standings: standing, loyalty_points: loyalty, research: researchAgent, planets: planet }[view];
    const final = await harness({ read: async args => response(args, Array.from({ length: 10000 }, (_, index) => make(index + 1))) }).read('synthetic-owner', { characterId, view, offset: 9900 });
    assert.equal(final.rows.length, 100); assert.equal(final.next, null); assert.equal(final.coverage, 'partial');
    const tooMany = await harness({ read: async args => response(args, Array.from({ length: 10001 }, (_, index) => make(index + 1))) }).read('synthetic-owner', { characterId, view });
    assert.equal(tooMany.status, 'error'); assert.equal(tooMany.metrics.length, 0);
  });
}

test('faction warfare renders exact reported periods and optional enrollment/rank metadata', async () => {
  const result = await harness().read('synthetic-owner', requests[2]);
  assert.deepEqual(plain(result.rows), [{ id: 'yesterday', cells: { period: 'Yesterday', kills: 2, victoryPoints: 100 } }, { id: 'last_week', cells: { period: 'Last week', kills: 7, victoryPoints: 500 } }, { id: 'total', cells: { period: 'Reported total', kills: 25, victoryPoints: 2500 } }]);
  assert.deepEqual(plain(result.metrics), [{ label: 'Enrollment', value: 'Reported' }, { label: 'Faction ID', value: 500001 }, { label: 'Enlisted (UTC)', value: '2025-12-01T12:00:00.000Z', unit: 'datetime' }, { label: 'Current rank', value: 0, unit: 'count' }, { label: 'Highest rank', value: 2, unit: 'count' }]);
  assert.match(result.message, /no today counter/); assert.match(result.message, /must not be added/); assert.equal(result.next, null);
});

test('successful faction warfare optional omissions stay unreported, not invented zero or request failures', async () => {
  const data = warfare(); for (const key of ['faction_id', 'enlisted_on', 'current_rank', 'highest_rank']) delete data[key];
  const result = await harness({ read: async args => response(args, data) }).read('synthetic-owner', requests[2]);
  assert.equal(result.status, 'ready'); assert.equal(result.coverage, 'complete'); assert(result.metrics.every(metric => metric.value === 'Not reported' && metric.unit === undefined));
  assert.equal(result.rows[2].cells.kills, 25); assert.match(result.message, /successful response/);
});

test('one-sided faction warfare enrollment metadata stays incomplete and unknown', async () => {
  for (const absent of ['faction_id', 'enlisted_on']) {
    const data = warfare(); delete data[absent];
    const result = await harness({ read: async args => response(args, data) }).read('synthetic-owner', requests[2]);
    assert.equal(result.status, 'partial'); assert.equal(result.coverage, 'unknown'); assert.equal(result.metrics[0].value, 'Incomplete fields'); assert.equal(result.rows.length, 3); assert.match(result.message, /cannot be determined/);
  }
});

test('unrecognized private response fields never enter reputation projections', async () => {
  for (const request of requests) {
    const h = harness({ read: async args => {
      const result = response(args), extra = { name: 'OMIT_PRIVATE_FIELDS', description: '<img src="https://example.invalid/OMIT_PRIVATE_FIELDS">', creator_id: 90009999, participants: ['OMIT_PRIVATE_FIELDS'], token: 'OMIT_PRIVATE_FIELDS' };
      result.data = Array.isArray(result.data) ? result.data.map(row => ({ ...row, ...extra })) : { ...result.data, ...extra };
      return result;
    } });
    const result = await h.read('synthetic-owner', request); assert.equal(result.status, 'ready'); assert(!/OMIT_PRIVATE_FIELDS|90009999|https:|<img/.test(JSON.stringify(result))); assert.equal(h.calls.length, 2);
  }
});

for (const [label, data] of [['unknown type', [standing(1001, { from_type: 'character' })]], ['duplicate ID', [standing(), standing(1001, { from_type: 'agent' })]], ['NaN', [standing(1001, { standing: NaN })]], ['infinity', [standing(1001, { standing: Infinity })]], ['above maximum', [standing(1001, { standing: 10.001 })]], ['below minimum', [standing(1001, { standing: -10.001 })]], ['string standing', [standing(1001, { standing: '5' })]], ['missing standing', [{ from_id: 1001, from_type: 'agent' }]], ['invalid ID', [standing(Number.MAX_SAFE_INTEGER + 1)]], ['null row', [null]], ['object list', {}]]) {
  test(`standings reject ${label} without publishing zero summary`, async () => {
    const result = await harness({ read: async args => response(args, data) }).read('synthetic-owner', requests[0]); assert.equal(result.status, 'error'); assert.equal(result.rows.length, 0); assert.equal(result.metrics.length, 0); assert.equal(result.retrievedAt, null);
  });
}

for (const [label, data] of [['duplicate corporation', [loyalty(), loyalty()]], ['negative LP', [loyalty(1001, { loyalty_points: -1 })]], ['fractional LP', [loyalty(1001, { loyalty_points: 1.5 })]], ['unsafe LP', [loyalty(1001, { loyalty_points: Number.MAX_SAFE_INTEGER + 1 })]], ['string LP', [loyalty(1001, { loyalty_points: '5' })]], ['missing balance', [{ corporation_id: 1001 }]], ['invalid corporation', [loyalty(0)]]]) {
  test(`loyalty rejects ${label} without guessing balance`, async () => {
    const result = await harness({ read: async args => response(args, data) }).read('synthetic-owner', requests[1]); assert.equal(result.status, 'error'); assert.equal(result.rows.length, 0); assert.equal(result.metrics.length, 0);
  });
}

for (const [label, data] of [['missing counters', {}], ['missing period', warfare({ kills: { total: 25, yesterday: 2 } })], ['negative count', warfare({ kills: { total: -1, yesterday: 2, last_week: 7 } })], ['fractional count', warfare({ victory_points: { total: 1.5, yesterday: 100, last_week: 500 } })], ['unsafe count', warfare({ kills: { total: Number.MAX_SAFE_INTEGER + 1, yesterday: 2, last_week: 7 } })], ['invalid faction', warfare({ faction_id: 0 })], ['null faction', warfare({ faction_id: null })], ['negative rank', warfare({ current_rank: -1 })], ['fractional rank', warfare({ highest_rank: 2.5 })], ['local date', warfare({ enlisted_on: '2026-01-01T00:00:00' })], ['rollover date', warfare({ enlisted_on: '2026-02-30T00:00:00Z' })], ['null date', warfare({ enlisted_on: null })]]) {
  test(`faction warfare rejects ${label} without inferring enrollment`, async () => {
    const result = await harness({ read: async args => response(args, data) }).read('synthetic-owner', requests[2]); assert.equal(result.status, 'error'); assert.equal(result.metrics.length, 0); assert.equal(result.rows.length, 0); assert(!/not enlisted/i.test(result.message));
  });
}

test('unknown envelopes, mismatched identities and unexpected pagination fail without values', async () => {
  for (const override of [{ characterId: characterId + 1 }, { dataset: 'mail' }, { entity: 'corporation' }, { retrievedAt: 'bad date' }, { pagination: { kind: 'page', page: 1, pages: 1 } }, { pagination: null }, { pagination: {} }]) {
    const result = await harness({ read: async args => ({ ...response(args), ...override }) }).read('synthetic-owner', requests[0]); assert.equal(result.status, 'error'); assert.equal(result.metrics.length, 0); assert.equal(result.rows.length, 0);
  }
});

test('freshness reflects expired caches while invalid cache headers are omitted', async () => {
  const stale = await harness({ read: async args => ({ ...response(args), cacheExpires: '2025-12-31T23:59:00Z' }) }).read('synthetic-owner', requests[0]);
  assert.equal(stale.status, 'partial'); assert.equal(stale.coverage, 'complete'); assert.match(stale.message, /cache expiry/);
  const unknown = await harness({ read: async args => ({ ...response(args), cacheExpires: 'OMIT_PRIVATE_FIELDS'.repeat(10) }) }).read('synthetic-owner', requests[0]); assert.equal(unknown.cacheExpires, null); assert.equal(unknown.status, 'ready');
});

test('provider role/auth/rate/errors remain private and never fabricate statistics', async () => {
  for (const status of [401, 403, 404, 409, 429, 500, 502]) {
    const result = await harness({ read: async (args, signal, EveError) => { throw new EveError('OMIT_PRIVATE_FIELDS', status); } }).read('synthetic-owner', requests[2]);
    assert.equal(result.status, [500, 502].includes(status) ? 'error' : 'unavailable'); assert.equal(result.rows.length, 0); assert.equal(result.metrics.length, 0); assert(!result.message.includes('OMIT_PRIVATE_FIELDS')); assert(!/not enlisted/i.test(result.message));
  }
});

test('upstream faction warfare 404 differs from a missing local connection and does not prove non-enrollment', async () => {
  const remote = await harness({ read: async (args, signal, EveError) => { throw new EveError('OMIT_PRIVATE_FIELDS', 502, undefined, 404); } }).read('synthetic-owner', requests[2]);
  assert.equal(remote.status, 'unavailable'); assert.match(remote.message, /does not establish enrollment/); assert.equal(remote.rows.length, 0); assert.equal(remote.metrics.length, 0);
  const local = harness({ connections: [] }); await assert.rejects(local.read('synthetic-owner', requests[2]), error => error.status === 404); assert.equal(local.calls.length, 1);
});

test('cancellation before ownership checks stops all provider work', async () => {
  const controller = new AbortController(); controller.abort(); const h = harness(); await assert.rejects(h.read('synthetic-owner', requests[0], { signal: controller.signal })); assert.equal(h.calls.length, 0);
});

test('cancellation after ownership lookup and during provider reads cannot return stale data', async () => {
  const afterOwnership = harness({ connected: deadline => { deadline.abort(); return [{ characterId, scopes: Object.values(scopes) }]; } });
  await assert.rejects(afterOwnership.read('synthetic-owner', requests[0])); assert.equal(afterOwnership.calls.length, 1);
  for (const request of requests) {
    const h = harness({ read: async (args, signal, EveError, deadline) => { deadline.abort(); return response(args); } });
    const result = await h.read('synthetic-owner', request); assert.equal(result.status, 'unavailable'); assert.equal(result.metrics.length, 0); assert.equal(result.rows.length, 0); assert.match(result.message, /cancelled/); assert.equal(h.calls.length, 2);
  }
});

test('industry selectors reject hidden detail, identity and invalid page or slice parameters before provider work', async () => {
  const invalid = [
    { view: 'blueprints', page: 0 }, { view: 'blueprints', page: 501 }, { view: 'blueprints', page: 1.5 }, { view: 'blueprints', page: '1' },
    { view: 'blueprints', offset: 99 }, { view: 'blueprints', offset: 10000 }, { view: 'blueprints', locationId: 60000001 },
    { view: 'research', page: 1 }, { view: 'research', agentId: 3001 }, { view: 'research', offset: -100 },
    { view: 'planets', page: 1 }, { view: 'planets', planetId: 40000001 }, { view: 'planets', includeLayout: true },
    { view: 'blueprints', includeNames: true }, { view: 'research', includeNames: true }, { view: 'planets', ownerId: characterId },
  ];
  for (const input of invalid) {
    const h = harness(); await assert.rejects(h.read('synthetic-owner', { characterId, ...input }), error => error.status === 400); assert.equal(h.calls.length, 0);
  }
});

test('blueprints separate original, copy and original-stack semantics without manufacturing totals', async () => {
  const data = [blueprint(1003, { quantity: 4, runs: -1 }), blueprint(1002, { quantity: -1, runs: -1 }), blueprint(1001, { quantity: -2, runs: 0 })];
  const result = await harness({ read: async args => response(args, data) }).read('synthetic-owner', requests[3]);
  assert.equal(result.status, 'ready'); assert.equal(result.coverage, 'complete');
  assert.deepEqual(plain(result.rows.map(row => [row.id, row.cells.kind, row.cells.units, row.cells.runs])), [['1001', 'Copy', 1, 0], ['1002', 'Original', 1, 'Unlimited (original)'], ['1003', 'Original stack', 4, 'Unlimited (original)']]);
  assert.deepEqual(plain(result.metrics.map(metric => metric.value)), [3, 1, 1, 1]);
  assert.deepEqual(Object.keys(result.rows[0].cells), ['item', 'type', 'kind', 'units', 'materialEfficiency', 'timeEfficiency', 'runs', 'location', 'flag']);
  assert.match(result.message, /not manufacturing output/); assert.match(result.message, /not resolved/); assert.match(result.message, /profit is inferred/);
});

test('blueprints finish bounded slices within one provider page before advancing one page', async () => {
  const h = harness({ read: async args => ({ ...response(args, Array.from({ length: args.parameters.page === 1 ? 201 : 1 }, (_, i) => blueprint(i + 1))), pagination: { kind: 'page', page: args.parameters.page, pages: 2, nextPage: args.parameters.page === 1 ? 2 : null } }) });
  const first = await h.read('synthetic-owner', requests[3]);
  assert.equal(first.rows.length, 100); assert.equal(first.metrics[0].value, 201); assert.equal(first.coverage, 'partial'); assert.deepEqual(plain(first.next), { ...requests[3], page: 1, offset: 100 });
  const second = await h.read('synthetic-owner', first.next); assert.equal(second.rows.length, 100); assert.deepEqual(plain(second.next), { ...requests[3], page: 1, offset: 200 });
  const third = await h.read('synthetic-owner', second.next); assert.equal(third.rows.length, 1); assert.deepEqual(plain(third.next), { ...requests[3], page: 2, offset: 0 });
  const last = await h.read('synthetic-owner', third.next); assert.equal(last.rows.length, 1); assert.equal(last.next, null); assert.equal(last.coverage, 'partial'); assert.equal(last.status, 'partial');
  const reads = h.calls.filter(call => call.operation === 'character'); assert.equal(reads.length, 4);
  assert.deepEqual(plain(reads.map(call => call.args)), [1, 1, 1, 2].map(page => ({ characterId, dataset: 'blueprints', parameters: { page } })));
  assert.match(first.message, /not a complete character inventory/); assert.match(last.message, /not a complete character inventory/);
});

test('blueprint unknown page counts remain unknown while local slices can continue', async () => {
  for (const pages of [null, undefined]) {
    const h = harness({ read: async args => ({ ...response(args, Array.from({ length: 101 }, (_, i) => blueprint(i + 1))), pagination: { kind: 'page', page: 1, pages, nextPage: null } }) });
    const first = await h.read('synthetic-owner', requests[3]); assert.equal(first.coverage, 'unknown'); assert.equal(first.status, 'partial'); assert.deepEqual(plain(first.next), { ...requests[3], page: 1, offset: 100 });
    const last = await h.read('synthetic-owner', first.next); assert.equal(last.coverage, 'unknown'); assert.equal(last.next, null); assert.equal(last.rows.length, 1); assert.match(last.message, /full page count is unknown/);
  }
});

test('blueprint empty known pages and obsolete offsets keep accurate coverage', async () => {
  const h = harness({ read: async args => response(args, []) });
  const empty = await h.read('synthetic-owner', requests[3]); assert.equal(empty.status, 'ready'); assert.equal(empty.coverage, 'complete'); assert.equal(empty.metrics[0].value, 0); assert.equal(empty.next, null);
  const obsolete = await h.read('synthetic-owner', { ...requests[3], offset: 100 }); assert.equal(obsolete.coverage, 'unknown'); assert.equal(obsolete.metrics.length, 0); assert.equal(obsolete.rows.length, 0); assert.equal(obsolete.next, null);
  const multiple = await harness({ read: async args => ({ ...response(args, []), pagination: { kind: 'page', page: 1, pages: 2, nextPage: 2 } }) }).read('synthetic-owner', requests[3]);
  assert.equal(multiple.coverage, 'partial'); assert.deepEqual(plain(multiple.next), { ...requests[3], page: 2, offset: 0 });
});

test('blueprint safety boundary allows final local slice but never guesses complete inventory', async () => {
  for (const pages of [500, 501, null]) {
    const result = await harness({ read: async args => ({ ...response(args, Array.from({ length: 10000 }, (_, i) => blueprint(i + 1))), pagination: { kind: 'page', page: 500, pages, nextPage: null } }) }).read('synthetic-owner', { ...requests[3], page: 500, offset: 9900 });
    assert.equal(result.rows.length, 100); assert.equal(result.next, null); assert.equal(result.coverage, pages === null ? 'unknown' : 'partial');
    if (pages !== 500) assert.match(result.message, /500-page safety limit/);
  }
  const oversized = await harness({ read: async args => response(args, Array.from({ length: 10001 }, (_, i) => blueprint(i + 1))) }).read('synthetic-owner', requests[3]);
  assert.equal(oversized.status, 'error'); assert.equal(oversized.metrics.length, 0); assert.equal(oversized.rows.length, 0);
});

test('blueprint page metadata must match selection and exact safe continuation', async () => {
  const invalid = [null, {}, { kind: 'none' }, { kind: 'page', page: 2, pages: 2 }, { kind: 'page', page: '1', pages: 1 }, { kind: 'page', page: 1, pages: 0 }, { kind: 'page', page: 1, pages: 1.5 }, { kind: 'page', page: 1, pages: '1' }, { kind: 'page', page: 1, pages: Number.MAX_SAFE_INTEGER + 1 }, { kind: 'page', page: 1, pages: 2 }, { kind: 'page', page: 1, pages: 2, nextPage: 3 }, { kind: 'page', page: 1, pages: null, nextPage: 2 }, { kind: 'page', page: 1, pages: 1, nextPage: 2 }];
  for (const pagination of invalid) {
    const result = await harness({ read: async args => ({ ...response(args), pagination }) }).read('synthetic-owner', requests[3]);
    assert.equal(result.status, 'error'); assert.equal(result.metrics.length, 0); assert.equal(result.rows.length, 0); assert.equal(result.next, null);
  }
});

for (const [label, data] of [
  ['duplicate item', [blueprint(), blueprint()]], ['zero quantity', [blueprint(1001, { quantity: 0 })]], ['unknown negative quantity', [blueprint(1001, { quantity: -3 })]],
  ['fractional stack', [blueprint(1001, { quantity: 1.5 })]], ['unlimited copy', [blueprint(1001, { runs: -1 })]], ['finite original', [blueprint(1001, { quantity: -1, runs: 1 })]],
  ['finite original stack', [blueprint(1001, { quantity: 2, runs: 1 })]], ['negative efficiency', [blueprint(1001, { material_efficiency: -1 })]], ['missing efficiency', [blueprint(1001, { time_efficiency: undefined })]],
  ['invalid item', [blueprint(0)]], ['invalid type', [blueprint(1001, { type_id: 0 })]], ['invalid location', [blueprint(1001, { location_id: Number.MAX_SAFE_INTEGER + 1 })]],
  ['free text flag', [blueprint(1001, { location_flag: 'OMIT_PRIVATE_FIELDS' })]], ['flag with padding', [blueprint(1001, { location_flag: ' Hangar' })]], ['missing flag', [blueprint(1001, { location_flag: undefined })]],
]) {
  test(`blueprints reject ${label} with no partial projection`, async () => {
    const result = await harness({ read: async args => response(args, data) }).read('synthetic-owner', requests[3]); assert.equal(result.status, 'error'); assert.equal(result.metrics.length, 0); assert.equal(result.rows.length, 0); assert(!JSON.stringify(result).includes('OMIT_PRIVATE_FIELDS'));
  });
}

test('research preserves reported signed and tiny fractional inputs without accrued balance math', async () => {
  const result = await harness({ read: async args => response(args, [researchAgent(3002, { points_per_day: 1e-10, remainder_points: -1e-10 }), researchAgent(3001)]) }).read('synthetic-owner', requests[4]);
  assert.equal(result.status, 'ready'); assert.deepEqual(plain(result.rows.map(row => row.cells)), [{ agent: 3001, skill: 4001, started: stamp, daily: 12.5, remainder: -1.25 }, { agent: 3002, skill: 4001, started: stamp, daily: 1e-10, remainder: -1e-10 }]);
  assert.deepEqual(plain(result.metrics), [{ label: 'Research agents returned', value: 2, unit: 'count' }]);
  assert.equal(result.columns[3].unit, 'RP/day'); assert.equal(result.columns[4].unit, 'RP'); assert.equal(result.columns[4].label, 'Reported remainder');
  assert.match(result.message, /No accrued, current, redeemable or lifetime/); assert.match(result.message, /not added together/);
});

for (const [label, data] of [
  ['duplicate agent', [researchAgent(), researchAgent(3001, { skill_type_id: 4002 })]], ['negative rate', [researchAgent(3001, { points_per_day: -1 })]],
  ['nonfinite rate', [researchAgent(3001, { points_per_day: Infinity })]], ['NaN remainder', [researchAgent(3001, { remainder_points: NaN })]],
  ['unsafe remainder', [researchAgent(3001, { remainder_points: -Number.MAX_SAFE_INTEGER - 1 })]], ['string remainder', [researchAgent(3001, { remainder_points: '1' })]],
  ['missing rate', [researchAgent(3001, { points_per_day: undefined })]], ['invalid skill', [researchAgent(3001, { skill_type_id: 0 })]],
  ['local start date', [researchAgent(3001, { started_at: '2026-01-01T00:00:00' })]], ['rollover start date', [researchAgent(3001, { started_at: '2026-02-30T00:00:00Z' })]],
]) {
  test(`research rejects ${label} without assuming research balance`, async () => {
    const result = await harness({ read: async args => response(args, data) }).read('synthetic-owner', requests[4]); assert.equal(result.status, 'error'); assert.equal(result.metrics.length, 0); assert.equal(result.rows.length, 0);
  });
}

test('colonies expose only owner-bound summary metadata for the eight reported planet types', async () => {
  const kinds = ['temperate', 'barren', 'oceanic', 'ice', 'gas', 'lava', 'storm', 'plasma'];
  const result = await harness({ read: async args => response(args, kinds.map((planet_type, index) => planet(index + 1, { planet_type, upgrade_level: index, num_pins: index, pins: ['OMIT_PRIVATE_FIELDS'], routes: ['OMIT_PRIVATE_FIELDS'], layout: 'OMIT_PRIVATE_FIELDS' }))) }).read('synthetic-owner', requests[5]);
  assert.equal(result.status, 'ready'); assert.deepEqual(plain(result.rows.map(row => row.cells.type)), kinds); assert.equal(result.metrics[0].value, 8);
  assert.deepEqual(plain(result.rows[0].cells), { planet: 1, system: 30000001, type: 'temperate', upgrade: 0, pins: 0, updated: stamp });
  assert(!/OMIT_PRIVATE_FIELDS|owner_id|layout|routes/.test(JSON.stringify(result.rows))); assert.match(result.message, /not proof of current extraction/); assert.match(result.message, /no production forecast/);
});

for (const [label, data] of [
  ['other owner', [planet(40000001, { owner_id: characterId + 1 })]], ['string owner', [planet(40000001, { owner_id: String(characterId) })]], ['missing owner', [planet(40000001, { owner_id: undefined })]],
  ['duplicate planet', [planet(), planet()]], ['invalid system', [planet(40000001, { solar_system_id: 0 })]], ['unknown planet type', [planet(40000001, { planet_type: 'OMIT_PRIVATE_FIELDS' })]],
  ['negative upgrade', [planet(40000001, { upgrade_level: -1 })]], ['fractional pin count', [planet(40000001, { num_pins: 1.5 })]], ['unsafe pin count', [planet(40000001, { num_pins: Number.MAX_SAFE_INTEGER + 1 })]],
  ['missing pin count', [planet(40000001, { num_pins: undefined })]], ['local update', [planet(40000001, { last_update: '2026-01-01T00:00:00' })]], ['invalid update', [planet(40000001, { last_update: null })]],
]) {
  test(`colonies reject ${label} without leaking partial locations`, async () => {
    const result = await harness({ read: async args => response(args, data) }).read('synthetic-owner', requests[5]); assert.equal(result.status, 'error'); assert.equal(result.metrics.length, 0); assert.equal(result.rows.length, 0); assert(!JSON.stringify(result).includes('OMIT_PRIVATE_FIELDS'));
  });
}

test('industry validates every row beyond the visible slice before returning any summary', async () => {
  for (const [view, make, override] of [['blueprints', blueprint, { location_flag: 'OMIT_PRIVATE_FIELDS' }], ['research', researchAgent, { points_per_day: NaN }], ['planets', planet, { owner_id: characterId + 1 }]]) {
    const data = Array.from({ length: 101 }, (_, index) => make(index + 1, index === 100 ? override : {}));
    const result = await harness({ read: async args => response(args, data) }).read('synthetic-owner', { characterId, view });
    assert.equal(result.status, 'error'); assert.equal(result.rows.length, 0); assert.equal(result.metrics.length, 0);
  }
});

test('mining preserves date/type/system quantities without mixing types or inventing lifetime coverage', async () => {
  const data = [miningRecord(35, { quantity: 0 }), miningRecord(34, { date: '2024-02-29', quantity: Number.MAX_SAFE_INTEGER }), miningRecord(34, { solar_system_id: 30000002, quantity: 7 }), miningRecord(34)];
  const result = await harness({ read: async args => response(args, data) }).read('synthetic-owner', requests[6]);
  assert.equal(result.status, 'ready'); assert.equal(result.coverage, 'complete');
  assert.deepEqual(plain(result.metrics), [{ label: 'Mining records in this page', value: 4, unit: 'count' }, { label: 'Types in this page', value: 2, unit: 'count' }, { label: 'Solar systems in this page', value: 2, unit: 'count' }]);
  assert.deepEqual(plain(result.rows[0]), { id: '2025-12-31-34-30000001', cells: { date: '2025-12-31', type: 34, system: 30000001, quantity: 1234 } });
  assert.equal(result.rows[2].cells.quantity, 0); assert.equal(result.rows[3].cells.quantity, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(plain(result.columns), [{ key: 'date', label: 'Date (UTC)' }, { key: 'type', label: 'Type ID' }, { key: 'system', label: 'Solar system ID' }, { key: 'quantity', label: 'Quantity', unit: 'count' }]);
  assert.match(result.message, /past-30-day/); assert.match(result.message, /not all-time/); assert.match(result.message, /Quantities stay separate/); assert.match(result.message, /no observer or corporation mining read/);
  assert.equal(result.labels, undefined); assert(!JSON.stringify(result).includes('OMIT_PRIVATE_FIELDS'));
});

test('mining slices precede pages and explicit public-label choice survives each continuation', async () => {
  for (const resolveNames of [true, false]) {
    const h = harness({ read: async args => ({ ...response(args, Array.from({ length: args.parameters.page === 1 ? 101 : 1 }, (_, index) => miningRecord(index + 1))), pagination: { kind: 'page', page: args.parameters.page, pages: 2, nextPage: args.parameters.page === 1 ? 2 : null } }) });
    const first = await h.read('synthetic-owner', { ...requests[6], resolveNames }); assert.equal(first.rows.length, 100); assert.equal(first.metrics[0].value, 101); assert.equal(first.coverage, 'partial');
    assert.deepEqual(plain(first.next), { ...requests[6], resolveNames, page: 1, offset: 100 });
    const second = await h.read('synthetic-owner', first.next); assert.equal(second.rows.length, 1); assert.deepEqual(plain(second.next), { ...requests[6], resolveNames, page: 2, offset: 0 });
    const last = await h.read('synthetic-owner', second.next); assert.equal(last.next, null); assert.equal(last.coverage, 'partial');
    assert.deepEqual(plain(h.calls.filter(call => call.operation === 'character').map(call => call.args)), [1, 1, 2].map(page => ({ characterId, dataset: 'mining', parameters: { page } })));
    assert.equal(h.calls.filter(call => call.operation === 'publicNames').length, resolveNames ? 3 : 0);
  }
});

test('mining unknown pages, empty results and obsolete slices do not imply a complete history', async () => {
  const unknown = harness({ read: async args => ({ ...response(args, Array.from({ length: 101 }, (_, index) => miningRecord(index + 1))), pagination: { kind: 'page', page: 1, pages: null, nextPage: null } }) });
  const first = await unknown.read('synthetic-owner', requests[6]); assert.equal(first.coverage, 'unknown'); assert.deepEqual(plain(first.next), { ...requests[6], page: 1, offset: 100 });
  const last = await unknown.read('synthetic-owner', first.next); assert.equal(last.next, null); assert.equal(last.coverage, 'unknown'); assert.match(last.message, /full page count is unknown/);
  const empty = harness({ read: async args => response(args, []) });
  const result = await empty.read('synthetic-owner', { ...requests[6], resolveNames: true }); assert.equal(result.status, 'ready'); assert.deepEqual(plain(result.metrics.map(metric => metric.value)), [0, 0, 0]); assert.equal(result.labels, undefined); assert.equal(empty.calls.length, 2);
  const obsolete = await empty.read('synthetic-owner', { ...requests[6], offset: 100, resolveNames: true }); assert.equal(obsolete.coverage, 'unknown'); assert.equal(obsolete.rows.length, 0); assert.equal(obsolete.metrics.length, 0); assert.equal(obsolete.labels, undefined); assert.equal(obsolete.next, null);
});

test('mining validates page metadata and safety boundaries before any public enrichment', async () => {
  for (const pagination of [null, {}, { kind: 'none' }, { kind: 'page', page: 2, pages: 2 }, { kind: 'page', page: 1, pages: 0 }, { kind: 'page', page: 1, pages: '1' }, { kind: 'page', page: 1, pages: 2 }, { kind: 'page', page: 1, pages: 2, nextPage: 3 }, { kind: 'page', page: 1, pages: null, nextPage: 2 }]) {
    const h = harness({ read: async args => ({ ...response(args), pagination }) }); const result = await h.read('synthetic-owner', { ...requests[6], resolveNames: true });
    assert.equal(result.status, 'error'); assert.equal(result.rows.length, 0); assert.equal(result.labels, undefined); assert.equal(h.calls.length, 2);
  }
  for (const pages of [500, 501, null]) {
    const result = await harness({ read: async args => ({ ...response(args, Array.from({ length: 10000 }, (_, index) => miningRecord(index + 1))), pagination: { kind: 'page', page: 500, pages, nextPage: null } }) }).read('synthetic-owner', { ...requests[6], page: 500, offset: 9900 });
    assert.equal(result.rows.length, 100); assert.equal(result.next, null); assert.equal(result.coverage, pages === null ? 'unknown' : 'partial'); if (pages !== 500) assert.match(result.message, /500-page safety limit/);
  }
  const oversized = await harness({ read: async args => response(args, Array.from({ length: 10001 }, (_, index) => miningRecord(index + 1))) }).read('synthetic-owner', requests[6]); assert.equal(oversized.status, 'error'); assert.equal(oversized.rows.length, 0);
});

for (const [label, override] of [
  ['missing date', { date: undefined }], ['timestamp date', { date: '2025-12-31T00:00:00Z' }], ['unpadded date', { date: '2025-2-1' }],
  ['rollover day', { date: '2025-02-30' }], ['nonleap day', { date: '2025-02-29' }], ['rollover month', { date: '2025-13-01' }], ['zero day', { date: '2025-01-00' }],
  ['zero type', { type_id: 0 }], ['string type', { type_id: '34' }], ['unsafe type', { type_id: Number.MAX_SAFE_INTEGER + 1 }], ['zero system', { solar_system_id: 0 }],
  ['negative quantity', { quantity: -1 }], ['fractional quantity', { quantity: 0.5 }], ['string quantity', { quantity: '10' }], ['unsafe quantity', { quantity: Number.MAX_SAFE_INTEGER + 1 }], ['nonfinite quantity', { quantity: Infinity }],
]) test(`mining rejects ${label}, including invalid rows outside the displayed slice`, async () => {
  const h = harness({ read: async args => response(args, [...Array.from({ length: 100 }, (_, index) => miningRecord(index + 1)), miningRecord(1001, override)]) });
  const result = await h.read('synthetic-owner', { ...requests[6], resolveNames: true }); assert.equal(result.status, 'error'); assert.equal(result.rows.length, 0); assert.equal(result.metrics.length, 0); assert.equal(result.labels, undefined); assert.equal(h.calls.length, 2);
});

test('mining rejects duplicate date/type/system tuples instead of combining quantities', async () => {
  const result = await harness({ read: async args => response(args, [miningRecord(), miningRecord(34, { quantity: 8 })]) }).read('synthetic-owner', requests[6]); assert.equal(result.status, 'error'); assert.equal(result.rows.length, 0); assert.equal(result.metrics.length, 0);
});

test('new selectors reject injected lookup IDs, nonboolean choices and unrelated dataset parameters before reads', async () => {
  for (const input of [
    { view: 'mining', page: 0 }, { view: 'mining', page: 501 }, { view: 'mining', offset: 1 }, { view: 'mining', offset: 10000 }, { view: 'mining', fromDate: '2025-01-01' }, { view: 'mining', typeId: 34 },
    ...['standings', 'loyalty_points', 'faction_warfare'].map(view => ({ view, resolveNames: true })),
    ...['blueprints', 'research', 'planets', 'mining'].flatMap(view => [{ view, resolveNames: 'true' }, { view, resolveNames: null }, { view, resolveNames: 1 }, { view, resolveNames: true, ids: [34] }, { view, resolveNames: true, labels: [] }]),
  ]) { const h = harness(); await assert.rejects(h.read('synthetic-owner', { characterId, ...input }), error => error.status === 400); assert.equal(h.calls.length, 0); }
});

for (const [view, expected] of [['blueprints', [100]], ['research', [4001]], ['planets', [30000001]], ['mining', [34, 30000001]]]) {
  test(`${view} public labels are optional and transmit only fixed public fields from authorized rows`, async () => {
    for (const resolveNames of [undefined, false, true]) {
      const h = harness(), result = await h.read('synthetic-owner', { characterId, view, ...(resolveNames === undefined ? {} : { resolveNames }) });
      const lookups = h.calls.filter(call => call.operation === 'publicNames'); assert.equal(lookups.length, resolveNames === true ? 1 : 0);
      if (resolveNames !== true) { assert.equal(result.labels, undefined); continue; }
      assert.deepEqual(plain(lookups[0].ids), expected); assert.equal(lookups[0].signal, h.calls[1].signal); assert.equal(result.labels.status, 'ready'); assert.equal(result.labels.names.length, expected.length); assert.equal(result.labels.retrievedAt, stamp); assert.equal(result.labels.cacheExpires, '2026-01-01T00:05:00.000Z');
      for (const key of ['item', 'type', 'skill', 'system', 'planet', 'agent', 'location']) if (typeof result.rows[0].cells[key] === 'number') assert(Number.isSafeInteger(result.rows[0].cells[key]));
      assert.equal(result.status, 'ready'); assert.equal(result.coverage, 'complete');
    }
  });
}

test('public labels are derived only from the visible mining slice and fit one 200-ID request', async () => {
  const h = harness({ read: async args => response(args, Array.from({ length: 200 }, (_, index) => miningRecord(index + 1, { solar_system_id: 30000001 + index }))) });
  const result = await h.read('synthetic-owner', { ...requests[6], offset: 100, resolveNames: true });
  const lookups = h.calls.filter(call => call.operation === 'publicNames'); assert.equal(lookups.length, 1); assert.equal(lookups[0].ids.length, 200); assert.equal(result.labels.names.length, 200);
  assert(lookups[0].ids.every(id => id >= 101 && id <= 200 || id >= 30000101 && id <= 30000200)); assert(!lookups[0].ids.includes(characterId));
});

test('public names deduplicate repeated types and never transmit private location or agent IDs', async () => {
  for (const [view, data, expected] of [['blueprints', [blueprint(90001), blueprint(90002)], [100]], ['research', [researchAgent(90001), researchAgent(90002)], [4001]], ['planets', [planet(40000001), planet(40000002)], [30000001]]]) {
    const h = harness({ read: async args => response(args, data) }); const result = await h.read('synthetic-owner', { characterId, view, resolveNames: true });
    assert.deepEqual(plain(h.calls.find(call => call.operation === 'publicNames').ids), expected); assert.equal(result.labels.status, 'ready');
  }
});

test('missing public names and expired public data retain numeric rows with separate partial-label status', async () => {
  for (const data of [[], [{ id: 34, category: 'inventory_type', name: 'Synthetic Ore' }]]) {
    const h = harness({ publicNames: async () => ({ data, retrievedAt: stamp, cacheExpires: null }) }); const result = await h.read('synthetic-owner', { ...requests[6], resolveNames: true });
    assert.equal(result.labels.status, 'partial'); assert.equal(result.labels.names.length, data.length); assert.equal(result.status, 'ready'); assert.equal(result.rows[0].cells.type, 34); assert.equal(result.rows[0].cells.system, 30000001);
  }
  const stale = await harness({ publicNames: async ids => ({ data: ids.map(id => ({ id, category: 'inventory_type', name: 'Synthetic blueprint' })), retrievedAt: stamp, cacheExpires: '2025-12-31T23:59:00Z' }) }).read('synthetic-owner', { ...requests[3], resolveNames: true });
  assert.equal(stale.status, 'ready'); assert.equal(stale.labels.status, 'partial'); assert.match(stale.labels.message, /cache expiry/);
});

for (const [label, data] of [
  ['foreign ID', [{ id: characterId, category: 'inventory_type', name: 'OMIT_PRIVATE_FIELDS' }]], ['private category', [{ id: 34, category: 'character', name: 'OMIT_PRIVATE_FIELDS' }]],
  ['wrong public category', [{ id: 34, category: 'solar_system', name: 'OMIT_PRIVATE_FIELDS' }]], ['duplicate ID', [{ id: 34, category: 'inventory_type', name: 'Synthetic Ore' }, { id: 34, category: 'inventory_type', name: 'OMIT_PRIVATE_FIELDS' }]],
  ['blank name', [{ id: 34, category: 'inventory_type', name: '  ' }]], ['oversize name', [{ id: 34, category: 'inventory_type', name: 'X'.repeat(513) }]], ['control name', [{ id: 34, category: 'inventory_type', name: 'bad\nname' }]], ['bidi name', [{ id: 34, category: 'inventory_type', name: 'bad\u202ename' }]],
]) test(`public labels reject ${label} without discarding valid private rows or exposing upstream text`, async () => {
  const h = harness({ publicNames: async () => ({ data, retrievedAt: stamp, cacheExpires: null }) }); const result = await h.read('synthetic-owner', { ...requests[6], resolveNames: true });
  assert.equal(result.status, 'ready'); assert.equal(result.rows.length, 1); assert.equal(result.labels.status, 'unavailable'); assert.equal(result.labels.names.length, 0); assert.equal(result.labels.retrievedAt, null); assert.equal(result.labels.cacheExpires, null); assert(!JSON.stringify(result).includes('OMIT_PRIVATE_FIELDS')); assert.equal(h.calls.length, 3);
});

test('public names validate metadata, sanitize transport failures and do not retry', async () => {
  for (const value of [null, {}, { data: [], retrievedAt: 'bad' }, { data: {}, retrievedAt: stamp }]) {
    const h = harness({ publicNames: async () => value }); const result = await h.read('synthetic-owner', { ...requests[6], resolveNames: true }); assert.equal(result.labels.status, 'unavailable'); assert.equal(result.status, 'ready'); assert.equal(h.calls.length, 3);
  }
  const h = harness({ publicNames: async () => { throw new Error('OMIT_PRIVATE_FIELDS'); } }); const result = await h.read('synthetic-owner', { ...requests[6], resolveNames: true }); assert.equal(result.status, 'ready'); assert.equal(result.labels.status, 'unavailable'); assert.equal(h.calls.length, 3); assert(!JSON.stringify(result).includes('OMIT_PRIVATE_FIELDS'));
});

test('derived category collisions fail enrichment before sending an ambiguous public ID', async () => {
  const h = harness({ read: async args => response(args, [miningRecord(34, { solar_system_id: 34 })]) }); const result = await h.read('synthetic-owner', { ...requests[6], resolveNames: true });
  assert.equal(result.status, 'ready'); assert.equal(result.labels.status, 'unavailable'); assert.equal(h.calls.length, 2); assert.equal(result.rows[0].cells.quantity, 1234);
});

test('public labels never run for denied, invalid, empty or obsolete private results', async () => {
  for (const options of [
    { connections: [{ characterId, scopes: [] }] }, { read: async () => { throw new Error('OMIT_PRIVATE_FIELDS'); } }, { read: async args => response(args, [miningRecord(34, { quantity: -1 })]) }, { read: async args => response(args, []) },
  ]) { const h = harness(options); const result = await h.read('synthetic-owner', { ...requests[6], resolveNames: true }); assert.equal(result.labels, undefined); assert(!h.calls.some(call => call.operation === 'publicNames')); }
});

test('cancellation during public enrichment clears all result values and prevents any retry', async () => {
  const h = harness({ publicNames: async (ids, signal, EveError, deadline) => { deadline.abort(); return { data: [], retrievedAt: stamp }; } });
  const result = await h.read('synthetic-owner', { ...requests[6], resolveNames: true }); assert.equal(result.status, 'unavailable'); assert.equal(result.rows.length, 0); assert.equal(result.metrics.length, 0); assert.equal(result.labels, undefined); assert.equal(h.calls.length, 3);
});

test('completion-time freshness stays consistent with the strict client when the clock advances between calls', async () => {
  const client = load(compile('character-workspace-client'), { require: () => load(compile('connection-client')) });
  for (const resolveNames of [false, true]) {
    let clockCalls = 0;
    const expiry = new Date(now + 2000).toISOString();
    const h = harness({
      now: () => now + (++clockCalls * 1000),
      read: async args => ({ ...response(args), cacheExpires: expiry }),
      publicNames: async ids => ({ data: ids.map(id => ({ id, category: id === 34 ? 'inventory_type' : 'solar_system', name: 'Synthetic label' })), retrievedAt: stamp, cacheExpires: expiry }),
    });
    const request = { ...requests[6], resolveNames }, result = await h.read('synthetic-owner', request);
    assert.doesNotThrow(() => client.characterWorkspaceResponse(result, request));
    assert.equal(clockCalls, 1); assert.equal(result.generatedAt, new Date(now + 1000).toISOString()); assert.equal(result.status, 'ready');
    if (resolveNames) assert.equal(result.labels.status, 'ready');
  }
});

test('primary and label data that expire during the public read are both partial at completion', async () => {
  const client = load(compile('character-workspace-client'), { require: () => load(compile('connection-client')) });
  let current = now;
  const expiry = new Date(now + 1000).toISOString();
  const h = harness({
    now: () => current,
    read: async args => ({ ...response(args), cacheExpires: expiry }),
    publicNames: async ids => { current += 2000; return { data: ids.map(id => ({ id, category: id === 34 ? 'inventory_type' : 'solar_system', name: 'Synthetic label' })), retrievedAt: stamp, cacheExpires: expiry }; },
  });
  const request = { ...requests[6], resolveNames: true }, result = await h.read('synthetic-owner', request);
  assert.equal(result.generatedAt, new Date(now + 2000).toISOString()); assert.equal(result.status, 'partial'); assert.equal(result.labels.status, 'partial');
  assert.match(result.message, /cache expiry/); assert.match(result.labels.message, /cache expiry/);
  assert.equal(result.rows.length, 1); assert.equal(result.labels.names.length, 2);
  assert.doesNotThrow(() => client.characterWorkspaceResponse(result, request));
});

test('an expiry equal to the completion timestamp is stale for both primary data and public labels', async () => {
  const client = load(compile('character-workspace-client'), { require: () => load(compile('connection-client')) });
  const h = harness({ read: async args => ({ ...response(args), cacheExpires: stamp }), publicNames: async ids => ({ data: ids.map(id => ({ id, category: id === 34 ? 'inventory_type' : 'solar_system', name: 'Synthetic label' })), retrievedAt: stamp, cacheExpires: stamp }) });
  const request = { ...requests[6], resolveNames: true }, result = await h.read('synthetic-owner', request);
  assert.equal(result.status, 'partial'); assert.equal(result.labels.status, 'partial'); assert.equal(result.generatedAt, stamp);
  assert.doesNotThrow(() => client.characterWorkspaceResponse(result, request));
});
