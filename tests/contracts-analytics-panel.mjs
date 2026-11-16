import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

const compile = file => ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const code = compile('app/contracts-analytics-panel.tsx'), operation = { exports: {} }, charts = { exports: {} };
vm.runInNewContext(compile('app/operations-charts.tsx'), { module: operation, exports: operation.exports, require: name => name === 'react' ? React : jsxRuntime });
vm.runInNewContext(compile('app/analytics-charts.tsx'), { module: charts, exports: charts.exports, require: name => name === 'react' ? React : name === 'react/jsx-runtime' ? jsxRuntime : {} });
class ConnectionResponseError extends Error { constructor(message, status = 0) { super(message); this.status = status; } }
function load(react = React, contractsAnalyticsRequest = () => { throw Error('Initial rendering must not fetch'); }) {
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Date, AbortController, require: name => {
    if (name === 'react') return react; if (name === 'react/jsx-runtime') return jsxRuntime;
    if (name === './lib/connection-client') return { ConnectionResponseError }; if (name === './lib/contracts-analytics-client') return { contractsAnalyticsRequest };
    if (name === './operations-charts') return operation.exports; if (name === './analytics-charts') return charts.exports;
    throw Error('Unexpected import ' + name);
  }, localStorage: new Proxy({}, { get: () => { throw Error('Contracts must not be stored'); } }) });
  return module.exports;
}
const characterId = 90000001, stamp = '2026-01-01T12:00:00.000Z';
const characters = [{ characterId, name: 'Synthetic first', scopes: [] }, { characterId: characterId + 1, name: 'Synthetic second', scopes: [] }];
const record = (contractId, offerExpiresAt = '2026-01-02T00:00:00.000Z', status = 'outstanding', type = 'courier') => ({ contractId, offerExpiresAt, status, type, issuedAt: '2025-12-01T00:00:00.000Z', acceptedAt: null, daysToComplete: null });
function fixture() {
  return { characterId, entity: 'character', corporationId: null, generatedAt: stamp, status: 'ready', message: 'Synthetic available contract evidence.', scope: 'esi-contracts.read_character_contracts.v1',
    coverage: { kind: 'complete_returned_response', page: 1, pages: 1, previousPage: null, nextPage: null, pageLimitReached: false, rows: 4 }, freshness: { state: 'fresh', retrievedAt: stamp, cacheExpires: '2026-01-01T13:00:00.000Z', lastModified: null },
    summary: { contracts: 4, outstanding: 3, inProgress: 1, outstandingPastExpiry: 1, outstandingDueWithin24h: 2 },
    statusCounts: [{ status: 'outstanding', count: 3 }, { status: 'in_progress', count: 1 }, { status: 'finished_issuer', count: 0 }, { status: 'finished_contractor', count: 0 }, { status: 'finished', count: 0 }, { status: 'cancelled', count: 0 }, { status: 'rejected', count: 0 }, { status: 'failed', count: 0 }, { status: 'deleted', count: 0 }, { status: 'reversed', count: 0 }],
    typeCounts: [{ type: 'unknown', count: 1 }, { type: 'item_exchange', count: 0 }, { type: 'auction', count: 1 }, { type: 'courier', count: 2 }, { type: 'loan', count: 0 }],
    contracts: [record(101, stamp, 'outstanding', 'unknown'), { ...record(102, stamp, 'in_progress'), acceptedAt: stamp, daysToComplete: 0 }, record(103), record(104, '2026-01-02T00:00:00.000Z', 'outstanding', 'auction')], limitations: ['Synthetic returned-page evidence only.'] };
}
function batch(count) {
  const value = fixture(); value.contracts = Array.from({ length: count }, (_, index) => record(50000 + index)); value.coverage.rows = count;
  Object.assign(value.summary, { contracts: count, outstanding: count, inProgress: 0, outstandingPastExpiry: 0, outstandingDueWithin24h: count }); value.statusCounts.forEach(row => row.count = row.status === 'outstanding' ? count : 0); value.typeCounts.forEach(row => row.count = row.type === 'courier' ? count : 0); return value;
}
const nodes = element => !element || typeof element !== 'object' ? [] : [element, ...React.Children.toArray(element.props?.children).flatMap(nodes)];
const find = (tree, predicate) => nodes(tree).find(predicate);
const text = element => React.Children.toArray(element.props?.children).filter(value => typeof value === 'string').join('');
const button = (tree, label) => find(tree, node => node.type === 'button' && text(node) === label);
const settle = () => new Promise(resolve => setImmediate(resolve));
function interactions(fetch) {
  const values = [], effects = []; let cursor = 0;
  const react = { ...React, useId: () => 'synthetic-contracts', useState: initial => { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], next => { values[i] = typeof next === 'function' ? next(values[i]) : next; }]; }, useRef: initial => { const i = cursor++; if (!(i in values)) values[i] = { current: initial }; return values[i]; }, useEffect: effect => { const i = cursor++; if (!(i in values)) { values[i] = true; effects.push(effect()); } } };
  const components = load(react, fetch), render = () => { cursor = 0; return components.default({ characters, openConnections: () => {} }); };
  const rows = () => React.Children.toArray(find(render(), node => node.type === 'tbody')?.props.children);
  return { render, rows, ids: () => rows().map(row => Number(row.key.slice(row.key.lastIndexOf('$') + 1))), select: (suffix, value) => find(render(), node => node.props?.id === 'contracts-' + suffix).props.onChange({ target: { value } }), chart: () => find(render(), node => node.type === components.ContractExpiryChart), cleanup: () => effects.forEach(fn => fn?.()) };
}
const renderChart = contracts => renderToStaticMarkup(React.createElement(load().ContractExpiryChart, { contracts, selectDate: () => {} }));

