/** Invented, in-memory examples only. This module never contacts EVE or a server. */
import { estimateManufacturing, manufacturingRequirements } from './manufacturing-estimate';
import type { ManufacturingDepthQuote, ManufacturingPlan, ManufacturingRecipe } from './manufacturing-estimate';
import { assessmentContext, manufacturingResponse } from './manufacturing-client';
import type { Character } from './connection-client';
import type { DemoScenario, ManufacturingCard, ManufacturingContext, ManufacturingJob, ManufacturingProductionResponse, ManufacturingRequest, ManufacturingResponse } from './manufacturing-types';

export const demoCharacters: Character[] = [{ characterId: 90000001, name: 'Synthetic pilot', corporationId: 98000001, scopes: [] }];
export const demoContext: ManufacturingContext = { characterId: 90000001, resourceEntity: 'character', marketRegionId: 10000001, marketStationId: 60000001, manufacturingSystemId: 30000001, useOwnedMaterials: true, stockLocationIds: [60000001], otherOwnedOrdersReviewed: true };
export const demoPlan = (): ManufacturingPlan => ({ runs: 2, materialEfficiency: 5, facilityMaterialMultiplier: '1', blueprint: { kind: 'original', accessConfirmed: true }, facilityAccessConfirmed: true, sale: { salesTaxRate: '0.05' }, job: { quotedInstallationISK: '50' }, overhead: { haulingISK: '10', blueprintCashISK: '0', blueprintOpportunityISK: '0', otherCashISK: '0', otherOpportunityISK: '0' } });
const recipes: ManufacturingRecipe[] = [
  { blueprintTypeId: 10001, blueprintName: 'Demo survey frigate blueprint', activity: 'manufacturing', materials: [{ typeId: 101, name: 'Demo alloy', quantity: 60 }, { typeId: 102, name: 'Demo circuitry', quantity: 8 }], products: [{ typeId: 201, name: 'Demo survey frigate', quantity: 1 }], skills: [{ typeId: 301, name: 'Demo industry', level: 1 }], timeSeconds: 600, maxProductionLimit: 100 },
  { blueprintTypeId: 10002, blueprintName: 'Demo cargo module blueprint', activity: 'manufacturing', materials: [{ typeId: 101, name: 'Demo alloy', quantity: 40 }, { typeId: 102, name: 'Demo circuitry', quantity: 4 }], products: [{ typeId: 202, name: 'Demo cargo module', quantity: 1 }], skills: [{ typeId: 301, name: 'Demo industry', level: 1 }], timeSeconds: 180, maxProductionLimit: 100 },
  { blueprintTypeId: 10003, blueprintName: 'Demo sensor array blueprint', activity: 'manufacturing', materials: [{ typeId: 101, name: 'Demo alloy', quantity: 20 }, { typeId: 103, name: 'Demo optics', quantity: 3 }], products: [{ typeId: 203, name: 'Demo sensor array', quantity: 2 }], skills: [{ typeId: 301, name: 'Demo industry', level: 2 }], timeSeconds: 300, maxProductionLimit: 100 },
];
const prices: Record<number, { buy: number; sell: number }> = { 101: { buy: 10, sell: 8 }, 102: { buy: 40, sell: 30 }, 103: { buy: 80, sell: 60 }, 201: { buy: 1800, sell: 1500 }, 202: { buy: 1000, sell: 850 }, 203: { buy: 650, sell: 500 } };
const cents = (value: string) => { const negative = value.startsWith('-'), [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.'); return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) * (negative ? -1n : 1n); };
const money = (value: bigint) => `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 100n}.${((value < 0n ? -value : value) % 100n).toString().padStart(2, '0')}`;
const sum = (values: (string | null)[]) => values.some(value => value === null) ? null : money(values.reduce<bigint>((total, value) => total + cents(value!), 0n));
type Pool = { stock: Map<number, number>; asks: Map<number, number>; bids: Map<number, number>; copies: Map<number, number> };
const pool = (scenario: DemoScenario): Pool => ({ stock: new Map([[101, scenario === 'scarce' ? 5 : 150], [102, scenario === 'scarce' ? 0 : 12], [103, 4]]), asks: new Map(), bids: new Map(), copies: new Map([[70000002, 3]]) });

function assess(context: ManufacturingContext, job: ManufacturingJob, scenario: DemoScenario, now: string, shared?: Pool) {
  const recipe = recipes.find(recipe => recipe.blueprintTypeId === job.blueprintTypeId);
  if (!recipe) throw new Error('Choose one of the three synthetic demo blueprints.');
  const resources = shared ?? pool(scenario);
  const knownOwner = context.characterId === 90000001 && (context.resourceEntity === 'character' || context.walletDivision === 1);
  const knownStock = knownOwner && (context.resourceEntity === 'character' || context.hangarDivisions?.includes(1)) && context.stockLocationIds?.includes(60000001);
  const knownMarket = context.marketRegionId === 10000001 && context.marketStationId === 60000001;
  const complete = scenario !== 'missing' && knownMarket && context.otherOwnedOrdersReviewed;
  const plan = structuredClone(job.plan), copyAvailable = job.blueprintItemId === 70000002 ? resources.copies.get(70000002) ?? 0 : null;
  plan.blueprint = { kind: 'unknown', accessConfirmed: false };
  if (job.blueprintSource === 'owned' && knownOwner && scenario !== 'missing') {
    const ownedMatch = job.blueprintPage === 1 && job.blueprintItemId === 70000001 + recipes.indexOf(recipe);
    if (ownedMatch) {
      plan.materialEfficiency = 5;
      plan.blueprint = job.blueprintItemId === 70000002 ? { kind: 'copy', remainingRuns: copyAvailable ?? 0, accessConfirmed: true } : { kind: 'original', accessConfirmed: true };
      if (shared && plan.blueprint.kind === 'copy') resources.copies.set(70000002, Math.max(0, (copyAvailable ?? 0) - plan.runs));
    }
  }
  const requirements = manufacturingRequirements(recipe, plan);
  function quote(typeId: number, quantity: number, side: ManufacturingDepthQuote['side'], consume = false): ManufacturingDepthQuote {
    const depth = side === 'buy_materials' ? resources.asks : resources.bids;
    const capacity = scenario === 'scarce' ? typeId >= 200 ? 1 : 30 : 1_000_000;
    const available = depth.get(typeId) ?? capacity, filled = Math.min(available, quantity);
    if (consume) depth.set(typeId, available - filled);
    return { typeId, quantity, side, grossISK: money(BigInt(filled) * BigInt(side === 'buy_materials' ? prices[typeId].buy : prices[typeId].sell) * 100n), regionId: context.marketRegionId, stationId: context.marketStationId, solarSystemId: context.manufacturingSystemId, filledQuantity: filled, unfilledQuantity: quantity - filled, coverage: complete ? filled === quantity ? 'complete' : 'partial' : 'unknown', completePages: complete, exclusionsVerified: complete, estimateReady: complete && filled === quantity, sourceFreshness: complete ? 'fresh' : 'unknown', generatedAt: now };
  }
  const evidence = requirements.materials.map(material => {
    const ownedQuantity = !context.useOwnedMaterials ? 0 : scenario === 'missing' || !knownStock ? null : resources.stock.get(material.typeId) ?? 0;
    const used = ownedQuantity === null ? null : Math.min(ownedQuantity, material.requiredQuantity), missing = used === null ? null : material.requiredQuantity - used;
    if (shared && used !== null) resources.stock.set(material.typeId, (resources.stock.get(material.typeId) ?? 0) - used);
    return { typeId: material.typeId, ownedQuantity, purchaseAll: quote(material.typeId, material.requiredQuantity, 'buy_materials'), purchaseMissing: missing === null ? null : quote(material.typeId, missing, 'buy_materials', !!shared), sellOwned: used === null ? null : quote(material.typeId, used, 'sell_output', !!shared) };
  });
  const outputQuote = quote(requirements.product.typeId, requirements.product.quantity, 'sell_output', !!shared);
  const estimate = estimateManufacturing(recipe, plan, { materials: evidence, output: outputQuote, walletISK: !knownOwner || scenario === 'missing' ? null : scenario === 'scarce' ? '20.00' : '2500.00', skills: scenario === 'missing' ? null : { complete: true, levels: [{ typeId: 301, level: 4 }] }, industry: complete ? { ready: true, costIndex: '0.04', adjustedPrices: recipe.materials.map(material => ({ typeId: material.typeId, adjustedPriceISK: String(prices[material.typeId].buy) })) } : null });
  const card: ManufacturingCard = { key: job.key, blueprintTypeId: job.blueprintTypeId, name: recipe.blueprintName, productName: recipe.products[0].name, runs: plan.runs, outputQuantity: requirements.product.quantity, readiness: estimate.eligibility.readiness === 'blocked' ? 'blocked' : estimate.eligibility.readiness === 'conditional' ? 'conditional' : 'unconfirmed', availableWalletISK: estimate.eligibility.wallet.availableISK, cashRequiredISK: estimate.costs.cashRequiredISK, economicCostISK: estimate.costs.economicCostISK, profitISK: estimate.instantSale.economicProfitISK, listedProfitISK: estimate.listedSale?.economicProfitISK ?? null, affordable: estimate.eligibility.wallet.instantScenarioAffordable, recipeCurrent: true, stockCoverage: scenario === 'missing' || context.useOwnedMaterials && !knownStock ? 'unknown' : 'complete', ownOrdersComplete: complete, materials: estimate.materials.map(material => ({ typeId: material.typeId, name: material.name, requiredQuantity: material.requiredQuantity, ownedQuantity: material.ownedAvailableQuantity, usedQuantity: material.ownedUsedQuantity, missingQuantity: material.missingQuantity, buyISK: material.additionalPurchaseISK })), reasons: ['Synthetic fixture; these are invented prices, holdings and skills, never live EVE evidence.', ...estimate.reasons, 'Facility access, future demand and available industry slots must be checked before a real job.'], freshness: [{ label: 'Synthetic evidence', status: complete ? 'fresh' : 'unknown', cacheExpires: null }] };
  if (!complete && card.readiness === 'conditional') card.readiness = 'unconfirmed';
  return { card, estimate, product: requirements.product, outputQuote, evidence };
}

/** Deliberate actions use the same request/response contract as the private workspace. */
export async function manufacturingDemoRequest(request: ManufacturingRequest, scenario: DemoScenario, signal: AbortSignal): Promise<ManufacturingResponse> {
  await Promise.resolve(); if (signal.aborted) throw new Error('Demo request cancelled.');
  const generatedAt = new Date().toISOString(); let result: ManufacturingResponse;
  if (request.operation === 'search') {
    const matches = recipes.filter(recipe => `${recipe.blueprintName} ${recipe.products[0].name}`.toLowerCase().includes(request.query.toLowerCase())), offset = request.offset ?? 0, limit = Math.min(request.limit ?? 20, 50);
    result = { operation: 'search', generatedAt, query: request.query, items: matches.slice(offset, offset + limit).map(recipe => ({ typeId: recipe.products[0].typeId, name: recipe.products[0].name, blueprintTypeIds: [recipe.blueprintTypeId] })), nextOffset: offset + limit < matches.length ? offset + limit : null, totalMatches: matches.length };
  } else if (request.operation === 'blueprints') result = { operation: 'blueprints', generatedAt, characterId: request.characterId, resourceEntity: request.resourceEntity, page: request.page, pages: request.page, coverage: scenario === 'missing' ? 'unknown' : 'complete', cacheExpires: null, items: request.characterId !== 90000001 || request.page !== 1 ? [] : [{ itemId: 70000001, typeId: 10001, name: recipes[0].blueprintName, kind: 'original', materialEfficiency: 5, remainingRuns: null }, { itemId: 70000002, typeId: 10002, name: recipes[1].blueprintName, kind: 'copy', materialEfficiency: 5, remainingRuns: 3 }, { itemId: 70000003, typeId: 10003, name: recipes[2].blueprintName, kind: 'original', materialEfficiency: 5, remainingRuns: null }] };
  else if (request.operation === 'catalog') result = { operation: 'catalog', generatedAt, status: 'current', pinnedBuild: 1, latestBuild: 1, message: 'Three invented demo recipes. This does not check the live EVE catalog.' };
  else if (request.operation === 'assess') result = { operation: 'assess', generatedAt, context: assessmentContext(request.input), assessment: assess(assessmentContext(request.input), { ...request.input, key: 'selected' }, scenario, generatedAt).card };
  else if (request.operation === 'compare') {
    const candidates = request.input.jobs.map(job => assess(request.input.context, job, scenario, generatedAt).card);
    const rankedKeys = candidates.filter(card => card.readiness === 'conditional' && card.profitISK !== null).sort((a, b) => cents(a.profitISK!) > cents(b.profitISK!) ? -1 : cents(a.profitISK!) < cents(b.profitISK!) ? 1 : 0).map(card => card.key);
    result = { operation: 'compare', generatedAt, context: request.input.context, candidates, rankedKeys, conditions: ['Synthetic alternatives: each candidate independently uses the same wallet, holdings and demand.', 'Ranking includes only conditional candidates with known instant-sale economic profit. Do not add alternative profits together.'] };
  } else {
    const shared = pool(scenario), assessed = request.input.jobs.map(job => assess(request.input.context, job, scenario, generatedAt, shared));
    const materials = new Map<number, ManufacturingProductionResponse['shoppingList'][number]>(), outputs = new Map<number, ManufacturingProductionResponse['outputs'][number]>();
    for (const job of assessed) {
      for (const material of job.card.materials) {
        const prior = materials.get(material.typeId), used = material.usedQuantity, missing = material.missingQuantity;
        materials.set(material.typeId, { typeId: material.typeId, name: material.name, requiredQuantity: (prior?.requiredQuantity ?? 0) + material.requiredQuantity, ownedAllocatedQuantity: prior?.ownedAllocatedQuantity === null || used === null ? null : (prior?.ownedAllocatedQuantity ?? 0) + used, missingQuantity: prior?.missingQuantity === null || missing === null ? null : (prior?.missingQuantity ?? 0) + missing, purchaseISK: sum([prior?.purchaseISK === undefined ? '0.00' : prior.purchaseISK, material.buyISK]), coverage: prior?.coverage === 'unknown' || missing === null || job.evidence.find(row => row.typeId === material.typeId)?.purchaseMissing?.coverage === 'unknown' ? 'unknown' : prior?.coverage === 'partial' || material.buyISK === null ? 'partial' : 'complete' });
      }
      const prior = outputs.get(job.product.typeId);
      outputs.set(job.product.typeId, { typeId: job.product.typeId, name: job.card.productName, quantity: (prior?.quantity ?? 0) + job.product.quantity, grossRevenueISK: sum([prior?.grossRevenueISK === undefined ? '0.00' : prior.grossRevenueISK, job.estimate.instantSale.grossRevenueISK]), coverage: prior?.coverage === 'unknown' || job.outputQuote.coverage === 'unknown' ? 'unknown' : prior?.coverage === 'partial' || job.outputQuote.coverage === 'partial' ? 'partial' : 'complete' });
    }
    const walletISK = assessed[0]?.card.availableWalletISK ?? null, cashRequiredISK = sum(assessed.map(job => job.card.cashRequiredISK));
    const affordable = walletISK === null || cashRequiredISK === null ? null : cents(walletISK) >= cents(cashRequiredISK);
    result = { operation: 'plan', generatedAt, context: request.input.context, jobs: assessed.map(job => job.card), shoppingList: [...materials.values()], outputs: [...outputs.values()], totals: { walletISK, materialCashISK: sum(assessed.map(job => job.estimate.costs.additionalMaterialCashISK)), jobAndOverheadCashISK: sum(assessed.flatMap(job => [job.estimate.costs.installation.totalISK, job.estimate.costs.haulingISK, job.estimate.costs.blueprintCashISK, job.estimate.costs.otherCashISK])), cashRequiredISK, affordable, netRevenueISK: sum(assessed.map(job => job.estimate.instantSale.netRevenueISK)), economicProfitISK: sum(assessed.map(job => job.card.profitISK)) }, readiness: affordable === false || assessed.some(job => job.card.readiness === 'blocked') ? 'blocked' : affordable === null || assessed.some(job => job.card.readiness !== 'conditional') ? 'unconfirmed' : 'conditional', conditions: ['Synthetic production plan: shared stock, copy runs and market depth are allocated once, in the displayed job order.', 'The spending wallet is tested once against total cash needed. Original blueprints may require sequential jobs.', 'All examples are in memory; changing selection or leaving this page clears the workspace.'] };
  }
  if (signal.aborted) throw new Error('Demo request cancelled.');
  return manufacturingResponse(result, request);
}
