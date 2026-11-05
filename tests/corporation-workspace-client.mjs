import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const compile = file => ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const connectionCode = compile('app/lib/connection-client.ts'), code = compile('app/lib/corporation-workspace-client.ts');
function harness(fetch = () => { throw Error('Unexpected request'); }, timers = {}) {
  const connection = { exports: {} }, client = { exports: {} }, context = { URL, AbortController, setTimeout, clearTimeout, fetch, ...timers };
  vm.runInNewContext(connectionCode, { ...context, module: connection, exports: connection.exports });
  vm.runInNewContext(code, { ...context, module: client, exports: client.exports, require: () => connection.exports });
  return client.exports;
}
const args = { characterId: 90000001, view: 'contracts' }, stamp = '2026-01-01T00:00:00Z';
function fixture() { return { ...args, corporationId: 98000001, generatedAt: stamp, status: 'partial', message: 'Synthetic batch.', scope: 'esi-contracts.read_corporation_contracts.v1', coverage: 'partial', retrievedAt: stamp, cacheExpires: null, sources: [{ dataset: 'contracts', scope: 'esi-contracts.read_corporation_contracts.v1', retrievedAt: stamp, cacheExpires: null }], columns: [{ key: 'title', label: 'Title' }], rows: [{ id: '1001', cells: { title: '<script>synthetic text</script>' }, action: { label: 'Load items', request: { characterId: args.characterId, view: 'contract_items', contractId: 1001 } } }], next: { ...args, page: 2, offset: 0 } }; }
test('validated rows preserve plain text without interpreting markup', () => { const value = fixture(); assert.equal(harness().corporationWorkspaceResponse(value, args), value); });
for (const [name, mutate] of [
  ['wrong character', value => value.characterId++], ['wrong view', value => value.view = 'wallets'],
  ['coerced status', value => value.status = ['ready']], ['invalid time', value => value.generatedAt = 'invalid'],
  ['oversized text', value => value.message = 'x'.repeat(2049)], ['missing sources', value => delete value.sources],
  ['duplicate row', value => value.rows.push(value.rows[0])], ['missing cell', value => value.rows[0].cells = {}],
  ['non-finite cell', value => value.rows[0].cells.title = Infinity], ['unknown column unit', value => value.columns[0].unit = ['ISK']],
  ['prototype key', value => value.columns[0].key = 'constructor'], ['duplicate column', value => value.columns.push(value.columns[0])],
  ['another character action', value => value.rows[0].action.request.characterId++],
  ['unexpected action view', value => value.rows[0].action.request = { ...args, view: 'wallets' }],
  ['unsafe action ID', value => value.rows[0].action.request.contractId = Number.MAX_SAFE_INTEGER + 1],
  ['another contract action', value => value.rows[0].action.request.contractId++],
  ['action URL', value => value.rows[0].action.request.url = 'https://example.invalid'],
  ['action silently enabling names', value => value.rows[0].action.request.includeNames = true],
  ['continuation silently enabling names', value => value.next.includeNames = true],
  ['coerced name option', value => value.next.includeNames = 'true'],
  ['another character continuation', value => value.next.characterId++],
  ['unbounded page', value => value.next.page = 501], ['unchanged continuation', value => value.next = { ...args }],
  ['unaligned offset', value => value.next.offset = 1], ['out-of-range offset', value => value.next.offset = 10000],
  ['string currency', value => value.columns[0].unit = 'ISK'], ['string count', value => value.columns[0].unit = 'count'], ['invalid date cell', value => value.columns[0].unit = 'datetime'],
  ['changed continuation view', value => value.next = { characterId: args.characterId, view: 'projects' }],
  ['unavailable result with rows', value => value.status = 'unavailable'],
  ['too many rows', value => value.rows = Array.from({ length: 101 }, (_, i) => ({ id: String(i), cells: { title: 'Synthetic' } }))],
]) test(`corporation client rejects ${name}`, () => { const value = fixture(); mutate(value); assert.throws(() => harness().corporationWorkspaceResponse(value, args), /incomplete response/); });
test('contract item continuation cannot change contract', () => {
  const selected = { characterId: args.characterId, view: 'contract_items', contractId: 1001 };
  const value = { ...fixture(), ...selected, rows: [], next: { ...selected, contractId: 1002, offset: 100 } };
  assert.throws(() => harness().corporationWorkspaceResponse(value, selected), /incomplete response/);
});
test('project actions require UUID and bounded cursor continuation', () => {
  const selected = { characterId: args.characterId, view: 'projects' }, value = { ...fixture(), ...selected, next: { ...selected, after: 'safe-cursor' } };
  value.rows[0].action.request = { characterId: args.characterId, view: 'project', projectId: '00000000-0000-4000-8000-000000000001' };
  value.rows[0].id = value.rows[0].action.request.projectId;
  assert.equal(harness().corporationWorkspaceResponse(value, selected), value);
  const otherProject = structuredClone(value); otherProject.rows[0].action.request.projectId = '00000000-0000-4000-8000-000000000002';
  assert.throws(() => harness().corporationWorkspaceResponse(otherProject, selected), /incomplete response/);
  value.rows[0].action.request.projectId += '\n';
  assert.throws(() => harness().corporationWorkspaceResponse(value, selected), /incomplete response/);
  value.rows[0].action.request.projectId = '../private';
  assert.throws(() => harness().corporationWorkspaceResponse(value, selected), /incomplete response/);
});
test('requests are explicit same-origin POST with no-store and cancellation', async () => {
  let calls = 0;
  const client = harness(async (url, init) => { calls++; assert.equal(url, '/api/eve/corporation-workspace'); assert.equal(init.method, 'POST'); assert.equal(init.cache, 'no-store'); assert.deepEqual(JSON.parse(init.body), args); assert.ok(init.signal instanceof AbortSignal); return Response.json(fixture()); });
  await client.corporationWorkspaceRequest(args, new AbortController().signal); assert.equal(calls, 1);
});
for (const view of ['order_history', 'blueprints', 'facilities', 'structures']) {
  test(`${view} accepts bounded table pagination and rejects cross-view actions`, () => {
    const selected = { characterId: args.characterId, view };
    const value = { ...fixture(), ...selected, rows: [{ id: '1001', cells: { title: 'Synthetic row' } }], next: { ...selected, offset: 100 } };
    const client = harness();
    assert.equal(client.corporationWorkspaceResponse(value, selected), value);
    value.next.characterId++;
    assert.throws(() => client.corporationWorkspaceResponse(value, selected), /incomplete response/);
    value.next = { ...selected, page: 2, offset: 0 };
    if (view === 'facilities') assert.throws(() => client.corporationWorkspaceResponse(value, selected), /incomplete response/);
    else assert.equal(client.corporationWorkspaceResponse(value, selected), value);
    value.next = { ...selected, after: 'unexpected-cursor' };
    assert.throws(() => client.corporationWorkspaceResponse(value, selected), /incomplete response/);
    value.next = null; value.rows[0].action = { label: 'Unexpected detail', request: { ...selected, view: 'project', projectId: '00000000-0000-4000-8000-000000000001' } };
    assert.throws(() => client.corporationWorkspaceResponse(value, selected), /incomplete response/);
  });
}
test('signed-out responses cancel unread bodies and expose no gateway HTML', async () => {
  let cancelled = false;
  const client = harness(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 401 }));
  await assert.rejects(client.corporationWorkspaceRequest(args, new AbortController().signal), error => error.status === 401 && /Sign in/.test(error.message)); assert.equal(cancelled, true);
});
test('server errors do not reflect upstream details', async () => {
  const client = harness(async () => Response.json({ error: 'synthetic private upstream body' }, { status: 500 }));
  await assert.rejects(client.corporationWorkspaceRequest(args, new AbortController().signal), error => error.status === 500 && !/synthetic/.test(error.message));
});
test('asset details stay bound to the displayed item and source page', () => {
  const selected = { characterId: args.characterId, view: 'assets', page: 2, includeNames: true };
  const value = { ...fixture(), ...selected, next: { ...selected, page: 3 }, rows: [{ id: '1001', cells: { title: 'Synthetic asset' }, action: { label: 'Load details', request: { characterId: args.characterId, view: 'asset_detail', itemId: 1001, page: 2, includeNames: true } } }] };
  const client = harness(); assert.equal(client.corporationWorkspaceResponse(value, selected), value);
  const action = value.rows[0].action.request;
  for (const mutate of [request => request.itemId++, request => request.page++, request => delete request.page, request => request.includeNames = false, request => request.itemIds = [1001]]) {
    const invalid = structuredClone(value); mutate(invalid.rows[0].action.request);
    assert.throws(() => client.corporationWorkspaceResponse(invalid, selected), /incomplete response/);
  }
  const detail = { ...value, view: 'asset_detail', rows: [], next: null };
  assert.equal(client.corporationWorkspaceResponse(detail, action), detail);
  detail.next = { ...action, page: 3 };
  assert.throws(() => client.corporationWorkspaceResponse(detail, action), /incomplete response/);
});
test('name consent is preserved across existing details and continuation', () => {
  const selected = { ...args, includeNames: true }, value = { ...fixture(), ...selected };
  value.rows[0].action.request.includeNames = true; value.next.includeNames = true;
  assert.equal(harness().corporationWorkspaceResponse(value, selected), value);
  delete value.next.includeNames;
  assert.throws(() => harness().corporationWorkspaceResponse(value, selected), /incomplete response/);
});
test('four bounded source timestamps support asset checks, details and optional public names', () => {
  const value = fixture(); value.sources = ['assets', 'asset_names', 'asset_locations', 'public_names'].map(dataset => ({ ...value.sources[0], dataset }));
  assert.equal(harness().corporationWorkspaceResponse(value, args), value);
  value.sources.push(value.sources[0]);
  assert.throws(() => harness().corporationWorkspaceResponse(value, args), /incomplete response/);
});
test('display formatting keeps identifiers exact and structure schedules explicitly UTC', () => {
  const { formatCorporationCell: format } = harness();
  assert.equal(format(1000000000001, { key: 'item', label: 'Item ID' }), '1000000000001');
  assert.equal(format(Number.MAX_SAFE_INTEGER, { key: 'location', label: 'Location ID' }), String(Number.MAX_SAFE_INTEGER));
  assert.equal(format(-12.25, { key: 'x', label: 'X coordinate' }), '-12.25');
  assert.match(format(1200.25, { key: 'balance', label: 'Balance', unit: 'ISK' }), /1.?200[.,]25 ISK/);
  assert.equal(format('Not reported', { key: 'fuelUntil', label: 'Fuel expiry' }), 'Not reported');
  assert.match(format(stamp, { key: 'fuelUntil', label: 'Fuel expiry' }), /UTC$/);
  assert.equal(format('<b>Synthetic</b>', { key: 'name', label: 'Name' }), '<b>Synthetic</b>');
});
test('caller cancellation aborts the request', async () => {
  const controller = new AbortController(), client = harness((url, init) => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(Error('private'))); controller.abort(); }));
  await assert.rejects(client.corporationWorkspaceRequest(args, controller.signal), /cancelled/);
});
test('deadline aborts the request', async () => {
  let deadline;
  const client = harness((url, init) => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(Error('private'))); deadline(); }), { setTimeout: callback => { deadline = callback; return 1; }, clearTimeout: () => {} });
  await assert.rejects(client.corporationWorkspaceRequest(args, new AbortController().signal), /too long/);
});

