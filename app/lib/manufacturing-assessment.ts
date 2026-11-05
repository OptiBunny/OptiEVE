import { EveError, listConnections, readCharacterData, readCorporationData, readEve } from './eve';
import { lookupManufacturingRecipes, readManufacturingCatalogStatus } from './manufacturing-catalog';
import { createManufacturingMarketReader } from './manufacturing-market';
import { projectManufacturingStock } from './manufacturing-stock';
import { estimateManufacturing, manufacturingRequirements, manufacturingPlanSchema, validateManufacturingPlan, type ManufacturingPlan, type ManufacturingEvidence, type ManufacturingRecipe } from './manufacturing-estimate';

const id = { type: 'integer', minimum: 1 };
const division = { type: 'integer', minimum: 1, maximum: 7 };
export const manufacturingAssessmentInputSchema = {
  type: 'object', additionalProperties: false,
  required: ['characterId', 'resourceEntity', 'blueprintTypeId', 'blueprintSource', 'marketRegionId', 'marketStationId', 'manufacturingSystemId', 'useOwnedMaterials', 'otherOwnedOrdersReviewed', 'plan'],
  properties: {
    characterId: id, resourceEntity: { type: 'string', enum: ['character', 'corporation'] }, walletDivision: division,
    hangarDivisions: { type: 'array', minItems: 1, maxItems: 7, uniqueItems: true, items: division },
    blueprintTypeId: id, blueprintSource: { type: 'string', enum: ['owned', 'prospective'] }, blueprintItemId: id,
    blueprintPage: { type: 'integer', minimum: 1, maximum: 500 },
    marketRegionId: id, marketStationId: id, manufacturingSystemId: id, manufacturingStructureId: id,
    useOwnedMaterials: { type: 'boolean' }, stockLocationIds: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: id },
    otherOwnedOrdersReviewed: { type: 'boolean' }, additionalOwnedOrderIds: { type: 'array', maxItems: 1000, uniqueItems: true, items: id },
    maxPrivatePages: { type: 'integer', minimum: 1, maximum: 50, default: 3 },
    maxMarketPages: { type: 'integer', minimum: 1, maximum: 4, default: 2 }, plan: manufacturingPlanSchema,
  },
};
export type ManufacturingAssessmentInput = {
  characterId: number; resourceEntity: 'character' | 'corporation'; walletDivision?: number; hangarDivisions?: number[];
  blueprintTypeId: number; blueprintSource: 'owned' | 'prospective'; blueprintItemId?: number; blueprintPage?: number;
  marketRegionId: number; marketStationId: number; manufacturingSystemId: number; manufacturingStructureId?: number;
  useOwnedMaterials: boolean; stockLocationIds?: number[]; otherOwnedOrdersReviewed: boolean; additionalOwnedOrderIds?: number[];
  maxPrivatePages?: number; maxMarketPages?: number; plan: ManufacturingPlan;
};
export type ManufacturingReadInput = { characterId: number; dataset: string; parameters?: Record<string, unknown> };
export type ManufacturingAssessmentDependencies = {
  connections: (user: string) => Promise<{ characterId: number }[]>;
  character: (user: string, input: ManufacturingReadInput, signal?: AbortSignal) => Promise<unknown>;
  corporation: (user: string, input: ManufacturingReadInput, signal?: AbortSignal) => Promise<unknown>;
  legacy: typeof readEve;
  catalog?: typeof lookupManufacturingRecipes; catalogStatus?: typeof readManufacturingCatalogStatus;
  market?: typeof createManufacturingMarketReader; now?: () => number;
  /** Server-only capture for a request-scoped batch; never an input field. */
  onPrepared?: (prepared: ManufacturingPreparedAssessment) => void;
};
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const listIds = (v: unknown, min: number, max: number, idMax = Number.MAX_SAFE_INTEGER): v is number[] => Array.isArray(v) && v.length >= min && v.length <= max && v.every(x => integer(x, 1, idMax)) && new Set(v).size === v.length;
const invalid = (): never => { throw new EveError('Choose a bounded manufacturing plan, resource owner, wallet/hangars, and explicit market/facility assumptions.'); };
export function validateManufacturingAssessmentInput(value: unknown): ManufacturingAssessmentInput {
  if (!record(value) || Object.keys(value).some(key => !Object.hasOwn(manufacturingAssessmentInputSchema.properties, key)) ||
      !['characterId', 'blueprintTypeId', 'marketRegionId', 'marketStationId', 'manufacturingSystemId'].every(key => integer(value[key], 1)) ||
      !['character', 'corporation'].includes(value.resourceEntity as string) || !['owned', 'prospective'].includes(value.blueprintSource as string) ||
      typeof value.useOwnedMaterials !== 'boolean' || typeof value.otherOwnedOrdersReviewed !== 'boolean') return invalid();
  if (value.resourceEntity === 'corporation' ? !integer(value.walletDivision, 1, 7) : value.walletDivision !== undefined || value.hangarDivisions !== undefined) return invalid();
  if (value.hangarDivisions !== undefined && !listIds(value.hangarDivisions, 1, 7, 7)) return invalid();
  if (value.blueprintSource === 'owned' ? !integer(value.blueprintItemId, 1) : value.blueprintItemId !== undefined || value.blueprintPage !== undefined) return invalid();
  for (const [key, maximum] of [['blueprintPage', 500], ['maxPrivatePages', 50], ['maxMarketPages', 4]] as const) if (value[key] !== undefined && !integer(value[key], 1, maximum)) return invalid();
  if (value.manufacturingStructureId !== undefined && !integer(value.manufacturingStructureId, 1)) return invalid();
  if (value.additionalOwnedOrderIds !== undefined && !listIds(value.additionalOwnedOrderIds, 0, 1000)) return invalid();
  if (value.useOwnedMaterials ? !listIds(value.stockLocationIds, 1, 10) || value.resourceEntity === 'corporation' && !value.hangarDivisions : value.stockLocationIds !== undefined || value.hangarDivisions !== undefined) return invalid();
  validateManufacturingPlan(value.plan);
  return value as ManufacturingAssessmentInput;
}
function money(value: unknown): string | null {
  // ESI wallet numbers may include sub-cent fractions. Convert the received
  // number's decimal representation with integer arithmetic, never floating
  // multiplication or rounding that could increase available funds.
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e12) return null;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(value));
  if (!match) return null;
  const fraction = match[2] ?? '', coefficient = BigInt(match[1] + fraction);
  const centExponent = Number(match[3] ?? 0) - fraction.length + 2;
  const cents = centExponent >= 0 ? coefficient * 10n ** BigInt(centExponent) : coefficient / 10n ** BigInt(-centExponent);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}
