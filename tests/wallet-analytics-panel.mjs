import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

const code = ts.transpileModule(readFileSync('app/wallet-analytics-panel.tsx', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
class ConnectionResponseError extends Error { constructor(message, status = 0) { super(message); this.status = status; } }
function WalletNetChart() { return React.createElement('div', { 'data-testid': 'wallet-net' }); }
function CashFlowBars() { return React.createElement('div', { 'data-testid': 'wallet-gross' }); }
const characterId = 90000001, stamp = '2026-02-01T12:00:00.000Z';
const characters = [{ characterId, name: 'Synthetic first', scopes: [] }, { characterId: characterId + 1, name: 'Synthetic second', scopes: [] }];
const row = (date = '2026-01-01') => ({ date, entries: 1, amountEntries: 1, missingAmountEntries: 0, totals: { incomingISK: '1.00', outgoingISK: '0.00', netISK: '1.00' } });
function fixture({ page = 1, entity = 'character', division = null, daily = [row()], owner = characterId } = {}) {
  return { characterId: owner, entity, division, corporationId: entity === 'corporation' ? 98000001 : null, generatedAt: stamp, status: 'partial', message: 'Synthetic wallet evidence.', scope: entity === 'character' ? 'esi-wallet.read_character_wallet.v1' : 'esi-wallet.read_corporation_wallets.v1',
    coverage: { page, pages: 2, nextPage: page === 1 ? 2 : null, previousPage: page === 2 ? 1 : null, pageLimitReached: false, entries: daily.length, amountEntries: daily.length, missingAmountEntries: 0, earliest: daily[0].date + 'T12:00:00.000Z', latest: daily[daily.length - 1].date + 'T12:00:00.000Z', kind: 'partial' },
    freshness: { state: 'fresh', retrievedAt: stamp, cacheExpires: '2026-02-01T13:00:00.000Z', lastModified: null }, totals: { incomingISK: String(daily.length), outgoingISK: '0', netISK: String(daily.length) }, daily, categories: [{ entries: daily.length, amountEntries: daily.length, missingAmountEntries: 0, totals: { incomingISK: String(daily.length), outgoingISK: '0', netISK: String(daily.length) }, id: 'other', label: 'Other activity' }], precisionPolicy: 'Synthetic precision.', limitations: ['Synthetic partial page.'] };
}
function load(react = React, walletAnalyticsRequest = () => { throw Error('Initial rendering must not fetch'); }) {
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, AbortController, Date, require: name => {
    if (name === 'react') return react; if (name === 'react/jsx-runtime') return jsxRuntime;
    if (name === './lib/connection-client') return { ConnectionResponseError };
    if (name === './lib/analytics-client') return { walletAnalyticsRequest, formatISK: value => value };
    if (name === './wallet-net-chart') return { default: WalletNetChart };
    if (name === './analytics-charts') return { CashFlowBars };
    throw Error('Unexpected import ' + name);
  } });
  return module.exports.default;
}
function interactions(fetch) {
  const values = [], effects = []; let cursor = 0;
  const react = { ...React, useState: initial => { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], next => { values[i] = typeof next === 'function' ? next(values[i]) : next; }]; }, useRef: initial => { const i = cursor++; if (!(i in values)) values[i] = { current: initial }; return values[i]; }, useEffect: effect => { const i = cursor++; if (!(i in values)) { values[i] = true; effects.push(effect()); } } };
  const component = load(react, fetch);
  return { render: () => { cursor = 0; return component({ characters, openConnections: () => {} }); }, cleanup: () => effects.forEach(fn => fn?.()) };
}
const nodes = element => !element || typeof element !== 'object' ? [] : [element, ...React.Children.toArray(element.props?.children).flatMap(nodes)];
const find = (tree, predicate) => nodes(tree).find(predicate);
const text = element => React.Children.toArray(element.props?.children).filter(value => typeof value === 'string').join('');
const button = (tree, label) => find(tree, node => node.type === 'button' && text(node) === label);
const chart = tree => find(tree, node => node.type === WalletNetChart);
const change = (h, id, value) => find(h.render(), node => node.props?.id === id).props.onChange({ target: { value } });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('initial wallet panel fetches nothing and shows no financial chart', () => {
  const html = renderToStaticMarkup(React.createElement(load(), { characters, openConnections: () => {} }));
  assert.match(html, /Load wallet activity/); assert.doesNotMatch(html, /data-testid="wallet-net"/);
});

