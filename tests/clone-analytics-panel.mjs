import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

const compile = file => ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const panelCode = compile('app/clone-analytics-panel.tsx'), chartCode = compile('app/analytics-charts.tsx');
const chart = { exports: {} };
vm.runInNewContext(chartCode, { module: chart, exports: chart.exports, require: name => name === 'react' ? React : name === 'react/jsx-runtime' ? jsxRuntime : {} });
class ConnectionResponseError extends Error { constructor(message, status = 0) { super(message); this.status = status; } }
function load(react = React, fetchCloneAnalytics = () => { throw Error('Rendering must not fetch'); }) {
  const module = { exports: {} };
  vm.runInNewContext(panelCode, { module, exports: module.exports, AbortController, Date, require: name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return jsxRuntime;
    if (name === './analytics-charts') return chart.exports;
    if (name === './lib/connection-client') return { ConnectionResponseError };
    assert.equal(name, './lib/clone-analytics-client'); return { fetchCloneAnalytics };
  } });
  return module.exports;
}
const stamp = '2026-01-02T00:00:00.000Z', expires = '2026-01-02T01:00:00.000Z', characterId = 90000001;
const implant = { typeId: 1001, name: 'Synthetic public implant', mapped: true };
const part = (data, scope) => ({ status: 'ready', scope, message: 'Synthetic snapshot.', retrievedAt: stamp, cacheExpires: expires, freshness: 'fresh', data });
function fixture() {
  return { characterId, generatedAt: stamp, status: 'ready', message: 'Synthetic response.',
    clones: part({ homeLocation: { locationId: null, locationType: 'station' }, lastCloneJumpAt: null, lastHomeStationChangeAt: null, cloneCount: 2, totalStoredImplants: 2, unmappedImplants: 0, clones: [{ row: 1, locationId: 60000001, locationType: 'station', implants: [implant, implant] }, { row: 2, locationId: 1000000000001, locationType: 'structure', implants: [] }] }, 'esi-clones.read_clones.v1'),
    implants: part({ implantCount: 1, unmappedImplants: 0, implants: [implant] }, 'esi-clones.read_implants.v1'),
  };
}
const render = result => renderToStaticMarkup(React.createElement(load().CloneAnalyticsResults, { result, openConnections: () => {} }));

test('clone chart and exact table agree, while active implants remain a separate source', () => {
  const html = render(fixture());
  assert.match(html, /Active implant entries<\/dt><dd>1<\/dd>/); assert.match(html, /Stored implant entries<\/dt><dd>2<\/dd>/);
  assert.match(html, /<span>Clone row 1<\/span>.*?<strong>2 <small>entries<\/small>/);
  assert.match(html, /<span>Clone row 2<\/span>.*?<strong>0 <small>entries<\/small>/);
  assert.match(html, /<th scope="row">Clone row 1<\/th><td>60000001<\/td><td>station<\/td><td>2<\/td>/);
  assert.match(html, /<th scope="row">Clone row 2<\/th><td>1000000000001<\/td><td>structure<\/td><td>0<\/td>/);
  assert.match(html, /does not combine these with active implants/); assert.match(html, /no bonuses, value or training rate is estimated/);
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
});

test('unknown home details and dates remain explicit without a derived next-jump timer', () => {
  const value = fixture(); value.clones.data.homeLocation = null;
  const html = render(value);
  assert.match(html, /Reported home location ID<\/dt><dd>Not reported<\/dd>/);
  assert.match(html, /Last reported clone jump<\/dt><dd[^>]*>Not reported<\/dd>/);
  assert.match(html, /Reported station-change date<\/dt><dd[^>]*>Not reported<\/dd>/);
  assert.match(html, /do not determine a next-jump time or available clone capacity/);
});

test('empty sources show reported emptiness, while a missing grant has no fabricated zero counts', () => {
  const value = fixture(); value.clones.data.clones = []; value.clones.data.cloneCount = 0; value.clones.data.totalStoredImplants = 0;
  value.implants.data.implants = []; value.implants.data.implantCount = 0;
  const html = render(value); assert.match(html, /No stored jump clones returned/); assert.match(html, /No active implants returned/);
  value.clones = { ...part(null, 'esi-clones.read_clones.v1'), status: 'needs_permission', retrievedAt: null, cacheExpires: null, freshness: 'unknown' };
  const denied = render(value); assert.match(denied, /Permission needed/); assert.match(denied, /Review access/); assert.doesNotMatch(denied, /Jump clones returned|Implant entries per stored jump clone/);
});