function auctionFixture() {
  const value = fixture();
  value.columns.push({ key: 'type', label: 'Type' });
  value.rows[0].cells.type = 'auction';
  value.rows[0].actions = [{ label: 'Load bids', request: { characterId: args.characterId, view: 'contract_bids', contractId: 1001, page: 1, offset: 0 } }];
  return value;
}

test('auction rows offer separate explicit item and bid reads without making requests', () => {
  const value = auctionFixture(), client = harness();
  assert.equal(client.corporationWorkspaceResponse(value, args), value);
  assert.equal(value.rows[0].action.request.view, 'contract_items');
  assert.equal(value.rows[0].actions[0].request.view, 'contract_bids');
});

for (const [name, mutate] of [
  ['non-auction bid action', value => value.rows[0].cells.type = 'courier'],
  ['another contract bid action', value => value.rows[0].actions[0].request.contractId++],
  ['another character bid action', value => value.rows[0].actions[0].request.characterId++],
  ['implicit name lookup in bids', value => value.rows[0].actions[0].request.includeNames = true],
  ['initial bid action skipping page', value => value.rows[0].actions[0].request.page = 2],
  ['initial bid action skipping slice', value => value.rows[0].actions[0].request.offset = 100],
  ['missing bid contract', value => delete value.rows[0].actions[0].request.contractId],
  ['duplicate extra action', value => value.rows[0].actions.push(structuredClone(value.rows[0].actions[0]))],
  ['extra duplicating primary action', value => value.rows[0].actions = [structuredClone(value.rows[0].action)]],
  ['unbounded extra actions', value => value.rows[0].actions = Array(3).fill(value.rows[0].actions[0])],
  ['non-list actions', value => value.rows[0].actions = { label: 'Unexpected action' }],
  ['empty action label', value => value.rows[0].actions[0].label = ' '],
  ['unknown action property', value => value.rows[0].actions[0].privateIdentity = 90009999],
  ['inherited action', value => value.rows[0].actions[0] = Object.create(value.rows[0].actions[0])],
  ['inherited request', value => value.rows[0].actions[0].request = Object.create(value.rows[0].actions[0].request)],
  ['inherited contract ID', value => { const request = value.rows[0].actions[0].request; value.rows[0].actions[0].request = Object.assign(Object.create({ contractId: request.contractId }), { ...request }); delete value.rows[0].actions[0].request.contractId; }],
]) test(`corporation client rejects ${name}`, () => {
  const value = auctionFixture(); mutate(value);
  assert.throws(() => harness().corporationWorkspaceResponse(value, args), /incomplete response/);
});

