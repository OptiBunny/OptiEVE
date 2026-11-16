import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';

const code = ts.transpileModule(readFileSync('app/lib/contracts-analytics-client.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
class ConnectionResponseError extends Error { constructor(message, status = 0) { super(message); this.status = status; } }
function harness(fetch = () => { throw Error('Unexpected network read'); }, timers = {}) {
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Date, AbortController, setTimeout, clearTimeout, fetch, ...timers, require: name => name === 'zod' ? { z } : { ConnectionResponseError } });
  return module.exports;
}
const client = harness(), selected = { characterId: 90000001, entity: 'character' }, stamp = '2026-01-01T12:00:00.000Z';
const clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
  return { ...selected, corporationId: null, generatedAt: stamp, status: 'ready', message: 'Synthetic contract page.', scope: 'esi-contracts.read_character_contracts.v1',
    coverage: { kind: 'complete_returned_response', page: 1, pages: 1, nextPage: null, previousPage: null, pageLimitReached: false, rows: 5 }, freshness: { state: 'fresh', retrievedAt: stamp, cacheExpires: '2026-01-01T13:00:00.000Z', lastModified: null },
    summary: { contracts: 5, outstanding: 3, inProgress: 1, outstandingPastExpiry: 1, outstandingDueWithin24h: 1 },
    statusCounts: [{ status: 'outstanding', count: 3 }, { status: 'in_progress', count: 1 }, { status: 'finished_issuer', count: 0 }, { status: 'finished_contractor', count: 0 }, { status: 'finished', count: 1 }, { status: 'cancelled', count: 0 }, { status: 'rejected', count: 0 }, { status: 'failed', count: 0 }, { status: 'deleted', count: 0 }, { status: 'reversed', count: 0 }],
    typeCounts: [{ type: 'unknown', count: 1 }, { type: 'item_exchange', count: 1 }, { type: 'auction', count: 1 }, { type: 'courier', count: 2 }, { type: 'loan', count: 0 }],
    contracts: [
      { contractId: 104, type: 'courier', status: 'in_progress', issuedAt: '2025-12-01T00:00:00.000Z', offerExpiresAt: '2026-01-01T00:00:00.000Z', acceptedAt: '2025-12-31T00:00:00.000Z', daysToComplete: 0 },
      { contractId: 101, type: 'unknown', status: 'outstanding', issuedAt: '2025-12-01T00:00:00.000Z', offerExpiresAt: stamp, acceptedAt: null, daysToComplete: null },
      { contractId: 102, type: 'courier', status: 'outstanding', issuedAt: '2025-12-01T00:00:00.000Z', offerExpiresAt: '2026-01-02T12:00:00.000Z', acceptedAt: null, daysToComplete: null },
      { contractId: 103, type: 'auction', status: 'outstanding', issuedAt: '2025-12-01T00:00:00.000Z', offerExpiresAt: '2026-01-02T12:00:00.001Z', acceptedAt: null, daysToComplete: null },
      { contractId: 105, type: 'item_exchange', status: 'finished', issuedAt: '2025-12-01T00:00:00.000Z', offerExpiresAt: '2026-01-08T12:00:00.000Z', acceptedAt: null, daysToComplete: 10 },
    ], limitations: ['Synthetic received-page evidence only.'] };
}
function unavailable(status = 'needs_permission', page = 1) {
  const value = fixture(); return { ...value, status, coverage: { ...value.coverage, kind: 'unavailable', page, pages: null, previousPage: page > 1 ? page - 1 : null, rows: 0 }, freshness: { state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null }, summary: null, contracts: [], statusCounts: [], typeCounts: [] };
}

test('strict contracts projection preserves exact offered boundaries and optional reported fields', () => {
  const result = client.contractsAnalyticsResponse(fixture(), selected);
  assert.equal(result.summary.outstandingPastExpiry, 1); assert.equal(result.summary.outstandingDueWithin24h, 1);
  assert.equal(result.contracts[0].daysToComplete, 0); assert.equal(result.contracts[1].acceptedAt, null); assert.equal(result.contracts[4].acceptedAt, null);
  const noAcceptance = fixture(); noAcceptance.contracts[0].acceptedAt = null; assert.equal(client.contractsAnalyticsResponse(noAcceptance, selected).contracts[0].status, 'in_progress');
  const afterOffer = fixture(); afterOffer.contracts[0].acceptedAt = '2026-01-02T12:00:00.000Z'; assert(client.contractsAnalyticsResponse(afterOffer, selected));
});

