import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

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
function invoke(name, value) {
  const helper = load(name).__cacheFixture;
  if (!['manufacturing-market', 'manufacturing-catalog'].includes(name)) return helper(value, received);
  const headers = new Headers();
  for (const [field, header] of [['cacheExpires', 'expires'], ['responseDate', 'date'], ['cacheControl', 'cache-control'], ['cacheAge', 'age']]) if (value[field] != null) headers.set(header, value[field]);
  return name === 'manufacturing-market' ? helper('https://esi.evetech.net/synthetic-fixture', headers, received).cacheExpires : helper(headers, received);
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
