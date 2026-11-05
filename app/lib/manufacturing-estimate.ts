/** Pure, read-only scenario arithmetic. The caller must resolve recipes and evidence
 * from the validated catalog and fresh readers; this module is not a data source. */
export interface ManufacturingRecipe {
  blueprintTypeId: number;
  blueprintName: string;
  activity: 'manufacturing';
  materials: Array<{ typeId: number; name: string; quantity: number }>;
  products: Array<{ typeId: number; name: string; quantity: number }>;
  skills: Array<{ typeId: number; name: string; level: number }>;
  timeSeconds: number;
  maxProductionLimit: number;
}

type DecimalInput = string | null;
export interface ManufacturingPlan {
  runs: number;
  materialEfficiency: number;
  facilityMaterialMultiplier: string;
  blueprint: { kind: 'original' | 'copy' | 'unknown'; remainingRuns?: number; accessConfirmed: boolean };
  facilityAccessConfirmed: boolean;
  sale: {
    salesTaxRate?: DecimalInput;
    listedBrokerRate?: DecimalInput;
    listedBrokerMinimumISK?: DecimalInput;
    listedUnitPriceISK?: DecimalInput;
  };
  job: {
    quotedInstallationISK?: DecimalInput;
    jobCostMultiplier?: DecimalInput;
    facilityTaxRate?: DecimalInput;
    sccSurchargeRate?: DecimalInput;
    alphaTaxRate?: DecimalInput;
    additionalTaxRate?: DecimalInput;
  };
  overhead: {
    haulingISK?: DecimalInput;
    blueprintCashISK?: DecimalInput;
    blueprintOpportunityISK?: DecimalInput;
    otherCashISK?: DecimalInput;
    otherOpportunityISK?: DecimalInput;
  };
}

/** Structural subset of a server-produced depth quote, never a client price input. */
export interface ManufacturingDepthQuote {
  regionId: number;
  typeId: number;
  stationId: number;
  solarSystemId: number;
  side: 'buy_materials' | 'sell_output';
  quantity: number;
  filledQuantity: number;
  unfilledQuantity: number;
  grossISK: string;
  coverage: 'complete' | 'partial' | 'unknown';
  completePages: boolean;
  exclusionsVerified: boolean;
  estimateReady: boolean;
  sourceFreshness: 'fresh' | 'stale' | 'unknown';
  generatedAt: string;
}

export interface ManufacturingEvidence {
  materials: Array<{
    typeId: number;
    ownedQuantity: number | null;
    purchaseAll: ManufacturingDepthQuote | null;
    purchaseMissing: ManufacturingDepthQuote | null;
    sellOwned: ManufacturingDepthQuote | null;
  }>;
  output: ManufacturingDepthQuote | null;
  walletISK: string | null;
  /** Active usable levels, not merely trained levels. Missing means zero only if complete. */
  skills: { complete: boolean; levels: Array<{ typeId: number; level: number }> } | null;
  industry: {
    costIndex: string | null;
    adjustedPrices: Array<{ typeId: number; adjustedPriceISK: string | null }>;
    ready: boolean;
  } | null;
}

const DECIMAL_PATTERN = '^(0|[1-9][0-9]{0,15})(\\.[0-9]{1,18})?$';
const decimalSchema = { type: ['string', 'null'], pattern: DECIMAL_PATTERN, maxLength: 35 } as const;
const decimalFields = (names: readonly string[]) => Object.fromEntries(names.map(name => [name, decimalSchema]));
const saleFields = ['salesTaxRate', 'listedBrokerRate', 'listedBrokerMinimumISK', 'listedUnitPriceISK'] as const;
const jobFields = ['quotedInstallationISK', 'jobCostMultiplier', 'facilityTaxRate', 'sccSurchargeRate', 'alphaTaxRate', 'additionalTaxRate'] as const;
const overheadFields = ['haulingISK', 'blueprintCashISK', 'blueprintOpportunityISK', 'otherCashISK', 'otherOpportunityISK'] as const;

