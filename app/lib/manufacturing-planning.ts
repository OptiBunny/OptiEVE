import { EveError, listConnections, readCharacterData, readCorporationData, readEve } from './eve';
import { createManufacturingMarketReader } from './manufacturing-market';
import {
  createManufacturingAssessment, finalizeManufacturingAssessment, manufacturingAssessmentInputSchema,
  validateManufacturingAssessmentInput, manufacturingAbortable, manufacturingExpiryTime, manufacturingSourceFreshness,
  type ManufacturingAssessmentInput, type ManufacturingAssessmentDependencies, type ManufacturingPreparedAssessment,
  type ManufacturingAssessment,
} from './manufacturing-assessment';
import type { ManufacturingDepthQuote } from './manufacturing-estimate';

type JobFields = 'blueprintTypeId' | 'blueprintSource' | 'blueprintItemId' | 'blueprintPage' | 'plan';
export type ManufacturingPlanningJob = Pick<ManufacturingAssessmentInput, JobFields> & { key: string };
export type ManufacturingPlanningInput = { context: Omit<ManufacturingAssessmentInput, JobFields>; jobs: ManufacturingPlanningJob[] };
const jobFields = ['blueprintTypeId', 'blueprintSource', 'blueprintItemId', 'blueprintPage', 'plan'];
const properties = manufacturingAssessmentInputSchema.properties;
export const manufacturingPlanningInputSchema = {
  type: 'object', additionalProperties: false, required: ['context', 'jobs'], properties: {
    context: { type: 'object', additionalProperties: false,
      required: manufacturingAssessmentInputSchema.required.filter(key => !jobFields.includes(key)),
      properties: Object.fromEntries(Object.entries(properties).filter(([key]) => !jobFields.includes(key))) },
    jobs: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object', additionalProperties: false,
      required: ['key', 'blueprintTypeId', 'blueprintSource', 'plan'], properties: {
        key: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,40}$' },
        ...Object.fromEntries(Object.entries(properties).filter(([key]) => jobFields.includes(key))),
      } } },
  },
};
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min = 0, max = 1_000_000_000_000): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const invalid = (): never => { throw new EveError('Choose one shared manufacturing context and one to five uniquely keyed, bounded jobs.'); };
export function validateManufacturingPlanningInput(raw: unknown): ManufacturingPlanningInput {
  if (!record(raw) || Object.keys(raw).some(key => !['context', 'jobs'].includes(key)) || !record(raw.context) || !Array.isArray(raw.jobs) || raw.jobs.length < 1 || raw.jobs.length > 5) return invalid();
  if (Object.keys(raw.context).some(key => !Object.hasOwn(properties, key) || jobFields.includes(key))) return invalid();
  const keys = new Set<string>();
  for (const job of raw.jobs) {
    if (!record(job) || Object.keys(job).some(key => key !== 'key' && !jobFields.includes(key)) || typeof job.key !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(job.key) || keys.has(job.key)) return invalid();
    keys.add(job.key); const fields = Object.fromEntries(Object.entries(job).filter(([key]) => key !== 'key'));
    validateManufacturingAssessmentInput({ ...raw.context, ...fields });
  }
  return structuredClone(raw) as ManufacturingPlanningInput;
}
type Market = ReturnType<typeof createManufacturingMarketReader>;
type Depth = Awaited<ReturnType<Market['quote']>>;
type Coverage = 'complete' | 'partial' | 'unknown';
export type ManufacturingAllocatedMaterial = { typeId: number; name: string; requiredQuantity: number; ownedAllocatedQuantity: number | null; missingQuantity: number | null };
type CopyAllocation = { status: 'not-applicable' | 'verified' | 'unavailable' | 'overcommitted'; requested: number; available: number | null; allocated: number | null; overcommitted: boolean | null };
const cents = (value: string | null | undefined): bigint | null => typeof value === 'string' && /^-?(0|[1-9][0-9]{0,30})\.[0-9]{2}$/.test(value) ? BigInt(value.replace('.', '')) : null;
const money = (value: bigint | null): string | null => value === null ? null : `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 100n}.${String((value < 0n ? -value : value) % 100n).padStart(2, '0')}`;
const sum = (values: Array<bigint | null>): bigint | null => values.some(value => value === null) ? null : (values as bigint[]).reduce((a, b) => a + b, 0n);
const subtract = (a: bigint | null, b: bigint | null) => a === null || b === null ? null : a - b;
const addQuantity = (a: number, b: number) => { const result = a + b; if (!integer(result)) throw new EveError('The combined plan exceeds its bounded quantity limit.'); return result; };

