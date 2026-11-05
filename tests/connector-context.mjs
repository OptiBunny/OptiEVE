import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const fixtureModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(readFileSync('lib/connector-contract.mts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { module: fixtureModule, exports: fixtureModule.exports });
const { createConnectors } = fixtureModule.exports;
const context = inputSchema => ({ status: 'success', connectors: [{ connectorId: 'synthetic', policy: 'enabled', tools: [{ actionName: 'read', inputSchema }] }] });
const read = value => createConnectors({ getContext: async () => value }).getContext();
const projected = value => value.connectors[0].tools[0].inputSchema;
const json = value => JSON.parse(JSON.stringify(value));
const rejected = async value => {
  const result = await read(value);
  assert.equal(result.status, 'upstream_error');
  assert.deepEqual(json(result), { status: 'upstream_error' });
};

test('context preserves valid JSON schemas, references, scalars and unusual property names', async () => {
  const schema = JSON.parse('{"type":"object","$defs":{"item":{"type":"string"}},"properties":{"value":{"$ref":"#/$defs/item"}},"enum":[null,true,false,0,-2.5,"é🙂"],"additionalProperties":false,"__proto__":{"synthetic":true},"toJSON":{"type":"string"}}');
  const result = await read(context(schema));
  assert.equal(result.status, 'success');
  assert.deepEqual(json(projected(result)), schema);
  assert(Object.hasOwn(projected(result), '__proto__'));
  assert.equal({}.synthetic, undefined);
  assert.notEqual(projected(result), schema);
});

test('null-prototype, frozen, and shared acyclic JSON values remain supported', async () => {
  const shared = Object.freeze({ type: 'string' });
  const schema = Object.assign(Object.create(null), { type: 'object', properties: Object.freeze({ one: shared, two: shared }) });
  const result = await read(context(schema));
  assert.equal(result.status, 'success');
  assert.deepEqual(json(projected(result)), json(schema));
});

for (const [name, value] of [
  ['undefined', undefined], ['infinity', Infinity], ['NaN', NaN], ['bigint', 1n],
  ['symbol', Symbol('synthetic')], ['function', () => 1], ['date', new Date(0)],
  ['map', new Map()], ['set', new Set()], ['typed array', new Uint8Array(1)], ['regexp', /synthetic/],
]) test(`context rejects a non-JSON schema value: ${name}`, async () => {
  await rejected(context({ type: 'object', nested: value }));
});

test('cyclic schemas fail safely, including indirect cycles', async () => {
  const direct = {}; direct.self = direct;
  const first = {}, second = { first }; first.second = second;
  await rejected(context(direct));
  await rejected(context(first));
});

test('schema depth is bounded without rejecting ordinary nested schemas', async () => {
  const nested = depth => { const root = {}; let value = root; for (let index = 0; index < depth; index++) value = value.child = {}; return root; };
  assert.equal((await read(context(nested(32)))).status, 'success');
  await rejected(context(nested(2000)));
});

const sharedTree = depth => {
  let value = {};
  for (let index = 0; index < depth; index++) value = { left: value, right: value };
  return value;
};
const withSchemas = schemas => ({ status: 'success', connectors: [{ connectorId: 'synthetic', policy: 'enabled', tools: schemas.map(inputSchema => ({ actionName: 'read', inputSchema })) }] });

test('a bounded shared DAG cannot amplify into an excessive JSON projection', async () => {
  // Only 17 source objects, but cloning every reference would produce 131,071.
  await rejected(context(sharedTree(16)));
  assert.equal((await read(context(sharedTree(8)))).status, 'success');
});

test('the traversal budget is shared across tools and connectors', async () => {
  const schema = sharedTree(15);
  assert.equal((await read(context(schema))).status, 'success');
  await rejected(withSchemas([schema, schema]));
  const acrossConnectors = context(schema);
  acrossConnectors.connectors.push(context(schema).connectors[0]);
  await rejected(acrossConnectors);
});

test('the context bounds cumulative UTF-8 string and schema key bytes', async () => {
  const text = '🙂'.repeat(1_100_000); // 4.4 MB in UTF-8, below the individual limit.
  assert.equal((await read(context({ description: text }))).status, 'success');
  await rejected(withSchemas([{ description: text }, { description: text }]));
  await rejected(withSchemas([{ [text]: null }, { [text]: null }]));
  await rejected(context({ description: 'x'.repeat(8 * 1024 * 1024 + 1) }));
});

test('connector metadata shares the schema string budget', async () => {
  const value = context({ description: 'x'.repeat(5 * 1024 * 1024) });
  value.connectors[0].tools[0].description = 'x'.repeat(4 * 1024 * 1024);
  await rejected(value);
});

test('the string budget includes JSON escaping for controls and lone surrogates', async () => {
  for (const escaped of ['\u0000', '\ud800']) {
    // 1.4 million UTF-16 units expand to 8.4 million JSON string bytes.
    await rejected(context({ description: escaped.repeat(1_400_000) }));
  }
});

test('excessive connector and tool lists are rejected before reading their entries', async () => {
  let entryReads = 0;
  const list = new Proxy(Array(100_001), {
    getOwnPropertyDescriptor(target, key) {
      if (key === '0') entryReads++;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  await rejected({ status: 'success', connectors: list });
  const value = context({}); value.connectors[0].tools = list;
  await rejected(value);
  assert.equal(entryReads, 0);
});

test('ordinary multi-tool catalogs remain supported within the shared limits', async () => {
  const schema = { type: 'object', properties: { value: { $ref: '#/$defs/value' } }, $defs: { value: { type: 'string', maxLength: 100 } }, additionalProperties: false };
  const result = await read(withSchemas(Array(1000).fill(schema)));
  assert.equal(result.status, 'success');
  assert.equal(result.connectors[0].tools.length, 1000);
});

test('schema accessors and toJSON hooks are rejected without execution', async () => {
  let executed = 0;
  const getter = Object.defineProperty({}, 'nested', { enumerable: true, get() { executed++; return 'synthetic-private-value'; } });
  const hook = { toJSON() { executed++; return { type: 'string' }; } };
  const inheritedHook = Object.create({ toJSON() { executed++; return {}; } });
  for (const schema of [getter, hook, inheritedHook]) await rejected(context(schema));
  assert.equal(executed, 0);
});

test('schema array accessors, holes and non-JSON keys are rejected safely', async () => {
  let executed = 0;
  const getter = Object.defineProperty([0], '0', { enumerable: true, get() { executed++; return 'synthetic-private-value'; } });
  const symbolKey = { [Symbol('synthetic')]: 1 };
  for (const schema of [{ enum: getter }, { enum: Array(1) }, symbolKey]) await rejected(context(schema));
  assert.equal(executed, 0);
});

test('known context fields and list entries must be data properties', async () => {
  let executed = 0;
  const accessor = (value, key) => Object.defineProperty(value, key, { enumerable: true, get() { executed++; return 'synthetic-private-value'; } });
  const status = accessor({}, 'status');
  const connectors = accessor({ status: 'success' }, 'connectors');
  const schema = context({}); accessor(schema.connectors[0].tools[0], 'inputSchema');
  const action = context({}); accessor(action.connectors[0].tools[0], 'actionName');
  const list = context({}); accessor(list.connectors, '0');
  for (const value of [status, connectors, schema, action, list]) await rejected(value);
  assert.equal(executed, 0);
});

test('unrelated diagnostics are omitted without invoking getters or serializing cycles', async () => {
  let executed = 0;
  const value = context({ type: 'object' });
  const cyclic = {}; cyclic.self = cyclic; value.privateMetadata = cyclic;
  Object.defineProperty(value.connectors[0].tools[0], 'privateMetadata', { get() { executed++; return 'synthetic-private-value'; } });
  const result = await read(value);
  assert.equal(result.status, 'success');
  assert(!JSON.stringify(result).includes('privateMetadata'));
  assert.equal(executed, 0);
});

test('known context failure statuses and thrown exceptions keep their safe behavior', async () => {
  for (const status of ['binding_unavailable', 'upstream_error', 'internal_error', 'request_context_expired']) {
    assert.deepEqual(json(await read({ status, diagnostic: 'synthetic-private-value' })), { status });
  }
  const result = await createConnectors({ getContext: async () => { throw Error('synthetic-private-value'); } }).getContext();
  assert.deepEqual(json(result), { status: 'upstream_error' });
});