test('bid consent and refresh requests retain the selected contract and no-store policy', async () => {
  const selected = { characterId: args.characterId, view: 'contract_bids', contractId: 1001, page: 2, includeNames: true };
  const value = { ...fixture(), ...selected, columns: [{ key: 'amount', label: 'Bid amount', unit: 'ISK' }], rows: [{ id: '1', cells: { amount: 1250.75 } }], next: { ...selected, page: 3, offset: 0 } };
  let calls = 0;
  const client = harness(async (url, init) => {
    calls++; assert.equal(url, '/api/eve/corporation-workspace'); assert.equal(init.cache, 'no-store');
    assert.deepEqual(JSON.parse(init.body), selected); return Response.json(value);
  });
  await client.corporationWorkspaceRequest(selected, new AbortController().signal);
  assert.equal(calls, 1);
  value.next = { ...selected, offset: 100 };
  assert.equal(client.corporationWorkspaceResponse(value, selected), value);
  for (const mutate of [
    next => next.contractId++, next => next.characterId++, next => next.page = 1, next => next.page = 4,
    next => next.offset = 200, next => next.offset = 1, next => next.view = 'contract_items',
    next => next.includeNames = false, next => next.url = 'https://example.invalid',
  ]) {
    const malformed = structuredClone(value); mutate(malformed.next);
    assert.throws(() => client.corporationWorkspaceResponse(malformed, selected), /incomplete response/);
  }
  value.next = { ...selected, page: 3, offset: 100 };
  assert.throws(() => client.corporationWorkspaceResponse(value, selected), /incomplete response/);
});