test('expiry chart retains actual UTC gaps and only provider-outstanding records', () => {
  const records = [record(1, '2026-01-01T00:00:00.000Z'), record(2, '2026-01-02T00:00:00.000Z'), record(3, '2026-01-08T00:00:00.000Z'), record(4, '2026-01-08T12:00:00.000Z'), record(5, '2026-01-01T12:00:00.000Z', 'in_progress')];
  const html = renderChart(records), positions = [...html.matchAll(/<rect x="([^"]+)"/g)].map(match => Number(match[1]));
  assert.equal(positions.length, 3); assert(Math.abs((positions[2] - positions[1]) / (positions[1] - positions[0]) - 6) < 0.00001);
  for (const [day, count] of [['2026-01-01', 1], ['2026-01-02', 1], ['2026-01-08', 2]]) assert(html.includes('<th scope="row">' + day + '</th><td>' + count + '</td>'));
  assert.doesNotMatch(html, /2026-01-03|NaN|Infinity|undefined/); assert.match(html, /does not establish contract failure, completion or a courier delivery deadline/); assert.match(html, /<svg[^>]+role="img"[^>]+aria-labelledby=/);
});

test('expiry chart is bounded to earliest30dates and provides accessible exact-date controls', () => {
  const contracts = Array.from({ length: 35 }, (_, i) => record(i + 1, new Date(Date.UTC(2026, 0, i + 1)).toISOString()));
  const html = renderChart(contracts); assert.equal((html.match(/<rect /g) ?? []).length, 30); assert.match(html, /Earliest 30 of 35 returned UTC dates; 5 later dates omitted/); assert.doesNotMatch(html, /2026-02-04/);
  const selected = [], component = load({ ...React, useId: () => 'synthetic-chart' }).ContractExpiryChart;
  const tree = component({ contracts, selectDate: value => selected.push(value) }), controls = nodes(tree).filter(node => node.type === 'button'); assert.equal(controls.length, 30);
  assert.equal(controls[0].props['aria-label'], 'Show outstanding contracts expiring on 2026-01-01'); controls[0].props.onClick(); assert.deepEqual(selected, ['2026-01-01']);
});

test('initial and disconnected panels perform no automatic contract reads', () => {
  for (const connected of [characters, []]) { const html = renderToStaticMarkup(React.createElement(load().default, { characters: connected, openConnections: () => {} })); assert.doesNotMatch(html, /<svg|Outstanding contract offer expiry values/); assert.match(html, connected.length ? /Load contracts/ : /Set up a connection/); }
});

