import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { z } from 'zod';

const compile = name => ts.transpileModule(readFileSync(`app/lib/${name}.ts`, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const code = compile('analytics-client'), connectionCode = compile('connection-client');
function harness(fetch = () => { throw Error('Unexpected request'); }, timers = {}) {
  const connection = { exports: {} }, client = { exports: {} };
  vm.runInNewContext(connectionCode, { module: connection, exports: connection.exports });
  vm.runInNewContext(code, { module: client, exports: client.exports, fetch, AbortController, setTimeout, clearTimeout, ...timers, require: name => name === 'zod' ? { z } : connection.exports });
  return client.exports;
}
const client = harness(), characterId = 90000001, args = { characterId }, walletArgs = { characterId, entity: 'character' }, stamp = '2026-01-01T00:00:00.000Z', expires = '2026-01-01T01:00:00.000Z';
const plain = value => JSON.parse(JSON.stringify(value));
const totals = { incomingISK: '0.30', outgoingISK: '0.10', netISK: '0.20' };
function characterFixture() {
  const section = (data, scope = 'esi-skills.read_skills.v1') => ({ data, scope, status: 'ready', message: 'Synthetic projection.', retrievedAt: stamp, cacheExpires: expires, freshness: 'fresh' });
  return {
    characterId, generatedAt: stamp, status: 'ready', message: 'Synthetic response.',
    skills: section({ totalSp: 8001, unallocatedSp: null, reportedSkillSp: 8000, skillCount: 1, trainedSkillCount: 1, activeSkillCount: 1, reducedActiveSkillCount: 0, boostedActiveSkillCount: 0, levelDistribution: Array.from({ length: 6 }, (_, level) => ({ level, trainedCount: level === 3 ? 1 : 0, activeCount: level === 3 ? 1 : 0 })), groups: [{ groupId: 20, name: 'Synthetic public group', skillCount: 1, skillpoints: 8000 }], skills: [{ typeId: 1001, name: 'Synthetic public skill', groupId: 20, groupName: 'Synthetic public group', trainedLevel: 3, activeLevel: 3, skillpoints: 8000 }] }),
    queue: section({ entryCount: 1, timedEntryCount: 1, passedFinishEntryCount: 0, nextPlannedFinishAt: '2026-01-02T00:00:00.000Z', lastPlannedFinishAt: '2026-01-02T00:00:00.000Z', entries: [{ position: 0, typeId: 1001, name: 'Synthetic public skill', finishedLevel: 4, startAt: stamp, finishAt: '2026-01-02T00:00:00.000Z', levelStartSp: 8000, levelEndSp: 45000, trainingStartSp: 12000 }] }, 'esi-skills.read_skillqueue.v1'),
    attributes: section({ charisma: 20, intelligence: 21, memory: 22, perception: 23, willpower: 24, bonusRemaps: null, lastRemapAt: null, accruedRemapCooldownAt: null }),
  };
}
function walletFixture() {
  const bucket = { entries: 2, amountEntries: 2, missingAmountEntries: 0, totals: { ...totals } };
  return { characterId, entity: 'character', division: null, corporationId: null, generatedAt: stamp, status: 'ready', message: 'Synthetic wallet response.', scope: 'esi-wallet.read_character_wallet.v1', coverage: { kind: 'complete_returned_window', page: 1, pages: 1, nextPage: null, previousPage: null, pageLimitReached: false, entries: 2, amountEntries: 2, missingAmountEntries: 0, earliest: '2025-12-31T12:00:00.000Z', latest: '2025-12-31T13:00:00.000Z' }, freshness: { state: 'fresh', retrievedAt: stamp, cacheExpires: expires, lastModified: null }, totals: { ...totals }, daily: [{ date: '2025-12-31', ...plain(bucket) }], categories: [{ id: 'market', label: 'Market activity', ...plain(bucket) }], precisionPolicy: 'Synthetic precision policy.', limitations: ['Synthetic limitations.'] };
}
const unavailable = () => ({ ...walletFixture(), status: 'needs_permission', coverage: { kind: 'unavailable', page: 1, pages: null, nextPage: null, previousPage: null, pageLimitReached: false, entries: 0, amountEntries: 0, missingAmountEntries: 0, earliest: null, latest: null }, freshness: { state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null }, totals: null, daily: [], categories: [] });

test('analytics clients accept exact synthetic projections while keeping separate total SP unchanged', () => {
  assert.deepEqual(plain(client.characterAnalyticsResponse(characterFixture(), args)), characterFixture());
  assert.deepEqual(plain(client.walletAnalyticsResponse(walletFixture(), walletArgs)), walletFixture());
  assert.equal(client.characterAnalyticsResponse(characterFixture(), args).skills.data.totalSp, 8001);
  assert.equal(client.walletAnalyticsResponse(unavailable(), walletArgs).totals, null);
});

for (const [name, mutate] of [
  ['different character', value => value.characterId++], ['extra root private field', value => value.privateSettings = 'OMIT_PRIVATE'],
  ['extra skill private field', value => value.skills.data.skills[0].secret = 'OMIT_PRIVATE'], ['invalid calendar date', value => value.generatedAt = '2026-02-30T00:00:00Z'],
  ['extra section field', value => value.queue.source = 'https://example.invalid/private'], ['control character name', value => value.skills.data.skills[0].name = 'Synthetic\u202e'],
  ['wrong scope', value => value.attributes.scope = 'esi-location.read_location.v1'], ['inconsistent overall status', value => value.status = 'error'],
  ['active summary count', value => value.skills.data.activeSkillCount = 0], ['trained summary count', value => value.skills.data.trainedSkillCount = 0],
  ['reduced summary count', value => value.skills.data.reducedActiveSkillCount = 1], ['boosted summary count', value => value.skills.data.boostedActiveSkillCount = 1],
  ['swapped level distribution', value => { value.skills.data.levelDistribution[2].trainedCount = 1; value.skills.data.levelDistribution[3].trainedCount = 0; }],
  ['wrong skill group', value => value.skills.data.skills[0].groupId = 99], ['wrong group name', value => value.skills.data.skills[0].groupName = 'Other group'],
  ['wrong skill SP', value => value.skills.data.skills[0].skillpoints = 7999], ['unknown attribute field', value => value.attributes.data.implants = [1234]],
  ['duplicate queue target', value => { value.queue.data.entries.push({ ...value.queue.data.entries[0], position: 1 }); value.queue.data.entryCount = 2; value.queue.data.timedEntryCount = 2; }],
  ['reversed queue dates', value => value.queue.data.entries[0].startAt = '2026-01-03T00:00:00.000Z'], ['inconsistent queue SP', value => value.queue.data.entries[0].levelEndSp = 1],
  ['incorrect timed count', value => value.queue.data.timedEntryCount = 0], ['incorrect past-finish count', value => value.queue.data.passedFinishEntryCount = 1],
  ['incorrect next finish', value => value.queue.data.nextPlannedFinishAt = null], ['stale declared fresh', value => value.queue.cacheExpires = stamp],
  ['ready null section', value => value.queue.data = null], ['invalid date hour', value => value.generatedAt = '2026-01-01T24:00:00Z'],
]) test(`character analytics rejects ${name}`, () => { const value = characterFixture(); mutate(value); assert.throws(() => client.characterAnalyticsResponse(value, args), /incomplete response/); });

test('character analytics preserves partial permission state, unknown queue dates and expert-system levels', () => {
  const value = characterFixture(); value.status = 'partial';
  value.attributes = { ...value.attributes, status: 'needs_permission', retrievedAt: null, cacheExpires: null, freshness: 'unknown', data: null };
  value.skills.data.skills[0].activeLevel = 5; value.skills.data.boostedActiveSkillCount = 1; value.skills.data.levelDistribution[3].activeCount = 0; value.skills.data.levelDistribution[5].activeCount = 1;
  Object.assign(value.queue.data.entries[0], { startAt: null, finishAt: null }); Object.assign(value.queue.data, { timedEntryCount: 0, nextPlannedFinishAt: null, lastPlannedFinishAt: null });
  assert.equal(client.characterAnalyticsResponse(value, args).skills.data.skills[0].activeLevel, 5);
});

for (const [name, mutate] of [
  ['different character', value => value.characterId++], ['wrong entity', value => value.entity = 'corporation'], ['wrong division', value => value.division = 2],
  ['unexpected corporation ID', value => value.corporationId = 98000001], ['wrong page', value => value.coverage.page = 2], ['wrong scope', value => value.scope = 'esi-wallet.read_corporation_wallets.v1'],
  ['private journal rows', value => value.journal = [{ reason: 'OMIT_PRIVATE' }]], ['private bucket field', value => value.daily[0].participants = [90000002]],
  ['incorrect net', value => value.totals.netISK = '0.21'], ['inconsistent daily sum', value => { value.daily[0].totals.incomingISK = '1.30'; value.daily[0].totals.netISK = '1.20'; }],
  ['inconsistent category counts', value => { value.categories[0].entries = 1; value.categories[0].amountEntries = 1; }], ['arbitrary category label', value => value.categories[0].label = 'OMIT_PRIVATE_LABEL'],
  ['duplicate day', value => value.daily.push(plain(value.daily[0]))], ['duplicate category', value => value.categories.push(plain(value.categories[0]))],
  ['false complete coverage', value => value.coverage.pages = 2], ['false page limit', value => value.coverage.pageLimitReached = true], ['bad next page', value => value.coverage.nextPage = 3],
  ['false missing amount count', value => value.coverage.missingAmountEntries = 1], ['unknown total despite known amounts', value => value.totals = null],
  ['error with totals', value => value.status = 'error'], ['invalid timestamp', value => value.coverage.earliest = '2026-02-30T00:00:00.000Z'], ['wrong earliest day', value => value.coverage.earliest = '2025-12-30T00:00:00.000Z'],
  ['invalid decimal exponent', value => value.totals.incomingISK = '1e2'], ['negative incoming', value => value.totals.incomingISK = '-1'], ['invalid net leading zeros', value => value.totals.netISK = '00.20'],
  ['stale source marked fresh', value => value.freshness.cacheExpires = stamp], ['missing source fetch time', value => value.freshness.retrievedAt = null],
]) test(`wallet analytics rejects ${name}`, () => { const value = walletFixture(); mutate(value); assert.throws(() => client.walletAnalyticsResponse(value, walletArgs), /incomplete response/); });

test('wallet analytics validates exact tiny and maximum aggregate decimal magnitudes', () => {
  const tiny = '0.' + '0'.repeat(323) + '5', value = walletFixture();
  for (const target of [value, value.daily[0], value.categories[0]]) target.totals = { incomingISK: tiny, outgoingISK: '0.00', netISK: tiny };
  assert.equal(client.walletAnalyticsResponse(value, walletArgs).totals.netISK, tiny);
  const bound = String(BigInt(Number.MAX_SAFE_INTEGER) * 2n);
  for (const target of [value, value.daily[0], value.categories[0]]) target.totals = { incomingISK: bound, outgoingISK: '0.00', netISK: bound };
  assert.equal(client.walletAnalyticsResponse(value, walletArgs).totals.netISK, bound);
  const excessive = String(BigInt(bound) + 1n);
  for (const target of [value, value.daily[0], value.categories[0]]) target.totals = { incomingISK: excessive, outgoingISK: '0.00', netISK: excessive };
  assert.throws(() => client.walletAnalyticsResponse(value, walletArgs), /incomplete response/);
});

test('wallet analytics distinguishes unknown amounts, verified empty responses and missing access', () => {
  const unknown = walletFixture(); unknown.status = 'partial';
  for (const target of [unknown.coverage, unknown.daily[0], unknown.categories[0]]) Object.assign(target, { amountEntries: 0, missingAmountEntries: 2 });
  for (const target of [unknown, unknown.daily[0], unknown.categories[0]]) target.totals = null;
  assert.equal(client.walletAnalyticsResponse(unknown, walletArgs).totals, null);
  const empty = walletFixture(); Object.assign(empty.coverage, { entries: 0, amountEntries: 0, earliest: null, latest: null }); empty.daily = []; empty.categories = []; empty.totals = { incomingISK: '0.00', outgoingISK: '0.00', netISK: '0.00' };
  assert.equal(client.walletAnalyticsResponse(empty, walletArgs).totals.netISK, '0.00');
  const missing = unavailable(); missing.totals = empty.totals;
  assert.throws(() => client.walletAnalyticsResponse(missing, walletArgs), /incomplete response/);
});

test('wallet analytics pins corporation division, page navigation and unknown coverage', () => {
  const value = walletFixture(); Object.assign(value, { entity: 'corporation', corporationId: 98000001, division: 3, scope: 'esi-wallet.read_corporation_wallets.v1', status: 'partial' });
  Object.assign(value.coverage, { page: 2, pages: 3, previousPage: 1, nextPage: 3, kind: 'partial' });
  const selected = { characterId, entity: 'corporation', division: 3, page: 2 };
  assert.equal(client.walletAnalyticsResponse(value, selected).division, 3);
  assert.throws(() => client.walletAnalyticsResponse(value, { ...selected, division: 2 }), /incomplete response/);
  Object.assign(value.coverage, { pages: null, nextPage: null, kind: 'unknown' });
  assert.equal(client.walletAnalyticsResponse(value, selected).coverage.kind, 'unknown');
});

test('exact ISK formatter never converts a decimal string to floating point', () => {
  assert.equal(client.formatISK('9007199254740991.0000001'), '9,007,199,254,740,991.0000001');
  assert.equal(client.formatISK('-1234567890.0100'), '-1,234,567,890.0100');
  assert.equal(client.formatISK('0.00'), '0.00');
});
test('decimal chart maxima compare exact values and width geometry stays bounded', () => {
  assert.equal(client.decimalMaximum(['1.00001', '1.00002']), '1.00002');
  assert.equal(client.decimalMaximum(['9007199254740991.0000001', '9007199254740991.0000002']), '9007199254740991.0000002');
  assert.equal(client.decimalMaximum([]), '0'); assert.equal(client.decimalWidth('0.00', '0'), 0); assert.equal(client.decimalWidth('0.1', '0.3'), 33.33);
  assert.equal(client.decimalWidth('1.00002', '1.00002'), 100);
});

test('analytics requests use selected context with same-origin no-store POST and bounded timeout', async () => {
  const seen = [], h = harness(async (url, options) => { seen.push({ url, options }); return { ok: true, status: 200, headers: { get: () => 'application/json; charset=utf-8' }, json: async () => url.includes('character-analytics') ? characterFixture() : walletFixture() }; });
  await h.characterAnalyticsRequest(args); await h.walletAnalyticsRequest(walletArgs);
  assert.deepEqual(seen.map(value => value.url), ['/api/eve/character-analytics', '/api/eve/wallet-analytics']);
  for (const { options } of seen) { assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error'); assert.equal(options.headers['Content-Type'], 'application/json'); assert(options.signal instanceof AbortSignal); }
  assert.deepEqual(JSON.parse(seen[0].options.body), args); assert.deepEqual(JSON.parse(seen[1].options.body), walletArgs);
});

test('request errors suppress private provider bodies and retain actionable HTTP status', async () => {
  for (const status of [401, 404, 403, 500]) {
    const h = harness(async () => ({ ok: false, status, json: () => { throw Error('Private body must not be read'); } }));
    await assert.rejects(h.walletAnalyticsRequest(walletArgs), error => error.status === status && !error.message.includes('Private'));
  }
  await assert.rejects(harness(async () => { throw Error('OMIT_PRIVATE_HOST'); }).characterAnalyticsRequest(args), error => /could not be reached/.test(error.message) && !error.message.includes('OMIT_PRIVATE'));
  await assert.rejects(harness(async () => ({ ok: true, headers: { get: () => 'text/html' }, json: () => { throw Error('Unexpected body'); } })).walletAnalyticsRequest(walletArgs), /incomplete response/);
});

test('already-cancelled requests perform no fetch and in-flight cancellation suppresses late data', async () => {
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(harness().characterAnalyticsRequest(args, cancelled.signal), /cancelled or timed out/);
  const controller = new AbortController();
  const h = harness(async () => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => { controller.abort(); return walletFixture(); } }));
  await assert.rejects(h.walletAnalyticsRequest(walletArgs, controller.signal), /cancelled or timed out/);
});

test('request timeout aborts the pending transport and cleans up its timer', async () => {
  let timeout, cleared = false;
  const h = harness(async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })), { setTimeout: (fn, milliseconds) => { assert.equal(milliseconds, 60000); timeout = fn; return 7; }, clearTimeout: timer => { assert.equal(timer, 7); cleared = true; } });
  const pending = h.walletAnalyticsRequest(walletArgs); timeout();
  await assert.rejects(pending, /cancelled or timed out/); assert(cleared);
});