function projectFixture() {
  const selected = { characterId: args.characterId, view: 'project', projectId: '00000000-0000-4000-8000-000000000001' };
  return { selected, value: { ...fixture(), ...selected, next: null, rows: [{ id: selected.projectId, cells: { title: 'Synthetic project' } }], details: [{ label: 'Objective', value: 'Manufacture item' }, { label: 'Item type IDs', value: '34, 35' }, { label: 'Contribution limit', value: 100 }] } };
}

test('project objective details accept bounded plain text and preserve exact numeric values', () => {
  const { selected, value } = projectFixture();
  value.details[0].value = '<script>synthetic untrusted text</script>';
  value.details[2].value = Number.MAX_SAFE_INTEGER;
  assert.equal(harness().corporationWorkspaceResponse(value, selected), value);
  assert.equal(value.details[0].value, '<script>synthetic untrusted text</script>');
});

for (const [name, mutate] of [
  ['non-list objective', value => value.details = {}],
  ['too many objective fields', value => value.details = Array.from({ length: 21 }, (_, index) => ({ label: `Field ${index}`, value: 'Synthetic' }))],
  ['duplicate objective labels', value => value.details.push(structuredClone(value.details[0]))],
  ['blank objective label', value => value.details[0].label = ' '],
  ['oversized objective label', value => value.details[0].label = 'x'.repeat(129)],
  ['oversized objective text', value => value.details[0].value = 'x'.repeat(2049)],
  ['non-finite objective value', value => value.details[0].value = Infinity],
  ['unsafe objective number', value => value.details[0].value = Number.MAX_SAFE_INTEGER + 1],
  ['nested objective value', value => value.details[0].value = { creator: 90009999 }],
  ['missing objective value', value => delete value.details[0].value],
  ['inherited objective field', value => value.details[0] = Object.create(value.details[0])],
  ['unexpected objective metadata', value => value.details[0].creator = 90009999],
  ['objective on failed result', value => { value.rows = []; value.status = 'error'; }],
  ['empty objective on failed result', value => { value.rows = []; value.status = 'unavailable'; value.details = []; }],
  ['additional action on project details', value => value.rows[0].actions = []],
]) test(`corporation client rejects ${name}`, () => {
  const { selected, value } = projectFixture(); mutate(value);
  assert.throws(() => harness().corporationWorkspaceResponse(value, selected), /incomplete response/);
});

