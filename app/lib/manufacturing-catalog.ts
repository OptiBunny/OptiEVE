import sourceCatalog from '../data/manufacturing-catalog.json';

export type ManufacturingComponent = { typeId: number; name: string; quantity: number };
export type ManufacturingRecipe = {
  blueprintTypeId: number;
  blueprintName: string;
  activity: 'manufacturing';
  timeSeconds: number;
  // SDE metadata, not a guarantee of allowed job runs or owned copy availability.
  maxProductionLimit: number;
  materials: ManufacturingComponent[];
  products: ManufacturingComponent[];
  skills: { typeId: number; name: string; level: number }[];
};
export type ManufacturingCatalogProvenance = {
  provider: string; dataset: string; buildNumber: number; releaseDate: string;
  sourceUrl: string; latestManifestUrl: string; archiveSha256: string;
  sourceFiles: { name: string; sha256: string; bytes: number; rows: number }[];
  selection: string; omittedUnpublishedRecipes: number; nonManufacturingBlueprints: number;
};
type CatalogData = {
  formatVersion: number;
  provenance: ManufacturingCatalogProvenance;
  items: [number, string, number, number | null, number | null][];
  groups: [number, string, number][];
  categories: [number, string][];
  recipes: ManufacturingRecipe[];
};
export type ManufacturingItem = {
  typeId: number; name: string; groupId: number; groupName: string;
  categoryId: number; categoryName: string; volumeM3: number | null;
  marketGroupId: number | null; manufacturingBlueprintTypeIds: number[];
};
const catalog = sourceCatalog as unknown as CatalogData;
const latestUrl = 'https://developers.eveonline.com/static-data/tranquility/latest.jsonl';
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
export class ManufacturingCatalogError extends Error {}
const invalid = (): never => { throw new ManufacturingCatalogError('Choose one blueprint or product type ID, or a bounded public item search.'); };
const groups = new Map(catalog.groups.map(row => [row[0], row]));
const categories = new Map(catalog.categories.map(row => [row[0], row[1]]));
const blueprints = new Map(catalog.recipes.map(recipe => [recipe.blueprintTypeId, recipe]));
const productRecipes = new Map<number, ManufacturingRecipe[]>();
for (const recipe of catalog.recipes) for (const product of recipe.products) {
  const recipes = productRecipes.get(product.typeId) ?? [];
  recipes.push(recipe); productRecipes.set(product.typeId, recipes);
}
const items = new Map(catalog.items.map(row => [row[0], row]));
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const staticFreshness = 'This is a pinned public SDE snapshot, not a live recipe query. Check catalog status before a manufacturing assessment; a newer build or an unavailable freshness check must remain visible.';

export function getCatalogProvenance(): ManufacturingCatalogProvenance {
  return copy(catalog.provenance);
}
export function findPublishedManufacturingItem(typeId: number): ManufacturingItem | null {
  if (!integer(typeId)) return invalid();
  const row = items.get(typeId); if (!row) return null;
  const group = groups.get(row[2])!;
  return { typeId: row[0], name: row[1], groupId: row[2], groupName: group[1], categoryId: group[2], categoryName: categories.get(group[2])!, volumeM3: row[3], marketGroupId: row[4], manufacturingBlueprintTypeIds: (productRecipes.get(typeId) ?? []).map(recipe => recipe.blueprintTypeId) };
}

export function lookupManufacturingRecipes(input: unknown) {
  if (!record(input) || Object.keys(input).some(key => !['blueprintTypeId', 'productTypeId'].includes(key)) ||
      Number(Object.hasOwn(input, 'blueprintTypeId')) + Number(Object.hasOwn(input, 'productTypeId')) !== 1) return invalid();
  const byBlueprint = Object.hasOwn(input, 'blueprintTypeId'), id = byBlueprint ? input.blueprintTypeId : input.productTypeId;
  if (!integer(id)) return invalid();
  const recipe = byBlueprint ? blueprints.get(id) : undefined;
  const recipes = byBlueprint ? recipe ? [recipe] : [] : productRecipes.get(id) ?? [];
  return {
    lookup: { kind: byBlueprint ? 'blueprint' : 'product', typeId: id },
    recipes: copy(recipes),
    provenance: getCatalogProvenance(),
    coverage: 'published-manufacturing-recipes',
    freshness: staticFreshness,
    message: recipes.length ? 'Official base materials, products, skills and activity time. No ME, facility, tax, market, owned-material or skill adjustment is included. maxProductionLimit is SDE blueprint metadata; validate owned copy runs and job limits separately.' : 'No published manufacturing recipe is present in this SDE snapshot for that exact type. Do not invent a recipe or substitute an invention/reaction activity.',
  };
}

