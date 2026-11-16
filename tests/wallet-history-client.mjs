import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';

const compile = name => ts.transpileModule(readFileSync(`app/lib/${name}.ts`, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const code = compile('wallet-history-client'), connectionCode = compile('connection-client');
function harness(fetch = () => { throw Error('Unexpected request'); }, timers = {}) {
  const connection = { exports: {} }, client = { exports: {} };
  vm.runInNewContext(connectionCode, { module: connection, exports: connection.exports });
  vm.runInNewContext(code, { module: client, exports: client.exports, fetch, AbortController, TextDecoder, setTimeout, clearTimeout, ...timers, require: name => name === 'zod' ? { z } : connection.exports });
  return client.exports;
}
const client = harness(), characterId = 90000001, args = { characterId, operation: 'report', days: 30 }, stamp = '2026-01-02T00:00:00.000Z', expires = '2026-01-02T01:00:00.000Z';
const plain = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const bucket = { entries: 2, amountEntries: 2, missingAmountEntries: 0, totals: { incomingISK: '10.30', outgoingISK: '0.10', netISK: '10.20' } };
  return { characterId, generatedAt: stamp, status: 'partial', message: 'Synthetic saved observations.', settings: { enabled: true, retentionDays: 90 }, report: { days: 30, ...plain(bucket), earliest: '2026-01-01T12:00:00.000Z', latest: '2026-01-01T13:00:00.000Z', daily: [{ date: '2026-01-01', ...plain(bucket) }], categories: [{ id: 'market', label: 'Market activity', ...plain(bucket) }] }, lastCapture: { at: stamp, pagesRead: 1, pagesAdvertised: 1, entriesRead: 2, addedEntries: 2, coverage: 'returned_pages', freshness: 'fresh', retrievedAt: stamp, cacheExpires: expires }, limits: { maxPages: 4, maxEvents: 10000 }, precisionPolicy: 'Synthetic exact decimal policy.', limitations: ['Synthetic incomplete history.'] };
}
function empty(enabled = false) { return { ...fixture(), status: enabled ? 'empty' : 'disabled', settings: { enabled, retentionDays: 90 }, report: { days: 30, entries: 0, amountEntries: 0, missingAmountEntries: 0, earliest: null, latest: null, totals: null, daily: [], categories: [] }, lastCapture: null }; }
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8' } });

test('history client accepts exact saved cashflow, paused history and unknown empty totals', () => {
  assert.deepEqual(plain(client.walletHistoryResponse(fixture(), args)), fixture());
  assert.equal(client.walletHistoryResponse(empty(), args).report.totals, null);
  assert.equal(client.walletHistoryResponse(empty(true), args).status, 'empty');
  const paused = fixture(); paused.settings.enabled = false; paused.status = 'disabled';
  assert.equal(client.walletHistoryResponse(paused, args).report.totals.netISK, '10.20');
});

for (const [label, change] of [
  ['wrong character', value => value.characterId++], ['different report period', value => value.report.days = 90],
  ['unexpected root fields', value => value.rawJournal = [{ description: 'OMIT_PRIVATE' }]], ['raw category fields', value => value.report.categories[0].counterparty = 'OMIT_PRIVATE'],
  ['wrong counts', value => value.report.entries++], ['wrong net', value => value.report.totals.netISK = '10.21'],
  ['wrong category sums', value => { value.report.categories[0].totals.incomingISK = '9.30'; value.report.categories[0].totals.netISK = '9.20'; }],
  ['wrong daily counts', value => { value.report.daily[0].entries = 3; value.report.daily[0].missingAmountEntries = 1; }],
  ['duplicate days', value => value.report.daily.push(plain(value.report.daily[0]))], ['duplicate categories', value => value.report.categories.push(plain(value.report.categories[0]))],
  ['arbitrary category label', value => value.report.categories[0].label = 'Private participant'], ['false complete history', value => value.status = 'ready'],
  ['incorrect empty status', value => value.status = 'empty'], ['enabled disabled status', value => value.status = 'disabled'],
  ['missing amount mistaken for zero', value => value.report.totals = null], ['unexpected retention', value => value.settings.retentionDays = 1000],
  ['oversized event count', value => value.report.entries = 10001], ['invalid calendar date', value => value.generatedAt = '2026-02-30T00:00:00.000Z'],
  ['invalid earliest date', value => value.report.earliest = '2026-01-01T24:00:00.000Z'], ['reversed dates', value => value.report.earliest = '2026-01-01T14:00:00.000Z'],
  ['wrong day boundary', value => value.report.earliest = '2025-12-31T23:59:59.000Z'], ['history outside report period', value => { value.report.earliest = '2025-11-01T12:00:00.000Z'; value.report.daily[0].date = '2025-11-01'; }],
  ['future entry', value => value.report.latest = '2026-01-03T13:00:00.000Z'], ['unbounded decimal', value => value.report.totals.incomingISK = '9'.repeat(1000)],
  ['exponent decimal', value => value.report.totals.incomingISK = '1e3'], ['negative incoming', value => value.report.totals.incomingISK = '-10.30'],
  ['unsafe numeric identity', value => value.characterId = Number.MAX_SAFE_INTEGER + 1], ['expanded read budget', value => value.limits.maxPages = 100],
  ['capture future time', value => value.lastCapture.at = '2026-01-03T00:00:00.000Z'], ['capture future retrieval', value => value.lastCapture.retrievedAt = '2026-01-03T00:00:00.000Z'],
  ['capture too many pages', value => value.lastCapture.pagesRead = 5], ['capture more rows than pages', value => value.lastCapture.entriesRead = 2501],
  ['capture more additions than observations', value => value.lastCapture.addedEntries = 3], ['capture missed pages reported complete', value => value.lastCapture.pagesAdvertised = 2],
  ['capture freshness conflict', value => value.lastCapture.cacheExpires = stamp], ['capture unknown pages reported complete', value => value.lastCapture.pagesAdvertised = null],
  ['secret capture field', value => value.lastCapture.source = 'https://example.invalid/private'],
]) test(`history client rejects ${label}`, () => { const value = fixture(); change(value); assert.throws(() => client.walletHistoryResponse(value, args), /incomplete response/); });

test('history preserves missing amounts and source uncertainty without invented totals', () => {
  const value = fixture();
  for (const bucket of [value.report, ...value.report.daily, ...value.report.categories]) { bucket.amountEntries = 0; bucket.missingAmountEntries = 2; bucket.totals = null; }
  Object.assign(value.lastCapture, { pagesAdvertised: null, coverage: 'unknown', cacheExpires: null, freshness: 'unknown' });
  assert.equal(client.walletHistoryResponse(value, args).report.totals, null);
  Object.assign(value.lastCapture, { pagesRead: 4, pagesAdvertised: 8, coverage: 'partial' });
  assert.equal(client.walletHistoryResponse(value, args).lastCapture.coverage, 'partial');
});

test('history validates maximum and tiny exact amounts without numeric chart coercion', () => {
  const value = fixture(), tiny = '0.' + '0'.repeat(323) + '5';
  for (const bucket of [value.report, ...value.report.daily, ...value.report.categories]) bucket.totals = { incomingISK: tiny, outgoingISK: '0.00', netISK: tiny };
  assert.equal(client.walletHistoryResponse(value, args).report.totals.netISK, tiny);
  const bound = String(BigInt(Number.MAX_SAFE_INTEGER) * 2n);
  for (const bucket of [value.report, ...value.report.daily, ...value.report.categories]) bucket.totals = { incomingISK: bound, outgoingISK: '0.00', netISK: bound };
  assert.equal(client.walletHistoryResponse(value, args).report.totals.incomingISK, bound);
  for (const bucket of [value.report, ...value.report.daily, ...value.report.categories]) bucket.totals = { incomingISK: String(BigInt(bound) + 1n), outgoingISK: '0.00', netISK: String(BigInt(bound) + 1n) };
  assert.throws(() => client.walletHistoryResponse(value, args), /incomplete response/);
});

test('configure, capture and erase responses must reflect the requested local change', () => {
  assert.equal(client.walletHistoryResponse(empty(true), { characterId, operation: 'configure', enabled: true, retentionDays: 90 }).settings.enabled, true);
  assert.throws(() => client.walletHistoryResponse(empty(), { characterId, operation: 'configure', enabled: true, retentionDays: 90 }), /incomplete response/);
  assert.throws(() => client.walletHistoryResponse(fixture(), { characterId, operation: 'configure', enabled: true, retentionDays: 30 }), /incomplete response/);
  assert.throws(() => client.walletHistoryResponse(empty(true), { characterId, operation: 'capture' }), /incomplete response/);
  assert.equal(client.walletHistoryResponse(empty(), { characterId, operation: 'clear', confirm: 'delete_wallet_history' }).settings.enabled, false);
  assert.throws(() => client.walletHistoryResponse(fixture(), { characterId, operation: 'clear', confirm: 'delete_wallet_history' }), /incomplete response/);
  const paused = fixture(); paused.status = 'disabled'; paused.settings = { enabled: false, retentionDays: 365 };
  assert.equal(client.walletHistoryResponse(paused, { characterId, operation: 'configure', enabled: false }).settings.retentionDays, 365);
  assert.throws(() => client.walletHistoryResponse(fixture(), { characterId, operation: 'configure', enabled: false }), /incomplete response/);
});

for (const bad of [null, {}, { characterId: 0, operation: 'report' }, { ...args, days: 100 }, { ...args, entity: 'corporation' }, { characterId, operation: 'clear' }, { characterId, operation: 'clear', confirm: true }, { characterId, operation: 'configure', enabled: true }, { characterId, operation: 'capture', days: 30 }]) test(`history request rejects invalid selection ${JSON.stringify(bad)}`, async () => {
  let calls = 0; const h = harness(async () => { calls++; return response(fixture()); });
  await assert.rejects(h.fetchWalletHistory(bad), /supported wallet history action/); assert.equal(calls, 0);
});

test('history transport sends one bounded same-origin request and validates the response', async () => {
  const seen = []; const h = harness(async (url, init) => { seen.push({ url, init }); return response(fixture()); });
  assert.equal((await h.fetchWalletHistory(args)).report.totals.netISK, '10.20'); assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/api/eve/wallet-history'); assert.equal(seen[0].init.method, 'POST'); assert.equal(seen[0].init.credentials, 'same-origin'); assert.equal(seen[0].init.cache, 'no-store'); assert.equal(seen[0].init.redirect, 'error'); assert.deepEqual(JSON.parse(seen[0].init.body), args);
});

test('history transport refuses non-JSON, excessive bytes, invalid UTF-8 and leaked error bodies', async () => {
  for (const result of [new Response('<html>OMIT_PRIVATE</html>'), new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }), new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }), new Response('OMIT_PRIVATE', { status: 500 })]) {
    let calls = 0; const h = harness(async () => { calls++; return result; });
    await assert.rejects(h.fetchWalletHistory(args), error => !error.message.includes('OMIT_PRIVATE')); assert.equal(calls, 1);
  }
});

