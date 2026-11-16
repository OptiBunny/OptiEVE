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
const code = compile('app/training-queue.tsx'), chartsCode = compile('app/analytics-charts.tsx'), clientCode = compile('app/lib/analytics-client.ts');
const analytics = { exports: {} }, charts = { exports: {} };
vm.runInNewContext(clientCode, { module: analytics, exports: analytics.exports, require: name => name === 'zod' ? { z } : {} });
vm.runInNewContext(chartsCode, { module: charts, exports: charts.exports, require: name => name === 'react' ? React : name === 'react/jsx-runtime' ? jsxRuntime : analytics.exports });
function load(react = React) {
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Date, require: name => name === 'react' ? react : name === 'react/jsx-runtime' ? jsxRuntime : charts.exports, fetch: () => { throw Error('Local queue controls must not fetch'); } });
  return module.exports;
}
const asOf = '2026-01-01T12:00:00.000Z';
const finishes = ['2026-01-01T12:00:00.000Z', '2026-01-01T13:00:00.000Z', '2026-01-02T12:00:00.000Z', '2026-01-02T12:00:00.001Z', '2026-01-08T12:00:00.000Z', '2026-01-08T12:00:00.001Z', '2026-01-31T12:00:00.000Z', '2026-01-31T12:00:00.001Z', null, '2026-01-02T00:30:00+02:00'];
function fixture() {
  return { entryCount: 10, timedEntryCount: 9, passedFinishEntryCount: 1, nextPlannedFinishAt: finishes[1], lastPlannedFinishAt: finishes[7],
    entries: finishes.map((finishAt, position) => ({ position, typeId: 1001 + position, name: 'Synthetic skill ' + position, finishedLevel: 1, startAt: '2026-01-01T00:00:00.000Z', finishAt, levelStartSp: null, levelEndSp: null, trainingStartSp: null })),
    schedule: { asOf, elapsedEntries: 1, next24hEntries: 3, days2To7Entries: 2, days8To30Entries: 2, laterEntries: 1, missingFinishEntries: 1, daily: [{ date: '2026-01-01', entries: 2 }, { date: '2026-01-02', entries: 2 }, { date: '2026-01-08', entries: 2 }, { date: '2026-01-31', entries: 1 }] },
  };
}
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
const nodes = element => !element || typeof element !== 'object' ? [] : [element, ...React.Children.toArray(element.props?.children).flatMap(nodes)];
const find = (tree, predicate) => nodes(tree).find(predicate);
const text = element => React.Children.toArray(element.props?.children).filter(value => typeof value === 'string').join('');
const button = (tree, label) => find(tree, node => node.type === 'button' && text(node) === label);
function interactions(queue = fixture()) {
  const values = []; let cursor = 0;
  const react = { ...React, useId: () => 'synthetic-training', useState: initial => { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], next => { values[i] = typeof next === 'function' ? next(values[i]) : next; }]; } };
  const components = load(react);
  const tree = () => { cursor = 0; return components.default({ queue }); };
  return { render: tree, timeline: () => find(tree(), node => node.type === charts.exports.QueueTimeline).props.entries, chart: () => find(tree(), node => node.type === components.TrainingFinishChart), select: (suffix, value) => find(tree(), node => node.props?.id === 'synthetic-training-' + suffix).props.onChange({ target: { value } }) };
}

test('daily chart and exact table agree while preserving actual UTC gaps', () => {
  const schedule = fixture().schedule;
  const html = render(load().TrainingFinishChart, { schedule, selectDay: () => {} });
  for (const [date, count] of [['2026-01-01', 2], ['2026-01-02', 2], ['2026-01-08', 2], ['2026-01-31', 1]]) assert(html.includes('<th scope="row">' + date + '</th><td>' + count + '</td>'));
  const positions = [...html.matchAll(/<rect x="([^"]+)"/g)].map(match => Number(match[1]));
  assert.equal(positions.length, 4); assert(Math.abs((positions[2] - positions[1]) / (positions[1] - positions[0]) - 6) < 0.00001);
  assert.doesNotMatch(html, /<th scope="row">2026-01-03|NaN|Infinity|undefined/);
  assert.match(html, /first and last UTC days can be partial/); assert.match(html, /not confirmed completions/); assert.match(html, /<svg[^>]+role="img"[^>]+aria-labelledby=/);
  assert.match(html, /After 2026-01-01 12:00:00 UTC through 2026-01-31 12:00:00 UTC/);
});

test('offset assessment timestamps are normalized before drawing the first UTC axis day', () => {
  const schedule = { ...fixture().schedule, asOf: '2026-01-01T23:30:00-02:00', daily: [{ date: '2026-01-02', entries: 1 }] };
  const html = render(load().TrainingFinishChart, { schedule, selectDay: () => {} });
  assert(html.includes('>2026-01-02</text>')); assert(!html.includes('>2026-01-01</text>'));
  assert.match(html, /After 2026-01-02 01:30:00 UTC through 2026-02-01 01:30:00 UTC/);
});

