// Semantic review of public CCP SDE catalogs; reports IDs, never arbitrary row text.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = () => { throw Error('Invalid manufacturing catalog schema or official-source provenance'); };
const text = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value);
const keys = (value, names) => record(value) && same(Object.keys(value).sort(), [...names].sort());
const latest = 'https://developers.eveonline.com/static-data/tranquility/latest.jsonl';
const selection = 'Published inventory types and published blueprint manufacturing activities with published products; invention, reactions and unpublished recipes are excluded.';

function table(rows, length, validate) {
  if (!Array.isArray(rows) || rows.length > 500000) fail();
  const result = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== length || !validate(row) || result.has(row[0])) fail();
    result.set(row[0], row);
  }
  return result;
}

export function validateCatalog(catalog) {
  if (!keys(catalog, ['formatVersion', 'provenance', 'itemColumns', 'items', 'groupColumns', 'groups', 'categoryColumns', 'categories', 'recipes']) || catalog.formatVersion !== 1) fail();
  const p = catalog.provenance;
  if (!keys(p, ['provider', 'dataset', 'buildNumber', 'releaseDate', 'sourceUrl', 'latestManifestUrl', 'archiveSha256', 'sourceFiles', 'selection', 'omittedUnpublishedRecipes', 'nonManufacturingBlueprints']) || p.provider !== 'CCP Games' || p.dataset !== 'EVE Online Static Data Export' || !integer(p.buildNumber, 1) || p.sourceUrl !== `https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-${p.buildNumber}-jsonl.zip` || p.latestManifestUrl !== latest || !hash(p.archiveSha256) || p.selection !== selection || !integer(p.omittedUnpublishedRecipes) || !integer(p.nonManufacturingBlueprints)) fail();
  if (typeof p.releaseDate !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(p.releaseDate) || !Number.isFinite(Date.parse(p.releaseDate)) || new Date(p.releaseDate).toISOString() !== p.releaseDate.replace('Z', '.000Z')) fail();
  if (!Array.isArray(p.sourceFiles) || p.sourceFiles.length !== 5 || !same(p.sourceFiles.map(row => row?.name).sort(), ['_sde.jsonl', 'blueprints.jsonl', 'categories.jsonl', 'groups.jsonl', 'types.jsonl'])) fail();
  for (const row of p.sourceFiles) if (!keys(row, ['name', 'sha256', 'bytes', 'rows']) || !hash(row.sha256) || !integer(row.bytes, 1) || !integer(row.rows, 1)) fail();
  if (!same(catalog.itemColumns, ['typeId', 'name', 'groupId', 'volumeM3', 'marketGroupId']) || !same(catalog.groupColumns, ['groupId', 'name', 'categoryId']) || !same(catalog.categoryColumns, ['categoryId', 'name'])) fail();
  const categories = table(catalog.categories, 2, row => integer(row[0]) && text(row[1]));
  const groups = table(catalog.groups, 3, row => integer(row[0]) && text(row[1]) && categories.has(row[2]));
  const items = table(catalog.items, 5, row => integer(row[0], 1) && text(row[1]) && groups.has(row[2]) && (row[3] === null || typeof row[3] === 'number' && Number.isFinite(row[3]) && row[3] >= 0) && (row[4] === null || integer(row[4], 1)));
  if (!Array.isArray(catalog.recipes) || catalog.recipes.length > 100000) fail();
  const recipes = new Map();
  for (const recipe of catalog.recipes) {
    if (!keys(recipe, ['blueprintTypeId', 'blueprintName', 'activity', 'timeSeconds', 'maxProductionLimit', 'materials', 'products', 'skills']) || !integer(recipe.blueprintTypeId, 1) || recipes.has(recipe.blueprintTypeId) || !items.has(recipe.blueprintTypeId) || recipe.blueprintName !== items.get(recipe.blueprintTypeId)[1] || recipe.activity !== 'manufacturing' || !integer(recipe.timeSeconds, 1) || !integer(recipe.maxProductionLimit, 1)) fail();
    for (const name of ['materials', 'products', 'skills']) {
      if (!Array.isArray(recipe[name]) || recipe[name].length > 1000 || name === 'products' && !recipe[name].length) fail();
      const seen = new Set();
      for (const row of recipe[name]) {
        const field = name === 'skills' ? 'level' : 'quantity';
        if (!keys(row, ['typeId', 'name', field]) || !integer(row.typeId, 1) || !text(row.name) || seen.has(row.typeId) || !integer(row[field], name === 'skills' ? 0 : 1) || name === 'skills' && row.level > 5) fail();
        // Materials and skills can include unpublished types omitted from items.
        if (name === 'products' && !items.has(row.typeId) || items.has(row.typeId) && row.name !== items.get(row.typeId)[1]) fail();
        seen.add(row.typeId);
      }
    }
    recipes.set(recipe.blueprintTypeId, recipe);
  }
  return { items, groups, categories, recipes };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function recipeValue(recipe) {
  return canonical({ ...recipe, materials: [...recipe.materials].sort((a, b) => a.typeId - b.typeId), products: [...recipe.products].sort((a, b) => a.typeId - b.typeId), skills: [...recipe.skills].sort((a, b) => a.typeId - b.typeId) });
}

function changes(before, after, limit, normalize = canonical) {
  const added = [], removed = [], changed = [];
  for (const [id, row] of after) {
    if (!before.has(id)) added.push(id);
    else if (!same(normalize(before.get(id)), normalize(row))) changed.push(id);
  }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);
  const summary = values => ({ count: values.length, sampleIds: values.sort((a, b) => a - b).slice(0, limit), omitted: Math.max(0, values.length - limit) });
  return { added: summary(added), removed: summary(removed), changed: summary(changed) };
}