test('cancelled history mutation stops waiting without retry and warns that server work may finish', async () => {
  let calls = 0; const controller = new AbortController(); const h = harness(() => { calls++; return new Promise(() => {}); });
  const pending = h.fetchWalletHistory({ characterId, operation: 'capture' }, controller.signal); controller.abort();
  await assert.rejects(pending, /saved change may still have completed/); assert.equal(calls, 1);
});

test('already-aborted history request never fetches and deadline interrupts stalled streams', async () => {
  let calls = 0; const controller = new AbortController(); controller.abort();
  await assert.rejects(harness(() => { calls++; }).fetchWalletHistory(args, controller.signal), /cancelled/); assert.equal(calls, 0);
  let timeout; const h = harness(async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), { headers: { 'content-type': 'application/json' } }), { setTimeout: callback => { timeout = callback; return 1; }, clearTimeout: () => {} });
  const pending = h.fetchWalletHistory(args); await new Promise(resolve => setImmediate(resolve)); timeout(); await assert.rejects(pending, /timed out/);
});

const comparisonArgs = { ...args, comparePrevious: true };
function comparisonFixture() {
  return { ...fixture(), comparison: {
    current: { startsAt: '2025-12-03T00:00:00.000Z', endsAt: stamp, retentionClipped: false },
    previous: { startsAt: '2025-11-03T00:00:00.000Z', endsBefore: '2025-12-03T00:00:00.000Z', retentionClipped: false,
      entries: 2, amountEntries: 2, missingAmountEntries: 0, earliest: '2025-12-01T00:00:00.000Z', latest: '2025-12-01T12:00:00.000Z',
      totals: { incomingISK: '4.10', outgoingISK: '2.20', netISK: '1.90' } },
    observedDelta: { incomingISK: '6.20', outgoingISK: '-2.10', netISK: '8.30' },
  } };
}