type Source = { entity: string; dataset: string; page: number | null; retrievedAt: string; cacheExpires: string | null; freshness: 'fresh' | 'stale' | 'unknown' };
export function manufacturingExpiryTime(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 100) return null;
  const parsed = Date.parse(value); if (!Number.isFinite(parsed)) return null;
  const iso = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  // Date.parse normalizes impossible dates. Accept only exact ISO/HTTP dates
  // emitted by our adapters and provider headers, never their normalized form.
  return (iso ? new Date(parsed).toISOString() === `${iso[1]}.${(iso[2] ?? '').padEnd(3, '0')}Z` : new Date(parsed).toUTCString() === value) ? parsed : null;
}
export function manufacturingPrivateExpiry(value: Record<string, unknown>, received: number): string | null {
  const expires = manufacturingExpiryTime(value.cacheExpires), date = manufacturingExpiryTime(value.responseDate);
  const control = typeof value.cacheControl === 'string' && value.cacheControl.length <= 256 ? value.cacheControl : '';
  const age = value.cacheAge == null ? 0 : typeof value.cacheAge === 'string' && /^\d+$/.test(value.cacheAge) ? Number(value.cacheAge) : NaN;
  const match = /(?:^|,)\s*max-age=(\d+)(?:\s*(?:,|$))/i.exec(control), maxAge = match ? Number(match[1]) : null;
  const cached = maxAge !== null && integer(maxAge, 0, 604800) && integer(age, 0, 604800) && date !== null && date <= received + 60000 ? Math.min(date + maxAge * 1000, received + (maxAge - age) * 1000) : null;
  let expiry = expires === null ? cached : cached === null ? expires : Math.min(expires, cached);
  if (/(?:^|,)\s*(?:no-cache|no-store)(?:\s*(?:,|$))/i.test(control)) expiry = received;
  return expiry === null ? null : new Date(expiry).toISOString();
}
export function manufacturingSourceFreshness(sources: unknown, at: number): 'fresh' | 'stale' | 'unknown' {
  if (!Array.isArray(sources) || sources.length === 0) return 'unknown';
  let unknown = false;
  for (const source of sources) {
    const expiry = record(source) ? manufacturingExpiryTime(source.cacheExpires) : null;
    if (expiry === null) unknown = true; else if (expiry <= at) return 'stale';
  }
  return unknown ? 'unknown' : 'fresh';
}
export async function manufacturingAbortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); });
  // A synchronous reader may abort and throw before Promise.race attaches.
  void interrupted.catch(() => {});
  try { const value = await Promise.race([work(), interrupted]); signal.throwIfAborted(); return value; }
  finally { signal.removeEventListener('abort', cancel); }
}