test('objective data cannot appear in an unrelated workspace result', () => {
  const value = fixture(); value.details = [{ label: 'Objective', value: 'Synthetic' }];
  assert.throws(() => harness().corporationWorkspaceResponse(value, args), /incomplete response/);
});

function extractionFixture() {
  const selected = { characterId: args.characterId, view: 'extractions', page: 2, offset: 0 };
  return { selected, value: { ...fixture(), ...selected,
    columns: [{ key: 'structure', label: 'Structure ID' }, { key: 'moon', label: 'Moon ID' },
      { key: 'start', label: 'Start (UTC)', unit: 'datetime' }, { key: 'arrival', label: 'Arrival (UTC)', unit: 'datetime' },
      { key: 'decay', label: 'Natural fracture (UTC)', unit: 'datetime' }, { key: 'phase', label: 'Schedule at load' }],
    rows: [{ id: '1000000000001', cells: { structure: 1000000000001, moon: 40000001, start: stamp,
      arrival: '2026-01-02T00:00:00Z', decay: '2026-01-03T00:00:00Z', phase: 'Arrival pending' } }],
    next: { ...selected, offset: 100 },
  } };
}

function freelanceFixture() {
  const selected = { characterId: args.characterId, view: 'freelance_jobs', after: 'synthetic-current-cursor' };
  return { selected, value: { ...fixture(), ...selected,
    columns: [{ key: 'name', label: 'Job' }, { key: 'state', label: 'State' },
      { key: 'current', label: 'Progress', unit: 'count' }, { key: 'desired', label: 'Goal', unit: 'count' },
      { key: 'initialReward', label: 'Initial reserved reward' }, { key: 'remainingReward', label: 'Remaining reserved reward' },
      { key: 'lastModified', label: 'Last modified (UTC)', unit: 'datetime' }],
    rows: [{ id: '11111111-1111-4111-8111-111111111111', cells: { name: '<b>Synthetic freelance job</b>', state: 'Active', current: 25,
      desired: 100, initialReward: 5000, remainingReward: 3750, lastModified: stamp } }],
    next: { ...selected, after: 'synthetic-next-cursor' },
  } };
}

