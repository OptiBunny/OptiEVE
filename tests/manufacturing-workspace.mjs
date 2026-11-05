import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const data = JSON.parse(readFileSync('app/data/manufacturing-catalog.json', 'utf8'));
const now = Date.parse('2026-01-01T00:00:00Z'), stamp = new Date(now).toISOString(), expiry = new Date(now + 3600000).toISOString();
class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const modules = new Map();
function load(name) {
  if (name === './eve') return { EveError };
  if (name === '../data/manufacturing-catalog.json') return { default: data };
  if (!modules.has(name)) {
    assert.match(name, /^\.\/manufacturing-[a-z-]+$/);
    const m = { exports: {} };
    vm.runInNewContext(ts.transpileModule(readFileSync(`app/lib/${name.slice(2)}.ts`, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { module: m, exports: m.exports, require: load, Date, AbortSignal, structuredClone, setTimeout, clearTimeout, TextEncoder, TextDecoder, Uint8Array, Headers, URL, URLSearchParams, fetch: () => { throw Error('No external requests in synthetic tests'); } });
    modules.set(name, m.exports);
  }
  return modules.get(name);
}
const workspace = load('./manufacturing-workspace');
const recipe = data.recipes.find(row => row.materials.length <= 12 && row.products.length === 1);
const plan = { runs: 2, materialEfficiency: 0, facilityMaterialMultiplier: '1', blueprint: { kind: 'unknown', accessConfirmed: false }, facilityAccessConfirmed: false, sale: {}, job: {}, overhead: {} };
const context = { characterId: 90000001, resourceEntity: 'character', marketRegionId: 10000001, marketStationId: 60000001, manufacturingSystemId: 30000001, useOwnedMaterials: false, otherOwnedOrdersReviewed: false };
const job = { key: 'a', blueprintTypeId: recipe.blueprintTypeId, blueprintSource: 'prospective', plan };
const single = () => { const { key, ...selection } = job; return { ...context, ...structuredClone(selection) }; };
const estimate = load('./manufacturing-estimate').estimateManufacturing(recipe, plan, { materials: [], output: null, walletISK: null, skills: null, industry: null });
const assessment = { generatedAt: stamp, estimate, currentRecipeVerified: false, stockCoverage: 'unknown', ownOrdersComplete: false, privateSources: [{ entity: 'character', dataset: 'skills', page: null, freshness: 'fresh', cacheExpires: expiry }], conditions: ['Synthetic missing evidence'], limitations: ['Synthetic assumptions'], data: { privateMarker: 'OMIT_PRIVATE_PAYLOAD' } };
function harness(options = {}) {
  const calls = [];
  const read = async (user, input, signal) => { calls.push({ user, input, signal }); return options.frame ?? { characterId: context.characterId, entity: 'character', dataset: 'blueprints', retrievedAt: stamp, cacheExpires: expiry, responseDate: stamp, cacheAge: '0', pagination: { kind: 'page', page: 1, pages: 2 }, data: [{ item_id: 5001, type_id: recipe.blueprintTypeId, quantity: -2, runs: 3, material_efficiency: 10, name: 'OMIT_PRIVATE_PAYLOAD' }] }; };
  const api = workspace.createManufacturingWorkspace({ now: () => now, connections: async () => options.connections ?? [{ characterId: context.characterId }], character: read, corporation: read, assess: async (user, input, controls) => { calls.push({ user, input, signal: controls.signal }); return structuredClone(assessment); }, compare: async (user, input, controls) => { calls.push({ user, input, signal: controls.signal }); return { generatedAt: stamp, alternatives: input.jobs.map((j, i) => ({ key: j.key, assessment: structuredClone(assessment), rank: i + 1 })), conditions: ['Synthetic alternatives'] }; }, plan: async (user, input, controls) => { calls.push({ user, input, signal: controls.signal }); return { generatedAt: stamp, jobs: input.jobs.map(j => ({ key: j.key, assessment: structuredClone(assessment), copyRuns: { status: 'unavailable', requested: 2, available: null, allocated: null, overcommitted: null } })), shoppingList: [], outputs: [], totals: { walletISK: null, materialCashISK: null, jobAndOverheadCashISK: null, cashRequiredISK: null, affordable: null, netRevenueISK: null, economicProfitISK: null }, readiness: 'unconfirmed', conditions: ['Synthetic plan'], limitations: ['No writes'] }; } });
  return { api, calls };
}
test('all operations require identity and reject unknown operation and request fields', async () => {
  const { api, calls } = harness();
  for (const operation of ['search', 'blueprints', 'catalog', 'assess', 'compare', 'plan']) await assert.rejects(api('', { operation }), e => e.status === 401);
  for (const raw of [null, [], {}, { operation: 'write' }, { operation: 'search', query: 'Rifter', private: true }, { operation: 'catalog', url: 'https://example.invalid' }, { operation: 'assess', input: { ...single(), walletISK: '999' } }, { operation: 'plan', input: { context, jobs: [] } }]) await assert.rejects(api('synthetic', raw));
  assert.equal(calls.length, 0);
});
test('product search is bounded public-only and requires no account fetch', async () => {
  const { api, calls } = harness();
  const value = await api('synthetic', { operation: 'search', query: recipe.products[0].name, limit: 5 });
  assert(value.items.some(row => row.typeId === recipe.products[0].typeId));
  assert(value.items.length <= 5); assert(value.items.every(row => row.blueprintTypeIds.length)); assert.equal(calls.length, 0);
  await assert.rejects(api('synthetic', { operation: 'search', query: 'a' }));
});
test('blueprints require owned character, matching envelope and requested page; strip raw account fields', async () => {
  const input = { operation: 'blueprints', characterId: context.characterId, resourceEntity: 'character', page: 1 };
  const { api, calls } = harness(); const value = await api('synthetic-user', input);
  assert.equal(value.coverage, 'partial'); assert.equal(value.items[0].remainingRuns, 3); assert.equal(value.items[0].kind, 'copy');
  assert(!JSON.stringify(value).includes('OMIT_PRIVATE_PAYLOAD')); assert.equal(calls[0].user, 'synthetic-user'); assert.equal(calls[0].input.parameters.page, 1);
  const other = harness({ connections: [] }); await assert.rejects(other.api('synthetic', input), e => e.status === 404); assert.equal(other.calls.length, 0);
  for (const frame of [{}, { characterId: 1, dataset: 'blueprints', data: [] }, { characterId: context.characterId, dataset: 'blueprints', entity: 'character', pagination: { kind: 'page', page: 2, pages: 2 }, data: [] }]) await assert.rejects(harness({ frame }).api('synthetic', input), e => e.status === 502);
});
test('assess, compare and combined plan bind exact validated context and project only calculated cards', async () => {
  const { api } = harness();
  for (const operation of ['assess', 'compare', 'plan']) {
    const value = await api('synthetic', { operation, input: operation === 'assess' ? single() : { context, jobs: [job] } });
    assert.deepEqual(JSON.parse(JSON.stringify(value.context)), context);
    const card = operation === 'assess' ? value.assessment : operation === 'compare' ? value.candidates[0] : value.jobs[0];
    assert.equal(card.blueprintTypeId, recipe.blueprintTypeId); assert.equal(card.profitISK, null); assert.equal(card.affordable, null);
    assert(!JSON.stringify(value).includes('OMIT_PRIVATE_PAYLOAD'));
  }
});
test('cancellation prevents reads and resolves an uncooperative reader without exposing internals', async () => {
  const controller = new AbortController(); controller.abort(); const h = harness();
  await assert.rejects(h.api('synthetic', { operation: 'search', query: 'Rifter' }, { signal: controller.signal })); assert.equal(h.calls.length, 0);
  const active = new AbortController(); const api = workspace.createManufacturingWorkspace({ catalog: () => new Promise(() => {}) });
  const pending = api('synthetic', { operation: 'catalog' }, { signal: active.signal }); active.abort(new Error('OMIT_PRIVATE_PAYLOAD'));
  await assert.rejects(pending, e => e.status === 408 && !e.message.includes('OMIT_PRIVATE_PAYLOAD'));
});
