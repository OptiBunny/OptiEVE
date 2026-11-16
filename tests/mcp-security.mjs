import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = file => ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const catalogCode = source('app/lib/character-data.ts');
const corporationCode = source('app/lib/corporation-data.ts');
const mcpCode = source('app/mcp/route.ts');
const apiCode = source('app/api/eve/[...path]/route.ts');
const manufacturingSources = new Map();
const manufacturingData = JSON.parse(readFileSync('app/data/manufacturing-catalog.json', 'utf8'));
const manufacturingNames = ['manufacturing_compare', 'manufacturing_plan', 'manufacturing_item_search', 'manufacturing_recipe', 'manufacturing_catalog_status', 'manufacturing_requirements', 'manufacturing_market_history', 'manufacturing_industry_costs', 'manufacturing_station_quote', 'assess_manufacturing'];
const historyNames = ['wallet_history_status', 'wallet_history_report', 'configure_wallet_history', 'capture_wallet_history', 'clear_wallet_history'];
const origin = 'https://example.chatgpt.site';

function harness(options = {}) {
  const calls = [];
  const workspaceCalls = [];
  const characterWorkspaceCalls = [];
  const manufacturingCalls = [];
  const historyCalls = [];
  const overviewCalls = [], overviewFeedCalls = [], trainingCalls = [];
  let realOverview;
  const execute = (code, require = () => { throw new Error('Unexpected import'); }) => {
    const fixtureModule = { exports: {} };
    vm.runInNewContext(code, {
      module: fixtureModule, exports: fixtureModule.exports, require, Request, Response, URL, URLSearchParams,
      AbortSignal, AbortController, ReadableStream, TextDecoder, TextEncoder, Uint8Array, Headers, structuredClone, setTimeout, clearTimeout,
      fetch: async (_url, init) => {
        calls.push('public');
        assert.equal(init.redirect, 'manual');
        return options.publicResponse?.clone() ?? Response.json([], { headers: { 'x-pages': '2' } });
      },
    });
    return fixtureModule.exports;
  };
  const catalog = execute(catalogCode);
  const corporationCatalog = execute(corporationCode);
  class EveError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
  }
  const backend = {
    EveError,
    publicError: error => ({ error: error instanceof EveError ? error.message : 'Request failed.', status: error instanceof EveError ? error.status : 500 }),
    requireUser: request => {
      const user = request.headers.get('oai-authenticated-user-id');
      if (!user) throw new EveError('Sign in first.', 401);
      return user;
    },
    checkOrigin: request => { if (request.headers.get('origin') !== origin) throw new EveError('Invalid origin.', 403); },
    getStatus: async () => { calls.push('status'); return options.statusResult ?? { characters: [] }; },
    saveConfig: async () => { calls.push('config'); return { configured: true }; },
    startConnect: async () => { calls.push('connect'); return { url: `${origin}/synthetic-signin` }; },
    disconnect: async () => { calls.push('disconnect'); return { disconnected: true }; },
    readEve: async () => { calls.push('legacy'); return { data: [] }; },
    readCharacterData: async (_user, args) => {
      try { catalog.buildCharacterRequest(args); }
      catch (error) { throw new EveError(error.message); }
      calls.push('character');
      return { data: [] };
    },
    readCorporationData: async (_user, args) => {
      try { corporationCatalog.buildCorporationRequest(args); }
      catch (error) { throw new EveError(error.message); }
      calls.push('corporation');
      return { data: [] };
    },
  };
  const manufacturingModules = new Map();
  function manufacturingRequire(name) {
    if (name === './eve') return backend;
    if (name === '../data/manufacturing-catalog.json') return { default: manufacturingData };
    if (!/^\.\/manufacturing-[a-z-]+$/.test(name)) throw new Error(`Unexpected manufacturing import: ${name}`);
    if (!manufacturingModules.has(name)) {
      const file = `app/lib/${name.slice(2)}.ts`;
      if (!manufacturingSources.has(file)) manufacturingSources.set(file, source(file));
      const module = execute(manufacturingSources.get(file), manufacturingRequire);
      if (name === './manufacturing-assessment') module.assessManufacturing = async (user, args, context) => {
        calls.push('manufacturing-assessment'); manufacturingCalls.push({ user, args, signal: context.signal });
        if (options.manufacturingError) throw new Error('OMIT_PRIVATE_MANUFACTURING_DETAILS');
        return { kind: 'synthetic_assessment', privateData: false };
      };
      if (name === './manufacturing-planning') for (const method of ['compareManufacturing', 'planManufacturing']) module[method] = async (user, args, context) => {
        calls.push(method); manufacturingCalls.push({ user, args, signal: context.signal });
        if (options.manufacturingError) throw new Error('OMIT_PRIVATE_MANUFACTURING_DETAILS');
        return { kind: 'synthetic_batch', privateData: false };
      };
      manufacturingModules.set(name, module);
    }
    return manufacturingModules.get(name);
  }
  const validateHistoryArgs = execute(source('app/lib/wallet-history.ts'), name => name === './eve' ? backend : {}).validateWalletHistoryArgs;
  const historyBackend = { runWalletHistory: async (user, args, context) => { validateHistoryArgs(args); historyCalls.push({ user, args, signal: context.signal }); if (options.historyError) throw new Error('OMIT_PRIVATE_HISTORY'); return { characterId: args.characterId, operation: args.operation, synthetic: true }; } };
  let bodyModule;
  const require = name => {
    if (name.endsWith('/blueprint-reconciliation-stream')) return execute(source('app/lib/blueprint-reconciliation-stream.ts'), dependency => {
      if (dependency === './eve') return backend;
      if (dependency === './blueprint-reconciliation') return {
        validateBlueprintReconciliationArgs: input => {
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'characterId') || !Number.isSafeInteger(input.characterId) || input.characterId <= 0) throw new EveError('Choose a connected character.');
          return { characterId: input.characterId };
        },
        readBlueprintReconciliation: async (user, args, context) => {
          calls.push('blueprint-reconciliation'); characterWorkspaceCalls.push({ user, args, signal: context.signal });
          if (options.collectionRead) return options.collectionRead(user, args, context, EveError);
          if (options.collectionError) throw new Error('OMIT_PRIVATE_COLLECTION');
          context.onProgress({ pagesRead: 0, pagesExpected: null, rowsReceived: 0, uniqueRecords: 0, duplicateRecords: 0, pageLimit: 50, rowLimit: 50000 });
          return { characterId: args.characterId, synthetic: true };
        },
      };
      throw new Error('Unexpected collection stream import: ' + dependency);
    });
    if (name.endsWith('/blueprint-collection-stream')) return execute(source('app/lib/blueprint-collection-stream.ts'), dependency => {
      if (dependency === './eve') return backend;
      if (dependency === './blueprint-collection') return {
        validateBlueprintCollectionArgs: input => {
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'characterId') || !Number.isSafeInteger(input.characterId) || input.characterId <= 0) throw new EveError('Choose a connected character.');
          return { characterId: input.characterId };
        },
        readBlueprintCollection: async (user, args, context) => {
          calls.push('blueprint-collection'); characterWorkspaceCalls.push({ user, args, signal: context.signal });
          if (options.collectionRead) return options.collectionRead(user, args, context, EveError);
          if (options.collectionError) throw new Error('OMIT_PRIVATE_COLLECTION');
          context.onProgress({ pagesRead: 0, pagesExpected: null, rowsReceived: 0, uniqueRecords: 0, duplicateRecords: 0, pageLimit: 50, rowLimit: 50000 });
          return { characterId: args.characterId, synthetic: true };
        },
      };
      throw new Error('Unexpected collection stream import: ' + dependency);
    });
    if (name.endsWith('/wallet-history-tools')) return execute(source('app/lib/wallet-history-tools.ts'), dependency => { if (dependency === './eve') return backend; if (dependency === './wallet-history') return historyBackend; throw new Error('Unexpected history import'); });
    if (name.endsWith('/wallet-history')) return historyBackend;
    if (name.endsWith('/manufacturing-tools')) return manufacturingRequire('./manufacturing-tools');
    if (name.endsWith('/eve')) return backend;
    if (name.endsWith('/character-data')) return catalog;
    if (name.endsWith('/corporation-data')) return corporationCatalog;
    if (name.endsWith('/corporation-workspace')) return { readCorporationWorkspace: async (user, args, context) => {
      calls.push('workspace'); workspaceCalls.push({ user, args, signal: context.signal });
      if (options.workspaceError) throw new EveError('Synthetic workspace unavailable.', 502);
      return { view: args.view, data: [] };
    } };
    if (name.endsWith('/manufacturing-workspace')) return { readManufacturingWorkspace: async (user, args, context) => { calls.push('manufacturing-workspace'); manufacturingCalls.push({ user, args, signal: context.signal }); if(options.manufacturingError) throw new Error('OMIT_PRIVATE_MANUFACTURING_DETAILS'); return { operation: args.operation, synthetic: true }; } };
    if (name.endsWith('/overview')) return { readOverview: async (user, args, context) => {
      calls.push('overview'); overviewCalls.push({ user, args, signal: context.signal });
      if (options.overviewError) throw new Error('OMIT_PRIVATE_OVERVIEW');
      if (!options.realOverview) return { characterId: args.characterId, view: args.view, synthetic: true };
      if (!realOverview) {
        const summary = execute(source('app/lib/overview-summary.ts'));
        const module = execute(source('app/lib/overview.ts'), dependency => dependency === './overview-summary' ? summary : backend);
        realOverview = module.createOverviewReader({
          connections: async owner => { overviewFeedCalls.push({ operation: 'connections', user: owner }); return options.overviewConnections ?? [{ characterId: 90000001, scopes: ['esi-wallet.read_character_wallet.v1'] }]; },
          character: async (owner, selected, signal) => {
            overviewFeedCalls.push({ operation: 'character', user: owner, args: selected, signal });
            return options.overviewResponse ? options.overviewResponse(owner, selected, signal) : { ...selected, data: 123.45, retrievedAt: '2026-01-01T00:00:00.000Z', cacheExpires: 'Thu, 01 Jan 2026 00:05:00 GMT', cacheControl: 'private, max-age=300', lastModified: 'Wed, 31 Dec 2025 23:55:00 GMT', pagination: { kind: 'none' }, private_marker: 'OMIT_PRIVATE_OVERVIEW', clientId: 'OMIT_PRIVATE_CONFIGURATION' };
          },
          corporation: async () => { throw new Error('Unexpected corporation overview read'); },
          now: () => Date.parse('2026-01-01T00:00:00.000Z'),
        });
      }
      return realOverview(user, args, context);
    } };
    if (name.endsWith('/character-training-report')) return { readCharacterTrainingReport: async (user, args, context) => { calls.push('training-report'); trainingCalls.push({ user, args, signal: context.signal }); if (options.trainingError) throw new Error('OMIT_PRIVATE_TRAINING'); if (options.trainingOwnerError) throw new EveError('Choose a connected character.', 404); return { characterId: args.characterId, synthetic: true }; } };
    if (name.endsWith('/character-analytics')) return { readCharacterAnalytics: async (user, args, context) => { calls.push('character-analytics'); characterWorkspaceCalls.push({ user, args, signal: context.signal }); if (options.analyticsError) throw new Error('OMIT_PRIVATE_ANALYTICS'); return { characterId: args.characterId, synthetic: true }; } };
    if (name.endsWith('/clone-analytics')) return { readCloneAnalytics: async (user, args, context) => { calls.push('clone-analytics'); characterWorkspaceCalls.push({ user, args, signal: context.signal }); if (options.analyticsError) throw new Error('OMIT_PRIVATE_ANALYTICS'); return { characterId: args.characterId, synthetic: true }; } };
    if (name.endsWith('/wallet-analytics')) return { readWalletAnalytics: async (user, args, context) => { calls.push('wallet-analytics'); characterWorkspaceCalls.push({ user, args, signal: context.signal }); if (options.analyticsError) throw new Error('OMIT_PRIVATE_ANALYTICS'); return { characterId: args.characterId, entity: args.entity, synthetic: true }; } };
    if (name.endsWith('/inventory-analytics')) return { readInventoryAnalytics: async (user, args, context) => { calls.push('inventory-analytics'); characterWorkspaceCalls.push({ user, args, signal: context.signal }); if (options.analyticsError) throw new Error('OMIT_PRIVATE_ANALYTICS'); return { characterId: args.characterId, entity: args.entity, synthetic: true }; } };
    if (name.endsWith('/industry-analytics')) return { readIndustryAnalytics: async (user, args, context) => { calls.push('industry-analytics'); characterWorkspaceCalls.push({ user, args, signal: context.signal }); if (options.analyticsError) throw new Error('OMIT_PRIVATE_ANALYTICS'); return { characterId: args.characterId, entity: args.entity, synthetic: true }; } };
    if (name.endsWith('/order-analytics')) return { readOrderAnalytics: async (user, args, context) => { calls.push('order-analytics'); characterWorkspaceCalls.push({ user, args, signal: context.signal }); if (options.analyticsError) throw new Error('OMIT_PRIVATE_ANALYTICS'); return { characterId: args.characterId, entity: args.entity, synthetic: true }; } };
    if (name.endsWith('/blueprint-analytics')) return { readBlueprintAnalytics: async (user, args, context) => { calls.push('blueprint-analytics'); characterWorkspaceCalls.push({ user, args, signal: context.signal }); if (options.analyticsError) throw new Error('OMIT_PRIVATE_ANALYTICS'); return { characterId: args.characterId, entity: args.entity, synthetic: true }; } };
    if (name.endsWith('/character-workspace')) return { readCharacterWorkspace: async (user, args, context) => {
      calls.push('character-workspace'); characterWorkspaceCalls.push({ user, args, signal: context.signal });
      if (options.characterWorkspaceError) throw new Error('OMIT_PRIVATE_UPSTREAM');
      return { view: args.view, rows: [] };
    } };
    if (name.endsWith('/request-body')) return bodyModule ??= execute(source('app/lib/request-body.ts'));
    throw new Error('Unexpected import');
  };
  return { mcp: execute(mcpCode, require), api: execute(apiCode, require), catalog, calls, workspaceCalls, characterWorkspaceCalls, manufacturingCalls, historyCalls, overviewCalls, overviewFeedCalls, trainingCalls };
}

