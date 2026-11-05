import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

const compiled = ts.transpileModule(readFileSync('app/operations-charts.tsx', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports, require: name => {
  if (name === 'react') return React;
  if (name === 'react/jsx-runtime') return jsxRuntime;
  throw Error(`Unexpected chart import: ${name}`);
}, fetch: () => { throw Error('Charts must not make requests'); } });
const { RecordDonut, IndustryTimeline, JobEndDates, utcTime, jobStatusColors } = module.exports;
const render = (component, properties) => renderToStaticMarkup(React.createElement(component, properties));
const job = (jobId = 1001, extra = {}) => ({ jobId, activityId: 1, activityLabel: 'Manufacturing', status: 'active', blueprintTypeId: 10001, blueprintName: 'Synthetic blueprint', productTypeId: null, productName: null, runs: 1, startAt: '2026-01-01T00:00:00.000Z', endAt: '2026-01-03T00:00:00.000Z', durationSeconds: 172800, pauseAt: null, completedAt: null, ...extra });

test('record composition chart exposes the exact full category table when small categories are combined visually', () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ label: `Category ${index + 1}`, count: index + 1 }));
  const html = render(RecordDonut, { title: 'Inventory composition', unit: 'records', rows });
  assert.match(html, /<svg[^>]+role="img"[^>]+aria-labelledby=/);
  assert.match(html, /Remaining categories combined: 6 records/);
  assert.match(html, />55<\/text>/);
  assert.equal((html.match(/<th scope="row">Category /g) ?? []).length, 10);
  for (let index = 1; index <= 10; index++) assert(html.includes(`<th scope="row">Category ${index}</th><td>${index}</td>`));
  assert.match(html, /returned response only/);
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
});
test('known empty category counts render text and an exact table without a misleading nonzero donut', () => {
  for (const rows of [[], [{ label: 'Active', count: 0 }, { label: 'Ready', count: 0 }]]) {
    const html = render(RecordDonut, { title: 'Empty counts', unit: 'jobs', rows });
    assert.match(html, /No jobs returned in this response/); assert.doesNotMatch(html, /<svg|NaN|Infinity/);
  }
});
test('public category and blueprint labels remain escaped text in SVG titles, legends and tables', () => {
  const malicious = '<img src="https://example.invalid/fixture" onerror="globalThis.fixtureExecuted=true">';
  for (const html of [render(RecordDonut, { title: 'Safe labels', unit: 'records', rows: [{ label: malicious, count: 1 }] }), render(IndustryTimeline, { jobs: [job(1001, { blueprintName: malicious })], generatedAt: '2026-01-02T00:00:00.000Z' })]) {
    assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img|<script/);
  }
});
test('industry timeline is capped at twenty displayed jobs and keeps later outliers out of its axis', () => {
  const jobs = Array.from({ length: 20 }, (_, index) => job(index + 1)); jobs.push(job(9999, { endAt: '2099-01-01T00:00:00.000Z' }));
  const html = render(IndustryTimeline, { jobs, generatedAt: '2026-01-02T00:00:00.000Z' });
  assert.match(html, /First 20 matching jobs/); assert.equal((html.match(/<rect /g) ?? []).length, 20);
  assert.doesNotMatch(html, /2099|Job 9999/); assert.match(html, /<title>Load time<\/title>/);
  assert.match(html, /not a live clock/); assert.match(html, /does not confirm completion or delivery/);
});
test('timeline omits a load marker outside its range and handles an observed zero-duration interval safely', () => {
  const zero = job(1001, { endAt: '2026-01-01T00:00:00.000Z', durationSeconds: 0 });
  for (const loaded of ['2025-12-31T00:00:00.000Z', '2026-01-02T00:00:00.000Z']) {
    const html = render(IndustryTimeline, { jobs: [zero], generatedAt: loaded });
    assert.doesNotMatch(html, /<title>Load time<\/title>|NaN|Infinity/); assert.match(html, /<rect[^>]+width="1"/);
  }
});
test('empty filtered timeline provides an explicit empty state without invalid SVG coordinates', () => {
  const html = render(IndustryTimeline, { jobs: [], generatedAt: '2026-01-02T00:00:00.000Z' });
  assert.match(html, /No matching jobs to chart/); assert.doesNotMatch(html, /<svg|NaN|Infinity/);
});
test('timeline colors preserve the reported status without converting past active jobs to ready', () => {
  const jobs = [job(1), job(2, { status: 'paused' }), job(3, { status: 'ready' })];
  const html = render(IndustryTimeline, { jobs, generatedAt: '2026-01-04T00:00:00.000Z' });
  for (const status of ['active', 'paused', 'ready']) assert(html.includes(`fill="${jobStatusColors[status]}"`));
  assert.match(html, /Job 1: Synthetic blueprint; active;/);
  assert.doesNotMatch(html, /Job 1: Synthetic blueprint; ready;/);
});
test('active-job end dates preserve real UTC spacing and omit unreported days from the exact table', () => {
  const jobs = [job(1, { endAt: '2026-01-01T23:00:00.000Z' }), job(2, { endAt: '2026-01-01T10:00:00.000Z' }), job(3, { endAt: '2026-01-03T00:00:00.000Z' }), job(4, { endAt: '2026-01-10T00:00:00.000Z' })];
  const html = render(JobEndDates, { jobs });
  assert.match(html, /<th scope="row">2026-01-01<\/th><td>2<\/td>/);
  assert.match(html, /<th scope="row">2026-01-03<\/th><td>1<\/td>/);
  assert.match(html, /<th scope="row">2026-01-10<\/th><td>1<\/td>/);
  assert.doesNotMatch(html, /2026-01-02/);
  const x = [...html.matchAll(/<rect x="([^"]+)"/g)].map(match => Number(match[1]));
  assert.equal(x.length, 3); assert(Math.abs((x[2] - x[1]) / (x[1] - x[0]) - 3.5) < 0.00001);
  assert.match(html, /do not guarantee completion/); assert.match(html, /Missing dates are omitted/);
});
test('empty active-job chart and timestamp formatter preserve unknowns', () => {
  const html = render(JobEndDates, { jobs: [] });
  assert.match(html, /No active jobs returned/); assert.doesNotMatch(html, /<svg|NaN|Infinity/);
  assert.equal(utcTime(null), 'Not reported'); assert.equal(utcTime('2026-01-01T02:00:00+01:00'), '2026-01-01 01:00:00.000 UTC');
});
test('representative charts emit no React SVG title or accessibility rendering warnings', () => {
  const previous = console.error, messages = []; console.error = (...values) => messages.push(values.join(' '));
  try {
    render(RecordDonut, { title: 'Category counts', unit: 'records', rows: [{ label: 'Synthetic category', count: 4 }] });
    render(IndustryTimeline, { jobs: [job()], generatedAt: '2026-01-02T00:00:00.000Z' });
    render(JobEndDates, { jobs: [job()] });
  } finally { console.error = previous; }
  assert.deepEqual(messages, []);
});
