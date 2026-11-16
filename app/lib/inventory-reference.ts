import { EveError, listConnections, readEve } from './eve';
import { createInventoryAnalyticsReader } from './inventory-analytics';
import { readManufacturingReferencePrices } from './manufacturing-market';
import { overviewDate } from './overview-summary';
import { walletActivityDecimal, walletActivityFormat, walletActivityBucket, accumulateWalletActivity, walletActivityProject } from './wallet-analytics';
import type { InventoryAnalytics } from './inventory-analytics-types';
import type { InventoryReferenceAnalytics, InventoryReferenceState } from './inventory-reference-types';

type Selection = { characterId: number; entity: 'character' | 'corporation'; page: number };
type Dependencies = {
  inventory: (user: string, input: Selection, options: { signal: AbortSignal }) => Promise<InventoryAnalytics>;
  prices: (input: { typeIds: number[] }, options: { signal: AbortSignal }) => Promise<unknown>;
  now?: () => number;
};
const states: InventoryReferenceState[] = ['priced', 'missing_price', 'excluded_blueprint', 'excluded_unknown_type', 'price_unavailable'];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const sourceUrl = 'https://esi.evetech.net/markets/prices' as const;
const invalid = (): never => { throw new EveError('The inventory reference response could not be validated safely. No reference values are assumed.', 502); };
const precisionPolicy = 'Reference values use exact arithmetic on each received average-price number’s decimal representation multiplied by the reported per-type integer quantity. Totals are not rounded to cents. Provider numeric precision cannot be recovered after it is lost; this arithmetic is not an appraisal of individual items.';
const limitations = [
  'This is a reference subtotal for priced types in one returned asset page. It is not total net worth, profit, wallet balance or a guarantee of sale proceeds; other pages, escrow, orders and contracts are not combined.',
  'Every reported unit of an included type uses the same public ESI average price, including singleton-bearing types. Condition, assembly, fittings, mutation, location, market access and hauling are not valued or inferred.',
  'All blueprint-category types and types reporting blueprint-copy evidence are excluded. Unknown catalog classifications are excluded rather than guessed. Blueprint research, licensed runs and copy/original values are not appraised.',
  'Missing average prices stay unknown. Adjusted industry prices are never substituted. A reported zero average is a zero reference input, not proof that an item is worthless or cannot be sold.',
  'Public average prices are descriptive type-level inputs, not executable regional or station quotations. No specific averaging window or equivalence to the in-game net-worth indicator is assumed.',
  'Inventory and public prices are independently cached observations, not an atomic snapshot. Their separate freshness and inventory page coverage remain visible. Values and counts are not saved or collected in the background.',
  'Coverage charts count returned types or asset records, not physical quantities across different items. Category subtotals include only priced types; excluded and unpriced values are not zero.',
];
export function validateInventoryReferenceArgs(value: unknown): Selection {
  if (!record(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['characterId', 'entity', 'page'].includes(key)) ||
      !Object.hasOwn(value, 'characterId') || !integer(value.characterId, 1) || !Object.hasOwn(value, 'entity') || value.entity !== 'character' && value.entity !== 'corporation' ||
      'page' in value && !Object.hasOwn(value, 'page') || Object.hasOwn(value, 'page') && !integer(value.page, 1, 500)) {
    throw new EveError('Choose one connected character, a character or corporation inventory, and a page from 1 to 500.');
  }
  return { characterId: value.characterId, entity: value.entity, page: Object.hasOwn(value, 'page') ? value.page as number : 1 };
}
const timestamp = (value: unknown): string | null => { const result = overviewDate(value); return result?.length === 24 ? result : null; };
async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let cancel: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); });
  void interrupted.catch(() => {});
  try { const result = await Promise.race([work(), interrupted]); signal.throwIfAborted(); return result; }
  finally { signal.removeEventListener('abort', cancel); }
}
const blankFreshness = (): InventoryAnalytics['freshness'] => ({ state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null });
function priceStatus(status: InventoryReferenceAnalytics['prices']['status'], message: string): InventoryReferenceAnalytics['prices'] {
  return { status, message, sourceUrl, returnedTypes: null, freshness: blankFreshness() };
}
function excluded(type: InventoryAnalytics['types'][number]): InventoryReferenceState | null {
  if (type.categoryId === 9 || type.blueprintCopyRecords > 0) return 'excluded_blueprint';
  if (type.categoryId === null || type.blueprintCopyUnknownRecords > 0) return 'excluded_unknown_type';
  return null;
}
function priceProjection(response: unknown, wanted: number[], completed: number) {
  if (!record(response) || !integer(response.returnedTypes, 0, 100000) || !Array.isArray(response.prices) || response.prices.length !== wanted.length || !record(response.source) || response.source.url !== sourceUrl) return invalid();
  const retrievedAt = timestamp(response.source.retrievedAt), cacheExpires = response.source.cacheExpires === null ? null : timestamp(response.source.cacheExpires), lastModified = response.source.lastModified === null ? null : timestamp(response.source.lastModified);
  if (retrievedAt === null || Date.parse(retrievedAt) > completed + 60000 || response.source.cacheExpires !== null && cacheExpires === null || response.source.lastModified !== null && lastModified === null) return invalid();
  const selected = new Set(wanted), prices = new Map<number, ReturnType<typeof walletActivityDecimal> | null>();
  for (const row of response.prices) {
    if (!record(row) || !integer(row.typeId, 1) || !selected.has(row.typeId) || prices.has(row.typeId) || row.averagePrice !== null && (typeof row.averagePrice !== 'number' || !Number.isFinite(row.averagePrice) || row.averagePrice < 0 || row.averagePrice > Number.MAX_SAFE_INTEGER)) return invalid();
    prices.set(row.typeId, row.averagePrice === null ? null : walletActivityDecimal(row.averagePrice));
  }
  if ([...prices.values()].filter(value => value !== null).length > response.returnedTypes) return invalid();
  const metadata: InventoryReferenceAnalytics['prices'] = { status: 'available', message: 'One public ESI average-price response; only returned inventory types are joined locally.', sourceUrl, returnedTypes: response.returnedTypes,
    freshness: { state: cacheExpires === null ? 'unknown' : Date.parse(cacheExpires) <= completed ? 'stale' : 'fresh', retrievedAt, cacheExpires, lastModified } };
  return { prices, metadata };
}
function reassessInventory(value: InventoryAnalytics, completed: number): InventoryAnalytics {
  if (!['ready', 'partial'].includes(value.status)) return { ...value, generatedAt: new Date(completed).toISOString() };
  const state = value.freshness.cacheExpires === null ? 'unknown' : Date.parse(value.freshness.cacheExpires) <= completed ? 'stale' : 'fresh';
  const complete = value.coverage.kind === 'complete_returned_list' && state === 'fresh' && value.summary?.unmappedTypeRecords === 0;
  return { ...value, generatedAt: new Date(completed).toISOString(), freshness: { ...value.freshness, state }, status: complete ? 'ready' : 'partial',
    message: `Selected inventory page ${value.coverage.page}${value.coverage.pages === null ? '; provider page count is unknown' : ` of ${value.coverage.pages}`}. Counts cover this page only. Inventory source freshness is ${state}.` };
}
function assemble(inventory: InventoryAnalytics, prices: InventoryReferenceAnalytics['prices'], amounts: Map<number, ReturnType<typeof walletActivityDecimal> | null>, completed: number): InventoryReferenceAnalytics {
  const result: InventoryReferenceAnalytics = { generatedAt: new Date(completed).toISOString(), status: inventory.status, message: inventory.message, basis: 'esi_average_price', inventory, prices,
    summary: null, coverage: [], types: [], categories: [], precisionPolicy, limitations: [...limitations] };
  if (inventory.summary === null) return result;
  const coverage = states.map(state => ({ state, types: 0, records: 0 })), total = walletActivityBucket();
  const categories = new Map<number | null, { output: InventoryReferenceAnalytics['categories'][number]; amounts: ReturnType<typeof walletActivityBucket> }>();
  let zeroAveragePriceTypes = 0, singletonBearingPricedTypes = 0;
  for (const type of [...inventory.types].sort((left, right) => left.typeId - right.typeId)) {
    const exclusion = excluded(type), average = amounts.get(type.typeId) ?? null;
    const state: InventoryReferenceState = exclusion ?? (prices.status !== 'available' ? 'price_unavailable' : average === null ? 'missing_price' : 'priced');
    const count = coverage.find(value => value.state === state)!; count.types++; count.records += type.records;
    const category = categories.get(type.categoryId) ?? { output: { categoryId: type.categoryId, name: type.categoryName, types: 0, records: 0, pricedTypes: 0, pricedRecords: 0, referenceSubtotalISK: null }, amounts: walletActivityBucket() };
    category.output.types++; category.output.records += type.records;
    let averagePriceISK: string | null = null, referenceISK: string | null = null;
    if (state === 'priced' && average !== null) {
      const product = { units: average.units * BigInt(type.quantity), scale: average.scale };
      averagePriceISK = walletActivityFormat(average); referenceISK = walletActivityFormat(product);
      accumulateWalletActivity(total, product); accumulateWalletActivity(category.amounts, product);
      category.output.pricedTypes++; category.output.pricedRecords += type.records;
      if (average.units === 0n) zeroAveragePriceTypes++;
      if (type.singletonRecords > 0) singletonBearingPricedTypes++;
    }
    categories.set(type.categoryId, category);
    result.types.push({ typeId: type.typeId, state, averagePriceISK, referenceISK });
  }
  const priced = coverage[0], referenceSubtotalISK = priced.types > 0 || inventory.types.length === 0 ? walletActivityProject(total).totals!.incomingISK : null;
  result.coverage = coverage;
  result.summary = { referenceSubtotalISK, pricedTypes: priced.types, pricedRecords: priced.records, zeroAveragePriceTypes, singletonBearingPricedTypes };
  result.categories = [...categories.values()].map(({ output, amounts }) => ({ ...output, referenceSubtotalISK: output.pricedTypes ? walletActivityProject(amounts).totals!.incomingISK : null }))
    .sort((left, right) => left.categoryId === null ? right.categoryId === null ? 0 : 1 : right.categoryId === null ? -1 : left.categoryId - right.categoryId);
  result.status = inventory.status === 'ready' && (inventory.types.length === 0 || prices.status === 'available' && prices.freshness.state === 'fresh' && priced.types === inventory.types.length) ? 'ready' : 'partial';
  result.message = `${priced.types} of ${inventory.types.length} returned types have average-price reference values. The subtotal covers priced types in this asset page only; unpriced and excluded values remain unknown.`;
  return result;
}

