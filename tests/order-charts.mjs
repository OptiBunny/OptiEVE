import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
const code = ts.transpileModule(readFileSync('app/order-charts.tsx', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports, Date, require: name => name === 'react' ? React : jsx });
const render = orders => renderToStaticMarkup(React.createElement(mod.exports.OrderExpiryChart, { orders }));
test('expiry chart has accessible chart and exact-value regions with real UTC spacing', () => {
  const html = render([{ expiresAt: '2026-01-01T00:00:00.000Z' }, { expiresAt: '2026-01-01T12:00:00.000Z' }, { expiresAt: '2026-01-04T00:00:00.000Z' }]);
  assert.match(html, /role="img" aria-labelledby=/); assert.match(html, /aria-label="Reported order expiry chart"/); assert.match(html, /aria-label="Order expiry-date values"/); assert.match(html, /2026-01-01: 2 orders/); assert.match(html, /2026-01-04: 1 orders/);
  const xs = [...html.matchAll(/<rect[^>]* x="([\d.]+)"/g)].map(match => Number(match[1])); assert.equal(xs.length, 2); assert(Math.abs(xs[1] - xs[0] - 465) < .01); assert(!html.includes('2026-01-02:'));
});
test('empty chart gives explicit empty state without NaN or fabricated bars', () => { const html = render([]); assert.match(html, /No included orders to chart/); assert(!html.includes('NaN')); assert(!html.includes('<rect')); });
test('single expiry date and wide spans produce finite positive geometry', () => {
  for (const orders of [[{ expiresAt: '2026-01-01T00:00:00.000Z' }], [{ expiresAt: '2000-01-01T00:00:00.000Z' }, { expiresAt: '2099-01-01T00:00:00.000Z' }]]) { const html = render(orders); assert(!html.includes('NaN')); assert(!html.includes('Infinity')); for (const match of html.matchAll(/<rect[^>]* width="([\d.]+)" height="([\d.]+)"/g)) { assert(Number(match[1]) >= 1); assert(Number(match[2]) > 0); } }
});
