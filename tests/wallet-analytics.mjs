import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync('app/lib/wallet-analytics.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const summaryCode = ts.transpileModule(readFileSync('app/lib/overview-summary.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const summaryModule = { exports: {} };
vm.runInNewContext(summaryCode, { module: summaryModule, exports: summaryModule.exports, Date });
const now = Date.parse('2026-01-02T00:00:00Z'), stamp = new Date(now).toISOString();
const args = { characterId: 90000001, entity: 'character' };
const corporation = { ...args, entity: 'corporation', division: 3 };
const scopes = ['esi-wallet.read_character_wallet.v1', 'esi-wallet.read_corporation_wallets.v1'];
const plain = value => JSON.parse(JSON.stringify(value));
const row = (id, amount = 1, overrides = {}) => ({ id, amount, date: '2026-01-01T12:00:00Z', ref_type: 'market_transaction', description: 'OMIT_PRIVATE_DESCRIPTION', first_party_id: 90009999, second_party_id: 90008888, reason: 'OMIT_PRIVATE_REASON', balance: 999999, tax: 234, tax_receiver_id: 98009999, context_id: 10008888, ...overrides });
function response(input, overrides = {}) {
  return { ...input, ...(input.entity === 'corporation' ? { corporationId: 98000001 } : {}), data: [row(1)], retrievedAt: stamp, cacheExpires: 'Fri, 02 Jan 2026 01:00:00 GMT', cacheControl: 'private, max-age=3600', responseDate: 'Fri, 02 Jan 2026 00:00:00 GMT', cacheAge: '0', lastModified: 'Thu, 01 Jan 2026 23:59:00 GMT', pages: 1, nextPage: null, pageLimit: 500, morePagesAvailable: false, pageLimitReached: false, ...overrides };
}
function harness(options = {}) {
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const calls = [], deadline = new AbortController();
  const deps = {
    connections: async user => { calls.push({ operation: 'connections', user }); return options.connections ? options.connections(user, deadline) : [{ characterId: args.characterId, scopes }]; },
    journal: async (user, input, signal) => { calls.push({ operation: 'journal', user, input, signal }); return options.journal ? options.journal(user, input, signal, EveError, deadline) : response(input, options.result); },
    now: () => options.now ?? now,
  };
  const fixtureModule = { exports: {} };
  vm.runInNewContext(code, { module: fixtureModule, exports: fixtureModule.exports, Date, AbortSignal: { any: AbortSignal.any.bind(AbortSignal), timeout: ms => { assert.equal(ms, 55000); return deadline.signal; } }, require: path => { if (path === './overview-summary') return summaryModule.exports; assert.equal(path, './eve'); return { EveError, listConnections: deps.connections, readEve: deps.journal }; } });
  return { read: fixtureModule.exports.createWalletAnalyticsReader(deps), calls, deadline };
}

test('one selected journal page provides exact cash-flow totals and fixed safe categories', async () => {
  const h = harness({ result: { data: [row(1, 0.1), row(2, 0.2), row(3, -0.3), row(4, 25.001, { date: '2025-12-31T23:00:00Z', ref_type: 'player_donation' }), row(5, -2.501, { ref_type: 'transaction_tax' }), row(6, 7, { ref_type: 'future_reference_type' })] } });
  const result = await h.read('synthetic-owner', args);
  assert.equal(result.status, 'ready');
  assert.deepEqual(plain(result.totals), { incomingISK: '32.301', outgoingISK: '2.801', netISK: '29.50' });
  assert.deepEqual(plain(result.daily.map(value => value.date)), ['2025-12-31', '2026-01-01']);
  assert.deepEqual(plain(result.daily[1].totals), { incomingISK: '7.30', outgoingISK: '2.801', netISK: '4.499' });
  assert.equal(result.categories.find(value => value.id === 'market').totals.netISK, '0.00');
  assert.equal(result.categories.find(value => value.id === 'other').label, 'Other activity');
  assert.equal(result.coverage.entries, 6); assert.equal(result.coverage.amountEntries, 6);
  assert.equal(result.coverage.kind, 'complete_returned_window'); assert.equal(result.coverage.earliest, '2025-12-31T23:00:00.000Z');
  assert.equal(h.calls.length, 2); assert.deepEqual(plain(h.calls[1].input), { ...args, page: 1, dataset: 'wallet_journal' });
  assert(h.calls.every(value => value.user === 'synthetic-owner')); assert(h.calls[1].signal instanceof AbortSignal);
  for (const secret of ['OMIT_PRIVATE', '90009999', '90008888', '98009999', '10008888', 'future_reference_type', 'first_party', 'tax_receiver']) assert(!JSON.stringify(result).includes(secret), secret);
  assert.match(result.limitations.join(' '), /not profit/); assert.match(result.precisionPolicy, /precision already lost/);
});

test('optional missing amounts remain unknown, including all-unknown category and day buckets', async () => {
  const omitted = row(1); delete omitted.amount;
  const missing = row(2, 1, { date: '2025-12-31T12:00:00Z', ref_type: 'player_donation' }); delete missing.amount;
  const result = await harness({ result: { data: [omitted, missing, row(3, -12.5)] } }).read('synthetic-owner', args);
  assert.equal(result.status, 'partial'); assert.equal(result.coverage.missingAmountEntries, 2);
  assert.deepEqual(plain(result.totals), { incomingISK: '0.00', outgoingISK: '12.50', netISK: '-12.50' });
  assert.equal(result.daily[0].totals, null); assert.equal(result.categories.find(value => value.id === 'transfers').totals, null);
  const unknown = await harness({ result: { data: [omitted] } }).read('synthetic-owner', args);
  assert.equal(unknown.totals, null); assert.equal(unknown.daily[0].totals, null); assert.match(unknown.message, /omit an amount/);
});

test('empty returned data has zero observed activity without filling absent days', async () => {
  const result = await harness({ result: { data: [] } }).read('synthetic-owner', args);
  assert.deepEqual(plain(result.totals), { incomingISK: '0.00', outgoingISK: '0.00', netISK: '0.00' });
  assert.equal(result.daily.length, 0); assert.equal(result.categories.length, 0); assert.equal(result.coverage.earliest, null);
});

test('signed and exponent decimal amounts are summed without floating point accumulation', async () => {
  const result = await harness({ result: { data: [row(1, 1e-7), row(2, -2e-7), row(3, 9007199254740991), row(4, -9007199254740991), row(5, -0)] } }).read('synthetic-owner', args);
  assert.equal(result.totals.incomingISK, '9007199254740991.0000001');
  assert.equal(result.totals.outgoingISK, '9007199254740991.0000002'); assert.equal(result.totals.netISK, '-0.0000001');
  assert.equal(result.coverage.amountEntries, 5);
});

test('valid journal offsets and fractional seconds group by the normalized UTC date', async () => {
  const result = await harness({ result: { data: [
    row(1, 5, { date: '2026-01-01T01:00:00.123456789+02:00' }),
    row(2, -2, { date: '2025-12-31T22:30:00-01:00' }),
    row(3, 1, { date: '2026-01-01T12:00:00+00:00' }),
  ] } }).read('synthetic-owner', args);
  assert.equal(result.status, 'ready'); assert.equal(result.coverage.earliest, '2025-12-31T23:00:00.123Z');
  assert.equal(result.coverage.latest, '2026-01-01T12:00:00.000Z');
  assert.deepEqual(plain(result.daily.map(day => [day.date, day.totals.netISK])), [['2025-12-31', '3.00'], ['2026-01-01', '1.00']]);
  for (const date of ['2026-02-30T00:00:00+01:00', '2026-01-01T12:00:00+24:00', '2026-01-01T12:00:00+01:60', '2026-01-01T12:00:00']) {
    const invalid = await harness({ result: { data: [row(1, 1, { date })] } }).read('synthetic-owner', args);
    assert.equal(invalid.status, 'error'); assert.equal(invalid.totals, null);
  }
});

test('only the requested corporation wallet division is read and returned', async () => {
  const h = harness(); const result = await h.read('synthetic-owner', corporation);
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].input.division, 3);
  assert.equal(result.division, 3); assert.equal(result.corporationId, 98000001); assert.equal(result.scope, scopes[1]);
});