test('the client accepts actual skills-service projections across success, partial and failed sections', async () => {
  const summary = { exports: {} }, service = { exports: {} };
  vm.runInNewContext(compile('overview-summary'), { module: summary, exports: summary.exports });
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  vm.runInNewContext(compile('character-analytics'), { module: service, exports: service.exports, AbortSignal, require: name => name === './overview-summary' ? summary.exports : name === './manufacturing-catalog' ? { findPublishedManufacturingItem: () => null } : { EveError } });
  for (const mode of ['ready', 'stale', 'missing', 'malformed', 'partial']) {
    const read = service.exports.createCharacterAnalyticsReader({ now: () => Date.parse(stamp), connections: async () => [{ characterId, scopes: mode === 'missing' ? [] : ['esi-skills.read_skills.v1', 'esi-skills.read_skillqueue.v1'] }], character: async (_user, request) => ({ characterId, dataset: request.dataset, retrievedAt: stamp, cacheExpires: mode === 'stale' ? stamp : expires, pagination: { kind: 'none', nextPage: null, after: null, before: null }, data: mode === 'malformed' || mode === 'partial' && request.dataset === 'skills' ? {} : request.dataset === 'skills' ? { total_sp: 1, skills: [{ skill_id: 1001, skillpoints_in_skill: 0, trained_skill_level: 0, active_skill_level: 5 }] } : request.dataset === 'skill_queue' ? [{ queue_position: 0, skill_id: 1001, finished_level: 1 }] : { charisma: 20, intelligence: 21, memory: 22, perception: 23, willpower: 24 } }) });
    const projected = await read('synthetic-owner', args);
    assert.deepEqual(plain(client.characterAnalyticsResponse(projected, args)), plain(projected), mode);
  }
});

