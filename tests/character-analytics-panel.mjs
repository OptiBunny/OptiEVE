import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

const code = ts.transpileModule(readFileSync('app/character-analytics-panel.tsx', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
class ConnectionResponseError extends Error { constructor(message, status = 0) { super(message); this.status = status; } }
function TrainingQueue({ queue }) { return React.createElement('div', { 'data-testid': 'training-queue' }, queue.entryCount); }
function SkillExplorer({ skills }) { return React.createElement('div', { 'data-testid': 'skill-explorer' }, skills.skillCount); }
const characterId = 90000001, stamp = '2026-01-01T12:00:00.000Z';
const characters = [{ characterId, name: 'Synthetic first', scopes: [] }, { characterId: characterId + 1, name: 'Synthetic second', scopes: [] }];
function fixture(overrides = {}) {
  const unavailable = scope => ({ scope, status: 'needs_permission', message: 'Synthetic permission needed.', retrievedAt: null, cacheExpires: null, freshness: 'unknown', data: null });
  return { characterId, generatedAt: stamp, status: 'partial', message: 'Synthetic training evidence.', skills: { scope: 'esi-skills.read_skills.v1', status: 'ready', message: 'Synthetic skill evidence.', retrievedAt: stamp, cacheExpires: '2026-01-02T12:00:00.000Z', freshness: 'fresh', data: { totalSp: 0, unallocatedSp: null, reportedSkillSp: 0, skillCount: 0, trainedSkillCount: 0, activeSkillCount: 0, reducedActiveSkillCount: 0, boostedActiveSkillCount: 0, groups: [], skills: [], levelDistribution: [0, 1, 2, 3, 4, 5].map(level => ({ level, trainedCount: 0, activeCount: 0 })) } }, attributes: unavailable('esi-skills.read_skills.v1'),
    queue: { scope: 'esi-skills.read_skillqueue.v1', status: 'ready', message: 'Synthetic queue.', retrievedAt: stamp, cacheExpires: '2026-01-02T12:00:00.000Z', freshness: 'fresh', data: { entryCount: 0, timedEntryCount: 0, passedFinishEntryCount: 0, nextPlannedFinishAt: null, lastPlannedFinishAt: null, entries: [], schedule: { asOf: overrides.generatedAt ?? stamp, elapsedEntries: 0, next24hEntries: 0, days2To7Entries: 0, days8To30Entries: 0, laterEntries: 0, missingFinishEntries: 0, daily: [] } } }, ...overrides };
}
function load(react = React, characterAnalyticsRequest = () => { throw Error('Initial rendering must not fetch'); }) {
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, AbortController, Date, require: name => {
    if (name === 'react') return react; if (name === 'react/jsx-runtime') return jsxRuntime;
    if (name === './lib/connection-client') return { ConnectionResponseError };
    if (name === './lib/analytics-client') return { characterAnalyticsRequest };
    if (name === './training-queue') return { default: TrainingQueue };
    if (name === './skill-explorer') return { default: SkillExplorer };
    if (name === './analytics-charts') return { CountBars: () => null };
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
const queue = tree => find(tree, node => node.type === TrainingQueue);
const explorer = tree => find(tree, node => node.type === SkillExplorer);
// Children.toArray escapes element keys; compare using the same public React representation.
const inspectedKey = value => React.Children.toArray([React.createElement(TrainingQueue, { key: value })])[0].key;
const settle = () => new Promise(resolve => setImmediate(resolve));

test('initial training panel performs no reads and explains manual selection', () => {
  const html = renderToStaticMarkup(React.createElement(load(), { characters, openConnections: () => {} }));
  assert.match(html, /Load training/); assert.match(html, /Choose a character/); assert.doesNotMatch(html, /data-testid="training-queue"/);
});

test('refresh unmounts prior skills and schedule and keys new results by owner and completion instant', async () => {
  const calls = [], h = interactions((args, signal) => new Promise(resolve => calls.push({ args, signal, resolve })));
  button(h.render(), 'Load training').props.onClick(); calls[0].resolve(fixture()); await settle();
  const firstKey = queue(h.render()).key; assert.equal(explorer(h.render()).key, firstKey); assert.equal(firstKey, inspectedKey(characterId + ':' + stamp));
  button(h.render(), 'Refresh training').props.onClick(); assert(!queue(h.render())); assert(!explorer(h.render())); assert.equal(calls[0].signal.aborted, true);
  const later = '2026-01-01T13:00:00.000Z'; calls[1].resolve(fixture({ generatedAt: later })); await settle();
  assert.equal(queue(h.render()).key, inspectedKey(characterId + ':' + later)); assert.notEqual(queue(h.render()).key, firstKey); assert.equal(explorer(h.render()).key, queue(h.render()).key); assert.equal(calls.length, 2);
});

test('owner changes cancel pending reads and suppress stale skill and schedule results', async () => {
  const calls = [], h = interactions((args, signal) => new Promise(resolve => calls.push({ args, signal, resolve })));
  button(h.render(), 'Load training').props.onClick(); calls[0].resolve(fixture()); await settle(); assert(queue(h.render())); assert(explorer(h.render()));
  find(h.render(), node => node.props?.id === 'training-character').props.onChange({ target: { value: String(characterId + 1) } });
  assert(!queue(h.render())); assert(!explorer(h.render())); assert.equal(calls[0].signal.aborted, true);
  button(h.render(), 'Load training').props.onClick(); assert.equal(calls[1].args.characterId, characterId + 1);
  find(h.render(), node => node.props?.id === 'training-character').props.onChange({ target: { value: String(characterId) } });
  calls[1].resolve(fixture({ characterId: characterId + 1 })); await settle(); assert(!queue(h.render())); assert(!explorer(h.render())); assert.equal(calls[1].signal.aborted, true);
});

test('cancel and unmount abort pending training reads without late skill or schedule display', async () => {
  const calls = [], h = interactions((args, signal) => new Promise(resolve => calls.push({ args, signal, resolve })));
  button(h.render(), 'Load training').props.onClick(); button(h.render(), 'Cancel').props.onClick();
  calls[0].resolve(fixture()); await settle(); assert.equal(calls[0].signal.aborted, true); assert(!queue(h.render())); assert(!explorer(h.render()));
  button(h.render(), 'Load training').props.onClick(); h.cleanup(); calls[1].resolve(fixture()); await settle();
  assert.equal(calls[1].signal.aborted, true); assert(!queue(h.render())); assert(!explorer(h.render()));
});

test('unavailable queue evidence never becomes an empty schedule chart', async () => {
  const value = fixture(); value.skills = { ...value.skills, status: 'needs_permission', message: 'Synthetic permission needed.', retrievedAt: null, cacheExpires: null, freshness: 'unknown', data: null }; value.queue = { ...value.skills, scope: 'esi-skills.read_skillqueue.v1' }; value.status = 'needs_permission';
  const h = interactions(async () => value); button(h.render(), 'Load training').props.onClick(); await settle();
  assert(!queue(h.render())); assert(!explorer(h.render())); const html = renderToStaticMarkup(h.render()); assert.match(html, /Synthetic permission needed/); assert.doesNotMatch(html, /data-testid="training-queue"/);
});

test('failed refresh clears skills and schedule and keeps sign-in recovery visible', async () => {
  let requests = 0; const h = interactions(async () => { if (!requests++) return fixture(); throw new ConnectionResponseError('Synthetic sign-in required.', 401); });
  button(h.render(), 'Load training').props.onClick(); await settle(); assert(queue(h.render()));
  button(h.render(), 'Refresh training').props.onClick(); await settle(); assert(!queue(h.render())); assert(!explorer(h.render()));
  assert(find(h.render(), node => node.type === 'a' && node.props.href === '/signin-with-chatgpt?return_to=%2F'));
});

test('unavailable skills never become zero-skill charts while available queue evidence remains visible', async () => {
  const value = fixture(); value.skills = { ...value.skills, status: 'error', data: null, message: 'Synthetic skills unavailable.' };
  const h = interactions(async () => value); button(h.render(), 'Load training').props.onClick(); await settle();
  assert(!explorer(h.render())); assert(queue(h.render())); const html = renderToStaticMarkup(h.render()); assert.match(html, /Synthetic skills unavailable/); assert.doesNotMatch(html, /data-testid="skill-explorer"/);
});

test('known empty skill evidence mounts the explorer and keeps source freshness visible', async () => {
  const h = interactions(async () => fixture()); button(h.render(), 'Load training').props.onClick(); await settle();
  assert.equal(explorer(h.render()).props.skills.skillCount, 0); const html = renderToStaticMarkup(h.render());
  assert.match(html, /data-testid="skill-explorer"/); assert.match(html, /Synthetic skill evidence/); assert.match(html, /Cache expiry/); assert.match(html, /2026-01-02 12:00:00 UTC/);
});