function request(value, options = {}) {
  return new Request(`${origin}${options.path ?? '/mcp'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'oai-authenticated-user-id': 'synthetic-user', ...options.headers },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
}
const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const tool = (name, args = {}, id = 1) => rpc('tools/call', { name, arguments: args }, id);
async function rpcError(response, code, id = null) {
  const value = await response.json();
  assert.equal(value.jsonrpc, '2.0');
  assert.equal(value.error?.code, code);
  assert.equal(value.id, id);
  assert.equal(value.result, undefined);
}

test('Sites discovery retains existing tools and exposes the optional corporation reader', async () => {
  const { mcp } = harness();
  const discovery = await (await mcp.POST(request(rpc('server/discover')))).json();
  assert.deepEqual(discovery.result.supportedVersions, ['2026-07-28']);
  assert.deepEqual(discovery.result.capabilities, { tools: {} });
  assert.equal(discovery.result.serverInfo.name, 'OptiEVE');
  const listing = await (await mcp.POST(request(rpc('tools/list')))).json();
  assert.deepEqual(listing.result.tools.map(item => item.name), ['connection_status', 'character_overview', 'character_training_report', 'read_character_data', 'read_corporation_data', 'read_private_data', 'resolve_names', 'public_market', ...manufacturingNames, ...historyNames]);
  assert(listing.result.tools.filter(item => !historyNames.includes(item.name)).every(item => item.annotations.readOnlyHint && !item.annotations.destructiveHint));
});

test('character overview exposes one strict personal selector with read-only annotations', async () => {
  const h = harness(), listing = await (await h.mcp.POST(request(rpc('tools/list')))).json();
  const overview = listing.result.tools.find(item => item.name === 'character_overview');
  assert.deepEqual(overview.inputSchema, { type: 'object', required: ['characterId'], properties: { characterId: { type: 'integer', minimum: 1 } }, additionalProperties: false });
  assert.deepEqual(overview.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  assert.equal(h.calls.length, 0);
});

test('character overview binds the gateway owner, fixed personal view and request cancellation', async () => {
  const h = harness(), input = request(tool('character_overview', { characterId: 90000001 }));
  const response = await (await h.mcp.POST(input)).json();
  assert.equal(response.result.isError, undefined); assert.deepEqual(h.calls, ['overview']);
  assert.equal(h.overviewCalls[0].user, 'synthetic-user');
  assert.deepEqual(JSON.parse(JSON.stringify(h.overviewCalls[0].args)), { characterId: 90000001, view: 'personal' });
  assert.equal(h.overviewCalls[0].signal, input.signal);
  assert.deepEqual(JSON.parse(response.result.content[0].text), { characterId: 90000001, view: 'personal', synthetic: true });
});

test('character overview rejects missing identity and notifications without executing a reader', async () => {
  const h = harness();
  const denied = await (await h.mcp.POST(request(tool('character_overview', { characterId: 90000001 }), { headers: { 'oai-authenticated-user-id': '' } }))).json();
  assert.equal(denied.result.isError, true);
  const notification = await h.mcp.POST(request({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'character_overview', arguments: { characterId: 90000001 } } }));
  assert.equal(notification.status, 202); assert.equal(await notification.text(), '');
  assert.equal(h.calls.length, 0); assert.equal(h.overviewCalls.length, 0);
});

test('character overview refuses invalid IDs and alternate ownership or feed selectors before reads', async () => {
  const h = harness();
  for (const args of [null, {}, { characterId: 0 }, { characterId: -1 }, { characterId: 1.5 }, { characterId: Number.MAX_SAFE_INTEGER + 1 }, { characterId: '90000001' },
    { characterId: 90000001, view: 'corporation' }, { characterId: 90000001, corporationId: 98000001 }, { characterId: 90000001, userId: 'another-user' },
    { characterId: 90000001, dataset: 'mail' }, { characterId: 90000001, url: 'https://attacker.example' }, { characterId: 90000001, parameters: {} }, { characterId: 90000001, page: 2 },
  ]) await rpcError(await h.mcp.POST(request(tool('character_overview', args))), -32602, 1);
  assert.equal(h.calls.length, 0); assert.equal(h.overviewCalls.length, 0);
});

test('character overview unexpected failures never expose private exception details', async () => {
  const h = harness({ overviewError: true }), response = await (await h.mcp.POST(request(tool('character_overview', { characterId: 90000001 })))).json();
  assert.equal(response.result.isError, true); assert.equal(response.result.content[0].text, 'Request failed.');
  assert(!JSON.stringify(response).includes('OMIT_PRIVATE'));
});

test('character overview MCP dispatch reuses the real six-section service and skips ungranted feeds', async () => {
  const h = harness({ realOverview: true }), response = await (await h.mcp.POST(request(tool('character_overview', { characterId: 90000001 })))).json();
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.view, 'personal'); assert.equal(result.characterId, 90000001); assert.equal(result.corporationId, undefined);
  assert.deepEqual(result.sections.map(section => section.id), ['wallet', 'training', 'orders', 'industry', 'contracts', 'freelance']);
  assert.deepEqual(result.sections[0].metrics, [{ label: 'Wallet balance', value: 123.45, unit: 'ISK' }]);
  assert.equal(result.sections[0].coverage, 'complete'); assert.equal(result.sections[0].retrievedAt, '2026-01-01T00:00:00.000Z'); assert.equal(result.sections[0].cacheExpires, '2026-01-01T00:05:00.000Z');
  assert(result.sections.slice(1).every(section => section.status === 'needs_permission' && section.metrics.length === 0 && section.coverage === 'unavailable'));
  assert.deepEqual(h.overviewFeedCalls.map(call => call.operation), ['connections', 'character']);
  assert.equal(h.overviewFeedCalls[1].user, 'synthetic-user'); assert.equal(h.overviewFeedCalls[1].args.dataset, 'wallet_balance');
  assert(!JSON.stringify(result).includes('OMIT_PRIVATE')); assert(!JSON.stringify(result).includes('clientId')); assert(!Object.hasOwn(result, 'data'));
});

test('character overview real ownership check rejects another character without provider reads', async () => {
  const h = harness({ realOverview: true }), response = await (await h.mcp.POST(request(tool('character_overview', { characterId: 90000002 })))).json();
  assert.equal(response.result.isError, true); assert.match(response.result.content[0].text, /connected/);
  assert.deepEqual(h.overviewFeedCalls.map(call => call.operation), ['connections']);
});

test('character overview real projection rejects malformed data without plausible zero metrics', async () => {
  const h = harness({ realOverview: true, overviewResponse: async (_user, args) => ({ ...args, data: 'OMIT_PRIVATE_PROVIDER', retrievedAt: '2026-01-01T00:00:00.000Z', pagination: { kind: 'none' } }) });
  const response = await (await h.mcp.POST(request(tool('character_overview', { characterId: 90000001 })))).json(), result = JSON.parse(response.result.content[0].text);
  assert.equal(result.sections[0].status, 'error'); assert.equal(result.sections[0].metrics.length, 0); assert.equal(result.sections[0].coverage, 'unavailable');
  assert(!JSON.stringify(response).includes('OMIT_PRIVATE'));
});

test('corporation tool validates its dataset options before calling any reader', async () => {
  const { mcp, calls } = harness();
  for (const args of [
    { characterId: 12345, dataset: '__proto__' },
    { characterId: 12345, dataset: 'contributors' },
    { characterId: 12345, dataset: 'projects', parameters: { page: 1 } },
    { characterId: 12345, dataset: 'projects', parameters: { after: '0', before: '0' } },
    { characterId: 12345, dataset: 'industry_jobs', parameters: { includeCompleted: null } },
    { characterId: 12345, dataset: 'contracts', corporationId: 987 },
    { characterId: 12345, dataset: 'wallet_balances', parameters: { page: 1 } },
    { characterId: 12345, dataset: 'order_history', parameters: { url: 'https://attacker.example' } },
    { characterId: 12345, dataset: 'blueprints', parameters: { page: '1' } },
    { characterId: 12345, dataset: 'facilities', parameters: { page: 1 } },
    { characterId: 12345, dataset: 'structures', parameters: { page: 501 } },
    { characterId: 12345, dataset: 'structures', parameters: { corporationId: 987 } },
    { characterId: 12345, dataset: 'assets', parameters: { page: 501 } },
    { characterId: 12345, dataset: 'asset_names' },
    { characterId: 12345, dataset: 'asset_names', parameters: { itemIds: [1001, 1001] } },
    { characterId: 12345, dataset: 'asset_names', parameters: { itemIds: [], page: 1 } },
    { characterId: 12345, dataset: 'asset_locations', parameters: { itemIds: ['1001'] } },
    { characterId: 12345, dataset: 'asset_locations', parameters: { itemIds: [1001], corporationId: 987 } },
    { characterId: 12345, dataset: 'contract_items' },
    { characterId: 12345, dataset: 'contract_bids', parameters: { contractId: '10' } },
    { characterId: 12345, dataset: 'project', parameters: { projectId: '../other' } },
    { characterId: 12345, dataset: 'project_contribution', parameters: { projectId: '00000000-0000-0000-0000-000000000001', characterId: 54321 } },
    { characterId: 12345, dataset: 'project_contribution', parameters: { projectId: '00000000-0000-0000-0000-000000000001', corporationId: 987 } },
  ]) await rpcError(await mcp.POST(request(tool('read_corporation_data', args))), -32602, 1);
  assert.equal(calls.length, 0);
  const good = await mcp.POST(request(tool('read_corporation_data', { characterId: 12345, dataset: 'projects', parameters: { after: '0', limit: 100 } })));
  assert.equal((await good.json()).result.isError, undefined);
  assert.deepEqual(calls, ['corporation']);
});

test('corporation tool exposes required detail parameters and accepts fixed read-only endpoints', async () => {
  const { mcp, calls } = harness();
  const listing = await (await mcp.POST(request(rpc('tools/list')))).json();
  const schema = listing.result.tools.find(item => item.name === 'read_corporation_data').inputSchema;
  assert.equal(schema.properties.parameters.additionalProperties, false);
  assert.equal(schema.properties.parameters.properties.projectId.format, 'uuid');
  assert.equal(schema.properties.parameters.properties.contractId.minimum, 1);
  assert.equal(schema.properties.parameters.properties.itemIds.maxItems, 1000);
  assert.equal(schema.properties.parameters.properties.itemIds.uniqueItems, true);
  for (const [dataset, parameters] of [
    ['wallet_balances', undefined], ['order_history', { page: 2 }],
    ['contract_items', { contractId: 10 }], ['contract_bids', { contractId: 10, page: 2 }],
    ['project', { projectId: '00000000-0000-0000-0000-000000000001' }],
    ['project_contribution', { projectId: '00000000-0000-0000-0000-000000000001' }],
    ['blueprints', { page: 2 }], ['facilities', undefined], ['structures', { page: 2 }],
    ['assets', { page: 2 }], ['asset_names', { itemIds: [1001] }], ['asset_locations', { itemIds: [1001] }],
  ]) {
    const response = await mcp.POST(request(tool('read_corporation_data', { characterId: 12345, dataset, parameters })));
    assert.equal((await response.json()).result.isError, undefined);
  }
  assert.deepEqual(calls, Array(12).fill('corporation'));
});

test('valid legacy initialization negotiates the supported legacy version', async () => {
  const { mcp } = harness();
  const response = await mcp.POST(request(rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Synthetic client', version: '1' } })));
  const result = (await response.json()).result;
  assert.equal(result.protocolVersion, '2025-03-26');
  for (const instruction of ['manufacturing_catalog_status', 'assess_manufacturing', 'corporation wallet', 'opportunity cost', 'missing does not mean zero', 'No game writes']) assert(result.instructions.includes(instruction));
});

const manufacturingPlan = () => ({ runs: 2, materialEfficiency: 0, facilityMaterialMultiplier: '1', blueprint: { kind: 'unknown', accessConfirmed: false }, facilityAccessConfirmed: false, sale: { salesTaxRate: null }, job: { quotedInstallationISK: null }, overhead: { haulingISK: null, blueprintCashISK: null, blueprintOpportunityISK: null, otherCashISK: null, otherOpportunityISK: null } });
const assessmentArgs = () => ({ characterId: 90000001, resourceEntity: 'character', blueprintTypeId: manufacturingData.recipes[0].blueprintTypeId, blueprintSource: 'prospective', marketRegionId: 10000001, marketStationId: 60000001, manufacturingSystemId: 30000001, useOwnedMaterials: false, otherOwnedOrdersReviewed: false, plan: manufacturingPlan() });
const batchArgs = () => { const { blueprintTypeId, blueprintSource, plan, ...context } = assessmentArgs(); return { context, jobs: [{ key: 'a', blueprintTypeId, blueprintSource, plan }] }; };
const manufacturingArguments = () => ({
  manufacturing_compare: batchArgs(), manufacturing_plan: batchArgs(),
  manufacturing_item_search: { query: 'Rifter', limit: 2 },
  manufacturing_recipe: { blueprintTypeId: manufacturingData.recipes[0].blueprintTypeId },
  manufacturing_catalog_status: {},
  manufacturing_requirements: { blueprintTypeId: manufacturingData.recipes[0].blueprintTypeId, runs: 2, materialEfficiency: 0, facilityMaterialMultiplier: '1' },
  manufacturing_market_history: { regionId: 10000001, typeId: 34, days: 7 },
  manufacturing_industry_costs: { solarSystemId: 30000001, typeIds: [34] },
  manufacturing_station_quote: { regionId: 10000001, typeId: 34, stationId: 60000001, quantity: 2, side: 'buy_materials', excludeOrderIds: [], ownOrdersComplete: false, maxPages: 1 },
  assess_manufacturing: assessmentArgs(),
});

test('all manufacturing tools require authenticated identity before private or public reads', async () => {
  const { mcp, calls, manufacturingCalls } = harness();
  for (const [name, args] of Object.entries(manufacturingArguments())) {
    const incoming = request(tool(name, args)); incoming.headers.delete('oai-authenticated-user-id');
    const response = await mcp.POST(incoming), value = await response.json();
    assert.equal(value.result?.isError, true, name);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.match(value.result.content[0].text, /Sign in/);
  }
  assert.equal(calls.length, 0); assert.equal(manufacturingCalls.length, 0);
});

test('manufacturing discovery uses actual bounded schemas and no write annotations', async () => {
  const { mcp } = harness();
  const listed = (await (await mcp.POST(request(rpc('tools/list')))).json()).result.tools.filter(tool => manufacturingNames.includes(tool.name));
  assert.equal(listed.length, 10);
  for (const tool of listed) { assert.equal(tool.inputSchema.additionalProperties, false); assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.annotations.destructiveHint, false); }
  const schemas = Object.fromEntries(listed.map(tool => [tool.name, tool.inputSchema]));
  assert.equal(schemas.manufacturing_item_search.properties.limit.maximum, 50);
  assert.equal(schemas.manufacturing_station_quote.properties.excludeOrderIds.maxItems, 2000);
  assert.equal(schemas.assess_manufacturing.properties.maxPrivatePages.maximum, 50);
  assert.equal(schemas.assess_manufacturing.properties.maxMarketPages.maximum, 4);
  assert.deepEqual(schemas.assess_manufacturing.properties.plan.properties.sale.properties.salesTaxRate.type, ['string', 'null']);
  assert.deepEqual(schemas.manufacturing_requirements.properties.facilityMaterialMultiplier, schemas.assess_manufacturing.properties.plan.properties.facilityMaterialMultiplier);
});

test('authenticated catalog lookup and exact requirements run actual source without external reads', async () => {
  const { mcp, calls } = harness(), recipe = manufacturingData.recipes[0];
  async function invoke(name, args) { const value = await (await mcp.POST(request(tool(name, args)))).json(); assert.equal(value.error, undefined); assert.equal(value.result.isError, undefined); return JSON.parse(value.result.content[0].text); }
  const found = await invoke('manufacturing_item_search', { query: recipe.products[0].name, limit: 5, manufacturableOnly: true });
  assert(found.items.some(item => item.typeId === recipe.products[0].typeId));
  const lookup = await invoke('manufacturing_recipe', { blueprintTypeId: recipe.blueprintTypeId });
  assert.deepEqual(lookup.recipes[0], recipe); assert.match(lookup.provenance.archiveSha256, /^[a-f0-9]{64}$/);
  const result = await invoke('manufacturing_requirements', manufacturingArguments().manufacturing_requirements);
  assert.equal(result.requirements.product.quantity, recipe.products[0].quantity * 2);
  assert.deepEqual(result.requirements.materials.map(row => row.requiredQuantity), recipe.materials.map(row => row.quantity * 2));
  assert.equal(calls.length, 0);
});

test('assessment nullable costs preserve unknowns and forward only authenticated identity and cancellation', async () => {
  const { mcp, manufacturingCalls } = harness(), args = assessmentArgs(), incoming = request(tool('assess_manufacturing', args));
  const result = await (await mcp.POST(incoming)).json(); assert.equal(result.result.isError, undefined);
  assert.equal(manufacturingCalls.length, 1); assert.equal(manufacturingCalls[0].user, 'synthetic-user');
  assert.equal(manufacturingCalls[0].signal, incoming.signal); assert.deepEqual(JSON.parse(JSON.stringify(manufacturingCalls[0].args)), args);
  assert.equal(manufacturingCalls[0].args.plan.sale.salesTaxRate, null);
});

test('assessment failures never expose upstream private details through MCP', async () => {
  const { mcp } = harness({ manufacturingError: true });
  const response = await mcp.POST(request(tool('assess_manufacturing', assessmentArgs()))), body = await response.text();
  assert(!body.includes('OMIT_PRIVATE_MANUFACTURING_DETAILS')); assert.equal(JSON.parse(body).result.isError, true);
});

test('comparison and plan MCP dispatch preserves bounded selections and cancellation, never upstream failures', async () => {
  for (const name of ['manufacturing_compare', 'manufacturing_plan']) {
    const h = harness(), args = batchArgs(), incoming = request(tool(name, args));
    const value = await (await h.mcp.POST(incoming)).json(); assert.equal(value.result.isError, undefined);
    assert.equal(h.manufacturingCalls[0].user, 'synthetic-user'); assert.equal(h.manufacturingCalls[0].signal, incoming.signal);
    assert.deepEqual(JSON.parse(JSON.stringify(h.manufacturingCalls[0].args)), args);
    for (const bad of [{ ...args, walletISK: '999' }, { ...args, jobs: [] }, { ...args, jobs: Array.from({ length: 6 }, (_, i) => ({ ...args.jobs[0], key: `job${i}` })) }, { ...args, context: { ...args.context, secret: 'synthetic' } }]) await rpcError(await h.mcp.POST(request(tool(name, bad))), -32602, 1);
    const failed = await harness({ manufacturingError: true }).mcp.POST(request(tool(name, args))), text = await failed.text();
    assert(!text.includes('OMIT_PRIVATE_MANUFACTURING_DETAILS')); assert.equal(JSON.parse(text).result.isError, true);
  }
});

test('manufacturing API preserves owner and signal; expanded body budget is bounded and route-specific', async () => {
  const h = harness(), body = { operation: 'plan', input: batchArgs() }, incoming = request(body, { path: '/api/eve/manufacturing' });
  const response = await h.api.POST(incoming); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(h.manufacturingCalls[0].user, 'synthetic-user'); assert.equal(h.manufacturingCalls[0].signal, incoming.signal);
  assert.deepEqual(JSON.parse(JSON.stringify(h.manufacturingCalls[0].args)), body);
  const padded = JSON.stringify(body) + ' '.repeat(5000);
  assert.equal((await h.api.POST(request(padded, { path: '/api/eve/manufacturing' }))).status, 200);
  assert.equal((await h.api.POST(request(padded, { path: '/api/eve/config' }))).status, 413);
  assert.equal((await h.api.POST(request(' '.repeat(65537), { path: '/api/eve/manufacturing' }))).status, 413);
  for (const [headers, status] of [[{ 'oai-authenticated-user-id': '' }, 401], [{ origin: 'https://wrong.example' }, 403], [{ 'content-type': 'text/plain' }, 415]]) {
    const denied = harness(); const res = await denied.api.POST(request(padded, { path: '/api/eve/manufacturing', headers })); assert.equal(res.status, status); assert.equal(denied.calls.length, 0);
  }
  const failed = await harness({ manufacturingError: true }).api.POST(request(body, { path: '/api/eve/manufacturing' })); assert.equal(failed.status, 500); assert(!(await failed.text()).includes('OMIT_PRIVATE_MANUFACTURING_DETAILS'));
});

test('manufacturing schema and semantic validation reject unsafe or ambiguous arguments', async () => {
  const { mcp, calls, manufacturingCalls } = harness(), defaults = manufacturingArguments();
  const invalid = [
    ['manufacturing_item_search', { query: 'a' }], ['manufacturing_item_search', { query: 'Rifter', limit: 51 }],
    ['manufacturing_item_search', { query: 'Rifter', offset: -1 }], ['manufacturing_item_search', { query: 'Rifter', apiKey: 'synthetic' }],
    ['manufacturing_item_search', { query: 'Ri\u202efter' }],
    ['manufacturing_recipe', {}], ['manufacturing_recipe', { blueprintTypeId: 1, productTypeId: 2 }], ['manufacturing_recipe', { productTypeId: null }],
    ['manufacturing_catalog_status', { url: 'https://attacker.example' }],
    ['manufacturing_requirements', { ...defaults.manufacturing_requirements, facilityMaterialMultiplier: '0.1234567890123456789' }],
    ['manufacturing_requirements', { ...defaults.manufacturing_requirements, facilityMaterialMultiplier: '0' }],
    ['manufacturing_requirements', { ...defaults.manufacturing_requirements, facilityMaterialMultiplier: null }],
    ['manufacturing_market_history', { ...defaults.manufacturing_market_history, days: 91 }],
    ['manufacturing_industry_costs', { solarSystemId: 1, typeIds: [34, 34] }],
    ['manufacturing_station_quote', { ...defaults.manufacturing_station_quote, ownOrdersComplete: null }],
    ['manufacturing_station_quote', { ...defaults.manufacturing_station_quote, excludeOrderIds: [1, 1] }],
    ['assess_manufacturing', { ...assessmentArgs(), walletISK: '999' }],
    ['assess_manufacturing', { ...assessmentArgs(), maxPrivatePages: 51 }],
    ['assess_manufacturing', { ...assessmentArgs(), plan: { ...manufacturingPlan(), sale: { salesTaxRate: 0.1 } } }],
    ['assess_manufacturing', { ...assessmentArgs(), plan: { ...manufacturingPlan(), job: null } }],
    ['assess_manufacturing', { ...assessmentArgs(), plan: { ...manufacturingPlan(), blueprint: { kind: 'original', accessConfirmed: null } } }],
  ];
  for (const [name, args] of invalid) await rpcError(await mcp.POST(request(tool(name, args))), -32602, 1);
  assert.equal(calls.length, 0); assert.equal(manufacturingCalls.length, 0);
});

for (const [name, value] of [
  ['missing version', { id: 1, method: 'tools/list' }],
  ['wrong version', { jsonrpc: '1.0', id: 1, method: 'tools/list' }],
  ['missing method', { jsonrpc: '2.0', id: 1 }],
  ['nonstring method', { jsonrpc: '2.0', id: 1, method: 3 }],
  ['object ID', rpc('ping', undefined, {})],
  ['null ID', rpc('ping', undefined, null)],
  ['fractional ID', rpc('ping', undefined, 1.5)],
  ['unsafe integer ID', rpc('ping', undefined, Number.MAX_SAFE_INTEGER + 1)],
  ['null request', null],
]) test(`rejects an invalid JSON-RPC envelope: ${name}`, async () => {
  const { mcp, calls } = harness();
  await rpcError(await mcp.POST(request(value)), -32600);
  assert.equal(calls.length, 0);
});

for (const params of [null, [], 'unexpected', 7]) test(`rejects nonobject method parameters: ${JSON.stringify(params)}`, async () => {
  const { mcp } = harness();
  await rpcError(await mcp.POST(request(rpc('tools/list', params))), -32602, 1);
});

test('rejects malformed metadata and unsupported tool-list cursors', async () => {
  const { mcp } = harness();
  for (const params of [{ _meta: null }, { _meta: [] }, { cursor: 1 }, { cursor: 'unknown-cursor' }]) {
    await rpcError(await mcp.POST(request(rpc('tools/list', params))), -32602, 1);
  }
});

test('preserves valid string, zero and negative integer request IDs', async () => {
  const { mcp } = harness();
  for (const id of ['synthetic-id', 0, -1]) {
    const result = await (await mcp.POST(request(rpc('ping', undefined, id)))).json();
    assert.equal(result.id, id);
    assert.deepEqual(result.result, {});
  }
});

for (const method of ['ping', 'notifications/initialized', 'notifications/cancelled', 'unknown', 'tools/call']) test(`does not respond to or execute a notification: ${method}`, async () => {
  const { mcp, calls } = harness();
  const response = await mcp.POST(request({ jsonrpc: '2.0', method, params: { name: 'connection_status' } }));
  assert.equal(response.status, 202);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('vary'), 'oai-authenticated-user-id, Origin');
  assert.equal(calls.length, 0);
});

test('a notification method sent as a request receives a protocol error', async () => {
  const { mcp } = harness();
  await rpcError(await mcp.POST(request(rpc('notifications/initialized'))), -32601, 1);
});

test('legacy batches reply to requests and invalid members, omitting notifications', async () => {
  const { mcp, calls } = harness();
  const response = await mcp.POST(request([
    rpc('ping', undefined, 'first'),
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    7,
    tool('connection_status', {}, 2),
  ]));
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.length, 3);
  assert.deepEqual(value[0], { jsonrpc: '2.0', id: 'first', result: {} });
  assert.equal(value[1].error.code, -32600);
  assert.equal(value[1].id, null);
  assert.equal(value[2].id, 2);
  assert.deepEqual(calls, ['status']);
});

test('all-notification batches return an empty 202, and empty batches are invalid', async () => {
  const { mcp } = harness();
  const response = await mcp.POST(request([{ jsonrpc: '2.0', method: 'notifications/initialized' }]));
  assert.equal(response.status, 202);
  assert.equal(await response.text(), '');
  await rpcError(await mcp.POST(request([])), -32600);
});

test('batch item limits reject the whole batch before any handler runs', async () => {
  const { mcp, calls } = harness();
  const allowed = await mcp.POST(request(Array.from({ length: 8 }, (_, index) => tool('connection_status', {}, index))));
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).length, 8);
  assert.equal(calls.length, 8);
  calls.length = 0;
  const denied = await mcp.POST(request(Array.from({ length: 9 }, (_, index) => tool('connection_status', {}, `request-${index}`))));
  assert.equal(denied.status, 400);
  const errors = await denied.json();
  assert.deepEqual(errors.map(item => item.id), Array.from({ length: 9 }, (_, index) => `request-${index}`));
  assert(errors.every(item => item.error.code === -32600));
  assert.equal(calls.length, 0);
});

test('batch limit errors preserve malformed envelopes and omit valid notifications', async () => {
  const { mcp, calls } = harness();
  const input = [tool('connection_status', {}, 'request'), null, rpc('ping', undefined, null), ...Array.from({ length: 6 }, () => ({ jsonrpc: '2.0', method: 'notifications/initialized' }))];
  const response = await mcp.POST(request(input));
  const errors = await response.json();
  assert.equal(response.status, 400);
  assert.deepEqual(errors.map(item => item.id), ['request', null, null]);
  assert.equal(errors[1].error.message, 'Invalid request');
  assert.equal(errors[2].error.message, 'Invalid request ID');
  assert.equal(calls.length, 0);
  const notifications = await mcp.POST(request(Array.from({ length: 9 }, () => ({ jsonrpc: '2.0', method: 'notifications/initialized' }))));
  assert.equal(notifications.status, 202);
  assert.equal(await notifications.text(), '');
});

test('batch response budget stops remaining handlers and identifies unfinished requests', async () => {
  const { mcp, calls } = harness({ statusResult: { synthetic: 'x'.repeat(2 * 1024 * 1024) } });
  const response = await mcp.POST(request([tool('connection_status', {}, 'first'), tool('connection_status', {}, 'second'), { jsonrpc: '2.0', method: 'notifications/initialized' }, tool('connection_status', {}, 'third')]));
  const text = await response.text(), values = JSON.parse(text);
  assert.equal(response.status, 200);
  assert(Buffer.byteLength(text) <= 4 * 1024 * 1024);
  assert.deepEqual(calls, ['status', 'status']);
  assert.deepEqual(values.map(item => item.id), ['first', 'second', 'third']);
  assert.equal(values[0].result.content[0].type, 'text');
  assert(values.slice(1).every(item => item.error.code === -32603));
  assert(!JSON.stringify(values.slice(1)).includes('xxxxxxxx'));
});

test('an oversized first batch result is discarded without running later handlers', async () => {
  const { mcp, calls } = harness({ statusResult: { synthetic: 'x'.repeat(4 * 1024 * 1024) } });
  const response = await mcp.POST(request([tool('connection_status', {}, 0), null, tool('connection_status', {}, 2), { jsonrpc: '2.0', method: 'notifications/initialized' }]));
  const text = await response.text(), values = JSON.parse(text);
  assert(Buffer.byteLength(text) < 2048);
  assert.deepEqual(calls, ['status']);
  assert.deepEqual(values.map(item => item.id), [0, null, 2]);
  assert.deepEqual(values.map(item => item.error.code), [-32603, -32600, -32603]);
});

test('batch response accounting measures UTF-8 bytes and reserves room for error IDs', async () => {
  const { mcp, calls } = harness({ statusResult: { synthetic: '🙂'.repeat(600000) } });
  const response = await mcp.POST(request([tool('connection_status', {}, 1), tool('connection_status', {}, 2), tool('connection_status', {}, 3)]));
  const text = await response.text(), values = JSON.parse(text);
  assert(Buffer.byteLength(text) <= 4 * 1024 * 1024);
  assert.deepEqual(calls, ['status', 'status']);
  assert.equal(values[0].result.content[0].type, 'text');
  assert(values.slice(1).every(item => item.error.code === -32603));

  const reserved = harness({ statusResult: { synthetic: 'x'.repeat(4 * 1024 * 1024 - 200) } });
  const longId = 'synthetic-id-'.repeat(600);
  const limited = await reserved.mcp.POST(request([tool('connection_status', {}, 1), tool('connection_status', {}, longId)]));
  const limitedText = await limited.text(), limitedValues = JSON.parse(limitedText);
  assert(Buffer.byteLength(limitedText) <= 4 * 1024 * 1024);
  assert.deepEqual(reserved.calls, ['status']);
  assert.deepEqual(limitedValues.map(item => item.id), [1, longId]);
  assert(limitedValues.every(item => item.error.code === -32603));
});

test('single-call responses retain their existing behavior outside the batch budget', async () => {
  const { mcp, calls } = harness({ statusResult: { synthetic: 'x'.repeat(4 * 1024 * 1024) } });
  const response = await mcp.POST(request(tool('connection_status')));
  const value = await response.json();
  assert.equal(response.status, 200);
  assert.equal(value.result.content[0].type, 'text');
  assert.deepEqual(calls, ['status']);
});

test('initialization is rejected inside a batch', async () => {
  const { mcp } = harness();
  const response = await mcp.POST(request([rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Synthetic', version: '1' } })]));
  const value = await response.json();
  assert.equal(value[0].error.code, -32600);
});

for (const params of [undefined, {}, { protocolVersion: '2025-03-26', capabilities: [], clientInfo: {} }]) test('initialization requires its protocol parameters', async () => {
  const { mcp } = harness();
  await rpcError(await mcp.POST(request(rpc('initialize', params))), -32602, 1);
});

test('unknown methods and tools use their separate protocol error codes', async () => {
  const { mcp, calls } = harness();
  await rpcError(await mcp.POST(request(rpc('unknown'))), -32601, 1);
  await rpcError(await mcp.POST(request(tool('unknown'))), -32602, 1);
  assert.equal(calls.length, 0);
});

for (const [name, args] of [
  ['connection_status', { unexpected: true }],
  ['connection_status', null],
  ['resolve_names', { ids: [1], unexpected: true }],
  ['resolve_names', { ids: [true] }],
  ['resolve_names', { ids: [] }],
  ['resolve_names', { ids: Array(201).fill(1) }],
  ['public_market', { regionId: 1, typeId: 1, side: 'invalid' }],
  ['public_market', { regionId: 1, typeId: 1, page: 501 }],
  ['public_market', { regionId: 1, typeId: 1, unexpected: true }],
  ['read_private_data', { characterId: 1, entity: 'character', dataset: 'wallet_transactions', fromId: true }],
  ['read_private_data', { characterId: 1, entity: 'character', dataset: 'assets', unexpected: true }],
  ['read_character_data', { characterId: 1, dataset: 'skills', parameters: null }],
  ['read_character_data', { characterId: 1, dataset: 'skills', parameters: { page: 1 } }],
  ['read_character_data', { characterId: 1, dataset: 'planet' }],
]) test(`rejects invalid ${name} arguments before any operation`, async () => {
  const { mcp, calls } = harness();
  await rpcError(await mcp.POST(request(tool(name, args))), -32602, 1);
  assert.equal(calls.length, 0);
});

test('valid tools still work and private operations still require authentication', async () => {
  const { mcp, calls } = harness();
  for (const value of [tool('connection_status'), tool('read_character_data', { characterId: 1, dataset: 'skills' }), tool('read_private_data', { characterId: 1, entity: 'character', dataset: 'assets' }), tool('resolve_names', { ids: [1] }), tool('public_market', { regionId: 1, typeId: 1 })]) {
    const result = await (await mcp.POST(request(value))).json();
    assert.equal(result.result.isError, undefined);
    assert.equal(result.result.content[0].type, 'text');
  }
  assert.deepEqual(calls, ['status', 'character', 'legacy', 'public', 'public']);
  const unauthenticated = request(tool('connection_status'));
  unauthenticated.headers.delete('oai-authenticated-user-id');
  const denied = await (await mcp.POST(unauthenticated)).json();
  assert.equal(denied.result.isError, true);
  assert.equal(calls.length, 5);
});

test('the catalog rejects explicit null parameters while accepting omission', () => {
  const { catalog } = harness();
  assert.throws(() => catalog.buildCharacterRequest({ characterId: 1, dataset: 'skills', parameters: null }), /parameters must be an object/);
  assert.equal(catalog.buildCharacterRequest({ characterId: 1, dataset: 'skills' }).path, '/characters/1/skills');
});

test('MCP and API request limits count UTF-8 bytes rather than characters', async () => {
  const { mcp, api, calls } = harness();
  const oversizedMcp = rpc('tools/list', { _meta: { note: 'é'.repeat(17000) } });
  assert.equal((await mcp.POST(request(oversizedMcp))).status, 413);
  const oversizedApi = { clientId: 'é'.repeat(2200) };
  assert.equal((await api.POST(request(oversizedApi, { path: '/api/eve/config' }))).status, 413);
  assert.equal(calls.length, 0);
});

test('API authentication, origin and content-type checks precede parsing and drain rejected bodies', async () => {
  for (const path of ['/api/eve/config', '/api/eve/corporation-workspace', '/api/eve/character-workspace']) {
  for (const [headers, status] of [
    [{ 'oai-authenticated-user-id': '' }, 401],
    [{ origin: 'https://invalid.example' }, 403],
    [{ 'content-type': 'text/plain' }, 415],
  ]) {
    const { api, calls } = harness();
    let pulled = 0, cancelled = false;
    const stream = new ReadableStream({
      pull(controller) { if (pulled++ < 4) controller.enqueue(new Uint8Array(1024)); else controller.close(); },
      cancel() { cancelled = true; },
    });
    const incoming = new Request(`${origin}${path}`, { method: 'POST', duplex: 'half', headers: { origin, 'content-type': 'application/json', 'oai-authenticated-user-id': 'synthetic-user', ...headers }, body: stream });
    const response = await api.POST(incoming);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(pulled, 5);
    assert.equal(cancelled, false);
    assert.equal(calls.length, 0);
  }
  }
});

test('corporation workspace API dispatch preserves the signed-in owner and request cancellation', async () => {
  const { api, calls, workspaceCalls } = harness();
  const body = { characterId: 12345, view: 'wallets' };
  const incoming = request(body, { path: '/api/eve/corporation-workspace' });
  const response = await api.POST(incoming);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('vary'), 'oai-authenticated-user-id, Cookie');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await response.json(), { view: 'wallets', data: [] });
  assert.deepEqual(calls, ['workspace']);
  assert.equal(workspaceCalls[0].user, 'synthetic-user');
  assert.equal(JSON.stringify(workspaceCalls[0].args), JSON.stringify(body));
  assert.equal(workspaceCalls[0].signal, incoming.signal);
});

test('corporation workspace API rejects malformed or oversized input before dispatch and never caches errors', async () => {
  const { api, calls } = harness();
  for (const [body, status] of [['{', 400], ['null', 400], ['[]', 400], [{ note: 'é'.repeat(2200) }, 413]]) {
    const response = await api.POST(request(body, { path: '/api/eve/corporation-workspace' }));
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
  assert.equal(calls.length, 0);
  const failing = harness({ workspaceError: true });
  const response = await failing.api.POST(request({ characterId: 12345, view: 'wallets' }, { path: '/api/eve/corporation-workspace' }));
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), { error: 'Synthetic workspace unavailable.' });
});

test('character workspace API dispatch preserves owner, exact selection, cancellation and private caching', async () => {
  for (const view of ['faction_warfare', 'standings', 'loyalty_points', 'blueprints', 'research', 'planets', 'mining']) {
    const { api, calls, characterWorkspaceCalls } = harness();
    const body = { characterId: 12345, view }, incoming = request(body, { path: '/api/eve/character-workspace' });
    const response = await api.POST(incoming);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('vary'), 'oai-authenticated-user-id, Cookie');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(await response.json(), { view, rows: [] });
    assert.deepEqual(calls, ['character-workspace']);
    assert.equal(characterWorkspaceCalls[0].user, 'synthetic-user');
    assert.equal(JSON.stringify(characterWorkspaceCalls[0].args), JSON.stringify(body));
    assert.equal(characterWorkspaceCalls[0].signal, incoming.signal);
  }
});

test('industry name selection stays inside the protected character workspace dispatch', async () => {
  for (const view of ['blueprints', 'research', 'planets', 'mining']) {
    const { api, calls, characterWorkspaceCalls } = harness();
    const body = { characterId: 12345, view, resolveNames: true };
    const incoming = request(body, { path: '/api/eve/character-workspace' });
    const response = await api.POST(incoming);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(calls, ['character-workspace']);
    assert.equal(JSON.stringify(characterWorkspaceCalls[0].args), JSON.stringify(body));
    assert.equal(characterWorkspaceCalls[0].signal, incoming.signal);
  }
});

test('character reputation API rejects malformed input before dispatch and hides unexpected errors', async () => {
  const { api, calls } = harness();
  for (const [body, status] of [['{', 400], ['null', 400], ['[]', 400], [{ note: 'é'.repeat(2200) }, 413]]) {
    const response = await api.POST(request(body, { path: '/api/eve/character-workspace' }));
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
  assert.equal(calls.length, 0);
  const failing = harness({ characterWorkspaceError: true });
  const response = await failing.api.POST(request({ characterId: 12345, view: 'standings' }, { path: '/api/eve/character-workspace' }));
  assert.equal(response.status, 500);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), { error: 'Request failed.' });
});

const publicTools = [
  ['public_market', { regionId: 1, typeId: 1 }],
  ['resolve_names', { ids: [1] }],
];
async function publicResult(upstream, name = 'public_market', args = { regionId: 1, typeId: 1 }) {
  const { mcp, calls } = harness({ publicResponse: upstream });
  const response = await mcp.POST(request(tool(name, args)));
  const result = (await response.json()).result;
  assert.deepEqual(calls, ['public']);
  return result;
}

test('public market does not invent a page count when the header is missing or invalid', async () => {
  for (const pageCount of [null, '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992']) {
    const headers = pageCount === null ? {} : { 'x-pages': pageCount };
    const result = await publicResult(Response.json([{ order_id: 1 }], { headers }));
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.pages, null);
    assert(data.pagination.includes('completeness is unknown'));
  }
});

test('public market preserves valid positive integer page counts', async () => {
  for (const pages of ['1', '3']) {
    const result = await publicResult(Response.json([], { headers: { 'x-pages': pages } }));
    assert.equal(JSON.parse(result.content[0].text).pages, Number(pages));
  }
});

test('public name lookup remains a single unpaginated list', async () => {
  const result = await publicResult(Response.json([]), 'resolve_names', { ids: [1] });
  assert.equal(JSON.parse(result.content[0].text).pages, 1);
});

test('public readers reject non-array successful payloads', async () => {
  for (const [name, args] of publicTools) for (const payload of [null, {}, { error: 'synthetic confidential upstream detail' }]) {
    const result = await publicResult(Response.json(payload), name, args);
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, 'EVE returned an unexpected dataset.');
  }
});

test('public readers reject partial HTTP responses', async () => {
  for (const [name, args] of publicTools) {
    const result = await publicResult(Response.json([], { status: 206, headers: { 'content-range': 'items 0-0/100' } }), name, args);
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, 'EVE returned an unexpected response.');
  }
});

test('public readers preserve cache snapshot metadata', async () => {
  const headers = { expires: 'Sun, 01 Nov 2026 12:30:00 GMT', 'last-modified': 'Sun, 01 Nov 2026 12:25:00 GMT', 'cache-control': 'public, max-age=300' };
  for (const [name, args] of publicTools) {
    const result = await publicResult(Response.json([], { headers }), name, args);
    const value = JSON.parse(result.content[0].text);
    assert.equal(value.cacheExpires, headers.expires);
    assert.equal(value.lastModified, headers['last-modified']);
    assert.equal(value.cacheControl, headers['cache-control']);
    assert(Number.isFinite(Date.parse(value.retrievedAt)));
  }
});

test('public throttling errors retain actionable numeric delays without upstream details', async () => {
  for (const [status, header, seconds] of [[429, 'retry-after', '120'], [420, 'x-esi-error-limit-reset', '55'], [429, 'retry-after', '0']]) {
    const result = await publicResult(Response.json({ error: 'synthetic confidential upstream detail' }, { status, headers: { [header]: seconds } }));
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, `EVE's request limit was reached. Retry after ${seconds} seconds.`);
  }
});

