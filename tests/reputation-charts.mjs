import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name).exports;
  const source = readFileSync(`app/${name}.tsx`, 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} }; modules.set(name, module);
  vm.runInNewContext(code, { module, exports: module.exports, require: spec => {
    if (spec === 'react') return React;
    if (spec === 'react/jsx-runtime') return jsx;
    if (spec === './lib/analytics-client') return { decimalMaximum: () => { throw Error('Unexpected cash-flow operation'); }, decimalWidth: () => { throw Error('Unexpected cash-flow operation'); }, formatISK: () => { throw Error('Unexpected valuation'); } };
    if (['./analytics-charts', './operations-charts'].includes(spec)) return load(spec.slice(2));
    throw Error(`Unexpected module: ${spec}`);
  } });
  return module.exports;
}
const { reputationChartData, default: ReputationCharts } = load('reputation-charts');
const plain = value => JSON.parse(JSON.stringify(value));
const standing = (sourceId, value, kind = 'Faction') => ({ id: `${kind}-${sourceId}`, cells: { sourceId, standing: value, kind } });
const loyalty = (corporationId, points) => ({ id: String(corporationId), cells: { corporationId, points } });
const periods = ['yesterday', 'last_week', 'total'], labels = ['Yesterday', 'Last week', 'Reported total'];
const warfare = (kills = [2, 7, 11], points = [5, 15, 40]) => periods.map((id, index) => ({ id, cells: { period: labels[index], kills: kills[index], victoryPoints: points[index] } }));
const fixture = (view, rows, extra = {}) => ({ view, characterId: 90000001, generatedAt: '2026-01-01T00:00:00Z', status: 'partial', coverage: 'partial', message: 'Synthetic response.', scope: 'synthetic-read-scope', retrievedAt: null, cacheExpires: null, metrics: [{ label: 'Full response count', value: 9876 }], columns: [], rows, next: null, ...extra });
const render = result => renderToStaticMarkup(React.createElement(ReputationCharts, { result }));

test('standing charts preserve signs, exact fractions and deterministic absolute-value ranking', () => {
  const result = fixture('standings', [standing(90003, -2.5, 'Agent'), standing(90001, 2.5), standing(90002, 0, 'NPC corporation'), standing(90004, -10, 'Agent'), standing(90005, 10, 'NPC corporation')]);
  const before = JSON.stringify(result);
  const data = plain(reputationChartData(result));
  assert.deepEqual(data.rows, [
    { sourceId: 90005, kind: 'NPC corporation', standing: 10 },
    { sourceId: 90004, kind: 'Agent', standing: -10 },
    { sourceId: 90001, kind: 'Faction', standing: 2.5 },
    { sourceId: 90003, kind: 'Agent', standing: -2.5 },
    { sourceId: 90002, kind: 'NPC corporation', standing: 0 },
  ]);
  assert.deepEqual(data.signs, [{ label: 'Positive', count: 2 }, { label: 'Zero', count: 1 }, { label: 'Negative', count: 2 }]);
  assert.equal(JSON.stringify(result), before);
  const html = render(result); assert.match(html, /only the 5 rows displayed in this batch/); assert.doesNotMatch(html, /9876/);
});

