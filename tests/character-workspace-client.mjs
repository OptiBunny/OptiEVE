import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const compile = file => ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const connectionCode = compile('app/lib/connection-client.ts'), code = compile('app/lib/character-workspace-client.ts');
function harness(fetch = () => { throw Error('Unexpected request'); }, timers = {}) {
  const connection = { exports: {} }, client = { exports: {} }, context = { URL, AbortController, setTimeout, clearTimeout, fetch, ...timers };
  vm.runInNewContext(connectionCode, { ...context, module: connection, exports: connection.exports });
  vm.runInNewContext(code, { ...context, module: client, exports: client.exports, require: () => connection.exports });
  return client.exports;
}
const args = { characterId: 90000001, view: 'standings' }, stamp = '2026-01-01T00:00:00Z';
const scopes = { standings: 'esi-characters.read_standings.v1', loyalty_points: 'esi-characters.read_loyalty.v1', faction_warfare: 'esi-characters.read_fw_stats.v1' };
const count = (label, value) => ({ label, value, unit: 'count' });
function fixture(view = 'standings') {
  const result = { ...args, view, generatedAt: stamp, status: 'ready', coverage: 'complete', message: 'Synthetic response.', scope: scopes[view], retrievedAt: stamp, cacheExpires: null, metrics: [], columns: [], rows: [], next: null };
  if (view === 'standings') Object.assign(result, {
    metrics: [count('Standings returned', 3), count('Positive standings', 1), count('Negative standings', 1), count('Zero standings', 1)],
    columns: [{ key: 'kind', label: 'Source kind' }, { key: 'sourceId', label: 'Source ID' }, { key: 'standing', label: 'Reported standing', unit: 'standing' }],
    rows: [{ id: 'agent-91001', cells: { kind: 'Agent', sourceId: 91001, standing: -10 } }, { id: 'npc_corp-91002', cells: { kind: 'NPC corporation', sourceId: 91002, standing: 0 } }, { id: 'faction-91003', cells: { kind: 'Faction', sourceId: 91003, standing: 1e-9 } }],
  });
  if (view === 'loyalty_points') Object.assign(result, {
    metrics: [count('NPC corporations returned', 2), count('Corporations with LP', 1)],
    columns: [{ key: 'corporationId', label: 'NPC corporation ID' }, { key: 'points', label: 'Loyalty points', unit: 'LP' }],
    rows: [{ id: '91001', cells: { corporationId: 91001, points: 0 } }, { id: '91002', cells: { corporationId: 91002, points: 123456 } }],
  });
  if (view === 'faction_warfare') Object.assign(result, {
    metrics: [{ label: 'Enrollment', value: 'Reported' }, { label: 'Faction ID', value: 91001 }, { label: 'Enlisted (UTC)', value: stamp, unit: 'datetime' }, count('Current rank', 0), { label: 'Highest rank', value: 'Not reported' }],
    columns: [{ key: 'period', label: 'Period' }, { key: 'kills', label: 'Kills', unit: 'count' }, { key: 'victoryPoints', label: 'Victory points', unit: 'count' }],
    rows: [{ id: 'yesterday', cells: { period: 'Yesterday', kills: 0, victoryPoints: 1 } }, { id: 'last_week', cells: { period: 'Last week', kills: 3, victoryPoints: 4 } }, { id: 'total', cells: { period: 'Reported total', kills: 8, victoryPoints: 9 } }],
  });
  return result;
}

for (const view of Object.keys(scopes)) test(`reputation client accepts selected ${view} with explicit units and genuine zeros`, () => {
  const value = fixture(view); assert.equal(harness().characterWorkspaceResponse(value, { ...args, view }), value);
});
test('rendered messages remain plain text values', () => {
  const value = fixture(); value.message = '<img src="https://example.invalid/pixel" onerror="synthetic()">';
  assert.equal(harness().characterWorkspaceResponse(value, args).message, value.message);
});
for (const [name, mutate] of [
  ['another character', value => value.characterId++], ['another view', value => value.view = 'loyalty_points'],
  ['wrong scope', value => value.scope = scopes.faction_warfare], ['source URL', value => value.source = 'https://example.invalid/private'],
  ['creator identity', value => value.creator = { id: 99 }], ['response offset', value => value.offset = 0],
  ['missing next', value => delete value.next], ['invalid generated time', value => value.generatedAt = 'invalid'],
  ['invalid cache time', value => value.cacheExpires = 'invalid'], ['invalid fetch time', value => value.retrievedAt = 'invalid'],
  ['unavailable coverage on available rows', value => value.coverage = 'unavailable'], ['unknown status', value => value.status = 'complete'],
  ['coerced status', value => value.status = ['ready']], ['coerced coverage', value => value.coverage = ['complete']],
  ['unknown metric label', value => value.metrics[0].label = 'Private identity'], ['unknown metric field', value => value.metrics[0].creator = 'synthetic'],
  ['string count', value => value.metrics[0].value = '3'], ['LP sum metric', value => value.metrics[0].unit = 'LP'],
  ['negative count', value => value.metrics[0].value = -1], ['excessive count', value => value.metrics[0].value = 10001],
  ['inconsistent category counts', value => value.metrics[1].value = 0], ['extra metric', value => value.metrics.push(count('Creator', 1))],
  ['missing column', value => value.columns.pop()], ['extra column', value => value.columns.push({ key: 'creator', label: 'Creator' })],
  ['changed column label', value => value.columns[0].label = 'Private identity'], ['wrong standing unit', value => value.columns[2].unit = 'ISK'],
  ['unknown column field', value => value.columns[0].private = true], ['extra row cell', value => value.rows[0].cells.name = 'synthetic'],
  ['duplicate row', value => value.rows[1] = value.rows[0]], ['missing cell', value => delete value.rows[0].cells.kind],
  ['private row detail', value => value.rows[0].detail = 'synthetic'], ['row action', value => value.rows[0].action = { label: 'Write' }],
  ['coerced NPC kind', value => value.rows[0].cells.kind = ['Agent']], ['player kind', value => value.rows[0].cells.kind = 'Character'],
  ['negative ID', value => value.rows[0].cells.sourceId = -1], ['string ID', value => value.rows[0].cells.sourceId = '91001'],
  ['mismatched row ID', value => value.rows[0].id = 'agent-1234'], ['unsafe ID', value => value.rows[0].cells.sourceId = Number.MAX_SAFE_INTEGER + 1],
  ['standing above range', value => value.rows[0].cells.standing = 10.1], ['standing below range', value => value.rows[0].cells.standing = -10.1],
  ['string standing', value => value.rows[0].cells.standing = '10'], ['infinite standing', value => value.rows[0].cells.standing = Infinity],
  ['unbounded message', value => value.message = 'x'.repeat(2049)], ['rows over limit', value => value.rows = Array(101).fill(value.rows[0])],
]) test(`reputation client rejects ${name}`, () => { const value = fixture(); mutate(value); assert.throws(() => harness().characterWorkspaceResponse(value, args), /incomplete response/); });