test('both feed owners accept explicit pages and retain unknown page count or page limit', () => {
  for (const entity of ['character', 'corporation']) for (const [page, pages, nextPage, kind, pageLimitReached] of [[2, 3, 3, 'partial', false], [2, null, null, 'unknown', false], [500, 501, null, 'partial', true], [500, null, null, 'unknown', true]]) {
    const value = fixture(); Object.assign(value, { entity, corporationId: entity === 'corporation' ? 98000001 : null, scope: 'esi-contracts.read_' + entity + '_contracts.v1', status: 'partial' }); Object.assign(value.coverage, { page, pages, nextPage, previousPage: page - 1, kind, pageLimitReached });
    assert.equal(client.contractsAnalyticsResponse(value, { ...selected, entity, page }).coverage.page, page);
  }
});

test('freshness is assessed at generation time and unavailable remains distinct from known empty', () => {
  for (const status of ['needs_permission', 'unavailable', 'error']) assert.equal(client.contractsAnalyticsResponse(unavailable(status, 2), { ...selected, page: 2 }).summary, null);
  const empty = fixture(); empty.contracts = []; empty.coverage.rows = 0; Object.keys(empty.summary).forEach(key => empty.summary[key] = 0); empty.statusCounts.forEach(row => row.count = 0); empty.typeCounts.forEach(row => row.count = 0);
  assert.equal(client.contractsAnalyticsResponse(empty, selected).summary.contracts, 0);
  for (const [cacheExpires, state] of [[stamp, 'stale'], [null, 'unknown']]) { const value = fixture(); value.status = 'partial'; Object.assign(value.freshness, { cacheExpires, state }); assert.equal(client.contractsAnalyticsResponse(value, selected).freshness.state, state); }
});

const mutations = [
  ['wrong character', v => v.characterId++], ['wrong feed', v => v.entity = 'corporation'], ['personal corporation leaked', v => v.corporationId = 98000001], ['wrong scope', v => v.scope = 'esi-wallet.read_character_wallet.v1'],
  ['private top-level field', v => v.raw = 'PRIVATE_MARKER'], ['title disclosure', v => v.contracts[0].title = 'PRIVATE_MARKER'], ['issuer disclosure', v => v.contracts[0].issuer_id = 90000002], ['location disclosure', v => v.contracts[0].start_location_id = 60000001], ['money disclosure', v => v.contracts[0].reward = 1],
  ['duplicate contract', v => v.contracts[1].contractId = 104], ['unsafe contract ID', v => v.contracts[0].contractId = Number.MAX_SAFE_INTEGER + 1], ['negative days', v => v.contracts[0].daysToComplete = -1], ['fractional days', v => v.contracts[0].daysToComplete = .5], ['unsafe days', v => v.contracts[0].daysToComplete = Number.MAX_SAFE_INTEGER + 1],
  ['malformed offer date', v => v.contracts[0].offerExpiresAt = '2026-02-30T00:00:00.000Z'], ['noncanonical offer date', v => v.contracts[0].offerExpiresAt = '2026-01-01T00:00:00+00:00'], ['expiry before issue', v => v.contracts[0].issuedAt = '2026-01-01T00:00:00.001Z'], ['acceptance before issue', v => v.contracts[0].acceptedAt = '2025-11-30T23:59:59.999Z'],
  ['unsorted offer dates', v => v.contracts.reverse()], ['unknown provider status', v => v.contracts[0].status = 'delivered'], ['unknown contract type', v => v.contracts[0].type = 'exchange'],
  ['forged page rows', v => v.coverage.rows++], ['forged total', v => v.summary.contracts++], ['forged outstanding', v => v.summary.outstanding--], ['forged in progress', v => v.summary.inProgress--], ['boundary expiry missing from elapsed', v => v.summary.outstandingPastExpiry = 0], ['beyond24h incorrectly counted', v => v.summary.outstandingDueWithin24h = 2],
  ['missing fixed status', v => v.statusCounts.pop()], ['reordered statuses', v => v.statusCounts.reverse()], ['duplicate status', v => v.statusCounts[1].status = 'outstanding'], ['forged status count', v => v.statusCounts[0].count--], ['missing fixed type', v => v.typeCounts.pop()], ['reordered types', v => v.typeCounts.reverse()], ['forged type count', v => v.typeCounts[0].count++],
  ['wrong page', v => v.coverage.page = 2], ['invented previous page', v => v.coverage.previousPage = 1], ['invented next page', v => v.coverage.nextPage = 2], ['invented page limit', v => v.coverage.pageLimitReached = true], ['wrong page coverage', v => v.coverage.kind = 'unknown'],
  ['missing retrieval', v => v.freshness.retrievedAt = null], ['future retrieval', v => v.freshness.retrievedAt = '2026-01-01T12:01:00.001Z'], ['stale reported fresh', v => v.freshness.cacheExpires = stamp], ['unknown reported fresh', v => v.freshness.cacheExpires = null], ['complete fresh incorrectly partial', v => v.status = 'partial'], ['unavailable with data', v => v.status = 'unavailable'],
];
for (const [label, mutate] of mutations) test('rejects ' + label, () => { const value = fixture(); mutate(value); assert.throws(() => client.contractsAnalyticsResponse(value, selected), ConnectionResponseError); });