/** Rates are fractions (0.04 = 4%). Every omitted/null cost remains unknown. */
export const manufacturingPlanSchema = {
  type: 'object', additionalProperties: false,
  required: ['runs', 'materialEfficiency', 'facilityMaterialMultiplier', 'blueprint', 'facilityAccessConfirmed', 'sale', 'job', 'overhead'],
  properties: {
    runs: { type: 'integer', minimum: 1, maximum: 1_000_000 },
    materialEfficiency: { type: 'integer', minimum: 0, maximum: 10 },
    facilityMaterialMultiplier: { type: 'string', pattern: DECIMAL_PATTERN, maxLength: 35, description: 'Explicit material multiplier greater than 0 and at most 1; 1 means no facility reduction.' },
    blueprint: {
      type: 'object', additionalProperties: false, required: ['kind', 'accessConfirmed'],
      properties: { kind: { type: 'string', enum: ['original', 'copy', 'unknown'] }, remainingRuns: { type: 'integer', minimum: 0, maximum: 1_000_000_000_000 }, accessConfirmed: { type: 'boolean' } },
    },
    facilityAccessConfirmed: { type: 'boolean' },
    sale: { type: 'object', additionalProperties: false, properties: decimalFields(saleFields) },
    job: { type: 'object', additionalProperties: false, properties: decimalFields(jobFields) },
    overhead: { type: 'object', additionalProperties: false, properties: decimalFields(overheadFields) },
  },
} as const;

export class ManufacturingInputError extends Error {
  readonly status = 400;
  constructor(message: string) { super(message); this.name = 'ManufacturingInputError'; }
}

const SCALE = 10n ** 18n;
const CENT = SCALE / 100n;
const MAX_QUANTITY = 1_000_000_000_000;
const decimalPattern = new RegExp(DECIMAL_PATTERN);
type MaybeMoney = bigint | null;
const fail = (message: string): never => { throw new ManufacturingInputError(message); };
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(`Invalid ${label}.`);
  return value as number;
}
function decimal(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || value.length > 35 || !decimalPattern.test(value)) fail(`Invalid ${label}; use a nonnegative decimal string with at most 18 decimal places.`);
  const [whole, fraction = ''] = (value as string).split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
}
function rate(value: unknown, label: string, positive = false): bigint {
  const parsed = decimal(value, label);
  if (parsed > SCALE || (positive && parsed === 0n)) fail(`Invalid ${label}; use a fraction ${positive ? 'greater than zero and ' : ''}at most one.`);
  return parsed;
}
function record(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`Invalid ${label}.`);
  return value as Record<string, unknown>;
}
function array(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(`Invalid ${label}.`);
  return value as unknown[];
}
function bool(value: unknown, label: string) { if (typeof value !== 'boolean') fail(`Invalid ${label}.`); }
function uniqueId(seen: Set<number>, value: unknown, label: string): number {
  const id = integer(value, 1, Number.MAX_SAFE_INTEGER, label);
  if (seen.has(id)) fail(`Duplicate ${label}.`);
  seen.add(id); return id;
}
const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
const toCostCents = (scaledISK: bigint) => ceil(scaledISK, CENT);
const toRevenueCents = (scaledISK: bigint) => scaledISK / CENT;
const money = (cents: MaybeMoney): string | null => cents === null ? null : `${cents < 0n ? '-' : ''}${(cents < 0n ? -cents : cents) / 100n}.${((cents < 0n ? -cents : cents) % 100n).toString().padStart(2, '0')}`;
const sum = (...values: MaybeMoney[]): MaybeMoney => values.some(value => value === null) ? null : (values as bigint[]).reduce((a, b) => a + b, 0n);
const subtract = (a: MaybeMoney, b: MaybeMoney): MaybeMoney => a === null || b === null ? null : a - b;
const tax = (cents: MaybeMoney, taxRate: bigint | null): MaybeMoney => cents === null || taxRate === null ? null : ceil(cents * taxRate, SCALE);

