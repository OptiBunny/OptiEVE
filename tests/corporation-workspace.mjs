import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const compile = name => ts.transpileModule(readFileSync(`app/lib/${name}.ts`, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const code = compile('corporation-workspace'), summaryCode = compile('overview-summary');
const now = Date.parse('2026-01-01T00:00:00Z'), stamp = new Date(now).toISOString();
const characterId = 90000001, corporationId = 98000001, projectId = 'abcdef00-0000-0000-0000-000000000001';
const grants = ['esi-wallet.read_corporation_wallets.v1', 'esi-contracts.read_corporation_contracts.v1', 'esi-corporations.read_projects.v1', 'esi-markets.read_corporation_orders.v1', 'esi-corporations.read_blueprints.v1', 'esi-corporations.read_facilities.v1', 'esi-corporations.read_structures.v1', 'esi-assets.read_corporation_assets.v1', 'esi-industry.read_corporation_mining.v1', 'esi-corporations.read_freelance_jobs.v1'];
const requests = [{ view: 'wallets', characterId }, { view: 'contracts', characterId }, { view: 'projects', characterId }, { view: 'contract_items', characterId, contractId: 1001 }, { view: 'project', characterId, projectId }, { view: 'order_history', characterId }, { view: 'blueprints', characterId }, { view: 'facilities', characterId }, { view: 'structures', characterId }, { view: 'assets', characterId }, { view: 'asset_detail', characterId, itemId: 1001, page: 1 }, { view: 'contract_bids', characterId, contractId: 1001 }, { view: 'extractions', characterId }, { view: 'freelance_jobs', characterId }];
const plain = value => JSON.parse(JSON.stringify(value));
function load(source, context = {}) {
  const fixtureModule = { exports: {} };
  vm.runInNewContext(source, { module: fixtureModule, exports: fixtureModule.exports, Date, AbortSignal, ...context });
  return fixtureModule.exports;
}
const summary = load(summaryCode);
const contract = (id = 1001, override = {}) => ({ contract_id: id, title: 'Synthetic delivery', type: 'courier', status: 'outstanding', date_expired: '2026-01-02T00:00:00Z', issuer_id: 90009999, private_marker: 'OMIT_PRIVATE_FIELDS', ...override });
const item = (id = 1001, override = {}) => ({ record_id: id, type_id: 34, quantity: 10, is_singleton: false, is_included: true, raw_quantity: -2, ...override });
const project = (override = {}) => ({ id: projectId, name: 'Synthetic project', state: 'Active', last_modified: stamp, progress: { current: 3, desired: 20 }, creator: { id: 90009999, name: 'OMIT_PRIVATE_FIELDS' }, details: { description: 'OMIT_PRIVATE_FIELDS', career: 'Industrialist', created: stamp }, configuration: { manual: {} }, ...override });
const bid = (id = 1001, override = {}) => ({ bid_id: id, amount: 123.45, date_bid: stamp, bidder_id: 90009999, private_marker: 'OMIT_PRIVATE_FIELDS', ...override });
const order = (id = 1001, override = {}) => ({ order_id: id, type_id: 34, location_id: 60000001, wallet_division: 1, region_id: 10000001, duration: 90, range: 'region', state: 'expired', price: 4.25, volume_total: 100, volume_remain: 10, issued: stamp, issued_by: 90009999, private_marker: 'OMIT_PRIVATE_FIELDS', ...override });
const blueprint = (id = 1001, override = {}) => ({ item_id: id, type_id: 10001, location_id: 60000001, location_flag: 'CorpSAG1', material_efficiency: 10, time_efficiency: 20, quantity: -2, runs: 5, private_marker: 'OMIT_PRIVATE_FIELDS', ...override });
const facility = (id = 1001, override = {}) => ({ facility_id: id, type_id: 10001, system_id: 30000001, private_marker: 'OMIT_PRIVATE_FIELDS', ...override });
const structure = (id = 1001, override = {}) => ({ structure_id: id, type_id: 10001, corporation_id: corporationId, system_id: 30000001, profile_id: 10001, state: 'shield_vulnerable', name: 'Synthetic structure', fuel_expires: '2026-01-02T00:00:00Z', state_timer_end: '2026-01-03T00:00:00Z', services: [{ name: 'Manufacturing', state: 'online' }, { name: 'Research', state: 'offline' }], private_marker: 'OMIT_PRIVATE_FIELDS', ...override });
const asset = (id = 1001, override = {}) => ({ item_id: id, type_id: 10001, quantity: 1, location_id: 60000001, location_type: 'station', location_flag: 'CorpSAG1', is_singleton: true, private_marker: 'OMIT_PRIVATE_FIELDS', ...override });
const extraction = (id = 1001, override = {}) => ({ structure_id: id, moon_id: 40000001, extraction_start_time: '2025-12-31T00:00:00Z', chunk_arrival_time: '2026-01-02T00:00:00Z', natural_decay_time: '2026-01-04T00:00:00Z', private_marker: 'OMIT_PRIVATE_FIELDS', ...override });
const freelance = (override = {}) => ({ id: projectId, name: 'Synthetic freelance job', state: 'Active', last_modified: stamp, progress: { current: 3, desired: 20 }, reward: { initial: 1000, remaining: 800 }, creator: { id: 90009999, name: 'OMIT_PRIVATE_FIELDS' }, description: 'OMIT_PRIVATE_FIELDS', ...override });
const publicNames = ids => ({ data: ids.map(id => ({ id, name: `Synthetic public ${id}`, category: id >= 30000000 ? 'solar_system' : 'inventory_type' })), retrievedAt: stamp, cacheExpires: 'Thu, 01 Jan 2026 00:05:00 GMT' });
function response(args) {
  const data = args.dataset === 'wallet_balances' ? Array.from({ length: 7 }, (_, index) => ({ division: index + 1, balance: index * 10 })) : args.dataset === 'contracts' ? [contract()] : args.dataset === 'contract_items' ? [item()] : args.dataset === 'contract_bids' ? [bid()] : args.dataset === 'projects' ? { projects: [project()] } : args.dataset === 'project' ? project() : args.dataset === 'order_history' ? [order()] : args.dataset === 'blueprints' ? [blueprint()] : args.dataset === 'facilities' ? [facility()] : args.dataset === 'structures' ? [structure()] : args.dataset === 'assets' ? [asset()] : args.dataset === 'asset_names' ? [{ item_id: args.parameters.itemIds[0], name: 'Synthetic custom name' }] : args.dataset === 'asset_locations' ? [{ item_id: args.parameters.itemIds[0], position: { x: 0, y: 0, z: 0 } }] : args.dataset === 'mining_extractions' ? [extraction()] : args.dataset === 'freelance_jobs' ? { freelance_jobs: [freelance()] } : { contributed: 2, last_modified: stamp };
  return { entity: 'corporation', characterId: args.characterId, corporationId, dataset: args.dataset, data, retrievedAt: stamp, cacheExpires: 'Thu, 01 Jan 2026 00:05:00 GMT', pagination: ['contracts', 'contract_bids', 'order_history', 'blueprints', 'structures', 'assets', 'mining_extractions'].includes(args.dataset) ? { kind: 'page', page: args.parameters?.page ?? 1, pages: 1, nextPage: null } : args.dataset === 'projects' || args.dataset === 'freelance_jobs' ? { kind: 'cursor', after: null, before: null } : { kind: 'none' } };
}
function harness(options = {}) {
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const calls = [], deadline = new AbortController();
  const deps = {
    connections: async user => { calls.push({ operation: 'connections', user }); return options.connections ?? [{ characterId, scopes: grants }]; },
    corporation: async (user, args, signal) => { calls.push({ operation: 'corporation', user, args, signal }); return options.read ? options.read(args, signal, EveError, deadline) : response(args); },
    publicNames: async (ids, signal) => { calls.push({ operation: 'publicNames', ids: [...ids], signal }); return options.publicNames ? options.publicNames(ids, signal, EveError, deadline) : publicNames(ids); },
    now: () => now,
  };
  const service = load(code, { require: path => path === './overview-summary' ? summary : { EveError, listConnections: deps.connections, readCorporationData: deps.corporation, readPublicNames: deps.publicNames }, AbortSignal: { any: AbortSignal.any.bind(AbortSignal), timeout: milliseconds => { assert.equal(milliseconds, 55000); return deadline.signal; } } });
  return { read: service.createCorporationWorkspaceReader(deps), calls, deadline };
}

test('extraction and freelance selectors cannot introduce detail, identity or arbitrary paging requests', async () => {
  for (const input of [
    { ...requests[12], after: 'cursor' }, { ...requests[12], page: 501 }, { ...requests[12], offset: 1 }, { ...requests[12], structureId: 1001 },
    { ...requests[13], page: 1 }, { ...requests[13], offset: 0 }, { ...requests[13], limit: 1000 }, { ...requests[13], state: 'Active' },
    { ...requests[13], jobId: projectId }, { ...requests[13], participantId: 90009999 }, { ...requests[13], after: 'two words' }, { ...requests[13], after: 'a'.repeat(513) },
  ]) { const h = harness(); await assert.rejects(h.read('synthetic-owner', input), error => error.status === 400); assert.equal(h.calls.length, 0); }
});

test('extraction table emits only schedule fields and never sends structure or moon IDs to public names', async () => {
  const h = harness(), result = await h.read('synthetic-owner', { ...requests[12], includeNames: true });
  assert.equal(result.status, 'ready'); assert.equal(result.rows[0].id, '1001');
  assert.deepEqual(plain(Object.keys(result.rows[0].cells)), ['structure', 'moon', 'start', 'arrival', 'decay', 'phase']);
  assert.equal(result.rows[0].cells.phase, 'Arrival pending'); assert.equal(result.rows[0].cells.decay, '2026-01-04T00:00:00.000Z');
  assert.equal(h.calls.length, 2); assert.deepEqual(plain(h.calls[1].args), { characterId, dataset: 'mining_extractions', parameters: { page: 1 } });
  assert(!JSON.stringify(result).includes('OMIT_PRIVATE_FIELDS')); assert.equal(result.rows[0].action, undefined);
  assert.match(result.message, /automatic fracture/); assert.match(result.message, /Neither date proves ore/);
  assert.equal(result.columns.find(column => column.key === 'decay').label, 'Natural fracture (UTC)');
});

test('extraction phases use UTC instants including exact schedule boundaries', async () => {
  const data = [extraction(1001, { extraction_start_time: '2026-01-02T00:00:00Z' }), extraction(1002, { extraction_start_time: stamp }), extraction(1003, { chunk_arrival_time: '2025-12-31T16:00:00-08:00' }), extraction(1004, { chunk_arrival_time: '2025-12-31T01:00:00Z', natural_decay_time: stamp })];
  const result = await harness({ read: async args => ({ ...response(args), data }) }).read('synthetic-owner', requests[12]);
  assert.deepEqual(plain(result.rows.map(row => row.cells.phase)), ['Start pending', 'Arrival pending', 'Arrival time passed', 'Natural fracture time passed']);
  assert.equal(result.rows[2].cells.arrival, stamp);
});

test('extraction slices bound rows and preserve manual page progression and coverage', async () => {
  const h = harness({ read: async args => ({ ...response(args), data: Array.from({ length: 101 }, (_, i) => extraction(i + 1)), pagination: { kind: 'page', page: args.parameters.page, pages: 2, nextPage: args.parameters.page === 1 ? 2 : null } }) });
  const first = await h.read('synthetic-owner', requests[12]);
  assert.equal(first.rows.length, 100); assert.equal(first.coverage, 'partial'); assert.deepEqual(plain(first.next), { ...requests[12], page: 1, offset: 100 });
  const last = await h.read('synthetic-owner', first.next); assert.equal(last.rows.length, 1); assert.deepEqual(plain(last.next), { ...requests[12], page: 2, offset: 0 });
  const unknown = await harness({ read: async args => ({ ...response(args), data: [], pagination: { kind: 'page', page: 1, pages: null } }) }).read('synthetic-owner', requests[12]);
  assert.equal(unknown.coverage, 'unknown'); assert.equal(unknown.next, null);
});

test('invalid extraction records and pagination fail without partial schedules', async () => {
  for (const override of [
    { data: [extraction(), extraction()] }, { data: [extraction(1001, { moon_id: 0 })] }, { data: [extraction(1001, { structure_id: 1.5 })] },
    { data: [extraction(1001, { extraction_start_time: '2026-02-30T00:00:00Z' })] }, { data: [extraction(1001, { natural_decay_time: '2026-01-01T00:00:00Z' })] },
    { data: Array.from({ length: 10001 }, (_, i) => extraction(i + 1)) }, { pagination: { kind: 'none' } },
    { pagination: { kind: 'page', page: 2, pages: 2 } }, { pagination: { kind: 'page', page: 1, pages: 1, nextPage: 2 } },
  ]) { const result = await harness({ read: async args => ({ ...response(args), ...override }) }).read('synthetic-owner', requests[12]); assert.equal(result.status, 'error'); assert.equal(result.rows.length, 0); assert.equal(result.sources.length, 0); }
});

test('freelance table emits job progress and optional reserves without participant details or identities', async () => {
  const h = harness({ read: async args => ({ ...response(args), data: { freelance_jobs: [freelance(), freelance({ id: 'abcdef00-0000-0000-0000-000000000002', reward: undefined, progress: { current: 10, desired: 0 } })] } }) });
  const result = await h.read('synthetic-owner', { ...requests[13], includeNames: true });
  assert.equal(result.status, 'partial'); assert.equal(result.coverage, 'unknown'); assert.equal(result.next, null);
  assert.equal(h.calls.length, 2); assert.deepEqual(plain(h.calls[1].args), { characterId, dataset: 'freelance_jobs', parameters: { limit: 100 } });
  assert.deepEqual(plain(Object.keys(result.rows[0].cells)), ['name', 'state', 'current', 'desired', 'initialReward', 'remainingReward', 'lastModified']);
  assert.equal(result.rows[0].cells.initialReward, 1000); assert.equal(result.rows[0].cells.remainingReward, 800);
  assert.equal(result.rows[1].cells.initialReward, 'Not reported'); assert.equal(result.rows[1].cells.remainingReward, 'Not reported');
  assert.equal(result.rows[1].cells.desired, 0); assert.equal(result.rows[0].action, undefined); assert.equal(result.details, undefined);
  assert(!JSON.stringify(result).includes('OMIT_PRIVATE_FIELDS')); assert(!JSON.stringify(result).includes('90009999'));
  assert.match(result.message, /not earned, claimable or paid rewards or profit/); assert.match(result.message, /not the selected character/);
});

test('freelance cursor paging is manual, bounded and cannot repeat its current cursor', async () => {
  const h = harness({ read: async args => ({ ...response(args), pagination: { kind: 'cursor', after: args.parameters.after ? null : 'synthetic-next/+=', before: null } }) });
  const first = await h.read('synthetic-owner', requests[13]); assert.deepEqual(plain(first.next), { ...requests[13], after: 'synthetic-next/+=' }); assert.equal(h.calls.length, 2);
  const second = await h.read('synthetic-owner', first.next); assert.equal(second.next, null); assert.equal(second.coverage, 'unknown'); assert.equal(h.calls.length, 4);
  for (const pagination of [{ kind: 'none' }, { kind: 'cursor', after: 'same' }, { kind: 'cursor', after: '' }, { kind: 'cursor', after: 'two words' }, { kind: 'cursor', after: 'a'.repeat(513) }, { kind: 'cursor', before: 1 }]) {
    const result = await harness({ read: async args => ({ ...response(args), pagination }) }).read('synthetic-owner', { ...requests[13], after: 'same' });
    assert.equal(result.status, 'error'); assert.equal(result.rows.length, 0);
  }
});

test('freelance unknown states, malformed optional budgets and oversized batches are not rendered', async () => {
  for (const row of [freelance({ state: 'FutureState' }), freelance({ progress: { current: -1, desired: 10 } }), freelance({ reward: null }), freelance({ reward: { initial: 1000 } }), freelance({ reward: { initial: 1000, remaining: Infinity } }), freelance({ last_modified: '2026-02-30T00:00:00Z' }), freelance({ name: '\u0000' })]) {
    const result = await harness({ read: async args => ({ ...response(args), data: { freelance_jobs: [row] } }) }).read('synthetic-owner', requests[13]); assert.equal(result.status, 'error'); assert.equal(result.rows.length, 0);
  }
  for (const data of [{}, { freelance_jobs: [freelance(), freelance({ id: projectId.toUpperCase() })] }, { freelance_jobs: Array.from({ length: 101 }, (_, i) => freelance({ id: `abcdef00-0000-0000-0000-${String(i).padStart(12, '0')}` })) }]) {
    const result = await harness({ read: async args => ({ ...response(args), data }) }).read('synthetic-owner', requests[13]); assert.equal(result.status, 'error'); assert.equal(result.rows.length, 0);
  }
  const empty = await harness({ read: async args => ({ ...response(args), data: { freelance_jobs: [] } }) }).read('synthetic-owner', requests[13]); assert.equal(empty.status, 'partial'); assert.equal(empty.coverage, 'unknown');
});

test('new views stop cleanly on revocation, role denial, rate limits and cancellation', async () => {
  for (const request of [requests[12], requests[13]]) {
    for (const status of [401, 403, 404, 409, 429]) {
      const h = harness({ read: async (_args, _signal, EveError) => { throw new EveError('OMIT_PRIVATE_FIELDS', status); } });
      const result = await h.read('synthetic-owner', request); assert.equal(result.status, 'unavailable'); assert.equal(result.rows.length, 0); assert.equal(h.calls.length, 2); assert(!JSON.stringify(result).includes('OMIT_PRIVATE_FIELDS'));
    }
    const h = harness({ read: async (args, _signal, _EveError, deadline) => { deadline.abort(); return response(args); } });
    const result = await h.read('synthetic-owner', request); assert.equal(result.status, 'unavailable'); assert.equal(result.rows.length, 0); assert.equal(result.sources.length, 0); assert.equal(h.calls.length, 2);
  }
});

test('workspace rejects malformed input and unowned overrides before storage or ESI', async () => {
  for (const input of [null, [], {}, { view: 'wallets', characterId: '90000001' }, { view: 'constructor', characterId }, { view: ['wallets'], characterId }, { view: 'wallets', characterId, corporationId }, { view: 'wallets', characterId, url: 'https://example.invalid' }, { view: 'wallets', characterId, page: 1 }, { view: 'contracts', characterId, page: 501 }, { view: 'contracts', characterId, page: 0 }, { view: 'contracts', characterId, offset: 1 }, { view: 'contracts', characterId, offset: 10000 }, { view: 'contract_items', characterId }, { view: 'contract_items', characterId, contractId: '1001' }, { view: 'project', characterId }, { view: 'project', characterId, projectId: '../secret' }, { view: 'projects', characterId, after: 'two words' }, { view: 'projects', characterId, after: 'a'.repeat(513) }, { view: 'projects', characterId, limit: 1000 }, Object.create(requests[0])]) {
    const h = harness(); await assert.rejects(h.read('synthetic-owner', input), error => error.status === 400); assert.equal(h.calls.length, 0);
  }
});
test('workspace requires a signed-in owner and owned connection', async () => {
  const signedOut = harness(); await assert.rejects(signedOut.read('', requests[0]), error => error.status === 401); assert.equal(signedOut.calls.length, 0);
  const anotherOwner = harness({ connections: [{ characterId: 90000002, scopes: grants }] }); await assert.rejects(anotherOwner.read('synthetic-owner', requests[0]), error => error.status === 404); assert.equal(anotherOwner.calls.length, 1);
});
test('each missing permission returns no rows and performs no upstream read', async () => {
  for (const request of requests) {
    const h = harness({ connections: [{ characterId, scopes: [] }] }), result = await h.read('synthetic-owner', request);
    assert.equal(h.calls.length, 1); assert.equal(result.status, 'needs_permission'); assert.equal(result.rows.length, 0); assert.equal(result.sources.length, 0); assert.equal(result.corporationId, undefined);
  }
});
test('explicit views perform only their allowlisted bounded datasets with selected character', async () => {
  for (const [index, expected] of [['wallet_balances'], ['contracts'], ['projects'], ['contract_items'], ['project', 'project_contribution'], ['order_history'], ['blueprints'], ['facilities'], ['structures'], ['assets'], ['assets', 'asset_names', 'asset_locations'], ['contract_bids'], ['mining_extractions'], ['freelance_jobs']].entries()) {
    const h = harness(), result = await h.read('synthetic-owner', requests[index]);
    assert.deepEqual(h.calls.slice(1).map(call => call.args.dataset), expected); assert.equal(result.corporationId, corporationId);
    assert(h.calls.every(call => call.user === 'synthetic-owner')); assert(h.calls.slice(1).every(call => call.args.characterId === characterId && call.signal instanceof AbortSignal));
    assert.equal(result.rows.length, index === 0 ? 7 : 1); assert.equal(result.sources.length, expected.length);
  }
});
test('new production views reject unsupported selectors before any storage or network', async () => {
  for (const input of [
    { view: 'facilities', characterId, page: 1 }, { view: 'facilities', characterId, offset: 1 }, { view: 'facilities', characterId, offset: 10000 },
    { view: 'blueprints', characterId, page: 501 }, { view: 'structures', characterId, after: 'cursor' }, { view: 'order_history', characterId, division: 2 },
    { view: 'structures', characterId, corporationId }, { view: 'blueprints', characterId, itemIds: [1001] },
  ]) { const h = harness(); await assert.rejects(h.read('synthetic-owner', input), error => error.status === 400); assert.equal(h.calls.length, 0); }
});
test('historical orders preserve quoted price and remaining volumes without claiming fills or profit', async () => {
  const h = harness({ read: async args => ({ ...response(args), data: [order(1001), order(1002, { is_buy_order: true, state: 'cancelled', volume_remain: 0 })] }) });
  const result = await h.read('synthetic-owner', requests[5]);
  assert.equal(result.rows[0].cells.side, 'Sell'); assert.equal(result.rows[1].cells.side, 'Buy'); assert.equal(result.rows[1].cells.state, 'cancelled');
  assert.equal(result.rows[0].cells.price, 4.25); assert.equal(result.rows[1].cells.volumeRemain, 0); assert.equal(result.rows[0].cells.volumeTotal, 100);
  assert(!JSON.stringify(result).includes('OMIT_PRIVATE_FIELDS')); assert(!JSON.stringify(result).includes('90009999'));
  assert(!Object.hasOwn(result.rows[0].cells, 'filled')); assert(!Object.hasOwn(result.rows[0].cells, 'profit')); assert.match(result.message, /up to 90 days/); assert.match(result.message, /do not prove fills/);
  assert.equal(h.calls.length, 2); assert.equal(result.rows[0].action, undefined);
});
test('malformed historical order fields cannot become trading conclusions', async () => {
  for (const override of [{ type_id: 0 }, { location_id: -1 }, { wallet_division: 8 }, { volume_total: -1 }, { volume_remain: 101 }, { volume_remain: 1.5 }, { price: -1 }, { price: Infinity }, { price: '4.25' }, { state: 'filled' }, { is_buy_order: 'true' }, { issued: '2026-02-30T00:00:00Z' }]) {
    const result = await harness({ read: async args => ({ ...response(args), data: [order(1001, override)] }) }).read('synthetic-owner', requests[5]);
    assert.equal(result.status, 'error'); assert.equal(result.rows.length, 0); assert.equal(result.sources.length, 0);
  }
});
test('blueprint kinds distinguish copy runs, singleton originals and original stacks', async () => {
  const result = await harness({ read: async args => ({ ...response(args), data: [blueprint(1001), blueprint(1002, { quantity: -1, runs: -1 }), blueprint(1003, { quantity: 7, runs: -1 }), blueprint(1004, { quantity: -2, runs: 0 })] }) }).read('synthetic-owner', requests[6]);
  assert.deepEqual(plain(result.rows.map(row => row.cells.kind)), ['Copy', 'Original', 'Original stack', 'Copy']);
  assert.deepEqual(plain(result.rows.map(row => row.cells.units)), [1, 1, 7, 1]);
  assert.deepEqual(plain(result.rows.map(row => row.cells.runs)), [5, 'Unlimited (original)', 'Unlimited (original)', 0]);
  assert.equal(result.rows[0].cells.materialEfficiency, 10); assert.equal(result.rows[0].cells.timeEfficiency, 20); assert.match(result.message, /Director/);
  assert(!JSON.stringify(result).includes('OMIT_PRIVATE_FIELDS')); assert.equal(result.rows[0].action, undefined);
});
test('inconsistent blueprint type, efficiency and run markers fail safely', async () => {
  for (const override of [{ quantity: 0 }, { quantity: -3 }, { quantity: 1.5 }, { quantity: -1, runs: 5 }, { quantity: 2, runs: 5 }, { quantity: -2, runs: -1 }, { material_efficiency: -1 }, { time_efficiency: 1.5 }, { runs: Number.MAX_SAFE_INTEGER + 1 }, { type_id: 0 }, { location_id: 0 }, { location_flag: null }]) {
    const result = await harness({ read: async args => ({ ...response(args), data: [blueprint(1001, override)] }) }).read('synthetic-owner', requests[6]);
    assert.equal(result.status, 'error'); assert.equal(result.rows.length, 0);
  }
});
test('facilities expose identifiers only and distinguish empty complete responses from missing permissions', async () => {
  const h = harness(), result = await h.read('synthetic-owner', requests[7]);
  assert.deepEqual(Object.keys(result.rows[0].cells), ['facility', 'type', 'system']); assert.equal(h.calls.length, 2); assert.equal(h.calls[1].args.parameters, undefined);
  assert.match(result.message, /not service availability/); assert.match(result.message, /Factory Manager/); assert(!JSON.stringify(result).includes('OMIT_PRIVATE_FIELDS'));
  const empty = await harness({ read: async args => ({ ...response(args), data: [] }) }).read('synthetic-owner', requests[7]);
  assert.equal(empty.status, 'ready'); assert.equal(empty.coverage, 'complete'); assert.equal(empty.rows.length, 0);
  const absent = await harness({ connections: [{ characterId, scopes: grants.filter(scope => !scope.includes('read_facilities')) }] }).read('synthetic-owner', requests[7]);
  assert.equal(absent.status, 'needs_permission'); assert.equal(absent.coverage, 'unavailable');
});
test('structures show actual service states and optional fields without inference or profile leakage', async () => {
  const result = await harness({ read: async args => ({ ...response(args), data: [structure(1001), structure(1002, { name: undefined, fuel_expires: undefined, services: undefined, state_timer_end: undefined }), structure(1003, { fuel_expires: '2025-12-31T00:00:00Z', services: [] })] }) }).read('synthetic-owner', requests[8]);
  assert.equal(result.rows[0].cells.services, 'Manufacturing: online; Research: offline');
  assert.equal(result.rows[1].cells.services, 'Not reported'); assert.equal(result.rows[1].cells.fuelUntil, 'Not reported'); assert.equal(result.rows[1].cells.name, 'Not reported'); assert.equal(result.rows[1].cells.timerEnd, 'Not reported');
  assert.equal(result.rows[2].cells.services, 'No services returned'); assert.equal(result.rows[2].cells.state, 'shield vulnerable');
  assert.equal(result.rows[2].cells.fuelUntil, '2025-12-31T00:00:00.000Z'); assert.match(result.message, /not proof of current fuel quantity or destruction/);
  assert(!JSON.stringify(result).includes('profile_id')); assert(!JSON.stringify(result).includes('OMIT_PRIVATE_FIELDS')); assert.match(result.message, /Station Manager/);
});
test('structure corporation binding and malformed optional metadata fail closed', async () => {
  for (const override of [{ corporation_id: corporationId + 1 }, { corporation_id: undefined }, { state: 'destroyed' }, { profile_id: 0 }, { type_id: 0 }, { system_id: 0 }, { fuel_expires: null }, { state_timer_start: 'yesterday' }, { state_timer_end: '2026-02-30T00:00:00Z' }, { unanchors_at: 42 }, { services: null }, { services: [{ name: 'Manufacturing', state: 'active' }] }, { services: [{ name: '', state: 'online' }] }]) {
    const result = await harness({ read: async args => ({ ...response(args), data: [structure(1001, override)] }) }).read('synthetic-owner', requests[8]);
    assert.equal(result.status, 'error'); assert.equal(result.rows.length, 0); assert.equal(result.corporationId, undefined);
  }
});
test('structure names and service text remain bounded plain text with explicit omitted service count', async () => {
  const result = await harness({ read: async args => ({ ...response(args), data: [structure(1001, { name: '<script>synthetic</script>\u0000' + 'x'.repeat(1000), services: Array.from({ length: 12 }, (_, i) => ({ name: `Synthetic service ${i}`, state: 'cleanup' })) })] }) }).read('synthetic-owner', requests[8]);
  assert.equal(result.rows[0].cells.name.length, 256); assert(!result.rows[0].cells.name.includes('\u0000')); assert.match(result.rows[0].cells.name, /^<script>/);
  assert.match(result.rows[0].cells.services, /2 more services returned/); assert(!result.rows[0].cells.services.includes('Synthetic service 11'));
});
test('new tables slice large responses and never auto-fetch another page', async () => {
  for (const [view, factory] of [['order_history', order], ['blueprints', blueprint], ['facilities', facility], ['structures', structure]]) {
    const h = harness({ read: async args => ({ ...response(args), data: Array.from({ length: 101 }, (_, i) => factory(i + 1)), ...(view === 'facilities' ? {} : { pagination: { kind: 'page', page: args.parameters.page, pages: 2, nextPage: args.parameters.page < 2 ? 2 : null } }) }) });
    const first = await h.read('synthetic-owner', { characterId, view }); assert.equal(first.rows.length, 100); assert.equal(first.coverage, 'partial'); assert.equal(first.next.offset, 100); assert.equal(h.calls.length, 2);
    const second = await h.read('synthetic-owner', first.next); assert.equal(second.rows.length, 1); assert.equal(second.rows[0].id, '101'); assert.equal(second.next?.page ?? null, view === 'facilities' ? null : 2);
    assert.equal(h.calls.filter(call => call.operation === 'corporation').length, 2);
  }
});
test('new paged views keep missing page counts unknown, reject wrong metadata and bound page traversal', async () => {
  for (const view of ['order_history', 'blueprints', 'structures']) {
    const selected = { view, characterId };
    const unknown = await harness({ read: async args => ({ ...response(args), pagination: { kind: 'page', page: 1, pages: null, nextPage: null } }) }).read('synthetic-owner', selected);
    assert.equal(unknown.coverage, 'unknown'); assert.equal(unknown.status, 'partial');
    const capped = await harness({ read: async args => ({ ...response(args), pagination: { kind: 'page', page: 500, pages: 501, nextPage: null } }) }).read('synthetic-owner', { ...selected, page: 500 });
    assert.equal(capped.coverage, 'partial'); assert.match(capped.message, /500-page safety limit/); assert.equal(capped.next, null);
    for (const pagination of [{ kind: 'none' }, { kind: 'page', page: 2, pages: 2 }, { kind: 'page', page: 1, pages: 1, nextPage: 2 }]) assert.equal((await harness({ read: async args => ({ ...response(args), pagination }) }).read('synthetic-owner', selected)).status, 'error');
  }
});
test('new datasets reject duplicate identifiers and out-of-range rows', async () => {
  for (const [view, factory] of [['order_history', order], ['blueprints', blueprint], ['facilities', facility], ['structures', structure]]) {
    for (const data of [[factory(), factory()], Array.from({ length: 10001 }, (_, i) => factory(i + 1)), {}]) {
      const result = await harness({ read: async args => ({ ...response(args), data }) }).read('synthetic-owner', { characterId, view }); assert.equal(result.status, 'error'); assert.equal(result.rows.length, 0);
    }
  }
});
test('wallets distinguish complete and missing divisions without invented balances', async () => {
  const complete = await harness().read('synthetic-owner', requests[0]); assert.equal(complete.status, 'ready'); assert.equal(complete.coverage, 'complete'); assert.equal(complete.rows[0].cells.balance, 0);
  for (const data of [[], [{ division: 1, balance: -4.25 }]]) {
    const h = harness({ read: async args => ({ ...response(args), data }) }), result = await h.read('synthetic-owner', requests[0]);
    assert.equal(result.coverage, 'partial'); assert.equal(result.status, 'partial'); assert.equal(result.rows.length, data.length); assert.match(result.message, /unavailable, not zero/);
    if (data.length) assert.equal(result.rows[0].cells.balance, -4.25);
  }
});
test('wallet malformed duplicate nonfinite and out-of-range divisions fail closed', async () => {
  for (const data of [[{ division: 0, balance: 1 }], [{ division: 8, balance: 1 }], [{ division: 1, balance: Infinity }], [{ division: 1, balance: Number.MAX_VALUE }], [{ division: 1, balance: 1 }, { division: 1, balance: 2 }], {}]) {
    const result = await harness({ read: async args => ({ ...response(args), data }) }).read('synthetic-owner', requests[0]);
    assert.equal(result.status, 'error'); assert.equal(result.rows.length, 0); assert.equal(result.corporationId, undefined);
  }
});
test('contracts omit issuer and raw fields, keep offer expiry separate, and offer only explicit item actions', async () => {
  const h = harness(), result = await h.read('synthetic-owner', requests[1]);
  assert.equal(h.calls.length, 2); assert(!JSON.stringify(result).includes('OMIT_PRIVATE_FIELDS')); assert(!JSON.stringify(result).includes('90009999'));
  assert.deepEqual(plain(result.rows[0].action.request), requests[3]); assert.match(result.message, /not an accepted courier delivery deadline/);
});
test('titles remain bounded plain text and never become executable markup or URLs', async () => {
  const title = '<script>synthetic</script>\u0000' + 'x'.repeat(1000);
  const result = await harness({ read: async args => ({ ...response(args), data: [contract(1001, { title })] }) }).read('synthetic-owner', requests[1]);
  assert.equal(result.rows[0].cells.title.length, 256); assert(!result.rows[0].cells.title.includes('\u0000')); assert.equal(result.rows[0].cells.title.slice(0, 8), '<script>');
  assert.equal(result.rows[0].action.request.view, 'contract_items');
});
test('large contract pages show bounded slices and then advance one numbered page', async () => {
  const h = harness({ read: async args => ({ ...response(args), data: Array.from({ length: 201 }, (_, index) => contract(index + 1)), pagination: { kind: 'page', page: args.parameters.page, pages: 3, nextPage: args.parameters.page < 3 ? args.parameters.page + 1 : null } }) });
  const first = await h.read('synthetic-owner', requests[1]); assert.equal(first.rows.length, 100); assert.equal(first.coverage, 'partial'); assert.deepEqual(plain(first.next), { ...requests[1], page: 1, offset: 100 });
  const second = await h.read('synthetic-owner', first.next); assert.equal(second.rows.length, 100); assert.equal(second.rows[0].id, '101'); assert.equal(second.next.offset, 200);
  const third = await h.read('synthetic-owner', second.next); assert.equal(third.rows.length, 1); assert.deepEqual(plain(third.next), { ...requests[1], page: 2, offset: 0 });
  assert.equal(h.calls.filter(call => call.operation === 'corporation').length, 3);
});
test('unknown contract page counts stay unknown and invalid page metadata fails closed', async () => {
  const unknown = await harness({ read: async args => ({ ...response(args), data: [], pagination: { kind: 'page', page: 1, pages: null, nextPage: null } }) }).read('synthetic-owner', requests[1]);
  assert.equal(unknown.coverage, 'unknown'); assert.equal(unknown.status, 'partial');
  for (const pagination of [{ kind: 'page', page: 2, pages: 2 }, { kind: 'page', page: 1, pages: -1 }, { kind: 'page', page: 1, pages: 2, nextPage: 3 }, { kind: 'page', page: 1, pages: 1, nextPage: 2 }]) assert.equal((await harness({ read: async args => ({ ...response(args), pagination }) }).read('synthetic-owner', requests[1])).status, 'error');
});
test('changing provider responses do not invent empty later slice completeness', async () => {
  const result = await harness().read('synthetic-owner', { ...requests[1], offset: 100 });
  assert.equal(result.rows.length, 0); assert.equal(result.coverage, 'unknown'); assert.equal(result.next, null); assert.match(result.message, /feed may have changed/);
});
test('contract item quantities and sides are accurate without guessing blueprint type from raw_quantity', async () => {
  const result = await harness({ read: async args => ({ ...response(args), data: [item(), item(1002, { is_included: false, is_singleton: true })] }) }).read('synthetic-owner', requests[3]);
  assert.equal(result.rows[0].cells.direction, 'Offered'); assert.equal(result.rows[1].cells.direction, 'Requested'); assert.equal(result.rows[1].cells.singleton, 'Yes');
  assert(!JSON.stringify(result).includes('raw_quantity')); assert(!JSON.stringify(result).includes('blueprint'));
  for (const override of [{ quantity: -1 }, { quantity: 1.5 }, { type_id: 0 }, { is_included: 'true' }]) assert.equal((await harness({ read: async args => ({ ...response(args), data: [item(1001, override)] }) }).read('synthetic-owner', requests[3])).status, 'error');
});
test('project listing never fan-outs, returns bounded progress fields, and retains opaque next cursor', async () => {
  const h = harness({ read: async args => ({ ...response(args), pagination: { kind: 'cursor', after: 'synthetic-cursor/+=', before: 'ignored' } }) }), result = await h.read('synthetic-owner', requests[2]);
  assert.equal(h.calls.length, 2); assert.equal(result.coverage, 'unknown'); assert.equal(result.rows[0].cells.current, 3); assert.equal(result.rows[0].cells.desired, 20);
  assert.deepEqual(plain(result.rows[0].action.request), requests[4]); assert.deepEqual(plain(result.next), { ...requests[2], after: 'synthetic-cursor/+=' });
  assert(!JSON.stringify(result).includes('OMIT_PRIVATE_FIELDS'));
  assert.deepEqual(plain(h.calls[1].args.parameters), { limit: 100, state: 'Active' });
});
test('project cursor repetition and unsafe metadata do not create endless navigation', async () => {
  for (const after of ['synthetic-cursor', 'line\nbreak', 'a'.repeat(513), {}]) {
    const result = await harness({ read: async args => ({ ...response(args), pagination: { kind: 'cursor', after } }) }).read('synthetic-owner', { ...requests[2], after: 'synthetic-cursor' });
    assert.equal(result.status, 'error'); assert.equal(result.next, null);
  }
});
test('explicit project detail adds only the selected character contribution and separately reports freshness', async () => {
  const h = harness({ read: async args => ({ ...response(args), ...(args.dataset === 'project_contribution' ? { retrievedAt: '2026-01-01T00:00:01Z', cacheExpires: 'Thu, 01 Jan 2026 00:04:00 GMT' } : {}) }) }), result = await h.read('synthetic-owner', { ...requests[4], projectId: projectId.toUpperCase() });
  assert.equal(result.status, 'ready'); assert.equal(result.rows[0].cells.ownContribution, 2); assert.equal(result.sources.length, 2);
  assert.equal(result.retrievedAt, stamp); assert.equal(result.cacheExpires, '2026-01-01T00:04:00.000Z'); assert.equal(result.sources[1].retrievedAt, '2026-01-01T00:00:01.000Z');
  assert.deepEqual(plain(h.calls[2].args), { characterId, dataset: 'project_contribution', parameters: { projectId } });
  assert(!JSON.stringify(result).includes('OMIT_PRIVATE_FIELDS')); assert.match(result.message, /creator identity is omitted/);
});
test('wrong project identity stops before contribution read and malformed progress is never accepted', async () => {
  for (const override of [{ id: 'abcdef00-0000-0000-0000-000000000002' }, { progress: { current: NaN, desired: 20 } }, { progress: { current: 3, desired: -1 } }, { progress: { current: 3.5, desired: 20 } }, { state: 'other' }, { last_modified: '2026-02-30T00:00:00Z' }]) {
    const h = harness({ read: async args => ({ ...response(args), data: project(override) }) }), result = await h.read('synthetic-owner', requests[4]);
    assert.equal(result.status, 'error'); assert.equal(result.rows.length, 0); assert.equal(h.calls.length, 2);
  }
});
test('zero project target does not infer a completion percentage or discard valid reported progress', async () => {
  const result = await harness({ read: async args => ({ ...response(args), ...(args.dataset === 'project' ? { data: project({ progress: { current: 3, desired: 0 } }) } : {}) }) }).read('synthetic-owner', requests[4]);
  assert.equal(result.status, 'ready'); assert.equal(result.rows[0].cells.desired, 0); assert.equal(result.rows[0].cells.current, 3); assert(!Object.hasOwn(result.rows[0].cells, 'percent'));
});
test('malformed or unavailable contribution discards detail rather than assuming zero', async () => {
  for (const data of [{}, { contributed: -1 }, { contributed: Number.MAX_SAFE_INTEGER + 1 }, { contributed: 1, last_modified: 'yesterday' }]) {
    const result = await harness({ read: async args => ({ ...response(args), ...(args.dataset === 'project_contribution' ? { data } : {}) }) }).read('synthetic-owner', requests[4]);
    assert.equal(result.status, 'error'); assert.equal(result.rows.length, 0); assert.equal(result.sources.length, 0);
  }
});
test('corporation drift during detail discards every source and value', async () => {
  const result = await harness({ read: async args => ({ ...response(args), corporationId: args.dataset === 'project' ? corporationId : corporationId + 1 }) }).read('synthetic-owner', requests[4]);
  assert.equal(result.status, 'unavailable'); assert.equal(result.corporationId, undefined); assert.equal(result.rows.length, 0); assert.equal(result.sources.length, 0);
});
for (const status of [401, 403, 404, 409, 429, 500]) test(`upstream status ${status} exposes no provider detail and makes no retry`, async () => {
  const h = harness({ read: async (_args, _signal, EveError) => { throw new EveError('OMIT_PRIVATE_FIELDS', status); } }), result = await h.read('synthetic-owner', requests[4]);
  assert.equal(result.status, status === 500 ? 'error' : 'unavailable'); assert.equal(h.calls.length, 2); assert.equal(result.rows.length, 0); assert(!JSON.stringify(result).includes('OMIT_PRIVATE_FIELDS'));
});
test('wrong response entity, character, dataset, corporation or date cannot reach rows', async () => {
  for (const override of [{ entity: 'character' }, { characterId: characterId + 1 }, { dataset: 'mail' }, { corporationId: -1 }, { retrievedAt: '2026-02-30T00:00:00Z' }]) {
    const result = await harness({ read: async args => ({ ...response(args), ...override }) }).read('synthetic-owner', requests[0]);
    assert.equal(result.status, 'error'); assert.equal(result.rows.length, 0);
  }
});
test('cache expiry preserves stale distinction without leaking arbitrary headers', async () => {
  const result = await harness({ read: async args => ({ ...response(args), cacheExpires: 'Wed, 31 Dec 2025 23:59:00 GMT', cacheControl: 'OMIT_PRIVATE_FIELDS' }) }).read('synthetic-owner', requests[0]);
  assert.equal(result.status, 'partial'); assert.equal(result.coverage, 'complete'); assert.match(result.message, /reached its reported cache expiry/); assert(!JSON.stringify(result).includes('OMIT_PRIVATE_FIELDS'));
  const malformed = await harness({ read: async args => ({ ...response(args), cacheExpires: 'OMIT_PRIVATE_FIELDS' }) }).read('synthetic-owner', requests[0]); assert.equal(malformed.cacheExpires, null);
});
test('aborted callers never read connection storage', async () => {
  const controller = new AbortController(); controller.abort(); const h = harness();
  await assert.rejects(h.read('synthetic-owner', requests[0], { signal: controller.signal })); assert.equal(h.calls.length, 0);
});
test('deadline and caller cancellation discard in-flight successes and stop later reads', async () => {
  for (const caller of [false, true]) {
    const controller = new AbortController();
    const h = harness({ read: async (args, _signal, _EveError, deadline) => { (caller ? controller : deadline).abort(); return response(args); } });
    const result = await h.read('synthetic-owner', requests[4], caller ? { signal: controller.signal } : {});
    assert.equal(result.status, 'unavailable'); assert.equal(result.rows.length, 0); assert.equal(h.calls.length, 2); assert(h.calls[1].signal.aborted);
  }
});

test('asset selection and name options reject malformed input before storage', async () => {
  for (const input of [
    { ...requests[9], page: 501 }, { ...requests[9], offset: 1 }, { ...requests[9], includeNames: 'true' },
    { view: 'asset_detail', characterId, itemId: 1001 }, { ...requests[10], itemId: 0 }, { ...requests[10], page: '1' },
    { ...requests[10], page: 501 }, { ...requests[10], offset: 0 }, { ...requests[10], itemIds: [1001] },
    { ...requests[10], includeNames: [] }, { ...requests[10], corporationId },
  ]) { const h = harness(); await assert.rejects(h.read('synthetic-owner', input), error => error.status === 400); assert.equal(h.calls.length, 0); }
});

test('asset listing exposes bounded membership fields and only explicit detail actions', async () => {
  const h = harness(), result = await h.read('synthetic-owner', requests[9]);
  assert.equal(result.status, 'ready'); assert.equal(h.calls.length, 2); assert.equal(result.rows[0].cells.quantity, 1);
  assert.equal(result.rows[0].cells.locationType, 'station'); assert.equal(result.rows[0].cells.singleton, 'Yes');
  assert.deepEqual(plain(result.rows[0].action.request), requests[10]);
  assert(!JSON.stringify(result).includes('OMIT_PRIVATE_FIELDS')); assert.match(result.message, /not a complete container hierarchy/);
  assert.match(result.message, /Director/); assert(!Object.hasOwn(result.rows[0].cells, 'is_blueprint_copy'));
  for (const override of [{ quantity: -1 }, { type_id: 0 }, { location_id: 0 }, { location_type: 'structure' }, { is_singleton: 'true' }, { is_blueprint_copy: null }, { location_flag: '' }]) {
    const result = await harness({ read: async args => ({ ...response(args), data: [asset(1001, override)] }) }).read('synthetic-owner', requests[9]);
    assert.equal(result.status, 'error'); assert.equal(result.rows.length, 0);
  }
});

test('asset pagination preserves source page and name choice without loading private details', async () => {
  const h = harness({ read: async args => ({ ...response(args), data: Array.from({ length: 101 }, (_, i) => asset(1001 + i)), pagination: { kind: 'page', page: args.parameters.page, pages: 2, nextPage: 2 } }) });
  const result = await h.read('synthetic-owner', { ...requests[9], includeNames: true });
  assert.equal(result.rows.length, 100); assert.equal(result.next.includeNames, true); assert.equal(result.next.offset, 100);
  assert.equal(result.rows[0].action.request.includeNames, true); assert.equal(result.rows[0].action.request.page, 1);
  assert.deepEqual(h.calls.filter(call => call.operation === 'corporation').map(call => call.args.dataset), ['assets']);
  assert.equal(h.calls.filter(call => call.operation === 'publicNames').length, 1);
});

test('asset detail rechecks membership before three bounded current-corporation sources', async () => {
  const h = harness(), result = await h.read('synthetic-owner', { ...requests[10], includeNames: true });
  assert.equal(result.status, 'ready'); assert.equal(result.sources.length, 4); assert.equal(result.rows[0].cells.name, 'Synthetic custom name');
  assert.equal(result.rows[0].cells.x, 0); assert.match(result.message, /hangars or stations/); assert.match(result.message, /not locate a tracked player/);
  assert.deepEqual(plain(h.calls.filter(call => call.operation === 'corporation').map(call => call.args)), [
    { characterId, dataset: 'assets', parameters: { page: 1 } },
    { characterId, dataset: 'asset_names', parameters: { itemIds: [1001] } },
    { characterId, dataset: 'asset_locations', parameters: { itemIds: [1001] } },
  ]);
  assert.deepEqual(h.calls.find(call => call.operation === 'publicNames').ids, [10001]);
  assert.equal(result.rows[0].cells.type, 'Synthetic public 10001 (10001)'); assert.equal(result.next, null);
});

test('missing or malformed asset page prevents all item-specific and public reads', async () => {
  for (const modify of [value => ({ ...value, data: [] }), value => ({ ...value, data: [asset(1002)] }), value => ({ ...value, data: [asset(1001, { quantity: -1 })] }), value => ({ ...value, pagination: { kind: 'none' } }), value => ({ ...value, pagination: { kind: 'page', page: 1, pages: -1 } }), value => ({ ...value, pagination: { kind: 'page', page: 1, pages: 1, nextPage: 2 } })]) {
    const h = harness({ read: async args => modify(response(args)) }), result = await h.read('synthetic-owner', { ...requests[10], includeNames: true });
    assert(['unavailable', 'error'].includes(result.status)); assert.equal(result.rows.length, 0); assert.equal(h.calls.length, 2);
  }
});

test('asset detail discards mixed-corporation and malformed lookup responses', async () => {
  for (const dataset of ['asset_names', 'asset_locations']) {
    const h = harness({ read: async args => ({ ...response(args), corporationId: args.dataset === dataset ? corporationId + 1 : corporationId }) });
    const result = await h.read('synthetic-owner', requests[10]); assert.equal(result.status, 'unavailable'); assert.equal(result.sources.length, 0); assert.equal(result.rows.length, 0);
  }
  for (const [dataset, data] of [
    ['asset_names', [{ item_id: 1002, name: 'Wrong item' }]], ['asset_names', [{ item_id: 1001, name: null }]],
    ['asset_names', [{ item_id: 1001, name: 'A' }, { item_id: 1001, name: 'B' }]],
    ['asset_locations', [{ item_id: 1002, position: { x: 0, y: 0, z: 0 } }]],
    ['asset_locations', [{ item_id: 1001, position: { x: Infinity, y: 0, z: 0 } }]],
  ]) {
    const h = harness({ read: async args => ({ ...response(args), ...(args.dataset === dataset ? { data } : {}) }) });
    const result = await h.read('synthetic-owner', requests[10]); assert.equal(result.status, 'error'); assert.equal(result.rows.length, 0);
    if (dataset === 'asset_names') assert.equal(h.calls.length, 3);
  }
});

test('unavailable custom names and positions remain explicit and names stay inert', async () => {
  const missing = await harness({ read: async args => ({ ...response(args), ...(['asset_names', 'asset_locations'].includes(args.dataset) ? { data: [] } : {}) }) }).read('synthetic-owner', requests[10]);
  assert.equal(missing.status, 'partial'); assert.equal(missing.rows[0].cells.name, 'Not reported'); assert.equal(missing.rows[0].cells.x, 'Not reported'); assert.equal(missing.sources.length, 3);
  const named = await harness({ read: async args => ({ ...response(args), ...(args.dataset === 'asset_names' ? { data: [{ item_id: 1001, name: '<script>synthetic</script>\u0000' + 'x'.repeat(1000) }] } : {}) }) }).read('synthetic-owner', requests[10]);
  assert.equal(named.rows[0].cells.name.length, 256); assert.match(named.rows[0].cells.name, /^<script>/); assert(!named.rows[0].cells.name.includes('\u0000'));
});

test('public labels are opt-in and derive only displayed type and system IDs', async () => {
  for (const request of [requests[3], requests[5], requests[6], requests[7], requests[8], requests[9]]) {
    const off = harness(); await off.read('synthetic-owner', request); assert(!off.calls.some(call => call.operation === 'publicNames'));
    const on = harness(), result = await on.read('synthetic-owner', { ...request, includeNames: true });
    const names = on.calls.filter(call => call.operation === 'publicNames'); assert.equal(names.length, 1);
    assert(names[0].ids.every(id => [34, 10001, 30000001].includes(id))); assert.equal(result.sources.at(-1).dataset, 'public_names');
    assert.match(result.message, /Public labels resolved/); assert.match(String(result.rows[0].cells.type), /\(\d+\)$/);
  }
  for (const request of [requests[0], requests[1], requests[2], requests[4]]) { const h = harness(); await h.read('synthetic-owner', { ...request, includeNames: true }); assert(!h.calls.some(call => call.operation === 'publicNames')); }
});

test('public label budget is one request for at most 200 distinct displayed IDs', async () => {
  const h = harness({ read: async args => ({ ...response(args), data: Array.from({ length: 101 }, (_, i) => facility(1001 + i, { type_id: 10001 + i, system_id: 30000001 + i })) }) });
  const result = await h.read('synthetic-owner', { ...requests[7], includeNames: true });
  const lookup = h.calls.find(call => call.operation === 'publicNames'); assert.equal(lookup.ids.length, 200); assert.equal(new Set(lookup.ids).size, 200);
  assert(!lookup.ids.includes(10101)); assert(!lookup.ids.includes(30000101)); assert.equal(result.rows.length, 100); assert.equal(result.coverage, 'partial');
});

test('public name partial or invalid responses preserve private values and coverage', async () => {
  const partial = await harness({ publicNames: ids => ({ ...publicNames(ids), data: publicNames(ids).data.slice(0, 1) }) }).read('synthetic-owner', { ...requests[7], includeNames: true });
  assert.equal(partial.status, 'partial'); assert.equal(partial.coverage, 'complete'); assert.equal(partial.rows[0].cells.system, 30000001); assert.match(partial.message, /1 of 2/);
  for (const override of [
    { data: [{ id: 90009999, name: 'Wrong identity', category: 'inventory_type' }] },
    { data: [{ id: 10001, name: 'Wrong category', category: 'solar_system' }] },
    { data: [{ id: 10001, name: 'Wrong category', category: 'character' }] },
    { data: [{ id: 10001, name: 'A', category: 'inventory_type' }, { id: 10001, name: 'B', category: 'inventory_type' }] },
    { data: [{ id: 10001, name: '', category: 'inventory_type' }] }, { retrievedAt: 'yesterday' },
  ]) {
    const h = harness({ publicNames: ids => ({ ...publicNames(ids), ...override }) }), result = await h.read('synthetic-owner', { ...requests[7], includeNames: true });
    assert.equal(result.status, 'partial'); assert.equal(result.coverage, 'complete'); assert.equal(result.rows[0].cells.type, 10001); assert.equal(result.rows[0].cells.system, 30000001);
    assert.equal(result.sources.length, 1); assert.match(result.message, /Original IDs are preserved/); assert.equal(h.calls.length, 3);
  }
});

test('public type/category conflicts fail enrichment before any public request', async () => {
  const h = harness({ read: async args => ({ ...response(args), data: [facility(1001, { system_id: 10001 })] }) });
  const result = await h.read('synthetic-owner', { ...requests[7], includeNames: true });
  assert.equal(result.status, 'partial'); assert.equal(result.rows[0].cells.type, 10001); assert.equal(h.calls.length, 2);
});

test('public lookup failures never reflect provider errors or retry private reads', async () => {
  const h = harness({ publicNames: (_ids, _signal, EveError) => { throw new EveError('OMIT_PRIVATE_FIELDS', 429); } });
  const result = await h.read('synthetic-owner', { ...requests[6], includeNames: true });
  assert.equal(result.status, 'partial'); assert.equal(result.coverage, 'complete'); assert.equal(result.rows[0].cells.type, 10001);
  assert.equal(h.calls.length, 3); assert(!JSON.stringify(result).includes('OMIT_PRIVATE_FIELDS'));
});

test('cancellation during public or private detail reads discards results and stops subsequent reads', async () => {
  for (const stop of ['assets', 'asset_names', 'asset_locations', 'publicNames']) {
    const h = harness({ read: (args, _signal, _EveError, deadline) => { if (args.dataset === stop) deadline.abort(); return response(args); }, publicNames: (ids, _signal, _EveError, deadline) => { if (stop === 'publicNames') deadline.abort(); return publicNames(ids); } });
    const result = await h.read('synthetic-owner', { ...requests[10], includeNames: true });
    assert.equal(result.status, 'unavailable'); assert.equal(result.rows.length, 0); assert.equal(result.sources.length, 0);
    assert.equal(h.calls.length, ['assets', 'asset_names', 'asset_locations', 'publicNames'].indexOf(stop) + 2);
  }
});

test('contract bids require a bounded contract/page selection before storage', async () => {
  for (const input of [
    { view: 'contract_bids', characterId }, { ...requests[11], contractId: 0 }, { ...requests[11], contractId: '1001' },
    { ...requests[11], contractId: Number.MAX_SAFE_INTEGER + 1 }, { ...requests[11], page: 0 }, { ...requests[11], page: 501 },
    { ...requests[11], offset: -1 }, { ...requests[11], offset: 101 }, { ...requests[11], offset: 10000 },
    { ...requests[11], bidderId: 90009999 }, { ...requests[11], corporationId }, { ...requests[11], includeNames: 'true' },
  ]) { const h = harness(); await assert.rejects(h.read('synthetic-owner', input), error => error.status === 400); assert.equal(h.calls.length, 0); }
});

test('only auction rows offer an additional explicit bid action without automatic reads', async () => {
  const h = harness({ read: async args => ({ ...response(args), data: [contract(1001, { type: 'auction' }), contract(1002), contract(1003, { type: 'item_exchange' })] }) });
  const result = await h.read('synthetic-owner', { ...requests[1], includeNames: true });
  assert.equal(h.calls.length, 2); assert.equal(result.rows[0].action.request.view, 'contract_items');
  assert.deepEqual(plain(result.rows[0].actions), [{ label: 'Load bids', request: { view: 'contract_bids', characterId, contractId: 1001, page: 1, offset: 0, includeNames: true } }]);
  assert.equal(result.rows[1].actions, undefined); assert.equal(result.rows[2].actions, undefined);
});

test('bid views expose amounts and dates only and never infer payment or a winner', async () => {
  const h = harness(), result = await h.read('synthetic-owner', { ...requests[11], includeNames: true });
  assert.equal(result.status, 'ready'); assert.equal(h.calls.length, 2); assert.equal(result.sources.length, 1);
  assert.deepEqual(plain(result.rows[0].cells), { amount: 123.45, date: stamp });
  assert.deepEqual(plain(h.calls[1].args), { characterId, dataset: 'contract_bids', parameters: { contractId: 1001, page: 1 } });
  assert(!/90009999|OMIT_PRIVATE_FIELDS|bidder_id|private_marker/.test(JSON.stringify(result)));
  assert.match(result.message, /not completed payments/); assert.match(result.message, /No highest bid/);
});

test('bid pagination uses bounded slices and retains the contract and opt-in choice', async () => {
  const h = harness({ read: async args => ({ ...response(args), data: Array.from({ length: 101 }, (_, i) => bid(1001 + i)), pagination: { kind: 'page', page: args.parameters.page, pages: 2, nextPage: args.parameters.page === 1 ? 2 : null } }) });
  const first = await h.read('synthetic-owner', { ...requests[11], includeNames: true });
  assert.equal(first.rows.length, 100); assert.equal(first.coverage, 'partial');
  assert.deepEqual(plain(first.next), { ...requests[11], page: 1, offset: 100, includeNames: true });
  const last = await h.read('synthetic-owner', first.next);
  assert.equal(last.rows.length, 1); assert.deepEqual(plain(last.next), { ...requests[11], page: 2, offset: 0, includeNames: true });
  assert(!h.calls.some(call => call.operation === 'publicNames'));
});

test('invalid bid values, duplicate IDs and mismatched pagination cannot reach the table', async () => {
  for (const override of [{ amount: -0.001 }, { amount: NaN }, { amount: Infinity }, { amount: Number.MAX_SAFE_INTEGER }, { amount: '12' }, { date_bid: '2026-02-30T00:00:00Z' }, { bid_id: -1 }]) {
    const result = await harness({ read: async args => ({ ...response(args), data: [bid(1001, override)] }) }).read('synthetic-owner', requests[11]);
    assert.equal(result.status, 'error'); assert.equal(result.rows.length, 0); assert.equal(result.sources.length, 0);
  }
  for (const override of [{ data: [bid(), bid()] }, { data: Array.from({ length: 10001 }, (_, i) => bid(1001 + i)) }, { pagination: { kind: 'none' } }, { pagination: { kind: 'page', page: 2, pages: 2 } }, { pagination: { kind: 'page', page: 1, pages: 1, nextPage: 2 } }]) {
    assert.equal((await harness({ read: async args => ({ ...response(args), ...override }) }).read('synthetic-owner', requests[11])).status, 'error');
  }
  const empty = await harness({ read: async args => ({ ...response(args), data: [] }) }).read('synthetic-owner', requests[11]);
  assert.equal(empty.status, 'ready'); assert.equal(empty.rows.length, 0); assert.equal(empty.next, null);
});

test('bid authorization failure and cancellation never preserve rows or retry', async () => {
  for (const code of [401, 403, 404, 409, 429]) {
    const h = harness({ read: async (_args, _signal, EveError) => { throw new EveError('OMIT_PRIVATE_FIELDS', code); } });
    const result = await h.read('synthetic-owner', requests[11]); assert.equal(result.status, 'unavailable'); assert.equal(result.rows.length, 0); assert.equal(h.calls.length, 2);
  }
  const h = harness({ read: async (args, _signal, _EveError, deadline) => { deadline.abort(); return response(args); } });
  const result = await h.read('synthetic-owner', requests[11]); assert.equal(result.status, 'unavailable'); assert.equal(result.rows.length, 0); assert.equal(h.calls.length, 2);
});

const objectiveData = override => project({
  configuration: { deliver_item: { items: [{ type_id: 34 }, { group_id: 18 }], docking_locations: [{ structure_id: 1000000001001 }], office_id: 1000000002001 } },
  details: { description: 'OMIT_PRIVATE_FIELDS', career: 'Industrialist', created: stamp, expires: '2026-01-03T00:00:00Z' },
  contribution: { participation_limit: 100, submission_limit: 10, submission_multiplier: 1.5, reward_per_contribution: 12.5 },
  reward: { initial: 5000, remaining: 4000 }, ...override,
});
const objectiveHarness = data => harness({ read: async args => ({ ...response(args), ...(args.dataset === 'project' ? { data } : {}) }) });

test('project objective summarizes known settings without creator, description or docking details', async () => {
  const h = objectiveHarness(objectiveData()), result = await h.read('synthetic-owner', { ...requests[4], includeNames: true });
  const details = Object.fromEntries(result.details.map(row => [row.label, row.value]));
  assert.equal(result.status, 'partial'); assert.equal(result.rows[0].cells.ownContribution, 2); assert.equal(result.sources.length, 2); assert.equal(h.calls.length, 3);
  assert.equal(details.Objective, 'Deliver items'); assert.equal(details['Item filters'], 'Type ID 34; Inventory group ID 18');
  assert.equal(details['Deadline (UTC)'], '2026-01-03 00:00:00.000 UTC'); assert.equal(details['Contribution limit per participant'], 100);
  assert.equal(details['Progress multiplier per contribution'], 1.5); assert.equal(details['Reward per contribution'], '12.5 ISK');
  assert.equal(details['Initial reward reserve'], '5000 ISK'); assert.equal(details['Remaining reward reserve'], '4000 ISK');
  assert(!/90009999|OMIT_PRIVATE_FIELDS|1000000001001|1000000002001|structure_id|office_id/.test(JSON.stringify(result)));
  assert(result.details.length <= 20); assert.match(result.message, /full requirements in EVE/); assert.match(result.message, /not earned or claimable/);
});

test('all documented objective kinds use fixed labels with no raw configuration serialization', async () => {
  const kinds = ['capture_fw_complex', 'damage_ship', 'defend_fw_complex', 'deliver_item', 'destroy_npc', 'destroy_ship', 'earn_loyalty_point', 'lost_ship', 'manual', 'manufacture_item', 'mine_material', 'remote_boost_shield', 'remote_repair_armor', 'salvage_wreck', 'scan_signature', 'ship_insurance'];
  for (const kind of kinds) {
    const config = kind === 'manufacture_item' ? { owner: 'Character' } : kind === 'ship_insurance' ? { conflict_type: 'Pvp', reimburse_implants: false } : {};
    const result = await objectiveHarness(project({ configuration: { [kind]: config } })).read('synthetic-owner', requests[4]);
    assert.equal(result.status, 'ready', kind); assert(result.details.length <= 20); assert(!JSON.stringify(result.details).includes('OMIT_PRIVATE_FIELDS'));
    assert.equal(result.rows[0].cells.ownContribution, 2);
  }
});

test('unknown and missing objectives preserve verified progress without leaking arbitrary configuration', async () => {
  for (const configuration of [undefined, null, [], {}, { unknown: { type: 'OMIT_PRIVATE_FIELDS', data: { character_id: 90009999 } } }, { future_private_kind: { marker: 'OMIT_PRIVATE_FIELDS' } }, { manual: {}, deliver_item: {} }, { manual: null }]) {
    const h = objectiveHarness(project({ configuration })), result = await h.read('synthetic-owner', requests[4]);
    assert.equal(result.status, 'partial'); assert.equal(result.rows[0].cells.current, 3); assert.equal(result.rows[0].cells.ownContribution, 2); assert.equal(h.calls.length, 3);
    assert(result.details.length > 0); assert(!/OMIT_PRIVATE_FIELDS|90009999|future_private_kind/.test(JSON.stringify(result))); assert.match(result.message, /partial or unavailable/);
  }
});

test('objective filters are bounded and use distinct inventory and ship-tree group semantics', async () => {
  const mine = await objectiveHarness(project({ configuration: { mine_material: { materials: Array.from({ length: 11 }, (_, i) => ({ type_id: 34 + i })) } } })).read('synthetic-owner', requests[4]);
  assert.equal(mine.status, 'partial'); assert.match(mine.details.find(row => row.label === 'Material filters').value, /1 more not displayed$/);
  const ship = await objectiveHarness(project({ configuration: { damage_ship: { ships: [{ group_id: 12 }], identities: [{ character_id: 90009999 }], locations: [{ solar_system_id: 30000001 }] } } })).read('synthetic-owner', requests[4]);
  assert.equal(ship.details.find(row => row.label === 'Ship filters').value, 'Ship tree group ID 12'); assert.equal(ship.status, 'partial'); assert(!/90009999|30000001/.test(JSON.stringify(ship)));
  const missing = await objectiveHarness(project({ configuration: { deliver_item: { items: [] } } })).read('synthetic-owner', requests[4]);
  assert.match(missing.details.find(row => row.label === 'Item filters').value, /no unrestricted eligibility/);
  assert.equal(missing.details.find(row => row.label === 'Reward per contribution').value, 'Not reported');
});

test('malformed objective fields become explicit unavailable summaries without invented zeroes', async () => {
  const variations = [
    { configuration: { deliver_item: { items: [{ type_id: 0 }] } } }, { configuration: { deliver_item: { items: [{ type_id: 34, character_id: 90009999 }] } } },
    { configuration: { deliver_item: { items: [{ type_id: 34 }, { type_id: 34 }] } } }, { configuration: { deliver_item: { items: Array.from({ length: 101 }, (_, i) => ({ type_id: 34 + i })) } } },
    { configuration: { manufacture_item: {} } }, { configuration: { manufacture_item: { owner: 'OMIT_PRIVATE_FIELDS' } } },
    { configuration: { ship_insurance: { conflict_type: 'PvP', reimburse_implants: true } } },
    { details: { career: 'OMIT_PRIVATE_FIELDS', created: stamp } }, { details: { career: 'Industrialist', created: '2026-02-30T00:00:00Z' } },
    { contribution: { participation_limit: -1 } }, { contribution: { submission_multiplier: Infinity } }, { contribution: { reward_per_contribution: -0.001 } },
    { reward: { initial: 10 } }, { reward: { initial: 10, remaining: Infinity } },
  ];
  for (const override of variations) {
    const result = await objectiveHarness(objectiveData(override)).read('synthetic-owner', requests[4]);
    assert.equal(result.status, 'partial'); assert.equal(result.details.length, 1); assert.match(result.details[0].value, /unavailable/);
    assert.equal(result.rows[0].cells.ownContribution, 2); assert(!/OMIT_PRIVATE_FIELDS|90009999/.test(JSON.stringify(result)));
  }
});

test('project objective fields are discarded with failed contribution, corporation drift or cancellation', async () => {
  for (const scenario of ['contribution', 'corporation', 'cancel']) {
    const h = harness({ read: async (args, _signal, EveError, deadline) => {
      if (args.dataset === 'project') return { ...response(args), data: objectiveData() };
      if (scenario === 'contribution') throw new EveError('OMIT_PRIVATE_FIELDS', 403);
      if (scenario === 'cancel') deadline.abort();
      return { ...response(args), ...(scenario === 'corporation' ? { corporationId: corporationId + 1 } : {}) };
    } });
    const result = await h.read('synthetic-owner', requests[4]);
    assert.equal(result.status, 'unavailable'); assert.equal(result.rows.length, 0); assert.equal(result.details, undefined); assert.equal(result.sources.length, 0);
  }
});
