import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { z } from 'zod';

const compile = file => ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const panelCode = compile('app/wallet-history-panel.tsx'), chartCode = compile('app/analytics-charts.tsx'), clientCode = compile('app/lib/analytics-client.ts');
class ConnectionResponseError extends Error { constructor(message, status = 0) { super(message); this.status = status; } }
const analytics = { exports: {} };
vm.runInNewContext(clientCode, { module: analytics, exports: analytics.exports, require: name => name === 'zod' ? { z } : { ConnectionResponseError } });
const chart = { exports: {} };
vm.runInNewContext(chartCode, { module: chart, exports: chart.exports, require: name => name === 'react' ? React : name === 'react/jsx-runtime' ? jsxRuntime : analytics.exports });
function load(react = React, fetchWalletHistory = () => { throw Error('Rendering must not fetch'); }) {
  const module = { exports: {} };
  vm.runInNewContext(panelCode, { module, exports: module.exports, AbortController, Date, require: name => {
    if (name === 'react') return react; if (name === 'react/jsx-runtime') return jsxRuntime;
    if (name === './analytics-charts') return chart.exports;
    if (name === './lib/connection-client') return { ConnectionResponseError };
    if (name === './lib/analytics-client') return analytics.exports;
    assert.equal(name, './lib/wallet-history-client'); return { fetchWalletHistory };
  } });
  return module.exports;
}
const stamp = '2026-01-02T00:00:00.000Z', characterId = 90000001, scope = 'esi-wallet.read_character_wallet.v1';
const plain = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const bucket = { entries: 2, amountEntries: 2, missingAmountEntries: 0, totals: { incomingISK: '10.30', outgoingISK: '0.10', netISK: '10.20' } };
  return { characterId, generatedAt: stamp, status: 'partial', message: 'Synthetic saved observations.', settings: { enabled: true, retentionDays: 90 }, report: { days: 30, ...plain(bucket), earliest: '2026-01-01T12:00:00.000Z', latest: '2026-01-01T13:00:00.000Z', daily: [{ date: '2026-01-01', ...plain(bucket) }], categories: [{ id: 'market', label: 'Market activity', ...plain(bucket) }] }, lastCapture: { at: stamp, pagesRead: 4, pagesAdvertised: 6, entriesRead: 2, addedEntries: 2, coverage: 'partial', freshness: 'fresh', retrievedAt: stamp, cacheExpires: '2026-01-02T01:00:00.000Z' }, limits: { maxPages: 4, maxEvents: 10000 }, precisionPolicy: 'Synthetic exact decimal policy.', limitations: ['Synthetic incomplete history.'] };
}
function empty(enabled = false) { return { ...fixture(), status: enabled ? 'empty' : 'disabled', settings: { enabled, retentionDays: 90 }, report: { days: 30, entries: 0, amountEntries: 0, missingAmountEntries: 0, earliest: null, latest: null, totals: null, daily: [], categories: [] }, lastCapture: null }; }
const render = result => renderToStaticMarkup(React.createElement(load().WalletHistoryResults, { result }));

test('saved cashflow chart and exact table agree and explain incomplete observation coverage', () => {
  const html = render(fixture());
  assert.match(html, /Net cash flow \(ISK\)<\/dt><dd>10.20<\/dd>/); assert.match(html, /Incoming ISK<\/dt><dd>10.30<\/dd>/);
  assert.match(html, /<th scope="row">2026-01-01<\/th><td>10.30<\/td><td>0.10<\/td><td>10.20<\/td>/);
  assert.match(html, /saved observations only/); assert.doesNotMatch(html, /returned page only/);
  assert.match(html, /Cash flow includes transfers and is not profit or wallet balance/);
  assert.match(html, /Read 4 of 6 advertised pages/); assert.match(html, /freshness when journal read completed: fresh/);
  assert.match(html, /a report does not trigger a capture/); assert.doesNotMatch(html, /NaN|Infinity|undefined/);
});

test('empty observations and missing amounts remain unknown, not zero cashflow', () => {
  const html = render(empty()); assert.match(html, /No saved observations in this period. Cash-flow totals are unknown/); assert.doesNotMatch(html, /Net cash flow \(ISK\)/);
  const value = fixture(); for (const bucket of [value.report, ...value.report.daily, ...value.report.categories]) { bucket.amountEntries = 0; bucket.missingAmountEntries = 2; bucket.totals = null; }
  const missing = render(value); assert.match(missing, /Saved entries contain no reported amounts/); assert.match(missing, /Amount not reported/); assert.doesNotMatch(missing, /Net cash flow \(ISK\)/);
});

