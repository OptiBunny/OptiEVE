import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const raw = JSON.parse(readFileSync('app/data/manufacturing-catalog.json', 'utf8'));
const code = ts.transpileModule(readFileSync('app/lib/manufacturing-catalog.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
function harness() {
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => { assert.equal(name, '../data/manufacturing-catalog.json'); return raw; }, Date, Map, Set, AbortSignal, TextDecoder, Uint8Array, fetch: () => { throw Error('Unexpected network'); } });
  return module.exports;
}
const service = harness(), plain = value => JSON.parse(JSON.stringify(value));
const stamp = '2026-11-03T00:00:00.000Z', now = () => Date.parse(stamp);
const manifest = overrides => JSON.stringify({ _key: 'sde', buildNumber: raw.provenance.buildNumber, releaseDate: raw.provenance.releaseDate, ...overrides }) + '\n';
const response = (body = manifest(), init) => new Response(body, { headers: { date: new Date(now()).toUTCString(), 'cache-control': 'public, max-age=300' }, ...init });

test('pinned public catalog carries exact official build and file provenance', () => {
  const provenance = service.getCatalogProvenance();
  assert.equal(provenance.provider, 'CCP Games');
  assert.match(provenance.sourceUrl, new RegExp(`/eve-online-static-data-${provenance.buildNumber}-jsonl\\.zip$`));
  assert.equal(new URL(provenance.sourceUrl).origin, 'https://developers.eveonline.com');
  assert.match(provenance.archiveSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(plain(provenance.sourceFiles.map(row => row.name).sort()), ['_sde.jsonl','blueprints.jsonl','categories.jsonl','groups.jsonl','types.jsonl']);
  assert.ok(provenance.sourceFiles.every(file => /^[a-f0-9]{64}$/.test(file.sha256) && file.bytes > 0 && file.rows > 0));
  provenance.sourceFiles[0].sha256 = 'altered';
  assert.notEqual(service.getCatalogProvenance().sourceFiles[0].sha256, 'altered');
});
test('all catalog recipes refer to published blueprint/products and exact unadjusted components', () => {
  const published = new Set(raw.items.map(row => row[0]));
  assert.ok(raw.recipes.length > 1000 && raw.items.length > 10000);
  const seen = new Set();
  for (const recipe of raw.recipes) {
    assert.equal(recipe.activity, 'manufacturing'); assert.ok(published.has(recipe.blueprintTypeId)); assert.ok(!seen.has(recipe.blueprintTypeId)); seen.add(recipe.blueprintTypeId);
    assert.ok(Number.isSafeInteger(recipe.timeSeconds) && recipe.timeSeconds > 0);
    assert.ok(recipe.products.length > 0);
    for (const product of recipe.products) assert.ok(published.has(product.typeId));
    for (const list of [recipe.materials, recipe.products]) { assert.equal(new Set(list.map(row => row.typeId)).size, list.length); for (const row of list) { assert.ok(Number.isSafeInteger(row.typeId) && row.typeId > 0); assert.ok(Number.isSafeInteger(row.quantity) && row.quantity > 0); assert.equal(typeof row.name, 'string'); } }
    for (const skill of recipe.skills) assert.ok(Number.isSafeInteger(skill.level) && skill.level >= 0 && skill.level <= 5);
  }
});
test('recipe lookup by blueprint and product retains complete base materials and required skills', () => {
  const sample = raw.recipes.find(recipe => recipe.materials.length > 3 && recipe.skills.length > 0);
  const byBlueprint = service.lookupManufacturingRecipes({ blueprintTypeId: sample.blueprintTypeId });
  assert.deepEqual(plain(byBlueprint.recipes), [sample]);
  const byProduct = service.lookupManufacturingRecipes({ productTypeId: sample.products[0].typeId });
  assert.ok(byProduct.recipes.some(recipe => recipe.blueprintTypeId === sample.blueprintTypeId));
  assert.match(byBlueprint.message, /No ME, facility, tax, market/);
  assert.match(byBlueprint.message, /maxProductionLimit/);
  byBlueprint.recipes[0].materials[0].quantity = 99999999;
  assert.equal(service.lookupManufacturingRecipes({ blueprintTypeId: sample.blueprintTypeId }).recipes[0].materials[0].quantity, sample.materials[0].quantity);
});
test('unknown recipes remain absent rather than guessed', () => {
  const value = service.lookupManufacturingRecipes({ blueprintTypeId: Number.MAX_SAFE_INTEGER });
  assert.equal(value.recipes.length, 0); assert.match(value.message, /Do not invent/); assert.match(value.freshness, /pinned/);
});
for (const input of [null, [], {}, { blueprintTypeId: 0 }, { blueprintTypeId: '683' }, { blueprintTypeId: 683, productTypeId: 582 }, { blueprintTypeId: 683, characterId: 1 }, { productTypeId: 1.2 }, { productTypeId: NaN }, { productTypeId: Infinity }, { blueprintTypeId: Number.MAX_SAFE_INTEGER + 1 }]) {
  test('recipe lookup rejects unsupported input '+JSON.stringify(input), () => assert.throws(() => service.lookupManufacturingRecipes(input), service.ManufacturingCatalogError));
}
test('published item search is bounded and exact names rank first without private name lookups', () => {
  const result = service.searchManufacturingItems({ query: 'Rifter', limit: 2 });
  assert.equal(result.items[0].name, 'Rifter'); assert.ok(result.items.length <= 2); assert.ok(result.totalMatches >= result.items.length);
  assert.ok(result.items[0].manufacturingBlueprintTypeIds.length > 0); assert.equal(typeof result.items[0].groupName, 'string');
  assert.match(result.coverage, /not private assets/); assert.match(result.freshness, /pinned/);
  if (result.nextOffset !== null) { const next = service.searchManufacturingItems({ query: 'Rifter', limit: 2, offset: result.nextOffset }); assert.ok(!result.items.some(item => next.items.some(other => other.typeId === item.typeId))); }
});
test('manufacturable search does not claim every published item has a recipe', () => {
  const result = service.searchManufacturingItems({ query: 'tri', limit: 50, manufacturableOnly: true });
  assert.ok(result.items.every(item => item.manufacturingBlueprintTypeIds.length > 0));
  const mineral = service.findPublishedManufacturingItem(34); assert.equal(mineral.name, 'Tritanium'); assert.equal(mineral.manufacturingBlueprintTypeIds.length, 0);
  assert.equal(service.findPublishedManufacturingItem(Number.MAX_SAFE_INTEGER), null);
});
test('search beyond the end returns an explicit empty page and no loop', () => {
  const result = service.searchManufacturingItems({ query: 'rifter', offset: 100000 });
  assert.equal(result.items.length, 0); assert.equal(result.nextOffset, null);
});
for (const input of [null, {}, { query: '' }, { query: ' ' }, { query: 'a' }, { query: 'x'.repeat(101) }, { query: 'ab\ncd' }, { query: 'ab\u202ecd' }, { query: 'rifter', limit: 0 }, { query: 'rifter', limit: 51 }, { query: 'rifter', offset: -1 }, { query: 'rifter', offset: 100001 }, { query: 'rifter', manufacturableOnly: 'true' }, { query: 'rifter', characterId: 1 }, { query: 'rifter', url: 'https://example.invalid' }]) {
  test('search rejects unsupported input '+JSON.stringify(input), () => assert.throws(() => service.searchManufacturingItems(input), service.ManufacturingCatalogError));
}
test('freshness reads only the fixed official public manifest without identity or authorization', async () => {
  let calls = 0;
  const read = service.createManufacturingCatalogStatusReader({ now, fetch: async (url, options) => {
    calls++; assert.equal(url, 'https://developers.eveonline.com/static-data/tranquility/latest.jsonl');
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual'); assert.equal(options.body, undefined);
    assert.ok(options.signal instanceof AbortSignal); assert.equal(options.headers.Authorization, undefined); assert.equal(options.headers.Cookie, undefined);
    return response();
  } });
  const result = await read(); assert.equal(calls, 1); assert.equal(result.status, 'current'); assert.equal(result.checkedAt, stamp);
});
test('a newer official build requires an explicit reviewed update', async () => {
  const read = service.createManufacturingCatalogStatusReader({ now, fetch: async () => response(manifest({ buildNumber: raw.provenance.buildNumber + 1 })) });
  const result = await read(); assert.equal(result.status, 'update_required'); assert.match(result.message, /Update and review/); assert.equal(result.pinned.buildNumber, raw.provenance.buildNumber);
});
for (const [label, body, init] of [
  ['HTTPerror', 'OMIT_PRIVATE_ERROR', { status: 503 }],
  ['unexpected206', manifest(), { status: 206 }],
  ['redirect', manifest(), { status: 302, headers: { location: 'https://example.invalid/DO_NOT_FOLLOW' } }],
  ['invalidjson', 'not-json', undefined],
  ['oversized', 'x'.repeat(8193), undefined],
  ['oversizedHeader', manifest(), { headers: { 'content-length': '999999' } }],
  ['duplicate', manifest()+manifest(), undefined],
  ['missingrecord', '{"_key":"different"}', undefined],
  ['invalidbuild', manifest({ buildNumber: '1' }), undefined],
  ['invaliddate', manifest({ releaseDate: '2026-02-30T12:00:00Z' }), undefined],
  ['olderbuild', manifest({ buildNumber: raw.provenance.buildNumber - 1 }), undefined],
  ['samebuilddifferentdate', manifest({ releaseDate: '2026-11-01T11:07:56Z' }), undefined],
  ['expiredmanifest', manifest(), { headers: { expires: 'Mon, 02 Nov 2026 23:59:00 GMT' } }],
  ['unknownfreshness', manifest(), { headers: {} }],
  ['exhaustedmaxage', manifest(), { headers: { date: new Date(now()).toUTCString(), 'cache-control': 'public, max-age=300', age: '600' } }],
  ['datedmaxageexpired', manifest(), { headers: { date: new Date(now() - 600000).toUTCString(), 'cache-control': 'max-age=300', age: '0' } }],
  ['nocache', manifest(), { headers: { expires: new Date(now() + 600000).toUTCString(), 'cache-control': 'no-cache' } }],
  ['nostore', manifest(), { headers: { expires: new Date(now() + 600000).toUTCString(), 'cache-control': 'public, no-store' } }],
  ['invalidage', manifest(), { headers: { date: new Date(now()).toUTCString(), 'cache-control': 'max-age=300', age: 'bad' } }],
  ['futuredate', manifest(), { headers: { date: new Date(now() + 300000).toUTCString(), 'cache-control': 'max-age=300' } }],
  ['conflictingexpiry', manifest(), { headers: { expires: new Date(now() + 600000).toUTCString(), date: new Date(now()).toUTCString(), 'cache-control': 'max-age=300', age: '600' } }],
]) test('freshness remains unverified for '+label, async () => {
  const read = service.createManufacturingCatalogStatusReader({ now, fetch: async () => response(body, init) });
  const result = await read(); assert.equal(result.status, 'unverified'); assert.ok(!JSON.stringify(result).includes('OMIT_PRIVATE'));
});
test('freshness takes the conservative max-age, Age and Expires bound', async () => {
  const read = service.createManufacturingCatalogStatusReader({ now, fetch: async () => response(manifest(), { headers: { expires: new Date(now() + 600000).toUTCString(), date: new Date(now()).toUTCString(), 'cache-control': 'max-age=300', age: '200' } }) });
  const result = await read(); assert.equal(result.status, 'current'); assert.equal(result.cacheExpires, new Date(now() + 100000).toISOString());
});
test('freshness cancellation before reading never calls the public provider', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const read = service.createManufacturingCatalogStatusReader({ now, fetch: async () => { calls++; return response(); } });
  assert.equal((await read({ signal: controller.signal })).status, 'unverified'); assert.equal(calls, 0);
});
test('freshness cancellation during response processing cannot report current', async () => {
  const controller = new AbortController();
  const read = service.createManufacturingCatalogStatusReader({ now, fetch: async () => { controller.abort(); return response(); } });
  const result = await read({ signal: controller.signal }); assert.equal(result.status, 'unverified'); assert.equal(result.latest, null);
});