test('public throttling errors do not echo invalid header contents', async () => {
  for (const delay of ['-1', '1.5', 'Infinity', '9007199254740992', 'synthetic confidential header']) {
    const result = await publicResult(Response.json({ error: 'synthetic confidential upstream detail' }, { status: 429, headers: { 'retry-after': delay } }));
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "EVE's request limit was reached. Please wait before retrying.");
  }
});

test('public market page limits never expose an unusable continuation or imply completeness', async () => {
  for (const [page, pages, nextPage, more, limited] of [[499, 501, 500, true, false], [500, 501, null, true, true], [500, 500, null, false, false], [500, null, null, null, true], [1, 3, 2, true, false], [1, null, null, null, false]]) {
    const headers = pages === null ? {} : { 'x-pages': String(pages) };
    const result = await publicResult(Response.json([{ order_id: 1 }], { headers }), 'public_market', { regionId: 1, typeId: 1, page });
    const metadata = JSON.parse(result.content[0].text);
    assert.equal(metadata.page, page);
    assert.equal(metadata.pageLimit, 500);
    assert.equal(metadata.nextPage, nextPage);
    assert.equal(metadata.morePagesAvailable, more);
    assert.equal(metadata.pageLimitReached, limited);
    if (limited) assert(metadata.pagination.includes(more === true ? 'additional pages exist' : 'completeness cannot be determined'));
    if (limited && more === true) assert(metadata.pagination.includes('incomplete'));
  }
});