test('unavailable results cannot carry stale rows, zero summaries or source evidence', () => {
  for (const mutate of [v => v.contracts = fixture().contracts, v => v.summary = fixture().summary, v => v.statusCounts = fixture().statusCounts, v => v.typeCounts = fixture().typeCounts, v => v.corporationId = 98000001, v => v.freshness.cacheExpires = stamp, v => v.coverage.rows = 1]) { const value = unavailable(); mutate(value); assert.throws(() => client.contractsAnalyticsResponse(value, selected)); }
});

test('rows tied on offer expiry require unique ascending IDs', () => {
  const value = fixture(); value.contracts[3].offerExpiresAt = value.contracts[2].offerExpiresAt; value.summary.outstandingDueWithin24h = 2;
  assert(client.contractsAnalyticsResponse(value, selected)); [value.contracts[2], value.contracts[3]] = [value.contracts[3], value.contracts[2]]; assert.throws(() => client.contractsAnalyticsResponse(value, selected));
});

test('responses above 1000 records are rejected instead of silently truncated', () => {
  const value = fixture(); value.contracts = Array.from({ length: 1001 }, (_, index) => ({ ...value.contracts[0], contractId: index + 1 })); assert.throws(() => client.contractsAnalyticsResponse(value, selected));
});

test('request binding uses only the selected feed/page and private same-origin transport', async () => {
  const calls = [], h = harness(async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(fixture()), { headers: { 'content-type': 'application/json' } }); });
  await h.contractsAnalyticsRequest(selected); assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/eve/contracts-analytics'); assert.deepEqual(JSON.parse(calls[0].options.body), selected);
  for (const [key, expected] of Object.entries({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' })) assert.equal(calls[0].options[key], expected);
  for (const args of [{}, { ...selected, characterId: 0 }, { ...selected, page: 0 }, { ...selected, page: 501 }, { ...selected, page: undefined }, { ...selected, page: '2' }, { ...selected, corporationId: 98000001 }, { ...selected, scope: 'write' }]) await assert.rejects(h.contractsAnalyticsRequest(args)); assert.equal(calls.length, 1);
});

test('cancelled and timed-out loads do not return late contracts', async () => {
  const controller = new AbortController(); controller.abort(); let reads = 0;
  await assert.rejects(harness(async () => { reads++; }).contractsAnalyticsRequest(selected, controller.signal), /cancelled or timed out/); assert.equal(reads, 0);
  const pending = new AbortController(); const h = harness(async () => ({ ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: async () => { pending.abort(); return fixture(); } }));
  await assert.rejects(h.contractsAnalyticsRequest(selected, pending.signal), /cancelled or timed out/);
  let timeout; const timed = harness(async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('abort')))), { setTimeout: fn => { timeout = fn; return 1; }, clearTimeout: () => {} });
  const read = timed.contractsAnalyticsRequest(selected); timeout(); await assert.rejects(read, /cancelled or timed out/);
});

test('HTTP errors and malformed bodies remain generic without reflecting provider content', async () => {
  for (const status of [401, 404, 500]) await assert.rejects(harness(async () => new Response('PRIVATE_MARKER', { status })).contractsAnalyticsRequest(selected), error => error.status === status && !error.message.includes('PRIVATE_MARKER'));
  await assert.rejects(harness(async () => new Response('PRIVATE_MARKER', { headers: { 'content-type': 'text/html' } })).contractsAnalyticsRequest(selected), /incomplete response/);
  await assert.rejects(harness(async () => new Response('PRIVATE_MARKER', { headers: { 'content-type': 'application/json' } })).contractsAnalyticsRequest(selected), error => !error.message.includes('PRIVATE_MARKER'));
});