export function validateManufacturingPlan(value: unknown): ManufacturingPlan {
  const p = record(value, ['runs', 'materialEfficiency', 'facilityMaterialMultiplier', 'blueprint', 'facilityAccessConfirmed', 'sale', 'job', 'overhead'], 'manufacturing plan');
  integer(p.runs, 1, 1_000_000, 'runs'); integer(p.materialEfficiency, 0, 10, 'material efficiency');
  rate(p.facilityMaterialMultiplier, 'facility material multiplier', true);
  const bp = record(p.blueprint, ['kind', 'remainingRuns', 'accessConfirmed'], 'blueprint assumptions');
  if (!['original', 'copy', 'unknown'].includes(String(bp.kind))) fail('Invalid blueprint kind.');
  if (bp.remainingRuns !== undefined) integer(bp.remainingRuns, 0, MAX_QUANTITY, 'blueprint remaining runs');
  bool(bp.accessConfirmed, 'blueprint access confirmation'); bool(p.facilityAccessConfirmed, 'facility access confirmation');
  for (const [key, fields] of [['sale', saleFields], ['job', jobFields], ['overhead', overheadFields]] as const) {
    const section = record(p[key], fields, `${key} assumptions`);
    for (const name of fields) {
      if (section[name] === undefined || section[name] === null) continue;
      if (name.endsWith('Rate') || name === 'jobCostMultiplier') rate(section[name], name, name === 'jobCostMultiplier');
      else decimal(section[name], name);
    }
  }
  return value as ManufacturingPlan;
}

function validateRecipe(recipe: ManufacturingRecipe) {
  if (!recipe || recipe.activity !== 'manufacturing') fail('A validated manufacturing recipe is required.');
  integer(recipe.blueprintTypeId, 1, Number.MAX_SAFE_INTEGER, 'blueprint type');
  if (typeof recipe.blueprintName !== 'string' || recipe.blueprintName.length > 300) fail('Invalid blueprint name.');
  integer(recipe.timeSeconds, 1, MAX_QUANTITY, 'base manufacturing time');
  integer(recipe.maxProductionLimit, 1, MAX_QUANTITY, 'blueprint copy limit metadata');
  for (const [key, rows] of [['materials', recipe.materials], ['products', recipe.products]] as const) {
    const seen = new Set<number>();
    if (!array(rows, 1000, `recipe ${key}`).length) fail(`Recipe ${key} must not be empty.`);
    for (const row of rows) {
      if (!row || typeof row !== 'object') fail(`Invalid recipe ${key}.`);
      uniqueId(seen, row.typeId, `recipe ${key} type`); integer(row.quantity, 1, MAX_QUANTITY, `recipe ${key} quantity`);
      if (typeof row.name !== 'string' || row.name.length > 300) fail(`Invalid recipe ${key} name.`);
    }
  }
  if (recipe.products.length !== 1) fail('This estimate supports single-product manufacturing recipes only.');
  const seen = new Set<number>();
  array(recipe.skills, 100, 'recipe skills');
  for (const skill of recipe.skills) {
    if (!skill || typeof skill !== 'object') fail('Invalid recipe skill.');
    uniqueId(seen, skill.typeId, 'recipe skill type'); integer(skill.level, 1, 5, 'recipe skill level');
    if (typeof skill.name !== 'string' || skill.name.length > 300) fail('Invalid recipe skill name.');
  }
}

const requirementPolicy = 'Whole-job exact rational ceiling after ME and the explicit facility material multiplier, with at least one unit of each material per run. This conservative model does not assume undocumented intermediate game rounding; compare the in-game installation preview.';
export function manufacturingRequirements(recipe: ManufacturingRecipe, plan: Pick<ManufacturingPlan, 'runs' | 'materialEfficiency' | 'facilityMaterialMultiplier'>) {
  validateRecipe(recipe);
  const runs = integer(plan.runs, 1, 1_000_000, 'runs');
  const me = integer(plan.materialEfficiency, 0, 10, 'material efficiency');
  const facility = rate(plan.facilityMaterialMultiplier, 'facility material multiplier', true);
  const materials = recipe.materials.map(material => {
    const scaled = ceil(BigInt(material.quantity) * BigInt(runs) * BigInt(100 - me) * facility, 100n * SCALE);
    const quantity = scaled < BigInt(runs) ? BigInt(runs) : scaled;
    if (quantity > BigInt(MAX_QUANTITY)) fail('Requested material quantity exceeds the supported limit.');
    return { typeId: material.typeId, name: material.name, baseQuantity: material.quantity, requiredQuantity: Number(quantity) };
  });
  const outputQuantity = BigInt(recipe.products[0].quantity) * BigInt(runs);
  if (outputQuantity > BigInt(MAX_QUANTITY)) fail('Requested output quantity exceeds the supported limit.');
  return {
    blueprintTypeId: recipe.blueprintTypeId, runs, materialEfficiency: me, facilityMaterialMultiplier: plan.facilityMaterialMultiplier,
    materials, product: { typeId: recipe.products[0].typeId, name: recipe.products[0].name, quantity: Number(outputQuantity) },
    baseTimeSecondsPerRun: recipe.timeSeconds,
    policy: requirementPolicy,
  };
}