test('extractions preserve exact identifiers, UTC schedules and bounded manual continuations', () => {
  const { selected, value } = extractionFixture(), client = harness();
  assert.equal(client.corporationWorkspaceResponse(value, selected), value);
  assert.equal(client.formatCorporationCell(value.rows[0].cells.structure, value.columns[0]), '1000000000001');
  for (const column of value.columns.slice(2, 5)) assert.match(client.formatCorporationCell(value.rows[0].cells[column.key], column), /UTC$/);
  value.next = { ...selected, page: 3, offset: 0 };
  assert.equal(client.corporationWorkspaceResponse(value, selected), value);
});

for (const [name, mutate] of [
  ['unsafe structure ID', value => value.rows[0].cells.structure = Number.MAX_SAFE_INTEGER + 1],
  ['string moon ID', value => value.rows[0].cells.moon = '40000001'],
  ['mismatched row identity', value => value.rows[0].id = '1000000000002'],
  ['unknown schedule state', value => value.rows[0].cells.phase = 'Mined out'],
  ['coerced schedule state', value => value.rows[0].cells.phase = ['Arrival pending']],
  ['invalid arrival', value => value.rows[0].cells.arrival = 'not a date'],
  ['arrival before extraction start', value => value.rows[0].cells.arrival = '2025-01-01T00:00:00Z'],
  ['fracture before arrival', value => value.rows[0].cells.decay = stamp],
  ['formatted ID column', value => value.columns[0].unit = 'count'],
  ['untyped schedule date', value => delete value.columns[2].unit],
  ['missing schedule column', value => { value.columns.pop(); delete value.rows[0].cells.phase; }],
  ['extra private identity column', value => { value.columns.push({ key: 'observer', label: 'Observer' }); value.rows[0].cells.observer = 90000001; }],
  ['skipped schedule page', value => value.next = { ...value.next, page: 4, offset: 0 }],
  ['skipped schedule slice', value => value.next.offset = 200],
  ['schedule cursor', value => value.next = { characterId: args.characterId, view: 'extractions', after: 'synthetic-next' }],
  ['schedule detail action', value => value.rows[0].action = { label: 'Unexpected lookup', request: { characterId: args.characterId, view: 'asset_detail', page: 2, itemId: 1000000000001 } }],
]) test(`extraction client rejects ${name}`, () => {
  const { selected, value } = extractionFixture(); mutate(value);
  assert.throws(() => harness().corporationWorkspaceResponse(value, selected), /incomplete response/);
});

test('freelance accepts optional rewards, all provider states and over-goal progress', () => {
  const { selected, value } = freelanceFixture(), client = harness();
  for (const state of ['Unspecified', 'Active', 'Closed', 'Completed', 'Expired', 'Deleted']) {
    value.rows[0].cells.state = state;
    assert.equal(client.corporationWorkspaceResponse(value, selected), value);
  }
  assert.match(client.formatCorporationCell(value.rows[0].cells.initialReward, value.columns[4]), /ISK$/);
  assert.match(client.formatCorporationCell(value.rows[0].cells.lastModified, value.columns[6]), /UTC$/);
  value.rows[0].cells.current = 101;
  value.rows[0].cells.initialReward = 'Not reported'; value.rows[0].cells.remainingReward = 'Not reported';
  assert.equal(client.corporationWorkspaceResponse(value, selected), value);
  assert.equal(client.formatCorporationCell(value.rows[0].cells.remainingReward, value.columns[5]), 'Not reported');
  assert.equal(client.formatCorporationCell(value.rows[0].cells.name, value.columns[0]), '<b>Synthetic freelance job</b>');
});