test('paging exposes partial and unknown coverage, navigation and the application limit', async () => {
  for (const fixture of [
    { page: 1, pages: 8, nextPage: 2, morePagesAvailable: true, pageLimitReached: false, kind: 'partial' },
    { page: 8, pages: 8, nextPage: null, morePagesAvailable: false, pageLimitReached: false, kind: 'partial' },
    { page: 1, pages: null, nextPage: null, morePagesAvailable: null, pageLimitReached: false, kind: 'unknown' },
    { page: 500, pages: 501, nextPage: null, morePagesAvailable: true, pageLimitReached: true, kind: 'partial' },
    { page: 500, pages: null, nextPage: null, morePagesAvailable: null, pageLimitReached: true, kind: 'unknown' },
  ]) {
    const { kind, ...metadata } = fixture;
    const h = harness({ result: metadata }); const result = await h.read('synthetic-owner', { ...args, page: fixture.page });
    assert.equal(result.coverage.kind, kind); assert.equal(result.status, 'partial'); assert.equal(result.coverage.nextPage, fixture.nextPage);
    assert.equal(result.coverage.previousPage, fixture.page === 1 ? null : fixture.page - 1); assert.equal(result.coverage.pageLimitReached, fixture.pageLimitReached);
    assert.equal(h.calls.length, 2, 'No automatic page traversal');
  }
});

