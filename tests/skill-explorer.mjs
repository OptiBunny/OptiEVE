import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

const code = ts.transpileModule(readFileSync('app/skill-explorer.tsx', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function load(react = React) {
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => {
    if (name === 'react') return react; if (name === 'react/jsx-runtime') return jsxRuntime; throw Error('Unexpected import ' + name);
  }, fetch: () => { throw Error('Exploring loaded skills must not read the network'); }, localStorage: new Proxy({}, { get: () => { throw Error('Skill selections must not be stored'); } }) });
  return module.exports.default;
}
function fixture() {
  return { totalSp: 600000, reportedSkillSp: 593414, unallocatedSp: null, skillCount: 7, trainedSkillCount: 4, activeSkillCount: 5, reducedActiveSkillCount: 2, boostedActiveSkillCount: 2,
    groups: [{ groupId: 10, name: 'Navigation', skillCount: 2, skillpoints: 257414 }, { groupId: 20, name: 'Shared group', skillCount: 2, skillpoints: 336000 }, { groupId: 30, name: 'Shared group', skillCount: 1, skillpoints: 0 }, { groupId: null, name: 'Shared group', skillCount: 2, skillpoints: 0 }],
    levelDistribution: [{ level: 0, trainedCount: 3, activeCount: 2 }, { level: 1, trainedCount: 0, activeCount: 1 }, { level: 2, trainedCount: 1, activeCount: 1 }, { level: 3, trainedCount: 0, activeCount: 1 }, { level: 4, trainedCount: 1, activeCount: 1 }, { level: 5, trainedCount: 2, activeCount: 1 }],
    skills: [
      { typeId: 1001, name: 'Synthetic navigation', groupId: 10, groupName: 'Navigation', trainedLevel: 5, activeLevel: 5, skillpoints: 256000 },
      { typeId: 1002, name: 'Synthetic boosted', groupId: 10, groupName: 'Navigation', trainedLevel: 2, activeLevel: 3, skillpoints: 1414 },
      { typeId: 1003, name: 'Synthetic reduced', groupId: 20, groupName: 'Shared group', trainedLevel: 4, activeLevel: 2, skillpoints: 80000 },
      { typeId: 1004, name: 'Synthetic unmapped boost', groupId: null, groupName: 'Shared group', trainedLevel: 0, activeLevel: 1, skillpoints: 0 },
      { typeId: 1005, name: '<img src=x onerror=alert(1)>', groupId: 30, groupName: 'Shared group', trainedLevel: 0, activeLevel: 0, skillpoints: 0 },
      { typeId: 1006, name: 'Synthetic unmapped zero', groupId: null, groupName: 'Shared group', trainedLevel: 0, activeLevel: 0, skillpoints: 0 },
      { typeId: 1007, name: 'Synthetic reduced five', groupId: 20, groupName: 'Shared group', trainedLevel: 5, activeLevel: 4, skillpoints: 256000 },
    ] };
}
function batch(count) {
  return { totalSp: count, reportedSkillSp: count, unallocatedSp: 0, skillCount: count, trainedSkillCount: count, activeSkillCount: count, reducedActiveSkillCount: 0, boostedActiveSkillCount: 0,
    groups: [{ groupId: 10, name: 'Synthetic batch', skillCount: count, skillpoints: count }], levelDistribution: [0, 1, 2, 3, 4, 5].map(level => ({ level, trainedCount: level === 5 ? count : 0, activeCount: level === 5 ? count : 0 })),
    skills: Array.from({ length: count }, (_, index) => ({ typeId: 50000 + index, name: 'Synthetic batch ' + String(index).padStart(4, '0'), groupId: 10, groupName: 'Synthetic batch', trainedLevel: 5, activeLevel: 5, skillpoints: 1 })) };
}
const nodes = element => !element || typeof element !== 'object' ? [] : [element, ...React.Children.toArray(element.props?.children).flatMap(nodes)];
const find = (tree, predicate) => nodes(tree).find(predicate);
const text = element => React.Children.toArray(element.props?.children).filter(value => typeof value === 'string').join('');
const button = (tree, label) => find(tree, node => node.type === 'button' && text(node) === label);
function interactions(skills = fixture()) {
  const values = []; let cursor = 0;
  const react = { ...React, useId: () => 'synthetic-skills', useState: initial => { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], next => { values[i] = typeof next === 'function' ? next(values[i]) : next; }]; } };
  const Component = load(react), render = () => { cursor = 0; return Component({ skills }); };
  const rows = () => React.Children.toArray(find(render(), node => node.type === 'tbody').props.children);
  return { render, rows, ids: () => rows().map(row => Number(row.key.slice(row.key.lastIndexOf('$') + 1))), select: (suffix, value) => find(render(), node => node.props?.id === 'synthetic-skills-' + suffix).props.onChange({ target: { value } }), chart: title => find(render(), node => node.props?.title === title) };
}

