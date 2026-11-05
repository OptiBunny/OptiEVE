import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync('app/lib/manufacturing-stock.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const m = { exports: {} }; vm.runInNewContext(code, { module: m, exports: m.exports, Set, Map });
const project = input => JSON.parse(JSON.stringify(m.exports.projectManufacturingStock(input)));
const facility = 60000001, otherFacility = 60000002, structure = 1000000000000;
const row = (item_id, options = {}) => ({ item_id, type_id: 34, location_id: facility, location_type: 'station', location_flag: 'Hangar', quantity: 10, is_singleton: false, ...options });
const box = (item_id, options = {}) => row(item_id, { type_id: 3293, quantity: 1, is_singleton: true, ...options });
const office = (item_id = 100) => box(item_id, { type_id: 27, location_flag: 'OfficeFolder', location_type: 'other' });
const contents = (item_id, location_id, options = {}) => row(item_id, { location_id, location_type: 'item', location_flag: 'Unlocked', ...options });
const input = (rows, options = {}) => ({ rows, resourceEntity: 'character', verifiedFacilityIds: [facility], selectedStockLocationIds: [facility], materialTypeIds: [34, 35], providerComplete: true, ...options });
const corp = (rows, options = {}) => input(rows, { resourceEntity: 'corporation', hangarDivisions: [1], ...options });
const unknown = result => { assert.equal(result.complete, false); assert.deepEqual(result.quantities, []); assert.deepEqual(result.byDivision, {}); assert.ok(result.issues.length > 0); };
const quantity = (result, typeId = 34) => result.quantities.find(value => value.typeId === typeId)?.quantity;

test('complete personal hangar counts exact material stacks and reports proven absent types as zero', () => {
  const result = project(input([row(1), row(2, { quantity: 25 }), row(3, { type_id: 36, quantity: 100 })]));
  assert.deepEqual(result, { complete: true, quantities: [{ typeId: 34, quantity: 35 }, { typeId: 35, quantity: 0 }], byDivision: { personal: { 34: 35 } }, issues: [] });
});
test('an empty complete snapshot is zero only for a verified physical selection', () => {
  assert.equal(quantity(project(input([]))), 0);
  unknown(project(input([], { selectedStockLocationIds: [100] })));
});
test('personal container ancestry inherits Hangar, supports nesting and does not double-count overlapping selections', () => {
  const rows = [box(100), box(101, { location_id: 100, location_type: 'item', location_flag: 'Unlocked' }), contents(1, 101), contents(2, 100, { quantity: 5 })];
  const result = project(input(rows, { selectedStockLocationIds: [facility, 100, 101] }));
  assert.equal(result.complete, true); assert.equal(quantity(result), 15);
  assert.equal(quantity(project(input(rows, { selectedStockLocationIds: [101] }))), 10);
});
test('unselected but resolved ordinary containers do not donate their stock', () => {
  const rows = [box(100), box(101), contents(1, 100), contents(2, 101, { quantity: 500 })];
  assert.equal(quantity(project(input(rows, { selectedStockLocationIds: [100] }))), 10);
});
test('corporation OfficeFolder with location_type other bridges selected hangars to a facility', () => {
  const rows = [office(), row(1, { location_id: 100, location_type: 'item', location_flag: 'CorpSAG1' }), row(2, { location_id: 100, location_type: 'item', location_flag: 'CorpSAG2', quantity: 80 })];
  const result = project(corp(rows, { selectedStockLocationIds: [100] }));
  assert.equal(result.complete, true); assert.equal(quantity(result), 10); assert.deepEqual(result.byDivision, { 1: { 34: 10 } });
});
test('nested corporation containers inherit selected division from their container/office path', () => {
  const rows = [office(), box(101, { location_id: 100, location_type: 'item', location_flag: 'CorpSAG2' }), box(102, { location_id: 101, location_type: 'item', location_flag: 'Unlocked' }), contents(1, 102)];
  const result = project(corp(rows, { selectedStockLocationIds: [100, 101, 102], hangarDivisions: [2] }));
  assert.equal(result.complete, true); assert.equal(quantity(result), 10); assert.deepEqual(result.byDivision, { 2: { 34: 10 } });
});
test('direct structure stock and division carried on the material row are supported', () => {
  const result = project(corp([row(1, { location_id: structure, location_type: 'item', location_flag: 'CorpSAG3' })], { verifiedFacilityIds: [structure], selectedStockLocationIds: [structure], hangarDivisions: [3] }));
  assert.equal(result.complete, true); assert.deepEqual(result.byDivision, { 3: { 34: 10 } });
});
test('different corporate divisions are combined only when each is explicitly selected and remain distinct', () => {
  const rows = [row(1, { location_flag: 'CorpSAG1' }), row(2, { location_flag: 'CorpSAG2', quantity: 20 }), row(3, { location_flag: 'CorpSAG3', quantity: 500 })];
  const result = project(corp(rows, { hangarDivisions: [1, 2] }));
  assert.equal(quantity(result), 30); assert.deepEqual(result.byDivision, { 1: { 34: 10 }, 2: { 34: 20 } });
  assert.equal(quantity(project(corp(rows))), 10);
});
test('explicit container from an unselected corporation division is rejected', () => {
  unknown(project(corp([box(100, { location_flag: 'CorpSAG2' })], { selectedStockLocationIds: [100] })));
});
test('conflicting corporation divisions anywhere in the selected path fail closed', () => {
  unknown(project(corp([box(100, { location_flag: 'CorpSAG1' }), contents(1, 100, { location_flag: 'CorpSAG2' })], { hangarDivisions: [1, 2] })));
});
test('personal Hangar and corporation division cannot substitute for each other', () => {
  unknown(project(input([row(1, { location_flag: 'CorpSAG1' })])));
  unknown(project(corp([row(1)])));
  unknown(project(input([row(1, { location_flag: 'Unlocked' })])));
  unknown(project(corp([office(), contents(1, 100)])));
});
test('provider-incomplete snapshots never present observed stock or zero as complete', () => {
  unknown(project(input([row(1)], { providerComplete: false })));
  unknown(project(input([], { providerComplete: false })));
});
test('unknown parent of apparently unrelated material still makes overall stock coverage unknown', () => {
  unknown(project(input([row(1), contents(2, 999999)])));
});
test('explicit different station/system roots prove stock outside the selection without guessing item IDs', () => {
  const result = project(input([row(1), row(2, { location_id: otherFacility }), row(3, { location_id: 30000001, location_type: 'solar_system' }), box(100, { location_id: otherFacility }), contents(4, 100)]));
  assert.equal(result.complete, true); assert.equal(quantity(result), 10);
  unknown(project(input([box(100, { location_id: otherFacility })], { selectedStockLocationIds: [100] })));
});
test('missing ancestry of unrelated non-material assets does not invalidate known materials', () => {
  const result = project(input([row(1), contents(2, 999999, { type_id: 36 })]));
  assert.equal(result.complete, true); assert.equal(quantity(result), 10);
});
test('cycles and self-parenting are unknown instead of recursively traversed', () => {
  unknown(project(input([box(100, { location_id: 101, location_type: 'item', location_flag: 'Unlocked' }), box(101, { location_id: 100, location_type: 'item', location_flag: 'Unlocked' }), contents(1, 100)])));
  unknown(project(input([box(100, { location_id: 100, location_type: 'item' })], { selectedStockLocationIds: [100] })));
  unknown(project(input([row(1, { location_id: 1, location_type: 'item' })])));
});
test('16 asset rows of ancestry are bounded and accepted, while 17 fail closed', () => {
  const chain = count => Array.from({ length: count }, (_, i) => box(100 + i, i ? { location_id: 99 + i, location_type: 'item', location_flag: 'Unlocked' } : {}));
  assert.equal(quantity(project(input([...chain(15), contents(1, 114)]))), 10);
  unknown(project(input([...chain(16), contents(1, 115)])));
});
test('contradictory physical location types cannot be used as parent links', () => {
  unknown(project(input([box(100), contents(1, 100, { location_type: 'station' })])));
  unknown(project(input([row(1, { location_type: 'solar_system' })])));
});
test('non-singleton and blueprint parents cannot act as containers', () => {
  unknown(project(input([row(100, { type_id: 3293 }), contents(1, 100)])));
  unknown(project(input([box(100, { is_blueprint_copy: true }), contents(1, 100)])));
});
test('singleton materials and blueprint copies are never credited', () => {
  const result = project(input([row(1), box(2, { type_id: 34 }), row(3, { is_blueprint_copy: true })]));
  assert.equal(result.complete, true); assert.equal(quantity(result), 10);
});
for (const flag of ['Cargo', 'Locked', 'AssetSafety', 'Deliveries', 'CorpDeliveries', 'FleetHangar', 'SpecializedOreHold', 'StructureFuel', 'Impounded']) {
  test(`selected ${flag} materials are conditional and cannot silently become usable stock`, () => {
    unknown(project(input([box(100), contents(1, 100, { location_flag: flag })])));
    unknown(project(input([box(100, { location_flag: flag })], { selectedStockLocationIds: [100] })));
  });
}
test('unsupported but proven unselected branches do not contaminate selected stock', () => {
  const result = project(input([box(100), box(101), contents(1, 100), contents(2, 101, { location_flag: 'Cargo' })], { selectedStockLocationIds: [100] }));
  assert.equal(result.complete, true); assert.equal(quantity(result), 10);
});
for (const overrides of [{ quantity: 0 }, { quantity: -1 }, { quantity: 1.5 }, { quantity: '10' }, { quantity: 1e12 + 1 }, { type_id: 0 }, { type_id: '34' }, { item_id: Number.MAX_SAFE_INTEGER + 1 }, { location_id: -1 }, { location_flag: 'unknown' }, { location_flag: '__proto__' }, { location_type: 'container' }, { is_singleton: undefined }, { is_singleton: 0 }, { is_singleton: true }, { is_blueprint_copy: 'false' }, { location_flag: 'OfficeFolder' }]) {
  test('strict malformed asset fails closed: ' + JSON.stringify(overrides), () => unknown(project(input([row(1, overrides)]))));
}
test('duplicate item IDs and asset/facility identity collisions are rejected', () => {
  unknown(project(input([row(1), row(1)])));
  unknown(project(input([row(facility)])));
});
test('exact quantity sum is bounded before overflow and no partial totals escape', () => {
  assert.equal(quantity(project(input([row(1, { quantity: 1e12 - 10 }), row(2)]))), 1e12);
  unknown(project(input([row(1, { quantity: 1e12 }), row(2)])));
});
for (const overrides of [{ resourceEntity: 'all' }, { rows: null }, { providerComplete: 'true' }, { verifiedFacilityIds: [] }, { verifiedFacilityIds: [facility, facility] }, { selectedStockLocationIds: [] }, { selectedStockLocationIds: [facility, facility] }, { selectedStockLocationIds: [1.5] }, { materialTypeIds: [] }, { materialTypeIds: [34, 34] }, { hangarDivisions: [1] }]) {
  test('invalid bounded stock input fails closed: ' + JSON.stringify(overrides), () => unknown(project(input([], overrides))));
}
for (const hangarDivisions of [undefined, [], [0], [8], [1, 1], [1.5], ['1']]) {
  test('corporation requires explicit valid distinct hangar divisions: ' + JSON.stringify(hangarDivisions), () => unknown(project(corp([], { hangarDivisions }))));
}
test('50,000 valid rows are accepted and 50,001 are rejected before projection', () => {
  const rows = Array.from({ length: 50_000 }, (_, i) => row(1000 + i, { type_id: 36 }));
  assert.equal(project(input(rows)).complete, true);
  unknown(project(input([...rows, row(60000)])));
});
test('sparse selectors, missing input and invalid records fail closed without throwing', () => {
  unknown(project(null)); unknown(project(undefined)); unknown(project([]));
  for (const field of ['verifiedFacilityIds', 'selectedStockLocationIds', 'materialTypeIds']) unknown(project(input([], { [field]: Array(1) })));
  unknown(project(corp([], { hangarDivisions: Array(1) })));
  unknown(project(input(Array(1)))); unknown(project(input([null]))); unknown(project(input([new Date()])));
});
test('projection is order-independent, does not mutate inputs and returns no raw asset details', () => {
  const rows = [box(100), contents(1, 100), row(2, { type_id: 35, quantity: 20, personal_note: 'SYNTHETIC_PRIVATE_SENTINEL' })];
  const args = input(rows), before = JSON.stringify(args), result = project(args);
  assert.deepEqual(project(input([...rows].reverse())), result); assert.equal(JSON.stringify(args), before);
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_SENTINEL'));
  assert.ok(!JSON.stringify(result).includes('item_id')); assert.ok(!JSON.stringify(result).includes('location_id'));
});