export function searchManufacturingItems(input: unknown) {
  if (!record(input) || Object.keys(input).some(key => !['query', 'limit', 'offset', 'manufacturableOnly'].includes(key)) ||
      typeof input.query !== 'string' || input.query.trim().length < 2 || input.query.length > 100 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(input.query) ||
      input.limit !== undefined && !integer(input.limit, 1, 50) || input.offset !== undefined && !integer(input.offset, 0, 100000) ||
      input.manufacturableOnly !== undefined && typeof input.manufacturableOnly !== 'boolean') return invalid();
  const query = input.query.trim().toLocaleLowerCase('en'), limit = input.limit as number | undefined ?? 20, offset = input.offset as number | undefined ?? 0;
  const matches = catalog.items.filter(row => row[1].toLocaleLowerCase('en').includes(query) && (input.manufacturableOnly !== true || productRecipes.has(row[0])));
  const score = (value: string) => value === query ? 0 : value.startsWith(query) ? 1 : 2;
  matches.sort((a, b) => score(a[1].toLocaleLowerCase('en')) - score(b[1].toLocaleLowerCase('en')) || a[1].localeCompare(b[1], 'en') || a[0] - b[0]);
  const selected = matches.slice(offset, offset + limit);
  return { query: input.query.trim(), items: selected.map(row => findPublishedManufacturingItem(row[0])!), totalMatches: matches.length, offset, limit, nextOffset: offset + selected.length < matches.length ? offset + selected.length : null, provenance: getCatalogProvenance(), freshness: staticFreshness, coverage: 'English names of published inventory types in the pinned SDE; not private assets or player-authored item names.' };
}