for (const [dataset, parameter] of [['asset_names', 'itemIds'], ['mail', 'labels'], ['search', 'categories']]) test(`deep invalid ${parameter} entries are rejected without a validator crash`, async () => {
  // Construct raw JSON because serializing the deliberately invalid nested item
  // in the test would itself exceed the JavaScript call stack.
  const nested = '['.repeat(12000) + '1' + ']'.repeat(12000);
  const search = dataset === 'search' ? ',"search":"synthetic"' : '';
  const raw = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_character_data","arguments":{"characterId":1,"dataset":"${dataset}","parameters":{"${parameter}":[${nested}]${search}}}}}`;
  for (const authenticated of [true, false]) for (const batched of [true, false]) {
    const { mcp, calls } = harness();
    const payload = batched ? `[${raw}]` : raw;
    assert(new TextEncoder().encode(payload).byteLength < 32000);
    const incoming = request(payload);
    if (!authenticated) incoming.headers.delete('oai-authenticated-user-id');
    const response = await mcp.POST(incoming);
    const value = await response.json();
    const result = batched ? value[0] : value;
    assert.equal(result.id, 1);
    assert.equal(result.error.code, -32602);
    assert.equal(result.result, undefined);
    assert.equal(calls.length, 0);
  }
});

for (const operation of ['character-analytics', 'clone-analytics', 'wallet-analytics', 'inventory-analytics', 'industry-analytics', 'order-analytics', 'blueprint-analytics', 'blueprint-collection', 'blueprint-reconciliation']) {
  test(`${operation} is protected by authentication, origin, content type and request limits`, async () => {
    for (const [headers, expected] of [[{ 'oai-authenticated-user-id': '' }, 401], [{ origin: 'https://other.invalid' }, 403], [{ 'content-type': 'text/plain' }, 415]]) {
      const { api, calls } = harness();
      const response = await api.POST(request({ characterId: 90000001 }, { path: `/api/eve/${operation}`, headers }));
      assert.equal(response.status, expected); assert.deepEqual(calls, []); assert.match(response.headers.get('cache-control'), /no-store/);
    }
    const { api, calls } = harness();
    const oversized = await api.POST(request(' '.repeat(4097), { path: `/api/eve/${operation}` }));
    assert.equal(oversized.status, 413); assert.deepEqual(calls, []); assert.match(oversized.headers.get('cache-control'), /private.*no-store/);
  });
  test(`${operation} rejects malformed or non-object input and unsupported GET without invoking a reader`, async () => {
    for (const body of ['{', 'null', '[]', 'true', '"synthetic"']) {
      const { api, calls } = harness();
      const response = await api.POST(request(body, { path: `/api/eve/${operation}` }));
      assert.equal(response.status, 400); assert.deepEqual(calls, []);
      assert.match(response.headers.get('cache-control'), /private.*no-store/);
    }
    for (const authenticated of [true, false]) {
      const { api, calls } = harness();
      const response = await api.GET(new Request(`${origin}/api/eve/${operation}`, { headers: authenticated ? { 'oai-authenticated-user-id': 'synthetic-user' } : {} }));
      assert.equal(response.status, authenticated ? 404 : 401); assert.deepEqual(calls, []);
      assert.match(response.headers.get('cache-control'), /private.*no-store/);
    }
  });
  if (operation === 'blueprint-collection' || operation === 'blueprint-reconciliation') continue;
  test(`${operation} propagates selected context and cancellation without leaking service errors`, async () => {
    const { api, calls, characterWorkspaceCalls } = harness(), body = { characterId: 90000001, ...(['character-analytics', 'clone-analytics'].includes(operation) ? {} : { entity: 'corporation', page: 2, ...(operation === 'wallet-analytics' ? { division: 3 } : operation === 'industry-analytics' ? { includeCompleted: true } : {}) }) };
    const incoming = request(body, { path: `/api/eve/${operation}` }), response = await api.POST(incoming);
    assert.equal(response.status, 200); assert.deepEqual(calls, [operation]);
    assert.equal(characterWorkspaceCalls[0].user, 'synthetic-user'); assert.equal(characterWorkspaceCalls[0].signal, incoming.signal);
    assert.deepEqual(JSON.parse(JSON.stringify(characterWorkspaceCalls[0].args)), body);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.match(response.headers.get('vary'), /Cookie/);
    assert.match(response.headers.get('vary'), /oai-authenticated-user-id/); assert.match(response.headers.get('cache-control'), /private.*no-store/);
    const failed = await harness({ analyticsError: true }).api.POST(request(body, { path: `/api/eve/${operation}` }));
    assert.equal(failed.status, 500); assert.doesNotMatch(await failed.text(), /OMIT_PRIVATE/); assert.match(failed.headers.get('cache-control'), /private.*no-store/);
  });
}

