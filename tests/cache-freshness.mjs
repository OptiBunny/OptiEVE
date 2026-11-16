import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { z } from 'zod';

// Compile the real helpers with a test-only export; production exports stay unchanged.
const helpers = { 'wallet-analytics': 'expiry', 'character-analytics': 'cacheExpiry', 'clone-analytics': 'expiry', 'blueprint-analytics': 'expiry', 'inventory-analytics': 'expiry', 'industry-analytics': 'expiry', 'order-analytics': 'expiry', 'manufacturing-assessment': 'manufacturingPrivateExpiry', 'manufacturing-market': 'sourceHeaders', 'manufacturing-catalog': 'catalogExpiry', 'wallet-history': 'capture' };
class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const unexpected = () => { throw Error('Cache fixtures must not access a runtime or make network requests'); };
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const module = { exports: {} };
  const source = readFileSync('app/lib/' + name + '.ts', 'utf8') + (helpers[name] ? '\nexport const __cacheFixture = ' + helpers[name] + ';' : '');
  const require = path => {
    if (path === 'zod') return { z };
    if (path === './connection-client') return { ConnectionResponseError: class extends Error {} };
    if (path === './eve') return { EveError, listConnections: unexpected, readCharacterData: unexpected, readCorporationData: unexpected, readEve: unexpected };
    if (path === './wallet-history-storage') return { walletHistoryStorage: {}, WALLET_HISTORY_SCOPE: 'esi-wallet.read_character_wallet.v1' };
    if (path === './manufacturing-estimate') return { manufacturingPlanSchema: {}, validateManufacturingPlan: unexpected };
    if (path === './manufacturing-stock') return { projectManufacturingStock: unexpected };
    if (path === '../data/manufacturing-catalog.json') return { default: JSON.parse(readFileSync('app/data/manufacturing-catalog.json', 'utf8')) };
    if (['./overview-summary', './manufacturing-catalog', './manufacturing-market', './wallet-analytics'].includes(path)) return load(path.slice(2));
    throw Error('Unexpected cache-fixture import: ' + path);
  };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { module, exports: module.exports, require, Date, Headers, AbortSignal, fetch: unexpected });
  cache.set(name, module.exports); return module.exports;
}
const received = Date.parse('2026-01-01T00:00:00.000Z'), stamp = '2026-01-01T00:00:00.000Z', future = '2026-01-01T01:00:00.000Z';
const base = { cacheExpires: future, responseDate: stamp, cacheControl: 'max-age=300', cacheAge: '0' };
// These expected instants are authored from the HTTP lifetime rules, not computed
// with the implementation under test. A directive takes precedence over Expires.
const cases = [
  ['zero max-age without Date', { cacheControl: 'max-age=0', responseDate: null }, null],
  ['positive max-age with malformed Date', { responseDate: 'invalid-date' }, null],
  ['Date beyond allowed60second skew', { responseDate: '2026-01-01T00:01:00.001Z' }, null],
  ['max-age beyond7day safety bound', { cacheControl: 'max-age=604801' }, null],
  ['malformed max-age', { cacheControl: 'public, max-age=wrong' }, null],
  ['malformed first directive cannot fall through to a later valid one', { cacheControl: 'max-age=wrong, max-age=300' }, null],
  ['unsupported whitespace assignment cannot revive Expires', { cacheControl: 'max-age =300' }, null],
  ['negative max-age', { cacheControl: 'max-age=-1' }, null],
  ['valueless max-age', { cacheControl: 'private, max-age' }, null],
  ['empty max-age', { cacheControl: 'max-age=' }, null],
  ['quoted max-age outside accepted parser', { cacheControl: 'max-age="300"' }, null],
  ['max-age with unusable Age', { cacheAge: 'unknown' }, null],
  ['max-age zero with valid Date', { cacheControl: 'max-age=0' }, stamp],
  ['Age already exceeds max-age', { cacheAge: '301' }, '2025-12-31T23:59:59.000Z'],
  ['valid positive lifetime', {}, '2026-01-01T00:05:00.000Z'],
  ['missing Age defaults to zero', { cacheAge: null }, '2026-01-01T00:05:00.000Z'],
  ['Date at exact60second skew stays conservative', { responseDate: '2026-01-01T00:01:00.000Z' }, '2026-01-01T00:05:00.000Z'],
  ['no-cache overrides unusable cache evidence', { cacheControl: 'max-age=300, no-cache', cacheAge: 'wrong', responseDate: null }, stamp],
  ['no-store overrides unusable cache evidence', { cacheControl: 'no-store, max-age=wrong', cacheAge: 'wrong', responseDate: null }, stamp],
  ['oversized cache-control cannot revive Expires', { cacheControl: 'max-age=0, ' + 'x'.repeat(600) }, null],
  ['oversized no-cache text remains untrusted', { cacheControl: 'no-cache, ' + 'x'.repeat(600) }, null],
  ['absent cache-control preserves Expires', { cacheControl: null, responseDate: null }, future],
  ['Expires without max-age remains usable', { cacheControl: 'private', responseDate: null }, future],
  ['lookalike directives do not claim max-age', { cacheControl: 'x-max-age=0, max-agex=0', responseDate: null }, future],
  ['earlier Expires stays conservative', { cacheExpires: '2026-01-01T00:01:00.000Z' }, '2026-01-01T00:01:00.000Z'],
];
function invoke(name, value, assessed = received) {
  const helper = load(name).__cacheFixture;
  if (!['manufacturing-market', 'manufacturing-catalog'].includes(name)) return helper(value, assessed);
  const headers = new Headers();
  for (const [field, header] of [['cacheExpires', 'expires'], ['responseDate', 'date'], ['cacheControl', 'cache-control'], ['cacheAge', 'age']]) if (value[field] != null) headers.set(header, value[field]);
  return name === 'manufacturing-market' ? helper('https://esi.evetech.net/synthetic-fixture', headers, assessed).cacheExpires : helper(headers, assessed);
}
for (const name of Object.keys(helpers).filter(name => name !== 'wallet-history')) {
  const selectedCases = ['manufacturing-market', 'manufacturing-catalog'].includes(name) ? cases : [...cases,
    ['nonstring numeric cache-control stays unknown', { cacheControl: 300 }, null],
    ['nonstring object cache-control stays unknown', { cacheControl: { maxAge: 300 } }, null],
  ];
  for (const [label, override, expected] of selectedCases) test(name + ': ' + label, () => assert.equal(invoke(name, { ...base, ...override }), expected));
}

