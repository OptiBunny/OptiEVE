import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

const compiled = ts.transpileModule(readFileSync('app/mining-chart.tsx', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports, require: name => {
  if (name === 'react') return React;
  if (name === 'react/jsx-runtime') return jsxRuntime;
  if (name === './lib/character-workspace-client') return { characterPublicName: (result, key, id) => result.labels?.names.find(item => item.id === id && key === 'type' && item.category === 'inventory_type')?.name };
  throw Error(`Unexpected module: ${name}`);
} });
const { miningChartDays, default: MiningChart } = module.exports;
const row = (date, type, system, quantity) => ({ id: `${date}-${type}-${system}`, cells: { date, type, system, quantity } });
const plain = value => JSON.parse(JSON.stringify(value));
const rows = [row('2026-01-03', 1001, 2001, 10), row('2026-01-01', 1001, 2001, 4), row('2026-01-03', 1001, 2002, 20), row('2026-01-02', 1002, 2001, 900)];
const fixture = () => ({ view: 'mining', characterId: 90000001, generatedAt: '2026-01-04T00:00:00Z', status: 'partial', coverage: 'partial', message: 'Synthetic mining data.', scope: 'esi-industry.read_character_mining.v1', retrievedAt: null, cacheExpires: null, metrics: [], columns: [], rows, next: { characterId: 90000001, view: 'mining', page: 2 } });

test('mining chart groups the selected material across displayed systems and preserves missing dates', () => {
  assert.deepEqual(plain(miningChartDays(rows, 1001)), [{ date: '2026-01-01', quantity: 4, records: 1 }, { date: '2026-01-03', quantity: 30, records: 2 }]);
  assert.deepEqual(plain(miningChartDays(rows, 1002)), [{ date: '2026-01-02', quantity: 900, records: 1 }]);
  assert.deepEqual(plain(miningChartDays(rows, 9999)), []);
});

test('mining chart retains a genuine reported zero without inventing empty dates', () => {
  assert.deepEqual(plain(miningChartDays([row('2026-01-01', 1001, 2001, 0)], 1001)), [{ date: '2026-01-01', quantity: 0, records: 1 }]);
});

test('mining chart rejects duplicate records and quantities beyond exact integer arithmetic', () => {
  assert.equal(miningChartDays([rows[0], rows[0]], 1001), null);
  assert.equal(miningChartDays([row('2026-01-01', 1001, 2001, Number.MAX_SAFE_INTEGER), row('2026-01-01', 1001, 2002, 1)], 1001), null);
  assert.equal(miningChartDays([row('2026-01-01', 1001, 2001, Number.MAX_SAFE_INTEGER + 1)], 1001), null);
});

test('mining chart rejects malformed dates, negative quantities and excess displayed records', () => {
  for (const invalid of [row('2026-02-30', 1001, 2001, 1), row('2026-01-01T00:00:00Z', 1001, 2001, 1), row('2026-01-01', 1001, 2001, -1), row('2026-01-01', 1001, 2001, 0.5), row('2026-01-01', 1001, 0, 1)]) assert.equal(miningChartDays([invalid], 1001), null);
  assert.equal(miningChartDays(Array.from({ length: 101 }, (_, index) => row('2026-01-01', 1001, 2001 + index, 1)), 1001), null);
  assert.equal(miningChartDays(rows, 0), null);
});

test('mining chart provides material selection, an accessible SVG and exact table alternative', () => {
  const html = renderToStaticMarkup(React.createElement(MiningChart, { result: fixture() }));
  assert.match(html, /<select[^>]+id=/);
  assert.match(html, /<svg[^>]+role="img"[^>]+aria-labelledby=/);
  assert.match(html, /Reported mining quantities for Type 1001/);
  assert.match(html, /<summary>Chart values/);
  assert.match(html, /<th scope="row">2026-01-03<\/th><td>30<\/td><td>2<\/td>/);
  assert.match(html, /Other batches and pages are excluded/);
  assert.match(html, /unknown, not zero/);
  assert.doesNotMatch(html, /<td>900<\/td>|fetch\(|localStorage|sessionStorage/);
});

test('mining chart escapes opt-in public material labels as text', () => {
  const result = fixture();
  result.labels = { names: [{ id: 1001, category: 'inventory_type', name: '<img src="https://example.invalid/pixel">' }] };
  const html = renderToStaticMarkup(React.createElement(MiningChart, { result }));
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
});

test('mining chart renders explicit unavailable output on unsafe aggregation', () => {
  const result = fixture(); result.rows = [row('2026-01-01', 1001, 2001, Number.MAX_SAFE_INTEGER), row('2026-01-01', 1001, 2002, 1)];
  const html = renderToStaticMarkup(React.createElement(MiningChart, { result }));
  assert.match(html, /A reliable chart is unavailable/);
  assert.doesNotMatch(html, /<svg/);
});

test('mining chart does not render a graph for unavailable or non-mining data', () => {
  for (const result of [{ ...fixture(), rows: [] }, { ...fixture(), status: 'error' }, { ...fixture(), view: 'blueprints' }]) assert.equal(renderToStaticMarkup(React.createElement(MiningChart, { result })), '');
});