test('continuations keep view/character and advance one bounded slice', () => {
  const value = fixture('loyalty_points'), selected = { ...args, view: 'loyalty_points', offset: 100 };
  value.status = 'partial'; value.coverage = 'partial'; value.metrics = [count('NPC corporations returned', 201), count('Corporations with LP', 0)];
  value.rows = Array.from({ length: 100 }, (_, index) => ({ id: String(92000 + index), cells: { corporationId: 92000 + index, points: 0 } }));
  value.next = { ...selected, offset: 200 };
  assert.equal(harness().characterWorkspaceResponse(value, selected), value);
  for (const next of [{ ...value.next, offset: 100 }, { ...value.next, offset: 300 }, { ...value.next, view: 'standings' }, { ...value.next, characterId: 99 }, { ...value.next, private: true }, { ...value.next, offset: 10000 }]) {
    assert.throws(() => harness().characterWorkspaceResponse({ ...value, next }, selected), /incomplete response/);
  }
  assert.throws(() => harness().characterWorkspaceResponse({ ...value, next: null }, selected), /incomplete response/);
  assert.throws(() => harness().characterWorkspaceResponse({ ...value, status: 'ready', coverage: 'complete' }, selected), /incomplete response/);
  value.rows.pop(); assert.throws(() => harness().characterWorkspaceResponse(value, selected), /incomplete response/);
});
test('complete list coverage cannot silently truncate the response total', () => {
  const value = fixture('loyalty_points'), selected = { ...args, view: 'loyalty_points' };
  value.metrics[0].value = 3;
  assert.throws(() => harness().characterWorkspaceResponse(value, selected), /incomplete response/);
});
test('an obsolete later slice is explicit unknown coverage without zero totals', () => {
  const value = fixture(); Object.assign(value, { status: 'partial', coverage: 'unknown', metrics: [], rows: [] });
  assert.equal(harness().characterWorkspaceResponse(value, { ...args, offset: 100 }), value);
  assert.throws(() => harness().characterWorkspaceResponse(value, args), /incomplete response/);
});
test('cache-expired complete data stays limited rather than masquerading as current', () => {
  const value = fixture(); value.cacheExpires = stamp; value.status = 'partial';
  assert.equal(harness().characterWorkspaceResponse(value, args), value);
  value.status = 'ready'; assert.throws(() => harness().characterWorkspaceResponse(value, args), /incomplete response/);
});
test('missing permissions, denials and failures contain no rows or invented zero metrics', () => {
  for (const status of ['needs_permission', 'unavailable', 'error']) {
    const value = fixture(); Object.assign(value, { status, coverage: 'unavailable', metrics: [], columns: [], rows: [], retrievedAt: null });
    assert.equal(harness().characterWorkspaceResponse(value, args), value);
    value.metrics.push(count('Standings returned', 0)); assert.throws(() => harness().characterWorkspaceResponse(value, args), /incomplete response/);
  }
});
for (const [name, mutate] of [
  ['negative LP', value => value.rows[0].cells.points = -1], ['fractional LP', value => value.rows[0].cells.points = 0.5],
  ['string LP', value => value.rows[0].cells.points = '1'], ['ISK unit', value => value.columns[1].unit = 'ISK'],
  ['wrong corporation row identity', value => value.rows[0].id = '92000'],
]) test(`loyalty rejects ${name}`, () => { const value = fixture('loyalty_points'); mutate(value); assert.throws(() => harness().characterWorkspaceResponse(value, { ...args, view: 'loyalty_points' }), /incomplete response/); });
for (const [name, mutate] of [
  ['today instead of yesterday', value => value.rows[0].cells.period = 'Today'], ['extra period', value => value.rows.push({ id: 'today', cells: { period: 'Today', kills: 1, victoryPoints: 2 } })],
  ['missing period', value => value.rows.pop()], ['negative kills', value => value.rows[0].cells.kills = -1],
  ['fractional victory points', value => value.rows[0].cells.victoryPoints = 1.2], ['row action', value => value.rows[0].action = 'synthetic'],
  ['false confirmed enrollment', value => value.metrics[0].value = 'Not enlisted'], ['inconsistent enrollment', value => value.metrics[0].value = 'Not reported'],
  ['numeric string rank', value => value.metrics[3].value = '0'], ['missing value represented as zero', value => value.metrics[4].value = 0],
  ['string faction ID', value => value.metrics[1].value = '91001'], ['invalid enlistment date', value => value.metrics[2].value = 'invalid'],
  ['FW continuation', value => value.next = { ...args, view: 'faction_warfare' }],
]) test(`faction warfare rejects ${name}`, () => { const value = fixture('faction_warfare'); mutate(value); assert.throws(() => harness().characterWorkspaceResponse(value, { ...args, view: 'faction_warfare' }), /incomplete response/); });
test('successful missing or incomplete enrollment fields remain explicitly unreported', () => {
  const value = fixture('faction_warfare'), selected = { ...args, view: 'faction_warfare' };
  value.metrics[0].value = 'Not reported'; value.metrics[1].value = 'Not reported'; value.metrics[2] = { label: 'Enlisted (UTC)', value: 'Not reported' };
  assert.equal(harness().characterWorkspaceResponse(value, selected), value);
  value.metrics[0].value = 'Incomplete fields'; value.metrics[1].value = 91001; value.status = 'partial'; value.coverage = 'unknown';
  assert.equal(harness().characterWorkspaceResponse(value, selected), value);
});