/** One manual owned inventory page plus, when useful, one public price-list read. */
export function createInventoryReferenceReader(dependencies: Dependencies) {
  return async (user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<InventoryReferenceAnalytics> => {
    const selection = validateInventoryReferenceArgs(input), now = dependencies.now ?? Date.now;
    if (typeof user !== 'string' || !user) throw new EveError('Sign in to this private connector first.', 401);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    signal.throwIfAborted();
    const observed = await abortable(() => dependencies.inventory(user, selection, { signal }), signal);
    if (observed.characterId !== selection.characterId || observed.entity !== selection.entity || observed.coverage.page !== selection.page || observed.types.length > 1000 || observed.coverage.records > 1000) return invalid();
    const wanted = observed.summary === null ? [] : observed.types.filter(type => excluded(type) === null).map(type => type.typeId).sort((left, right) => left - right);
    let response: unknown, receivedPrices = false, prices = priceStatus('not_requested', observed.summary === null ? 'No accepted inventory was available for a price join.' : 'This page has no eligible types; no public price read was needed.');
    if (wanted.length) {
      try { response = await abortable(() => dependencies.prices({ typeIds: wanted }, { signal }), signal); receivedPrices = true; }
      catch { signal.throwIfAborted(); prices = priceStatus('unavailable', 'Public average prices could not be read. Inventory evidence is preserved; no monetary values are assumed.'); }
    }
    const completed = now(), inventory = reassessInventory(observed, completed);
    let amounts = new Map<number, ReturnType<typeof walletActivityDecimal> | null>();
    if (receivedPrices) {
      try { const projected = priceProjection(response, wanted, completed); amounts = projected.prices; prices = projected.metadata; }
      catch { prices = priceStatus('error', 'Public price data could not be validated safely. Inventory evidence is preserved; no monetary values are assumed.'); }
    }
    const result = assemble(inventory, prices, amounts, completed);
    // Reassess both independent observations after the exact aggregation work.
    const finished = now(); result.generatedAt = new Date(finished).toISOString(); result.inventory = reassessInventory(observed, finished);
    if (result.prices.status === 'available') result.prices.freshness.state = result.prices.freshness.cacheExpires === null ? 'unknown' : Date.parse(result.prices.freshness.cacheExpires) <= finished ? 'stale' : 'fresh';
    result.status = result.inventory.summary === null ? result.inventory.status : result.inventory.status === 'ready' && (result.inventory.types.length === 0 || result.prices.status === 'available' && result.prices.freshness.state === 'fresh' && result.summary?.pricedTypes === result.inventory.types.length) ? 'ready' : 'partial';
    signal.throwIfAborted();
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 4 * 1024 * 1024) return invalid();
    return result;
  };
}
const boundedInventory = createInventoryAnalyticsReader({ connections: listConnections, assets: (user, args, signal) => readEve(user, args, signal, { maxResponseBytes: 2 * 1024 * 1024 }) });
export const readInventoryReference = createInventoryReferenceReader({ inventory: boundedInventory, prices: readManufacturingReferencePrices });