for (const [name, mutate] of [
  ['invalid job UUID', value => value.rows[0].id = '../synthetic-job'],
  ['numeric job name', value => value.rows[0].cells.name = 42],
  ['unknown freelance state', value => value.rows[0].cells.state = 'Paused'],
  ['wrong case freelance state', value => value.rows[0].cells.state = 'active'],
  ['coerced freelance state', value => value.rows[0].cells.state = ['Active']],
  ['negative progress', value => value.rows[0].cells.current = -1],
  ['fractional desired progress', value => value.rows[0].cells.desired = 0.5],
  ['unsafe progress', value => value.rows[0].cells.current = Number.MAX_SAFE_INTEGER + 1],
  ['string reward amount', value => value.rows[0].cells.initialReward = '5000'],
  ['negative reserved reward', value => value.rows[0].cells.remainingReward = -1],
  ['non-finite reserved reward', value => value.rows[0].cells.remainingReward = Infinity],
  ['unsafe reserved reward', value => value.rows[0].cells.remainingReward = Number.MAX_SAFE_INTEGER + 1],
  ['invalid modified time', value => value.rows[0].cells.lastModified = 'invalid'],
  ['extra job description column', value => { value.columns.push({ key: 'description', label: 'Description' }); value.rows[0].cells.description = 'Synthetic private text'; }],
  ['cursor repeating current page', value => value.next.after = 'synthetic-current-cursor'],
  ['empty cursor', value => value.next.after = ''],
  ['oversized cursor', value => value.next.after = 'x'.repeat(513)],
  ['cursor whitespace', value => value.next.after = 'synthetic next'],
  ['cursor control character', value => value.next.after = 'synthetic\nnext'],
  ['numeric cursor', value => value.next.after = 123],
  ['cursor view mismatch', value => value.next.view = 'projects'],
  ['cursor character mismatch', value => value.next.characterId++],
  ['implicit public names consent', value => value.next.includeNames = true],
  ['unsupported reverse cursor', value => value.next.before = 'synthetic-before'],
  ['unexpected page parameter', value => value.next.page = 2],
  ['unexpected continuation URL', value => value.next.url = 'https://example.invalid/next'],
  ['unexpected participation action', value => value.rows[0].action = { label: 'Load participants', request: { characterId: args.characterId, view: 'project', projectId: value.rows[0].id } }],
]) test(`freelance client rejects ${name}`, () => {
  const { selected, value } = freelanceFixture(); mutate(value);
  assert.throws(() => harness().corporationWorkspaceResponse(value, selected), /incomplete response/);
});