export type ManufacturingPreparedAssessment = {
  args: ManufacturingAssessmentInput; recipe: ManufacturingRecipe; plan: ManufacturingPlan;
  materials: ManufacturingEvidence['materials']; output: ManufacturingEvidence['output'];
  skills: ManufacturingEvidence['skills']; industry: ManufacturingEvidence['industry']; walletISK: string | null;
  privateSources: Source[]; industrySources: unknown; catalogStatus: Awaited<ReturnType<typeof readManufacturingCatalogStatus>>;
  catalogProvenance: unknown; liquidity: unknown; exclusionsVerified: boolean; ownOrderIds: number[];
  /** Internal location proof from server-validated market responses, retained
   * separately when a joint plan replaces quotes with its shared allocations. */
  stationGeography: Array<{ stationId: number; regionId: number; sources: unknown }>;
  stockComplete: boolean; stockByDivision: Record<string, Record<string, number>>; structureVerified: boolean; issues: string[];
};

/** Revalidate immutable, server-derived evidence at a caller's shared completion instant. */
export function finalizeManufacturingAssessment(prepared: ManufacturingPreparedAssessment, completedAt: number) {
  const snapshot = structuredClone(prepared);
  const { args, recipe, plan, materials, output, industry, privateSources, industrySources, catalogStatus, catalogProvenance, liquidity, stationGeography, issues } = snapshot;
  let { skills, walletISK, exclusionsVerified, stockComplete, stockByDivision, structureVerified } = snapshot;
  const privateFresh = (entity: string, dataset: string, at: number) => manufacturingSourceFreshness(privateSources.filter(source => source.entity === entity && source.dataset === dataset), at) === 'fresh';
  // Every decision uses the same completion-time freshness boundary. Earlier
  // reads may expire while later pages, books or the catalog are in flight.
  for (const source of privateSources) source.freshness = manufacturingSourceFreshness([source], completedAt);
  for (const source of privateSources) if (source.freshness !== 'fresh') issues.push(`${source.entity} ${source.dataset}: freshness is ${source.freshness} at completion; it cannot establish current eligibility, stock or funding.`);
  if (!privateFresh(args.resourceEntity, args.resourceEntity === 'corporation' ? 'wallet_balances' : 'wallet_balance', completedAt)) walletISK = null;
  if (!privateFresh('character', 'skills', completedAt)) skills = null;
  if (args.blueprintSource === 'owned' && !privateFresh(args.resourceEntity, 'blueprints', completedAt)) plan.blueprint.accessConfirmed = false;
  if (args.manufacturingStructureId !== undefined && !privateFresh('character', 'structure', completedAt)) structureVerified = false;
  const depths = [...materials.flatMap(material => [material.purchaseAll, material.purchaseMissing, material.sellOwned]), output];
  // Location evidence remains independent of fillability and own-order review.
  // Retain its original provenance and recheck expiry; never carry a bare true
  // flag from an earlier assessment or accept location proof from the caller.
  const marketStationVerified = stationGeography.some(location => location.stationId === args.marketStationId && location.regionId === args.marketRegionId && manufacturingSourceFreshness(location.sources, completedAt) === 'fresh');
  if (args.useOwnedMaterials && !marketStationVerified) {
    stockComplete = false;
    issues.push('Public market-station geography was not freshly verified; stock at an unverified facility cannot establish affordability.');
  }
  if (args.useOwnedMaterials && (!privateFresh(args.resourceEntity, 'assets', completedAt) || args.stockLocationIds!.some(location => location !== args.marketStationId) && args.manufacturingStructureId !== undefined && !structureVerified)) stockComplete = false;
  if (!stockComplete) { stockByDivision = {}; for (const material of materials) { material.ownedQuantity = null; material.purchaseMissing = null; material.sellOwned = null; } }
  exclusionsVerified &&= privateFresh('character', 'orders', completedAt) && (args.resourceEntity !== 'corporation' || privateFresh('corporation', 'orders', completedAt));
  const catalogCurrent = catalogStatus.status === 'current' && manufacturingSourceFreshness([catalogStatus], completedAt) === 'fresh';
  if (!catalogCurrent) {
    issues.push('The official recipe catalog is outdated or its freshness is unverified. All manufacturing decisions remain conditional until the catalog is current.');
    plan.blueprint.accessConfirmed = false; walletISK = null;
  }
  for (const depth of depths) if (depth) {
    depth.sourceFreshness = manufacturingSourceFreshness((depth as unknown as { sources?: unknown }).sources, completedAt);
    depth.exclusionsVerified &&= exclusionsVerified;
    const validUntil = manufacturingExpiryTime((depth as unknown as { validUntil?: unknown }).validUntil);
    depth.estimateReady &&= depth.stationId === args.marketStationId && depth.regionId === args.marketRegionId && depth.sourceFreshness === 'fresh' && validUntil !== null && validUntil > completedAt && exclusionsVerified && catalogCurrent;
  }
  if (industry) industry.ready &&= manufacturingSourceFreshness(industrySources, completedAt) === 'fresh' && catalogCurrent;
  if (record(liquidity)) liquidity.sourceFreshness = manufacturingSourceFreshness(liquidity.sources, completedAt);
  const estimate = estimateManufacturing(recipe, plan, { materials, output, walletISK, skills, industry });
  return {
    generatedAt: new Date(completedAt).toISOString(), currentRecipeVerified: catalogCurrent, resourceEntity: args.resourceEntity, selectedWalletDivision: args.walletDivision ?? null,
    walletPrecisionPolicy: 'Available wallet funds use the decimal representation of the received numeric balance, floored to whole ISK cents with integer arithmetic. Sub-cent fractions are discarded; malformed or out-of-range balances remain unknown.',
    selectedHangarDivisions: args.hangarDivisions ?? [], selectedStockLocationIds: args.stockLocationIds ?? [],
    stockCoverage: stockComplete ? 'complete-selected-verified-locations' : 'unknown', stockBySelectedDivision: stockComplete ? stockByDivision : {},
    blueprintSource: args.blueprintSource, structureSystemVerified: structureVerified, marketStationVerified, ownOrdersComplete: exclusionsVerified,
    ownOrderScope: 'Selected character and, for corporation resources, its current corporation; additional account exclusions require the explicit caller review.',
    catalog: { provenance: catalogProvenance, status: catalogStatus }, estimate, liquidity, privateSources,
    conditions: [...new Set(issues)],
    limitations: ['A scenario estimate is not realized profit, a trade, a job installation or a jointly affordable portfolio.', 'Blueprint job availability, facility service availability, delivery rights and hauling are not established by ownership or structure-info access.', 'Stock is restricted to selected verified facilities, offices or containers with bounded validated parent chains and inherited hangar divisions. Inaccessible or unresolved paths are never credited.', 'Different corporation wallet divisions and personal funds are never combined.', 'All account evidence stays in request memory; pagination snapshots may change between requests.'],
  };
}
export type ManufacturingAssessment = ReturnType<typeof finalizeManufacturingAssessment>;