test('empty daily evidence remains separate from missing and later queue dates', () => {
  const queue = fixture(); queue.entries = [queue.entries[7], queue.entries[8]]; Object.assign(queue, { entryCount: 2, timedEntryCount: 1, passedFinishEntryCount: 0, nextPlannedFinishAt: finishes[7] });
  Object.assign(queue.schedule, { elapsedEntries: 0, next24hEntries: 0, days2To7Entries: 0, days8To30Entries: 0, laterEntries: 1, missingFinishEntries: 1, daily: [] });
  const html = render(load().default, { queue });
  assert.match(html, /No reported future finish dates in the next 30 days/); assert.match(html, /No reported finish date/);
  assert.match(html, /absent dates do not establish a paused or empty queue/); assert.doesNotMatch(html, /NaN|Infinity|undefined/);
});

test('disjoint schedule filters respect every exact rolling boundary', () => {
  const h = interactions();
  for (const [bucket, positions] of [['elapsed', [0]], ['next24h', [1, 2, 9]], ['days2to7', [3, 4]], ['days8to30', [5, 6]], ['later', [7]], ['missing', [8]], ['next30d', [1, 2, 3, 4, 5, 6, 9]]]) {
    h.select('bucket', bucket); assert.deepEqual(Array.from(h.timeline(), row => row.position), positions);
  }
});

test('chart date drill-down excludes elapsed and beyond-window entries sharing the boundary day', () => {
  const h = interactions(); h.select('query', 'No matching synthetic skill');
  h.chart().props.selectDay('2026-01-01');
  assert.deepEqual(Array.from(h.timeline(), row => row.position), [1, 9]);
  assert.equal(find(h.render(), node => node.props?.id === 'synthetic-training-query').props.value, '');
  h.chart().props.selectDay('2026-01-31'); assert.deepEqual(Array.from(h.timeline(), row => row.position), [6]);
  assert.deepEqual(h.chart().props.schedule.daily.map(row => row.entries), [2, 2, 2, 1]);
  h.select('bucket', 'elapsed'); assert.equal(find(h.render(), node => node.props?.id === 'synthetic-training-date').props.value, '');
  assert.deepEqual(Array.from(h.timeline(), row => row.position), [0]);
});

test('exact chart table buttons expose accessible date selection without initiating reads', () => {
  const selected = [], components = load({ ...React, useId: () => 'synthetic-chart' });
  const tree = components.TrainingFinishChart({ schedule: fixture().schedule, selectDay: value => selected.push(value) });
  const controls = nodes(tree).filter(node => node.type === 'button'); assert.equal(controls.length, 4);
  assert.equal(controls[0].props['aria-label'], 'Show queue entries scheduled on 2026-01-01'); controls[0].props.onClick(); assert.deepEqual(selected, ['2026-01-01']);
});

test('large queues page at100rows, limit the rendered timeline to20, and reset pagination on filter changes', () => {
  const queue = fixture(); queue.entries = Array.from({ length: 205 }, (_, position) => ({ ...queue.entries[1], position, typeId: 2000 + position, name: 'Synthetic batch skill ' + position }));
  Object.assign(queue, { entryCount: 205, timedEntryCount: 205, passedFinishEntryCount: 0, nextPlannedFinishAt: finishes[1], lastPlannedFinishAt: finishes[1] }); Object.assign(queue.schedule, { elapsedEntries: 0, next24hEntries: 205, days2To7Entries: 0, days8To30Entries: 0, laterEntries: 0, missingFinishEntries: 0, daily: [{ date: '2026-01-01', entries: 205 }] });
  const h = interactions(queue), rows = () => React.Children.toArray(find(h.render(), node => node.type === 'tbody').props.children);
  assert.equal(rows().length, 100); assert.match(renderToStaticMarkup(h.render()), /Timeline shows the first 20/);
  const html = renderToStaticMarkup(h.render()); assert.equal((html.match(/<rect /g) ?? []).length, 21);
  button(h.render(), 'Next 100 queue entries').props.onClick(); assert.equal(rows().length, 100);
  button(h.render(), 'Next 100 queue entries').props.onClick(); assert.equal(rows().length, 5); assert.equal(button(h.render(), 'Next 100 queue entries').props.disabled, true);
  h.select('query', '2204'); assert.equal(rows().length, 1); assert.equal(button(h.render(), 'Previous 100 queue entries').props.disabled, true);
  h.select('query', 'does not exist'); assert.equal(rows().length, 0); assert.match(renderToStaticMarkup(h.render()), /No returned queue entries match these filters/);
  assert.equal(h.chart().props.schedule.next24hEntries, 205);
  h.select('bucket', 'missing'); assert.equal(button(h.render(), 'Previous 100 queue entries').props.disabled, true);
});

test('skill text is escaped throughout table and timeline rather than treated as markup', () => {
  const queue = fixture(); queue.entries[0].name = '<img src="https://example.invalid/fixture" onerror="alert(1)">';
  const html = render(load().default, { queue }); assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img|<script/);
});

test('new result mounts reset local query and schedule selections', () => {
  const old = interactions(); old.select('bucket', 'missing'); old.select('query', 'no match'); assert.equal(old.timeline().length, 0);
  const refreshed = interactions(); assert.equal(refreshed.timeline().length, 10); assert.equal(find(refreshed.render(), node => node.props?.id === 'synthetic-training-bucket').props.value, 'all');
});