test('standing SVG uses a fixed signed scale, a visible zero axis and exact labels', () => {
  const html = render(fixture('standings', [-10, -5, 0, 5, 10].map((value, index) => standing(90001 + index, value))));
  const bars = [...html.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="26"/g)].map(match => [Number(match[1]), Number(match[2])]);
  assert.deepEqual(bars, [[260, 260], [520, 260], [390, 130], [520, 130], [520, 0]]);
  assert.match(html, /<line x1="520" x2="520"[^>]*stroke="#e6f3ff"/);
  assert.match(html, /<svg[^>]*role="img"[^>]*aria-labelledby=/);
  assert.match(html, /aria-label="Signed standings chart"/);
  for (const text of ['Faction 90001: -10', 'Faction 90004: +5', 'Faction 90003: 0']) assert(html.includes(text));
  assert.match(html, /The table below contains every displayed row/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test('standings limit ranked bars to twelve while the composition covers every displayed row', () => {
  const rows = Array.from({ length: 13 }, (_, index) => standing(90001 + index, index - 6));
  const html = render(fixture('standings', rows));
  assert.equal([...html.matchAll(/<rect /g)].length, 12);
  assert.match(html, /Showing 12 of 13 displayed standings/);
  assert.match(html, /only the 13 rows displayed in this batch/);
  assert.doesNotMatch(html, /Faction 90007: 0/);
  assert.deepEqual(plain(reputationChartData(fixture('standings', rows)).signs), [{ label: 'Positive', count: 6 }, { label: 'Zero', count: 1 }, { label: 'Negative', count: 6 }]);
});

test('standing batch validation refuses duplicates, invalid kinds, nonfinite and out-of-range values', () => {
  for (const rows of [
    [standing(90001, 1), standing(90001, 2, 'Agent')], [standing(0, 1)], [standing(90001, 10.1)], [standing(90001, -10.1)],
    [standing(90001, NaN)], [standing(90001, Infinity)], [standing(90001, '1')], [standing(90001, null)], [standing(90001, 1, '<script>alert(1)</script>')],
    Array.from({ length: 101 }, (_, index) => standing(90001 + index, 1)),
  ]) {
    const result = fixture('standings', rows); assert.equal(reputationChartData(result), null);
    const html = render(result); assert.match(html, /Reliable reputation charts are unavailable/); assert.doesNotMatch(html, /<svg|<script|alert\(1\)/);
  }
});

test('loyalty balances stay separate, preserve zero, and use stable ID ties without totals or valuation', () => {
  const result = fixture('loyalty_points', [loyalty(1003, 9), loyalty(1001, 17), loyalty(1002, 17), loyalty(1004, 0)]);
  const data = plain(reputationChartData(result));
  assert.deepEqual(data.rows, [{ corporationId: 1001, points: 17 }, { corporationId: 1002, points: 17 }, { corporationId: 1003, points: 9 }, { corporationId: 1004, points: 0 }]);
  assert.deepEqual(Object.keys(data).sort(), ['rows', 'view']);
  const html = render(result);
  assert.match(html, /NPC corporation 1001/); assert.match(html, /0 <small>LP/);
  assert.match(html, /LP is not added across corporations or converted to ISK/);
  assert.doesNotMatch(html, /43 <small>LP|9876|ISK value|net worth/);
});

test('loyalty top twelve never silently combines the remaining balances', () => {
  const html = render(fixture('loyalty_points', Array.from({ length: 13 }, (_, index) => loyalty(1001 + index, index + 1))));
  assert.match(html, /Largest 12 separate balances among the 13 corporations displayed/);
  assert.match(html, /NPC corporation 1013/); assert.doesNotMatch(html, /NPC corporation 1001|Remaining categories combined/);
  assert.equal([...html.matchAll(/class="analytics-bar-row"/g)].length, 12);
});

test('large valid LP balances remain individual safe values rather than overflowing an aggregate', () => {
  const result = fixture('loyalty_points', [loyalty(1001, Number.MAX_SAFE_INTEGER), loyalty(1002, Number.MAX_SAFE_INTEGER)]);
  assert.deepEqual(plain(reputationChartData(result).rows), [{ corporationId: 1001, points: Number.MAX_SAFE_INTEGER }, { corporationId: 1002, points: Number.MAX_SAFE_INTEGER }]);
  const html = render(result); assert.equal([...html.matchAll(/width:100%/g)].length, 2); assert.doesNotMatch(html, /Infinity|NaN/);
});

test('loyalty refuses malformed balances and duplicate identities without inferred zero balances', () => {
  for (const rows of [[loyalty(1001, -1)], [loyalty(1001, 0.5)], [loyalty(1001, Number.MAX_SAFE_INTEGER + 1)], [loyalty(1001, '2')], [loyalty(1001, null)], [loyalty(0, 1)], [loyalty(1001, 1), loyalty(1001, 2)]]) {
    assert.equal(reputationChartData(fixture('loyalty_points', rows)), null);
  }
});

test('warfare charts keep every original counter separate and order periods without adding overlapping windows', () => {
  const result = fixture('faction_warfare', warfare().reverse());
  assert.deepEqual(plain(reputationChartData(result).rows), [
    { period: 'yesterday', label: 'Yesterday', kills: 2, victoryPoints: 5 },
    { period: 'last_week', label: 'Last week', kills: 7, victoryPoints: 15 },
    { period: 'total', label: 'Reported total', kills: 11, victoryPoints: 40 },
  ]);
  const html = render(result);
  assert.match(html, /Reported faction-warfare kills/); assert.match(html, /Reported faction-warfare victory points/);
  assert.match(html, /periods overlap and have different lengths/); assert.match(html, /Kills and victory points use separate scales/);
  for (const value of [2, 7, 11]) assert(html.includes(`${value} <small>kills`));
  for (const value of [5, 15, 40]) assert(html.includes(`${value} <small>victory points`));
  assert.doesNotMatch(html, /20 <small>kills|60 <small>victory points|Today/);
  assert.equal([...html.matchAll(/class="analytics-bar-row"/g)].length, 6);
});

test('warfare preserves explicit zero counters without fabricating missing periods or accepting duplicate periods', () => {
  const zero = fixture('faction_warfare', warfare([0, 0, 0], [0, 0, 0]));
  assert.equal([...render(zero).matchAll(/width:0%/g)].length, 6);
  for (const rows of [warfare().slice(0, 2), [warfare()[0], warfare()[0], warfare()[2]], warfare().map((row, index) => index ? row : { ...row, cells: { ...row.cells, kills: null } }), warfare().map((row, index) => index ? row : { ...row, cells: { ...row.cells, victoryPoints: -1 } })]) assert.equal(reputationChartData(fixture('faction_warfare', rows)), null);
});

test('unrelated private metadata never enters chart labels or markup', () => {
  const result = fixture('loyalty_points', [{ ...loyalty(1001, 17), private_note: '<img src="https://example.invalid/pixel">', cells: { ...loyalty(1001, 17).cells, name: '<script>private</script>' } }], { message: '<img src="https://example.invalid/pixel">' });
  const html = render(result); assert.match(html, /NPC corporation 1001/); assert.doesNotMatch(html, /<img|<script|example\.invalid|private/);
  const wrongLabel = warfare(); wrongLabel[0].cells.period = '<img src="https://example.invalid/pixel">';
  assert.doesNotMatch(render(fixture('faction_warfare', wrongLabel)), /<img|example\.invalid/);
});

test('unavailable, wrong-view and empty batches do not display charts', () => {
  for (const result of [
    ...['needs_permission', 'unavailable', 'error'].map(status => fixture('standings', [standing(90001, 1)], { status })),
    fixture('mining', [standing(90001, 1)]), fixture('standings', []), fixture('loyalty_points', []), fixture('faction_warfare', []),
  ]) assert.equal(render(result), '');
});

test('actual reputation service and strict browser client feed charts only their displayed batch and canonical period labels', async () => {
  function lib(name, context = {}) {
    const module = { exports: {} }, source = readFileSync(`app/lib/${name}.ts`, 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(code, { module, exports: module.exports, Date, AbortSignal, ...context }); return module.exports;
  }
  const summary = lib('overview-summary'), connection = lib('connection-client');
  const client = lib('character-workspace-client', { require: name => { assert.equal(name, './connection-client'); return connection; } });
  class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const service = lib('character-workspace', { require: name => { if (name === './overview-summary') return summary; assert.equal(name, './eve'); return { EveError }; } });
  const scopes = { standings: 'esi-characters.read_standings.v1', loyalty_points: 'esi-characters.read_loyalty.v1', faction_warfare: 'esi-characters.read_fw_stats.v1' };
  const stamp = '2026-01-01T00:00:00Z';
  for (const view of Object.keys(scopes)) {
    let reads = 0;
    const selected = { characterId: 90000001, view };
    const read = service.createCharacterWorkspaceReader({
      connections: async user => { assert.equal(user, 'synthetic-owner'); return [{ characterId: selected.characterId, scopes: [scopes[view]] }]; },
      now: () => Date.parse(stamp),
      publicNames: async () => { throw Error('Charts must not trigger name lookups'); },
      character: async (user, args, signal) => {
        assert.equal(user, 'synthetic-owner'); assert.equal(args.characterId, selected.characterId); assert.equal(args.dataset, view); assert(signal instanceof AbortSignal); reads++;
        const data = view === 'standings' ? Array.from({ length: 101 }, (_, index) => ({ from_id: 92000 + index, from_type: 'faction', standing: index === 100 ? 9.5 : index % 2 ? -2.5 : 0.5, private_note: 'OMIT_PRIVATE' }))
          : view === 'loyalty_points' ? Array.from({ length: 101 }, (_, index) => ({ corporation_id: 92000 + index, loyalty_points: index * 11, private_note: 'OMIT_PRIVATE' }))
          : { kills: { yesterday: 2, last_week: 7, total: 11 }, victory_points: { yesterday: 5, last_week: 15, total: 40 }, private_note: 'OMIT_PRIVATE' };
        return { characterId: selected.characterId, dataset: view, retrievedAt: stamp, cacheExpires: 'Thu, 01 Jan 2026 01:00:00 GMT', pagination: { kind: 'none' }, data };
      },
    });
    const first = client.characterWorkspaceResponse(await read('synthetic-owner', selected), selected);
    const chart = plain(reputationChartData(first)); assert.equal(chart.view, view); assert.equal(reads, 1);
    assert.doesNotMatch(render(first), /OMIT_PRIVATE/);
    if (view === 'standings') {
      assert.equal(first.metrics[0].value, 101); assert.equal(first.metrics[1].value, 51); assert.equal(chart.rows.length, 100);
      assert.deepEqual(chart.signs, [{ label: 'Positive', count: 50 }, { label: 'Zero', count: 0 }, { label: 'Negative', count: 50 }]);
      assert(!chart.rows.some(row => row.sourceId === 92100)); assert.doesNotMatch(render(first), /Faction 92100/);
    } else if (view === 'loyalty_points') {
      assert.equal(first.metrics[0].value, 101); assert.equal(chart.rows.length, 100);
      assert.deepEqual(chart.rows[0], { corporationId: 92099, points: 1089 }); assert.doesNotMatch(render(first), /NPC corporation 92100/);
    } else {
      assert.deepEqual(chart.rows, [{ period: 'yesterday', label: 'Yesterday', kills: 2, victoryPoints: 5 }, { period: 'last_week', label: 'Last week', kills: 7, victoryPoints: 15 }, { period: 'total', label: 'Reported total', kills: 11, victoryPoints: 40 }]);
      assert.match(render(first), /Reported faction-warfare kills/); assert.equal(first.next, null);
    }
    if (first.next) {
      const next = client.characterWorkspaceResponse(await read('synthetic-owner', first.next), first.next);
      const nextChart = plain(reputationChartData(next)); assert.equal(reads, 2); assert.equal(nextChart.rows.length, 1);
      if (view === 'standings') assert.deepEqual(nextChart.rows, [{ sourceId: 92100, kind: 'Faction', standing: 9.5 }]);
      else assert.deepEqual(nextChart.rows, [{ corporationId: 92100, points: 1100 }]);
    }
  }
});