test('reputation requests use same-origin POST, no-store and cancellation', async () => {
  let calls = 0;
  const client = harness(async (url, init) => { calls++; assert.equal(url, '/api/eve/character-workspace'); assert.equal(init.method, 'POST'); assert.equal(init.cache, 'no-store'); assert.ok(init.signal instanceof AbortSignal); assert.deepEqual(JSON.parse(init.body), args); return Response.json(fixture()); });
  assert.equal((await client.characterWorkspaceRequest(args, new AbortController().signal)).characterId, args.characterId); assert.equal(calls, 1);
});
for (const input of [{ ...args, view: 'contacts' }, { ...args, offset: 1 }, { ...args, offset: 10000 }, { ...args, view: 'faction_warfare', offset: 0 }, { ...args, page: 1 }, { ...args, characterId: '90000001' }]) test(`invalid request is rejected before network ${JSON.stringify(input)}`, async () => {
  await assert.rejects(harness().characterWorkspaceRequest(input, new AbortController().signal), /supported reputation view/);
});
test('signed-out gateway response cancels unread body without exposing HTML', async () => {
  let cancelled = false;
  const client = harness(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 401 }));
  await assert.rejects(client.characterWorkspaceRequest(args, new AbortController().signal), error => error.status === 401 && /Sign in/.test(error.message)); assert.ok(cancelled);
});
for (const status of [403, 404, 429, 503]) test(`HTTP${status} does not echo provider content or fabricate data`, async () => {
  await assert.rejects(harness(async () => Response.json({ error: 'OMIT_PRIVATE_UPSTREAM' }, { status })).characterWorkspaceRequest(args, new AbortController().signal), error => error.status === status && !/OMIT_PRIVATE/.test(error.message));
});
test('malformed JSON and network errors are generic', async () => {
  await assert.rejects(harness(async () => new Response('OMIT_PRIVATE_UPSTREAM')).characterWorkspaceRequest(args, new AbortController().signal), /unreadable response/);
  await assert.rejects(harness(async () => { throw Error('OMIT_PRIVATE_NETWORK'); }).characterWorkspaceRequest(args, new AbortController().signal), /Could not reach/);
});
test('an already cancelled request performs no fetch', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(harness().characterWorkspaceRequest(args, controller.signal), /cancelled/);
});
test('cancellation and timeout abort in-flight reads and release timers', async () => {
  for (const timedOut of [false, true]) {
    const controller = new AbortController(); let deadline, cleared = false;
    const client = harness((url, init) => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(Error('OMIT_PRIVATE'))); timedOut ? deadline() : controller.abort(); }), { setTimeout: callback => { deadline = callback; return 1; }, clearTimeout: () => { cleared = true; } });
    await assert.rejects(client.characterWorkspaceRequest(args, controller.signal), timedOut ? /too long/ : /cancelled/); assert.ok(cleared);
  }
});
test('formatting preserves identifiers, signed standings and distinct LP units', () => {
  const client = harness();
  assert.equal(client.formatCharacterValue(1000000001001, { key: 'sourceId' }), '1000000001001');
  assert.equal(client.formatCharacterValue(1e-9, { unit: 'standing' }), '+1e-9');
  assert.equal(client.formatCharacterValue(-1e-9, { unit: 'standing' }), '-1e-9');
  assert.equal(client.formatCharacterValue(0, { unit: 'standing' }), '0');
  assert.match(client.formatCharacterValue(1234, { unit: 'LP' }), / LP$/); assert.doesNotMatch(client.formatCharacterValue(1234, { unit: 'LP' }), /ISK/);
  assert.match(client.formatCharacterValue(stamp, { unit: 'datetime' }), / UTC$/);
});

test('actual reputation service outputs satisfy all browser contracts without additional reads', async () => {
  const load = (source, context = {}) => { const module = { exports: {} }; vm.runInNewContext(source, { module, exports: module.exports, Date, AbortSignal, ...context }); return module.exports; };
  const summary = load(compile('app/lib/overview-summary.ts'));
  class EveError extends Error { constructor(message, status = 400, reason, upstreamStatus) { super(message); this.status = status; this.upstreamStatus = upstreamStatus; } }
  const service = load(compile('app/lib/character-workspace.ts'), { require: path => path === './overview-summary' ? summary : { EveError } });
  for (const view of Object.keys(scopes)) {
    const selected = { ...args, view }; let reads = 0, shrink = false;
    const data = () => view === 'standings' ? Array.from({ length: shrink ? 2 : 101 }, (_, index) => ({ from_id: 92000 + index, from_type: 'faction', standing: index % 2 ? -2.5 : 0.5, creator: 'OMIT_PRIVATE' }))
      : view === 'loyalty_points' ? Array.from({ length: shrink ? 2 : 101 }, (_, index) => ({ corporation_id: 92000 + index, loyalty_points: index, creator: 'OMIT_PRIVATE' }))
      : { kills: { yesterday: 0, last_week: 2, total: 4 }, victory_points: { yesterday: 0, last_week: 3, total: 6 }, creator: 'OMIT_PRIVATE' };
    const read = service.createCharacterWorkspaceReader({ connections: async () => [{ characterId: args.characterId, scopes: [scopes[view]] }], now: () => Date.parse(stamp), character: async (_user, request, signal) => {
      reads++; assert.equal(request.dataset, view); assert.equal(request.characterId, args.characterId); assert.ok(signal instanceof AbortSignal);
      return { characterId: args.characterId, dataset: view, retrievedAt: stamp, pagination: { kind: 'none' }, data: data() };
    } });
    const first = await read('synthetic-owner', selected); assert.equal(harness().characterWorkspaceResponse(first, selected), first); assert.equal(reads, 1); assert.doesNotMatch(JSON.stringify(first), /OMIT_PRIVATE/);
    if (first.next) {
      const second = await read('synthetic-owner', first.next); assert.equal(harness().characterWorkspaceResponse(second, first.next), second); assert.equal(second.rows.length, 1); assert.equal(second.next, null);
      shrink = true; const obsolete = await read('synthetic-owner', first.next); assert.equal(harness().characterWorkspaceResponse(obsolete, first.next), obsolete); assert.equal(obsolete.metrics.length, 0);
    }
    const denied = await service.createCharacterWorkspaceReader({ connections: async () => [{ characterId: args.characterId, scopes: [] }], character: async () => { throw Error('Unexpected read'); }, now: () => Date.parse(stamp) })('synthetic-owner', selected);
    assert.equal(harness().characterWorkspaceResponse(denied, selected), denied); assert.equal(denied.status, 'needs_permission');
    if (view === 'faction_warfare') {
      for (const error of [new EveError('OMIT_PRIVATE', 403), new EveError('OMIT_PRIVATE', 502, undefined, 404)]) {
        const unavailable = await service.createCharacterWorkspaceReader({ connections: async () => [{ characterId: args.characterId, scopes: [scopes[view]] }], character: async () => { throw error; }, now: () => Date.parse(stamp) })('synthetic-owner', selected);
        assert.equal(harness().characterWorkspaceResponse(unavailable, selected), unavailable); assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.metrics.length, 0);
      }
    }
  }
});