type StatusDependencies = { fetch?: typeof fetch; now?: () => number };
function headerDate(value: string | null, now: number): number | null {
  if (!value || value.length > 100) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const parsed = Date.parse(value), local = Date.parse(value.slice(0, 19) + 'Z');
    return Number.isFinite(parsed) && new Date(parsed).toISOString().length === 24 && Number.isFinite(local) &&
      new Date(local).toISOString().slice(0, 19) === value.slice(0, 19) ? parsed : null;
  }
  // HTTP also permits RFC850 and asctime dates. Decode their fields explicitly:
  // Date.parse alone repairs impossible dates and reads asctime in local time.
  const imf = /^([a-z]{3}), (\d{2}) ([a-z]{3}) (\d{4}) (\d{2}:\d{2}:\d{2}) GMT$/i.exec(value);
  const rfc850 = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([a-z]{3})-(\d{2}) (\d{2}:\d{2}:\d{2}) GMT$/i.exec(value);
  const asctime = /^([a-z]{3}) ([a-z]{3}) (\d{2}| \d) (\d{2}:\d{2}:\d{2}) (\d{4})$/i.exec(value);
  const fields = imf ?? rfc850 ?? (asctime && [asctime[0], asctime[1], asctime[3].trim().padStart(2, '0'), asctime[2], asctime[5], asctime[4]]);
  if (!fields) return null;
  const [, weekday, day, monthText, yearText, time] = fields;
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(monthText.toLowerCase()) + 1;
  if (!month) return null;
  let year = Number(yearText);
  const utcText = () => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${day}T${time}Z`;
  if (rfc850) {
    const cutoff = new Date(now), currentYear = cutoff.getUTCFullYear();
    year += currentYear - currentYear % 100;
    cutoff.setUTCFullYear(currentYear + 50);
    if (Date.parse(utcText()) > cutoff.getTime()) year -= 100;
  }
  if (!Number.isInteger(year) || year < 0 || year > 9999) return null;
  const expected = utcText(), parsed = Date.parse(expected);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  return date.toISOString() === expected.slice(0, -1) + '.000Z' &&
    date.toUTCString().slice(0, 3).toLowerCase() === weekday.slice(0, 3).toLowerCase() ? parsed : null;
}
function cacheDirectives(control: string): string[] | null {
  // Commas inside a quoted extension value do not start new directives.
  const parts: string[] = [];
  let start = 0, quoted = false, escaped = false;
  for (let index = 0; index < control.length; index++) {
    const character = control[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && character === '\\') { escaped = true; continue; }
    if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) { parts.push(control.slice(start, index)); start = index + 1; }
  }
  if (quoted) return null;
  parts.push(control.slice(start));
  return parts;
}
function catalogExpiry(headers: Headers, now: number): string | null {
  const expires = headerDate(headers.get('expires'), now), date = headerDate(headers.get('date'), now);
  const rawControl = headers.get('cache-control'), control = rawControl && rawControl.length <= 256 && !/[\x00-\x1f\x7f]/.test(rawControl) ? rawControl : null;
  if (rawControl !== null && (rawControl.length > 256 || /[\x00-\x1f\x7f]/.test(rawControl))) return null;
  const directives = cacheDirectives(control ?? '');
  if (directives === null) return null;
  const rawAge = headers.get('age'), age = rawAge === null ? 0 : /^\d+$/.test(rawAge) ? Number(rawAge) : NaN;
  const maxAgeDirective = directives.map(directive => /^\s*max-age(?=\s*(?:=|$))([\s\S]*)$/i.exec(directive)).find(Boolean);
  const match = maxAgeDirective && /^=(\d+)\s*$/.exec(maxAgeDirective[1]), maxAge = match ? Number(match[1]) : null;
  const maxAgeExpiry = maxAge !== null && integer(maxAge, 0, 604800) && integer(age, 0, 604800) && date !== null && date <= now + 60000 ? Math.min(date + maxAge * 1000, now + (maxAge - age) * 1000) : null;
  let expiry = expires === null ? maxAgeExpiry : maxAgeExpiry === null ? expires : Math.min(expires, maxAgeExpiry);
  if (directives.some(directive => /^\s*(?:no-cache|no-store)\s*$/i.test(directive))) expiry = now;
  else if (!integer(age, 0, 604800) || maxAgeDirective && maxAgeExpiry === null) expiry = null;
  const normalized = expiry === null ? null : new Date(expiry).toISOString();
  return normalized?.length === 24 ? normalized : null;
}
export function createManufacturingCatalogStatusReader(dependencies: StatusDependencies = {}) {
  return async function read(options: { signal?: AbortSignal } = {}) {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
    const now = dependencies.now ?? Date.now;
    let current: { buildNumber: number; releaseDate: string } | null = null;
    let cacheHeaders: Headers | null = null;
    let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      signal.throwIfAborted();
      response = await (dependencies.fetch ?? fetch)(latestUrl, { method: 'GET', headers: { Accept: 'application/jsonl, application/x-ndjson, text/plain', 'User-Agent': 'OptiEVE/1.0 (public SDE freshness check)' }, redirect: 'manual', signal });
      if (response.status !== 200 || !response.body) throw new Error('Public manifest unavailable');
      const declared = response.headers.get('content-length'); if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 8192)) throw new Error('Public manifest size');
      reader = response.body.getReader();
      const joined = new Uint8Array(8192); let bytes = 0;
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        if (chunk.value.byteLength > joined.byteLength - bytes) throw new Error('Public manifest size');
        joined.set(chunk.value, bytes); bytes += chunk.value.byteLength;
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(joined.subarray(0, bytes));
      const lines: unknown[] = text.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      const matches = lines.filter(row => record(row) && row._key === 'sde');
      if (matches.length !== 1 || !record(matches[0]) || !integer(matches[0].buildNumber) || typeof matches[0].releaseDate !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(matches[0].releaseDate) || !Number.isFinite(Date.parse(matches[0].releaseDate)) || new Date(matches[0].releaseDate).toISOString() !== matches[0].releaseDate.replace('Z', '.000Z')) throw new Error('Public manifest shape');
      current = { buildNumber: matches[0].buildNumber, releaseDate: matches[0].releaseDate };
      cacheHeaders = response.headers;
      signal.throwIfAborted();
    } catch { current = null; cacheHeaders = null; /* Never expose arbitrary response text, URLs or exception details. */ }
    finally {
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      else if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
    const completedAt = now(), checkedAt = new Date(completedAt).toISOString(), cacheExpires = cacheHeaders ? catalogExpiry(cacheHeaders, completedAt) : null;
    const staleOrUnknown = cacheExpires === null || Date.parse(cacheExpires) <= completedAt;
    const status = !current || staleOrUnknown || current.buildNumber < catalog.provenance.buildNumber || current.buildNumber === catalog.provenance.buildNumber && current.releaseDate !== catalog.provenance.releaseDate ? 'unverified' : current.buildNumber === catalog.provenance.buildNumber ? 'current' : 'update_required';
    return { status, checkedAt, cacheExpires, latest: current, pinned: getCatalogProvenance(), source: latestUrl, message: status === 'current' ? 'The pinned catalog matches the official latest-build manifest at this check. The manifest can be cached by CCP for five minutes; recipes are versioned static data, not market prices.' : status === 'update_required' ? 'CCP reports a newer SDE build. Update and review the public catalog before treating recipes as current; do not silently replace the pinned source at runtime.' : 'Current SDE freshness could not be established. Keep the pinned build and release date visible and do not claim current recipe data.' };
  };
}
export const readManufacturingCatalogStatus = createManufacturingCatalogStatusReader();
