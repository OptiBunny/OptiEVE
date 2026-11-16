import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync('app/lib/contracts-report.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const plain = value => JSON.parse(JSON.stringify(value));
function load(reader = async () => { throw Error('Projection must not fetch'); }) {
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Date, require: name => {
    assert.equal(name, './contracts-analytics'); return { readContractsAnalytics: reader };
  } });
  return module.exports;
}
const stamp = '2026-01-01T12:00:00.000Z', privateMarker = 'SYNTHETIC_PRIVATE_CONTRACT_FIELD';
const row = (id, status, expiry) => ({ contractId: id, type: 'courier', status, issuedAt: '2026-01-01T00:00:00.000Z', offerExpiresAt: expiry, acceptedAt: null, daysToComplete: null, title: privateMarker, issuer_id: 90000009 });
function fixture() {
  const future = Array.from({ length: 25 }, (_, index) => row(1001 + index, 'outstanding', new Date(Date.parse(stamp) + (index + 1) * 86400000).toISOString()));
  return {
    characterId: 90000001, entity: 'corporation', corporationId: 98000001, generatedAt: stamp, status: 'partial',
    message: 'One synthetic contracts page.', scope: 'esi-contracts.read_corporation_contracts.v1',
    coverage: { kind: 'partial', page: 2, pages: 3, nextPage: 3, previousPage: 1, pageLimitReached: false, rows: 29, raw: privateMarker },
    freshness: { state: 'stale', retrievedAt: stamp, cacheExpires: stamp, lastModified: null, raw: privateMarker },
    summary: { contracts: 29, outstanding: 27, inProgress: 1, outstandingPastExpiry: 2, outstandingDueWithin24h: 1, raw: privateMarker },
    statusCounts: [{ status: 'outstanding', count: 27, raw: privateMarker }, { status: 'in_progress', count: 1 }, { status: 'finished', count: 1 }],
    typeCounts: [{ type: 'courier', count: 29, raw: privateMarker }],
    contracts: [...future.reverse(), row(9, 'outstanding', stamp), row(8, 'outstanding', '2026-01-01T11:59:59.999Z'), row(7, 'in_progress', '2026-01-02T00:00:00.000Z'), row(6, 'finished', '2026-01-02T00:00:00.000Z')],
    limitations: ['Synthetic page coverage remains partial.'], raw: privateMarker,
  };
}

test('contracts briefing retains full-page evidence but bounds upcoming offers to twenty', () => {
  const input = fixture(), before = plain(input), result = load().projectContractsReport(input);
  assert.deepEqual(Array.from(result.upcomingOutstandingOffers, value => value.contractId), Array.from({ length: 20 }, (_, index) => 1001 + index));
  assert.equal(result.upcomingOfferTotal, 25); assert.equal(result.upcomingOffersOmitted, 5); assert.equal(result.upcomingOfferLimit, 20);
  assert.deepEqual(plain(result.summary), { contracts: 29, outstanding: 27, inProgress: 1, outstandingPastExpiry: 2, outstandingDueWithin24h: 1 });
  assert.equal(result.coverage.page, 2); assert.equal(result.coverage.pages, 3); assert.equal(result.coverage.rows, 29); assert.equal(result.freshness.state, 'stale');
  assert.deepEqual(plain(input), before, 'Projection must not reorder or mutate the source');
});

test('briefing whitelist omits raw records, nested extra fields and acceptance details', () => {
  const result = load().projectContractsReport(fixture());
  assert.doesNotMatch(JSON.stringify(result), new RegExp(privateMarker));
  assert.equal(Object.hasOwn(result, 'contracts'), false);
  assert.deepEqual(Object.keys(result.upcomingOutstandingOffers[0]).sort(), ['contractId', 'offerExpiresAt', 'type']);
  assert.deepEqual(Object.keys(result.coverage).sort(), ['kind', 'nextPage', 'page', 'pageLimitReached', 'pages', 'previousPage', 'rows']);
  assert.match(result.limitations.join(' '), /not an accepted courier delivery deadline/);
});

test('offer deadline uses strict report-time boundary and excludes every other provider status', () => {
  const input = fixture(); input.contracts = [row(3, 'outstanding', stamp), row(2, 'outstanding', '2026-01-01T12:00:00.001Z'), row(1, 'outstanding', '2026-01-01T12:00:00.001Z'), ...['in_progress', 'finished_issuer', 'finished_contractor', 'finished', 'cancelled', 'rejected', 'failed', 'deleted', 'reversed'].map((status, index) => row(20 + index, status, '2026-01-01T12:00:00.001Z'))];
  const result = load().projectContractsReport(input);
  assert.deepEqual(Array.from(result.upcomingOutstandingOffers, value => value.contractId), [1, 2]);
  assert.equal(result.upcomingOfferTotal, 2); assert.equal(result.upcomingOffersOmitted, 0);
});

test('unavailable contract evidence remains unknown while a verified empty page is zero', () => {
  const input = fixture(); input.contracts = []; input.statusCounts = []; input.typeCounts = []; input.summary = null; input.status = 'needs_permission';
  let result = load().projectContractsReport(input);
  assert.equal(result.summary, null); assert.equal(result.upcomingOfferTotal, null); assert.equal(result.upcomingOffersOmitted, null); assert.equal(result.upcomingOutstandingOffers.length, 0);
  input.status = 'ready'; input.summary = { contracts: 0, outstanding: 0, inProgress: 0, outstandingPastExpiry: 0, outstandingDueWithin24h: 0 };
  result = load().projectContractsReport(input);
  assert.equal(result.summary.contracts, 0); assert.equal(result.upcomingOfferTotal, 0); assert.equal(result.upcomingOffersOmitted, 0);
});

test('reader forwards one owner selection and cancellation signal without extra reads', async () => {
  const calls = [], controller = new AbortController(), input = { characterId: 90000001, entity: 'corporation', page: 2 };
  const report = load(async (user, args, options) => { calls.push({ user, args, options }); return fixture(); });
  const result = await report.readContractsReport('synthetic-owner', input, { signal: controller.signal });
  assert.equal(calls.length, 1); assert.equal(calls[0].user, 'synthetic-owner'); assert.equal(calls[0].args, input); assert.equal(calls[0].options.signal, controller.signal); assert.equal(result.upcomingOfferTotal, 25);
});

test('a response completed after cancellation cannot be projected as a successful report', async () => {
  const controller = new AbortController();
  const report = load(async () => { controller.abort(); return fixture(); });
  await assert.rejects(report.readContractsReport('synthetic-owner', { characterId: 90000001, entity: 'character' }, { signal: controller.signal }), error => error.name === 'AbortError');
});

test('reader failures remain failures for the outer safe-error boundary', async () => {
  const failure = new Error('Synthetic unavailable reader');
  await assert.rejects(load(async () => { throw failure; }).readContractsReport('synthetic-owner', { characterId: 90000001, entity: 'character' }), error => error === failure);
});