/** Evidence contains already scoped holdings; unrelated/personal records must never be passed. */
export function estimateManufacturing(recipe: ManufacturingRecipe, input: ManufacturingPlan, evidence: ManufacturingEvidence) {
  const plan = validateManufacturingPlan(input);
  const requirements = manufacturingRequirements(recipe, plan);
  const reasons: string[] = [];
  const missing = (reason: string): null => { if (!reasons.includes(reason)) reasons.push(reason); return null; };
  const assumedRate = (value: DecimalInput | undefined, name: string) => value == null ? missing(`${name} is unknown; supply an explicit fraction, including zero when applicable.`) : rate(value, name, name === 'jobCostMultiplier');
  const assumedCost = (value: DecimalInput | undefined, name: string) => value == null ? missing(`${name} is unknown; supply an explicit total ISK amount, including zero when applicable.`) : toCostCents(decimal(value, name));
  if (!evidence || typeof evidence !== 'object') fail('Manufacturing evidence is required.');
  const materialEvidence = new Map<number, ManufacturingEvidence['materials'][number]>();
  const materialIds = new Set(requirements.materials.map(row => row.typeId));
  array(evidence.materials, 1000, 'material evidence');
  for (const row of evidence.materials) {
    if (!row || typeof row !== 'object' || !materialIds.has(row.typeId) || materialEvidence.has(row.typeId)) fail('Invalid or duplicate material evidence.');
    if (row.ownedQuantity !== null) integer(row.ownedQuantity, 0, MAX_QUANTITY, 'owned material quantity');
    materialEvidence.set(row.typeId, row);
  }
  const pricingEvidence: Array<{ purpose: string; typeId: number; quantity: number; regionId: number; stationId: number; solarSystemId: number; generatedAt: string }> = [];
  let marketLocation: { regionId: number; stationId: number; solarSystemId: number } | null = null;
  function quoteCost(quote: ManufacturingDepthQuote | null | undefined, typeId: number, quantity: number | null, side: ManufacturingDepthQuote['side'], purpose: string): MaybeMoney {
    if (quantity === 0) return 0n;
    if (quantity === null) return missing(`${purpose}: the required quantity is unknown.`);
    if (!quote) return missing(`${purpose}: a fresh full-depth quote is unavailable.`);
    if (quote.typeId !== typeId || quote.side !== side || quote.quantity !== quantity) return missing(`${purpose}: quote type, side or requested quantity does not match.`);
    if (!quote.estimateReady || quote.coverage !== 'complete' || !quote.completePages || !quote.exclusionsVerified || quote.sourceFreshness !== 'fresh' || quote.filledQuantity !== quantity || quote.unfilledQuantity !== 0) return missing(`${purpose}: full fresh depth and verified owned-order exclusions are required.`);
    for (const [label, value] of [['quote region', quote.regionId], ['quote station', quote.stationId], ['quote system', quote.solarSystemId]] as const) integer(value, 1, Number.MAX_SAFE_INTEGER, label);
    if (typeof quote.generatedAt !== 'string' || !Number.isFinite(Date.parse(quote.generatedAt))) return missing(`${purpose}: quote timestamp is unavailable.`);
    if (marketLocation && (quote.regionId !== marketLocation.regionId || quote.stationId !== marketLocation.stationId || quote.solarSystemId !== marketLocation.solarSystemId)) return missing(`${purpose}: all market quotes must use the same selected station.`);
    marketLocation ??= { regionId: quote.regionId, stationId: quote.stationId, solarSystemId: quote.solarSystemId };
    if (typeof quote.grossISK !== 'string' || !/^(0|[1-9][0-9]{0,30})\.[0-9]{2}$/.test(quote.grossISK)) fail('Invalid depth quote gross amount.');
    const [whole, fraction] = quote.grossISK.split('.');
    pricingEvidence.push({ purpose, typeId, quantity, ...marketLocation, generatedAt: quote.generatedAt });
    return BigInt(whole) * 100n + BigInt(fraction);
  }

  const salesTaxRate = assumedRate(plan.sale.salesTaxRate, 'salesTaxRate');
  const cashMaterialValues: MaybeMoney[] = [], ownedMaterialValues: MaybeMoney[] = [], replacementValues: MaybeMoney[] = [];
  const materials = requirements.materials.map(material => {
    const row = materialEvidence.get(material.typeId);
    const ownedUsed = row?.ownedQuantity == null ? missing(`Material ${material.typeId}: scoped owned quantity is unknown.`) : Math.min(row.ownedQuantity, material.requiredQuantity);
    const missingQuantity = ownedUsed === null ? null : material.requiredQuantity - ownedUsed;
    const purchaseAll = quoteCost(row?.purchaseAll, material.typeId, material.requiredQuantity, 'buy_materials', `Material ${material.typeId} replacement purchase`);
    const purchaseMissing = quoteCost(row?.purchaseMissing, material.typeId, missingQuantity, 'buy_materials', `Material ${material.typeId} cash purchase`);
    const ownedGross = quoteCost(row?.sellOwned, material.typeId, ownedUsed, 'sell_output', `Material ${material.typeId} owned opportunity`);
    // Already-owned inputs retain the net proceeds forgone by not selling them now.
    const ownedOpportunity = ownedUsed === 0 ? 0n : subtract(ownedGross, tax(ownedGross, salesTaxRate));
    cashMaterialValues.push(purchaseMissing); ownedMaterialValues.push(ownedOpportunity); replacementValues.push(purchaseAll);
    return { ...material, ownedAvailableQuantity: row?.ownedQuantity ?? null, ownedUsedQuantity: ownedUsed, missingQuantity, replacementPurchaseISK: money(purchaseAll), additionalPurchaseISK: money(purchaseMissing), ownedOpportunityISK: money(ownedOpportunity) };
  });
  const additionalMaterialCash = sum(...cashMaterialValues), ownedMaterialOpportunity = sum(...ownedMaterialValues), replacementMaterialCost = sum(...replacementValues);

  let installation: MaybeMoney = null;
  let installationMode: 'user_quote_assumption' | 'adjusted_price_model' = 'adjusted_price_model';
  let estimatedItemValue: MaybeMoney = null;
  let jobBreakdown: { systemCostISK: string | null; facilityTaxISK: string | null; sccSurchargeISK: string | null; alphaTaxISK: string | null; additionalTaxISK: string | null } | null = null;
  if (plan.job.quotedInstallationISK != null) {
    installation = assumedCost(plan.job.quotedInstallationISK, 'quotedInstallationISK');
    installationMode = 'user_quote_assumption';
  } else {
    const multiplier = assumedRate(plan.job.jobCostMultiplier, 'jobCostMultiplier');
    const facilityTaxRate = assumedRate(plan.job.facilityTaxRate, 'facilityTaxRate');
    const sccRate = assumedRate(plan.job.sccSurchargeRate, 'sccSurchargeRate');
    const alphaRate = assumedRate(plan.job.alphaTaxRate, 'alphaTaxRate');
    const additionalRate = assumedRate(plan.job.additionalTaxRate, 'additionalTaxRate');
    let eivScaled: bigint | null = null, costIndex: bigint | null = null;
    if (!evidence.industry?.ready) missing('Fresh adjusted prices and the selected manufacturing system cost index are unavailable.');
    else {
      costIndex = evidence.industry.costIndex === null ? missing('Manufacturing system cost index is unknown.') : rate(evidence.industry.costIndex, 'manufacturing system cost index');
      array(evidence.industry.adjustedPrices, 1000, 'adjusted prices');
      const adjusted = new Map<number, bigint | null>();
      for (const price of evidence.industry.adjustedPrices) {
        if (!price || !materialIds.has(price.typeId) || adjusted.has(price.typeId)) fail('Invalid or duplicate adjusted material price.');
        adjusted.set(price.typeId, price.adjustedPriceISK === null ? null : decimal(price.adjustedPriceISK, 'adjusted material price'));
      }
      eivScaled = 0n;
      for (const material of recipe.materials) {
        const price = adjusted.get(material.typeId);
        if (price == null) { eivScaled = missing(`Material ${material.typeId}: adjusted price is unknown.`); break; }
        eivScaled += price * BigInt(material.quantity) * BigInt(plan.runs);
      }
    }
    // CCP's EIV uses base inputs, not the ME/facility-reduced purchase quantities.
    const component = (factor: bigint | null) => eivScaled === null || factor === null ? null : ceil(eivScaled * factor, SCALE * CENT);
    const system = eivScaled === null || costIndex === null || multiplier === null ? null : ceil(eivScaled * costIndex * multiplier, SCALE * SCALE * CENT);
    const facility = component(facilityTaxRate), scc = component(sccRate), alpha = component(alphaRate), additional = component(additionalRate);
    installation = sum(system, facility, scc, alpha, additional);
    estimatedItemValue = eivScaled === null ? null : toCostCents(eivScaled);
    jobBreakdown = { systemCostISK: money(system), facilityTaxISK: money(facility), sccSurchargeISK: money(scc), alphaTaxISK: money(alpha), additionalTaxISK: money(additional) };
  }
  const hauling = assumedCost(plan.overhead.haulingISK, 'haulingISK');
  const blueprintCash = assumedCost(plan.overhead.blueprintCashISK, 'blueprintCashISK');
  const blueprintOpportunity = assumedCost(plan.overhead.blueprintOpportunityISK, 'blueprintOpportunityISK');
  const otherCash = assumedCost(plan.overhead.otherCashISK, 'otherCashISK');
  const otherOpportunity = assumedCost(plan.overhead.otherOpportunityISK, 'otherOpportunityISK');
  const directOverhead = sum(installation, hauling, blueprintCash, otherCash);
  const opportunityOverhead = sum(blueprintOpportunity, otherOpportunity);
  const cashRequired = sum(additionalMaterialCash, directOverhead);
  const economicCost = sum(cashRequired, ownedMaterialOpportunity, opportunityOverhead);
  const buyAllEconomicCost = sum(replacementMaterialCost, directOverhead, opportunityOverhead);

  const instantGross = quoteCost(evidence.output, requirements.product.typeId, requirements.product.quantity, 'sell_output', 'Output instant sale');
  const instantTax = tax(instantGross, salesTaxRate), instantNet = subtract(instantGross, instantTax);
  const instantProfit = subtract(instantNet, economicCost), instantBuyAllProfit = subtract(instantNet, buyAllEconomicCost);
  const listedPrice = plan.sale.listedUnitPriceISK == null ? null : decimal(plan.sale.listedUnitPriceISK, 'listedUnitPriceISK');
  let listed: { kind: 'hypothetical_listed_sale'; grossRevenueISK: string | null; salesTaxISK: string | null; brokerFeeISK: string | null; netRevenueISK: string | null; economicProfitISK: string | null; buyAllProfitISK: string | null; upfrontCashRequiredISK: string | null; complete: boolean; warning: string } | null = null;
  let listedUpfront: MaybeMoney = null;
  if (listedPrice !== null) {
    const listedGrossScaled = listedPrice * BigInt(requirements.product.quantity);
    const listedGross = toRevenueCents(listedGrossScaled);
    const brokerRate = assumedRate(plan.sale.listedBrokerRate, 'listedBrokerRate');
    const brokerMinimum = assumedCost(plan.sale.listedBrokerMinimumISK, 'listedBrokerMinimumISK');
    const listedFee = (feeRate: bigint | null) => feeRate === null ? null : ceil(listedGrossScaled * feeRate, SCALE * CENT);
    const brokerCalculated = listedFee(brokerRate);
    const brokerFee = brokerCalculated === null || brokerMinimum === null ? null : brokerCalculated > brokerMinimum ? brokerCalculated : brokerMinimum;
    const listedTax = listedFee(salesTaxRate), listedNet = subtract(subtract(listedGross, listedTax), brokerFee);
    const listedProfit = subtract(listedNet, economicCost);
    listedUpfront = sum(cashRequired, brokerFee);
    listed = {
      kind: 'hypothetical_listed_sale', grossRevenueISK: money(listedGross), salesTaxISK: money(listedTax), brokerFeeISK: money(brokerFee), netRevenueISK: money(listedNet), economicProfitISK: money(listedProfit), buyAllProfitISK: money(subtract(listedNet, buyAllEconomicCost)), upfrontCashRequiredISK: money(listedUpfront), complete: listedProfit !== null,
      warning: 'The supplied asking price is an assumption, not executable demand or realized profit. No fill, timing, future price, relisting or cancellation costs are inferred; include their allowance in explicit overhead.',
    };
  }

  const skillLevels = new Map<number, number>();
  if (evidence.skills !== null && evidence.skills !== undefined) {
    bool(evidence.skills.complete, 'skill coverage'); array(evidence.skills.levels, 10000, 'active skill levels');
    for (const skill of evidence.skills.levels) {
      if (!skill || skillLevels.has(skill.typeId)) fail('Invalid or duplicate active skill.');
      integer(skill.typeId, 1, Number.MAX_SAFE_INTEGER, 'active skill type');
      skillLevels.set(skill.typeId, integer(skill.level, 0, 5, 'active skill level'));
    }
  }
  const skills = recipe.skills.map(skill => {
    const activeLevel = skillLevels.get(skill.typeId) ?? (evidence.skills?.complete ? 0 : null);
    return { typeId: skill.typeId, name: skill.name, requiredLevel: skill.level, activeLevel, status: activeLevel === null ? 'unknown' : activeLevel >= skill.level ? 'met' : 'missing' };
  });
  const skillStatus = skills.some(skill => skill.status === 'missing') ? 'missing' : skills.some(skill => skill.status === 'unknown') ? 'unknown' : 'met';
  const blueprintStatus = plan.blueprint.kind === 'copy' && plan.blueprint.remainingRuns !== undefined && plan.blueprint.remainingRuns < plan.runs ? 'insufficient_copy_runs'
    : !plan.blueprint.accessConfirmed || plan.blueprint.kind === 'unknown' || (plan.blueprint.kind === 'copy' && plan.blueprint.remainingRuns === undefined) ? 'unconfirmed' : 'confirmed_assumption';
  const facilityStatus = plan.facilityAccessConfirmed ? 'confirmed_assumption' : 'unconfirmed';
  const wallet = evidence.walletISK == null ? null : toRevenueCents(decimal(evidence.walletISK, 'available wallet ISK'));
  const affordable = (required: MaybeMoney) => wallet === null || required === null ? null : wallet >= required;
  if (skillStatus === 'unknown') missing('Required active skill eligibility is incomplete.');
  if (skillStatus === 'missing') missing('One or more required active skill levels are not met.');
  if (blueprintStatus === 'unconfirmed') missing('Blueprint access, kind or available copy runs are unconfirmed; finding a recipe does not establish blueprint ownership.');
  if (blueprintStatus === 'insufficient_copy_runs') missing('The selected blueprint copy has too few remaining runs.');
  if (facilityStatus === 'unconfirmed') missing('Facility access, service availability and installation conditions remain unconfirmed.');
  if (wallet === null) missing('Available spending wallet balance is unknown.');
  const instantAffordable = affordable(cashRequired);
  const readiness = skillStatus === 'missing' || blueprintStatus === 'insufficient_copy_runs' || instantAffordable === false ? 'blocked'
    : skillStatus !== 'met' || blueprintStatus !== 'confirmed_assumption' || facilityStatus !== 'confirmed_assumption' || instantAffordable === null ? 'unconfirmed' : 'conditional';
  if (instantAffordable === false) missing('The available wallet is below the modeled upfront cash requirement.');

  return {
    kind: 'manufacturing_scenario_estimate' as const,
    requirements, materials,
    costs: {
      additionalMaterialCashISK: money(additionalMaterialCash), ownedMaterialOpportunityISK: money(ownedMaterialOpportunity), replacementMaterialCostISK: money(replacementMaterialCost),
      installation: { mode: installationMode, estimatedItemValueISK: money(estimatedItemValue), totalISK: money(installation), breakdown: jobBreakdown },
      haulingISK: money(hauling), blueprintCashISK: money(blueprintCash), blueprintOpportunityISK: money(blueprintOpportunity), otherCashISK: money(otherCash), otherOpportunityISK: money(otherOpportunity),
      cashRequiredISK: money(cashRequired), economicCostISK: money(economicCost), buyAllEconomicCostISK: money(buyAllEconomicCost),
    },
    instantSale: { kind: 'current_buy_order_depth' as const, grossRevenueISK: money(instantGross), salesTaxISK: money(instantTax), netRevenueISK: money(instantNet), economicProfitISK: money(instantProfit), buyAllProfitISK: money(instantBuyAllProfit), complete: instantProfit !== null },
    listedSale: listed,
    eligibility: { readiness, blueprint: blueprintStatus, facility: facilityStatus, skills: { status: skillStatus, requirements: skills }, wallet: { availableISK: money(wallet), instantScenarioAffordable: instantAffordable, listedScenarioAffordable: listed === null ? null : affordable(listedUpfront) } },
    reasons,
    pricingEvidence,
    assumptions: {
      materialEfficiency: plan.materialEfficiency, facilityMaterialMultiplier: plan.facilityMaterialMultiplier,
      blueprint: { kind: plan.blueprint.kind, accessConfirmed: plan.blueprint.accessConfirmed, remainingRuns: plan.blueprint.remainingRuns ?? null },
      facilityAccessConfirmed: plan.facilityAccessConfirmed,
      sale: Object.fromEntries(saleFields.map(key => [key, plan.sale[key] ?? null])),
      job: Object.fromEntries(jobFields.map(key => [key, plan.job[key] ?? null])),
      overhead: Object.fromEntries(overheadFields.map(key => [key, plan.overhead[key] ?? null])),
      source: 'User-supplied scenario assumptions; none establish API-verified ownership, facility availability or an actual sale.',
    },
    limitations: [
      requirementPolicy,
      'ISK arithmetic uses fixed-point integers: costs and each fee component round up to cents; gross revenues round down. Installation totals may conservatively exceed game rounding by a few cents.',
      'EIV is base recipe material quantities times adjusted prices times runs. System cost uses its explicit bonus multiplier; facility tax, SCC surcharge, alpha tax and additional tax apply directly to EIV. Rates and any regional surcharge must be checked against the game preview.',
      'Installation model exceptions and future rule changes are not inferred. Supply the full in-game installation quote when applicable; a supplied quote remains an assumption.',
      'Owned materials are valued at forgone net instant-sale proceeds, not zero. The separate buy-all scenario uses full replacement purchase depth. Cash required includes only missing materials and explicit cash costs; do not duplicate one cost in cash and opportunity allowances.',
      'Executable-depth estimates require complete fresh market pages and the caller-verified owned-order exclusion set. They are snapshots, not reserved fills; unlinked characters or corporations may own other orders.',
      'Base recipe time is metadata only. No adjusted build duration, job-slot availability, transport feasibility or sustainable profit rate is inferred. Copy-limit metadata is not a universal manufacturing run cap.',
    ],
    formulaSources: [
      'https://www.eveonline.com/news/view/eve-industry-all-you-want-to-know',
      'https://www.eveonline.com/de/news/view/industry-3rd-party-developers',
      'https://www.eveonline.com/news/view/viridian-expansion-notes',
    ],
  };
}