test('all 205 returned skills are reachable across three bounded pages, with correct ranges', () => {
  const h = interactions(batch(205));
  assert.deepEqual(h.ids(), Array.from({ length: 100 }, (_, i) => 50000 + i)); assert.equal(button(h.render(), 'Previous 100 skills').props.disabled, true);
  button(h.render(), 'Next 100 skills').props.onClick(); assert.deepEqual(h.ids(), Array.from({ length: 100 }, (_, i) => 50100 + i));
  button(h.render(), 'Next 100 skills').props.onClick(); assert.deepEqual(h.ids(), [50200, 50201, 50202, 50203, 50204]); assert.equal(button(h.render(), 'Next 100 skills').props.disabled, true);
  assert.match(renderToStaticMarkup(h.render()), /Reported skills 201–205 of 205 matches/);
  button(h.render(), 'Previous 100 skills').props.onClick(); assert.equal(h.ids()[0], 50100);
});

test('the maximum 2000 returned skills stay bounded to 100 rendered rows without losing the last row', () => {
  const h = interactions(batch(2000)); const seen = [];
  for (let page = 0; page < 20; page++) { assert.equal(h.rows().length, 100); seen.push(...h.ids()); if (page < 19) button(h.render(), 'Next 100 skills').props.onClick(); }
  assert.equal(new Set(seen).size, 2000); assert.equal(seen[1999], 51999); assert.equal(button(h.render(), 'Next 100 skills').props.disabled, true);
});

test('text and exact group identities distinguish equal names from unmapped skills', () => {
  const h = interactions(); h.select('query', '  NAVIGATION  '); assert.deepEqual(h.ids(), [1001, 1002]);
  h.select('query', '1007'); assert.deepEqual(h.ids(), [1007]); h.select('query', '');
  h.select('group', '20'); assert.deepEqual(h.ids(), [1003, 1007]);
  h.select('group', '30'); assert.deepEqual(h.ids(), [1005]);
  h.select('group', 'unmapped'); assert.deepEqual(h.ids(), [1004, 1006]);
  const html = renderToStaticMarkup(h.render()); assert.match(html, /Shared group · group 20/); assert.match(html, /Shared group · group 30/); assert.match(html, /Shared group · unmapped group/);
});

test('trained, active and relation filters intersect without inferring current training', () => {
  const h = interactions(); h.select('relation', 'reduced'); assert.deepEqual(h.ids(), [1003, 1007]);
  h.select('trained', '5'); assert.deepEqual(h.ids(), [1007]); h.select('active', '4'); assert.deepEqual(h.ids(), [1007]);
  h.select('active', '5'); assert.deepEqual(h.ids(), []); assert.match(renderToStaticMarkup(h.render()), /No returned skills match these filters/);
  button(h.render(), 'Reset skill filters').props.onClick(); h.select('relation', 'boosted'); assert.deepEqual(h.ids(), [1002, 1004]);
  h.select('trained', '0'); assert.deepEqual(h.ids(), [1004]);
  button(h.render(), 'Reset skill filters').props.onClick(); h.select('relation', 'equal'); assert.deepEqual(h.ids(), [1001, 1005, 1006]);
});

