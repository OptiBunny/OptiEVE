import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const compile = name => ts.transpileModule(readFileSync(`app/lib/${name}.ts`, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const planningCode = compile('manufacturing-planning');
const code = compile('manufacturing-assessment'), calculatorCode = compile('manufacturing-estimate'), stockCode = compile('manufacturing-stock');
const plain = value => JSON.parse(JSON.stringify(value));
const clone = value => structuredClone(value);
const now = Date.parse('2026-01-01T00:00:00Z'), stamp = new Date(now).toISOString(), expiry = '2026-01-01T01:00:00Z';
const publicSource = { url: 'https://esi.evetech.net/latest/markets/prices/', retrievedAt: stamp, cacheExpires: expiry, lastModified: stamp, cacheControl: 'public, max-age=3600' };
const characterId = 90000001, corporationId = 98000001, stationId = 60000001;
class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
function load(source, imports = {}, overrides = {}) {
  const fixtureModule = { exports: {} };
  vm.runInNewContext(source, { module: fixtureModule, exports: fixtureModule.exports, require: name => { assert(Object.hasOwn(imports, name), name); return imports[name]; }, Date, AbortSignal, structuredClone, ...overrides });
  return fixtureModule.exports;
}
const calculator = load(calculatorCode);
const stock = load(stockCode);
const recipe = {
  blueprintTypeId: 10001, blueprintName: 'Synthetic blueprint', activity: 'manufacturing',
  materials: [{ typeId: 101, name: 'Synthetic input A', quantity: 10 }, { typeId: 102, name: 'Synthetic input B', quantity: 1 }],
  products: [{ typeId: 201, name: 'Synthetic output', quantity: 2 }],
  skills: [{ typeId: 301, name: 'Synthetic skill', level: 2 }], timeSeconds: 120, maxProductionLimit: 1,
};
const request = {
  characterId, resourceEntity: 'character', blueprintTypeId: recipe.blueprintTypeId, blueprintSource: 'owned', blueprintItemId: 5001,
  marketRegionId: 10000001, marketStationId: stationId, manufacturingSystemId: 30000001,
  useOwnedMaterials: true, stockLocationIds: [stationId], otherOwnedOrdersReviewed: true,
  plan: {
    runs: 2, materialEfficiency: 0, facilityMaterialMultiplier: '1',
    blueprint: { kind: 'original', accessConfirmed: true }, facilityAccessConfirmed: true,
    sale: { salesTaxRate: '0.1', listedBrokerRate: '0.03', listedBrokerMinimumISK: '1', listedUnitPriceISK: '25' },
    job: { quotedInstallationISK: '4' },
    overhead: { haulingISK: '1', blueprintCashISK: '2', blueprintOpportunityISK: '3', otherCashISK: '1', otherOpportunityISK: '2' },
  },
};
const asset = (itemId, typeId, quantity, flag = 'Hangar', locationId = stationId, overrides = {}) => ({ item_id: itemId, type_id: typeId, quantity, location_id: locationId, location_type: locationId === stationId ? 'station' : 'item', location_flag: flag, is_singleton: false, private_marker: 'OMIT_PRIVATE_FIXTURE_MARKER', ...overrides });
function frame(entity, input, legacy = false) {
  const dataset = input.dataset, page = input.parameters?.page ?? input.page ?? 1;
  let data;
  if (dataset === 'blueprints') data = [{ item_id: 5001, type_id: 10001, location_id: stationId, quantity: -2, runs: 20, material_efficiency: 10, time_efficiency: 20, private_marker: 'OMIT_PRIVATE_FIXTURE_MARKER' }];
  if (dataset === 'skills') data = { skills: [{ skill_id: 301, active_skill_level: 3, trained_skill_level: 5 }] };
  if (dataset === 'orders') data = [{ order_id: entity === 'corporation' ? 7002 : 7001 }];
  if (dataset === 'assets') data = entity === 'corporation'
    ? [asset(1001, 101, 6, 'CorpSAG2'), asset(1002, 101, 2, 'CorpSAG4'), asset(1003, 102, 2, 'CorpSAG2'), asset(1004, 101, 999, 'CorpSAG1')]
    : [asset(1001, 101, 8), asset(1002, 102, 2)];
  if (dataset === 'wallet_balance') data = 30;
  if (dataset === 'wallet_balances') data = [{ division: 1, balance: 100000 }, { division: 3, balance: 20 }];
  if (dataset === 'structure') data = { solar_system_id: 30000001 };
  assert.notEqual(data, undefined, dataset);
  return { characterId, ...(entity === 'corporation' ? { corporationId } : {}), entity, dataset, data, retrievedAt: stamp, cacheExpires: expiry, responseDate: stamp, cacheAge: '0', ...(legacy ? { page, pages: 1 } : { pagination: { kind: ['assets', 'blueprints'].includes(dataset) ? 'page' : 'none', page, pages: 1 } }) };
}
function harness(options = {}) {
  const calls = [], marketCalls = [], timeoutValues = [];
  const market = {
    quote: async (input, controls) => {
      marketCalls.push({ kind: 'quote', input: clone(input) }); controls.signal.throwIfAborted();
      const unit = input.side === 'buy_materials' ? ({ 101: 2, 102: 5 })[input.typeId] : ({ 101: 1, 102: 3, 201: 20 })[input.typeId];
      const value = { ...input, regionId: input.regionId, stationId: input.stationId, solarSystemId: 30000001, grossISK: (unit * input.quantity).toFixed(2), filledQuantity: input.quantity, unfilledQuantity: 0, coverage: 'complete', completePages: true, exclusionsVerified: input.ownOrdersComplete, estimateReady: input.ownOrdersComplete, sourceFreshness: 'fresh', generatedAt: stamp, validUntil: expiry, sources: [clone(publicSource)], priceLevels: [{priceISK: unit.toFixed(2), quantity: input.quantity, minimumFill: 1}] };
      return options.quote ? options.quote(input, controls, value) : value;
    },
    costs: async (input, controls) => { marketCalls.push({ kind: 'costs', input: clone(input) }); controls.signal.throwIfAborted(); return { manufacturingCostIndex: '0.1', adjustedPrices: [{ typeId: 101, adjustedPriceISK: '2' }, { typeId: 102, adjustedPriceISK: '3' }], complete: true, sourceFreshness: 'fresh', sources: [clone(publicSource)] }; },
    history: async (input, controls) => { marketCalls.push({ kind: 'history', input: clone(input) }); controls.signal.throwIfAborted(); return { kind: 'synthetic_regional_history', sourceFreshness: 'fresh', sources: [clone(publicSource)] }; },
  };
  const read = async (entity, user, input, signal, legacy = false) => {
    calls.push({ entity, user, input: clone(input), legacy }); signal?.throwIfAborted();
    const value = frame(entity, input, legacy);
    return options.read ? options.read(entity, input, value, signal, legacy) : value;
  };
  const deps = {
    connections: async user => { calls.push({ entity: 'connections', user }); return typeof options.connections === 'function' ? options.connections() : options.connections ?? [{ characterId }]; },
    character: (user, input, signal) => read('character', user, input, signal),
    corporation: (user, input, signal) => read('corporation', user, input, signal),
    legacy: (user, input, signal) => read(input.entity, user, input, signal, true),
    catalog: () => ({ recipes: [options.recipe ?? recipe], provenance: { source: 'synthetic-official-catalog-fixture' } }),
    catalogStatus: async ({ signal }) => { signal.throwIfAborted(); return options.catalogStatus ? options.catalogStatus(signal) : { status: 'current', checkedAt: stamp, cacheExpires: expiry }; }, market: () => market, now: options.now ?? (() => now),
  };
  const signalFacade = { any: signals => AbortSignal.any(signals), timeout: ms => { timeoutValues.push(ms); return options.deadlineSignal ?? AbortSignal.timeout(ms); } };
  const api = load(code, { './eve': { EveError }, './manufacturing-catalog': {}, './manufacturing-market': {}, './manufacturing-estimate': calculator, './manufacturing-stock': stock }, { AbortSignal: signalFacade });
  const planning = load(planningCode, { './eve': { EveError }, './manufacturing-market': {}, './manufacturing-assessment': api }, { AbortSignal: signalFacade });
  const factory = planning.createManufacturingPlanning(deps);
  return { compare: (input = batch(), controls) => factory.compare('synthetic-owner', input, controls), run: (input = batch(), controls) => factory.plan('synthetic-owner', input, controls), calls, marketCalls, timeoutValues, schema: planning.manufacturingPlanningInputSchema, validate: planning.validateManufacturingPlanningInput };
}
function batch(count=2) {
  const {blueprintTypeId,blueprintSource,blueprintItemId,plan,...context} = clone(request);
  return {context,jobs:Array.from({length:count},(_,i)=>({key:'job'+i,blueprintTypeId,blueprintSource,blueprintItemId,plan:clone(plan)}))};
}

test('combined stock and wallet are allocated once with aggregate shopping quantities', async () => {
  const h = harness(), result = await h.run();
  assert.equal(result.kind, 'manufacturing_production_plan');
  assert.deepEqual(plain(result.shoppingList.map(row => [row.typeId, row.requiredQuantity, row.ownedAllocatedQuantity, row.missingQuantity, row.purchaseISK])), [[101, 36, 8, 28, '56.00'], [102, 4, 2, 2, '10.00']]);
  assert.equal(result.totals.materialCashISK, '66.00');
  assert.equal(result.totals.cashRequiredISK, '82.00');
  assert.equal(result.totals.walletISK, '30.00');
  assert.equal(result.totals.affordable, false);
  assert.equal(result.readiness, 'blocked');
  assert.equal(result.totals.netRevenueISK, '144.00');
  assert.equal(result.totals.economicProfitISK, '39.40');
  assert.deepEqual(plain(result.jobs.map(row => row.allocatedMaterials.map(material => material.ownedAllocatedQuantity))), [[8, 2], [0, 0]]);
  assert.equal(h.calls.filter(call => call.input?.dataset === 'assets').length, 1);
  assert.equal(h.calls.filter(call => call.input?.dataset === 'wallet_balance').length, 1);
  assert.equal(h.calls.filter(call => call.entity === 'connections').length, 1);
  assert(!JSON.stringify(result).includes('OMIT_PRIVATE_FIXTURE_MARKER'));
  assert(!JSON.stringify(result).includes('ownOrderIds'));
  assert(!JSON.stringify(result).includes('7001'));
});

test('comparison keeps independent individually affordable alternatives separate', async () => {
  const result = await harness().compare();
  assert.equal(result.kind, 'manufacturing_comparison');
  assert.deepEqual(plain(result.alternatives.map(row => row.rank)), [1, 2]);
  assert(result.alternatives.every(row => row.assessment.estimate.eligibility.wallet.instantScenarioAffordable === true));
  assert(result.conditions.some(value => /never establishes joint affordability/.test(value)));
  assert(!Object.hasOwn(result, 'totals'));
});

test('a copy with individually sufficient runs cannot be reused beyond total remaining runs', async () => {
  const h = harness({read: (_entity,args,value) => { if(args.dataset==='blueprints') value.data[0].runs=2; return value; }});
  const result = await h.run();
  assert.equal(result.readiness, 'blocked');
  assert.deepEqual(plain(result.jobs.map(row=>row.copyRunsAllocated)), [2,0]);
  assert(result.jobs.every(row=>row.copyRuns.overcommitted===true));
  assert(result.conditions.some(value=>/overcommit/.test(value)));
});

test('unavailable blueprint evidence never authorizes a supplied copy run count', async () => {
  const request = batch(); request.jobs.forEach(job=>{job.blueprintSource='prospective';delete job.blueprintItemId; job.plan.blueprint={kind:'copy',remainingRuns:999,accessConfirmed:true};});
  const result = await harness().run(request);
  assert(result.jobs.every(row=>row.copyRuns.status==='unavailable'&&row.copyRunsAllocated===null));
});

test('combined actual output depth is quoted for total output and cannot be counted twice', async () => {
  const h = harness({quote: (input,_controls,value)=>{
    if(input.typeId===201 && input.quantity>4) { value.filledQuantity=4;value.unfilledQuantity=input.quantity-4;value.coverage='partial';value.estimateReady=false;value.grossISK='80.00';value.priceLevels=[{priceISK:'20.00',quantity:4,minimumFill:1}]; }
    return value;
  }});
  const independent = await h.compare(); assert(independent.alternatives.every(row=>row.assessment.estimate.instantSale.complete));
  const result = await h.run();
  assert.equal(result.outputs[0].quantity,8); assert.equal(result.outputs[0].coverage,'partial');
  assert.equal(result.outputs[0].grossRevenueISK,null); assert.equal(result.totals.netRevenueISK,null); assert.equal(result.totals.economicProfitISK,null);
  assert(h.marketCalls.some(call=>call.kind==='quote'&&call.input.typeId===201&&call.input.quantity===8));
});

test('combined purchase depth cannot reuse the cheap units of independent alternatives', async () => {
  const h = harness({quote: (input,_controls,value)=>{
    if(input.typeId===101 && input.side==='buy_materials' && input.quantity===28) {value.grossISK='128.00';value.priceLevels=[{priceISK:'2.00',quantity:10,minimumFill:1},{priceISK:'6.00',quantity:18,minimumFill:1}];}
    return value;
  }});
  const result=await h.run();
  assert.equal(result.shoppingList[0].purchaseISK,'128.00');
  assert.equal(result.totals.materialCashISK,'138.00');
  assert.equal(result.jobs[0].assessment.estimate.materials[0].additionalPurchaseISK,'20.00');
  assert.equal(result.jobs[1].assessment.estimate.materials[0].additionalPurchaseISK,'108.00');
});

test('aggregate output price levels are split in job order with per-job tax assumptions', async () => {
  const input=batch();input.jobs[0].plan.sale.salesTaxRate='0';input.jobs[1].plan.sale.salesTaxRate='0.1';
  const h=harness({quote:(args,_controls,value)=>{
    if(args.typeId===201&&args.quantity===8){value.grossISK='120.00';value.priceLevels=[{priceISK:'20.00',quantity:4,minimumFill:4},{priceISK:'10.00',quantity:4,minimumFill:4}];}return value;
  }});
  const result=await h.run(input);
  assert.equal(result.outputs[0].grossRevenueISK,'120.00');
  assert.equal(result.jobs[0].assessment.estimate.instantSale.netRevenueISK,'80.00');
  assert.equal(result.jobs[1].assessment.estimate.instantSale.netRevenueISK,'36.00');
  assert.equal(result.totals.netRevenueISK,'116.00');
});

test('corrupt aggregate price levels cannot establish combined cash or profit', async () => {
  const h=harness({quote:(args,_controls,value)=>{if(args.typeId===101&&args.quantity===28)value.priceLevels[0].quantity=27;return value;}});
  const result=await h.run(); assert.equal(result.totals.materialCashISK,null);assert.equal(result.totals.affordable,null);assert.equal(result.totals.economicProfitISK,null);
});

test('the earliest evidence is rechecked after the final combined quote finishes', async () => {
  let time=now;
  const h=harness({now:()=>time,quote:(args,_controls,value)=>{if(args.typeId===201&&args.quantity===8)time=Date.parse(expiry);return value;}});
  const result=await h.run();
  assert.equal(result.generatedAt,new Date(expiry).toISOString());assert.equal(result.totals.walletISK,null);assert.equal(result.totals.materialCashISK,null);assert.equal(result.totals.netRevenueISK,null);
  assert(result.jobs.every(row=>row.copyRuns.status==='unavailable'));
  assert(result.jobs.every(row=>row.assessment.privateSources.every(source=>source.freshness==='stale')));
});

test('comparison rechecks first alternative evidence at the same completion as the last', async () => {
  let time=now,calls=0;
  const h=harness({now:()=>time,catalogStatus:()=>{calls++;if(calls===2)time=Date.parse(expiry);return {status:'current',checkedAt:stamp,cacheExpires:expiry};}});
  const result=await h.compare();
  assert(result.alternatives.every(row=>row.rank===null&&row.assessment.estimate.eligibility.wallet.availableISK===null));
  assert(result.alternatives.every(row=>row.assessment.generatedAt===result.generatedAt));
});

test('one missing explicit cash cost makes combined cash and affordability unknown', async () => {
  const input=batch();delete input.jobs[1].plan.overhead.haulingISK;
  const result=await harness().run(input);
  assert.equal(result.totals.jobAndOverheadCashISK,null);assert.equal(result.totals.cashRequiredISK,null);assert.equal(result.totals.affordable,null);assert.equal(result.totals.economicProfitISK,null);
});

test('corporation plan uses only its selected division and never merges personal funds', async () => {
  const input=batch();Object.assign(input.context,{resourceEntity:'corporation',walletDivision:3,hangarDivisions:[2,4]});
  const h=harness(),result=await h.run(input);
  assert.equal(result.totals.walletISK,'20.00');assert.equal(result.shoppingList[0].ownedAllocatedQuantity,8);
  assert(!h.calls.some(call=>call.input?.dataset==='wallet_balance'));
  assert(!h.calls.some(call=>call.entity==='character'&&call.input?.dataset==='assets'));
});

test('corporation membership changes across cached batch evidence are rejected', async () => {
  const input=batch();Object.assign(input.context,{resourceEntity:'corporation',walletDivision:3,hangarDivisions:[2,4]});input.jobs[1].blueprintPage=2;
  const h=harness({read:(entity,args,value)=>{if(entity==='corporation'&&args.parameters?.page===2)value.corporationId=98000002;return value;}});
  await assert.rejects(h.run(input),error=>error.status===409);
});

test('other characters cannot supply planning evidence', async () => {
  const h=harness({connections:[{characterId:90000002}]}); await assert.rejects(h.run(),error=>error.status===404);assert(!h.calls.some(call=>call.input));
});

test('wrong-owner evidence is rejected even when the page is cached for other jobs', async () => {
  const h=harness({read:(_entity,args,value)=>{if(args.dataset==='assets')value.characterId=90000002;return value;}});
  await assert.rejects(h.run(),error=>error.status===502);
});

test('pre-cancelled requests perform no private reads', async () => {
  const abort=new AbortController();abort.abort();const h=harness();await assert.rejects(h.run(batch(),{signal:abort.signal}));assert.equal(h.calls.length,0);
});

test('a shared deadline aborts a non-cooperative owner lookup and every job', async () => {
  const abort=new AbortController(),h=harness({deadlineSignal:abort.signal,connections:()=>new Promise(()=>{})});
  const pending=h.run();abort.abort(new Error('Synthetic planning deadline'));await assert.rejects(pending,/Synthetic planning deadline/);
  assert(h.timeoutValues.every(value=>value===55000));
});

test('cancellation propagates to aggregate market reads', async () => {
  const abort=new AbortController();let aggregate=false;
  const h=harness({quote:(args,controls,value)=>{if(args.typeId===201&&args.quantity===8){aggregate=true;abort.abort();controls.signal.throwIfAborted();}return value;}});
  await assert.rejects(h.run(batch(),{signal:abort.signal}));assert(aggregate);
});

test('strict bounded context and unique keys reject mixed owner or client evidence fields', () => {
  const h=harness();
  for(const mutate of [input=>input.jobs.push(...clone(input.jobs),...clone(input.jobs)),input=>input.jobs[1].key=input.jobs[0].key,input=>input.jobs[0].walletISK='999',input=>input.jobs[0].characterId=90000002,input=>input.context.plan=clone(request.plan),input=>input.context.walletDivision=1,input=>input.jobs[0].key='private text']){
    const input=batch();mutate(input);assert.throws(()=>h.validate(input));
  }
});

test('planned output is never credited to input inventory or upfront funding', async () => {
  const input=batch();
  const outputAsInput={...clone(recipe),products:[{typeId:101,name:'Synthetic input A',quantity:2}]};
  const result=await harness({recipe:outputAsInput}).run(input);
  assert.equal(result.shoppingList[0].missingQuantity,28);assert.equal(result.totals.walletISK,'30.00');assert.equal(result.totals.affordable,false);
});

test('one physical blueprint cannot become another run pool through inconsistent selected pages', async () => {
  const input=batch();input.jobs[1].blueprintPage=2;
  const h=harness({read:(_entity,args,value)=>{if(args.dataset==='blueprints') {value.pagination.pages=2;if(args.parameters?.page===2){value.data[0].quantity=-1;value.data[0].runs=-1;}}return value;}});
  const result=await h.run(input);
  assert(result.jobs.every(row=>row.copyRuns.status==='unavailable'&&row.copyRunsAllocated===null));
  assert(result.conditions.some(value=>/inconsistent/.test(value)));
});

test('unreviewed own orders preserve verified stock consistently without enabling prices or profit', async () => {
  const input = batch(); input.context.otherOwnedOrdersReviewed = false;
  const h = harness({ read: (_entity, args, value) => {
    if (args.dataset === 'blueprints') { value.data[0].quantity = -1; value.data[0].runs = -1; }
    return value;
  } });
  const result = await h.run(input);
  assert.deepEqual(plain(result.shoppingList.map(row => [row.ownedAllocatedQuantity, row.missingQuantity])), [[8, 28], [2, 2]]);
  for (const job of result.jobs) {
    assert.equal(job.assessment.marketStationVerified, true);
    assert.equal(job.assessment.stockCoverage, 'complete-selected-verified-locations');
    assert.equal(job.assessment.ownOrdersComplete, false);
    assert.deepEqual(plain(job.assessment.estimate.materials.map(row => [row.ownedUsedQuantity, row.missingQuantity])), plain(job.allocatedMaterials.map(row => [row.ownedAllocatedQuantity, row.missingQuantity])));
    assert.equal(job.assessment.estimate.instantSale.netRevenueISK, null);
    assert.equal(job.assessment.estimate.instantSale.economicProfitISK, null);
  }
  assert.equal(result.totals.walletISK, '30.00');
  assert.equal(result.totals.materialCashISK, null);
  assert.equal(result.totals.cashRequiredISK, null);
  assert.equal(result.totals.affordable, null);
  assert.equal(result.totals.netRevenueISK, null);
  assert.equal(result.totals.economicProfitISK, null);
  assert(!JSON.stringify(result).includes('stationGeography'));
});

test('partial depth preserves known allocated materials while combined pricing stays unknown', async () => {
  const h = harness({ quote: (_args, _controls, value) => {
    value.coverage = 'partial'; value.estimateReady = false;
    value.filledQuantity = 0; value.unfilledQuantity = value.quantity; value.grossISK = '0.00'; value.priceLevels = [];
    return value;
  } });
  const result = await h.run();
  assert.deepEqual(plain(result.shoppingList.map(row => row.ownedAllocatedQuantity)), [8, 2]);
  assert(result.jobs.every(job => job.assessment.marketStationVerified && job.assessment.stockCoverage === 'complete-selected-verified-locations'));
  for (const job of result.jobs) assert.deepEqual(plain(job.assessment.estimate.materials.map(row => row.ownedUsedQuantity)), plain(job.allocatedMaterials.map(row => row.ownedAllocatedQuantity)));
  assert.equal(result.totals.materialCashISK, null);
  assert.equal(result.totals.affordable, null);
  assert.equal(result.totals.economicProfitISK, null);
});

test('stale order exclusions cannot enable prices even when geography and stock remain fresh', async () => {
  const h = harness({ read: (_entity, args, value) => { if (args.dataset === 'orders') value.cacheExpires = stamp; return value; } });
  const result = await h.run();
  assert(result.jobs.every(job => job.assessment.marketStationVerified && !job.assessment.ownOrdersComplete));
  assert(result.jobs.every(job => job.assessment.stockCoverage === 'complete-selected-verified-locations'));
  assert.equal(result.totals.walletISK, '30.00');
  assert.equal(result.totals.cashRequiredISK, null);
  assert.equal(result.totals.economicProfitISK, null);
});

test('retained geography expires at final batch completion despite still-fresh private evidence', async () => {
  let time = now;
  const geographyExpiry = new Date(now + 1000).toISOString();
  const h = harness({ now: () => time, quote: (args, _controls, value) => {
    value.sources[0].cacheExpires = geographyExpiry;
    if (args.typeId === 201 && args.quantity === 8) time = now + 1000;
    return value;
  } });
  const result = await h.run();
  assert(result.jobs.every(job => job.assessment.privateSources.every(source => source.freshness === 'fresh')));
  assert(result.jobs.every(job => !job.assessment.marketStationVerified && job.assessment.stockCoverage === 'unknown'));
  assert(result.shoppingList.every(row => row.ownedAllocatedQuantity === null && row.missingQuantity === null));
  assert(result.jobs.every(job => job.assessment.estimate.materials.every(row => row.ownedUsedQuantity === null && row.missingQuantity === null)));
  assert.equal(result.totals.walletISK, '30.00');
  assert.equal(result.totals.cashRequiredISK, null);
  assert.equal(result.totals.economicProfitISK, null);
});

for (const [name, change] of [
  ['a different station', value => { value.stationId++; }],
  ['missing source provenance', value => { value.sources = []; }],
]) test(`retained geography cannot credit stock from ${name}`, async () => {
  const result = await harness({ quote: (_args, _controls, value) => { change(value); return value; } }).run();
  assert(result.jobs.every(job => !job.assessment.marketStationVerified && job.assessment.stockCoverage === 'unknown'));
  assert(result.shoppingList.every(row => row.ownedAllocatedQuantity === null && row.missingQuantity === null));
  assert(result.jobs.every(job => job.assessment.estimate.materials.every(row => row.ownedUsedQuantity === null)));
  assert.equal(result.totals.affordable, null);
  assert.equal(result.totals.economicProfitISK, null);
});