test('clone table renders at most twenty rows while chart keeps the bounded complete returned list', () => {
  const value = fixture(); value.clones.data.clones = Array.from({ length: 25 }, (_, i) => ({ row: i + 1, locationId: 60000001, locationType: 'station', implants: [] })); value.clones.data.cloneCount = 25; value.clones.data.totalStoredImplants = 0;
  const html = render(value);
  assert.equal((html.match(/<th scope="row">Clone row /g) ?? []).length, 20);
  assert.match(html, /rows 1–20 of 25/); assert.match(html, /<span>Clone row 25<\/span>/);
  assert.match(html, /<button class="small">Next clone rows<\/button>/);
});

test('public catalog labels are escaped, and unprojected clone text or identities are not rendered', () => {
  const value = fixture(); const malicious = { ...implant, name: '<img src="https://example.invalid/fixture" onerror="alert(1)">' };
  value.implants.data.implants = [malicious]; value.clones.data.clones[0].implants = [malicious, malicious];
  value.clones.data.clones[0].name = 'OMIT_PRIVATE_NAME'; value.clones.data.clones[0].jump_clone_id = 'OMIT_PRIVATE_ID';
  const html = render(value); assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img|<script|OMIT_PRIVATE/);
});

// Interaction unit harness: drives the component's own handlers and hook state.
// This tests request binding/clearing, not browser layout or React scheduling.
function interactions(fetch) {
  const values = [], effects = []; let cursor = 0;
  const react = { ...React, useState: initial => { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], next => { values[i] = typeof next === 'function' ? next(values[i]) : next; }]; }, useRef: initial => { const i = cursor++; if (!(i in values)) values[i] = { current: initial }; return values[i]; }, useEffect: effect => { const i = cursor++; if (!(i in values)) { values[i] = true; effects.push(effect()); } } };
  const components = load(react, fetch);
  const properties = { characters: [{ characterId, name: 'Synthetic character', corporationId: 98000001, scopes: [] }, { characterId: characterId + 1, name: 'Other synthetic character', corporationId: 98000002, scopes: [] }], openConnections: () => {} };
  return { render: () => { cursor = 0; return components.default(properties); }, cleanup: () => effects.forEach(fn => fn?.()), results: components.CloneAnalyticsResults };
}
function nodes(element) { if (!element || typeof element !== 'object') return []; return [element, ...React.Children.toArray(element.props?.children).flatMap(nodes)]; }
const find = (tree, predicate) => nodes(tree).find(predicate);
const label = element => React.Children.toArray(element.props?.children).filter(value => typeof value === 'string').join('');

test('changing character clears a loaded result; refresh and cancel cannot revive a stale response', async () => {
  const calls = [];
  const h = interactions((args, signal) => new Promise(resolve => calls.push({ args, signal, resolve })));
  const loadButton = tree => find(tree, node => node.type === 'button' && /^(Load|Refresh) clones$/.test(label(node)));
  loadButton(h.render()).props.onClick(); assert.equal(calls.length, 1); calls[0].resolve(fixture()); await new Promise(resolve => setImmediate(resolve));
  assert(find(h.render(), node => node.type === h.results));
  find(h.render(), node => node.type === 'select').props.onChange({ target: { value: String(characterId + 1) } });
  assert(!find(h.render(), node => node.type === h.results)); assert.equal(calls[0].signal.aborted, true);
  loadButton(h.render()).props.onClick(); assert.equal(calls[1].args.characterId, characterId + 1);
  find(h.render(), node => node.type === 'button' && label(node) === 'Cancel').props.onClick(); assert.equal(calls[1].signal.aborted, true);
  calls[1].resolve({ ...fixture(), characterId: characterId + 1 }); await new Promise(resolve => setImmediate(resolve));
  assert(!find(h.render(), node => node.type === h.results));
  loadButton(h.render()).props.onClick(); calls[2].resolve({ ...fixture(), characterId: characterId + 1 }); await new Promise(resolve => setImmediate(resolve));
  assert(find(h.render(), node => node.type === h.results));
  loadButton(h.render()).props.onClick(); assert(!find(h.render(), node => node.type === h.results)); assert.equal(calls[3].signal.aborted, false);
  h.cleanup(); assert.equal(calls[3].signal.aborted, true); calls[3].resolve(fixture()); await new Promise(resolve => setImmediate(resolve));
  assert(!find(h.render(), node => node.type === h.results));
});