const industryScopes = { blueprints: 'esi-characters.read_blueprints.v1', research: 'esi-characters.read_agents_research.v1', planets: 'esi-planets.manage_planets.v1', mining: 'esi-industry.read_character_mining.v1' };
function industryFixture(view) {
  const result = { ...fixture(), view, scope: industryScopes[view], rows: [], metrics: [], columns: [] };
  if (view === 'blueprints') Object.assign(result, {
    metrics: [count('Blueprint rows in this page', 3), count('Original rows', 1), count('Copy rows', 1), count('Original stack rows', 1)],
    columns: [{ key: 'item', label: 'Blueprint item ID' }, { key: 'type', label: 'Blueprint type ID' }, { key: 'kind', label: 'Blueprint kind' }, { key: 'units', label: 'Blueprint units', unit: 'count' }, { key: 'materialEfficiency', label: 'Material efficiency', unit: 'count' }, { key: 'timeEfficiency', label: 'Time efficiency', unit: 'count' }, { key: 'runs', label: 'Copy runs remaining / original' }, { key: 'location', label: 'Location ID' }, { key: 'flag', label: 'Location flag' }],
    rows: ['Original', 'Copy', 'Original stack'].map((kind, index) => ({ id: String(1000000001001 + index), cells: { item: 1000000001001 + index, type: 91001, kind, units: kind === 'Original stack' ? 5 : 1, materialEfficiency: 10, timeEfficiency: 20, runs: kind === 'Copy' ? 0 : 'Unlimited (original)', location: 1000000002001, flag: 'Hangar' } })),
  });
  if (view === 'research') Object.assign(result, {
    metrics: [count('Research agents returned', 1)],
    columns: [{ key: 'agent', label: 'Agent ID' }, { key: 'skill', label: 'Research skill type ID' }, { key: 'started', label: 'Research started (UTC)', unit: 'datetime' }, { key: 'daily', label: 'Reported rate', unit: 'RP/day' }, { key: 'remainder', label: 'Reported remainder', unit: 'RP' }],
    rows: [{ id: '91001', cells: { agent: 91001, skill: 91002, started: stamp, daily: 12.5, remainder: -0.25 } }],
  });
  if (view === 'planets') Object.assign(result, {
    metrics: [count('Colonies returned', 8)],
    columns: [{ key: 'planet', label: 'Planet ID' }, { key: 'system', label: 'Solar system ID' }, { key: 'type', label: 'Planet type' }, { key: 'upgrade', label: 'Command center upgrade', unit: 'count' }, { key: 'pins', label: 'Reported pins', unit: 'count' }, { key: 'updated', label: 'Colony updated (UTC)', unit: 'datetime' }],
    rows: ['temperate', 'barren', 'oceanic', 'ice', 'gas', 'lava', 'storm', 'plasma'].map((type, index) => ({ id: String(91001 + index), cells: { planet: 91001 + index, system: 92001, type, upgrade: index, pins: 100 + index, updated: stamp } })),
  });
  if (view === 'mining') Object.assign(result, {
    metrics: [count('Mining records in this page', 2), count('Types in this page', 2), count('Solar systems in this page', 1)],
    columns: [{ key: 'date', label: 'Date (UTC)' }, { key: 'type', label: 'Type ID' }, { key: 'system', label: 'Solar system ID' }, { key: 'quantity', label: 'Quantity', unit: 'count' }],
    rows: [0, Number.MAX_SAFE_INTEGER].map((quantity, index) => ({ id: `2024-02-29-${91001 + index}-92001`, cells: { date: '2024-02-29', type: 91001 + index, system: 92001, quantity } })),
  });
  return result;
}
for (const view of Object.keys(industryScopes)) {
  test(`industry accepts only the projected ${view} contract`, () => {
    const value = industryFixture(view), selected = { ...args, view };
    assert.equal(harness().characterWorkspaceResponse(value, selected), value);
    for (const mutate of [result => result.characterId++, result => result.scope = scopes.standings,
      result => result.rows[0].cells.owner = args.characterId, result => result.rows[0].action = 'write',
      result => result.rows[0].id = 'wrong', result => result.rows[0].name = 'OMIT_PRIVATE',
      result => result.columns[0].unit = 'ISK', result => result.metrics[0].label = 'Estimated profit',
      result => result.settings = { clientId: 'OMIT_PRIVATE' }, result => result.rows[1] = result.rows[0],
    ]) {
      const changed = structuredClone(value); mutate(changed);
      assert.throws(() => harness().characterWorkspaceResponse(changed, selected), /industry service returned an incomplete response/);
    }
    for (const status of ['needs_permission', 'unavailable', 'error']) {
      const unavailable = { ...value, status, coverage: 'unavailable', metrics: [], columns: [], rows: [], next: null, retrievedAt: null };
      assert.equal(harness().characterWorkspaceResponse(unavailable, selected), unavailable);
      assert.throws(() => harness().characterWorkspaceResponse({ ...unavailable, rows: value.rows }, selected), /incomplete response/);
    }
  });
  test(`industry ${view} requests are explicit same-origin reads without URL parameters`, async () => {
    const selected = { ...args, view }; let calls = 0;
    const client = harness(async (url, init) => { calls++; assert.equal(url, '/api/eve/character-workspace'); assert.equal(init.method, 'POST'); assert.equal(init.cache, 'no-store'); assert.deepEqual(JSON.parse(init.body), selected); return Response.json(industryFixture(view)); });
    assert.equal(calls, 0);
    assert.equal((await client.characterWorkspaceRequest(selected, new AbortController().signal)).view, view); assert.equal(calls, 1);
    await assert.rejects(harness(async () => { throw Error('OMIT_PRIVATE_NETWORK'); }).characterWorkspaceRequest(selected, new AbortController().signal), /Could not reach the industry service/);
  });
}
for (const [name, mutate] of [
  ['unsafe item ID', value => value.rows[0].cells.item = Number.MAX_SAFE_INTEGER + 1],
  ['fractional blueprint units', value => value.rows[2].cells.units = 1.5],
  ['copy represented as a stack', value => value.rows[1].cells.units = 2],
  ['original represented as a stack', value => value.rows[0].cells.units = 2],
  ['negative copy runs', value => value.rows[1].cells.runs = -1],
  ['finite original runs', value => value.rows[0].cells.runs = 0],
  ['coerced blueprint kind', value => value.rows[0].cells.kind = ['Original']],
  ['fractional efficiency', value => value.rows[0].cells.materialEfficiency = 0.5],
  ['negative efficiency', value => value.rows[0].cells.timeEfficiency = -1],
  ['free text location flag', value => value.rows[0].cells.flag = 'OMIT_PRIVATE'],
  ['whitespace-normalized flag', value => value.rows[0].cells.flag = ' Hangar '],
  ['inconsistent categories', value => value.metrics[1].value = 2],
  ['first-page false completion', value => value.next = { ...args, view: 'blueprints', page: 2, offset: 0 }],
]) test(`blueprint client rejects ${name}`, () => { const value = industryFixture('blueprints'); mutate(value); assert.throws(() => harness().characterWorkspaceResponse(value, { ...args, view: 'blueprints' }), /incomplete response/); });
for (const [name, mutate] of [
  ['negative rate', value => value.rows[0].cells.daily = -0.01], ['infinite rate', value => value.rows[0].cells.daily = Infinity],
  ['NaN remainder', value => value.rows[0].cells.remainder = NaN], ['unsafe remainder', value => value.rows[0].cells.remainder = -Number.MAX_SAFE_INTEGER - 1],
  ['string remainder', value => value.rows[0].cells.remainder = '-0.25'], ['invalid research date', value => value.rows[0].cells.started = 'invalid'],
  ['rate presented as balance', value => value.columns[3].unit = 'RP'], ['invented accrued balance', value => value.rows[0].cells.balance = 50],
]) test(`research client rejects ${name}`, () => { const value = industryFixture('research'); mutate(value); assert.throws(() => harness().characterWorkspaceResponse(value, { ...args, view: 'research' }), /incomplete response/); });
for (const [name, mutate] of [
  ['unknown planet type', value => value.rows[0].cells.type = 'fictional'], ['coerced planet type', value => value.rows[0].cells.type = ['temperate']],
  ['negative pin count', value => value.rows[0].cells.pins = -1], ['fractional upgrade', value => value.rows[0].cells.upgrade = 1.5],
  ['unsafe system ID', value => value.rows[0].cells.system = Number.MAX_SAFE_INTEGER + 1], ['invented extractor time', value => value.rows[0].cells.expiry = stamp],
]) test(`planet client rejects ${name}`, () => { const value = industryFixture('planets'); mutate(value); assert.throws(() => harness().characterWorkspaceResponse(value, { ...args, view: 'planets' }), /incomplete response/); });