test('untrusted text is escaped and raw rows are never rendered', () => {
  const value = fixture(); value.limitations = ['<img src="https://example.invalid/fixture" onerror="alert(1)">']; value.rawJournal = [{ description: 'OMIT_PRIVATE' }];
  const html = render(value); assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img|<script|OMIT_PRIVATE/);
});

test('initial panel does not fetch and explains optional private retention', () => {
  const html = renderToStaticMarkup(React.createElement(load().default, { characters: [{ characterId, name: 'Synthetic character', corporationId: 98000001, scopes: [scope] }], openConnections: () => {} }));
  assert.match(html, /History starts off/); assert.match(html, /does not start a schedule/); assert.match(html, /Load saved history/);
  assert.doesNotMatch(html, /Capture recent journal now/);
});

// Drives component handlers and hook state; this is not browser layout coverage.
function interactions(fetch, scopes = [scope]) {
  const values = [], effects = []; let cursor = 0;
  const react = { ...React, useState: initial => { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], next => { values[i] = typeof next === 'function' ? next(values[i]) : next; }]; }, useRef: initial => { const i = cursor++; if (!(i in values)) values[i] = { current: initial }; return values[i]; }, useEffect: effect => { const i = cursor++; if (!(i in values)) { values[i] = true; effects.push(effect()); } } };
  const components = load(react, fetch);
  const properties = { characters: [{ characterId, name: 'Synthetic character', corporationId: 98000001, scopes }, { characterId: characterId + 1, name: 'Other synthetic character', corporationId: 98000002, scopes }], openConnections: () => {} };
  return { render: () => { cursor = 0; return components.default(properties); }, cleanup: () => effects.forEach(fn => fn?.()), results: components.WalletHistoryResults };
}
function nodes(element) { if (!element || typeof element !== 'object') return []; return [element, ...React.Children.toArray(element.props?.children).flatMap(nodes)]; }
const find = (tree, predicate) => nodes(tree).find(predicate);
const label = element => React.Children.toArray(element.props?.children).filter(value => typeof value === 'string').join('');
const button = (tree, text) => find(tree, node => node.type === 'button' && label(node) === text);
const settle = () => new Promise(resolve => setImmediate(resolve));

test('history selection, report period, cancel and unmount suppress stale results', async () => {
  const calls = []; const h = interactions((args, signal) => new Promise(resolve => calls.push({ args, signal, resolve })));
  button(h.render(), 'Load saved history').props.onClick(); calls[0].resolve(fixture()); await settle(); assert(find(h.render(), node => node.type === h.results));
  find(h.render(), node => node.props?.id === 'wallet-history-character').props.onChange({ target: { value: String(characterId + 1) } });
  assert(!find(h.render(), node => node.type === h.results)); assert.equal(calls[0].signal.aborted, true);
  button(h.render(), 'Load saved history').props.onClick(); assert.equal(calls[1].args.characterId, characterId + 1);
  find(h.render(), node => node.props?.id === 'wallet-history-period').props.onChange({ target: { value: '90' } });
  calls[1].resolve(fixture()); await settle(); assert(!find(h.render(), node => node.type === h.results));
  button(h.render(), 'Load saved history').props.onClick(); assert.equal(calls[2].args.days, 90);
  button(h.render(), 'Cancel').props.onClick(); assert.equal(calls[2].signal.aborted, true); calls[2].resolve(fixture()); await settle(); assert(!find(h.render(), node => node.type === h.results));
  button(h.render(), 'Load saved history').props.onClick(); h.cleanup(); assert.equal(calls[3].signal.aborted, true); calls[3].resolve(fixture()); await settle(); assert(!find(h.render(), node => node.type === h.results));
});

test('enabling and capture are separate explicit actions with no automatic follow-up request', async () => {
  const calls = []; const h = interactions((args, signal) => new Promise(resolve => calls.push({ args, signal, resolve })));
  assert.equal(calls.length, 0); button(h.render(), 'Load saved history').props.onClick(); calls[0].resolve(empty()); await settle();
  assert(!button(h.render(), 'Capture recent journal now')); find(h.render(), node => node.props?.id === 'wallet-history-retention').props.onChange({ target: { value: '365' } });
  button(h.render(), 'Enable private history').props.onClick(); assert.deepEqual(plain(calls[1].args), { characterId, operation: 'configure', enabled: true, retentionDays: 365 }); assert(!find(h.render(), node => node.type === h.results));
  calls[1].resolve({ ...empty(true), settings: { enabled: true, retentionDays: 365 } }); await settle(); assert.equal(calls.length, 2);
  button(h.render(), 'Capture recent journal now').props.onClick(); assert.deepEqual(plain(calls[2].args), { characterId, operation: 'capture' }); assert(button(h.render(), 'Stop waiting'));
  button(h.render(), 'Stop waiting').props.onClick(); calls[2].resolve(fixture()); await settle(); assert(!find(h.render(), node => node.type === h.results)); assert.equal(calls.length, 3);
});