test('comparison response binds exact adjacent windows and signed observed differences', () => {
  const value = comparisonFixture();
  assert.deepEqual(plain(client.walletHistoryResponse(value, comparisonArgs)), value);
  value.settings.enabled = false; value.status = 'disabled';
  assert.equal(client.walletHistoryResponse(value, comparisonArgs).comparison.observedDelta.netISK, '8.30');
});

for (const [label, change] of [
  ['missing requested comparison', value => delete value.comparison],
  ['wrong current start', value => value.comparison.current.startsAt = '2025-12-04T00:00:00.000Z'],
  ['wrong current end', value => value.comparison.current.endsAt = '2026-01-02T00:00:00.001Z'],
  ['wrong previous start', value => value.comparison.previous.startsAt = '2025-11-02T00:00:00.000Z'],
  ['overlapping previous end', value => value.comparison.previous.endsBefore = stamp],
  ['false current retention clipping', value => value.comparison.current.retentionClipped = true],
  ['false previous retention clipping', value => value.comparison.previous.retentionClipped = true],
  ['incorrect previous net', value => value.comparison.previous.totals.netISK = '1.91'],
  ['incorrect previous counts', value => value.comparison.previous.entries++],
  ['previous event on excluded end', value => value.comparison.previous.latest = '2025-12-03T00:00:00.000Z'],
  ['previous event before start', value => value.comparison.previous.earliest = '2025-11-02T23:59:59.999Z'],
  ['reversed previous dates', value => value.comparison.previous.earliest = stamp],
  ['missing prior date', value => value.comparison.previous.earliest = null],
  ['wrong incoming difference', value => value.comparison.observedDelta.incomingISK = '6.21'],
  ['wrong outgoing difference sign', value => value.comparison.observedDelta.outgoingISK = '2.10'],
  ['wrong net difference', value => value.comparison.observedDelta.netISK = '8.31'],
  ['missing computable difference', value => value.comparison.observedDelta = null],
  ['unexpected private comparison field', value => value.comparison.previous.events = [{ description: 'OMIT_PRIVATE' }]],
  ['combined store limit exceeded', value => { value.comparison.previous.entries = 10000; value.comparison.previous.missingAmountEntries = 9998; value.comparison.observedDelta = null; }],
  ['future timestamp in comparison', value => { value.report.earliest = value.report.latest = '2026-01-02T00:00:00.001Z'; value.report.daily[0].date = '2026-01-02'; }],
]) test(`comparison client rejects ${label}`, () => {
  const value = comparisonFixture(); change(value); assert.throws(() => client.walletHistoryResponse(value, comparisonArgs), /incomplete response/);
});