/** All caches here are local to one authenticated invocation. Raw private frames
 * and exclusion IDs are never returned, persisted or accepted from callers. */
function requestDependencies(deps: ManufacturingAssessmentDependencies, signal: AbortSignal) {
  const cache = new Map<string, Promise<unknown>>();
  let corporationId: number | null = null, fatal: EveError | null = null;
  const checked = async (key: string, work: () => Promise<unknown>, entity?: string) => {
    signal.throwIfAborted(); if (fatal) throw fatal;
    if (!cache.has(key)) {
      if (cache.size >= 128) throw new EveError('Private manufacturing evidence exceeded its bounded page budget.');
      const pending = manufacturingAbortable(work, signal).then(value => {
        if (entity === 'corporation') {
          if (!record(value) || !integer(value.corporationId, 1, Number.MAX_SAFE_INTEGER) || corporationId !== null && corporationId !== value.corporationId) {
            fatal = new EveError('Corporation membership changed during the combined request. Retry with current connection status.', 409); throw fatal;
          }
          corporationId = value.corporationId;
        }
        return value;
      });
      void pending.catch(() => {}); cache.set(key, pending);
    }
    const value = await manufacturingAbortable(() => cache.get(key)!, signal);
    if (fatal) throw fatal; return structuredClone(value);
  };
  const market = (deps.market ?? createManufacturingMarketReader)();
  // The reader owns a request-scoped order-book cache. Exact repeated quotes
  // also share a snapshot; differing quantities are allocated against that book.
  const marketCache = new Map<string, Promise<unknown>>();
  const cachedMarket = Object.fromEntries((['quote', 'costs', 'history'] as const).map(method => [method, async (args: never) => {
    const key = `${method}:${JSON.stringify(args)}`;
    if (!marketCache.has(key)) {
      const pending = manufacturingAbortable(() => (market[method] as (args: never, controls: { signal: AbortSignal }) => Promise<unknown>)(args, { signal }), signal);
      void pending.catch(() => {}); marketCache.set(key, pending);
    }
    return structuredClone(await manufacturingAbortable(() => marketCache.get(key)!, signal));
  }])) as Market;
  const wrapped: ManufacturingAssessmentDependencies = {
    ...deps,
    connections: async user => await checked(`connections:${user}`, () => deps.connections(user)) as { characterId: number }[],
    character: (user, args) => checked(`character:${JSON.stringify(args)}`, () => deps.character(user, args, signal), 'character'),
    corporation: (user, args) => checked(`corporation:${JSON.stringify(args)}`, () => deps.corporation(user, args, signal), 'corporation'),
    legacy: async (user, args) => await checked(`legacy:${JSON.stringify(args)}`, () => deps.legacy(user, args, signal), args.entity) as Awaited<ReturnType<typeof readEve>>,
    market: () => cachedMarket,
  };
  return { deps: wrapped, market: cachedMarket, check: () => { signal.throwIfAborted(); if (fatal) throw fatal; } };
}
function assertBounds(prepared: ManufacturingPreparedAssessment[]) {
  const materials = new Set<number>(), products = new Set<number>(); let rows = 0;
  for (const item of prepared) {
    for (const row of item.recipe.materials) { materials.add(row.typeId); rows++; }
    for (const row of item.recipe.products) products.add(row.typeId);
  }
  if (rows > 60 || materials.size > 60 || products.size > 5) throw new EveError('The manufacturing batch exceeds the bounded material/product budget.');
}
function allocate(prepared: ManufacturingPreparedAssessment[], assessments: ManufacturingAssessment[]) {
  const requirements = new Map<number, { typeId: number; name: string; requiredQuantity: number; ownedAllocatedQuantity: number | null; missingQuantity: number | null }>();
  const available = new Map<number, number | null>();
  for (const assessment of assessments) for (const row of assessment.estimate.materials) {
    const prior = available.get(row.typeId), current = row.ownedAvailableQuantity;
    available.set(row.typeId, prior === undefined ? current : prior === current ? current : null);
  }
  const remaining = new Map(available), allocatedMaterials: ManufacturingAllocatedMaterial[][] = [];
  for (const assessment of assessments) {
    const rows: ManufacturingAllocatedMaterial[] = [];
    for (const row of assessment.estimate.requirements.materials) {
      const stock = remaining.get(row.typeId) ?? null, used = stock === null ? null : Math.min(stock, row.requiredQuantity);
      if (stock !== null && used !== null) remaining.set(row.typeId, stock - used);
      const missing = used === null ? null : row.requiredQuantity - used;
      rows.push({ typeId: row.typeId, name: row.name, requiredQuantity: row.requiredQuantity, ownedAllocatedQuantity: used, missingQuantity: missing });
      const total = requirements.get(row.typeId) ?? { typeId: row.typeId, name: row.name, requiredQuantity: 0, ownedAllocatedQuantity: 0, missingQuantity: 0 };
      total.requiredQuantity = addQuantity(total.requiredQuantity, row.requiredQuantity);
      total.ownedAllocatedQuantity = total.ownedAllocatedQuantity === null || used === null ? null : addQuantity(total.ownedAllocatedQuantity, used);
      total.missingQuantity = total.missingQuantity === null || missing === null ? null : addQuantity(total.missingQuantity, missing);
      requirements.set(row.typeId, total);
    }
    allocatedMaterials.push(rows);
  }
  // The same physical blueprint cannot be both a copy and an original across
  // selected pages. Page changes are not an atomic snapshot; disagreement is
  // unknown evidence, never another pool of runs.
  const blueprintSnapshots = new Map<number, { signature: string; consistent: boolean }>();
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i]; if (p.args.blueprintSource !== 'owned') continue;
    const bp = assessments[i].estimate.assumptions.blueprint;
    const signature = JSON.stringify([p.recipe.blueprintTypeId, bp.kind, bp.remainingRuns, assessments[i].estimate.assumptions.materialEfficiency]);
    const previous = blueprintSnapshots.get(p.args.blueprintItemId!);
    if (previous) previous.consistent &&= bp.accessConfirmed && signature === previous.signature;
    else blueprintSnapshots.set(p.args.blueprintItemId!, { signature, consistent: bp.accessConfirmed });
  }
  const copies = new Map<number, { remaining: number; total: number; verified: boolean; blueprintTypeId: number }>();
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i], bp = assessments[i].estimate.assumptions.blueprint;
    if (p.args.blueprintSource !== 'owned' || bp.kind !== 'copy') continue;
    const previous = copies.get(p.args.blueprintItemId!);
    const verified = bp.accessConfirmed && integer(bp.remainingRuns) && blueprintSnapshots.get(p.args.blueprintItemId!)?.consistent === true;
    if (!previous) copies.set(p.args.blueprintItemId!, { remaining: bp.remainingRuns ?? 0, total: p.plan.runs, verified, blueprintTypeId: p.recipe.blueprintTypeId });
    else { previous.total = addQuantity(previous.total, p.plan.runs); previous.verified &&= verified && previous.remaining === bp.remainingRuns && previous.blueprintTypeId === p.recipe.blueprintTypeId; }
  }
  const usedRuns = new Map<number, number>();
  const copyRuns: CopyAllocation[] = prepared.map((p, i) => {
    const bp = assessments[i].estimate.assumptions.blueprint, requested = p.plan.runs;
    if (bp.kind === 'original' && bp.accessConfirmed && blueprintSnapshots.get(p.args.blueprintItemId!)?.consistent === true) return { status: 'not-applicable', requested, available: null, allocated: null, overcommitted: false };
    const entry = copies.get(p.args.blueprintItemId!);
    if (!entry?.verified || bp.kind !== 'copy') return { status: 'unavailable', requested, available: null, allocated: null, overcommitted: null };
    const used = usedRuns.get(p.args.blueprintItemId!) ?? 0, amount = Math.min(requested, Math.max(0, entry.remaining - used));
    usedRuns.set(p.args.blueprintItemId!, used + amount);
    return { status: entry.total > entry.remaining ? 'overcommitted' : 'verified', requested, available: entry.remaining, allocated: amount, overcommitted: entry.total > entry.remaining };
  });
  return { requirements, allocatedMaterials, copyRuns };
}
type QuoteSet = { purchase: Map<number, Depth | null>; held: Map<number, Depth | null>; output: Map<number, Depth | null> };
function depthAt(quote: Depth | null | undefined, quantity: number, input: ManufacturingPlanningInput, assessments: ManufacturingAssessment[], at: number): Depth | null {
  if (!quote) return null;
  const result = structuredClone(quote), validUntil = manufacturingExpiryTime(result.validUntil);
  result.sourceFreshness = manufacturingSourceFreshness(result.sources, at);
  result.exclusionsVerified &&= assessments.every(item => item.ownOrdersComplete);
  result.estimateReady &&= result.typeId > 0 && result.quantity === quantity && result.stationId === input.context.marketStationId && result.regionId === input.context.marketRegionId && result.sourceFreshness === 'fresh' && validUntil !== null && validUntil > at && result.exclusionsVerified && assessments.every(item => item.currentRecipeVerified);
  return result;
}
function usable(quote: Depth | null, typeId: number, quantity: number, side: 'buy_materials' | 'sell_output') {
  return !!quote && quote.typeId === typeId && quote.side === side && quote.quantity === quantity && quote.coverage === 'complete' && quote.completePages && quote.estimateReady && quote.exclusionsVerified && quote.sourceFreshness === 'fresh' && quote.filledQuantity === quantity && quote.unfilledQuantity === 0 && cents(quote.grossISK) !== null;
}
/** Split a joint allocation for accounting only: each market order was filled
 * once by the reader, including its minimum fill, before quantities are split. */