test('erase needs fresh explicit confirmation and clears enabled state without a new capture', async () => {
  const calls = []; const h = interactions((args, signal) => new Promise(resolve => calls.push({ args, signal, resolve })));
  button(h.render(), 'Load saved history').props.onClick(); calls[0].resolve(fixture()); await settle();
  const erase = button(h.render(), 'Erase saved history'); assert.equal(erase.props.disabled, true); erase.props.onClick(); assert.equal(calls.length, 1);
  find(h.render(), node => node.props?.id === 'wallet-history-erase').props.onChange({ target: { checked: true } });
  assert.equal(button(h.render(), 'Erase saved history').props.disabled, false); button(h.render(), 'Erase saved history').props.onClick();
  assert.deepEqual(plain(calls[1].args), { characterId, operation: 'clear', confirm: 'delete_wallet_history' }); calls[1].resolve(empty()); await settle();
  assert.equal(button(h.render(), 'Erase saved history').props.disabled, true); assert(button(h.render(), 'Enable private history')); assert(!button(h.render(), 'Capture recent journal now')); assert.equal(calls.length, 2);
});

test('missing wallet scope disables enabling and capture but leaves erase available', async () => {
  const calls = []; const h = interactions(async args => { calls.push(plain(args)); return empty(); }, []); button(h.render(), 'Load saved history').props.onClick(); await settle();
  assert.deepEqual(calls, [{ characterId, operation: 'status' }]);
  assert.equal(button(h.render(), 'Enable private history').props.disabled, true); assert(button(h.render(), 'Review access'));
  find(h.render(), node => node.props?.id === 'wallet-history-erase').props.onChange({ target: { checked: true } }); assert.equal(button(h.render(), 'Erase saved history').props.disabled, false);
});

test('scope-loss configuration can pause existing captures without reading financial history', async () => {
  const calls = []; const h = interactions(async args => { calls.push(plain(args)); return args.operation === 'status' ? empty(true) : empty(); }, []);
  button(h.render(), 'Load saved history').props.onClick(); await settle();
  assert.equal(button(h.render(), 'Save retention').props.disabled, true); assert.equal(button(h.render(), 'Capture recent journal now').props.disabled, true);
  button(h.render(), 'Pause captures').props.onClick(); await settle();
  assert.deepEqual(calls, [{ characterId, operation: 'status' }, { characterId, operation: 'configure', enabled: false }]);
  assert(button(h.render(), 'Enable private history')); assert(!button(h.render(), 'Capture recent journal now'));
});

test('pausing captures preserves server retention despite a stale view and unsaved dropdown change', async () => {
  const calls = []; const h = interactions(async args => { calls.push(plain(args)); return args.operation === 'report' ? fixture() : { ...fixture(), status: 'disabled', settings: { enabled: false, retentionDays: 365 } }; });
  button(h.render(), 'Load saved history').props.onClick(); await settle();
  find(h.render(), node => node.props?.id === 'wallet-history-retention').props.onChange({ target: { value: '30' } });
  assert.equal(find(h.render(), node => node.props?.id === 'wallet-history-retention').props.value, 30);
  button(h.render(), 'Pause captures').props.onClick(); await settle();
  assert.deepEqual(calls, [{ characterId, operation: 'report', days: 30 }, { characterId, operation: 'configure', enabled: false }]);
  assert.equal(find(h.render(), node => node.props?.id === 'wallet-history-retention').props.value, 365);
  assert.equal(find(h.render(), node => node.type === h.results).props.result.report.entries, 2);
});

test('server errors clear prior history and preserve the sign-in recovery link', async () => {
  let calls = 0; const h = interactions(async () => { if (!calls++) return fixture(); throw new ConnectionResponseError('Synthetic sign-in required.', 401); });
  button(h.render(), 'Load saved history').props.onClick(); await settle(); button(h.render(), 'Reload saved history').props.onClick(); await settle();
  assert(!find(h.render(), node => node.type === h.results)); assert(find(h.render(), node => node.type === 'a' && node.props.href === '/signin-with-chatgpt?return_to=%2F'));
});