test('blueprint collection streams progress then one result with private response protections', async () => {
  const { api, calls, characterWorkspaceCalls } = harness();
  const incoming = request({ characterId: 90000001 }, { path: '/api/eve/blueprint-collection' });
  const response = await api.POST(incoming), events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(response.status, 200); assert.deepEqual(calls, ['blueprint-collection']);
  assert.equal(characterWorkspaceCalls[0].user, 'synthetic-user');
  assert.deepEqual(JSON.parse(JSON.stringify(characterWorkspaceCalls[0].args)), { characterId: 90000001 });
  assert(characterWorkspaceCalls[0].signal instanceof AbortSignal);
  assert.deepEqual(events.map(event => event.type), ['progress', 'result']);
  assert.equal(events[0].progress.pagesRead, 0); assert.equal(events[1].result.characterId, 90000001);
  assert.match(response.headers.get('content-type'), /^application\/x-ndjson/);
  assert.match(response.headers.get('cache-control'), /private.*no-store/);
  assert.match(response.headers.get('vary'), /Cookie/); assert.match(response.headers.get('vary'), /oai-authenticated-user-id/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('blueprint collection validates arguments before starting a reader', async () => {
  for (const input of [{}, { characterId: 0 }, { characterId: '90000001' }, { characterId: 90000001, page: 1 }, { characterId: 90000001, entity: 'corporation' }, { characterId: 90000001, write: true }]) {
    const { api, calls } = harness();
    const response = await api.POST(request(input, { path: '/api/eve/blueprint-collection' }));
    assert.equal(response.status, 400); assert.deepEqual(calls, []); assert.match(response.headers.get('cache-control'), /private.*no-store/);
  }
});

test('blueprint collection ownership failures are terminal stream errors without upstream text', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const { api } = harness({ collectionRead: async (_user, _args, _context, EveError) => { throw new EveError('OMIT_PRIVATE_COLLECTION', status); } });
    const response = await api.POST(request({ characterId: 90000001 }, { path: '/api/eve/blueprint-collection' }));
    const raw = await response.text(), events = raw.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(response.status, 200); assert.equal(events.length, 1); assert.equal(events[0].type, 'error');
    assert(Number.isInteger(events[0].status)); assert.doesNotMatch(raw, /OMIT_PRIVATE/);
    assert.match(response.headers.get('cache-control'), /private.*no-store/);
  }
});

test('cancelling a blueprint response aborts its in-flight reader', async () => {
  let capturedSignal, observedAbort = false;
  const { api } = harness({ collectionRead: async (_user, _args, context) => {
    capturedSignal = context.signal;
    context.onProgress({ pagesRead: 0, pagesExpected: null, rowsReceived: 0, uniqueRecords: 0, duplicateRecords: 0, pageLimit: 50, rowLimit: 50000 });
    await new Promise((resolve, reject) => { context.signal.addEventListener('abort', () => { observedAbort = true; reject(context.signal.reason); }, { once: true }); });
  } });
  const response = await api.POST(request({ characterId: 90000001 }, { path: '/api/eve/blueprint-collection' }));
  const reader = response.body.getReader();
  assert.equal(JSON.parse(new TextDecoder().decode((await reader.read()).value)).type, 'progress');
  await reader.cancel(); await Promise.resolve();
  assert(capturedSignal.aborted); assert(observedAbort);
});

test('aborting the originating blueprint request prevents a late result', async () => {
  const controller = new AbortController(); let capturedSignal;
  const { api } = harness({ collectionRead: async (_user, _args, context) => {
    capturedSignal = context.signal;
    await new Promise((resolve, reject) => { context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }); });
    return { synthetic: true };
  } });
  const incoming = new Request(`${origin}/api/eve/blueprint-collection`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'oai-authenticated-user-id': 'synthetic-user' }, body: JSON.stringify({ characterId: 90000001 }), signal: controller.signal });
  const response = await api.POST(incoming); controller.abort();
  const raw = await response.text();
  assert(capturedSignal.aborted); assert.doesNotMatch(raw, /"type":"result"/);
});

