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
function catalogExpiry(headers: Headers, now: number): string | null {
  const headerDate = (value: string | null) => value && value.length <= 100 && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
  const expires = headerDate(headers.get('expires')), date = headerDate(headers.get('date'));
  const rawControl = headers.get('cache-control'), control = rawControl && rawControl.length <= 256 && !/[\x00-\x1f\x7f]/.test(rawControl) ? rawControl : null;
  const rawAge = headers.get('age'), age = rawAge === null ? 0 : /^\d+$/.test(rawAge) ? Number(rawAge) : NaN;
  const match = control && /(?:^|,)\s*max-age=(\d+)(?:\s*(?:,|$))/i.exec(control), maxAge = match ? Number(match[1]) : null;
  const maxAgeExpiry = maxAge !== null && integer(maxAge, 0, 604800) && integer(age, 0, 604800) && date !== null && date <= now + 60000 ? Math.min(date + maxAge * 1000, now + (maxAge - age) * 1000) : null;
  let expiry = expires === null ? maxAgeExpiry : maxAgeExpiry === null ? expires : Math.min(expires, maxAgeExpiry);
  if (control && /(?:^|,)\s*(?:no-cache|no-store)(?:\s*(?:,|$))/i.test(control)) expiry = now;
  return expiry === null ? null : new Date(expiry).toISOString();
}
export function createManufacturingCatalogStatusReader(dependencies: StatusDependencies = {}) {
  return async function read(options: { signal?: AbortSignal } = {}) {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
    const now = dependencies.now ?? Date.now;
    let current: { buildNumber: number; releaseDate: string } | null = null;
    let cacheHeaders: Headers | null = null;
    try {
      signal.throwIfAborted();
      const response = await (dependencies.fetch ?? fetch)(latestUrl, { method: 'GET', headers: { Accept: 'application/jsonl, application/x-ndjson, text/plain', 'User-Agent': 'OptiEVE/1.0 (public SDE freshness check)' }, redirect: 'manual', signal });
      if (response.status !== 200 || !response.body) throw new Error('Public manifest unavailable');
      const declared = response.headers.get('content-length'); if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 8192)) throw new Error('Public manifest size');
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      try { while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 8192) { await reader.cancel(); throw new Error('Public manifest size'); } chunks.push(chunk.value); } }
      finally { reader.releaseLock(); }
      const joined = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(joined);
      const lines: unknown[] = text.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      const matches = lines.filter(row => record(row) && row._key === 'sde');
      if (matches.length !== 1 || !record(matches[0]) || !integer(matches[0].buildNumber) || typeof matches[0].releaseDate !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(matches[0].releaseDate) || !Number.isFinite(Date.parse(matches[0].releaseDate)) || new Date(matches[0].releaseDate).toISOString() !== matches[0].releaseDate.replace('Z', '.000Z')) throw new Error('Public manifest shape');
      current = { buildNumber: matches[0].buildNumber, releaseDate: matches[0].releaseDate };
      cacheHeaders = response.headers;
      signal.throwIfAborted();
    } catch { current = null; cacheHeaders = null; /* Never expose arbitrary response text, URLs or exception details. */ }
    const completedAt = now(), checkedAt = new Date(completedAt).toISOString(), cacheExpires = cacheHeaders ? catalogExpiry(cacheHeaders, completedAt) : null;
    const staleOrUnknown = cacheExpires === null || Date.parse(cacheExpires) <= completedAt;
    const status = !current || staleOrUnknown || current.buildNumber < catalog.provenance.buildNumber || current.buildNumber === catalog.provenance.buildNumber && current.releaseDate !== catalog.provenance.releaseDate ? 'unverified' : current.buildNumber === catalog.provenance.buildNumber ? 'current' : 'update_required';
    return { status, checkedAt, cacheExpires, latest: current, pinned: getCatalogProvenance(), source: latestUrl, message: status === 'current' ? 'The pinned catalog matches the official latest-build manifest at this check. The manifest can be cached by CCP for five minutes; recipes are versioned static data, not market prices.' : status === 'update_required' ? 'CCP reports a newer SDE build. Update and review the public catalog before treating recipes as current; do not silently replace the pinned source at runtime.' : 'Current SDE freshness could not be established. Keep the pinned build and release date visible and do not claim current recipe data.' };
  };
}
export const readManufacturingCatalogStatus = createManufacturingCatalogStatusReader();
