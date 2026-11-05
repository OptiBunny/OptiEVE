import assert from 'node:assert/strict';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { diffCatalogs, formatCatalogDiff, validateCatalog } from '../scripts/manufacturing-catalog-diff.mjs';
import { CatalogRefreshError, compilerPin, parseRefreshArguments, readValidationCompiler, realPublicDirectory, refreshCatalog } from '../scripts/refresh-manufacturing-catalog.mjs';
import { requirePublicSource } from '../scripts/public-source.mjs';
import { syncPrivateSource } from '../scripts/sync-private-source.mjs';

const catalogName = 'app/data/manufacturing-catalog.json';
const bytes = value => Buffer.from(JSON.stringify(value) + '\n');
const clone = value => structuredClone(value);

function catalog() {
  return {
    formatVersion: 1,
    provenance: {
      provider: 'CCP Games', dataset: 'EVE Online Static Data Export', buildNumber: 100, releaseDate: '2026-01-01T00:00:00Z',
      sourceUrl: 'https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-100-jsonl.zip',
      latestManifestUrl: 'https://developers.eveonline.com/static-data/tranquility/latest.jsonl', archiveSha256: 'a'.repeat(64),
      sourceFiles: ['_sde.jsonl', 'categories.jsonl', 'groups.jsonl', 'types.jsonl', 'blueprints.jsonl'].map(name => ({ name, bytes: 10, rows: 1, sha256: 'b'.repeat(64) })),
      selection: 'Published inventory types and published blueprint manufacturing activities with published products; invention, reactions and unpublished recipes are excluded.', omittedUnpublishedRecipes: 0, nonManufacturingBlueprints: 0,
    },
    itemColumns: ['typeId', 'name', 'groupId', 'volumeM3', 'marketGroupId'],
    items: [[1001, 'Synthetic blueprint A', 1, null, null], [1002, 'Synthetic blueprint B', 1, null, null], [2001, 'Synthetic output A', 1, 1, 1], [2002, 'Synthetic output B', 1, 1, 1], [3001, 'Synthetic material', 1, 0.1, null], [4001, 'Synthetic skill', 1, 0, null]],
    groupColumns: ['groupId', 'name', 'categoryId'], groups: [[1, 'Synthetic group', 1]],
    categoryColumns: ['categoryId', 'name'], categories: [[1, 'Synthetic category']],
    recipes: [1001, 1002].map((id, index) => ({ blueprintTypeId: id, blueprintName: `Synthetic blueprint ${index ? 'B' : 'A'}`, activity: 'manufacturing', timeSeconds: 100, maxProductionLimit: 5, materials: [{ typeId: 3001, name: 'Synthetic material', quantity: 10 }], products: [{ typeId: 2001 + index, name: `Synthetic output ${index ? 'B' : 'A'}`, quantity: 1 }], skills: [{ typeId: 4001, name: 'Synthetic skill', level: 2 }] })),
  };
}

function newer(value = catalog()) {
  value.provenance.buildNumber = 101;
  value.provenance.releaseDate = '2026-01-02T00:00:00Z';
  value.provenance.sourceUrl = value.provenance.sourceUrl.replace('-100-', '-101-');
  value.provenance.archiveSha256 = 'c'.repeat(64);
  return value;
}

// Tiny stored ZIP exercises the actual official-format updater without downloads.
function archiveBytes() {
  const c = newer(), rows = {
    '_sde.jsonl': [{ _key: 'sde', buildNumber: c.provenance.buildNumber, releaseDate: c.provenance.releaseDate }],
    'categories.jsonl': c.categories.map(([id, name]) => ({ _key: id, name: { en: name } })),
    'groups.jsonl': c.groups.map(([id, name, categoryID]) => ({ _key: id, name: { en: name }, categoryID })),
    'types.jsonl': c.items.map(([id, name, groupID, volume, marketGroupID]) => ({ _key: id, name: { en: name }, groupID, published: true, ...(volume === null ? {} : { volume }), ...(marketGroupID === null ? {} : { marketGroupID }) })),
    'blueprints.jsonl': c.recipes.map(recipe => ({ _key: recipe.blueprintTypeId, blueprintTypeID: recipe.blueprintTypeId, maxProductionLimit: recipe.maxProductionLimit, activities: { manufacturing: { time: recipe.timeSeconds, materials: recipe.materials.map(row => ({ typeID: row.typeId, quantity: row.quantity })), products: recipe.products.map(row => ({ typeID: row.typeId, quantity: row.quantity })), skills: recipe.skills.map(row => ({ typeID: row.typeId, level: row.level })) } } })),
  };
  const local = [], directory = []; let offset = 0;
  for (const [name, values] of Object.entries(rows)) {
    const filename = Buffer.from(name), body = Buffer.from(values.map(row => JSON.stringify(row)).join('\n') + '\n');
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14); header.writeUInt32LE(body.length, 18); header.writeUInt32LE(body.length, 22); header.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    local.push(header, filename, body); directory.push(central, filename); offset += header.length + filename.length + body.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(rows).length, 8); end.writeUInt16LE(Object.keys(rows).length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, end]);
}