test('blueprint reconciliation streams progress then one result with private response protections', async () => {
  const { api, calls, characterWorkspaceCalls } = harness();
  const incoming = request({ characterId: 90000001 }, { path: '/api/eve/blueprint-reconciliation' });
  const response = await api.POST(incoming), events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(response.status, 200); assert.deepEqual(calls, ['blueprint-reconciliation']);
  assert.equal(characterWorkspaceCalls[0].user, 'synthetic-user');
  assert.deepEqual(JSON.parse(JSON.stringify(characterWorkspaceCalls[0].args)), { characterId: 90000001 });
  assert(characterWorkspaceCalls[0].signal instanceof AbortSignal);
  assert.deepEqual(events.map(event => event.type), ['progress', 'result']);
  assert.equal(events[0].progress.pagesRead, 0); assert.equal(events[1].result.characterId, 90000001);
  assert.match(response.headers.get('content-type'), /^application\/x-ndjson/);
  assert.match(response.headers.get('cache-control'), /private.*no-store/);
  assert.match(response.headers.get('vary'), /Cookie/); assert.match(response.headers.get('vary'), /oai-authenticated-user-id/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('blueprint reconciliation validates arguments before starting a reader', async () => {
  for (const input of [{}, { characterId: 0 }, { characterId: '90000001' }, { characterId: 90000001, page: 1 }, { characterId: 90000001, entity: 'corporation' }, { characterId: 90000001, write: true }]) {
    const { api, calls } = harness();
    const response = await api.POST(request(input, { path: '/api/eve/blueprint-reconciliation' }));
    assert.equal(response.status, 400); assert.deepEqual(calls, []); assert.match(response.headers.get('cache-control'), /private.*no-store/);
  }
});

test('blueprint reconciliation ownership failures are terminal stream errors without upstream text', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const { api } = harness({ collectionRead: async (_user, _args, _context, EveError) => { throw new EveError('OMIT_PRIVATE_COLLECTION', status); } });
    const response = await api.POST(request({ characterId: 90000001 }, { path: '/api/eve/blueprint-reconciliation' }));
    const raw = await response.text(), events = raw.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(response.status, 200); assert.equal(events.length, 1); assert.equal(events[0].type, 'error');
    assert(Number.isInteger(events[0].status)); assert.doesNotMatch(raw, /OMIT_PRIVATE/);
    assert.match(response.headers.get('cache-control'), /private.*no-store/);
  }
});

test('cancelling a blueprint reconciliation response aborts its in-flight reader', async () => {
  let capturedSignal, observedAbort = false;
  const { api } = harness({ collectionRead: async (_user, _args, context) => {
    capturedSignal = context.signal;
    context.onProgress({ pagesRead: 0, pagesExpected: null, rowsReceived: 0, uniqueRecords: 0, duplicateRecords: 0, pageLimit: 50, rowLimit: 50000 });
    await new Promise((resolve, reject) => { context.signal.addEventListener('abort', () => { observedAbort = true; reject(context.signal.reason); }, { once: true }); });
  } });
  const response = await api.POST(request({ characterId: 90000001 }, { path: '/api/eve/blueprint-reconciliation' }));
  const reader = response.body.getReader();
  assert.equal(JSON.parse(new TextDecoder().decode((await reader.read()).value)).type, 'progress');
  await reader.cancel(); await Promise.resolve();
  assert(capturedSignal.aborted); assert(observedAbort);
});

test('aborting the originating reconciliation request prevents a late result', async () => {
  const controller = new AbortController(); let capturedSignal;
  const { api } = harness({ collectionRead: async (_user, _args, context) => {
    capturedSignal = context.signal;
    await new Promise((resolve, reject) => { context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }); });
    return { synthetic: true };
  } });
  const incoming = new Request(`${origin}/api/eve/blueprint-reconciliation`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'oai-authenticated-user-id': 'synthetic-user' }, body: JSON.stringify({ characterId: 90000001 }), signal: controller.signal });
  const response = await api.POST(incoming); controller.abort();
  const raw = await response.text();
  assert(capturedSignal.aborted); assert.doesNotMatch(raw, /"type":"result"/);
});


