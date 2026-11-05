// Public CCP ESI reads only. Each factory is request-scoped; no account data or
// market snapshot is persisted. Reviewed against the dated official ESI schema.
const ESI = 'https://esi.evetech.net';
const COMPATIBILITY = '2026-10-31';
const MAX_QUANTITY = 1_000_000_000_000;
const DAY = 86_400_000;
export class ManufacturingMarketError extends Error {}
const fail = (message = 'EVE returned public data that could not be validated safely.'): never => { throw new ManufacturingMarketError(message); };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(key => allowed.includes(key));
const isoDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
function timestamp(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 64) return false;
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(v);
  // Date.parse normalizes invalid dates such as February 30 and permits 24:00.
  // Validate the local calendar/time components before applying a valid offset.
  return !!parts && isoDate(parts[1]) && Number(parts[2]) <= 23 && Number(parts[3]) <= 59 && Number(parts[4]) <= 59 &&
    (parts[5] === undefined || Number(parts[5]) <= 23 && Number(parts[6]) <= 59) && Number.isFinite(Date.parse(v));
}
const ids = (v: unknown, min: number, max: number): v is number[] => Array.isArray(v) && v.length >= min && v.length <= max && v.every(id => integer(id, 1)) && new Set(v).size === v.length;
const idSchema = { type: 'integer', minimum: 1 };
const quantitySchema = { type: 'integer', minimum: 1, maximum: MAX_QUANTITY };
export const manufacturingMarketHistoryInputSchema = { type: 'object', required: ['regionId', 'typeId'], properties: { regionId: idSchema, typeId: idSchema, days: { type: 'integer', minimum: 1, maximum: 90, default: 30 } }, additionalProperties: false };
export const manufacturingIndustryCostsInputSchema = { type: 'object', required: ['solarSystemId', 'typeIds'], properties: { solarSystemId: idSchema, typeIds: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: idSchema } }, additionalProperties: false };
export const manufacturingStationQuoteInputSchema = { type: 'object', required: ['regionId', 'typeId', 'stationId', 'quantity', 'side', 'excludeOrderIds', 'ownOrdersComplete'], properties: { regionId: idSchema, typeId: idSchema, stationId: idSchema, quantity: quantitySchema, side: { type: 'string', enum: ['buy_materials', 'sell_output'] }, excludeOrderIds: { type: 'array', maxItems: 2000, uniqueItems: true, items: idSchema }, ownOrdersComplete: { type: 'boolean' }, maxPages: { type: 'integer', minimum: 1, maximum: 20, default: 4 } }, additionalProperties: false };
export type ManufacturingQuoteInput = { regionId: number; typeId: number; stationId: number; quantity: number; side: 'buy_materials' | 'sell_output'; excludeOrderIds: number[]; ownOrdersComplete: boolean; maxPages?: number };
export type ManufacturingPublicSource = { url: string; retrievedAt: string; cacheExpires: string | null; lastModified: string | null; cacheControl: string | null };
type Dependencies = { fetch?: typeof fetch; now?: () => number };
type Options = { signal?: AbortSignal };
type PublicResponse = { data: unknown; source: ManufacturingPublicSource; pages: number | null };
type Order = { id: number; type: number; station: number; system: number; buy: boolean; quantity: number; minimum: number; price: bigint; issued: number; expires: number };
type Book = { orders: Order[]; sources: ManufacturingPublicSource[]; pagesRead: number; pages: number | null; complete: boolean; changed: boolean };
const money = (cents: bigint) => `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
function cents(v: unknown): bigint {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1_000_000_000_000) return fail();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(v));
  if (!match) return fail();
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
}
// Keep adjusted/history prices as decimal strings. They are not necessarily
// cent-aligned market order prices and must not be rounded to zero silently.
function decimal(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e15) return fail();
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(v));
  if (!match) return fail();
  const digits = match[1] + (match[2] ?? ''), position = match[1].length + Number(match[3] ?? 0);
  const result = position <= 0 ? '0.' + '0'.repeat(-position) + digits : position >= digits.length ? digits + '0'.repeat(position - digits.length) : digits.slice(0, position) + '.' + digits.slice(position);
  if (result.length > 64) return fail();
  return result;
}
function headerDate(value: string | null): number | null {
  if (!value || value.length > 100) return null;
  const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null;
}
function sourceHeaders(url: string, headers: Headers, now: number): ManufacturingPublicSource {
  const expiry = headerDate(headers.get('expires')), date = headerDate(headers.get('date'));
  const control = headers.get('cache-control'), cleanControl = control && control.length <= 256 && !/[\x00-\x1f\x7f]/.test(control) ? control : null;
  const ageText = headers.get('age'), age = ageText === null ? 0 : /^\d+$/.test(ageText) ? Number(ageText) : NaN;
  const maxAgeMatch = cleanControl && /(?:^|,)\s*max-age=(\d+)(?:\s*(?:,|$))/i.exec(cleanControl);
  const maxAge = maxAgeMatch ? Number(maxAgeMatch[1]) : null;
  const cacheExpiry = maxAge !== null && integer(maxAge, 0, 604800) && integer(age, 0, 604800) && date !== null && date <= now + 60_000 ? Math.min(date + maxAge * 1000, now + (maxAge - age) * 1000) : null;
  let finalExpiry = expiry === null ? cacheExpiry : cacheExpiry === null ? expiry : Math.min(expiry, cacheExpiry);
  if (cleanControl && /(?:^|,)\s*(?:no-cache|no-store)(?:\s*(?:,|$))/i.test(cleanControl)) finalExpiry = now;
  const modified = headerDate(headers.get('last-modified'));
  return { url, retrievedAt: new Date(now).toISOString(), cacheExpires: finalExpiry === null ? null : new Date(finalExpiry).toISOString(), lastModified: modified === null ? null : new Date(modified).toISOString(), cacheControl: cleanControl };
}
function freshness(sources: ManufacturingPublicSource[], now: number): 'fresh' | 'stale' | 'unknown' {
  return sources.some(source => source.cacheExpires !== null && Date.parse(source.cacheExpires) <= now) ? 'stale' : sources.some(source => source.cacheExpires === null) ? 'unknown' : 'fresh';
}
function quoteInput(input: unknown): ManufacturingQuoteInput & { maxPages: number } {
  if (!record(input) || !keys(input, ['regionId', 'typeId', 'stationId', 'quantity', 'side', 'excludeOrderIds', 'ownOrdersComplete', 'maxPages']) ||
      !integer(input.regionId, 1) || !integer(input.typeId, 1) || !integer(input.stationId, 1) || !integer(input.quantity, 1, MAX_QUANTITY) ||
      !['buy_materials', 'sell_output'].includes(input.side as string) || !ids(input.excludeOrderIds, 0, 2000) || typeof input.ownOrdersComplete !== 'boolean' ||
      input.maxPages !== undefined && !integer(input.maxPages, 1, 20)) return fail('Choose one public NPC station, type, side and bounded quantity, and supply the owned-order exclusions and their completeness.');
  return { ...input, excludeOrderIds: [...input.excludeOrderIds], maxPages: input.maxPages ?? 4 } as ManufacturingQuoteInput & { maxPages: number };
}
export function createManufacturingMarketReader(dependencies: Dependencies = {}) {
  const request = dependencies.fetch ?? fetch, now = dependencies.now ?? Date.now;
  const stationCache = new Map<string, Promise<{ system: number; sources: ManufacturingPublicSource[] }>>();
  const bookCache = new Map<string, Promise<Book>>();
  const pricesCache = new Map<string, Promise<PublicResponse>>();
  const signalFor = (options: Options) => options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
  async function get(path: string, signal: AbortSignal, maxBytes = 4 * 1024 * 1024): Promise<PublicResponse> {
    signal.throwIfAborted();
    const url = ESI + path;
    let response: Response;
    try { response = await request(url, { method: 'GET', headers: { Accept: 'application/json', 'X-Compatibility-Date': COMPATIBILITY, 'User-Agent': 'OptiEVE/1.0 (read-only manufacturing)' }, redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) }); }
    catch { signal.throwIfAborted(); return fail('Public EVE data is temporarily unavailable. No retry was made.'); }
    if (response.status !== 200) { await response.body?.cancel(); return fail(response.status === 420 || response.status === 429 ? 'EVE is rate limiting public reads. Retry later; no automatic retry was made.' : response.status === 404 ? 'The requested public EVE record was not found. Private structures are not supported as market stations here.' : 'Public EVE data is temporarily unavailable. No upstream body was retained.'); }
    const length = response.headers.get('content-length');
    if (length && /^\d+$/.test(length) && Number(length) > maxBytes) { await response.body?.cancel(); return fail('Public EVE data exceeded the safe response limit.'); }
    const reader = response.body?.getReader(); if (!reader) return fail();
    const decoder = new TextDecoder('utf-8', { fatal: true }); let text = '', size = 0;
    try {
      while (true) { const chunk = await reader.read(); signal.throwIfAborted(); if (chunk.done) break; size += chunk.value.byteLength; if (size > maxBytes) return fail('Public EVE data exceeded the safe response limit.'); text += decoder.decode(chunk.value, { stream: true }); }
      text += decoder.decode();
    } catch (error) { await reader.cancel().catch(() => {}); if (error instanceof ManufacturingMarketError) throw error; signal.throwIfAborted(); return fail(); }
    finally { reader.releaseLock(); }
    let data: unknown; try { data = JSON.parse(text); } catch { return fail(); }
    const pagesText = response.headers.get('x-pages'), pages = pagesText && /^\d+$/.test(pagesText) && integer(Number(pagesText), 1, 1_000_000) ? Number(pagesText) : null;
    return { data, source: sourceHeaders(url, response.headers, now()), pages };
  }
  async function station(region: number, stationId: number, signal: AbortSignal) {
    const key = `${region}:${stationId}`;
    if (!stationCache.has(key)) stationCache.set(key, (async () => {
      const s = await get(`/universe/stations/${stationId}`, signal);
      if (!record(s.data) || s.data.station_id !== stationId || !integer(s.data.system_id, 1) || !Array.isArray(s.data.services) || !s.data.services.includes('market')) return fail('The selected public NPC station does not report a market service.');
      const system = s.data.system_id, sy = await get(`/universe/systems/${system}`, signal);
      if (!record(sy.data) || sy.data.system_id !== system || !integer(sy.data.constellation_id, 1)) return fail();
      const constellation = sy.data.constellation_id, co = await get(`/universe/constellations/${constellation}`, signal);
      if (!record(co.data) || co.data.constellation_id !== constellation || co.data.region_id !== region || !Array.isArray(co.data.systems) || !co.data.systems.includes(system)) return fail('The selected NPC station does not belong to the requested market region.');
      return { system, sources: [s.source, sy.source, co.source] };
    })());
    const result = await stationCache.get(key)!; signal.throwIfAborted(); return result;
  }
  async function book(args: ManufacturingQuoteInput & { maxPages: number }, signal: AbortSignal): Promise<Book> {
    const key = `${args.regionId}:${args.typeId}:${args.side}:${args.maxPages}`;
    if (!bookCache.has(key)) bookCache.set(key, (async () => {
      const orders: Order[] = [], sources: ManufacturingPublicSource[] = [], seen = new Set<number>(); let pages: number | null = null, changed = false, pagesRead = 0;
      for (let page = 1; page <= args.maxPages; page++) {
        const response = await get(`/markets/${args.regionId}/orders?type_id=${args.typeId}&order_type=${args.side === 'buy_materials' ? 'sell' : 'buy'}&page=${page}`, signal);
        if (!Array.isArray(response.data) || response.data.length > 10000 || orders.length + response.data.length > 20000) return fail('The selected market book exceeded the safe record limit.');
        sources.push(response.source); pagesRead++;
        if (page === 1) pages = response.pages; else if (pages !== response.pages) changed = true;
        for (const row of response.data) {
          if (!record(row) || !integer(row.order_id, 1) || seen.has(row.order_id) || row.type_id !== args.typeId || row.is_buy_order !== (args.side === 'sell_output') ||
              !integer(row.location_id, 1) || !integer(row.system_id, 1) || !integer(row.volume_total, 1) || !integer(row.volume_remain, 0, row.volume_total) || !integer(row.min_volume, 1) ||
              !integer(row.duration, 1, 365) || !timestamp(row.issued) || typeof row.range !== 'string' || !['station', 'region', 'solarsystem', '1', '2', '3', '4', '5', '10', '20', '30', '40'].includes(row.range)) return fail();
          seen.add(row.order_id);
          const issued = Date.parse(row.issued), expires = issued + row.duration * DAY;
          if (!Number.isSafeInteger(expires) || !Number.isFinite(expires)) return fail();
          orders.push({ id: row.order_id, type: row.type_id as number, station: row.location_id, system: row.system_id, buy: row.is_buy_order as boolean, quantity: row.volume_remain, minimum: Math.min(row.min_volume, row.volume_remain), price: cents(row.price), issued, expires });
        }
        if (pages === null || changed || page >= pages) break;
      }
      return { orders, sources, pagesRead, pages, complete: pages !== null && pagesRead === pages && !changed, changed };
    })());
    const result = await bookCache.get(key)!; signal.throwIfAborted(); return result;
  }
  async function quote(input: unknown, options: Options = {}) {
    const args = quoteInput(input), signal = signalFor(options);
    const location = await station(args.regionId, args.stationId, signal), snapshot = await book(args, signal); signal.throwIfAborted();
    const completedAt = now(), excluded = new Set(args.excludeOrderIds); let excludedOwnedOrders = 0, expiredOrders = 0;
    const candidates = snapshot.orders.filter(order => {
      if (order.station !== args.stationId) return false;
      if (order.system !== location.system) return fail();
      if (excluded.has(order.id)) { excludedOwnedOrders++; return false; }
      if (order.expires <= completedAt || order.issued > completedAt) { expiredOrders++; return false; }
      return order.quantity > 0;
    }).sort((a, b) => a.price === b.price ? a.issued - b.issued || a.id - b.id : (a.price < b.price ? -1 : 1) * (args.side === 'buy_materials' ? 1 : -1));
    let remaining = args.quantity, gross = 0n, minimumSkippedOrders = 0, allocationLimitReached = false, earliestAllocatedExpiry: number | null = null;
    const priceLevels: { priceISK: string; quantity: number; minimumFill: number }[] = [];
    for (const order of candidates) {
      if (!remaining) break;
      if (priceLevels.length === 1000) { allocationLimitReached = true; break; }
      const quantity = Math.min(remaining, order.quantity);
      if (quantity < order.minimum) { minimumSkippedOrders++; continue; }
      priceLevels.push({ priceISK: money(order.price), quantity, minimumFill: order.minimum });
      earliestAllocatedExpiry = earliestAllocatedExpiry === null ? order.expires : Math.min(earliestAllocatedExpiry, order.expires);
      gross += order.price * BigInt(quantity); remaining -= quantity;
    }
    const filled = args.quantity - remaining, sourceFreshness = freshness(snapshot.sources, completedAt), completePages = snapshot.complete;
    const coverage: 'complete' | 'partial' | 'unknown' = completePages && remaining === 0 ? 'complete' : snapshot.pages === null || snapshot.changed ? 'unknown' : 'partial';
    return { regionId: args.regionId, typeId: args.typeId, stationId: args.stationId, solarSystemId: location.system, side: args.side, quantity: args.quantity, filledQuantity: filled, unfilledQuantity: remaining,
      grossISK: money(gross), averageUnitISK: filled ? money((gross + BigInt(Math.floor(filled / 2))) / BigInt(filled)) : null, worstUnitISK: priceLevels.at(-1)?.priceISK ?? null,
      coverage, completePages, exclusionsVerified: args.ownOrdersComplete, estimateReady: coverage === 'complete' && args.ownOrdersComplete && sourceFreshness === 'fresh' && earliestAllocatedExpiry !== null && earliestAllocatedExpiry > completedAt,
      // Consumers assembling longer assessments must recheck both this order
      // deadline and source cache expiries at their own completion timestamp.
      validUntil: earliestAllocatedExpiry === null ? null : new Date(earliestAllocatedExpiry).toISOString(),
      generatedAt: new Date(completedAt).toISOString(), sourceFreshness, sources: [...location.sources, ...snapshot.sources], pagination: { pagesRead: snapshot.pagesRead, totalPages: snapshot.pages, pageLimit: args.maxPages, changedDuringRead: snapshot.changed },
      priceLevels, excludedOwnedOrders, expiredOrders, minimumSkippedOrders, allocationLimitReached,
      limitations: ['Observed gross order-book allocation, not an executed trade or realized profit. Sales tax, broker charges, hauling and manufacturing costs are separate.', 'Exact selected NPC station only; ranged buy orders based at other locations and private structure books are excluded.', 'Owned-order exclusion covers the supplied IDs and the caller’s completeness declaration; no all-account ownership is inferred.', 'Price-priority allocation honors effective minimum fill min(min_volume, volume_remain). Skipping minimum-volume orders is conservative and may omit alternative feasible allocations.', 'Pages are fetched separately and may change; matching page counts do not prove an atomic snapshot.', 'Public ESI prices can be cached and orders can disappear before execution. Average unit ISK is rounded; grossISK is the exact allocated cent sum.'] };
  }
  async function history(input: unknown, options: Options = {}) {
    if (!record(input) || !keys(input, ['regionId', 'typeId', 'days']) || !integer(input.regionId, 1) || !integer(input.typeId, 1) || input.days !== undefined && !integer(input.days, 1, 90)) return fail('Choose a public region, type and 1–90 history days.');
    const days = (input.days as number | undefined) ?? 30, signal = signalFor(options), response = await get(`/markets/${input.regionId}/history?type_id=${input.typeId}`, signal);
    if (!Array.isArray(response.data) || response.data.length > 1000) return fail();
    const seen = new Set<string>();
    const rows = response.data.map(row => {
      if (!record(row) || !isoDate(row.date) || seen.has(row.date) || !integer(row.volume) || !integer(row.order_count)) return fail();
      seen.add(row.date);
      const lowestISK = decimal(row.lowest), highestISK = decimal(row.highest), averageISK = decimal(row.average);
      if ((row.lowest as number) > (row.highest as number) || (row.average as number) < (row.lowest as number) || (row.average as number) > (row.highest as number)) return fail();
      return { date: row.date, volume: row.volume, orderCount: row.order_count, lowestISK, highestISK, averageISK };
    });
    const completedAt = now(), today = new Date(completedAt).toISOString().slice(0, 10), end = Date.parse(today + 'T00:00:00Z'), start = end - days * DAY;
    const selected = rows.filter(row => Date.parse(row.date + 'T00:00:00Z') >= start && row.date < today).sort((a, b) => a.date.localeCompare(b.date));
    const totalVolume = selected.reduce((sum, row) => sum + BigInt(row.volume), 0n), totalOrderCount = selected.reduce((sum, row) => sum + BigInt(row.orderCount), 0n);
    return { regionId: input.regionId, typeId: input.typeId, generatedAt: new Date(completedAt).toISOString(), window: { days, startUTC: new Date(start).toISOString().slice(0, 10), endExclusiveUTC: today, reportedDays: selected.length, missingDays: days - selected.length },
      rows: selected, totalReportedVolume: String(totalVolume), totalReportedOrderCount: String(totalOrderCount), averageVolumePerReportedDay: selected.length ? money((totalVolume * 100n + BigInt(Math.floor(selected.length / 2))) / BigInt(selected.length)) : null,
      sourceFreshness: freshness([response.source], completedAt), sources: [response.source], limitations: ['Regional history is not station-specific demand, an executable book or a forecast of your sales.', 'Only completed UTC days in the requested window are included. Missing dates are not imputed as zero volume.', 'Reported daily average/high/low prices are historical statistics, not guaranteed listing or execution prices.'] };
  }
  async function costs(input: unknown, options: Options = {}) {
    if (!record(input) || !keys(input, ['solarSystemId', 'typeIds']) || !integer(input.solarSystemId, 1) || !ids(input.typeIds, 1, 100)) return fail('Choose one manufacturing system and 1–100 unique material type IDs.');
    const signal = signalFor(options);
    for (const path of ['/industry/systems', '/markets/prices']) if (!pricesCache.has(path)) pricesCache.set(path, get(path, signal, 12 * 1024 * 1024));
    const [systems, prices] = await Promise.all([pricesCache.get('/industry/systems')!, pricesCache.get('/markets/prices')!]); signal.throwIfAborted();
    if (!Array.isArray(systems.data) || systems.data.length > 20000 || !Array.isArray(prices.data) || prices.data.length > 100000) return fail();
    let manufacturingCostIndex: string | null = null; const seenSystems = new Set<number>();
    for (const system of systems.data) {
      if (!record(system) || !integer(system.solar_system_id, 1) || seenSystems.has(system.solar_system_id)) return fail();
      seenSystems.add(system.solar_system_id);
      if (system.solar_system_id !== input.solarSystemId) continue;
      if (!Array.isArray(system.cost_indices) || system.cost_indices.length > 20) return fail();
      const activities = new Set<string>();
      for (const cost of system.cost_indices) {
        if (!record(cost) || typeof cost.activity !== 'string' || activities.has(cost.activity)) return fail();
        activities.add(cost.activity);
        if (cost.activity === 'manufacturing') { if (typeof cost.cost_index !== 'number' || cost.cost_index < 0 || cost.cost_index > 1) return fail(); manufacturingCostIndex = decimal(cost.cost_index); }
      }
    }
    const wanted = new Set(input.typeIds), found = new Map<number, { typeId: number; adjustedPriceISK: string | null; averagePriceISK: string | null }>(), seenPrices = new Set<number>();
    for (const row of prices.data) {
      if (!record(row) || !integer(row.type_id, 1) || seenPrices.has(row.type_id)) return fail();
      seenPrices.add(row.type_id);
      if (wanted.has(row.type_id)) found.set(row.type_id, { typeId: row.type_id, adjustedPriceISK: row.adjusted_price === undefined ? null : decimal(row.adjusted_price), averagePriceISK: row.average_price === undefined ? null : decimal(row.average_price) });
    }
    const adjustedPrices = input.typeIds.map(typeId => found.get(typeId) ?? { typeId, adjustedPriceISK: null, averagePriceISK: null }), completedAt = now(), sources = [systems.source, prices.source];
    return { solarSystemId: input.solarSystemId, generatedAt: new Date(completedAt).toISOString(), manufacturingCostIndex, adjustedPrices, missingAdjustedTypeIds: adjustedPrices.filter(row => row.adjustedPriceISK === null).map(row => row.typeId),
      complete: manufacturingCostIndex !== null && adjustedPrices.every(row => row.adjustedPriceISK !== null), sourceFreshness: freshness(sources, completedAt), sources,
      limitations: ['Adjusted prices are industry valuation inputs, not executable material purchase prices.', 'The system manufacturing index alone is not the installation fee. Facility modifiers, taxes, surcharges and rounding require explicit assumptions or an in-game job quote.', 'Average market prices are descriptive global inputs, not station prices. Missing prices or indices are not assumed to be zero.'] };
  }
  return { quote, history, costs };
}
export const readManufacturingStationQuote = (input: unknown, options?: Options) => createManufacturingMarketReader().quote(input, options);
export const readManufacturingMarketHistory = (input: unknown, options?: Options) => createManufacturingMarketReader().history(input, options);
export const readManufacturingIndustryCosts = (input: unknown, options?: Options) => createManufacturingMarketReader().costs(input, options);
