import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { createRequire } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const compile = name => ts.transpileModule(readFileSync(`app/lib/${name}.ts`, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const sources = Object.fromEntries(['manufacturing-client', 'manufacturing-estimate', 'manufacturing-demo'].map(name => [name, compile(name)]));
function harness(fetch = () => { throw Error('Unexpected network request'); }, timers = {}) {
  const modules = {};
  for (const name of Object.keys(sources)) {
    const fixtureModule = { exports: {} };
    vm.runInNewContext(sources[name], { module: fixtureModule, exports: fixtureModule.exports, require: name => { const target = modules[name.replace('./', '')]; if (!target) throw Error(`Unexpected import ${name}`); return target; }, fetch, AbortController, TextDecoder, Date, structuredClone, setTimeout, clearTimeout, ...timers });
    modules[name] = fixtureModule.exports;
  }
  return { ...modules['manufacturing-client'], ...modules['manufacturing-demo'] };
}
const plain = value => JSON.parse(JSON.stringify(value));
const signal = () => new AbortController().signal;
function selected(h = harness()) { return { operation: 'assess', input: { ...structuredClone(h.demoContext), blueprintTypeId: 10001, blueprintSource: 'owned', blueprintItemId: 70000001, blueprintPage: 1, plan: h.demoPlan() } }; }
function jobs(h, count = 2, type = 10001) { return Array.from({ length: count }, (_, i) => ({ key: `job-${i + 1}`, blueprintTypeId: type, blueprintSource: 'owned', blueprintItemId: 70000001 + type - 10001, blueprintPage: 1, plan: h.demoPlan() })); }
const callDemo = (h, request, scenario = 'complete') => h.manufacturingDemoRequest(request, scenario, signal());
const reject = (h, value, request) => assert.throws(() => h.manufacturingResponse(value, request), /did not match/);

test('client projects only bounded display fields and preserves unknowns and exact money', async () => {
  const h = harness(), request = selected(h), value = plain(await callDemo(h, request));
  value.privateExtra = { secret: 'discard this synthetic extra field' }; value.assessment.rawOrders = [{ owner: 'discard' }]; value.assessment.materials[0].rawAsset = 'discard';
  const projected = h.manufacturingResponse(value, request);
  assert.equal('privateExtra' in projected, false); assert.equal('rawOrders' in projected.assessment, false); assert.equal('rawAsset' in projected.assessment.materials[0], false);
  assert.equal(projected.assessment.cashRequiredISK, '220.00'); assert.equal(projected.assessment.materials[0].buyISK, '0.00');
  value.assessment.cashRequiredISK = null; assert.equal(h.manufacturingResponse(value, request).assessment.cashRequiredISK, null);
});

for (const [name, mutate] of [
  ['operation', r => r.operation = 'plan'], ['character', r => r.context.characterId++], ['owner kind', r => r.context.resourceEntity = 'corporation'],
  ['extra context setting', r => r.context.callbackUrl = 'https://example.invalid'], ['missing context setting', r => delete r.context.otherOwnedOrdersReviewed],
  ['stock locations', r => r.context.stockLocationIds = [60000002]], ['market hub', r => r.context.marketStationId++], ['system', r => r.context.manufacturingSystemId++],
  ['job selection', r => r.assessment.key = 'different'], ['recipe selection', r => r.assessment.blueprintTypeId++], ['run count', r => r.assessment.runs++],
  ['bad readiness', r => r.assessment.readiness = 'safe'], ['unsafe quantity', r => r.assessment.materials[0].requiredQuantity = 1e13],
  ['duplicate material', r => r.assessment.materials.push(r.assessment.materials[0])], ['allocation mismatch', r => r.assessment.materials[0].usedQuantity++],
  ['stock over-allocation', r => r.assessment.materials[0].ownedQuantity = 0], ['negative cash', r => r.assessment.cashRequiredISK = '-1.00'],
  ['exponential money', r => r.assessment.profitISK = '1e30'], ['fractional cents', r => r.assessment.profitISK = '1.001'], ['unbounded money', r => r.assessment.profitISK = '1'.repeat(20) + '.00'],
  ['unknown zero coercion', r => r.assessment.cashRequiredISK = 0], ['oversized reason', r => r.assessment.reasons.push('x'.repeat(2049))],
  ['too many materials', r => r.assessment.materials = Array(13).fill(r.assessment.materials[0])], ['too many sources', r => r.assessment.freshness = Array(129).fill(r.assessment.freshness[0])],
  ['invalid date', r => r.generatedAt = 'invalid'], ['invalid cache date', r => r.assessment.freshness[0].cacheExpires = 'invalid'], ['control characters', r => r.assessment.productName = 'bad\u0000name'],
]) test(`client rejects mismatched or malformed ${name}`, async () => { const h = harness(), request = selected(h), value = plain(await callDemo(h, request)); mutate(value); reject(h, value, request); });

test('client binds corporation wallet, hangars and extra exclusion IDs exactly', async () => {
  const h = harness(), request = selected(h); Object.assign(request.input, { resourceEntity: 'corporation', walletDivision: 1, hangarDivisions: [1, 2], additionalOwnedOrderIds: [80000001] });
  const value = plain(await callDemo(h, request));
  for (const change of [{ walletDivision: 2 }, { hangarDivisions: [2, 1] }, { additionalOwnedOrderIds: [] }]) reject(h, { ...value, context: { ...value.context, ...change } }, request);
});

test('blueprint browser binds owner and ESI page, bounds and projects every row', async () => {
  const h = harness(), request = { operation: 'blueprints', characterId: 90000001, resourceEntity: 'character', page: 1 }, value = plain(await callDemo(h, request));
  assert.equal(value.items.length, 3);
  for (const change of [{ page: 2 }, { characterId: 90000002 }, { resourceEntity: 'corporation' }, { pages: 0 }]) reject(h, { ...value, ...change }, request);
  const large = { ...value, items: Array.from({ length: 10000 }, (_, index) => ({ ...value.items[0], itemId: 71000001 + index, rawLocation: 'discard' })) };
  assert.equal(h.manufacturingResponse(large, request).items.length, 10000); assert.equal('rawLocation' in h.manufacturingResponse(large, request).items[0], false);
  large.items.push({ ...value.items[0], itemId: 72000001 }); reject(h, large, request);
});

test('search pagination binds query and advances a bounded slice', async () => {
  const h = harness(), request = { operation: 'search', query: 'Demo', limit: 1 }, value = plain(await callDemo(h, request));
  assert.equal(value.items.length, 1); assert.equal(value.nextOffset, 1); assert.equal(value.totalMatches, 3);
  reject(h, { ...value, query: 'different' }, request); reject(h, { ...value, nextOffset: 0 }, request);
  reject(h, { ...value, items: [{ ...value.items[0], blueprintTypeIds: [10001, 10001] }] }, request);
});

test('comparison response cannot mix jobs, duplicate rows or rank unconfirmed profit', async () => {
  const h = harness(), request = { operation: 'compare', input: { context: h.demoContext, jobs: jobs(h) } }, value = plain(await callDemo(h, request));
  assert.equal(value.rankedKeys.length, 2);
  reject(h, { ...value, candidates: [value.candidates[0], value.candidates[0]] }, request);
  reject(h, { ...value, rankedKeys: ['unselected'] }, request);
  reject(h, { ...value, candidates: value.candidates.slice(1) }, request);
  const noProfit = structuredClone(value); noProfit.candidates[0].profitISK = null; reject(h, noProfit, request);
});

test('combined production response enforces aggregate allocation arithmetic and unique outputs', async () => {
  const h = harness(), request = { operation: 'plan', input: { context: h.demoContext, jobs: jobs(h) } }, value = plain(await callDemo(h, request));
  assert.equal(value.shoppingList[0].requiredQuantity, 228); assert.equal(value.shoppingList[0].ownedAllocatedQuantity, 150); assert.equal(value.shoppingList[0].missingQuantity, 78);
  const mismatch = structuredClone(value); mismatch.shoppingList[0].missingQuantity++; reject(h, mismatch, request);
  reject(h, { ...value, outputs: [value.outputs[0], value.outputs[0]] }, request);
});

test('transport posts the selected input without cache and projects a valid response', async () => {
  const reference = harness(), request = selected(reference), fixture = plain(await callDemo(reference, request)); let seen;
  const h = harness(async (url, options) => { seen = { url, options }; return new Response(JSON.stringify(fixture)); });
  const value = await h.manufacturingRequest(request, signal());
  assert.equal(seen.url, '/api/eve/manufacturing'); assert.equal(seen.options.method, 'POST'); assert.equal(seen.options.cache, 'no-store'); assert.deepEqual(JSON.parse(seen.options.body), plain(request)); assert.equal(value.assessment.cashRequiredISK, '220.00');
});

test('transport bounds both declared and streamed response bytes', async () => {
  const request = selected();
  await assert.rejects(harness(async () => new Response('x', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } })).manufacturingRequest(request, signal()), /display limit/);
  await assert.rejects(harness(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))).manufacturingRequest(request, signal()), /display limit/);
});