test('net chart receives the selected response while existing exact tables retain all returned dates', async () => {
  const daily = Array.from({ length: 31 }, (_, i) => row('2026-01-' + String(i + 1).padStart(2, '0')));
  const h = interactions(async () => fixture({ daily })); button(h.render(), 'Load wallet activity').props.onClick(); await settle();
  assert.equal(chart(h.render()).props.daily.length, 31);
  const gross = find(h.render(), node => node.type === CashFlowBars && node.props.title === 'Daily incoming and outgoing (UTC)');
  assert.equal(gross.props.rows.length, 31); assert.equal(gross.props.rows[0].label, '2026-01-01');
});

test('journal page replacement clears the old chart and never combines daily observations', async () => {
  const calls = [], h = interactions((args, signal) => new Promise(resolve => calls.push({ args, signal, resolve })));
  button(h.render(), 'Load wallet activity').props.onClick(); calls[0].resolve(fixture()); await settle();
  button(h.render(), 'Next journal page').props.onClick(); assert(!chart(h.render())); assert.equal(calls[1].args.page, 2); assert.equal(calls[0].signal.aborted, true);
  calls[1].resolve(fixture({ page: 2, daily: [row('2026-01-15')] })); await settle();
  assert.deepEqual(chart(h.render()).props.daily.map(value => value.date), ['2026-01-15']);
  button(h.render(), 'Refresh first page').props.onClick(); assert.equal(calls[2].args.page, 1); assert(!chart(h.render()));
});

test('owner entity and corporation division changes abort reads and remove previous chart evidence', async () => {
  const calls = [], h = interactions((args, signal) => new Promise(resolve => calls.push({ args, signal, resolve })));
  button(h.render(), 'Load wallet activity').props.onClick(); calls[0].resolve(fixture()); await settle(); assert(chart(h.render()));
  change(h, 'wallet-character', String(characterId + 1)); assert(!chart(h.render())); assert.equal(calls[0].signal.aborted, true);
  button(h.render(), 'Load wallet activity').props.onClick(); assert.equal(calls[1].args.characterId, characterId + 1);
  change(h, 'wallet-entity', 'corporation'); calls[1].resolve(fixture({ owner: characterId + 1 })); await settle(); assert(!chart(h.render()));
  button(h.render(), 'Load wallet activity').props.onClick(); assert.equal(calls[2].args.division, 1);
  change(h, 'wallet-division', '3'); calls[2].resolve(fixture({ entity: 'corporation', division: 1, owner: characterId + 1 })); await settle(); assert(!chart(h.render()));
  button(h.render(), 'Load wallet activity').props.onClick(); assert.equal(calls[3].args.division, 3);
  calls[3].resolve(fixture({ entity: 'corporation', division: 3, owner: characterId + 1 })); await settle(); assert(chart(h.render()));
});

test('cancel and unmount suppress late wallet chart responses', async () => {
  const calls = [], h = interactions((args, signal) => new Promise(resolve => calls.push({ args, signal, resolve })));
  button(h.render(), 'Load wallet activity').props.onClick(); button(h.render(), 'Cancel').props.onClick(); calls[0].resolve(fixture()); await settle(); assert(!chart(h.render())); assert.equal(calls[0].signal.aborted, true);
  button(h.render(), 'Load wallet activity').props.onClick(); h.cleanup(); calls[1].resolve(fixture()); await settle(); assert(!chart(h.render())); assert.equal(calls[1].signal.aborted, true);
});

test('unavailable wallet evidence and failed refresh never render a plausible net chart', async () => {
  const value = fixture(); value.status = 'needs_permission'; value.totals = null; value.daily = []; value.categories = []; Object.assign(value.coverage, { kind: 'unavailable', entries: 0, amountEntries: 0, missingAmountEntries: 0, pages: null, nextPage: null, earliest: null, latest: null }); value.freshness = { state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null };
  const missing = interactions(async () => value); button(missing.render(), 'Load wallet activity').props.onClick(); await settle(); assert(!chart(missing.render()));
  let count = 0; const denied = interactions(async () => { if (!count++) return fixture(); throw new ConnectionResponseError('Synthetic sign-in required.', 401); });
  button(denied.render(), 'Load wallet activity').props.onClick(); await settle(); button(denied.render(), 'Refresh first page').props.onClick(); await settle(); assert(!chart(denied.render()));
  assert(find(denied.render(), node => node.type === 'a' && node.props.href === '/signin-with-chatgpt?return_to=%2F'));
});