function fixture(t) {
  const temporaryRoot = realpathSync(tmpdir());
  const temporary = mkdtempSync(join(temporaryRoot, 'optieve-catalog-test-'));
  const sourceRoot = join(temporary, 'development'), targetRoot = join(temporary, 'private'), validationDir = join(temporary, 'validation');
  const links = [];
  for (const path of [sourceRoot, validationDir]) mkdirSync(path);
  const put = (root, name, value) => { const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); return path; };
  const original = bytes(catalog());
  put(sourceRoot, '.openai/hosting.json', '{"d1":"DB","r2":null,"capabilities":["mcp"]}\n');
  put(sourceRoot, catalogName, original);
  for (const root of [sourceRoot, validationDir]) {
    put(root, 'package.json', bytes({ name: 'catalog-fixture', type: 'module', devDependencies: { typescript: compilerPin.version } }));
    put(root, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
  }
  t.after(() => {
    assert.equal(dirname(resolve(temporary)), temporaryRoot);
    assert.ok(basename(temporary).startsWith('optieve-catalog-test-'));
    assert.ok(!lstatSync(temporary).isSymbolicLink());
    for (const path of links.reverse()) { if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(path); }
    rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const reports = [], stages = [], validations = [], synchronizations = [];
  const options = { sourceRoot, targetRoot, validationDir };
  const operations = {
    compiler: Buffer.from('test seam, never executed'),
    stage: ({ stage, stagedCatalog }) => { stages.push(stage); writeFileSync(stagedCatalog, bytes(newer())); },
    validate: ({ stage }) => { validations.push(stage); assert.equal(JSON.parse(readFileSync(join(stage, catalogName))).provenance.buildNumber, 101); },
    synchronize: (...args) => { synchronizations.push(args); return { inSync: true }; },
    report: message => reports.push(message),
  };
  return { sourceRoot, targetRoot, validationDir, options, operations, original, reports, stages, validations, synchronizations, links, put, temporary };
}

test('semantic catalog comparison ignores row, property and component ordering', () => {
  const a = catalog(), b = clone(a);
  b.items.reverse(); b.recipes.reverse(); b.provenance.sourceFiles.reverse();
  b.recipes[0] = Object.fromEntries(Object.entries(b.recipes[0]).reverse());
  assert.equal(diffCatalogs(a, b).classification, 'unchanged');
});

test('provenance-only refresh is explicitly distinguished from semantic changes', () => {
  const diff = diffCatalogs(catalog(), newer());
  assert.equal(diff.classification, 'provenance-only');
  assert.equal(diff.semanticChanged, false);
  assert.match(formatCatalogDiff(diff), /Only release provenance changed/);
});

test('item additions, removals and volume changes are counted independently', () => {
  const a = catalog(), b = newer();
  a.items.push([9001, 'Synthetic removed', 1, null, null]);
  b.items.push([9002, 'Synthetic added', 1, null, null]);
  b.items[2][3] = 12;
  const diff = diffCatalogs(a, b);
  assert.equal(diff.classification, 'semantic-change');
  assert.equal(diff.tables.items.added.count, 1);
  assert.equal(diff.tables.items.removed.count, 1);
  assert.equal(diff.tables.items.changed.count, 1);
});

test('group/category names, recipe names and every manufacturing requirement are compared', () => {
  const a = catalog(), b = newer();
  b.groups[0][1] += ' new'; b.categories[0][1] += ' new';
  b.items[0][1] = b.recipes[0].blueprintName = 'Synthetic renamed blueprint';
  Object.assign(b.recipes[0], { timeSeconds: 200, maxProductionLimit: 10 });
  b.recipes[0].materials[0].quantity = 20;
  b.recipes[0].products[0].quantity = 2;
  b.recipes[0].skills[0].level = 3;
  const diff = diffCatalogs(a, b);
  assert.equal(diff.tables.groups.changed.count, 1);
  assert.equal(diff.tables.categories.changed.count, 1);
  assert.equal(diff.tables.recipes.changed.count, 1);
  assert.ok(Object.values(diff.recipeDetails).every(value => value.count === 1));
});

test('recipe additions/removals and bounded numeric examples never print arbitrary catalog names', () => {
  const a = catalog(), b = newer();
  a.recipes.pop(); b.recipes.shift();
  for (let id = 10000; id < 10100; id++) b.items.push([id, `Synthetic name ${id}`, 1, null, null]);
  const diff = diffCatalogs(a, b, { sampleLimit: 3 }), report = formatCatalogDiff(diff);
  assert.equal(diff.tables.recipes.added.count, 1);
  assert.equal(diff.tables.recipes.removed.count, 1);
  assert.equal(diff.tables.items.added.sampleIds.length, 3);
  assert.equal(diff.tables.items.added.omitted, 97);
  assert.ok(report.length < 1500);
  assert.doesNotMatch(report, /Synthetic/);
  assert.throws(() => diffCatalogs(a, b, { sampleLimit: 21 }));
});

for (const [name, change] of [
  ['unrecognized root metadata', c => { c.account = 'unexpected'; }],
  ['unrecognized provenance metadata', c => { c.provenance.owner = 'unexpected'; }],
  ['nonofficial provenance', c => { c.provenance.sourceUrl = 'https://example.test/archive.zip'; }],
  ['invalid release calendar date', c => { c.provenance.releaseDate = '2026-02-30T00:00:00Z'; }],
  ['duplicate item IDs', c => { c.items.push(clone(c.items[0])); }],
  ['unknown group reference', c => { c.items[0][2] = 42; }],
  ['duplicate recipe components', c => { c.recipes[0].materials.push(clone(c.recipes[0].materials[0])); }],
  ['fractional quantities', c => { c.recipes[0].materials[0].quantity = 0.5; }],
  ['unpublished product', c => { c.recipes[0].products[0].typeId = 99999; }],
  ['invalid skill level', c => { c.recipes[0].skills[0].level = 6; }],
]) test(`catalog schema rejects ${name}`, () => { const value = catalog(); change(value); assert.throws(() => validateCatalog(value)); });

test('check-only validates an external stage and leaves both copies and source tree unchanged', async t => {
  const f = fixture(t), before = requirePublicSource(f.sourceRoot);
  const result = await refreshCatalog(f.options, f.operations);
  assert.equal(result.applied, false); assert.equal(result.privateInSync, null);
  assert.deepEqual(requirePublicSource(f.sourceRoot), before);
  assert.equal(f.synchronizations.length, 0);
  assert.equal(f.validations.length, 1);
  assert.ok(f.stages.every(stage => !lstatSync(stage, { throwIfNoEntry: false })));
  assert.doesNotMatch(readdirSync(f.sourceRoot).join(','), /node_modules|dist|outputs/);
  assert.match(f.reports.join('\n'), /CHECK ONLY/);
});

test('apply replaces only the reviewed catalog after validation, then syncs and verifies parity', async t => {
  const f = fixture(t);
  f.operations.validate = () => assert.deepEqual(readFileSync(join(f.sourceRoot, catalogName)), f.original);
  f.operations.synchronize = (source, target, options) => {
    f.synchronizations.push(options?.checkOnly ?? false);
    assert.equal(source, f.sourceRoot); assert.equal(target, f.targetRoot);
    assert.deepEqual(readFileSync(join(source, catalogName)), bytes(newer()));
    return { inSync: true };
  };
  const result = await refreshCatalog({ ...f.options, apply: true }, f.operations);
  assert.equal(result.developmentUpdated, true); assert.equal(result.privateInSync, true);
  assert.deepEqual(f.synchronizations, [false, true]);
  assert.deepEqual(readdirSync(join(f.sourceRoot, 'app/data')), ['manufacturing-catalog.json']);
});

test('catalog apply defaults both guarded sync calls to sibling OptiEVE', async t => {
  const f = fixture(t);
  delete f.options.targetRoot;
  const result = await refreshCatalog({ ...f.options, apply: true }, f.operations);
  assert.equal(result.privateInSync, true);
  assert.equal(f.synchronizations.length, 2);
  for (const [source, target] of f.synchronizations) {
    assert.equal(source, f.sourceRoot);
    assert.equal(target, join(f.temporary, 'OptiEVE'));
  }
  assert.equal(f.synchronizations[0][2], undefined);
  assert.deepEqual(f.synchronizations[1][2], { checkOnly: true });
  assert.equal(lstatSync(join(f.temporary, 'OptiEVE Private'), { throwIfNoEntry: false }), undefined);
});

test('unchanged semantics/provenance preserve original bytes and still verify private parity on apply', async t => {
  const f = fixture(t);
  f.operations.stage = ({ stagedCatalog }) => writeFileSync(stagedCatalog, JSON.stringify(catalog(), null, 2));
  f.operations.validate = () => {};
  const result = await refreshCatalog({ ...f.options, apply: true }, f.operations);
  assert.equal(result.developmentUpdated, false); assert.equal(result.applied, true);
  assert.deepEqual(readFileSync(join(f.sourceRoot, catalogName)), f.original);
  assert.equal(f.synchronizations.length, 2);
});

for (const [name, operation, expectedPhase] of [
  ['download/updater failure', 'stage', 'official SDE staging'],
  ['regression failure', 'validate', 'catalog regression validation'],
]) test(`${name} preserves original catalog and never synchronizes`, async t => {
  const f = fixture(t);
  f.operations[operation] = () => { throw Error('Synthetic failure'); };
  await assert.rejects(refreshCatalog({ ...f.options, apply: true }, f.operations), error => error instanceof CatalogRefreshError && error.phase === expectedPhase && error.developmentUpdated === false);
  assert.deepEqual(readFileSync(join(f.sourceRoot, catalogName)), f.original);
  assert.equal(f.synchronizations.length, 0);
});

test('candidate credentials and unrecognized private metadata fail before tests or commit', async t => {
  const f = fixture(t), candidate = newer();
  candidate.items.push([9001, ['gh', 'p_', 'Q'.repeat(40)].join(''), 1, null, null]);
  f.operations.stage = ({ stagedCatalog }) => writeFileSync(stagedCatalog, bytes(candidate));
  await assert.rejects(refreshCatalog({ ...f.options, apply: true }, f.operations), { developmentUpdated: false });
  assert.equal(f.validations.length, 0); assert.equal(f.synchronizations.length, 0);
  assert.deepEqual(readFileSync(join(f.sourceRoot, catalogName)), f.original);
});

test('private artifacts written by staged validation are rejected before commit', async t => {
  const f = fixture(t);
  f.operations.validate = ({ stage }) => f.put(stage, '.env.local', 'SYNTHETIC_VALUE=fixture\n');
  await assert.rejects(refreshCatalog({ ...f.options, apply: true }, f.operations), { phase: 'precommit source validation', developmentUpdated: false });
  assert.deepEqual(readFileSync(join(f.sourceRoot, catalogName)), f.original);
  assert.equal(f.synchronizations.length, 0);
});

test('validation cannot silently rewrite the reviewed staged catalog', async t => {
  const f = fixture(t);
  f.operations.validate = ({ stage }) => { const value = newer(); value.recipes[0].timeSeconds++; writeFileSync(join(stage, catalogName), bytes(value)); };
  await assert.rejects(refreshCatalog({ ...f.options, apply: true }, f.operations), { phase: 'precommit source validation', developmentUpdated: false });
  assert.deepEqual(readFileSync(join(f.sourceRoot, catalogName)), f.original);
  assert.equal(f.synchronizations.length, 0);
});

test('concurrent development edits are preserved and abort catalog commit', async t => {
  const f = fixture(t);
  f.operations.validate = () => f.put(f.sourceRoot, 'concurrent.txt', 'Synthetic concurrent source change\n');
  await assert.rejects(refreshCatalog({ ...f.options, apply: true }, f.operations), { phase: 'precommit source validation', developmentUpdated: false });
  assert.equal(readFileSync(join(f.sourceRoot, 'concurrent.txt'), 'utf8'), 'Synthetic concurrent source change\n');
  assert.deepEqual(readFileSync(join(f.sourceRoot, catalogName)), f.original);
  assert.equal(f.synchronizations.length, 0);
});

test('older official releases cannot silently roll back the pinned catalog', async t => {
  const f = fixture(t), old = catalog();
  old.provenance.buildNumber = 99; old.provenance.sourceUrl = old.provenance.sourceUrl.replace('-100-', '-99-');
  f.operations.stage = ({ stagedCatalog }) => writeFileSync(stagedCatalog, bytes(old));
  await assert.rejects(refreshCatalog({ ...f.options, apply: true }, f.operations), { developmentUpdated: false });
  assert.deepEqual(readFileSync(join(f.sourceRoot, catalogName)), f.original);
  assert.equal(f.validations.length, 0);
});

test('offline archive uses the real updater in isolation and preserves canonical source in check mode', async t => {
  const f = fixture(t);
  f.put(f.sourceRoot, 'scripts/update-manufacturing-catalog.mjs', readFileSync(new URL('../scripts/update-manufacturing-catalog.mjs', import.meta.url)));
  const archive = f.put(f.temporary, 'synthetic-sde.zip', archiveBytes());
  delete f.operations.stage;
  const result = await refreshCatalog({ ...f.options, archive }, f.operations);
  assert.equal(result.diff.classification, 'provenance-only');
  assert.equal(f.validations.length, 1); assert.equal(f.synchronizations.length, 0);
  assert.deepEqual(readFileSync(join(f.sourceRoot, catalogName)), f.original);
  assert.match(f.reports.join('\n'), /not an independent authenticity signature/);
});

test('corrupted offline archive fails the real updater without replacing the original', async t => {
  const f = fixture(t), bad = archiveBytes();
  f.put(f.sourceRoot, 'scripts/update-manufacturing-catalog.mjs', readFileSync(new URL('../scripts/update-manufacturing-catalog.mjs', import.meta.url)));
  const entry = bad.indexOf(Buffer.from('_sde.jsonl')) + '_sde.jsonl'.length; bad[entry + 1] ^= 1;
  const archive = f.put(f.temporary, 'corrupted-sde.zip', bad);
  delete f.operations.stage;
  await assert.rejects(refreshCatalog({ ...f.options, archive, apply: true }, f.operations), { phase: 'official SDE staging', developmentUpdated: false });
  assert.equal(f.validations.length, 0); assert.equal(f.synchronizations.length, 0);
  assert.deepEqual(readFileSync(join(f.sourceRoot, catalogName)), f.original);
});

test('real guarded private sync preserves runtime state and verifies source parity', async t => {
  const f = fixture(t);
  syncPrivateSource(f.sourceRoot, f.targetRoot);
  const runtime = f.put(f.targetRoot, '.eve-private/runtime-state.txt', 'Synthetic runtime connection state\n');
  const environment = f.put(f.targetRoot, '.env.local', 'SYNTHETIC_VALUE=fixture\n');
  delete f.operations.synchronize;
  await refreshCatalog({ ...f.options, apply: true }, f.operations);
  assert.equal(readFileSync(runtime, 'utf8'), 'Synthetic runtime connection state\n');
  assert.equal(readFileSync(environment, 'utf8'), 'SYNTHETIC_VALUE=fixture\n');
  assert.deepEqual(readFileSync(join(f.targetRoot, catalogName)), bytes(newer()));
  assert.equal(syncPrivateSource(f.sourceRoot, f.targetRoot, { checkOnly: true }).inSync, true);
  assert.ok(!lstatSync(join(f.sourceRoot, '.eve-private'), { throwIfNoEntry: false }));
});

test('private source conflict is reported as partial development success without forcing or rollback', async t => {
  const f = fixture(t);
  syncPrivateSource(f.sourceRoot, f.targetRoot);
  const privateEdit = clone(catalog()); privateEdit.recipes[0].timeSeconds = 999;
  writeFileSync(join(f.targetRoot, catalogName), bytes(privateEdit));
  delete f.operations.synchronize;
  await assert.rejects(refreshCatalog({ ...f.options, apply: true }, f.operations), error => error.developmentUpdated === true && error.phase === 'private source synchronization' && /Private source parity is pending/.test(error.message));
  assert.deepEqual(readFileSync(join(f.sourceRoot, catalogName)), bytes(newer()));
  assert.deepEqual(readFileSync(join(f.targetRoot, catalogName)), bytes(privateEdit));
});

test('failed parity verification never reports completion', async t => {
  const f = fixture(t);
  f.operations.synchronize = () => ({ inSync: false });
  await assert.rejects(refreshCatalog({ ...f.options, apply: true }, f.operations), { developmentUpdated: true, phase: 'private source parity check' });
  assert.ok(f.reports.every(message => !message.includes('parity verified')));
});

test('unchanged catalog with a private sync failure still reports pending parity', async t => {
  const f = fixture(t);
  f.operations.stage = ({ stagedCatalog }) => writeFileSync(stagedCatalog, bytes(catalog()));
  f.operations.validate = () => {};
  f.operations.synchronize = () => { throw Error('Synthetic private conflict'); };
  await assert.rejects(refreshCatalog({ ...f.options, apply: true }, f.operations), error => error.developmentUpdated === false && error.privateSyncPending === true && /development catalog is unchanged/.test(error.message));
  assert.deepEqual(readFileSync(join(f.sourceRoot, catalogName)), f.original);
});

test('private development roots, nested private sources, and overlapping sync targets are refused', async t => {
  const f = fixture(t);
  await assert.rejects(refreshCatalog({ ...f.options, targetRoot: join(f.sourceRoot, 'private') }, f.operations), { phase: 'preflight' });
  mkdirSync(join(f.sourceRoot, '.eve-private'));
  await assert.rejects(refreshCatalog(f.options, f.operations), { phase: 'preflight' });
  mkdirSync(join(f.sourceRoot, 'nested'));
  assert.throws(() => realPublicDirectory(join(f.sourceRoot, 'nested')), /private runtime/);
  assert.deepEqual(readFileSync(join(f.sourceRoot, catalogName)), f.original);
});

test('linked source roots and hard-linked catalog destinations are refused', async t => {
  const f = fixture(t), linked = join(f.temporary, 'linked');
  symlinkSync(f.sourceRoot, linked, process.platform === 'win32' ? 'junction' : 'dir'); f.links.push(linked);
  await assert.rejects(refreshCatalog({ ...f.options, sourceRoot: linked }, f.operations), { phase: 'preflight' });
  linkSync(join(f.sourceRoot, catalogName), join(f.temporary, 'catalog-hardlink.json'));
  await assert.rejects(refreshCatalog(f.options, f.operations), { phase: 'preflight' });
  assert.deepEqual(readFileSync(join(f.sourceRoot, catalogName)), f.original);
});

test('archives inside development or a private runtime are refused before updater execution', async t => {
  const f = fixture(t);
  mkdirSync(f.targetRoot); mkdirSync(join(f.targetRoot, '.eve-private'));
  const archive = f.put(f.targetRoot, 'fixture.zip', 'Synthetic archive placeholder');
  await assert.rejects(refreshCatalog({ ...f.options, archive }, f.operations), { phase: 'preflight' });
  assert.equal(f.stages.length, 0);
});

test('external compiler is rejected on wrong package inputs, private marker, or untrusted runtime hash', t => {
  const f = fixture(t), entries = requirePublicSource(f.sourceRoot);
  f.put(f.validationDir, 'node_modules/typescript/package.json', bytes({ name: 'typescript', version: compilerPin.version }));
  f.put(f.validationDir, 'node_modules/typescript/lib/typescript.js', 'throw Error("Untrusted validation code must never execute");\n');
  assert.throws(() => readValidationCompiler(f.validationDir, f.sourceRoot, f.targetRoot, entries), /reviewed TypeScript runtime/);
  f.put(f.validationDir, 'pnpm-lock.yaml', 'lockfileVersion: 8\n');
  assert.throws(() => readValidationCompiler(f.validationDir, f.sourceRoot, f.targetRoot, entries), /inputs must match/);
  mkdirSync(join(f.validationDir, '.eve-private'));
  assert.throws(() => readValidationCompiler(f.validationDir, f.sourceRoot, f.targetRoot, entries), /private runtime/);
  assert.throws(() => readValidationCompiler(f.sourceRoot, f.sourceRoot, f.targetRoot, entries), /outside development/);
});

test('compiler package links resolving outside external node_modules are refused', t => {
  const f = fixture(t), outside = join(f.temporary, 'outside-compiler');
  mkdirSync(outside); mkdirSync(join(f.validationDir, 'node_modules'));
  const linked = join(f.validationDir, 'node_modules/typescript');
  symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir'); f.links.push(linked);
  assert.throws(() => readValidationCompiler(f.validationDir, f.sourceRoot, f.targetRoot, requirePublicSource(f.sourceRoot)), /inside the external validation/);
});

test('CLI defaults to check and cannot select arbitrary output paths or validation commands', () => {
  const options = parseRefreshArguments(['--validation-dir', 'synthetic-validation']);
  assert.equal(options.apply, false);
  assert.equal(parseRefreshArguments(['--apply', '--validation-dir', 'synthetic-validation']).apply, true);
  for (const args of [[], ['--check', '--apply'], ['--validation-dir'], ['--validation-dir', '--apply'], ['--output', 'arbitrary'], ['--validation-command', 'arbitrary'], ['--validation-dir', 'one', '--validation-dir', 'two']]) assert.throws(() => parseRefreshArguments(args));
});