// Cross the independently implemented server/browser boundary using actual service
// projections, with synthetic EVE responses and no account or network access.
const compileService = name => ts.transpileModule(readFileSync('app/lib/' + name + '.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const serviceSources = Object.fromEntries(['overview-summary', 'wallet-analytics', 'contracts-analytics'].map(name => [name, compileService(name)]));
function serviceProjection(selection, { data, pages = 1, grant = true, cacheExpires = 'Thu, 01 Jan 2026 13:00:00 GMT' }) {
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const page = selection.page ?? 1, more = pages === null ? null : page < pages, calls = [];
  const read = async (_user, args) => { calls.push(args); return { characterId: selection.characterId, dataset: 'contracts', ...(selection.entity === 'corporation' ? { entity: 'corporation', corporationId: 98000001 } : {}),
    data, retrievedAt: stamp, cacheExpires, pagination: { kind: 'page', page, pages, nextPage: more && page < 500 ? page + 1 : null, pageLimit: 500, morePagesAvailable: more, pageLimitReached: page === 500 && more !== false } }; };
  const dependencies = { connections: async () => [{ characterId: selection.characterId, scopes: grant ? ['esi-contracts.read_character_contracts.v1', 'esi-contracts.read_corporation_contracts.v1'] : [] }], character: read, corporation: read, now: () => Date.parse(stamp) };
  const eve = { EveError, listConnections: dependencies.connections, readCharacterData: read, readCorporationData: read, readEve: () => { throw Error('Unexpected wallet read'); } }, modules = {};
  for (const name of ['overview-summary', 'wallet-analytics', 'contracts-analytics']) {
    const module = { exports: {} }; modules[name] = module;
    vm.runInNewContext(serviceSources[name], { module, exports: module.exports, Date, AbortSignal, require: spec => spec === './eve' ? eve : modules[spec.slice(2)].exports });
  }
  return { read: () => modules['contracts-analytics'].exports.createContractsAnalyticsReader(dependencies)('synthetic-owner', selection), calls };
}
test('real service projections pass strict client validation across owners, page limits and exact expiry boundaries', async () => {
  const raw = [
    { contract_id: 201, type: 'courier', status: 'outstanding', date_issued: '2025-12-01T00:00:00Z', date_expired: stamp, title: 'PRIVATE_MARKER', issuer_id: 90009999, reward: 50 },
    { contract_id: 202, type: 'courier', status: 'outstanding', date_issued: '2025-12-01T00:00:00Z', date_expired: '2026-01-02T12:00:00.000Z', days_to_complete: 0 },
    { contract_id: 203, type: 'courier', status: 'outstanding', date_issued: '2025-12-01T00:00:00Z', date_expired: '2026-01-02T12:00:00.001Z', date_accepted: null },
  ];
  for (const entity of ['character', 'corporation']) for (const [page, pages] of [[1, 1], [2, 3], [500, null]]) {
    const selection = { ...selected, entity, page }, h = serviceProjection(selection, { data: raw, pages }), result = client.contractsAnalyticsResponse(await h.read(), selection);
    assert.equal(result.summary.outstandingPastExpiry, 1); assert.equal(result.summary.outstandingDueWithin24h, 1); assert.equal(result.contracts[1].daysToComplete, 0); assert.equal(result.contracts[2].acceptedAt, null);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].dataset, 'contracts'); assert.equal(h.calls[0].parameters.page, page); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_MARKER|issuer_id|reward/);
  }
});
test('real empty, stale, denied and malformed service results retain their evidence state in the strict client', async () => {
  const cases = [
    [{ data: [] }, 'ready', 0],
    [{ data: [], cacheExpires: 'Thu, 01 Jan 2026 12:00:00 GMT' }, 'partial', 0],
    [{ data: [], grant: false }, 'needs_permission', null],
    [{ data: [{}] }, 'error', null],
  ];
  for (const [options, status, count] of cases) { const h = serviceProjection(selected, options), result = client.contractsAnalyticsResponse(await h.read(), selected); assert.equal(result.status, status); assert.equal(result.summary?.contracts ?? null, count); assert.equal(h.calls.length, options.grant === false ? 0 : 1); }
});