test('research formatting preserves signed fractions and tiny values without an ISK balance', () => {
  const client = harness();
  for (const value of [-Number.MAX_SAFE_INTEGER, -1e-9, -0.25, 0, 12.5, Number.MAX_SAFE_INTEGER]) assert.equal(client.formatCharacterValue(value, { unit: 'RP' }), `${value} RP`);
  assert.equal(client.formatCharacterValue(12.5, { unit: 'RP/day' }), '12.5 RP/day');
  assert.equal(client.formatCharacterValue(1e-9, { unit: 'RP/day' }), '1e-9 RP/day');
  const response = industryFixture('research'); response.rows[0].cells.remainder = -1e-9; response.rows[0].cells.daily = 1e-9;
  assert.equal(client.characterWorkspaceResponse(response, { ...args, view: 'research' }), response);
});
for (const selected of [
  { ...args, view: 'blueprints', page: 0 }, { ...args, view: 'blueprints', page: 501 }, { ...args, view: 'blueprints', page: 1.5 },
  { ...args, view: 'blueprints', offset: 10000 }, { ...args, view: 'blueprints', offset: 50 },
  { ...args, view: 'research', page: 1 }, { ...args, view: 'planets', page: 1 }, { ...args, view: 'planets', planetId: 91001 },
]) test(`invalid industry request rejected before network ${JSON.stringify(selected)}`, async () => {
  await assert.rejects(harness().characterWorkspaceRequest(selected, new AbortController().signal), /supported industry view/);
});

function industryService(view, payload, pagination = { kind: 'none' }, publicNames) {
  const load = (source, context = {}) => { const module = { exports: {} }; vm.runInNewContext(source, { module, exports: module.exports, Date, AbortSignal, ...context }); return module.exports; };
  const summary = load(compile('app/lib/overview-summary.ts'));
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const service = load(compile('app/lib/character-workspace.ts'), { require: path => path === './overview-summary' ? summary : { EveError } });
  let reads = 0;
  const read = service.createCharacterWorkspaceReader({ publicNames, connections: async () => [{ characterId: args.characterId, scopes: [industryScopes[view]] }], now: () => Date.parse(stamp), character: async (_user, selected, signal) => {
    reads++; assert.equal(selected.dataset, view); assert.equal(selected.characterId, args.characterId); assert.ok(signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(selected).sort(), (['blueprints', 'mining'].includes(view) ? ['characterId', 'dataset', 'parameters'] : ['characterId', 'dataset']).sort());
    return { characterId: args.characterId, dataset: view, retrievedAt: stamp, pagination: typeof pagination === 'function' ? pagination(selected) : pagination, data: typeof payload === 'function' ? payload(selected) : payload };
  } });
  return { read: selected => read('synthetic-owner', selected), reads: () => reads };
}
const blueprintData = length => Array.from({ length }, (_, index) => ({ item_id: 1000000001001 + index, type_id: 91001, location_id: 1000000002001, location_flag: 'Hangar', quantity: index % 3 === 0 ? -1 : index % 3 === 1 ? -2 : 5, material_efficiency: 10, time_efficiency: 20, runs: index % 3 === 1 ? 0 : -1, creator: 'OMIT_PRIVATE' }));