const historyInputs = () => ({
  wallet_history_status: { characterId: 90000001 },
  wallet_history_report: { characterId: 90000001, days: 90 },
  configure_wallet_history: { characterId: 90000001, enabled: true, retentionDays: 30 },
  capture_wallet_history: { characterId: 90000001 },
  clear_wallet_history: { characterId: 90000001, confirm: 'delete_wallet_history' },
});

test('history tools honestly distinguish local storage writes from report reads', async () => {
  const h = harness(), listed = (await (await h.mcp.POST(request(rpc('tools/list')))).json()).result.tools;
  for (const name of historyNames) {
    const item = listed.find(row => row.name === name), readonly = ['wallet_history_status', 'wallet_history_report'].includes(name);
    assert.equal(item.annotations.readOnlyHint, readonly);
    assert.equal(item.annotations.destructiveHint, !readonly);
    assert.equal(item.annotations.idempotentHint, name !== 'capture_wallet_history');
    assert.equal(item.annotations.openWorldHint, name === 'capture_wallet_history');
    assert.equal(item.inputSchema.additionalProperties, false);
  }
});

test('all history tools bind gateway identity and signal to the shared service', async () => {
  const operations = ['status', 'report', 'configure', 'capture', 'clear'];
  const h = harness();
  for (const [index, [name, args]] of Object.entries(historyInputs()).entries()) {
    const incoming = request(tool(name, args));
    const result = (await (await h.mcp.POST(incoming)).json()).result;
    assert.equal(result.isError, undefined);
    assert.equal(h.historyCalls[index].user, 'synthetic-user');
    assert.equal(h.historyCalls[index].signal, incoming.signal);
    assert.deepEqual(JSON.parse(JSON.stringify(h.historyCalls[index].args)), { ...args, operation: operations[index] });
    const denied = request(tool(name, args)); denied.headers.delete('oai-authenticated-user-id');
    assert.equal((await (await h.mcp.POST(denied)).json()).result.isError, true);
    assert.equal(h.historyCalls.length, index + 1);
  }
});