for (const make of [extractionFixture, freelanceFixture]) {
  test(`${make.name} enforces the 100-row batch and rejects rows on permission failures`, () => {
    const { selected, value } = make(), client = harness();
    const first = value.rows[0];
    value.rows = Array.from({ length: 100 }, (_, index) => selected.view === 'extractions'
      ? { id: String(1000000000001 + index), cells: { ...first.cells, structure: 1000000000001 + index } }
      : { id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`, cells: { ...first.cells } });
    assert.equal(client.corporationWorkspaceResponse(value, selected), value);
    value.rows.push(first);
    assert.throws(() => client.corporationWorkspaceResponse(value, selected), /incomplete response/);
    Object.assign(value, { status: 'needs_permission', coverage: 'unavailable', columns: [], rows: [], sources: [], next: null, retrievedAt: null });
    assert.equal(client.corporationWorkspaceResponse(value, selected), value);
    value.rows = [first];
    assert.throws(() => client.corporationWorkspaceResponse(value, selected), /incomplete response/);
  });

  test(`${make.name} makes one explicit no-store request and retains selected name consent`, async () => {
    const { selected, value } = make(); selected.includeNames = true; value.next.includeNames = true;
    let calls = 0;
    const client = harness(async (url, init) => {
      calls++; assert.equal(url, '/api/eve/corporation-workspace'); assert.equal(init.cache, 'no-store');
      assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(init.body), selected); return Response.json(value);
    });
    await client.corporationWorkspaceRequest(selected, new AbortController().signal);
    assert.equal(calls, 1);
    delete value.next.includeNames;
    assert.throws(() => client.corporationWorkspaceResponse(value, selected), /incomplete response/);
  });
}

test('actual extraction and freelance service results satisfy the browser contract across pagination and failures', async () => {
  const load = (source, context = {}) => {
    const module = { exports: {} };
    vm.runInNewContext(source, { module, exports: module.exports, Date, AbortSignal, ...context });
    return module.exports;
  };
  const summary = load(compile('app/lib/overview-summary.ts'));
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const service = load(compile('app/lib/corporation-workspace.ts'), { require: path => path === './overview-summary' ? summary : { EveError } });
  const client = harness(), miningScope = 'esi-industry.read_corporation_mining.v1', jobScope = 'esi-corporations.read_freelance_jobs.v1';
  const extraction = index => ({ structure_id: 1000000000001 + index, moon_id: 40000001, extraction_start_time: stamp,
    chunk_arrival_time: '2026-01-02T00:00:00Z', natural_decay_time: '2026-01-03T00:00:00Z', observer: 'OMIT_PRIVATE_FIELDS' });
  const job = { id: '11111111-1111-4111-8111-111111111111', name: 'Synthetic job', state: 'Active', last_modified: stamp,
    progress: { current: 25, desired: 100 }, reward: { initial: 5000.25, remaining: 3750.5 }, description: 'OMIT_PRIVATE_FIELDS' };
  for (const view of ['extractions', 'freelance_jobs']) {
    let reads = 0;
    const selected = { characterId: args.characterId, view, includeNames: true };
    const scope = view === 'extractions' ? miningScope : jobScope;
    const deps = { connections: async () => [{ characterId: args.characterId, scopes: [scope] }], now: () => Date.parse(stamp),
      publicNames: async () => { throw Error('Unexpected names lookup'); },
      corporation: async (_owner, request) => {
        reads++;
        return { entity: 'corporation', characterId: args.characterId, corporationId: 98000001, dataset: request.dataset, retrievedAt: stamp, cacheExpires: null,
          data: view === 'extractions' ? Array.from({ length: 101 }, (_, index) => extraction(index)) : { freelance_jobs: [job, { ...job, id: '11111111-1111-4111-8111-111111111112', reward: undefined }] },
          pagination: view === 'extractions' ? { kind: 'page', page: request.parameters.page, pages: 2, nextPage: request.parameters.page === 1 ? 2 : null }
            : { kind: 'cursor', after: request.parameters.after ? null : 'synthetic-next-cursor' },
        };
      },
    };
    const read = service.createCorporationWorkspaceReader(deps);
    let current = selected;
    for (let batch = 0; batch < (view === 'extractions' ? 3 : 2); batch++) {
      const result = await read('synthetic-owner', current);
      assert.ok(['ready', 'partial'].includes(result.status));
      assert.equal(client.corporationWorkspaceResponse(result, current), result);
      assert.ok(result.rows.length <= 100); assert.ok(!JSON.stringify(result).includes('OMIT_PRIVATE_FIELDS'));
      current = result.next;
    }
    assert.equal(reads, view === 'extractions' ? 3 : 2);
    const denied = await service.createCorporationWorkspaceReader({ ...deps, connections: async () => [{ characterId: args.characterId, scopes: [] }] })('synthetic-owner', selected);
    assert.equal(denied.status, 'needs_permission'); assert.equal(client.corporationWorkspaceResponse(denied, selected), denied);
    const failed = await service.createCorporationWorkspaceReader({ ...deps, corporation: async () => { throw new EveError('Synthetic provider failure', 502); } })('synthetic-owner', selected);
    assert.equal(failed.status, 'error'); assert.equal(client.corporationWorkspaceResponse(failed, selected), failed);
  }
});