test('actual blueprint service and client retain provider pages, slices and unknown coverage', async () => {
  for (const pages of [1, 2, null]) {
    let length = 102;
    const service = industryService('blueprints', () => blueprintData(length), selected => ({ kind: 'page', page: selected.parameters.page, pages, nextPage: pages !== null && selected.parameters.page < pages ? selected.parameters.page + 1 : null }));
    const selected = { ...args, view: 'blueprints' }, first = await service.read(selected), client = harness();
    assert.equal(client.characterWorkspaceResponse(first, selected), first); assert.equal(first.rows.length, 100); assert.equal(first.coverage, pages === null ? 'unknown' : 'partial');
    assert.deepEqual(JSON.parse(JSON.stringify(first.next)), { ...selected, page: 1, offset: 100 }); assert.equal(service.reads(), 1); assert.doesNotMatch(JSON.stringify(first), /OMIT_PRIVATE/);
    for (const next of [{ ...first.next, page: 2 }, { ...first.next, offset: 200 }, { ...first.next, view: 'research' }, { ...first.next, characterId: 1 }, null]) {
      assert.throws(() => client.characterWorkspaceResponse({ ...first, next }, selected), /incomplete response/);
    }
    const last = await service.read(first.next); assert.equal(client.characterWorkspaceResponse(last, first.next), last); assert.equal(last.rows.length, 2);
    if (pages === 2) {
      assert.deepEqual(JSON.parse(JSON.stringify(last.next)), { ...selected, page: 2, offset: 0 });
      for (const next of [{ ...last.next, page: 3 }, { ...last.next, offset: 100 }, { ...last.next, page: 1 }]) assert.throws(() => client.characterWorkspaceResponse({ ...last, next }, first.next), /incomplete response/);
      length = 1; const final = await service.read(last.next); assert.equal(client.characterWorkspaceResponse(final, last.next), final); assert.equal(final.coverage, 'partial'); assert.equal(final.next, null);
      assert.throws(() => client.characterWorkspaceResponse({ ...final, coverage: 'complete', status: 'ready' }, last.next), /incomplete response/);
    } else assert.equal(last.next, null);
    length = 1; const obsolete = await service.read(first.next); assert.equal(client.characterWorkspaceResponse(obsolete, first.next), obsolete); assert.equal(obsolete.metrics.length, 0); assert.equal(obsolete.coverage, 'unknown');
  }
});
test('blueprint final-page cap and single-page empty response never invent completion', async () => {
  const selected = { ...args, view: 'blueprints', page: 500, offset: 0 };
  const capped = await industryService('blueprints', blueprintData(1), { kind: 'page', page: 500, pages: 501, nextPage: null }).read(selected);
  assert.equal(harness().characterWorkspaceResponse(capped, selected), capped); assert.equal(capped.next, null); assert.equal(capped.coverage, 'partial');
  const first = { ...args, view: 'blueprints' };
  const empty = await industryService('blueprints', [], { kind: 'page', page: 1, pages: 1, nextPage: null }).read(first);
  assert.equal(harness().characterWorkspaceResponse(empty, first), empty); assert.equal(empty.status, 'ready'); assert.equal(empty.rows.length, 0);
});
for (const view of ['research', 'planets']) test(`actual ${view} service and client preserve selected ownership, projection and bounded continuation`, async () => {
  let length = 101, wrongOwner = false;
  const service = industryService(view, () => Array.from({ length }, (_, index) => view === 'research'
    ? { agent_id: 91001 + index, skill_type_id: 92001, started_at: stamp, points_per_day: 1e-9, remainder_points: -1e-9, private_name: 'OMIT_PRIVATE' }
    : { planet_id: 91001 + index, solar_system_id: 92001, planet_type: 'temperate', owner_id: wrongOwner ? 1 : args.characterId, last_update: stamp, upgrade_level: 10, num_pins: 1000, routes: ['OMIT_PRIVATE'] }));
  const selected = { ...args, view }, first = await service.read(selected), client = harness();
  assert.equal(client.characterWorkspaceResponse(first, selected), first); assert.equal(first.rows.length, 100); assert.equal(service.reads(), 1); assert.doesNotMatch(JSON.stringify(first), /OMIT_PRIVATE|"owner_id"|"private_name"|"routes"/);
  const last = await service.read(first.next); assert.equal(client.characterWorkspaceResponse(last, first.next), last); assert.equal(last.rows.length, 1); assert.equal(last.next, null);
  for (const next of [{ ...first.next, offset: 200 }, { ...first.next, view: view === 'research' ? 'planets' : 'research' }, { ...first.next, page: 1 }, null]) assert.throws(() => client.characterWorkspaceResponse({ ...first, next }, selected), /incomplete response/);
  length = 1; const obsolete = await service.read(first.next); assert.equal(client.characterWorkspaceResponse(obsolete, first.next), obsolete); assert.equal(obsolete.metrics.length, 0);
  if (view === 'planets') {
    wrongOwner = true; const denied = await service.read(selected); assert.equal(client.characterWorkspaceResponse(denied, selected), denied); assert.equal(denied.status, 'error'); assert.equal(denied.rows.length, 0);
  }
});

for (const [name, mutate] of [
  ['nonexistent leap date', value => value.rows[0].cells.date = '2025-02-29'],
  ['rollover day', value => value.rows[0].cells.date = '2026-04-31'],
  ['month zero', value => value.rows[0].cells.date = '2026-00-01'],
  ['month thirteen', value => value.rows[0].cells.date = '2026-13-01'],
  ['localized date', value => value.rows[0].cells.date = '02/29/2024'],
  ['timestamp instead of day', value => value.rows[0].cells.date += 'T00:00:00Z'],
  ['quantity precision loss', value => value.rows[0].cells.quantity = Number.MAX_SAFE_INTEGER + 1],
  ['negative quantity', value => value.rows[0].cells.quantity = -1],
  ['fractional quantity', value => value.rows[0].cells.quantity = 0.5],
  ['string quantity', value => value.rows[0].cells.quantity = '100'],
  ['missing type', value => delete value.rows[0].cells.type],
  ['unsafe system', value => value.rows[0].cells.system = Number.MAX_SAFE_INTEGER + 1],
  ['foreign composite row identity', value => value.rows[0].id = '2024-02-29-99999-92001'],
  ['quantity relabeled as ISK', value => value.columns[3].unit = 'ISK'],
  ['fabricated type count', value => value.metrics[1].value = 1],
  ['fabricated system count', value => value.metrics[2].value = 2],
  ['type count exceeds page records', value => value.metrics[1].value = 3],
]) test(`mining client rejects ${name}`, () => {
  const value = industryFixture('mining'); mutate(value);
  assert.throws(() => harness().characterWorkspaceResponse(value, { ...args, view: 'mining' }), /incomplete response/);
});

for (const selected of [
  { ...args, resolveNames: true }, { ...args, view: 'faction_warfare', resolveNames: false },
  { ...args, view: 'mining', page: 0 }, { ...args, view: 'mining', page: 501 },
  { ...args, view: 'mining', offset: 1 }, { ...args, view: 'mining', resolveNames: 'true' },
  { ...args, view: 'blueprints', resolveNames: [] }, { ...args, view: 'mining', names: [91001] },
]) test(`invalid name or mining request never fetches ${JSON.stringify(selected)}`, async () => {
  await assert.rejects(harness().characterWorkspaceRequest(selected, new AbortController().signal), /supported .* view/);
});