/** One owner-scoped, bounded, memory-only assessment. No client supplied prices,
 * balances, stock quantities or skill claims become authoritative evidence. */
export function createManufacturingAssessment(deps: ManufacturingAssessmentDependencies) {
  return async (user: string, raw: unknown, options: { signal?: AbortSignal } = {}) => {
    const args = validateManufacturingAssessmentInput(raw), now = deps.now ?? Date.now;
    if (!user) throw new EveError('Sign in to the private connector first.', 401);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    if (!(await manufacturingAbortable(() => deps.connections(user), signal)).some(c => c.characterId === args.characterId)) throw new EveError('Choose an owned connected manufacturing character.', 404);
    const catalog = (deps.catalog ?? lookupManufacturingRecipes)({ blueprintTypeId: args.blueprintTypeId });
    const recipe = catalog.recipes[0];
    if (!recipe || recipe.products.length !== 1 || recipe.materials.length > 12) throw new EveError('This assessment supports one published manufacturing product and at most 12 material types. Select another recipe or inspect its official catalog data.');
    const plan: ManufacturingPlan = structuredClone(args.plan), issues: string[] = [], privateSources: Source[] = [];
    const market = (deps.market ?? createManufacturingMarketReader)();
    let corporationId: number | null = null;
    const privateFresh = (entity: string, dataset: string, at = now()) => manufacturingSourceFreshness(privateSources.filter(source => source.entity === entity && source.dataset === dataset), at) === 'fresh';
    async function read(entity: 'character' | 'corporation', dataset: string, page?: number, legacy = false, parameters?: Record<string, unknown>): Promise<Record<string, unknown> | null> {
      signal.throwIfAborted();
      let value: unknown;
      try {
        value = await manufacturingAbortable(() => legacy ? deps.legacy(user, { characterId: args.characterId, entity, dataset: 'orders', ...(entity === 'corporation' ? { page: page ?? 1 } : {}) }, signal)
          : deps[entity](user, { characterId: args.characterId, dataset, ...(parameters ? { parameters } : page === undefined ? {} : { parameters: { page } }) }, signal), signal);
      } catch { signal.throwIfAborted(); issues.push(`${entity} ${dataset}: unavailable; no missing value was assumed.`); return null; }
      signal.throwIfAborted();
      if (!record(value) || value.characterId !== args.characterId || value.dataset !== dataset || (value.entity !== undefined && value.entity !== entity) || typeof value.retrievedAt !== 'string' || manufacturingExpiryTime(value.retrievedAt) === null || Date.parse(value.retrievedAt) > now() + 60000) throw new EveError('Private manufacturing data failed its ownership or response checks.', 502);
      if (entity === 'corporation') {
        if (!integer(value.corporationId, 1) || corporationId !== null && corporationId !== value.corporationId) throw new EveError('Corporation membership changed during assessment. Retry with current connection status.', 409);
        corporationId = value.corporationId;
      }
      const expiry = manufacturingPrivateExpiry(value, Math.min(now(), Date.parse(value.retrievedAt)));
      privateSources.push({ entity, dataset, page: page ?? null, retrievedAt: value.retrievedAt, cacheExpires: expiry, freshness: expiry === null ? 'unknown' : Date.parse(expiry) <= now() ? 'stale' : 'fresh' });
      return value;
    }
    async function pages(entity: 'character' | 'corporation', dataset: 'assets' | 'orders', legacy = false) {
      const rows: Record<string, unknown>[] = [], seen = new Set<number>(); let totalPages: number | null = null;
      for (let page = 1; page <= (args.maxPrivatePages ?? 3); page++) {
        const envelope = await read(entity, dataset, page, legacy);
        if (!envelope || !Array.isArray(envelope.data) || envelope.data.length > 10000 || rows.length + envelope.data.length > 50000 || !privateFresh(entity, dataset)) return { rows: [], complete: false };
        for (const row of envelope.data) {
          const key = dataset === 'assets' ? 'item_id' : 'order_id';
          if (!record(row) || !integer(row[key], 1) || seen.has(row[key])) return { rows: [], complete: false };
          seen.add(row[key]); rows.push(row);
        }
        const p = legacy ? envelope : record(envelope.pagination) ? envelope.pagination : null;
        if (!p || !legacy && p.kind !== 'page' || p.page !== page || !integer(p.pages, page, 500)) return { rows, complete: false };
        if (totalPages !== null && totalPages !== p.pages) return { rows: [], complete: false };
        totalPages = p.pages;
        if (page === totalPages) return { rows, complete: true };
      }
      return { rows, complete: false };
    }
    const own = args.blueprintSource === 'owned' ? await read(args.resourceEntity, 'blueprints', args.blueprintPage ?? 1) : null;
    const blueprint = own && privateFresh(args.resourceEntity, 'blueprints') && record(own.pagination) && own.pagination.kind === 'page' && own.pagination.page === (args.blueprintPage ?? 1) && integer(own.pagination.pages, args.blueprintPage ?? 1, 500) && Array.isArray(own.data) && own.data.length <= 10000 ? own.data.filter((row: unknown) => record(row) && row.item_id === args.blueprintItemId) : [];
    plan.blueprint = { kind: 'unknown', accessConfirmed: false };
    if (blueprint.length === 1) {
      const row = blueprint[0] as Record<string, unknown>;
      if (row.type_id !== recipe.blueprintTypeId || !integer(row.material_efficiency, 0, 10) || !integer(row.quantity, -2) || row.quantity === 0 || !integer(row.runs, -1) || (row.quantity === -2 ? row.runs < 0 : row.runs !== -1)) throw new EveError('The selected owned blueprint does not match a valid manufacturing recipe.', 502);
      plan.materialEfficiency = row.material_efficiency;
      plan.blueprint = row.quantity === -2 ? { kind: 'copy', remainingRuns: row.runs, accessConfirmed: true } : { kind: 'original', accessConfirmed: true };
    } else issues.push(args.blueprintSource === 'prospective' ? 'Prospective blueprint: acquisition, research level and access remain assumptions.' : 'Owned blueprint not verified on the selected page; ownership is not assumed.');
    const requirements = manufacturingRequirements(recipe, plan);
    const skillEnvelope = await read('character', 'skills');
    let skills: ManufacturingEvidence['skills'] = null;
    if (skillEnvelope && privateFresh('character', 'skills') && record(skillEnvelope.data) && Array.isArray(skillEnvelope.data.skills) && skillEnvelope.data.skills.length <= 10000) {
      const seen = new Set<number>(), levels: { typeId: number; level: number }[] = []; let valid = true;
      for (const row of skillEnvelope.data.skills) { if (!record(row) || !integer(row.skill_id, 1) || seen.has(row.skill_id) || !integer(row.active_skill_level, 0, 5)) { valid = false; break; } seen.add(row.skill_id); levels.push({ typeId: row.skill_id, level: row.active_skill_level }); }
      if (valid) skills = { complete: true, levels };
    }
    const orders = await read('character', 'orders');
    const excluded = new Set(args.additionalOwnedOrderIds ?? []);
    let ordersComplete = !!orders && privateFresh('character', 'orders') && Array.isArray(orders.data) && orders.data.length <= 10000;
    const seenCharacterOrders = new Set<number>();
    if (ordersComplete) for (const row of orders!.data as unknown[]) { if (!record(row) || !integer(row.order_id, 1) || seenCharacterOrders.has(row.order_id)) { ordersComplete = false; break; } seenCharacterOrders.add(row.order_id); excluded.add(row.order_id); }
    if (args.resourceEntity === 'corporation') { const corpOrders = await pages('corporation', 'orders', true); ordersComplete &&= corpOrders.complete; for (const row of corpOrders.rows) excluded.add(row.order_id as number); }
    if (excluded.size > 2000) ordersComplete = false;
    const exclusionsVerified = ordersComplete && args.otherOwnedOrdersReviewed;
    if (!exclusionsVerified) issues.push('Owned-order exclusions are incomplete or other relevant accounts have not been reviewed. Full-batch margins remain unavailable.');
    let structureVerified = false;
    if (args.manufacturingStructureId !== undefined) {
      const value = await read('character', 'structure', undefined, false, { structureId: args.manufacturingStructureId });
      structureVerified = !!value && privateFresh('character', 'structure') && record(value.data) && value.data.solar_system_id === args.manufacturingSystemId;
      if (!structureVerified) issues.push('Private manufacturing structure/system is unverified; service availability, rigs and taxes are never inferred.');
    }
    const owned = new Map<number, number>(); let stockByDivision: Record<string, Record<string, number>> = {};
    let stockComplete = !args.useOwnedMaterials;
    if (args.useOwnedMaterials) {
      const assets = await pages(args.resourceEntity, 'assets');
      const stock = projectManufacturingStock({ rows: assets.rows, resourceEntity: args.resourceEntity,
        verifiedFacilityIds: [args.marketStationId, ...(structureVerified ? [args.manufacturingStructureId!] : [])],
        selectedStockLocationIds: args.stockLocationIds!, ...(args.hangarDivisions ? { hangarDivisions: args.hangarDivisions } : {}),
        materialTypeIds: recipe.materials.map(m => m.typeId), providerComplete: assets.complete });
      stockComplete = stock.complete; stockByDivision = stock.byDivision;
      for (const row of stock.quantities) owned.set(row.typeId, row.quantity);
      issues.push(...stock.issues);
    }
    const quote = async (typeId: number, quantity: number, side: 'buy_materials' | 'sell_output') => {
      if (!quantity || excluded.size > 2000) return null;
      try { return await manufacturingAbortable(() => market.quote({ regionId: args.marketRegionId, stationId: args.marketStationId, typeId, quantity, side, excludeOrderIds: [...excluded], ownOrdersComplete: exclusionsVerified, maxPages: args.maxMarketPages ?? 2 }, { signal }), signal); }
      catch { signal.throwIfAborted(); issues.push(`Public depth for type ${typeId} (${side}) is unavailable.`); return null; }
    };
    const materials: ManufacturingEvidence['materials'] = [];
    // Three bounded workers share one request-scoped public book cache.
    let nextMaterial = 0;
    await Promise.all(Array.from({ length: Math.min(3, requirements.materials.length) }, async () => {
      while (nextMaterial < requirements.materials.length) {
        const material = requirements.materials[nextMaterial++], quantity = stockComplete ? owned.get(material.typeId) ?? 0 : null;
        const used = quantity === null ? null : Math.min(quantity, material.requiredQuantity);
        const purchaseAll = await quote(material.typeId, material.requiredQuantity, 'buy_materials');
        const purchaseMissing = used === null ? null : await quote(material.typeId, material.requiredQuantity - used, 'buy_materials');
        const sellOwned = used === null ? null : await quote(material.typeId, used, 'sell_output');
        materials.push({ typeId: material.typeId, ownedQuantity: quantity, purchaseAll, purchaseMissing, sellOwned });
      }
    }));
    const output = await quote(requirements.product.typeId, requirements.product.quantity, 'sell_output');
    let industry: ManufacturingEvidence['industry'] = null, liquidity: unknown = null, industrySources: unknown = null;
    try { const costs = await manufacturingAbortable(() => market.costs({ solarSystemId: args.manufacturingSystemId, typeIds: recipe.materials.map(m => m.typeId) }, { signal }), signal); industrySources = costs.sources; industry = { costIndex: costs.manufacturingCostIndex, adjustedPrices: costs.adjustedPrices, ready: costs.complete && costs.sourceFreshness === 'fresh' }; } catch { signal.throwIfAborted(); issues.push('Adjusted prices or the manufacturing cost index are unavailable.'); }
    try { liquidity = await manufacturingAbortable(() => market.history({ regionId: args.marketRegionId, typeId: requirements.product.typeId, days: 30 }, { signal }), signal); } catch { signal.throwIfAborted(); issues.push('Regional product history is unavailable; liquidity is not assumed.'); }
    // Read funding last, also binding the final corporation read to the same identity.
    const funding = await read(args.resourceEntity, args.resourceEntity === 'corporation' ? 'wallet_balances' : 'wallet_balance');
    let walletISK: string | null = null;
    if (args.resourceEntity === 'character') walletISK = funding ? money(funding.data) : null;
    else if (funding && Array.isArray(funding.data)) {
      const rows = funding.data.filter((row: unknown) => record(row) && row.division === args.walletDivision);
      if (rows.length === 1 && record(rows[0])) walletISK = money(rows[0].balance);
    }
    signal.throwIfAborted();
    const catalogStatus = await manufacturingAbortable(() => (deps.catalogStatus ?? readManufacturingCatalogStatus)({ signal }), signal);
    signal.throwIfAborted();
    const stationGeography = [...materials.flatMap(material => [material.purchaseAll, material.purchaseMissing, material.sellOwned]), output]
      .filter(depth => depth !== null && depth.stationId === args.marketStationId && depth.regionId === args.marketRegionId)
      .map(depth => ({ stationId: depth!.stationId, regionId: depth!.regionId, sources: (depth as unknown as { sources?: unknown }).sources ?? null }));
    const prepared: ManufacturingPreparedAssessment = { args, recipe, plan, materials, output, skills, industry, walletISK, privateSources, industrySources, catalogStatus, catalogProvenance: catalog.provenance, liquidity, exclusionsVerified, ownOrderIds: [...excluded], stationGeography, stockComplete, stockByDivision, structureVerified, issues };
    deps.onPrepared?.(structuredClone(prepared));
    return finalizeManufacturingAssessment(prepared, now());
  };
}
export const assessManufacturing = createManufacturingAssessment({ connections: listConnections, character: readCharacterData, corporation: readCorporationData, legacy: readEve });