test('status, type and ID filters intersect locally and leave fullpage charts unchanged', async () => {
  let reads = 0; const h = interactions(async () => { reads++; return fixture(); }); button(h.render(), 'Load contracts').props.onClick(); await settle();
  h.select('status', 'outstanding'); assert.deepEqual(h.ids(), [101, 103, 104]); h.select('type', 'courier'); assert.deepEqual(h.ids(), [103]); h.select('query', '104'); assert.deepEqual(h.ids(), []);
  assert.match(renderToStaticMarkup(h.render()), /No returned contracts match these filters/); assert.equal(h.chart().props.contracts.length, 4); assert.equal(reads, 1);
  button(h.render(), 'Reset contract filters').props.onClick(); h.select('type', 'unknown'); assert.deepEqual(h.ids(), [101]);
});

test('chart date selection replaces other filters and excludes non-outstanding same-day rows', async () => {
  const h = interactions(async () => fixture()); button(h.render(), 'Load contracts').props.onClick(); await settle();
  h.select('query', 'no match'); h.select('type', 'loan'); h.chart().props.selectDate('2026-01-01'); assert.deepEqual(h.ids(), [101]);
  assert.equal(find(h.render(), node => node.props?.id === 'contracts-status').props.value, 'outstanding'); assert.equal(find(h.render(), node => node.props?.id === 'contracts-query').props.value, '');
  h.select('date', '2026-01-02'); assert.deepEqual(h.ids(), [103, 104]); h.select('status', 'in_progress'); assert.deepEqual(h.ids(), [102]); assert.equal(find(h.render(), node => node.props?.id === 'contracts-date').props.value, '');
  assert.equal(h.chart().props.contracts.length, 4);
});

test('dates omitted from the chart remain selectable with full matching rows', async () => {
  const value = batch(35); value.contracts = value.contracts.map((row, i) => ({ ...row, offerExpiresAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString() })); Object.assign(value.summary, { outstandingPastExpiry: 1, outstandingDueWithin24h: 1 });
  const h = interactions(async () => value); button(h.render(), 'Load contracts').props.onClick(); await settle(); h.select('date', '2026-02-04'); assert.deepEqual(h.ids(), [50034]);
  assert.equal(React.Children.toArray(find(h.render(), node => node.props?.id === 'contracts-date').props.children).length, 36);
});

test('205 matches have three bounded local pages and every filter resets the table page', async () => {
  const h = interactions(async () => batch(205)); button(h.render(), 'Load contracts').props.onClick(); await settle();
  assert.equal(h.rows().length, 100); button(h.render(), 'Next 100 contracts').props.onClick(); assert.equal(h.ids()[0], 50100); button(h.render(), 'Next 100 contracts').props.onClick(); assert.deepEqual(h.ids(), [50200, 50201, 50202, 50203, 50204]); assert.equal(button(h.render(), 'Next 100 contracts').props.disabled, true);
  for (const [filter, value] of [['query', '50204'], ['type', 'courier'], ['status', 'outstanding'], ['date', '2026-01-02']]) {
    button(h.render(), 'Reset contract filters').props.onClick(); button(h.render(), 'Next 100 contracts').props.onClick(); h.select(filter, value); assert.equal(button(h.render(), 'Previous 100 contracts').props.disabled, true); assert(h.rows().length > 0);
  }
});

test('the1000-row limit still reaches the final row with at most100 visible at a time', async () => {
  const h = interactions(async () => batch(1000)); button(h.render(), 'Load contracts').props.onClick(); await settle(); const seen = [];
  for (let page = 0; page < 10; page++) { assert.equal(h.rows().length, 100); seen.push(...h.ids()); if (page < 9) button(h.render(), 'Next 100 contracts').props.onClick(); }
  assert.equal(new Set(seen).size, 1000); assert.equal(seen[999], 50999); assert.equal(button(h.render(), 'Next 100 contracts').props.disabled, true);
});

test('reported zero completion days stay distinct from missing fields and do not become a deadline', async () => {
  const h = interactions(async () => fixture()); button(h.render(), 'Load contracts').props.onClick(); await settle(); h.select('status', 'in_progress');
  const rowHtml = renderToStaticMarkup(h.rows()[0]); assert.match(rowHtml, /2026-01-01 12:00:00\.000 UTC/); assert.match(rowHtml, /<td>0<\/td>/);
  const html = renderToStaticMarkup(h.render()); assert.match(html, /not a calculated delivery deadline/); assert.match(html, /Source: fresh/); assert.match(html, /Required read permission/);
});