test('transport rejects late responses after cancellation and cleans the timeout', async () => {
  const reference = harness(), request = selected(reference), fixture = plain(await callDemo(reference, request)), controller = new AbortController(); let resolveResponse, cleared = false;
  const h = harness(() => new Promise(resolve => { resolveResponse = resolve; }), { setTimeout: () => 7, clearTimeout: id => { assert.equal(id, 7); cleared = true; } });
  const pending = h.manufacturingRequest(request, controller.signal); controller.abort(); resolveResponse(new Response(JSON.stringify(fixture)));
  await assert.rejects(pending, /cancelled/); assert.equal(cleared, true);
});

test('transport hides raw authentication and unexpected network failures', async () => {
  await assert.rejects(harness(async () => new Response('synthetic secret', { status: 401 })).manufacturingRequest(selected(), signal()), /Sign in to the private app/);
  await assert.rejects(harness(async () => { throw Error('synthetic private host'); }).manufacturingRequest(selected(), signal()), error => !error.message.includes('private host') && /Could not reach/.test(error.message));
  await assert.rejects(harness(async () => new Response('invalid')).manufacturingRequest(selected(), signal()), /unreadable/);
});

test('synthetic demo performs every operation without any network or persistence APIs', async () => {
  let requests = 0; const h = harness(() => { requests++; throw Error('No network allowed in demo'); });
  for (const request of [{ operation: 'search', query: 'Demo' }, { operation: 'catalog' }, { operation: 'blueprints', characterId: 90000001, resourceEntity: 'character', page: 1 }, selected(h), ...['compare', 'plan'].map(operation => ({ operation, input: { context: h.demoContext, jobs: jobs(h) } }))]) await callDemo(h, request);
  assert.equal(requests, 0);
  for (const file of ['app/lib/manufacturing-demo.ts', 'app/manufacturing-panel.tsx', 'app/demo/page.tsx']) assert.doesNotMatch(readFileSync(file, 'utf8'), /localStorage|sessionStorage|indexedDB|document\.cookie|\/api\/eve\/status/);
  assert.doesNotMatch(readFileSync('app/demo/page.tsx', 'utf8').replace(/\/\*[^]*?\*\//g, ''), /ConnectionPanel|connectionStatus/);
});

test('synthetic missing evidence stays unknown even with assumed zeros and no stock selected', async () => {
  const h = harness(), request = selected(h), missing = await callDemo(h, request, 'missing');
  assert.equal(missing.assessment.availableWalletISK, null); assert.equal(missing.assessment.profitISK, null); assert.equal(missing.assessment.materials[0].usedQuantity, null); assert.equal(missing.assessment.readiness, 'unconfirmed');
  const context = { ...h.demoContext, useOwnedMaterials: false }; delete context.stockLocationIds;
  const plan = await callDemo(h, { operation: 'plan', input: { context, jobs: jobs(h) } }, 'missing'); assert.equal(plan.shoppingList[0].coverage, 'unknown'); assert.equal(plan.shoppingList[0].purchaseISK, null);
});

test('synthetic fee blanks are not silently interpreted as zero', async () => {
  const h = harness(), request = selected(h); request.input.plan.overhead.haulingISK = null;
  const value = await callDemo(h, request); assert.equal(value.assessment.cashRequiredISK, null); assert.equal(value.assessment.profitISK, null); assert.ok(value.assessment.reasons.some(reason => reason.includes('haulingISK')));
});

test('synthetic combined plan allocates shared stock once and checks the total wallet once', async () => {
  const h = harness(), input = { context: h.demoContext, jobs: jobs(h, 3) }, comparison = await callDemo(h, { operation: 'compare', input }), plan = await callDemo(h, { operation: 'plan', input });
  assert.ok(comparison.candidates.every(card => card.affordable === true)); assert.equal(plan.totals.affordable, false); assert.equal(plan.readiness, 'blocked'); assert.equal(plan.totals.walletISK, '2500.00');
  assert.equal(plan.shoppingList[0].ownedAllocatedQuantity, 150); assert.equal(plan.jobs.reduce((sum, job) => sum + job.materials[0].usedQuantity, 0), 150); assert.equal(plan.outputs[0].quantity, 6);
  const repeat = await callDemo(h, { operation: 'plan', input }); assert.deepEqual(plain(repeat.shoppingList), plain(plan.shoppingList), 'a new demo action starts with a fresh, local pool');
});

test('synthetic owned blueprints use verified ME and do not reuse copy runs', async () => {
  const h = harness(), input = { context: h.demoContext, jobs: jobs(h, 2, 10002) }; input.jobs[0].plan.materialEfficiency = 10;
  const value = await callDemo(h, { operation: 'plan', input });
  assert.equal(value.jobs[0].materials[0].requiredQuantity, 76, 'fixture ME5 overrides user ME10 before quantities are calculated'); assert.equal(value.jobs[1].readiness, 'blocked'); assert.ok(value.jobs[1].reasons.some(reason => /too few remaining runs/.test(reason)));
  const request = selected(h); request.input.blueprintSource = 'prospective'; delete request.input.blueprintItemId; delete request.input.blueprintPage;
  assert.equal((await callDemo(h, request)).assessment.readiness, 'unconfirmed', 'prospective access assumptions never become verified ownership');
});

test('synthetic limited depth is explicit and never represented as executable profit', async () => {
  const h = harness(), request = { operation: 'plan', input: { context: h.demoContext, jobs: jobs(h) } }, value = await callDemo(h, request, 'scarce');
  assert.equal(value.totals.economicProfitISK, null); assert.equal(value.outputs[0].coverage, 'partial'); assert.equal(value.outputs[0].grossRevenueISK, null); assert.equal(value.shoppingList[0].coverage, 'partial');
});

test('synthetic cancellation stops before creating results', async () => {
  const h = harness(), controller = new AbortController(); controller.abort(); await assert.rejects(h.manufacturingDemoRequest(selected(h), 'complete', controller.signal), /cancelled/);
});

test('manufacturing form renders explicit bounded read controls with conservative defaults', () => {
  const h = harness(), fixtureModule = { exports: {} }, nativeRequire = createRequire(import.meta.url);
  const source = ts.transpileModule(readFileSync('app/manufacturing-panel.tsx', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(source, { module: fixtureModule, exports: fixtureModule.exports, require: name => {
    if (name === 'react' || name === 'react/jsx-runtime') return nativeRequire(name);
    if (name === './lib/manufacturing-client' || name === './lib/manufacturing-demo') return h;
    if (name === './lib/manufacturing-estimate' || name === './manufacturing.css') return {};
    throw Error(`Unexpected panel import ${name}`);
  }, AbortController });
  const html = renderToStaticMarkup(nativeRequire('react').createElement(fixtureModule.exports.default, { characters: [], openConnections() {}, demo: true }));
  assert.match(html, /<summary>Data read limits<\/summary>/);
  assert.match(html, /id="manufacturing-private-pages"[^>]*value="3"/);
  assert.match(html, /id="manufacturing-market-pages"[^>]*value="2"/);
  assert.match(html, /1–50 pages/); assert.match(html, /1–4 pages/);
  assert.match(html, /55-second deadline/); assert.match(html, /does not establish complete coverage/);
});

test('chosen private and market budgets survive transport and bind the returned context', async () => {
  const reference = harness(), request = selected(reference); request.input.maxPrivatePages = 6; request.input.maxMarketPages = 4;
  const fixture = plain(await callDemo(reference, request)); let sent;
  const h = harness(async (_url, options) => { sent = JSON.parse(options.body); return new Response(JSON.stringify(fixture)); });
  await h.manufacturingRequest(request, signal());
  assert.equal(sent.input.maxPrivatePages, 6); assert.equal(sent.input.maxMarketPages, 4);
  for (const changed of [{ maxPrivatePages: 3 }, { maxMarketPages: 2 }]) reject(h, { ...fixture, context: { ...fixture.context, ...changed } }, request);
});