test('the client accepts actual wallet-service projections including subnormal numbers, missing amounts and page limits', async () => {
  const service = { exports: {} };
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  vm.runInNewContext(compile('wallet-analytics'), { module: service, exports: service.exports, AbortSignal, require: () => ({ EveError }) });
  for (const mode of ['ready', 'empty', 'missing', 'tiny', 'unknown', 'limit', 'permission', 'error']) {
    const selected = { ...walletArgs, page: mode === 'limit' ? 500 : 1 };
    const read = service.exports.createWalletAnalyticsReader({ now: () => Date.parse(stamp), connections: async () => [{ characterId, scopes: mode === 'permission' ? [] : ['esi-wallet.read_character_wallet.v1'] }], journal: async (_user, request) => {
      if (mode === 'error') throw Error('Synthetic failure');
      const pages = mode === 'unknown' ? null : mode === 'limit' ? 501 : 1;
      return { ...request, pages, nextPage: null, retrievedAt: stamp, cacheExpires: expires, data: mode === 'empty' ? [] : [{ id: 1, date: '2025-12-31T12:00:00Z', ref_type: 'market_transaction', ...(mode === 'missing' ? {} : { amount: mode === 'tiny' ? Number.MIN_VALUE : 0.1 }) }] };
    } });
    const projected = await read('synthetic-owner', selected);
    assert.deepEqual(plain(client.walletAnalyticsResponse(projected, selected)), plain(projected), mode);
  }
});