test('strict input validation and ownership prevent unselected or unauthorized reads', async () => {
  for (const input of [null, [], {}, Object.create(args), { ...args, characterId: '90000001' }, { ...args, characterId: 0 }, { ...args, entity: 'constructor' }, { ...args, division: 1 }, { ...args, division: undefined }, { ...args, page: 0 }, { ...args, page: 501 }, { ...args, page: 1.2 }, { ...args, page: undefined }, { ...corporation, division: undefined }, { ...corporation, division: 8 }, { ...args, data: [] }, { ...args, fromId: 10 }]) {
    const h = harness(); await assert.rejects(h.read('synthetic-owner', input), error => error.status === 400); assert.equal(h.calls.length, 0);
  }
  const unsigned = harness(); await assert.rejects(unsigned.read('', args), error => error.status === 401); assert.equal(unsigned.calls.length, 0);
  const unowned = harness({ connections: async () => [] }); await assert.rejects(unowned.read('synthetic-owner', args), error => error.status === 404); assert.equal(unowned.calls.length, 1);
  const missing = harness({ connections: async () => [{ characterId: args.characterId, scopes: [] }] });
  const result = await missing.read('synthetic-owner', args); assert.equal(result.status, 'needs_permission'); assert.equal(result.totals, null); assert.equal(missing.calls.length, 1);
});

test('unexpected identity, division or pagination suppresses every total', async () => {
  for (const override of [{ characterId: 90000002 }, { entity: 'corporation' }, { dataset: 'wallet_transactions' }, { division: 1 }, { corporationId: 98000001 }, { page: 2 }, { pages: 0 }, { pages: undefined }, { nextPage: 2 }, { pageLimit: 1000 }, { morePagesAvailable: true }, { pageLimitReached: true }]) {
    const result = await harness({ result: override }).read('synthetic-owner', args);
    assert.equal(result.status, 'error', JSON.stringify(override)); assert.equal(result.totals, null); assert.equal(result.daily.length, 0);
  }
  for (const override of [{ corporationId: undefined }, { corporationId: -1 }, { corporationId: '98000001' }, { division: 2 }]) {
    const result = await harness({ result: override }).read('synthetic-owner', corporation); assert.equal(result.status, 'error'); assert.equal(result.corporationId, null);
  }
});

test('malformed, duplicated, excessive or unsafe journal records never produce partial plausible totals', async () => {
  for (const override of [{ id: 0 }, { id: '1' }, { id: Number.MAX_SAFE_INTEGER + 1 }, { amount: null }, { amount: undefined }, { amount: '2.5' }, { amount: Infinity }, { amount: NaN }, { amount: Number.MAX_SAFE_INTEGER + 1 }, { date: '2026-02-30T00:00:00Z' }, { date: '2026-01-01' }, { date: '2026-01-02T00:02:00Z' }, { ref_type: undefined }, { ref_type: '<script>' }]) {
    const result = await harness({ result: { data: [row(1, 2), row(2, 1, override)] } }).read('synthetic-owner', args);
    assert.equal(result.status, 'error', JSON.stringify(override)); assert.equal(result.totals, null);
  }
  for (const data of [null, {}, [row(1), row(1)], Array.from({ length: 2501 }, (_, i) => row(i + 1))]) {
    const result = await harness({ result: { data } }).read('synthetic-owner', args); assert.equal(result.status, 'error'); assert.equal(result.totals, null);
  }
});

