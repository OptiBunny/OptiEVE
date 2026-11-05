import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const compile = name => ts.transpileModule(readFileSync(`app/lib/${name}.ts`, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const code = compile('manufacturing-assessment'), calculatorCode = compile('manufacturing-estimate'), stockCode = compile('manufacturing-stock');
const plain = value => JSON.parse(JSON.stringify(value));
const clone = value => structuredClone(value);
const now = Date.parse('2026-01-01T00:00:00Z'), stamp = new Date(now).toISOString(), expiry = '2026-01-01T01:00:00Z';
const publicSource = { url: 'https://esi.evetech.net/latest/markets/prices/', retrievedAt: stamp, cacheExpires: expiry, lastModified: stamp, cacheControl: 'public, max-age=3600' };
const characterId = 90000001, corporationId = 98000001, stationId = 60000001, officeId = 8001;
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
const corpRequest = () => ({ ...clone(request), resourceEntity: 'corporation', walletDivision: 3, hangarDivisions: [2, 4] });
const asset = (itemId, typeId, quantity, flag = 'Hangar', locationId = stationId, overrides = {}) => ({ item_id: itemId, type_id: typeId, quantity, location_id: locationId, location_type: locationId === stationId ? 'station' : 'item', location_flag: flag, is_singleton: false, private_marker: 'OMIT_PRIVATE_FIXTURE_MARKER', ...overrides });
function frame(entity, input, legacy = false) {
  const dataset = input.dataset, page = input.parameters?.page ?? input.page ?? 1;
  let data;
  if (dataset === 'blueprints') data = [{ item_id: 5001, type_id: 10001, location_id: stationId, quantity: -2, runs: 2, material_efficiency: 10, time_efficiency: 20, private_marker: 'OMIT_PRIVATE_FIXTURE_MARKER' }];
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
      const value = { ...input, regionId: input.regionId, stationId: input.stationId, solarSystemId: 30000001, grossISK: (unit * input.quantity).toFixed(2), filledQuantity: input.quantity, unfilledQuantity: 0, coverage: 'complete', completePages: true, exclusionsVerified: input.ownOrdersComplete, estimateReady: input.ownOrdersComplete, sourceFreshness: 'fresh', generatedAt: stamp, validUntil: expiry, sources: [clone(publicSource)] };
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
  return { run: (input = clone(request), controls) => api.createManufacturingAssessment(deps)('synthetic-owner', input, controls), calls, marketCalls, timeoutValues, schema: api.manufacturingAssessmentInputSchema };
}

test('assessment resolves owned blueprint ME/copy runs and uses actual calculator economics', async () => {
  const h = harness(), result = await h.run();
  assert.equal(result.estimate.requirements.materialEfficiency, 10);
  assert.equal(result.estimate.assumptions.blueprint.kind, 'copy');
  assert.equal(result.estimate.assumptions.blueprint.remainingRuns, 2);
  assert.equal(result.estimate.instantSale.economicProfitISK, '26.40');
  assert.equal(result.estimate.costs.cashRequiredISK, '28.00');
  assert.equal(result.estimate.eligibility.wallet.availableISK, '30.00');
  assert.match(result.walletPrecisionPolicy, /decimal representation of the received numeric balance, floored to whole ISK cents with integer arithmetic/);
  assert.match(result.walletPrecisionPolicy, /Sub-cent fractions are discarded; malformed or out-of-range balances remain unknown/);
  assert.equal(result.stockCoverage, 'complete-selected-verified-locations');
  assert.equal(result.ownOrdersComplete, true);
  assert(!JSON.stringify(result).includes('OMIT_PRIVATE_FIXTURE_MARKER'));
  assert.deepEqual(h.timeoutValues, [55000]);
});

test('corporation funding uses only selected wallet division and selected CorpSAG hangars', async () => {
  const h = harness(), result = await h.run(corpRequest());
  assert.equal(result.estimate.eligibility.wallet.availableISK, '20.00');
  assert.equal(result.estimate.eligibility.wallet.instantScenarioAffordable, false);
  assert.equal(result.estimate.eligibility.readiness, 'blocked');
  assert.equal(result.estimate.materials[0].ownedAvailableQuantity, 8);
  assert.deepEqual(plain(result.stockBySelectedDivision), { 2: { 101: 6, 102: 2 }, 4: { 101: 2 } });
  assert(!h.calls.some(call => call.input?.dataset === 'wallet_balance'));
  assert(!h.calls.some(call => call.entity === 'character' && call.input?.dataset === 'assets'));
  assert.equal(result.selectedWalletDivision, 3);
});

test('explicit one-hop corporation offices count only selected direct division stock', async () => {
  const input = corpRequest(); input.stockLocationIds = [officeId];
  const h = harness({ read: (entity, args, value) => {
    if (entity === 'corporation' && args.dataset === 'assets') value.data = [
      asset(officeId, 999, 1, 'OfficeFolder', stationId, { is_singleton: true }),
      asset(1001, 101, 8, 'CorpSAG2', officeId), asset(1002, 102, 2, 'CorpSAG4', officeId),
      asset(1003, 101, 999, 'CorpSAG1', officeId), asset(1004, 101, 999, 'CorpSAG2', stationId),
      asset(8002, 999, 1, 'CorpSAG2', officeId, { is_singleton: true }), asset(1005, 998, 999, 'Unlocked', 8002),
    ];
    return value;
  } });
  const result = await h.run(input);
  assert.equal(result.estimate.materials[0].ownedAvailableQuantity, 8);
  assert.equal(result.estimate.materials[1].ownedAvailableQuantity, 2);
  const unknownLocation = clone(input); unknownLocation.stockLocationIds = [8003];
  const refused = await h.run(unknownLocation);
  assert.equal(refused.stockCoverage, 'unknown');
  assert.equal(refused.estimate.materials[0].ownedAvailableQuantity, null);
});

test('unverified stock locations and non-hangar assets never inflate usable materials', async () => {
  const h = harness({ read: (entity, args, value) => {
    if (args.dataset === 'assets') value.data.push(asset(1003, 101, 999, 'Cargo'), asset(1004, 101, 1, 'Hangar', stationId, { is_singleton: true }), asset(1005, 101, 999, 'Hangar', stationId, { is_blueprint_copy: true }));
    return value;
  } });
  assert.equal((await h.run()).estimate.materials[0].ownedAvailableQuantity, null);
  const input = clone(request); input.stockLocationIds = [60000002];
  assert.equal((await h.run(input)).stockCoverage, 'unknown');
});

test('supported nested unlocked materials inherit the selected corporation division without double counting', async () => {
  const input = corpRequest(); input.stockLocationIds = [officeId, 8002];
  const h = harness({ read: (entity, args, value) => {
    if (args.dataset === 'assets') value.data = [
      asset(officeId, 999, 1, 'OfficeFolder', stationId, { is_singleton: true }),
      asset(8002, 999, 1, 'CorpSAG2', officeId, { is_singleton: true }),
      asset(8003, 999, 1, 'Unlocked', 8002, { is_singleton: true }),
      asset(1001, 101, 8, 'Unlocked', 8003), asset(1002, 102, 2, 'CorpSAG4', officeId),
    ];
    return value;
  } });
  const result = await h.run(input);
  assert.equal(result.estimate.materials[0].ownedAvailableQuantity, 8);
  assert.equal(result.stockBySelectedDivision['2']['101'], 8);
  assert.equal(result.estimate.instantSale.economicProfitISK, '26.40');
});

test('private structure stock requires same-system resolution and explicit location selection', async () => {
  const structureId = 1000000000001, input = clone(request); input.manufacturingStructureId = structureId; input.stockLocationIds = [structureId];
  for (const system of [30000001, 30000002]) {
    const h = harness({ read: (entity, args, value) => {
      if (args.dataset === 'structure') value.data.solar_system_id = system;
      if (args.dataset === 'assets') value.data.forEach(row => { row.location_id = structureId; });
      return value;
    } });
    const result = await h.run(input);
    assert.equal(result.structureSystemVerified, system === 30000001);
    assert.equal(result.estimate.materials[0].ownedAvailableQuantity, system === 30000001 ? 8 : null);
  }
});

test('unverified market geography never credits otherwise complete fully owned stock', async () => {
  const h = harness({
    read: (entity, args, value) => { if (args.dataset === 'assets') value.data = [asset(1001, 101, 18), asset(1002, 102, 2)]; return value; },
    quote: () => { throw new Error('Synthetic public station validation unavailable'); },
  });
  const result = await h.run();
  assert.equal(result.marketStationVerified, false);
  assert.equal(result.stockCoverage, 'unknown');
  assert.equal(result.estimate.materials[0].ownedAvailableQuantity, null);
  assert.equal(result.estimate.costs.cashRequiredISK, null);
  assert.equal(result.estimate.eligibility.wallet.instantScenarioAffordable, null);
});

test('a quote for a different station cannot establish stock geography or buy-all profit', async () => {
  const h = harness({ quote: (args, controls, value) => ({ ...value, stationId: stationId + 1 }) });
  const result = await h.run();
  assert.equal(result.marketStationVerified, false);
  assert.equal(result.estimate.materials[0].ownedAvailableQuantity, null);
  assert.equal(result.estimate.instantSale.economicProfitISK, null);
  assert.equal(result.estimate.instantSale.buyAllProfitISK, null);
});

test('failed, truncated, duplicate or unstable asset pages leave stock unknown, never zero', async () => {
  for (const mutate of [
    () => { throw new Error('synthetic unavailable'); },
    value => { value.pagination.pages = 4; },
    value => { delete value.pagination.pages; },
    value => { value.data.push(clone(value.data[0])); },
    value => { value.data[0].quantity = -1; },
    value => { value.data[0].is_singleton = undefined; },
  ]) {
    const h = harness({ read: (entity, args, value) => { if (args.dataset === 'assets') mutate(value); return value; } });
    const input = clone(request); input.maxPrivatePages = 1;
    const result = await h.run(input);
    assert.equal(result.stockCoverage, 'unknown');
    assert.equal(result.estimate.materials[0].ownedAvailableQuantity, null);
    assert.equal(result.estimate.costs.cashRequiredISK, null);
    assert.deepEqual(plain(result.stockBySelectedDivision), {});
  }
});

test('complete empty stock is zero, while buy-all mode never reads private assets', async () => {
  const h = harness({ read: (entity, args, value) => { if (args.dataset === 'assets') value.data = []; return value; } });
  assert.equal((await h.run()).estimate.materials[0].ownedAvailableQuantity, 0);
  const input = clone(request); input.useOwnedMaterials = false; delete input.stockLocationIds;
  const g = harness(), result = await g.run(input);
  assert.equal(result.estimate.materials[0].ownedAvailableQuantity, 0);
  assert(!g.calls.some(call => call.input?.dataset === 'assets'));
});

test('explicit higher private page budget fetches beyond five pages without silently truncating stocks', async () => {
  const input = clone(request); input.maxPrivatePages = 6;
  const h = harness({ read: (entity, args, value) => {
    if (args.dataset === 'assets') {
      const page = args.parameters.page; value.pagination.pages = 6;
      value.data = page === 6 ? [asset(1001, 101, 8), asset(1002, 102, 2)] : [asset(10000 + page, 999, 1)];
    }
    return value;
  } });
  const result = await h.run(input);
  assert.equal(result.estimate.materials[0].ownedAvailableQuantity, 8);
  assert.equal(h.calls.filter(call => call.input?.dataset === 'assets').length, 6);
});

test('prospective and absent owned blueprints do not establish ownership, while active levels override trained ones', async () => {
  const input = clone(request); input.blueprintSource = 'prospective'; delete input.blueprintItemId;
  const h = harness(), result = await h.run(input);
  assert.equal(result.estimate.assumptions.blueprint.kind, 'unknown');
  assert.equal(result.estimate.eligibility.blueprint, 'unconfirmed');
  assert.equal(result.estimate.requirements.materialEfficiency, 0);
  assert(!h.calls.some(call => call.input?.dataset === 'blueprints'));
  const g = harness({ read: (entity, args, value) => {
    if (args.dataset === 'blueprints') value.data = [];
    if (args.dataset === 'skills') value.data.skills[0].active_skill_level = 1;
    return value;
  } });
  const unknown = await g.run();
  assert.equal(unknown.estimate.eligibility.blueprint, 'unconfirmed');
  assert.equal(unknown.estimate.eligibility.skills.status, 'missing');
  assert.equal(unknown.estimate.eligibility.skills.requirements[0].activeLevel, 1);
});

test('owned blueprint copies with insufficient runs block readiness and type mismatches fail safely', async () => {
  const h = harness({ read: (entity, args, value) => { if (args.dataset === 'blueprints') value.data[0].runs = 1; return value; } });
  assert.equal((await h.run()).estimate.eligibility.blueprint, 'insufficient_copy_runs');
  const g = harness({ read: (entity, args, value) => { if (args.dataset === 'blueprints') value.data[0].type_id = 999; return value; } });
  await assert.rejects(g.run(), error => error.status === 502);
});

test('own character, corporation and explicitly reviewed additional orders are excluded from every quote', async () => {
  const input = corpRequest(); input.additionalOwnedOrderIds = [7003, 7001];
  const h = harness(), result = await h.run(input);
  assert.equal(result.ownOrdersComplete, true);
  for (const call of h.marketCalls.filter(call => call.kind === 'quote')) {
    assert.deepEqual([...call.input.excludeOrderIds].sort(), [7001, 7002, 7003]);
    assert.equal(call.input.ownOrdersComplete, true);
  }
  assert(h.calls.some(call => call.legacy && call.entity === 'corporation'));
});

test('unreviewed, duplicate or incomplete own orders disable full-profit claims', async () => {
  const input = clone(request); input.otherOwnedOrdersReviewed = false;
  assert.equal((await harness().run(input)).estimate.instantSale.economicProfitISK, null);
  for (const mutate of [value => { value.data.push(clone(value.data[0])); }, value => { value.data[0].order_id = 0; }]) {
    const h = harness({ read: (entity, args, value) => { if (entity === 'character' && args.dataset === 'orders') mutate(value); return value; } });
    assert.equal((await h.run()).ownOrdersComplete, false);
  }
  const h = harness({ read: (entity, args, value, signal, legacy) => { if (legacy) value.pages = 6; return value; } });
  const result = await h.run(corpRequest());
  assert.equal(result.ownOrdersComplete, false);
  assert.equal(result.estimate.instantSale.economicProfitISK, null);
});

test('a duplicate returned own order is invalid even when also supplied as an additional exclusion', async () => {
  const input = clone(request); input.additionalOwnedOrderIds = [7001];
  const h = harness({ read: (entity, args, value) => { if (entity === 'character' && args.dataset === 'orders') value.data.push(clone(value.data[0])); return value; } });
  const result = await h.run(input);
  assert.equal(result.ownOrdersComplete, false);
  assert.equal(result.estimate.instantSale.economicProfitISK, null);
});

test('character and selected corporation wallets floor sub-cent balances without losing decimal cents', async () => {
  const cases = [
    [1234.5678, '1234.56'], [1.9999, '1.99'], [1.005, '1.00'], [1.0099, '1.00'], [1.15, '1.15'],
    [0.0099, '0.00'], [1e-7, '0.00'], [Number.MIN_VALUE, '0.00'], [0, '0.00'],
    [999999999999.9999, '999999999999.99'], [1e12, '1000000000000.00'],
  ];
  for (const resourceEntity of ['character', 'corporation']) {
    for (const [balance, expected] of cases) {
      const input = resourceEntity === 'corporation' ? corpRequest() : clone(request);
      const h = harness({ read: (entity, args, value) => {
        if (args.dataset === 'wallet_balance') value.data = balance;
        if (args.dataset === 'wallet_balances') value.data = [{ division: 1, balance: 1e12 }, { division: 3, balance }];
        return value;
      } });
      const result = await h.run(input);
      assert.equal(result.estimate.eligibility.wallet.availableISK, expected, `${resourceEntity}: ${balance}`);
      if (resourceEntity === 'corporation') {
        assert.equal(result.selectedWalletDivision, 3);
        assert(!h.calls.some(call => call.input?.dataset === 'wallet_balance'));
      }
    }
  }
});

test('sub-cent funds never round up across the actual scenario affordability boundary', async () => {
  for (const resourceEntity of ['character', 'corporation']) {
    for (const [balance, expected, affordable] of [[27.9999, '27.99', false], [28, '28.00', true], [28.0001, '28.00', true]]) {
      const input = resourceEntity === 'corporation' ? corpRequest() : clone(request);
      const h = harness({ read: (entity, args, value) => {
        if (args.dataset === 'wallet_balance') value.data = balance;
        if (args.dataset === 'wallet_balances') value.data = [{ division: 1, balance: 1e12 }, { division: 3, balance }];
        return value;
      } });
      const result = await h.run(input);
      assert.equal(result.estimate.costs.cashRequiredISK, '28.00');
      assert.equal(result.estimate.eligibility.wallet.availableISK, expected);
      assert.equal(result.estimate.eligibility.wallet.instantScenarioAffordable, affordable, `${resourceEntity}: ${balance}`);
      assert.equal(result.estimate.eligibility.readiness, affordable ? 'conditional' : 'blocked');
      if (resourceEntity === 'corporation') assert(!h.calls.some(call => call.input?.dataset === 'wallet_balance'));
    }
  }
});

test('invalid character and selected corporation balances remain unknown without another funding source', async () => {
  const invalid = [1000000000000.0001, NaN, Infinity, -Infinity, -0.0001, -1, '1234.5678', null, undefined, true, [], {}];
  for (const resourceEntity of ['character', 'corporation']) {
    for (const balance of invalid) {
      const input = resourceEntity === 'corporation' ? corpRequest() : clone(request);
      const h = harness({ read: (entity, args, value) => {
        if (args.dataset === 'wallet_balance') value.data = balance;
        if (args.dataset === 'wallet_balances') value.data = [{ division: 1, balance: 1e12 }, { division: 3, balance }];
        return value;
      } });
      const result = await h.run(input);
      assert.equal(result.estimate.eligibility.wallet.availableISK, null, `${resourceEntity}: ${String(balance)}`);
      assert.equal(result.estimate.eligibility.wallet.instantScenarioAffordable, null);
      if (resourceEntity === 'corporation') assert(!h.calls.some(call => call.input?.dataset === 'wallet_balance'));
    }
  }
});

test('selected wallet absence, duplicates or malformed envelopes remain unknown', async () => {
  for (const balances of [[], [{ division: 1, balance: 999 }], [{ division: 3, balance: 20 }, { division: 3, balance: 30 }], { division: 3, balance: 30 }, null]) {
    const h = harness({ read: (entity, args, value) => { if (args.dataset === 'wallet_balances') value.data = balances; return value; } });
    const result = await h.run(corpRequest());
    assert.equal(result.estimate.eligibility.wallet.availableISK, null);
    assert.equal(result.estimate.eligibility.wallet.instantScenarioAffordable, null);
    assert(!h.calls.some(call => call.input?.dataset === 'wallet_balance'));
  }
});

test('corporation membership changes and malformed private owner envelopes abort the assessment', async () => {
  const h = harness({ read: (entity, args, value) => { if (args.dataset === 'wallet_balances') value.corporationId = 98000002; return value; } });
  await assert.rejects(h.run(corpRequest()), error => error.status === 409);
  for (const mutate of [value => { value.characterId++; }, value => { value.dataset = 'unrelated'; }, value => { value.entity = 'corporation'; }, value => { value.retrievedAt = 'invalid'; }]) {
    const g = harness({ read: (entity, args, value) => { if (args.dataset === 'blueprints') mutate(value); return value; } });
    await assert.rejects(g.run(), error => error.status === 502);
  }
});

test('stale or unversioned private snapshots cannot authorize stock, wallet or own-order exclusions', async () => {
  for (const cacheExpires of ['2025-12-31T23:59:59Z', undefined]) {
    const h = harness({ read: (entity, args, value) => { value.cacheExpires = cacheExpires; return value; } });
    const result = await h.run();
    assert.equal(result.stockCoverage, 'unknown');
    assert.equal(result.estimate.eligibility.wallet.availableISK, null);
    assert.equal(result.ownOrdersComplete, false);
    assert.equal(result.estimate.instantSale.economicProfitISK, null);
  }
});

test('freshness is rechecked when the assessment finishes, after earlier snapshots expire', async () => {
  let time = now;
  const h = harness({ now: () => time, catalogStatus: () => { time = Date.parse(expiry) + 1; return { status: 'current', checkedAt: stamp, cacheExpires: expiry }; } });
  const result = await h.run();
  assert.equal(result.ownOrdersComplete, false);
  assert.equal(result.estimate.materials[0].ownedAvailableQuantity, null);
  assert.equal(result.estimate.eligibility.wallet.availableISK, null);
  assert.equal(result.estimate.instantSale.economicProfitISK, null);
});

test('stale or unversioned public quote provenance overrides a claimed fresh estimate-ready flag', async () => {
  for (const sources of [[{ ...publicSource, cacheExpires: stamp }], [{ ...publicSource, cacheExpires: null }], []]) {
    const h = harness({ quote: (args, controls, value) => { if (args.typeId === 201) value.sources = clone(sources); return value; } });
    const result = await h.run();
    assert.equal(result.estimate.instantSale.economicProfitISK, null);
    assert.equal(result.estimate.instantSale.complete, false);
    assert.equal(result.currentRecipeVerified, true);
  }
});

test('allocated market orders expiring during later reads cannot support profit despite fresh HTTP cache', async () => {
  let time = now;
  const h = harness({
    now: () => time,
    quote: (args, controls, value) => { if (args.typeId === 201) value.validUntil = new Date(now + 1000).toISOString(); return value; },
    catalogStatus: () => { time = now + 1001; return { status: 'current', checkedAt: stamp, cacheExpires: expiry }; },
  });
  const result = await h.run();
  assert.equal(result.currentRecipeVerified, true);
  assert.equal(result.ownOrdersComplete, true);
  assert.equal(result.estimate.eligibility.wallet.availableISK, '30.00');
  assert.equal(result.estimate.instantSale.economicProfitISK, null);
});

test('outdated, unknown and expired catalog status cannot support a full current-profit claim', async () => {
  for (const catalog of [{ status: 'update_required', cacheExpires: expiry }, { status: 'unknown', cacheExpires: expiry }, { status: 'current', cacheExpires: null }, { status: 'current', cacheExpires: stamp }]) {
    const h = harness({ catalogStatus: () => catalog });
    const result = await h.run();
    assert.equal(result.currentRecipeVerified, false);
    assert.equal(result.estimate.instantSale.economicProfitISK, null);
    assert.equal(result.estimate.eligibility.blueprint, 'unconfirmed');
    assert.equal(result.estimate.eligibility.wallet.availableISK, null);
  }
});

test('owned blueprint pagination must identify the requested page before claiming access', async () => {
  const h = harness({ read: (entity, args, value) => { if (args.dataset === 'blueprints') value.pagination.page = 2; return value; } });
  const result = await h.run();
  assert.equal(result.estimate.eligibility.blueprint, 'unconfirmed');
});

test('bounded schema refuses caller balances, recipes, stock, prices and malformed selectors before reads', async () => {
  const invalid = [
    { walletISK: '100000' }, { ownedQuantity: 999 }, { recipe }, { quotes: [] }, { outputPrice: '1000' },
    { walletDivision: 3 }, { maxPrivatePages: 51 }, { maxMarketPages: 5 }, { blueprintPage: 501 },
    { stockLocationIds: [] }, { stockLocationIds: [stationId, stationId] }, { additionalOwnedOrderIds: [1, 1] },
  ];
  for (const override of invalid) {
    const h = harness(); await assert.rejects(h.run({ ...clone(request), ...override }), error => error.status === 400);
    assert.equal(h.calls.length, 0);
  }
  const input = clone(request); input.plan.sale.marketPrices = [{ typeId: 101, price: '0' }];
  const h = harness(); await assert.rejects(h.run(input), error => error.status === 400); assert.equal(h.calls.length, 0);
  assert.equal(h.schema.additionalProperties, false);
});

test('unknown connected character and oversized recipes are rejected before private data fetches', async () => {
  const h = harness({ connections: [] }); await assert.rejects(h.run(), error => error.status === 404);
  assert.equal(h.calls.length, 1);
  const r = clone(recipe); r.materials = Array.from({ length: 13 }, (_, i) => ({ typeId: 100 + i, name: 'Synthetic bounded input', quantity: 1 }));
  const g = harness({ recipe: r }); await assert.rejects(g.run(), error => error.status === 400);
  assert.equal(g.calls.length, 1);
});

test('abort and deadline signals stop reads and prevent partial successful results', async () => {
  const controller = new AbortController(); controller.abort();
  const h = harness(); await assert.rejects(h.run(clone(request), { signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(h.calls.length, 0);
  assert.equal(h.marketCalls.length, 0);
  const deadline = new AbortController();
  const g = harness({ deadlineSignal: deadline.signal, read: (entity, args, value) => { if (args.dataset === 'skills') deadline.abort(new DOMException('Synthetic deadline', 'TimeoutError')); return value; } });
  await assert.rejects(g.run(), error => error.name === 'TimeoutError');
  assert.equal(g.marketCalls.length, 0);
});

test('hanging connection lookups and catalog checks are inside the abortable assessment deadline', { timeout: 1000 }, async () => {
  const deadline = new AbortController();
  const h = harness({ deadlineSignal: deadline.signal, connections: () => new Promise(() => {}) });
  const pending = h.run(); deadline.abort(new DOMException('Synthetic deadline', 'TimeoutError'));
  await assert.rejects(pending, error => error.name === 'TimeoutError');
  assert.equal(h.calls.length, 1);
  const second = new AbortController();
  const g = harness({ deadlineSignal: second.signal, catalogStatus: () => { second.abort(new DOMException('Synthetic deadline', 'TimeoutError')); return new Promise(() => {}); } });
  await assert.rejects(g.run(), error => error.name === 'TimeoutError');
});

test('pagination and public request bounds propagate and no service mutation is invoked', async () => {
  const input = clone(request); input.maxPrivatePages = 2; input.maxMarketPages = 4;
  const h = harness(), result = await h.run(input);
  assert.equal(result.estimate.instantSale.complete, true);
  assert(h.marketCalls.filter(call => call.kind === 'quote').every(call => call.input.maxPages === 4));
  assert(h.calls.filter(call => call.input).every(call => ['blueprints', 'skills', 'orders', 'assets', 'wallet_balance'].includes(call.input.dataset)));
  const history = h.marketCalls.find(call => call.kind === 'history');
  assert.equal(history.input.days, 30);
  assert.equal(history.input.typeId, 201);
});