for (const [label, headers, expectedFreshness, expectedExpiry] of [
  ['missing Date cannot make a capture fresh', { cacheControl: 'max-age=0', responseDate: null }, 'unknown', null],
  ['unusable max-age cannot make a capture fresh', { cacheControl: 'max-age=wrong' }, 'unknown', null],
  ['expired max-age remains stale despite future Expires', { cacheAge: '301' }, 'stale', '2025-12-31T23:59:59.000Z'],
]) test('saved wallet capture: ' + label, async () => {
  let reads = 0;
  const captured = await load('wallet-history').__cacheFixture('synthetic-owner', 90000001, { version: 1, events: [], lastCapture: null }, 90, {
    now: () => received,
    journal: async (_user, args) => { reads++; return { ...args, pages: 1, nextPage: null, pageLimit: 500, morePagesAvailable: false, pageLimitReached: false, data: [], retrievedAt: stamp, ...base, ...headers }; },
  }, new AbortController().signal);
  assert.equal(reads, 1); assert.equal(captured.lastCapture.freshness, expectedFreshness); assert.equal(captured.lastCapture.cacheExpires, expectedExpiry); assert.equal(captured.events.length, 0);
});


// Optional HTTP metadata uses the same four-digit UTC-year domain as browser DTOs.
// Literal expectations intentionally include both bounds and arithmetic crossing them.
const expandedFuture = 'Sat, 01 Jan 10000 00:00:00 GMT';
const expandedPast = 'Fri, 31 Dec -0001 23:59:59 GMT';
const finalYear = '9999-12-31T23:59:59.000Z', firstYear = '0000-01-01T00:00:00.000Z';
const dateDomainCases = [
  ['expanded HTTP Expires is unknown', { cacheControl: null, cacheExpires: expandedFuture }, null],
  ['negative HTTP year is unknown', { cacheControl: null, cacheExpires: expandedPast }, null],
  ['offset-normalized expanded Expires is unknown', { cacheControl: null, cacheExpires: '9999-12-31T23:59:59-01:00' }, null],
  ['supported final four-digit HTTP year survives', { cacheControl: null, cacheExpires: 'Fri, 31 Dec 9999 23:59:59 GMT' }, finalYear],
  ['supported first four-digit ISO year survives', { cacheControl: null, cacheExpires: firstYear }, firstYear],
  ['unsupported Date cannot revive valid Expires', { responseDate: expandedFuture }, null],
  ['valid max-age can stand alone without malformed Expires', { cacheExpires: expandedFuture }, '2026-01-01T00:05:00.000Z'],
  ['no-store overrides unsupported header years', { cacheControl: 'no-store', cacheExpires: expandedFuture, responseDate: expandedPast }, stamp],
  ['no-cache overrides unsupported header years', { cacheControl: 'no-cache', cacheExpires: expandedFuture, responseDate: expandedPast }, stamp],
  ['computed expiry crossing beyond year9999 stays unknown', { cacheExpires: null, responseDate: finalYear, cacheControl: 'max-age=60' }, null, Date.parse(finalYear)],
  ['aged expiry crossing before year0000 stays unknown', { cacheExpires: null, responseDate: firstYear, cacheControl: 'max-age=0', cacheAge: '1' }, null, Date.parse(firstYear)],
  ['earlier supported Expires bounds overflowing max-age', { cacheExpires: finalYear, responseDate: finalYear, cacheControl: 'max-age=60' }, finalYear, Date.parse(finalYear)],
  ['no-store remains stale at the supported upper boundary', { cacheControl: 'no-store', cacheExpires: expandedFuture, responseDate: finalYear }, finalYear, Date.parse(finalYear)],
];
for (const name of Object.keys(helpers).filter(name => name !== 'wallet-history')) {
  for (const [label, fields, expected, assessed] of dateDomainCases) test(name + ': supported date domain ' + label, () => assert.equal(invoke(name, { ...base, ...fields }, assessed), expected));
}