test('history schemas reject unrequested settings, unsafe retention and missing erase confirmation before service calls', async () => {
  const h = harness();
  for (const [name, args] of [
    ['wallet_history_status', { characterId: 1, userId: 'another-owner' }],
    ['wallet_history_report', { characterId: 1, days: 366 }],
    ['wallet_history_report', { characterId: 1, entity: 'corporation' }],
    ['configure_wallet_history', { characterId: 1, enabled: 'true', retentionDays: 30 }],
    ['configure_wallet_history', { characterId: 1, enabled: true }],
    ['configure_wallet_history', { characterId: 1, enabled: true, retentionDays: 0 }],
    ['capture_wallet_history', { characterId: 1, operation: 'configure' }],
    ['capture_wallet_history', { characterId: 1, enabled: true }],
    ['clear_wallet_history', { characterId: 1 }],
    ['clear_wallet_history', { characterId: 1, confirm: true }],
  ]) await rpcError(await h.mcp.POST(request(tool(name, args))), -32602, 1);
  assert.equal(h.historyCalls.length, 0);
});

test('MCP notifications cannot enable, capture or erase history', async () => {
  const h = harness();
  for (const [name, args] of Object.entries(historyInputs())) {
    const notification = tool(name, args); delete notification.id;
    const result = await h.mcp.POST(request(notification));
    assert.equal(result.status, 202);
  }
  assert.equal(h.historyCalls.length, 0);
});

test('history API keeps origin, authentication and body limits ahead of mutations', async () => {
  const body = { characterId: 90000001, operation: 'capture' }, path = '/api/eve/wallet-history';
  const h = harness(), incoming = request(body, { path });
  const result = await h.api.POST(incoming);
  assert.equal(result.status, 200); assert.equal(h.historyCalls[0].user, 'synthetic-user');
  assert.equal(h.historyCalls[0].signal, incoming.signal);
  assert.deepEqual(JSON.parse(JSON.stringify(h.historyCalls[0].args)), body);
  for (const [header, status] of [['origin', 403], ['oai-authenticated-user-id', 401]]) {
    const rejected = request(body, { path }); rejected.headers.delete(header);
    assert.equal((await h.api.POST(rejected)).status, status);
  }
  assert.equal((await h.api.POST(request(' '.repeat(4097), { path }))).status, 413);
  assert.equal(h.historyCalls.length, 1);
  assert.match(result.headers.get('cache-control'), /no-store/);
});

test('history service errors do not leak storage details through either transport', async () => {
  const h = harness({ historyError: true });
  const mcp = await (await h.mcp.POST(request(tool('wallet_history_report', { characterId: 1 })))).text();
  assert(!mcp.includes('OMIT_PRIVATE_HISTORY')); assert.match(mcp, /isError/);
  const api = await h.api.POST(request({ characterId: 1, operation: 'report' }, { path: '/api/eve/wallet-history' }));
  assert.equal(api.status, 500); assert(!(await api.text()).includes('OMIT_PRIVATE_HISTORY'));
});


test('legacy batches reject history changes before any mutation executes', async () => {
  const h = harness(), inputs = historyInputs();
  const names = ['configure_wallet_history', 'capture_wallet_history', 'clear_wallet_history'];
  const values = await (await h.mcp.POST(request(names.map((name, index) => tool(name, inputs[name], index + 1))))).json();
  assert.deepEqual(values.map(value => value.id), [1, 2, 3]);
  for (const value of values) {
    assert.equal(value.error.code, -32600);
    assert.equal(value.error.message, 'Wallet history changes must be sent as a single request.');
  }
  assert.equal(h.historyCalls.length, 0);
});

test('a nearly full batch cannot commit a history change then report it as unfinished', async () => {
  const h = harness({ statusResult: { synthetic: 'x'.repeat(4 * 1024 * 1024 - 1000) } });
  const values = await (await h.mcp.POST(request([
    tool('connection_status', {}, 1),
    tool('clear_wallet_history', historyInputs().clear_wallet_history, 2),
  ]))).json();
  assert.equal(values[0].result.content[0].type, 'text');
  assert.equal(values[1].error.code, -32600);
  assert.equal(values[1].error.message, 'Wallet history changes must be sent as a single request.');
  assert.equal(h.historyCalls.length, 0);
  assert(Buffer.byteLength(JSON.stringify(values)) <= 4 * 1024 * 1024);
});

test('legacy batches still permit saved history status and reports', async () => {
  const h = harness(), inputs = historyInputs();
  const values = await (await h.mcp.POST(request([
    tool('wallet_history_status', inputs.wallet_history_status, 1),
    tool('wallet_history_report', inputs.wallet_history_report, 2),
  ]))).json();
  assert(values.every(value => value.result?.content[0]?.type === 'text' && !value.result.isError));
  assert.deepEqual(h.historyCalls.map(call => call.args.operation), ['status', 'report']);
});


test('saved history comparisons reuse the existing read-only tool with bounded report options', async () => {
  const h = harness(), listed = (await (await h.mcp.POST(request(rpc('tools/list')))).json()).result.tools;
  assert.equal(listed.length, 23);
  const report = listed.find(item => item.name === 'wallet_history_report');
  assert.deepEqual(report.inputSchema.properties.days.enum, [7, 30, 90, 365]);
  assert.equal(report.inputSchema.properties.comparePrevious.type, 'boolean');
  assert.equal(report.annotations.readOnlyHint, true); assert.equal(report.annotations.destructiveHint, false);
  assert.deepEqual(listed.find(item => item.name === 'configure_wallet_history').inputSchema.properties.retentionDays.enum, [30, 90, 365]);
  const selected = { characterId: 90000001, days: 7, comparePrevious: true };
  const incoming = request(tool('wallet_history_report', selected));
  assert.equal((await (await h.mcp.POST(incoming)).json()).result.isError, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(h.historyCalls[0].args)), { ...selected, operation: 'report' });
  assert.equal(h.historyCalls[0].user, 'synthetic-user'); assert.equal(h.historyCalls[0].signal, incoming.signal);
  for (const [name, args] of [
    ['wallet_history_report', { ...selected, comparePrevious: 'true' }],
    ['wallet_history_report', { ...selected, comparePrevious: null }],
    ['wallet_history_report', { ...selected, days: 14 }],
    ['wallet_history_status', { characterId: 90000001, comparePrevious: true }],
    ['configure_wallet_history', { characterId: 90000001, enabled: true, retentionDays: 7 }],
  ]) await rpcError(await h.mcp.POST(request(tool(name, args))), -32602, 1);
  const denied = request(tool('wallet_history_report', selected)); denied.headers.delete('oai-authenticated-user-id');
  assert.equal((await (await h.mcp.POST(denied)).json()).result.isError, true); assert.equal(h.historyCalls.length, 1);
});


test('character training report exposes one strict owned selector and read-only annotations', async () => {
  const h = harness(), listing = await (await h.mcp.POST(request(rpc('tools/list')))).json();
  const item = listing.result.tools.find(row => row.name === 'character_training_report');
  assert.deepEqual(item.inputSchema, { type: 'object', required: ['characterId'], properties: { characterId: { type: 'integer', minimum: 1 } }, additionalProperties: false });
  assert.deepEqual(item.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  assert.equal(h.calls.length, 0);
});
test('training report MCP forwards only the gateway owner, selected character and cancellation', async () => {
  const h = harness(), input = request(tool('character_training_report', { characterId: 90000001 }));
  const response = await (await h.mcp.POST(input)).json();
  assert.equal(response.result.isError, undefined); assert.deepEqual(h.calls, ['training-report']);
  assert.equal(h.trainingCalls[0].user, 'synthetic-user');
  assert.deepEqual(JSON.parse(JSON.stringify(h.trainingCalls[0].args)), { characterId: 90000001 });
  assert.equal(h.trainingCalls[0].signal, input.signal);
  assert.deepEqual(JSON.parse(response.result.content[0].text), { characterId: 90000001, synthetic: true });
});
test('training report refuses missing identity and notifications without reads', async () => {
  const h = harness();
  const denied = await (await h.mcp.POST(request(tool('character_training_report', { characterId: 90000001 }), { headers: { 'oai-authenticated-user-id': '' } }))).json();
  assert.equal(denied.result.isError, true);
  const notification = await h.mcp.POST(request({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'character_training_report', arguments: { characterId: 90000001 } } }));
  assert.equal(notification.status, 202); assert.equal(await notification.text(), ''); assert.equal(h.calls.length, 0);
});
test('training report rejects alternate owners, feed selectors, unbounded limits and bad IDs', async () => {
  const h = harness();
  for (const args of [null, {}, { characterId: 0 }, { characterId: -1 }, { characterId: 1.5 }, { characterId: Number.MAX_SAFE_INTEGER + 1 }, { characterId: '90000001' }, { characterId: 90000001, userId: 'other' }, { characterId: 90000001, corporationId: 98000001 }, { characterId: 90000001, dataset: 'mail' }, { characterId: 90000001, limit: 2000 }, { characterId: 90000001, page: 2 }, { characterId: 90000001, url: 'https://attacker.example' }]) await rpcError(await h.mcp.POST(request(tool('character_training_report', args))), -32602, 1);
  assert.equal(h.calls.length, 0);
});
test('training report preserves ownership refusal and hides unexpected exception details', async () => {
  const owned = harness({ trainingOwnerError: true });
  const denied = await (await owned.mcp.POST(request(tool('character_training_report', { characterId: 90000002 })))).json();
  assert.equal(denied.result.isError, true); assert.match(denied.result.content[0].text, /connected/);
  const failed = harness({ trainingError: true });
  const response = await (await failed.mcp.POST(request(tool('character_training_report', { characterId: 90000001 })))).json();
  assert.equal(response.result.isError, true); assert.equal(response.result.content[0].text, 'Request failed.'); assert(!JSON.stringify(response).includes('OMIT_PRIVATE'));
});