export function diffCatalogs(before, after, { sampleLimit = 8 } = {}) {
  if (!integer(sampleLimit) || sampleLimit > 20) throw Error('Catalog diff sample limit must be between zero and twenty');
  const previous = validateCatalog(before), next = validateCatalog(after);
  const tables = Object.fromEntries(['items', 'groups', 'categories', 'recipes'].map(name => [name, changes(previous[name], next[name], sampleLimit, name === 'recipes' ? recipeValue : canonical)]));
  const details = {};
  for (const field of ['blueprintName', 'materials', 'products', 'skills', 'timeSeconds', 'maxProductionLimit']) {
    const ids = [];
    for (const [id, recipe] of next.recipes) {
      const old = previous.recipes.get(id);
      if (old && !same(recipeValue(old)[field], recipeValue(recipe)[field])) ids.push(id);
    }
    details[field] = { count: ids.length, sampleIds: ids.sort((a, b) => a - b).slice(0, sampleLimit), omitted: Math.max(0, ids.length - sampleLimit) };
  }
  const semanticChanged = Object.values(tables).some(table => Object.values(table).some(part => part.count > 0));
  const normalizeProvenance = p => canonical({ ...p, sourceFiles: [...p.sourceFiles].sort((a, b) => a.name.localeCompare(b.name)) });
  const provenanceChanged = !same(normalizeProvenance(before.provenance), normalizeProvenance(after.provenance));
  return { classification: semanticChanged ? 'semantic-change' : provenanceChanged ? 'provenance-only' : 'unchanged', fromBuild: before.provenance.buildNumber, toBuild: after.provenance.buildNumber, semanticChanged, provenanceChanged, tables, recipeDetails: details };
}

export function formatCatalogDiff(diff) {
  const lines = [`Catalog review: ${diff.classification}; official build ${diff.fromBuild} -> ${diff.toBuild}.`];
  for (const [name, table] of Object.entries(diff.tables)) lines.push(`${name}: ${table.added.count} added, ${table.removed.count} removed, ${table.changed.count} changed.`);
  for (const [field, detail] of Object.entries(diff.recipeDetails)) if (detail.count) lines.push(`Recipe ${field}: ${detail.count} changed; sample blueprint IDs ${detail.sampleIds.join(', ') || '(none)'}${detail.omitted ? `; ${detail.omitted} more` : ''}.`);
  if (diff.classification === 'provenance-only') lines.push('Only release provenance changed; item and recipe meanings are unchanged.');
  return lines.join('\n');
}