test('unrequested comparisons are rejected for ordinary reports and history controls', () => {
  for (const input of [args, { ...args, comparePrevious: false }, { characterId, operation: 'status' }, { characterId, operation: 'capture' }]) {
    assert.throws(() => client.walletHistoryResponse(comparisonFixture(), input), /incomplete response/);
  }
  assert.deepEqual(plain(client.walletHistoryResponse(fixture(), { ...args, comparePrevious: false })), fixture());
});

test('comparison preserves empty, missing and retention-clipped prior periods as unknown', () => {
  const missing = comparisonFixture(); missing.comparison.previous.entries = 3; missing.comparison.previous.missingAmountEntries = 1; missing.comparison.observedDelta = null;
  assert.equal(client.walletHistoryResponse(missing, comparisonArgs).comparison.observedDelta, null);
  missing.comparison.observedDelta = { incomingISK: '6.20', outgoingISK: '-2.10', netISK: '8.30' };
  assert.throws(() => client.walletHistoryResponse(missing, comparisonArgs), /incomplete response/);
  const clipped = comparisonFixture(); clipped.settings.retentionDays = 30;
  Object.assign(clipped.comparison.previous, { retentionClipped: true, entries: 0, amountEntries: 0, missingAmountEntries: 0, earliest: null, latest: null, totals: null });
  clipped.comparison.observedDelta = null;
  assert.equal(client.walletHistoryResponse(clipped, comparisonArgs).comparison.previous.retentionClipped, true);
  clipped.comparison.previous.retentionClipped = false;
  assert.throws(() => client.walletHistoryResponse(clipped, comparisonArgs), /incomplete response/);
});

test('seven-day comparison is a report option and never a retention setting', async () => {
  const value = comparisonFixture(); value.report.days = 7;
  Object.assign(value.comparison.current, { startsAt: '2025-12-26T00:00:00.000Z' });
  Object.assign(value.comparison.previous, { startsAt: '2025-12-19T00:00:00.000Z', endsBefore: '2025-12-26T00:00:00.000Z', earliest: '2025-12-20T00:00:00.000Z', latest: '2025-12-20T12:00:00.000Z' });
  const selected = { ...comparisonArgs, days: 7 }, calls = [];
  const h = harness(async (_url, init) => { calls.push(JSON.parse(init.body)); return response(value); });
  assert.equal((await h.fetchWalletHistory(selected)).report.days, 7); assert.deepEqual(calls, [selected]);
  for (const input of [{ ...args, comparePrevious: 'true' }, { ...args, comparePrevious: null }, { characterId, operation: 'configure', enabled: true, retentionDays: 7 }, { characterId, operation: 'status', comparePrevious: true }]) {
    await assert.rejects(h.fetchWalletHistory(input), /supported wallet history action/);
  }
  assert.equal(calls.length, 1);
});