test('every local filter and reset returns the skill table to page one', () => {
  for (const [filter, value] of [['query', '50204'], ['group', '10'], ['trained', '5'], ['active', '5'], ['relation', 'equal']]) {
    const h = interactions(batch(205)); button(h.render(), 'Next 100 skills').props.onClick(); button(h.render(), 'Next 100 skills').props.onClick(); h.select(filter, value);
    assert.equal(button(h.render(), 'Previous 100 skills').props.disabled, true); assert.equal(h.ids()[0], filter === 'query' ? 50204 : 50000);
    button(h.render(), 'Reset skill filters').props.onClick(); assert.equal(h.ids()[0], 50000);
  }
});

test('full-result chart totals remain unchanged by filters and native chart buttons replace filters', () => {
  const h = interactions(); h.select('query', 'no match'); h.select('relation', 'equal');
  const groupChart = h.chart('SP by skill group'); assert.deepEqual(Array.from(groupChart.props.rows, row => [row.key, row.value]), [['20', 336000], ['10', 257414], ['unmapped', 0], ['30', 0]]);
  const groupControls = nodes(groupChart.type(groupChart.props)).filter(node => node.type === 'button');
  assert.equal(groupControls[0].props['aria-label'], 'Show 2 skills in Shared group · group 20'); groupControls[0].props.onClick(); assert.deepEqual(h.ids(), [1003, 1007]);
  const trained = h.chart('Trained levels'), active = h.chart('Active levels');
  assert.deepEqual(Array.from(trained.props.rows, row => row.value), [3, 0, 1, 0, 1, 2]); assert.deepEqual(Array.from(active.props.rows, row => row.value), [2, 1, 1, 1, 1, 1]); assert.equal(trained.props.maximum, active.props.maximum);
  nodes(trained.type(trained.props)).find(node => node.props?.['aria-label'] === 'Show skills with trained level 0').props.onClick(); assert.deepEqual(h.ids(), [1004, 1005, 1006]);
  nodes(active.type(active.props)).find(node => node.props?.['aria-label'] === 'Show skills with active level 5').props.onClick(); assert.deepEqual(h.ids(), [1001]);
});

test('group visuals stop at 20 while every returned group remains selectable with exact SP labels', () => {
  const skills = batch(21); skills.groups = skills.skills.map((row, i) => ({ groupId: i + 1, name: 'Synthetic group ' + i, skillCount: 1, skillpoints: i + 1 }));
  skills.skills = skills.skills.map((row, i) => ({ ...row, groupId: i + 1, groupName: 'Synthetic group ' + i, skillpoints: i + 1 })); skills.reportedSkillSp = skills.totalSp = 231;
  const h = interactions(skills); assert.equal(h.chart('SP by skill group').props.rows.length, 20); h.select('group', '1'); assert.deepEqual(h.ids(), [50000]);
  assert.match(renderToStaticMarkup(h.render()), /Showing 20 of 21 returned groups/);
  const large = batch(1); large.totalSp = large.reportedSkillSp = large.groups[0].skillpoints = large.skills[0].skillpoints = Number.MAX_SAFE_INTEGER;
  const html = renderToStaticMarkup(React.createElement(load(), { skills: large })); assert(html.includes(Number.MAX_SAFE_INTEGER.toLocaleString())); assert.doesNotMatch(html, /NaN|Infinity|undefined/);
});

test('zero reported skills stay known empty and text is escaped in charts and tables', () => {
  const empty = batch(0); empty.groups = [];
  const html = renderToStaticMarkup(React.createElement(load(), { skills: empty })); assert.match(html, /Reported skills 0–0 of 0 matches/); assert.match(html, /No reported groups/); assert.doesNotMatch(html, /NaN|Infinity|undefined/);
  const escaped = renderToStaticMarkup(React.createElement(load(), { skills: fixture() })); assert.match(escaped, /&lt;img/); assert.doesNotMatch(escaped, /<img|<script/); assert.match(escaped, /role="region" aria-label="Filtered reported skills"/);
});

test('a newly mounted result begins with all filters clear', () => {
  const old = interactions(batch(205)); button(old.render(), 'Next 100 skills').props.onClick(); old.select('query', 'no match'); old.select('group', 'unmapped'); assert.equal(old.rows().length, 0);
  const fresh = interactions(batch(205)); assert.equal(fresh.rows().length, 100); assert.equal(fresh.ids()[0], 50000); assert.equal(button(fresh.render(), 'Previous 100 skills').props.disabled, true);
});