function namedFixture(view) {
  const value = industryFixture(view), names = new Map();
  for (const row of value.rows) {
    if (view === 'blueprints' || view === 'mining') names.set(row.cells.type, { id: row.cells.type, category: 'inventory_type', name: `Synthetic type ${row.cells.type}` });
    if (view === 'research') names.set(row.cells.skill, { id: row.cells.skill, category: 'inventory_type', name: `Synthetic skill ${row.cells.skill}` });
    if (view === 'planets' || view === 'mining') names.set(row.cells.system, { id: row.cells.system, category: 'solar_system', name: `Synthetic system ${row.cells.system}` });
  }
  value.labels = { status: 'ready', message: 'Synthetic public names.', retrievedAt: stamp, cacheExpires: null, names: [...names.values()] };
  return value;
}
for (const view of Object.keys(industryScopes)) test(`public names are opt-in and only decorate eligible ${view} cells`, () => {
  const value = namedFixture(view), selected = { ...args, view, resolveNames: true }, client = harness();
  assert.equal(client.characterWorkspaceResponse(value, selected), value);
  assert.throws(() => client.characterWorkspaceResponse(value, { ...args, view }), /incomplete response/);
  assert.throws(() => client.characterWorkspaceResponse(value, { ...args, view, resolveNames: false }), /incomplete response/);
  assert.throws(() => client.characterWorkspaceResponse(industryFixture(view), selected), /incomplete response/);
  const label = value.labels.names[0];
  const column = view === 'blueprints' || view === 'mining' ? 'type' : view === 'research' ? 'skill' : 'system';
  assert.equal(client.characterPublicName(value, column, label.id), label.name);
  for (const privateColumn of ['item', 'location', 'planet', 'agent', 'owner', 'characterId']) assert.equal(client.characterPublicName(value, privateColumn, label.id), undefined);
  assert.equal(client.characterPublicName(value, column, String(label.id)), undefined);
  assert.equal(client.characterPublicName(value, column, 99999), undefined);
  const unavailable = { ...value, labels: { status: 'unavailable', message: 'Public names unavailable; exact IDs remain.', retrievedAt: null, cacheExpires: null, names: [] } };
  assert.equal(client.characterWorkspaceResponse(unavailable, selected), unavailable); assert.equal(unavailable.status, value.status); assert.equal(unavailable.rows, value.rows);
});

for (const [name, mutate] of [
  ['foreign name ID', value => value.labels.names[0].id = 99999],
  ['private item ID', value => value.labels.names[0].id = 1000000001001],
  ['private category', value => value.labels.names[0].category = 'character'],
  ['wrong public category', value => value.labels.names[0].category = 'solar_system'],
  ['duplicate label', value => value.labels.names.push(value.labels.names[0])],
  ['raw identity field', value => value.labels.names[0].owner = 99999],
  ['label URL field', value => value.labels.names[0].url = 'https://example.invalid'],
  ['envelope raw provider field', value => value.labels.raw = 'OMIT_PRIVATE'],
  ['missing envelope message', value => delete value.labels.message],
  ['unbounded label message', value => value.labels.message = 'x'.repeat(2049)],
  ['unbounded name', value => value.labels.names[0].name = 'x'.repeat(513)],
  ['blank name', value => value.labels.names[0].name = '   '],
  ['untrimmed name', value => value.labels.names[0].name = ' Synthetic '],
  ['control character', value => value.labels.names[0].name = 'Synthetic\nName'],
  ['DEL character', value => value.labels.names[0].name = 'Synthetic\x7fName'],
  ['bidi override', value => value.labels.names[0].name = 'Synthetic\u202eName'],
  ['bidi isolate', value => value.labels.names[0].name = 'Synthetic\u2066Name'],
  ['coerced name', value => value.labels.names[0].name = ['Synthetic']],
  ['invalid public fetch time', value => value.labels.retrievedAt = 'invalid'],
  ['invalid public expiry', value => value.labels.cacheExpires = 'invalid'],
  ['missing public fetch time', value => value.labels.retrievedAt = null],
  ['false ready for missing labels', value => value.labels.names = []],
  ['false partial for complete labels', value => value.labels.status = 'partial'],
  ['false ready for expired labels', value => value.labels.cacheExpires = stamp],
  ['unavailable with public rows', value => { value.labels.status = 'unavailable'; value.labels.retrievedAt = null; }],
  ['unavailable with source time', value => { value.labels.status = 'unavailable'; value.labels.names = []; }],
  ['unknown status', value => value.labels.status = 'cached'],
  ['oversized names list', value => value.labels.names = Array(201).fill(value.labels.names[0])],
]) test(`public-name client rejects ${name}`, () => {
  const value = namedFixture('blueprints'); mutate(value);
  assert.throws(() => harness().characterWorkspaceResponse(value, { ...args, view: 'blueprints', resolveNames: true }), /incomplete response/);
});

test('partial and stale public names keep primary coverage, IDs and decimal values', () => {
  const client = harness(), selected = { ...args, view: 'mining', resolveNames: true }, value = namedFixture('mining');
  value.labels.names.pop(); value.labels.status = 'partial';
  assert.equal(client.characterWorkspaceResponse(value, selected), value); assert.equal(value.status, 'ready'); assert.equal(value.coverage, 'complete');
  value.labels.names = []; assert.equal(client.characterWorkspaceResponse(value, selected), value);
  const research = namedFixture('research'); research.labels.status = 'partial'; research.labels.cacheExpires = stamp;
  assert.equal(client.characterWorkspaceResponse(research, { ...args, view: 'research', resolveNames: true }), research);
  assert.equal(research.rows[0].cells.remainder, -0.25);
});

