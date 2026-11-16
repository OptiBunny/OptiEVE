import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { z } from 'zod';

const compile = file => ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const analytics = { exports: {} }, chart = { exports: {} };
vm.runInNewContext(compile('app/lib/analytics-client.ts'), { module: analytics, exports: analytics.exports, require: name => name === 'zod' ? { z } : {} });
vm.runInNewContext(compile('app/wallet-net-chart.tsx'), { module: chart, exports: chart.exports, fetch: () => { throw Error('Chart must not fetch'); }, require: name => name === 'react' ? React : name === 'react/jsx-runtime' ? jsxRuntime : analytics.exports });
const row = (date, net, missing = net === null ? 1 : 0) => ({ date, entries: (net === null ? 0 : 1) + missing, amountEntries: net === null ? 0 : 1, missingAmountEntries: missing, totals: net === null ? null : { incomingISK: net.startsWith('-') ? '0' : net, outgoingISK: net.startsWith('-') ? net.slice(1) : '0', netISK: net } });
const render = daily => renderToStaticMarkup(React.createElement(chart.exports.default, { daily }));
const bars = html => [...html.matchAll(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)"/g)].map(match => ({ x: Number(match[1]), width: Number(match[3]) }));

test('positive and negative net use one exact shared magnitude scale around zero', () => {
  const html = render([row('2026-01-01', '-50.00'), row('2026-01-03', '100.00')]);
  assert.deepEqual(bars(html), [{ x: 315, width: 115 }, { x: 430, width: 230 }]);
  assert(html.includes('<th scope="row">2026-01-01</th><td>-50.00</td>')); assert(html.includes('<th scope="row">2026-01-03</th><td>+100.00</td>'));
  assert.match(html, /Shared scale magnitude: 100.00 ISK/); assert.doesNotMatch(html, /2026-01-02|NaN|Infinity|undefined/);
  assert.match(html, /not profit, wallet balance or a cumulative balance/); assert.match(html, /<svg[^>]+role="img"[^>]+aria-labelledby=/);
});

test('huge close decimal amounts retain their exact strings and correct scale ordering', () => {
  const html = render([row('2026-01-01', '-9007199254740991.0000001'), row('2026-01-02', '9007199254740991.0000002')]);
  assert.match(html, /Shared scale magnitude: 9,007,199,254,740,991.0000002 ISK/);
  assert(html.includes('<td>-9,007,199,254,740,991.0000001</td>')); assert(html.includes('<td>+9,007,199,254,740,991.0000002</td>'));
  const geometry = bars(html); assert(geometry[0].width < geometry[1].width); assert.equal(geometry[1].width, 230); assert.equal(geometry[0].x + geometry[0].width, 430);
});

test('subnormal-scale nonzero observations stay visible without becoming a zero or changing exact labels', () => {
  const tiny = '0.' + '0'.repeat(323) + '5';
  const html = render([row('2026-01-01', tiny), row('2026-01-02', '-' + tiny), row('2026-01-03', '1.00')]);
  assert.deepEqual(bars(html).slice(0, 2), [{ x: 430, width: 1 }, { x: 429, width: 1 }]);
  assert(html.includes('<td>+' + tiny + '</td>')); assert(html.includes('<td>-' + tiny + '</td>'));
  assert.match(html, /minimum-width marker/); assert.doesNotMatch(html, /<circle|NaN|Infinity/);
});

test('signed zero is a neutral marker and does not imply an absence of transactions', () => {
  const html = render([row('2026-01-01', '-0.00'), row('2026-01-02', '0.000')]);
  assert.equal(bars(html).length, 0); assert.equal((html.match(/<circle cx="430"/g) ?? []).length, 2);
  assert(html.includes('<td>0.00</td>')); assert(html.includes('<td>0.000</td>')); assert.doesNotMatch(html, /-0.00|\+0.000|NaN|Infinity/);
  assert.match(html, /does not mean no transactions/);
});

test('unknown amounts have no bar while partial known net preserves its value and missing count', () => {
  const html = render([row('2026-01-01', null, 3), row('2026-01-02', '-5.25', 2), row('2026-01-03', '0.00', 1)]);
  assert.equal(bars(html).length, 1); assert.equal((html.match(/<circle /g) ?? []).length, 1);
  assert(html.includes('<th scope="row">2026-01-01</th><td>Unknown</td><td>No reported amounts</td><td>3 / 3</td>'));
  assert(html.includes('<th scope="row">2026-01-02</th><td>-5.25</td><td>Partial reported amounts</td><td>3 / 2</td>'));
  assert(html.includes('<th scope="row">2026-01-03</th><td>0.00</td><td>Partial reported amounts</td><td>2 / 1</td>'));
});

test('all-unknown and empty observations do not manufacture known zero observations', () => {
  const html = render([row('2026-01-01', null), row('2026-01-02', null)]);
  assert.equal(bars(html).length, 0); assert.doesNotMatch(html, /<circle|<td>0(?:\.0+)?<\/td>|NaN|Infinity/);
  assert.match(html, /no net scale is available/); assert.doesNotMatch(html, /Shared scale magnitude/);
  const empty = render([]); assert.match(empty, /No returned daily observations to chart/); assert.doesNotMatch(empty, /<svg|NaN|Infinity/);
});

test('latest30 cap is explicit and omitted outliers cannot distort the displayed scale', () => {
  const daily = Array.from({ length: 31 }, (_, index) => row('2026-01-' + String(index + 1).padStart(2, '0'), index === 0 ? '1000000' : '1.00'));
  const original = structuredClone(daily), html = render(daily);
  assert.match(html, /Showing 30 of 31 returned UTC dates/); assert.match(html, /not a complete 30-day period/);
  assert.match(html, /Shared scale magnitude: 1.00 ISK/); assert.doesNotMatch(html, /2026-01-01|1,000,000/);
  assert.equal(bars(html).length, 30); assert.equal((html.match(/<th scope="row">/g) ?? []).length, 30);
  assert.match(html, /Full-page totals and the incoming\/outgoing tables cover all returned dates/); assert.deepEqual(daily, original);
});

test('chart labels are escaped and generated figures have no React warnings', () => {
  const prior = console.error, warnings = []; console.error = (...values) => warnings.push(values.join(' '));
  try { const html = render([row('<img src="https://example.invalid/synthetic" onerror="alert(1)">', '1')]); assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img|<script/); }
  finally { console.error = prior; }
  assert.deepEqual(warnings, []);
});