test('freshness accounts for expiry, date, age, no-store and completion-time expiry', async () => {
  for (const [override, state, clock] of [
    [{}, 'fresh', now],
    [{ cacheExpires: 'Thu, 01 Jan 2026 23:59:59 GMT' }, 'stale', now],
    [{ cacheAge: '3601' }, 'stale', now],
    [{ cacheControl: 'private, no-store, raw-private-header' }, 'stale', now],
    [{ cacheExpires: null, cacheControl: null }, 'unknown', now],
    [{ cacheExpires: '2026-02-30T00:00:00Z', cacheControl: null }, 'unknown', now],
    [{}, 'stale', now + 3600001],
  ]) {
    const result = await harness({ result: override, now: clock }).read('synthetic-owner', args);
    assert.equal(result.freshness.state, state); assert(!JSON.stringify(result).includes('raw-private-header'));
    assert.equal(result.status, state === 'fresh' ? 'ready' : 'partial');
  }
  for (const retrievedAt of ['2026-02-30T00:00:00Z', '2026-01-02T00:02:00Z', null]) {
    const result = await harness({ result: { retrievedAt } }).read('synthetic-owner', args); assert.equal(result.status, 'error'); assert.equal(result.totals, null);
  }
});

test('permission, authorization and rate-limit errors are generic and never expose upstream text', async () => {
  for (const status of [401, 403, 404, 409, 429, 500]) {
    const h = harness({ journal: async (_user, _args, _signal, EveError) => { throw new EveError('OMIT_PRIVATE_UPSTREAM', status); } });
    const result = await h.read('synthetic-owner', corporation); assert.equal(result.status, status === 500 ? 'error' : 'unavailable');
    assert.equal(result.totals, null); assert(!JSON.stringify(result).includes('OMIT_PRIVATE')); assert.equal(h.calls.length, 2);
  }
});

test('malformed cache age never falls back to an apparently fresh Expires value', async () => {
  for (const cacheAge of ['-1', 'not-an-age', '1.5', '604801', 1, '99999999999999999999']) {
    const result = await harness({ result: { cacheAge } }).read('synthetic-owner', args);
    assert.equal(result.freshness.state, 'unknown'); assert.equal(result.freshness.cacheExpires, null); assert.equal(result.status, 'partial');
  }
  const noStore = await harness({ result: { cacheAge: '-1', cacheControl: 'private, no-store' } }).read('synthetic-owner', args);
  assert.equal(noStore.freshness.state, 'stale');
});

test('abort and 55-second deadline release uncooperative connection and journal reads', async () => {
  for (const stage of ['connections', 'journal']) {
    const options = stage === 'connections' ? { connections: async (_user, deadline) => { queueMicrotask(() => deadline.abort()); return new Promise(() => {}); } } : { journal: async (_user, _input, _signal, _Error, deadline) => { queueMicrotask(() => deadline.abort()); return new Promise(() => {}); } };
    const h = harness(options); const result = await h.read('synthetic-owner', args);
    assert.equal(result.status, 'unavailable'); assert.equal(result.totals, null); assert.match(result.message, /cancelled|time limit/);
  }
  const controller = new AbortController(); controller.abort(); const h = harness();
  await assert.rejects(h.read('synthetic-owner', args, { signal: controller.signal })); assert.equal(h.calls.length, 0);
  const external = new AbortController();
  const active = harness({ journal: async () => { queueMicrotask(() => external.abort()); return new Promise(() => {}); } });
  const result = await active.read('synthetic-owner', args, { signal: external.signal }); assert.equal(result.status, 'unavailable');
});

test('independent calls never accumulate prior pages or retain prior journal records', async () => {
  const h = harness({ journal: async (_user, input) => response(input, { data: [row(1, input.page)], pages: 2, nextPage: input.page === 1 ? 2 : null, morePagesAvailable: input.page === 1 }) });
  const first = await h.read('synthetic-owner', args), second = await h.read('synthetic-owner', { ...args, page: 2 });
  assert.equal(first.totals.netISK, '1.00'); assert.equal(second.totals.netISK, '2.00'); assert.equal(second.coverage.entries, 1);
});