function splitDepth(quote: Depth | null, requests: number[], side: 'buy_materials' | 'sell_output'): Array<ManufacturingDepthQuote | null> {
  const total = requests.reduce(addQuantity, 0);
  if (!quote || !usable(quote, quote.typeId, total, side) || !Array.isArray(quote.priceLevels) || quote.priceLevels.length > 1000) return requests.map(() => null);
  let checkedQuantity = 0, checkedGross = 0n;
  for (const level of quote.priceLevels) {
    const price = cents(level.priceISK);
    if (!integer(level.quantity, 1) || price === null || price < 0n) return requests.map(() => null);
    checkedQuantity = addQuantity(checkedQuantity, level.quantity); checkedGross += price * BigInt(level.quantity);
  }
  if (checkedQuantity !== total || checkedGross !== cents(quote.grossISK)) return requests.map(() => null);
  let index = 0, consumed = 0;
  return requests.map(quantity => {
    if (!quantity) return null;
    let left = quantity, gross = 0n;
    while (left > 0) {
      const level = quote.priceLevels[index], used = Math.min(left, level.quantity - consumed);
      gross += cents(level.priceISK)! * BigInt(used); left -= used; consumed += used;
      if (consumed === level.quantity) { index++; consumed = 0; }
    }
    return { ...quote, quantity, filledQuantity: quantity, unfilledQuantity: 0, grossISK: money(gross)! };
  });
}