test('upstream page loads replace prior results and reset local filters without merging', async () => {
  const calls = [], h = interactions((args, signal) => new Promise(resolve => calls.push({ args, signal, resolve })));
  button(h.render(), 'Load contracts').props.onClick(); const first = fixture(); first.status = 'partial'; Object.assign(first.coverage, { kind: 'partial', pages: 2, nextPage: 2 }); calls[0].resolve(first); await settle(); h.select('query', '101');
  button(h.render(), 'Load next contract page').props.onClick(); assert(!h.chart()); assert.equal(calls[0].signal.aborted, true); assert.deepEqual(JSON.parse(JSON.stringify(calls[1].args)), { characterId, entity: 'character', page: 2 });
  const second = batch(1); second.status = 'partial'; Object.assign(second.coverage, { kind: 'partial', page: 2, pages: 2, previousPage: 1 }); calls[1].resolve(second); await settle(); assert.deepEqual(h.ids(), [50000]); assert.equal(find(h.render(), node => node.props?.id === 'contracts-query').props.value, '');
});

test('character and feed changes cancel pending loads and suppress stale responses', async () => {
  for (const [selection, value] of [['character', String(characterId + 1)], ['entity', 'corporation']]) {
    const calls = [], h = interactions((args, signal) => new Promise(resolve => calls.push({ args, signal, resolve })));
    button(h.render(), 'Load contracts').props.onClick(); h.select(selection, value); calls[0].resolve(fixture()); await settle(); assert(!h.chart()); assert.equal(calls[0].signal.aborted, true);
    button(h.render(), 'Load contracts').props.onClick(); assert.equal(calls[1].args[selection === 'character' ? 'characterId' : 'entity'], selection === 'character' ? Number(value) : value);
    h.cleanup(); calls[1].resolve(fixture()); await settle(); assert(!h.chart()); assert.equal(calls[1].signal.aborted, true);
  }
});

test('refresh and explicit cancel remove prior contract evidence and prevent late display', async () => {
  const calls = [], h = interactions((args, signal) => new Promise(resolve => calls.push({ args, signal, resolve })));
  button(h.render(), 'Load contracts').props.onClick(); calls[0].resolve(fixture()); await settle(); assert(h.chart()); h.select('query', '101');
  button(h.render(), 'Refresh first contract page').props.onClick(); assert(!h.chart()); button(h.render(), 'Cancel').props.onClick(); calls[1].resolve(fixture()); await settle(); assert(!h.chart()); assert.equal(calls[1].signal.aborted, true);
  button(h.render(), 'Load contracts').props.onClick(); calls[2].resolve(fixture()); await settle(); assert.equal(h.rows().length, 4);
});

test('unavailable contract evidence never becomes a zero chart; known empty remains explicit', async () => {
  for (const unavailable of [true, false]) {
    const value = batch(0); if (unavailable) { value.status = 'needs_permission'; value.summary = null; value.statusCounts = []; value.typeCounts = []; Object.assign(value.coverage, { kind: 'unavailable', pages: null }); value.freshness = { state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null }; }
    const h = interactions(async () => value); button(h.render(), 'Load contracts').props.onClick(); await settle();
    assert.equal(Boolean(h.chart()), !unavailable); const html = renderToStaticMarkup(h.render()); assert.match(html, unavailable ? /No contract counts or schedules are inferred/ : /No outstanding contracts returned in this page/);
  }
});

test('failed refresh removes old evidence and shows sign-in recovery without sensitive error bodies', async () => {
  let reads = 0; const h = interactions(async () => { if (!reads++) return fixture(); throw new ConnectionResponseError('Sign in again.', 401); });
  button(h.render(), 'Load contracts').props.onClick(); await settle(); assert(h.chart()); button(h.render(), 'Refresh first contract page').props.onClick(); await settle(); assert(!h.chart());
  assert(find(h.render(), node => node.type === 'a' && node.props.href === '/signin-with-chatgpt?return_to=%2F'));
});
