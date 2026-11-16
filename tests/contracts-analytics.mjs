import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const compile = name => ts.transpileModule(readFileSync(`app/lib/${name}.ts`, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const code = compile('contracts-analytics'), summaryCode = compile('overview-summary'), walletCode = compile('wallet-analytics');
const stamp = '2026-01-01T00:00:00.000Z', at = Date.parse(stamp), characterId = 90000001, corporationId = 98000001;
const scopes = { character: 'esi-contracts.read_character_contracts.v1', corporation: 'esi-contracts.read_corporation_contracts.v1' };
const statuses = ['outstanding', 'in_progress', 'finished_issuer', 'finished_contractor', 'finished', 'cancelled', 'rejected', 'failed', 'deleted', 'reversed'];
const types = ['unknown', 'item_exchange', 'auction', 'courier', 'loan'];
const args = { characterId, entity: 'character' }, marker = 'OMIT_PRIVATE_CONTRACT_DATA';
const plain = value => JSON.parse(JSON.stringify(value));
const contract = (contract_id = 1001, extra = {}) => ({ contract_id, type: 'courier', status: 'outstanding', date_issued: '2025-12-01T00:00:00Z', date_expired: '2026-01-02T00:00:00Z',
  issuer_id: 90009999, issuer_corporation_id: 98009999, assignee_id: 90008888, acceptor_id: 90007777, title: marker, start_location_id: 60000001, end_location_id: 60000002,
  for_corporation: true, availability: 'alliance', price: 1, reward: 2, collateral: 3, buyout: 4, volume: 5, date_completed: '2026-01-03T00:00:00Z', private_marker: marker, ...extra });
const envelope = (entity, input, data = [contract()], extra = {}) => ({ characterId: input.characterId, dataset: 'contracts', ...(entity === 'corporation' ? { entity, corporationId } : {}),
  data, retrievedAt: stamp, cacheExpires: 'Thu, 01 Jan 2026 00:05:00 GMT', lastModified: 'Wed, 31 Dec 2025 23:00:00 GMT', source: marker, private_marker: marker,
  pagination: { kind: 'page', page: input.parameters.page, pages: 1, nextPage: null, pageLimit: 500, morePagesAvailable: false, pageLimitReached: false, after: null, before: null, nextFromId: null, nextBeforeId: null, nextFromEvent: null }, ...extra });
function load(source, context = {}) { const module = { exports: {} }; vm.runInNewContext(source, { module, exports: module.exports, Date, AbortSignal, ...context }); return module.exports; }
const summary = load(summaryCode);
function harness(options = {}) {
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const calls = [], deadline = new AbortController();
  const read = entity => async (user, input, signal) => { calls.push({ entity, user, args: input, signal }); return options.read ? options.read(entity, input, signal, EveError, deadline) : envelope(entity, input); };
  const deps = { connections: async user => { calls.push({ operation: 'connections', user }); return options.connect ? options.connect(deadline) : options.connections ?? [{ characterId, scopes: Object.values(scopes) }]; },
    character: read('character'), corporation: read('corporation'), now: options.now ?? (() => at) };
  const eve = { EveError, listConnections: deps.connections, readCharacterData: deps.character, readCorporationData: deps.corporation, readEve: () => { throw new Error('Wallet reads are forbidden in contracts tests'); } };
  const wallet = load(walletCode, { require: name => { if (name === './overview-summary') return summary; if (name === './eve') return eve; throw new Error(name); } });
  const service = load(code, { require: name => { if (name === './overview-summary') return summary; if (name === './wallet-analytics') return wallet; if (name === './eve') return eve; throw new Error(name); },
    Date: class extends Date { static now() { return (options.now ?? (() => at))(); } },
    AbortSignal: { any: AbortSignal.any.bind(AbortSignal), timeout: milliseconds => { assert.equal(milliseconds, 55000); return deadline.signal; } } });
  return { read: service.createContractsAnalyticsReader(deps), validate: service.validateContractsAnalyticsArgs, defaultRead: service.readContractsAnalytics, calls, deadline };
}
const get = (h, selection = args, options) => h.read('synthetic-owner', selection, options);
function noData(value, status = 'error') {
  assert.equal(value.status, status); assert.equal(value.summary, null); assert.deepEqual(plain(value.contracts), []); assert.deepEqual(plain(value.statusCounts), []); assert.deepEqual(plain(value.typeCounts), []);
  assert.equal(value.coverage.kind, 'unavailable'); assert.equal(value.coverage.rows, 0); assert.equal(value.corporationId, null);
}

test('contract selectors reject unsafe, unrelated and inherited selections before any access', async () => {
  for (const input of [null, [], {}, Object.create(args), Object.assign(Object.create({ page: 501 }), args), { ...args, characterId: '90000001' }, { ...args, characterId: 0 }, { ...args, characterId: -1 },
    { ...args, characterId: 1.5 }, { ...args, characterId: Number.MAX_SAFE_INTEGER + 1 }, { ...args, entity: 'all' }, { ...args, entity: 'constructor' }, { ...args, page: null }, { ...args, page: undefined },
    { ...args, page: 0 }, { ...args, page: 501 }, { ...args, page: 1.5 }, { ...args, page: '2' }, { ...args, corporationId }, { ...args, division: 1 }, { ...args, includeItems: true }, { ...args, url: marker }, { ...args, [Symbol('hidden')]: 1 }]) {
    const h = harness(); await assert.rejects(get(h, input), error => error.status === 400); assert.equal(h.calls.length, 0);
  }
});
test('validator reconstructs default and explicit selections without retaining input objects', () => {
  const h = harness(), input = { ...args }, selected = h.validate(input); input.characterId++;
  assert.deepEqual(plain(selected), { ...args, page: 1 }); assert.deepEqual(plain(h.validate({ ...args, page: 500 })), { ...args, page: 500 });
});
test('sign-in, connection ownership and each exact existing grant precede provider work', async () => {
  for (const user of ['', null, 99]) { const h = harness(); await assert.rejects(h.read(user, args), error => error.status === 401); assert.equal(h.calls.length, 0); }
  const wrong = harness({ connections: [{ characterId: characterId + 1, scopes: Object.values(scopes) }] }); await assert.rejects(get(wrong), error => error.status === 404); assert.equal(wrong.calls.length, 1);
  for (const entity of ['character', 'corporation']) {
    const h = harness({ connections: [{ characterId, scopes: [scopes[entity === 'character' ? 'corporation' : 'character']] }] }); const result = await get(h, { ...args, entity, page: 3 });
    noData(result, 'needs_permission'); assert.equal(result.scope, scopes[entity]); assert.equal(result.coverage.page, 3); assert.equal(result.coverage.previousPage, 2); assert.equal(h.calls.length, 1);
  }
});
for (const entity of ['character', 'corporation']) test(`${entity} loads exactly its contracts page with owner and signal preserved`, async () => {
  const h = harness(), result = await get(h, { ...args, entity });
  assert.equal(h.calls.length, 2); assert.equal(h.calls[0].user, 'synthetic-owner'); assert.equal(h.calls[1].user, 'synthetic-owner'); assert.equal(h.calls[1].entity, entity); assert.equal(h.calls[1].signal, h.deadline.signal);
  assert.deepEqual(plain(h.calls[1].args), { characterId, dataset: 'contracts', parameters: { page: 1 } });
  assert.equal(result.entity, entity); assert.equal(result.corporationId, entity === 'corporation' ? corporationId : null); assert.equal(result.scope, scopes[entity]); assert.equal(result.status, 'ready');
  assert.deepEqual(plain(result.coverage), { kind: 'complete_returned_response', page: 1, pages: 1, nextPage: null, previousPage: null, pageLimitReached: false, rows: 1 });
  assert.deepEqual(plain(result.summary), { contracts: 1, outstanding: 1, inProgress: 0, outstandingPastExpiry: 0, outstandingDueWithin24h: 1 });
  assert.deepEqual(plain(result.freshness), { state: 'fresh', retrievedAt: stamp, cacheExpires: '2026-01-01T00:05:00.000Z', lastModified: '2025-12-31T23:00:00.000Z' });
});
test('exported default reader binds the same owned adapters and uses no wallet read', async () => {
  const h = harness(), result = await h.defaultRead('synthetic-owner', args); assert.equal(result.status, 'ready'); assert.equal(h.calls.length, 2);
});
test('current corporation identity comes from the selected scoped response without caller inference', async () => {
  const h = harness({ read: (entity, input) => envelope(entity, input, [contract()], { corporationId: corporationId + 1 }) });
  const result = await get(h, { ...args, entity: 'corporation' }); assert.equal(result.corporationId, corporationId + 1); assert.equal(result.status, 'ready');
});
test('all five types and ten provider statuses retain fixed count order and exclude non-outstanding expiries', async () => {
  const rows = statuses.map((status, index) => contract(1001 + index, { status, type: types[index % types.length], date_expired: stamp }));
  const h = harness({ read: (entity, input) => envelope(entity, input, rows) }), result = await get(h);
  assert.deepEqual(plain(result.statusCounts), statuses.map(status => ({ status, count: 1 })));
  assert.deepEqual(plain(result.typeCounts), types.map(type => ({ type, count: 2 })));
  assert.deepEqual(plain(result.summary), { contracts: 10, outstanding: 1, inProgress: 1, outstandingPastExpiry: 1, outstandingDueWithin24h: 0 });
});
test('offer windows own exact boundaries once and ignore provider statuses other than outstanding', async () => {
  const expiries = ['2025-12-31T23:59:59.999Z', stamp, '2026-01-01T00:00:00.001Z', '2026-01-01T23:59:59.999Z', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.001Z'];
  const rows = expiries.map((date_expired, index) => contract(index + 1, { date_expired })); rows.push(contract(20, { status: 'in_progress', date_expired: stamp }), contract(21, { status: 'finished', date_expired: expiries[2] }));
  const result = await get(harness({ read: (entity, input) => envelope(entity, input, rows) }));
  assert.deepEqual(plain(result.summary), { contracts: 8, outstanding: 6, inProgress: 1, outstandingPastExpiry: 2, outstandingDueWithin24h: 3 });
  assert.equal(result.contracts.find(row => row.contractId === 20).status, 'in_progress');
});
test('source completion time owns schedule and freshness after a slow read', async () => {
  let clock = at;
  const h = harness({ now: () => clock, read: (entity, input) => { clock += 300000; return envelope(entity, input, [contract(1, { date_expired: '2026-01-01T00:04:00Z' }), contract(2, { date_expired: '2026-01-02T00:04:00Z' })]); } });
  const result = await get(h); assert.equal(result.generatedAt, '2026-01-01T00:05:00.000Z'); assert.equal(result.freshness.state, 'stale'); assert.equal(result.status, 'partial');
  assert.equal(result.summary.outstandingPastExpiry, 1); assert.equal(result.summary.outstandingDueWithin24h, 1);
});
test('timezone offsets normalize and equal expiries sort by exact contract ID', async () => {
  const rows = [contract(9, { date_issued: '2025-12-01T02:00:00+02:00', date_expired: '2026-01-02T02:00:00+02:00', date_accepted: '2025-12-01T02:00:00+02:00' }), contract(3)];
  const result = await get(harness({ read: (entity, input) => envelope(entity, input, rows) }));
  assert.deepEqual(plain(result.contracts.map(row => row.contractId)), [3, 9]); assert.equal(result.contracts[1].issuedAt, '2025-12-01T00:00:00.000Z');
  assert.equal(result.contracts[1].offerExpiresAt, '2026-01-02T00:00:00.000Z'); assert.equal(result.contracts[1].acceptedAt, '2025-12-01T00:00:00.000Z');
});
test('optional acceptance and duration preserve absence null zero and large reported inputs without a derived deadline', async () => {
  const rows = [contract(1), contract(2, { status: 'in_progress', date_accepted: null, days_to_complete: null }), contract(3, { date_accepted: stamp, days_to_complete: 0 }),
    contract(4, { status: 'finished', date_accepted: '2026-01-03T00:00:00Z', days_to_complete: Number.MAX_SAFE_INTEGER })];
  const result = await get(harness({ read: (entity, input) => envelope(entity, input, rows) }));
  assert.deepEqual(plain(result.contracts.map(row => [row.acceptedAt, row.daysToComplete])), [[null, null], [null, null], [stamp, 0], ['2026-01-03T00:00:00.000Z', Number.MAX_SAFE_INTEGER]]);
  assert.equal(result.contracts[1].status, 'in_progress'); assert(!JSON.stringify(result).includes('deadlineAt'));
});
test('verified empty page has observed zero counts and remains different from unavailable data', async () => {
  const result = await get(harness({ read: (entity, input) => envelope(entity, input, []) }));
  assert.equal(result.status, 'ready'); assert.deepEqual(plain(result.summary), { contracts: 0, outstanding: 0, inProgress: 0, outstandingPastExpiry: 0, outstandingDueWithin24h: 0 });
  assert.deepEqual(plain(result.statusCounts), statuses.map(status => ({ status, count: 0 }))); assert.deepEqual(plain(result.typeCounts), types.map(type => ({ type, count: 0 })));
  assert.equal(result.coverage.rows, 0);
});
test('full permitted page is validated and kept while larger or duplicate pages fail without truncation', async () => {
  const rows = Array.from({ length: 1000 }, (_, index) => contract(1000 - index));
  const result = await get(harness({ read: (entity, input) => envelope(entity, input, rows) }));
  assert.equal(result.contracts.length, 1000); assert.equal(result.summary.contracts, 1000); assert.equal(result.contracts[0].contractId, 1); assert.equal(result.contracts[999].contractId, 1000);
  assert(Buffer.byteLength(JSON.stringify(result)) < 300000);
  for (const data of [[...rows, contract(1001)], [contract(), contract()], [...rows.slice(0, 999), contract(1000)]]) noData(await get(harness({ read: (entity, input) => envelope(entity, input, data) })));
});
for (const [name, override] of [
  ['zero ID', { contract_id: 0 }], ['unsafe ID', { contract_id: Number.MAX_SAFE_INTEGER + 1 }], ['string ID', { contract_id: '1001' }], ['unknown type', { type: 'other' }], ['unknown status', { status: 'complete' }],
  ['missing issue', { date_issued: undefined }], ['null expiry', { date_expired: null }], ['local date', { date_issued: '2025-12-01T00:00:00' }], ['rolled date', { date_expired: '2026-02-30T00:00:00Z' }],
  ['reversed offer', { date_expired: '2025-11-30T23:59:59Z' }], ['acceptance before issue', { date_accepted: '2025-11-30T23:59:59Z' }], ['invalid acceptance', { date_accepted: 'private value' }],
  ['negative days', { days_to_complete: -1 }], ['fractional days', { days_to_complete: 0.5 }], ['unsafe days', { days_to_complete: Number.MAX_SAFE_INTEGER + 1 }], ['string days', { days_to_complete: '2' }],
  ['nonfinite days', { days_to_complete: Infinity }], ['boolean days', { days_to_complete: false }], ['undefined type', { type: undefined }],
]) test(`malformed contract ${name} cannot leave plausible partial counts`, async () => {
  const rows = [contract(1), contract(2, override)]; noData(await get(harness({ read: (entity, input) => envelope(entity, input, rows) })));
});
test('malformed data containers and rows fail without raw values', async () => {
  for (const data of [null, {}, [null], [1], ['private value']]) noData(await get(harness({ read: (entity, input) => envelope(entity, input, data) })));
});
test('all unknown private fields are removed and no related reads are performed', async () => {
  const h = harness(), result = await get(h), row = result.contracts[0];
  assert.deepEqual(Object.keys(row).sort(), ['acceptedAt', 'contractId', 'daysToComplete', 'issuedAt', 'offerExpiresAt', 'status', 'type'].sort());
  const serialized = JSON.stringify(result); assert(!serialized.includes(marker));
  for (const key of ['issuer_id', 'issuer_corporation_id', 'assignee_id', 'acceptor_id', 'title', 'start_location_id', 'end_location_id', 'price', 'reward', 'collateral', 'buyout', 'volume', 'date_completed', 'availability', 'for_corporation', 'source']) assert(!Object.hasOwn(row, key));
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].args.dataset, 'contracts');
});
for (const entity of ['character', 'corporation']) test(`${entity} page coverage remains explicit and never triggers continuation`, async () => {
  for (const [page, pages, nextPage, more, reached, kind] of [[2, 4, 3, true, false, 'partial'], [1, null, null, null, false, 'unknown'], [500, 501, null, true, true, 'partial'], [500, null, null, null, true, 'unknown'], [500, 500, null, false, false, 'partial']]) {
    const h = harness({ read: (owner, input) => envelope(owner, input, [], { pagination: { kind: 'page', page, pages, nextPage, morePagesAvailable: more, pageLimitReached: reached } }) });
    const result = await get(h, { ...args, entity, page }); assert.equal(result.status, 'partial'); assert.equal(result.coverage.kind, kind); assert.equal(result.coverage.page, page);
    assert.equal(result.coverage.previousPage, page > 1 ? page - 1 : null); assert.equal(result.coverage.nextPage, nextPage); assert.equal(result.coverage.pageLimitReached, reached); assert.equal(h.calls.length, 2);
  }
});
test('wrong source identity context or pagination fails before any values reach the projection', async () => {
  const overrides = [{ characterId: characterId + 1 }, { dataset: 'contract_items' }, { entity: 'corporation' }, { corporationId }, { retrievedAt: 'private' }, { retrievedAt: '2026-01-01T00:01:00.001Z' },
    { pagination: { kind: 'none' } }, ...[{ page: 2 }, { pages: 0 }, { pages: undefined }, { pages: 1.5 }, { nextPage: 2 }, { pageLimit: 1000 }, { morePagesAvailable: true }, { pageLimitReached: true }, { after: 'cursor' }, { nextFromId: 9 }].map(extra => ({ pagination: { kind: 'page', page: 1, pages: 1, nextPage: null, ...extra } }))];
  for (const override of overrides) noData(await get(harness({ read: (entity, input) => envelope(entity, input, [contract()], override) })));
  for (const override of [{ entity: 'character' }, { entity: undefined }, { corporationId: null }, { corporationId: 0 }, { corporationId: '98000001' }]) noData(await get(harness({ read: (entity, input) => envelope(entity, input, [contract()], override) }), { ...args, entity: 'corporation' }));
});
for (const [name, extra, state, expires] of [
  ['Expires only', {}, 'fresh', '2026-01-01T00:05:00.000Z'],
  ['stale equality', { cacheExpires: 'Thu, 01 Jan 2026 00:00:00 GMT' }, 'stale', stamp],
  ['missing expiry', { cacheExpires: null }, 'unknown', null],
  ['invalid expiry', { cacheExpires: marker }, 'unknown', null],
  ['unsupported expanded expiry year', { cacheExpires: 'Sat, 01 Jan 10000 00:00:00 GMT' }, 'unknown', null],
  ['last supported expiry year', { cacheExpires: 'Fri, 31 Dec 9999 23:59:59 GMT' }, 'fresh', '9999-12-31T23:59:59.000Z'],
  ['valid max age', { cacheControl: 'private, max-age=120', responseDate: 'Thu, 01 Jan 2026 00:00:00 GMT', cacheAge: '60' }, 'fresh', '2026-01-01T00:01:00.000Z'],
  ['max age zero', { cacheControl: 'max-age=0', responseDate: 'Thu, 01 Jan 2026 00:00:00 GMT' }, 'stale', stamp],
  ['max age missing date', { cacheControl: 'max-age=0', responseDate: null }, 'unknown', null],
  ['max age malformed', { cacheControl: 'max-age=invalid', responseDate: 'Thu, 01 Jan 2026 00:00:00 GMT' }, 'unknown', null],
  ['max age future date', { cacheControl: 'max-age=120', responseDate: 'Thu, 01 Jan 2026 00:01:01 GMT' }, 'unknown', null],
  ['max age invalid age', { cacheControl: 'max-age=120', responseDate: 'Thu, 01 Jan 2026 00:00:00 GMT', cacheAge: 'invalid' }, 'unknown', null],
  ['no store overrides bad date and age', { cacheControl: 'no-store, max-age=120', responseDate: null, cacheAge: 'invalid' }, 'stale', stamp],
  ['invalid control type', { cacheControl: {} }, 'unknown', null],
  ['overlong control', { cacheControl: 'private,' + ' '.repeat(600) + 'max-age=0' }, 'unknown', null],
]) test(`contracts reuse conservative cache evidence: ${name}`, async () => {
  const result = await get(harness({ read: (entity, input) => envelope(entity, input, [contract()], extra) }));
  assert.equal(result.freshness.state, state); assert.equal(result.freshness.cacheExpires, expires); assert.equal(result.status, state === 'fresh' ? 'ready' : 'partial'); assert.equal(result.summary.contracts, 1);
});
test('unsafe last-modified data is omitted without fabricating freshness', async () => {
  const result = await get(harness({ read: (entity, input) => envelope(entity, input, [contract()], { lastModified: marker, cacheExpires: null }) }));
  assert.equal(result.freshness.lastModified, null); assert.equal(result.freshness.state, 'unknown'); assert(!JSON.stringify(result).includes(marker));
});
test('optional HTTP last-modified stays within the supported four-digit UTC year domain', async () => {
  for (const [lastModified, expected] of [['Sat, 01 Jan 10000 00:00:00 GMT', null], ['Fri, 31 Dec 9999 23:59:59 GMT', '9999-12-31T23:59:59.000Z']]) {
    const result = await get(harness({ read: (entity, input) => envelope(entity, input, [contract()], { lastModified }) }));
    assert.equal(result.status, 'ready'); assert.equal(result.summary.contracts, 1); assert.equal(result.freshness.lastModified, expected);
  }
});
test('connection lookup failure and shared deadline leave all data unavailable', async () => {
  for (const abort of [false, true]) {
    const h = harness({ connect: deadline => { if (abort) { deadline.abort(); return new Promise(() => {}); } throw new Error(marker); } });
    const result = await get(h); noData(result, 'unavailable'); assert.equal(h.calls.length, 1); assert(!JSON.stringify(result).includes(marker));
  }
});
for (const status of [401, 403, 404, 409, 429, 500]) test(`safe provider error ${status} causes no retries or raw error disclosure`, async () => {
  const h = harness({ read: (_entity, _input, _signal, EveError) => { throw new EveError(marker, status); } }), result = await get(h);
  noData(result, status === 500 ? 'error' : 'unavailable'); assert.equal(h.calls.length, 2); assert(!JSON.stringify(result).includes(marker));
});
test('pre-aborted caller performs no ownership or provider read', async () => {
  const controller = new AbortController(); controller.abort(); const h = harness(); await assert.rejects(get(h, args, { signal: controller.signal })); assert.equal(h.calls.length, 0);
});
test('caller cancellation and deadline discard in-flight success and never continue', async () => {
  for (const caller of [false, true]) {
    const controller = new AbortController();
    const h = harness({ read: (entity, input, signal, _EveError, deadline) => { (caller ? controller : deadline).abort(); assert.equal(signal.aborted, true); return envelope(entity, input); } });
    const result = await get(h, args, caller ? { signal: controller.signal } : undefined); noData(result, 'unavailable'); assert.equal(h.calls.length, 2);
  }
});
test('a noncooperative provider cannot outlive the shared request deadline', async () => {
  const h = harness({ read: (_entity, _input, _signal, _EveError, deadline) => { deadline.abort(); return new Promise(() => {}); } });
  noData(await get(h), 'unavailable'); assert.equal(h.calls.length, 2);
});