// Cross real reader projections into their real strict browser clients. The empty
// provider feeds are valid observations, so malformed optional headers cannot hide them.
const serviceClients = [
  ['wallet-analytics', 'createWalletAnalyticsReader', 'analytics-client', 'walletAnalyticsResponse', 'journal'],
  ['inventory-analytics', 'createInventoryAnalyticsReader', 'operations-analytics-client', 'inventoryAnalyticsResponse', 'assets'],
  ['industry-analytics', 'createIndustryAnalyticsReader', 'operations-analytics-client', 'industryAnalyticsResponse', 'character'],
  ['order-analytics', 'createOrderAnalyticsReader', 'order-analytics-client', 'orderAnalyticsResponse', 'orders'],
  ['blueprint-analytics', 'createBlueprintAnalyticsReader', 'blueprint-analytics-client', 'blueprintAnalyticsResponse', 'character'],
  ['character-analytics', 'createCharacterAnalyticsReader', 'analytics-client', 'characterAnalyticsResponse', 'character'],
  ['clone-analytics', 'createCloneAnalyticsReader', 'clone-analytics-client', 'cloneAnalyticsResponse', 'character'],
];
const allFixtureScopes = ['esi-wallet.read_character_wallet.v1', 'esi-assets.read_assets.v1', 'esi-industry.read_character_jobs.v1', 'esi-markets.read_character_orders.v1', 'esi-characters.read_blueprints.v1', 'esi-skills.read_skills.v1', 'esi-skills.read_skillqueue.v1', 'esi-clones.read_clones.v1', 'esi-clones.read_implants.v1'];
function syntheticFeed(args, extra) {
  const data = args.dataset === 'skills' ? { skills: [], total_sp: 0, unallocated_sp: 0 } : args.dataset === 'attributes' ? { charisma: 20, intelligence: 20, memory: 20, perception: 20, willpower: 20 } : args.dataset === 'clones' ? { jump_clones: [] } : [];
  const pagination = args.dataset === 'blueprints' ? { kind: 'page', page: 1, pages: 1, nextPage: null } : { kind: 'none' };
  return { ...args, data, retrievedAt: stamp, cacheExpires: future, responseDate: stamp, lastModified: '2025-12-31T23:59:00.000Z', pagination, pages: 1, nextPage: null, ...extra };
}
for (const [service, factory, client, response, dependency] of serviceClients) {
  for (const [label, extra, expectedExpiry, expectedModified] of [
    ['expanded Last-Modified is omitted', { lastModified: expandedFuture }, future, null],
    ['expanded Expires is unknown', { cacheExpires: expandedFuture }, null, '2025-12-31T23:59:00.000Z'],
    ['supported year9999 survives', { cacheExpires: finalYear, lastModified: finalYear }, finalYear, finalYear],
    ['no-store precedence survives', { cacheExpires: expandedFuture, cacheControl: 'no-store' }, stamp, '2025-12-31T23:59:00.000Z'],
  ]) test(service + ': strict client accepts ' + label, async () => {
    let reads = 0; const input = { characterId: 90000001, ...(['character-analytics', 'clone-analytics'].includes(service) ? {} : { entity: 'character' }), ...(service === 'industry-analytics' ? { includeCompleted: false } : {}) };
    const reader = load(service)[factory]({ connections: async user => { assert.equal(user, 'synthetic-owner'); return [{ characterId: input.characterId, scopes: allFixtureScopes }]; }, [dependency]: async (user, args) => { assert.equal(user, 'synthetic-owner'); reads++; return syntheticFeed(args, extra); }, now: () => received });
    const value = await reader('synthetic-owner', input);
    assert(['ready', 'partial'].includes(value.status), 'Valid synthetic feed must retain observed data');
    const result = load(client)[response](value, input);
    const parts = service === 'character-analytics' ? [result.skills, result.queue, result.attributes] : service === 'clone-analytics' ? [result.clones, result.implants] : [result.freshness];
    for (const part of parts) { assert.equal(part.cacheExpires, expectedExpiry); if (Object.hasOwn(part, 'lastModified')) assert.equal(part.lastModified, expectedModified); }
    assert.equal(reads, service === 'character-analytics' ? 3 : service === 'clone-analytics' ? 2 : 1);
  });
}
for (const [label, extra, expectedExpiry] of [
  ['unsupported absolute expiry stays unknown', { cacheControl: null, cacheExpires: expandedFuture }, null],
  ['supported final year remains usable', { cacheControl: null, cacheExpires: finalYear }, finalYear],
  ['explicit no-store keeps a stale capture', { cacheControl: 'no-store', cacheExpires: expandedFuture }, stamp],
]) test('saved wallet capture supported date domain: ' + label, async () => {
  const result = await load('wallet-history').__cacheFixture('synthetic-owner', 90000001, { version: 1, events: [], lastCapture: null }, 90, {
    now: () => received,
    journal: async (_user, args) => ({ ...args, pages: 1, nextPage: null, pageLimit: 500, morePagesAvailable: false, pageLimitReached: false, data: [], retrievedAt: stamp, ...base, ...extra }),
  }, new AbortController().signal);
  assert.equal(result.lastCapture.cacheExpires, expectedExpiry);
  assert.equal(result.lastCapture.freshness, expectedExpiry === null ? 'unknown' : Date.parse(expectedExpiry) <= received ? 'stale' : 'fresh');
});


for (const [label, header, expected] of [
  ['expanded HTTP year', expandedFuture, null],
  ['offset-normalized expanded year', '9999-12-31T23:59:59-01:00', null],
  ['supported final HTTP year', 'Fri, 31 Dec 9999 23:59:59 GMT', finalYear],
  ['supported first ISO year', firstYear, firstYear],
  ['ordinary malformed value', 'invalid-date', null],
  ['ordinary current value', 'Thu, 01 Jan 2026 00:00:00 GMT', stamp],
]) test('public manufacturing source Last-Modified: ' + label, () => {
  const headers = new Headers({ 'last-modified': header, expires: future });
  const result = load('manufacturing-market').__cacheFixture('https://esi.evetech.net/synthetic-fixture', headers, received);
  assert.equal(result.lastModified, expected);
  assert.equal(result.cacheExpires, future, 'Optional modification metadata cannot erase independently valid lifetime evidence');
});
