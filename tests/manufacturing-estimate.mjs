import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync('app/lib/manufacturing-estimate.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const fixtureModule = { exports: {} };
vm.runInNewContext(code, { module: fixtureModule, exports: fixtureModule.exports, Date });
const { manufacturingRequirements, estimateManufacturing, validateManufacturingPlan, manufacturingPlanSchema } = fixtureModule.exports;
const clone = value => structuredClone(value);
const plain = value => JSON.parse(JSON.stringify(value));
const recipe = {
  blueprintTypeId: 10001, blueprintName: 'Synthetic blueprint', activity: 'manufacturing',
  materials: [{ typeId: 101, name: 'Synthetic input A', quantity: 10 }, { typeId: 102, name: 'Synthetic input B', quantity: 1 }],
  products: [{ typeId: 201, name: 'Synthetic output', quantity: 2 }],
  skills: [{ typeId: 301, name: 'Synthetic skill', level: 2 }], timeSeconds: 120, maxProductionLimit: 1,
};
const plan = {
  runs: 2, materialEfficiency: 10, facilityMaterialMultiplier: '1',
  blueprint: { kind: 'copy', remainingRuns: 2, accessConfirmed: true }, facilityAccessConfirmed: true,
  sale: { salesTaxRate: '0.1', listedBrokerRate: '0.03', listedBrokerMinimumISK: '1', listedUnitPriceISK: '25' },
  job: { quotedInstallationISK: '4' },
  overhead: { haulingISK: '1', blueprintCashISK: '2', blueprintOpportunityISK: '3', otherCashISK: '1', otherOpportunityISK: '2' },
};
const quote = (typeId, quantity, side, grossISK, overrides = {}) => ({
  typeId, quantity, side, grossISK, regionId: 10000001, stationId: 60000001, solarSystemId: 30000001,
  filledQuantity: quantity, unfilledQuantity: 0, coverage: 'complete', completePages: true,
  exclusionsVerified: true, estimateReady: true, sourceFreshness: 'fresh', generatedAt: '2026-01-01T00:00:00Z', ...overrides,
});
const evidence = {
  materials: [
    { typeId: 101, ownedQuantity: 8, purchaseAll: quote(101, 18, 'buy_materials', '36.00'), purchaseMissing: quote(101, 10, 'buy_materials', '20.00'), sellOwned: quote(101, 8, 'sell_output', '8.00') },
    { typeId: 102, ownedQuantity: 2, purchaseAll: quote(102, 2, 'buy_materials', '10.00'), purchaseMissing: null, sellOwned: quote(102, 2, 'sell_output', '6.00') },
  ],
  output: quote(201, 4, 'sell_output', '80.00'), walletISK: '30',
  skills: { complete: true, levels: [{ typeId: 301, level: 3 }] }, industry: null,
};
const run = (p = clone(plan), e = clone(evidence), r = clone(recipe)) => estimateManufacturing(r, p, e);
const invalid = fn => assert.throws(fn, error => error.name === 'ManufacturingInputError' && error.status === 400);

test('whole-job requirements preserve output batches, base quantities and minimum one unit per run', () => {
  const result = manufacturingRequirements(recipe, plan);
  assert.deepEqual(plain(result.materials.map(row => [row.baseQuantity, row.requiredQuantity])), [[10, 18], [1, 2]]);
  assert.equal(result.product.quantity, 4);
  const r = clone(recipe); r.materials[0].quantity = 2;
  assert.equal(manufacturingRequirements(r, { runs: 5, materialEfficiency: 10, facilityMaterialMultiplier: '1' }).materials[0].requiredQuantity, 9);
  assert.equal(manufacturingRequirements(r, { runs: 5, materialEfficiency: 10, facilityMaterialMultiplier: '0.1' }).materials[0].requiredQuantity, 5);
});

test('exact rational materials avoid floating-point boundary overshoots and disclose conservative rounding', () => {
  const r = clone(recipe); r.materials[0].quantity = 100;
  const result = manufacturingRequirements(r, { runs: 1, materialEfficiency: 10, facilityMaterialMultiplier: '0.7' });
  assert.equal(result.materials[0].requiredQuantity, 63);
  assert.match(result.policy, /undocumented intermediate/);
  const p = { runs: 1, materialEfficiency: 0, facilityMaterialMultiplier: '0.630000000000000001' };
  assert.equal(manufacturingRequirements(r, p).materials[0].requiredQuantity, 64);
});

test('blueprint copy limit metadata never becomes a manufacturing run cap', () => {
  assert.equal(manufacturingRequirements(recipe, { ...plan, runs: 1000 }).runs, 1000);
});

test('cash, opportunity and replacement costs stay distinct; owned materials are not free', () => {
  const result = run();
  assert.equal(result.costs.additionalMaterialCashISK, '20.00');
  assert.equal(result.costs.ownedMaterialOpportunityISK, '12.60');
  assert.equal(result.costs.replacementMaterialCostISK, '46.00');
  assert.equal(result.costs.cashRequiredISK, '28.00');
  assert.equal(result.costs.economicCostISK, '45.60');
  assert.equal(result.costs.buyAllEconomicCostISK, '59.00');
  assert.equal(result.instantSale.netRevenueISK, '72.00');
  assert.equal(result.instantSale.economicProfitISK, '26.40');
  assert.equal(result.instantSale.buyAllProfitISK, '13.00');
  assert.equal(result.instantSale.complete, true);
  assert.equal(result.eligibility.readiness, 'conditional');
  assert.equal(result.eligibility.wallet.instantScenarioAffordable, true);
  assert.equal(result.materials[1].additionalPurchaseISK, '0.00');
});

test('listed scenario pays broker minimum, is hypothetical, and budgets fees upfront', () => {
  const result = run();
  assert.equal(result.listedSale.kind, 'hypothetical_listed_sale');
  assert.equal(result.listedSale.brokerFeeISK, '3.00');
  assert.equal(result.listedSale.economicProfitISK, '41.40');
  assert.equal(result.listedSale.upfrontCashRequiredISK, '31.00');
  assert.equal(result.eligibility.wallet.listedScenarioAffordable, false);
  assert.match(result.listedSale.warning, /not executable demand or realized profit/);
  const p = clone(plan); p.sale.listedBrokerMinimumISK = '5';
  assert.equal(run(p).listedSale.brokerFeeISK, '5.00');
});

test('listed subcent assumptions cannot lower fees by rounding revenue down first', () => {
  const p = clone(plan); p.sale.listedUnitPriceISK = '0.250025'; p.sale.salesTaxRate = '1'; p.sale.listedBrokerRate = '0'; p.sale.listedBrokerMinimumISK = '0';
  const result = run(p);
  assert.equal(result.listedSale.grossRevenueISK, '1.00');
  assert.equal(result.listedSale.salesTaxISK, '1.01');
  assert.equal(result.listedSale.netRevenueISK, '-0.01');
});

test('EIV uses undiscounted base inputs; all taxes apply to EIV rather than the indexed cost', () => {
  const p = clone(plan); p.job = { jobCostMultiplier: '0.5', facilityTaxRate: '0.01', sccSurchargeRate: '0.04', alphaTaxRate: '0.0025', additionalTaxRate: '0.02' };
  const e = clone(evidence); e.industry = { ready: true, costIndex: '0.1', adjustedPrices: [{ typeId: 101, adjustedPriceISK: '2' }, { typeId: 102, adjustedPriceISK: '3' }] };
  const result = run(p, e);
  assert.equal(result.costs.installation.mode, 'adjusted_price_model');
  assert.equal(result.costs.installation.estimatedItemValueISK, '46.00');
  assert.deepEqual(plain(result.costs.installation.breakdown), { systemCostISK: '2.30', facilityTaxISK: '0.46', sccSurchargeISK: '1.84', alphaTaxISK: '0.12', additionalTaxISK: '0.92' });
  assert.equal(result.costs.installation.totalISK, '5.64');
});

test('a supplied installation quote is an explicit assumption and needs no inferred tax defaults', () => {
  const result = run();
  assert.equal(result.costs.installation.mode, 'user_quote_assumption');
  assert.equal(result.costs.installation.totalISK, '4.00');
  assert.equal(result.costs.installation.breakdown, null);
  assert.equal(result.assumptions.job.sccSurchargeRate, null);
});

test('each unknown overhead prevents complete profit and cash affordability where applicable', () => {
  for (const field of Object.keys(plan.overhead)) {
    const p = clone(plan); delete p.overhead[field];
    const result = run(p);
    assert.equal(result.instantSale.economicProfitISK, null, field);
    assert.equal(result.instantSale.complete, false, field);
    assert(result.reasons.some(reason => reason.includes(field)));
    if (!field.includes('Opportunity')) assert.equal(result.eligibility.wallet.instantScenarioAffordable, null, field);
  }
});

test('unknown sales tax, broker fee or model inputs never quietly become zero', () => {
  const p = clone(plan); delete p.sale.salesTaxRate;
  assert.equal(run(p).instantSale.economicProfitISK, null);
  for (const field of ['listedBrokerRate', 'listedBrokerMinimumISK']) {
    const q = clone(plan); delete q.sale[field];
    assert.equal(run(q).listedSale.economicProfitISK, null);
    assert.equal(run(q).instantSale.economicProfitISK, '26.40');
  }
  const q = clone(plan); q.job = {};
  assert.equal(run(q).costs.installation.totalISK, null);
  assert.equal(run(q).instantSale.economicProfitISK, null);
});

test('no listed price means no hypothetical listed result and no irrelevant broker requirement', () => {
  const p = clone(plan); p.sale = { salesTaxRate: '0.1' };
  const result = run(p);
  assert.equal(result.listedSale, null);
  assert.equal(result.instantSale.complete, true);
  assert(!result.reasons.some(reason => reason.includes('Broker')));
});

test('incomplete, stale, nonexcluded, mismatched or insufficient depth cannot produce instant profit', () => {
  for (const overrides of [
    { estimateReady: false }, { coverage: 'partial' }, { completePages: false }, { exclusionsVerified: false },
    { sourceFreshness: 'stale' }, { filledQuantity: 3 }, { unfilledQuantity: 1 },
    { typeId: 999 }, { quantity: 3 }, { side: 'buy_materials' }, { stationId: 60000002 },
    { generatedAt: 'invalid' },
  ]) {
    const e = clone(evidence); Object.assign(e.output, overrides);
    const result = run(clone(plan), e);
    assert.equal(result.instantSale.economicProfitISK, null, JSON.stringify(overrides));
    assert.equal(result.instantSale.complete, false);
  }
});

test('owned liquidation depth is necessary for economic profit, not for cash budget', () => {
  const e = clone(evidence); e.materials[0].sellOwned = null;
  const result = run(clone(plan), e);
  assert.equal(result.costs.cashRequiredISK, '28.00');
  assert.equal(result.costs.ownedMaterialOpportunityISK, null);
  assert.equal(result.instantSale.economicProfitISK, null);
  assert.equal(result.instantSale.buyAllProfitISK, '13.00');
});

test('unknown scoped assets cannot become zero ownership, and excess stock is capped at the job', () => {
  const e = clone(evidence); e.materials[0].ownedQuantity = null;
  const result = run(clone(plan), e);
  assert.equal(result.materials[0].missingQuantity, null);
  assert.equal(result.costs.cashRequiredISK, null);
  assert.equal(result.instantSale.buyAllProfitISK, '13.00');
  const f = clone(evidence); f.materials[1].ownedQuantity = 1000;
  assert.equal(run(clone(plan), f).materials[1].ownedUsedQuantity, 2);
});

test('zero ownership needs no liquidation quote; zero deficit needs no purchase quote', () => {
  const e = clone(evidence); e.materials[0].ownedQuantity = 0; e.materials[0].sellOwned = null; e.materials[0].purchaseMissing = e.materials[0].purchaseAll;
  const result = run(clone(plan), e);
  assert.equal(result.materials[0].ownedOpportunityISK, '0.00');
  assert.equal(result.materials[1].additionalPurchaseISK, '0.00');
  assert.equal(result.instantSale.complete, true);
});

test('unconfirmed blueprint/facility and skill coverage keep numeric economics conditional', () => {
  const p = clone(plan); p.blueprint = { kind: 'unknown', accessConfirmed: false }; p.facilityAccessConfirmed = false;
  const e = clone(evidence); e.skills = null;
  const result = run(p, e);
  assert.equal(result.instantSale.economicProfitISK, '26.40');
  assert.equal(result.eligibility.readiness, 'unconfirmed');
  assert.equal(result.eligibility.blueprint, 'unconfirmed');
  assert.equal(result.eligibility.skills.status, 'unknown');
});

test('copy runs, active skill levels and wallet deficits block readiness without rewriting economics', () => {
  const p = clone(plan); p.blueprint.remainingRuns = 1;
  assert.equal(run(p).eligibility.blueprint, 'insufficient_copy_runs');
  assert.equal(run(p).eligibility.readiness, 'blocked');
  const e = clone(evidence); e.skills.levels[0].level = 1;
  assert.equal(run(clone(plan), e).eligibility.skills.status, 'missing');
  e.skills.levels = [];
  assert.equal(run(clone(plan), e).eligibility.skills.requirements[0].activeLevel, 0);
  e.skills.complete = false;
  assert.equal(run(clone(plan), e).eligibility.skills.requirements[0].activeLevel, null);
  const f = clone(evidence); f.walletISK = '27.99';
  assert.equal(run(clone(plan), f).eligibility.readiness, 'blocked');
  f.walletISK = '28';
  assert.equal(run(clone(plan), f).eligibility.wallet.instantScenarioAffordable, true);
});

test('missing, stale or duplicate adjusted prices never produce a complete installation model', () => {
  const p = clone(plan); p.job = { jobCostMultiplier: '1', facilityTaxRate: '0', sccSurchargeRate: '0', alphaTaxRate: '0', additionalTaxRate: '0' };
  const e = clone(evidence); e.industry = { ready: true, costIndex: '0.1', adjustedPrices: [{ typeId: 101, adjustedPriceISK: '2' }] };
  assert.equal(run(p, e).costs.installation.totalISK, null);
  e.industry.ready = false;
  assert.equal(run(p, e).costs.installation.totalISK, null);
  e.industry.ready = true; e.industry.adjustedPrices.push(e.industry.adjustedPrices[0]);
  invalid(() => run(p, e));
});

test('unsafe inputs, precision loss, exponents, unknown fields and unsupported recipes are rejected', () => {
  for (const overrides of [
    { runs: 0 }, { runs: 1.5 }, { runs: 1_000_001 }, { materialEfficiency: 11 }, { materialEfficiency: -1 },
    { facilityMaterialMultiplier: '0' }, { facilityMaterialMultiplier: '1.01' }, { facilityMaterialMultiplier: 0.9 },
    { facilityMaterialMultiplier: '1e-2' }, { facilityMaterialMultiplier: '0.1234567890123456789' }, { unexpected: true },
  ]) invalid(() => validateManufacturingPlan({ ...clone(plan), ...overrides }));
  for (const value of ['-1', 'NaN', 'Infinity', '1e3', '01', ' 1', '1.0000000000000000001', 1]) {
    const p = clone(plan); p.overhead.haulingISK = value; invalid(() => run(p));
  }
  const p = clone(plan); p.sale.salesTaxRate = '1.01'; invalid(() => run(p));
  const r = clone(recipe); r.products.push({ typeId: 202, name: 'Other output', quantity: 1 }); invalid(() => run(clone(plan), clone(evidence), r));
  const q = clone(recipe); q.materials[0].quantity = 1_000_000_000_000; invalid(() => manufacturingRequirements(q, { ...plan, runs: 1_000_000 }));
});

test('strict plan schema and explicit projections omit unrecognized evidence fields', () => {
  assert.equal(manufacturingPlanSchema.additionalProperties, false);
  assert.equal(manufacturingPlanSchema.properties.job.additionalProperties, false);
  const e = clone(evidence); e.private_marker = 'OMIT_SYNTHETIC_PRIVATE_FIELD'; e.materials[0].private_marker = 'OMIT_SYNTHETIC_PRIVATE_FIELD'; e.output.private_marker = 'OMIT_SYNTHETIC_PRIVATE_FIELD';
  const result = run(clone(plan), e);
  assert(!JSON.stringify(result).includes('OMIT_SYNTHETIC_PRIVATE_FIELD'));
  assert.equal(result.pricingEvidence[0].typeId, 101);
  assert.equal(result.assumptions.source.includes('User-supplied'), true);
});

test('estimates are deterministic, JSON-safe and never mutate recipes, plans or evidence', () => {
  const r = clone(recipe), p = clone(plan), e = clone(evidence);
  const before = JSON.stringify([r, p, e]);
  const a = estimateManufacturing(r, p, e), b = estimateManufacturing(r, p, e);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.stringify([r, p, e]), before);
  assert.equal(JSON.parse(JSON.stringify(a)).instantSale.economicProfitISK, '26.40');
});