test('empty, obsolete or failed responses never include public labels', () => {
  const client = harness(), selected = { ...args, view: 'mining', resolveNames: true }, value = industryFixture('mining');
  value.rows = []; value.metrics = value.metrics.map(metric => ({ ...metric, value: 0 }));
  assert.equal(client.characterWorkspaceResponse(value, selected), value);
  const labels = namedFixture('mining').labels;
  assert.throws(() => client.characterWorkspaceResponse({ ...value, labels }, selected), /incomplete response/);
  for (const status of ['needs_permission', 'unavailable', 'error']) {
    const unavailable = { ...value, status, coverage: 'unavailable', metrics: [], columns: [], retrievedAt: null };
    assert.equal(client.characterWorkspaceResponse(unavailable, selected), unavailable);
    assert.throws(() => client.characterWorkspaceResponse({ ...unavailable, labels }, selected), /incomplete response/);
  }
  Object.assign(value, { status: 'partial', coverage: 'unknown', metrics: [] });
  assert.equal(client.characterWorkspaceResponse(value, { ...selected, offset: 100 }), value);
  assert.throws(() => client.characterWorkspaceResponse({ ...value, labels }, { ...selected, offset: 100 }), /incomplete response/);
});

test('calendar dates and numeric identifiers retain their exact text', () => {
  const client = harness();
  assert.equal(client.formatCharacterValue('2024-02-29', { key: 'date' }), '2024-02-29');
  assert.equal(client.formatCharacterValue(Number.MAX_SAFE_INTEGER, { key: 'type' }), String(Number.MAX_SAFE_INTEGER));
  const value = namedFixture('blueprints'); value.labels.names[0].name = '<img src="https://example.invalid/pixel" onerror="synthetic()">';
  assert.equal(client.characterWorkspaceResponse(value, { ...args, view: 'blueprints', resolveNames: true }), value);
  assert.equal(client.characterPublicName(value, 'type', value.labels.names[0].id), value.labels.names[0].name);
});

const miningData = length => Array.from({ length }, (_, index) => ({ date: '2025-12-31', type_id: 91001 + index, solar_system_id: 92001, quantity: index === 0 ? Number.MAX_SAFE_INTEGER : index, observer_id: 'OMIT_PRIVATE' }));
test('actual mining service/client retain paging, unknown coverage and exact composite identities', async () => {
  for (const pages of [1, 2, null]) {
    let length = 102;
    const service = industryService('mining', () => miningData(length), selected => ({ kind: 'page', page: selected.parameters.page, pages, nextPage: pages !== null && selected.parameters.page < pages ? selected.parameters.page + 1 : null }));
    const selected = { ...args, view: 'mining' }, first = await service.read(selected), client = harness();
    assert.equal(client.characterWorkspaceResponse(first, selected), first); assert.equal(first.rows.length, 100); assert.equal(first.coverage, pages === null ? 'unknown' : 'partial');
    assert.equal(first.rows[0].cells.date, '2025-12-31'); assert.equal(first.rows[0].cells.quantity, Number.MAX_SAFE_INTEGER); assert.doesNotMatch(JSON.stringify(first), /OMIT_PRIVATE/);
    for (const next of [{ ...first.next, page: 2 }, { ...first.next, offset: 200 }, { ...first.next, resolveNames: true }, { ...first.next, resolveNames: false }, null]) assert.throws(() => client.characterWorkspaceResponse({ ...first, next }, selected), /incomplete response/);
    const second = await service.read(first.next); assert.equal(client.characterWorkspaceResponse(second, first.next), second); assert.equal(second.rows.length, 2);
    if (pages === 2) { length = 1; const final = await service.read(second.next); assert.equal(client.characterWorkspaceResponse(final, second.next), final); assert.equal(final.coverage, 'partial'); }
    else assert.equal(second.next, null);
    length = 1; const obsolete = await service.read(first.next); assert.equal(client.characterWorkspaceResponse(obsolete, first.next), obsolete); assert.equal(obsolete.metrics.length, 0);
  }
});

test('actual public-name service/client use one bounded call derived only from the rendered slice', async () => {
  for (const view of Object.keys(industryScopes)) {
    let nameCalls = 0;
    const payload = view === 'blueprints' ? blueprintData(102) : view === 'mining' ? miningData(102) : view === 'research'
      ? Array.from({ length: 102 }, (_, index) => ({ agent_id: 81001 + index, skill_type_id: 91001, started_at: stamp, points_per_day: 12.5, remainder_points: -0.25 }))
      : Array.from({ length: 102 }, (_, index) => ({ planet_id: 81001 + index, solar_system_id: 92001, planet_type: 'temperate', owner_id: args.characterId, last_update: stamp, upgrade_level: 3, num_pins: 5 }));
    const pagination = ['blueprints', 'mining'].includes(view) ? { kind: 'page', page: 1, pages: 1, nextPage: null } : { kind: 'none' };
    const service = industryService(view, payload, pagination, async (ids, signal) => {
      nameCalls++; assert.ok(signal instanceof AbortSignal); assert.ok(ids.length > 0 && ids.length <= 200);
      assert.ok(ids.every(id => id === 92001 || id >= 91001 && id <= 91102));
      return { retrievedAt: stamp, cacheExpires: null, data: ids.map(id => ({ id, category: id === 92001 ? 'solar_system' : 'inventory_type', name: ` Synthetic ${id} ` })) };
    });
    const selected = { ...args, view, resolveNames: true }, first = await service.read(selected), client = harness();
    assert.equal(client.characterWorkspaceResponse(first, selected), first); assert.equal(nameCalls, 1); assert.equal(first.labels.status, 'ready'); assert.equal(first.next.resolveNames, true);
    for (const resolveNames of [undefined, false]) assert.throws(() => client.characterWorkspaceResponse({ ...first, next: { ...first.next, resolveNames } }, selected), /incomplete response/);
    const second = await service.read(first.next); assert.equal(client.characterWorkspaceResponse(second, first.next), second); assert.equal(second.rows.length, 2); assert.equal(nameCalls, 2);
  }
});

test('actual public-name failure and category collisions preserve primary mining rows', async () => {
  const selected = { ...args, view: 'mining', resolveNames: true }, pagination = { kind: 'page', page: 1, pages: 1, nextPage: null }, client = harness();
  const failed = await industryService('mining', miningData(1), pagination, async () => { throw Error('OMIT_PRIVATE_LOOKUP'); }).read(selected);
  assert.equal(client.characterWorkspaceResponse(failed, selected), failed); assert.equal(failed.labels.status, 'unavailable'); assert.equal(failed.rows.length, 1); assert.doesNotMatch(JSON.stringify(failed), /OMIT_PRIVATE/);
  const collision = await industryService('mining', [{ ...miningData(1)[0], solar_system_id: 91001 }], pagination, async () => { throw Error('Unexpected name request'); }).read(selected);
  assert.equal(client.characterWorkspaceResponse(collision, selected), collision); assert.equal(collision.labels.status, 'unavailable'); assert.equal(collision.status, 'ready');
});