export function createManufacturingPlanning(deps: ManufacturingAssessmentDependencies) {
  async function execute(user: string, raw: unknown, combined: boolean, options: { signal?: AbortSignal } = {}) {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    signal.throwIfAborted(); const input = validateManufacturingPlanningInput(raw), now = deps.now ?? Date.now;
    if (!user) throw new EveError('Sign in to the private connector first.', 401);
    const request = requestDependencies(deps, signal), prepared: ManufacturingPreparedAssessment[] = [];
    const assess = createManufacturingAssessment({ ...request.deps, onPrepared: item => prepared.push(item) });
    for (const job of input.jobs) { const fields = Object.fromEntries(Object.entries(job).filter(([key]) => key !== 'key')); await assess(user, { ...input.context, ...fields }, { signal }); request.check(); assertBounds(prepared); }
    if (prepared.length !== input.jobs.length) throw new EveError('The manufacturing evidence could not be prepared completely.', 502);
    if (!combined) {
      const completedAt = now(), assessments = prepared.map(item => finalizeManufacturingAssessment(item, completedAt)); request.check();
      const alternatives = assessments.map((assessment, index) => ({ key: input.jobs[index].key, assessment, rank: null as number | null }));
      const ranked = alternatives.filter(item => item.assessment.currentRecipeVerified && item.assessment.estimate.eligibility.readiness === 'conditional' && item.assessment.estimate.instantSale.complete && cents(item.assessment.estimate.instantSale.economicProfitISK) !== null)
        .sort((a, b) => { const left = cents(a.assessment.estimate.instantSale.economicProfitISK)!, right = cents(b.assessment.estimate.instantSale.economicProfitISK)!; return left === right ? 0 : left > right ? -1 : 1; });
      ranked.forEach((item, index) => { item.rank = index + 1; });
      return { kind: 'manufacturing_comparison' as const, generatedAt: new Date(completedAt).toISOString(), alternatives,
        rankingBasis: 'Descending modeled instant-sale economic profit for complete, conditional individual alternatives. Negative values remain losses. Unconfirmed or blocked alternatives are unranked.',
        conditions: ['Alternatives independently reuse the selected stock, wallet, copy runs and current book. This comparison never establishes joint affordability or reserves market fills.', 'Estimates compare selected batch sizes, not profit per hour, execution probability or future prices.'] };
    }
    let assessments = prepared.map(item => finalizeManufacturingAssessment(item, now()));
    const allocation = allocate(prepared, assessments), outputs = new Map<number, { typeId: number; name: string; quantity: number }>();
    for (const assessment of assessments) { const product = assessment.estimate.requirements.product, existing = outputs.get(product.typeId); outputs.set(product.typeId, { ...product, quantity: addQuantity(existing?.quantity ?? 0, product.quantity) }); }
    const excluded = [...new Set(prepared.flatMap(item => item.ownOrderIds))];
    const quotes: QuoteSet = { purchase: new Map(), held: new Map(), output: new Map() }, issues: string[] = [];
    const quote = async (typeId: number, quantity: number | null, side: 'buy_materials' | 'sell_output') => {
      if (quantity === null || quantity === 0 || excluded.length > 2000) return null;
      try { return await manufacturingAbortable(() => request.market.quote({ regionId: input.context.marketRegionId, stationId: input.context.marketStationId, typeId, quantity, side, excludeOrderIds: excluded, ownOrdersComplete: assessments.every(item => item.ownOrdersComplete), maxPages: input.context.maxMarketPages ?? 2 }, { signal }), signal); }
      catch { request.check(); issues.push(`Combined ${side} depth for type ${typeId} is unavailable.`); return null; }
    };
    const tasks = [...allocation.requirements.values()].flatMap(row => [async () => { quotes.purchase.set(row.typeId, await quote(row.typeId, row.missingQuantity, 'buy_materials')); }, async () => { quotes.held.set(row.typeId, await quote(row.typeId, row.ownedAllocatedQuantity, 'sell_output')); }]);
    tasks.push(...[...outputs.values()].map(row => async () => { quotes.output.set(row.typeId, await quote(row.typeId, row.quantity, 'sell_output')); }));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, tasks.length) }, async () => { while (next < tasks.length) { request.check(); await tasks[next++](); } }));
    request.check();
    // Every private and public decision is rechecked at this one boundary,
    // including evidence used by the first job before the last quote finished.
    const completedAt = now(); assessments = prepared.map(item => finalizeManufacturingAssessment(item, completedAt));
    const finalAllocation = allocate(prepared, assessments), jointPrepared = structuredClone(prepared);
    for (let i = 0; i < jointPrepared.length; i++) {
      jointPrepared[i].materials = finalAllocation.allocatedMaterials[i].map(row => ({ typeId: row.typeId, ownedQuantity: row.ownedAllocatedQuantity, purchaseAll: null, purchaseMissing: null, sellOwned: null }));
      jointPrepared[i].output = null;
    }
    const shoppingList = [...finalAllocation.requirements.values()].map(row => {
      const purchase = row.missingQuantity === null ? null : depthAt(quotes.purchase.get(row.typeId), row.missingQuantity, input, assessments, completedAt);
      const held = row.ownedAllocatedQuantity === null ? null : depthAt(quotes.held.get(row.typeId), row.ownedAllocatedQuantity, input, assessments, completedAt);
      const amounts = finalAllocation.allocatedMaterials.map(rows => rows.find(item => item.typeId === row.typeId));
      const purchases = splitDepth(purchase, amounts.map(item => item?.missingQuantity ?? 0), 'buy_materials');
      const opportunity = splitDepth(held, amounts.map(item => item?.ownedAllocatedQuantity ?? 0), 'sell_output');
      for (let i = 0; i < jointPrepared.length; i++) { const material = jointPrepared[i].materials.find(item => item.typeId === row.typeId); if (material) { material.purchaseMissing = purchases[i]; material.sellOwned = opportunity[i]; } }
      const ready = row.missingQuantity === 0 || row.missingQuantity !== null && usable(purchase, row.typeId, row.missingQuantity, 'buy_materials') && purchases.every((item, i) => (amounts[i]?.missingQuantity ?? 0) === 0 || item !== null);
      return { ...row, purchaseISK: row.missingQuantity === 0 ? '0.00' : ready ? purchase!.grossISK : null, coverage: (ready ? 'complete' : purchase?.coverage === 'partial' ? 'partial' : 'unknown') as Coverage };
    });
    const outputRows = [...outputs.values()].map(row => {
      const output = depthAt(quotes.output.get(row.typeId), row.quantity, input, assessments, completedAt);
      const quantities = assessments.map(item => item.estimate.requirements.product.typeId === row.typeId ? item.estimate.requirements.product.quantity : 0);
      const split = splitDepth(output, quantities, 'sell_output');
      for (let i = 0; i < jointPrepared.length; i++) if (quantities[i]) jointPrepared[i].output = split[i];
      const ready = usable(output, row.typeId, row.quantity, 'sell_output') && split.every((item, i) => quantities[i] === 0 || item !== null);
      return { ...row, grossRevenueISK: ready ? output!.grossISK : null, coverage: (ready ? 'complete' : output?.coverage === 'partial' ? 'partial' : 'unknown') as Coverage };
    });
    const joint = jointPrepared.map(item => finalizeManufacturingAssessment(item, completedAt));
    const jobs = joint.map((assessment, i) => ({ key: input.jobs[i].key, assessment, allocatedMaterials: finalAllocation.allocatedMaterials[i], copyRunsAllocated: finalAllocation.copyRuns[i].allocated, copyRuns: finalAllocation.copyRuns[i] }));
    const wallets = assessments.map(item => item.estimate.eligibility.wallet.availableISK), wallet = wallets.every(value => value === wallets[0]) ? cents(wallets[0]) : null;
    const materialCash = sum(shoppingList.map(row => cents(row.purchaseISK)));
    const overheadCash = sum(joint.flatMap(({ estimate: { costs } }) => [costs.installation.totalISK, costs.haulingISK, costs.blueprintCashISK, costs.otherCashISK].map(cents)));
    const cash = sum([materialCash, overheadCash]), net = sum(joint.map(item => cents(item.estimate.instantSale.netRevenueISK)));
    const economic = sum(joint.map(item => cents(item.estimate.costs.economicCostISK)));
    const affordable = wallet === null || cash === null ? null : wallet >= cash;
    const overcommitted = finalAllocation.copyRuns.some(item => item.overcommitted === true);
    const blocked = overcommitted || affordable === false || joint.some(item => item.estimate.eligibility.skills.status === 'missing');
    const unknown = affordable === null || finalAllocation.copyRuns.some(item => item.status === 'unavailable') || joint.some(item => item.estimate.eligibility.blueprint !== 'confirmed_assumption' || item.estimate.eligibility.facility !== 'confirmed_assumption' || item.estimate.eligibility.skills.status !== 'met');
    if (overcommitted) issues.push('Selected jobs overcommit a verified blueprint copy; its remaining runs are allocated only once.');
    if (finalAllocation.copyRuns.some(item => item.status === 'unavailable')) issues.push('Blueprint access or copy-run evidence is unavailable or inconsistent across selected jobs; copy capacity is not assumed.');
    if (affordable === false) issues.push('The one selected wallet does not cover the combined upfront cash requirement. Planned sales are not credited toward funding.');
    if (affordable === null) issues.push('Combined affordability is unknown because funding or a required cash component is unavailable.');
    if (outputRows.some(row => row.coverage !== 'complete')) issues.push('Combined output depth is incomplete; full-plan sales and margins are unknown.');
    request.check();
    return { kind: 'manufacturing_production_plan' as const, generatedAt: new Date(completedAt).toISOString(), jobs, shoppingList, outputs: outputRows,
      totals: { walletISK: money(wallet), materialCashISK: money(materialCash), jobAndOverheadCashISK: money(overheadCash), cashRequiredISK: money(cash), affordable, netRevenueISK: money(net), economicProfitISK: money(subtract(net, economic)) },
      readiness: blocked ? 'blocked' as const : unknown ? 'unconfirmed' as const : 'conditional' as const,
      conditions: [...new Set([...issues, ...assessments.flatMap(item => item.conditions)])],
      limitations: ['Stock, verified copy runs and shared price-priority book allocations are assigned in the submitted job order. Reordering jobs changes per-job allocations, not combined quantities.', 'One selected wallet funds all jobs; no planned output, listed sale or future income is credited as cash or input stock.', 'Output and deficit quantities are aggregated by type before quoting actual depth. Owned-stock opportunity quotes are a separate counterfactual liquidation scenario, not additional planned sales.', 'Per-job estimates use the shared allocations; replacement purchase scenarios are not modeled for the combined plan. Fees and explicit overhead remain per job and round conservatively to cents.', 'Blueprint originals may be reused only as a sequential assumption. Job-slot availability, scheduling, delivery, hauling and service access are not verified.', 'Current quotes do not reserve orders and independent pagination is not an atomic snapshot. This is a conditional plan, not realized profit or permission to submit jobs.', 'All account evidence and derived planning values remain in this request only.'] };
  }
  return {
    compare: (user: string, raw: unknown, options: { signal?: AbortSignal } = {}) => execute(user, raw, false, options) as Promise<ManufacturingComparison>,
    plan: (user: string, raw: unknown, options: { signal?: AbortSignal } = {}) => execute(user, raw, true, options) as Promise<ManufacturingProductionPlan>,
  };
}
// Explicit result types avoid circular inference through the factory wrappers.
export type ManufacturingComparison = { kind: 'manufacturing_comparison'; generatedAt: string; alternatives: { key: string; assessment: ManufacturingAssessment; rank: number | null }[]; rankingBasis: string; conditions: string[] };
export type ManufacturingProductionPlan = {
  kind: 'manufacturing_production_plan'; generatedAt: string;
  jobs: { key: string; assessment: ManufacturingAssessment; allocatedMaterials: ManufacturingAllocatedMaterial[]; copyRunsAllocated: number | null; copyRuns: CopyAllocation }[];
  shoppingList: (ManufacturingAllocatedMaterial & { purchaseISK: string | null; coverage: Coverage })[];
  outputs: { typeId: number; name: string; quantity: number; grossRevenueISK: string | null; coverage: Coverage }[];
  totals: { walletISK: string | null; materialCashISK: string | null; jobAndOverheadCashISK: string | null; cashRequiredISK: string | null; affordable: boolean | null; netRevenueISK: string | null; economicProfitISK: string | null };
  readiness: 'blocked' | 'unconfirmed' | 'conditional'; conditions: string[]; limitations: string[];
};
export const createManufacturingComparison = (deps: ManufacturingAssessmentDependencies) => createManufacturingPlanning(deps).compare;
export const createManufacturingProductionPlan = (deps: ManufacturingAssessmentDependencies) => createManufacturingPlanning(deps).plan;
const defaultPlanning = createManufacturingPlanning({ connections: listConnections, character: readCharacterData, corporation: readCorporationData, legacy: readEve });
export const compareManufacturing = defaultPlanning.compare;
export const planManufacturing = defaultPlanning.plan;
