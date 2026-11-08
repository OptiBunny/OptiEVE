import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPublicSource } from '../scripts/public-source.mjs';

// Run against an installed, built sanitized copy. No private checkout or live
// EVE credentials are used; all runtime state stays in a disposable directory.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prefix = 'optieve-wrangler-regression-';
const origin = 'https://optieve.example';
const identity = { 'oai-authenticated-user-id': 'synthetic-runtime-test' };
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
async function settledWithin(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([promise.then(() => true), new Promise(resolveTimer => { timer = setTimeout(() => resolveTimer(false), milliseconds); })]);
  } finally { clearTimeout(timer); }
}
const children = new Set();
let temporary, stage = 'preflight';

class Failure extends Error {}
function check(condition, message) { if (!condition) throw new Failure(message); }
function inside(parent, child) {
  const distance = relative(resolve(parent), resolve(child));
  return distance !== '' && distance !== '..' && !distance.startsWith(`..${sep}`) && !isAbsolute(distance);
}
function option(args, name, value) {
  const index = args.indexOf(name);
  if (index === -1) args.push(name, value);
  else {
    check(index + 1 < args.length && !args[index + 1].startsWith('--'), `Invalid ${name} start option`);
    args[index + 1] = value;
  }
}
function launch(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: root, env, windowsHide: true, detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const entry = { child, closed: false, exitCode: null, failedToStart: false };
  children.add(entry);
  // Discard CLI output: Wrangler's diagnostics can contain local machine paths.
  child.stdout.resume(); child.stderr.resume();
  child.on('error', () => { entry.failedToStart = true; });
  entry.done = new Promise(resolveDone => child.on('close', code => {
    entry.closed = true; entry.exitCode = code; children.delete(entry); resolveDone();
  }));
  return entry;
}
async function stop(entry) {
  if (entry.closed) return;
  if (entry.child.pid) {
    if (process.platform === 'win32') {
      // Only this still-live child and its descendants; never a discovered PID.
      spawnSync('taskkill.exe', ['/PID', String(entry.child.pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore', timeout: 10000,
      });
    } else {
      try { process.kill(-entry.child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
      await settledWithin(entry.done, 1000);
      if (!entry.closed) {
        try { process.kill(-entry.child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
      }
    }
  }
  await settledWithin(entry.done, 10000);
  check(entry.closed, 'Could not stop the temporary worker process');
}
async function run(args, env) {
  const entry = launch(args, env);
  await settledWithin(entry.done, 45000);
  if (!entry.closed) { await stop(entry); throw new Failure('Temporary database setup timed out'); }
  check(!entry.failedToStart && entry.exitCode === 0, 'Temporary database setup failed');
}

try {
  // Archive copies have no Git index to exclude these two normal build files.
  // Permit only their generated-file classification: content, link, credential
  // and private-runtime failures still reject the test before state is read.
  const permittedBuildFiles = new Set([
    'next-env.d.ts: generated or local-only artifact',
    'tsconfig.tsbuildinfo: generated or local-only artifact',
  ]);
  check(inspectPublicSource(root).failures.every(failure => permittedBuildFiles.has(failure)), 'Runtime tests require sanitized source without private runtime state');
  const builtRoot = join(root, 'dist', 'server');
  const builtConfig = join(builtRoot, 'wrangler.json');
  check(existsSync(builtConfig) && existsSync(join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js')), 'Install dependencies and build the sanitized validation copy first');
  const configured = JSON.parse(readFileSync(builtConfig, 'utf8'));
  const main = resolve(builtRoot, configured.main);
  const assets = resolve(builtRoot, configured.assets?.directory ?? '');
  check(inside(join(root, 'dist'), main) && inside(join(root, 'dist'), assets), 'Build paths must remain within dist');

  const start = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts?.start;
  // Execute the real package command without a shell. This project uses a plain
  // Node CLI command; refuse future shell syntax rather than interpreting it.
  check(typeof start === 'string' && /^node\s/.test(start) && !/["'`;&|<>\r\n]/.test(start), 'Expected a direct Node start command');
  const startArgs = start.trim().split(/\s+/).slice(1);
  check(startArgs.includes('dev') && startArgs.includes('--local'), 'Start command must use a local worker');

  temporary = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  const runtime = join(temporary, 'runtime'), persist = join(temporary, 'state');
  mkdirSync(runtime);
  const config = join(temporary, 'wrangler.json');
  // Preserve the build's module/bundling settings, including no_bundle, so this
  // test catches regressions in the actual start command's configuration.
  writeFileSync(config, JSON.stringify({
    name: 'optieve-runtime-test', main,
    compatibility_date: configured.compatibility_date,
    compatibility_flags: configured.compatibility_flags,
    no_bundle: configured.no_bundle,
    rules: configured.rules,
    assets: { directory: assets },
    d1_databases: [{ binding: 'DB', database_name: 'synthetic-runtime-test', database_id: '00000000-0000-4000-8000-000000000000' }],
    vars: { EVE_SITE_ORIGIN: origin },
  }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:EVE_|CF_|CLOUDFLARE_|SITES_|WRANGLER_|MINIFLARE_|OPENAI_|GITHUB_|GH_)|^NODE_OPTIONS$/i.test(name)));
  Object.assign(env, {
    CI: 'true', SITES_RUNTIME_ROOT: runtime,
    CLOUDFLARE_CF_FETCH_ENABLED: 'false', WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false',
    WRANGLER_LOG_PATH: join(runtime, 'logs'), WRANGLER_REGISTRY_PATH: join(runtime, 'dev-registry'),
    MINIFLARE_REGISTRY_PATH: join(runtime, 'registry'),
  });
  stage = 'temporary database setup';
  await run(['--import', './scripts/sites-env.mjs', './node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', config, '--persist-to', persist, '--file', join(root, 'drizzle', '0000_gorgeous_guardian.sql')], env);

  const listener = createServer();
  await new Promise((resolveListen, rejectListen) => { listener.once('error', rejectListen); listener.listen(0, '127.0.0.1', resolveListen); });
  const port = listener.address().port;
  await new Promise(resolveClose => listener.close(resolveClose));
  option(startArgs, '--config', config); option(startArgs, '--persist-to', persist);
  option(startArgs, '--ip', '127.0.0.1'); option(startArgs, '--port', String(port)); option(startArgs, '--inspector-port', '0');
  const server = launch(startArgs, env);
  const base = `http://127.0.0.1:${port}`;
  async function request(path, init = {}, timeout = 10000) {
    // Do not retry POSTs or force Connection: close: either would conceal the
    // unread-body connection reuse regression this test is meant to detect.
    const response = await fetch(base + path, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    return { status: response.status, headers: response.headers, text: await response.text() };
  }
  const expectStatus = (response, status) => check(response.status === status, `Expected HTTP ${status}; received ${response.status}`);
  async function post(path, body, headers = {}) {
    return request(path, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
  }
  async function rpc(method, params = undefined, authenticated = false) {
    const response = await post('/mcp', JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), authenticated ? identity : {});
    expectStatus(response, 200);
    return JSON.parse(response.text);
  }
  stage = 'local worker startup';
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline && !server.closed) {
    try { ready = (await request('/', {}, 1000)).status === 200; } catch { /* Only readiness GETs are retried. */ }
    if (ready) break;
    await sleep(150);
  }
  check(ready && !server.failedToStart, 'Local worker did not become ready');

  for (let round = 1; round <= 10; round++) {
    stage = `round ${round}, missing identity`;
    expectStatus(await post('/api/eve/connect', '{}', { origin }), 401);
    stage = `round ${round}, missing Origin`;
    expectStatus(await post('/api/eve/connect', '{}', identity), 403);
    stage = `round ${round}, wrong Origin`;
    expectStatus(await post('/api/eve/connect', '{}', { ...identity, origin: 'https://wrong.example' }), 403);
    stage = `round ${round}, wrong content type`;
    expectStatus(await post('/api/eve/connect', '{}', { ...identity, origin, 'content-type': 'text/plain' }), 415);
    stage = `round ${round}, unconfigured connect`;
    expectStatus(await post('/api/eve/connect', '{}', { ...identity, origin }), 400);
    stage = `round ${round}, invalid configuration`;
    expectStatus(await post('/api/eve/config', '{"clientId":"short"}', { ...identity, origin }), 400);
    stage = `round ${round}, malformed JSON`;
    expectStatus(await post('/api/eve/config', '{', { ...identity, origin }), 400);
    stage = `round ${round}, healthy status after rejections`;
    const response = await request('/api/eve/status', { headers: identity });
    expectStatus(response, 200);
    const status = JSON.parse(response.text);
    check(status.configured === false && status.clientId === null && status.characters.length === 0, 'Expected a fresh empty synthetic account');
    check(status.callbackUrl === `${origin}/eve/callback` && status.scopes.character.length === 39, 'Unexpected setup metadata');
    check(status.corporationFeatures.length === 8 && status.corporationFeatures.some(feature => feature.id === 'extractions' && feature.scope === 'esi-industry.read_corporation_mining.v1') && status.corporationFeatures.some(feature => feature.id === 'freelance' && feature.scope === 'esi-corporations.read_freelance_jobs.v1'), 'Built worker must advertise the two optional read permissions');
  }
  stage = 'streamed rejected upload';
  let chunks = 0;
  const streamedBody = new ReadableStream({
    async pull(controller) {
      if (chunks === 3) { controller.close(); return; }
      await sleep(10);
      controller.enqueue(new TextEncoder().encode('synthetic chunk '.repeat(300)));
      chunks++;
    },
  });
  expectStatus(await request('/api/eve/connect', {
    method: 'POST', body: streamedBody, duplex: 'half',
    headers: { ...identity, origin: 'https://wrong.example', 'content-type': 'application/json' },
  }), 403);
  check(chunks === 3, 'Rejected upload must be consumed without truncating the connection');
  expectStatus(await request('/api/eve/status', { headers: identity }), 200);
  stage = 'oversized request';
  expectStatus(await post('/api/eve/config', 'x'.repeat(4097), { ...identity, origin }), 413);
  expectStatus(await request('/api/eve/status', { headers: identity }), 200);
  stage = 'MCP operations';
  check((await rpc('server/discover')).result.supportedVersions.includes('2026-07-28'), 'Unexpected Sites discovery version');
  const initialized = (await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'synthetic-runtime-test', version: '1.0' } })).result;
  check(initialized.serverInfo.name === 'OptiEVE', 'Unexpected MCP server identity');
  check(initialized.instructions.includes('assess_manufacturing') && initialized.instructions.includes('No game writes'), 'Manufacturing guidance must reach the real MCP client');
  const toolNames = (await rpc('tools/list')).result.tools.map(tool => tool.name).sort();
  check(JSON.stringify(toolNames) === JSON.stringify(['connection_status', 'public_market', 'read_character_data', 'read_corporation_data', 'read_private_data', 'resolve_names', 'manufacturing_item_search', 'manufacturing_recipe', 'manufacturing_catalog_status', 'manufacturing_requirements', 'manufacturing_market_history', 'manufacturing_industry_costs', 'manufacturing_station_quote', 'assess_manufacturing', 'manufacturing_compare', 'manufacturing_plan'].sort()), 'Unexpected MCP tool catalog');
  check((await rpc('tools/call', { name: 'connection_status', arguments: {} })).result.isError === true, 'Missing MCP identity must be rejected');
  const connection = (await rpc('tools/call', { name: 'connection_status', arguments: {} }, true)).result;
  check(!connection.isError && JSON.parse(connection.content[0].text).characters.length === 0, 'Synthetic MCP status must be empty');
  stage = 'authenticated manufacturing catalog and exact requirements';
  // These three real Worker calls use only the vendored public SDE and exact
  // calculator. They must never need live EVE data or stored authorizations.
  const publicCatalog = JSON.parse(readFileSync(join(root, 'app', 'data', 'manufacturing-catalog.json'), 'utf8'));
  const publicRecipe = publicCatalog.recipes[0];
  const manufacturingCalls = [
    ['manufacturing_item_search', { query: publicRecipe.products[0].name, limit: 5, manufacturableOnly: true }],
    ['manufacturing_recipe', { blueprintTypeId: publicRecipe.blueprintTypeId }],
    ['manufacturing_requirements', { blueprintTypeId: publicRecipe.blueprintTypeId, runs: 2, materialEfficiency: 0, facilityMaterialMultiplier: '1' }],
  ];
  for (const [name, args] of manufacturingCalls) check((await rpc('tools/call', { name, arguments: args })).result.isError === true, 'Public manufacturing tools still require connector identity');
  const manufacturingResults = [];
  for (const [name, args] of manufacturingCalls) {
    const reply = (await rpc('tools/call', { name, arguments: args }, true)).result;
    check(reply && !reply.isError, 'Authenticated public manufacturing call must work in the real Worker');
    manufacturingResults.push(JSON.parse(reply.content[0].text));
  }
  check(manufacturingResults[0].items.some(item => item.typeId === publicRecipe.products[0].typeId), 'Worker search must load the pinned public item catalog');
  check(JSON.stringify(manufacturingResults[1].recipes[0]) === JSON.stringify(publicRecipe), 'Worker recipe must preserve official base data');
  check(manufacturingResults[1].provenance.archiveSha256 === publicCatalog.provenance.archiveSha256, 'Worker recipe must expose pinned source provenance');
  check(manufacturingResults[2].requirements.product.quantity === publicRecipe.products[0].quantity * 2, 'Worker calculator must preserve output batch quantities');
  check(manufacturingResults[2].requirements.materials.every((material, index) => material.requiredQuantity === publicRecipe.materials[index].quantity * 2), 'Worker calculator must calculate exact whole-job materials');
  stage = 'overview authorization boundaries';
  stage = 'manufacturing workspace authorization and public catalog';
  const manufacturingBody = JSON.stringify({ operation: 'search', query: publicRecipe.products[0].name, limit: 5 });
  for (const [headers, status] of [[{ origin }, 401], [{ ...identity, origin: 'https://wrong.example' }, 403], [{ ...identity, origin, 'content-type': 'text/plain' }, 415]]) {
    expectStatus(await post('/api/eve/manufacturing', manufacturingBody, headers), status);
    expectStatus(await request('/api/eve/status', { headers: identity }), 200);
  }
  const workspaceSearch = await post('/api/eve/manufacturing', manufacturingBody, { ...identity, origin });
  expectStatus(workspaceSearch, 200);
  check(JSON.parse(workspaceSearch.text).items.some(row => row.typeId === publicRecipe.products[0].typeId), 'Manufacturing UI search must project the catalog in the real Worker');
  expectStatus(await post('/api/eve/manufacturing', JSON.stringify({ operation: 'blueprints', characterId: 90000001, resourceEntity: 'character', page: 1 }), { ...identity, origin }), 404);
  expectStatus(await post('/api/eve/manufacturing', JSON.stringify({ operation: 'plan', input: { context: {}, jobs: [] } }), { ...identity, origin }), 400);
  expectStatus(await post('/api/eve/manufacturing', ' '.repeat(65537), { ...identity, origin }), 413);
  expectStatus(await request('/api/eve/manufacturing', { headers: identity }), 404);
  expectStatus(await request('/demo'), 200);
  expectStatus(await request('/api/eve/status', { headers: identity }), 200);
  stage = 'overview authorization boundaries';
  const overviewBody = JSON.stringify({ characterId: 90000001, view: 'personal' });
  for (const [headers, expected] of [[{ origin }, 401], [{ ...identity, origin: 'https://wrong.example' }, 403], [{ ...identity, origin }, 404]]) {
    const response = await post('/api/eve/overview', overviewBody, headers);
    expectStatus(response, expected);
    check(response.headers.get('cache-control')?.includes('private') && response.headers.get('cache-control')?.includes('no-store'), 'Overview errors must disable shared caching');
    check(response.headers.get('vary')?.includes('oai-authenticated-user-id'), 'Overview responses must vary on authenticated identity');
    expectStatus(await request('/api/eve/status', { headers: identity }), 200);
  }
  expectStatus(await post('/api/eve/overview', JSON.stringify({ characterId: 90000001, view: ['personal'] }), { ...identity, origin }), 400);
  expectStatus(await request('/api/eve/overview', { headers: identity }), 404);
  stage = 'corporation workspace authorization boundaries';
  const workspaceBody = JSON.stringify({ characterId: 90000001, view: 'wallets' });
  for (const [headers, expected] of [[{ origin }, 401], [{ ...identity, origin: 'https://wrong.example' }, 403], [{ ...identity, origin }, 404]]) {
    const response = await post('/api/eve/corporation-workspace', workspaceBody, headers);
    expectStatus(response, expected);
    check(response.headers.get('cache-control')?.includes('private') && response.headers.get('cache-control')?.includes('no-store'), 'Corporation workspace must disable shared caching');
    check(response.headers.get('vary')?.includes('oai-authenticated-user-id'), 'Corporation workspace varies on identity');
    expectStatus(await request('/api/eve/status', { headers: identity }), 200);
  }
  expectStatus(await post('/api/eve/corporation-workspace', JSON.stringify({ characterId: 90000001, view: 'project', projectId: '../private' }), { ...identity, origin }), 400);
  expectStatus(await request('/api/eve/corporation-workspace', { headers: identity }), 404);
  for (const view of ['order_history', 'blueprints', 'facilities', 'structures', 'assets', 'extractions', 'freelance_jobs']) {
    expectStatus(await post('/api/eve/corporation-workspace', JSON.stringify({ characterId: 90000001, view }), { ...identity, origin }), 404);
    expectStatus(await request('/api/eve/status', { headers: identity }), 200);
  }
  expectStatus(await post('/api/eve/corporation-workspace', JSON.stringify({ characterId: 90000001, view: 'asset_detail', itemId: 1001, page: 1, includeNames: true }), { ...identity, origin }), 404);
  expectStatus(await post('/api/eve/corporation-workspace', JSON.stringify({ characterId: 90000001, view: 'assets', includeNames: 'true' }), { ...identity, origin }), 400);
  for (const detail of [
    { view: 'contract_bids', contractId: 1001, page: 1 },
    { view: 'project', projectId: 'abcdef00-0000-0000-0000-000000000001' },
    { view: 'extractions', page: 1 },
    { view: 'freelance_jobs', after: 'synthetic-runtime-cursor' },
  ]) {
    const body = JSON.stringify({ characterId: 90000001, ...detail });
    for (const [headers, expected] of [[{ origin }, 401], [{ ...identity, origin: 'https://wrong.example' }, 403], [{ ...identity, origin }, 404]]) {
      const response = await post('/api/eve/corporation-workspace', body, headers);
      expectStatus(response, expected);
      check(response.headers.get('cache-control')?.includes('private') && response.headers.get('cache-control')?.includes('no-store'), 'Detail reads must disable shared caching');
      check(response.headers.get('vary')?.includes('oai-authenticated-user-id'), 'Detail reads vary on identity');
      expectStatus(await request('/api/eve/status', { headers: identity }), 200);
    }
  }
  for (const detail of [{ view: 'contract_bids' }, { view: 'contract_bids', contractId: 1001, page: 501 }, { view: 'contract_bids', contractId: 1001, bidderId: 90000002 }]) {
    expectStatus(await post('/api/eve/corporation-workspace', JSON.stringify({ characterId: 90000001, ...detail }), { ...identity, origin }), 400);
  }
  stage = 'character reputation and industry authorization boundaries';
  for (const view of ['faction_warfare', 'standings', 'loyalty_points', 'blueprints', 'research', 'planets', 'mining']) {
    const body = JSON.stringify({ characterId: 90000001, view });
    for (const [headers, expected] of [[{ origin }, 401], [{ ...identity, origin: 'https://wrong.example' }, 403], [{ ...identity, origin }, 404]]) {
      const response = await post('/api/eve/character-workspace', body, headers);
      expectStatus(response, expected);
      check(response.headers.get('cache-control')?.includes('private') && response.headers.get('cache-control')?.includes('no-store'), 'Reputation responses must disable shared caching');
      check(response.headers.get('vary')?.includes('oai-authenticated-user-id'), 'Reputation responses must vary on authenticated identity');
      expectStatus(await request('/api/eve/status', { headers: identity }), 200);
    }
  }
  for (const input of [{ view: 'standings', offset: -100 }, { view: 'standings', offset: 1 }, { view: 'loyalty_points', offset: 10000 }, { view: 'faction_warfare', offset: 100 }, { view: 'contacts' }, { view: 'standings', corporationId: 1001 }]) {
    expectStatus(await post('/api/eve/character-workspace', JSON.stringify({ characterId: 90000001, ...input }), { ...identity, origin }), 400);
  }
  for (const input of [{ view: 'blueprints', page: 501 }, { view: 'blueprints', page: '1' }, { view: 'blueprints', offset: 1 }, { view: 'research', page: 1 }, { view: 'planets', planetId: 40000001 }, { view: 'planets', ownerId: 90000002 }, { view: 'research', offset: 10000 }]) {
    expectStatus(await post('/api/eve/character-workspace', JSON.stringify({ characterId: 90000001, ...input }), { ...identity, origin }), 400);
  }
  for (const view of ['blueprints', 'research', 'planets', 'mining']) {
    const body = JSON.stringify({ characterId: 90000001, view, resolveNames: true });
    for (const [headers, expected] of [[{ origin }, 401], [{ ...identity, origin: 'https://wrong.example' }, 403], [{ ...identity, origin }, 404]]) {
      const response = await post('/api/eve/character-workspace', body, headers);
      expectStatus(response, expected);
      check(response.headers.get('cache-control')?.includes('private') && response.headers.get('cache-control')?.includes('no-store'), 'Public-label selection must retain private response boundaries');
    }
  }
  for (const input of [{ view: 'mining', page: 0 }, { view: 'mining', page: 501 }, { view: 'mining', offset: 1 }, { view: 'mining', resolveNames: 'true' }, { view: 'mining', ids: [34] }, { view: 'standings', resolveNames: true }, { view: 'planets', resolveNames: true, systemId: 30000001 }]) {
    expectStatus(await post('/api/eve/character-workspace', JSON.stringify({ characterId: 90000001, ...input }), { ...identity, origin }), 400);
  }
  expectStatus(await request('/api/eve/character-workspace', { headers: identity }), 404);
  for (const operation of ['character-analytics', 'clone-analytics', 'wallet-analytics', 'inventory-analytics', 'industry-analytics', 'order-analytics', 'blueprint-analytics']) {
    stage = `${operation} request and response protections`;
    const body = JSON.stringify({ characterId: 90000001, ...(['character-analytics', 'clone-analytics'].includes(operation) ? {} : { entity: 'character', ...(operation === 'industry-analytics' ? { includeCompleted: false } : operation === 'order-analytics' ? {} : { page: 1 }) }) });
    for (const [headers, status] of [[{ origin }, 401], [identity, 403], [{ ...identity, origin: 'https://wrong.example' }, 403], [{ ...identity, origin, 'content-type': 'text/plain' }, 415], [{ ...identity, origin }, 404]]) {
      const response = await post(`/api/eve/${operation}`, body, headers);
      expectStatus(response, status);
      if (!/private.*no-store/.test(response.headers.get('cache-control') ?? '')) throw new Error('Analytics cache boundary missing');
      check(response.headers.get('vary')?.includes('Cookie') && response.headers.get('vary')?.includes('oai-authenticated-user-id'), 'Analytics identity cache partition missing');
      check(response.headers.get('x-content-type-options') === 'nosniff', 'Analytics response content protection missing');
      expectStatus(await request('/api/eve/status', { headers: identity }), 200);
    }
    for (const [input, status] of [['{', 400], ['null', 400], ['[]', 400], ['true', 400], [' '.repeat(4097), 413]]) {
      const response = await post(`/api/eve/${operation}`, input, { ...identity, origin });
      expectStatus(response, status);
      check(/private.*no-store/.test(response.headers.get('cache-control') ?? ''), 'Analytics invalid input must not be cached');
      expectStatus(await request('/api/eve/status', { headers: identity }), 200);
    }
    const unsupported = await request(`/api/eve/${operation}`, { headers: identity });
    expectStatus(unsupported, 404);
    check(/private.*no-store/.test(unsupported.headers.get('cache-control') ?? ''), 'Analytics GET rejection must not be cached');
    expectStatus(await post(`/api/eve/${operation}`, JSON.stringify({ characterId: 90000001, write: true }), { ...identity, origin }), 400);
  }
  stage = 'blueprint collection streaming request and response protections';
  const collectionBody = JSON.stringify({ characterId: 90000001 });
  for (const [headers, status] of [[{ origin }, 401], [identity, 403], [{ ...identity, origin: 'https://wrong.example' }, 403], [{ ...identity, origin, 'content-type': 'text/plain' }, 415]]) {
    const response = await post('/api/eve/blueprint-collection', collectionBody, headers);
    expectStatus(response, status);
    check(/private.*no-store/.test(response.headers.get('cache-control') ?? ''), 'Collection rejection must not be cached');
    check(response.headers.get('vary')?.includes('Cookie') && response.headers.get('vary')?.includes('oai-authenticated-user-id'), 'Collection identity cache partition missing');
    expectStatus(await request('/api/eve/status', { headers: identity }), 200);
  }
  for (const [input, status] of [['{', 400], ['null', 400], ['[]', 400], ['true', 400], [' '.repeat(4097), 413], [JSON.stringify({ characterId: 0 }), 400], [JSON.stringify({ characterId: 90000001, page: 1 }), 400], [JSON.stringify({ characterId: 90000001, write: true }), 400]]) {
    const response = await post('/api/eve/blueprint-collection', input, { ...identity, origin });
    expectStatus(response, status); check(/private.*no-store/.test(response.headers.get('cache-control') ?? ''), 'Collection invalid input must not be cached');
    expectStatus(await request('/api/eve/status', { headers: identity }), 200);
  }
  expectStatus(await request('/api/eve/blueprint-collection', { headers: identity }), 404);
  const emptyCollection = await post('/api/eve/blueprint-collection', collectionBody, { ...identity, origin });
  expectStatus(emptyCollection, 200);
  check(/^application\/x-ndjson/.test(emptyCollection.headers.get('content-type') ?? ''), 'Collection must use the streaming content type');
  check(/private.*no-store/.test(emptyCollection.headers.get('cache-control') ?? ''), 'Collection stream must not be cached');
  check(emptyCollection.headers.get('vary')?.includes('Cookie') && emptyCollection.headers.get('vary')?.includes('oai-authenticated-user-id'), 'Collection stream identity cache partition missing');
  check(emptyCollection.headers.get('x-content-type-options') === 'nosniff', 'Collection stream content protection missing');
  const collectionEvents = emptyCollection.text.trim().split('\n').map(line => JSON.parse(line));
  check(collectionEvents.at(-1)?.type === 'error' && collectionEvents.at(-1)?.status === 404, 'Unconnected collection must end with an ownership error');
  check(collectionEvents.every(event => event.type !== 'result'), 'Unconnected collection must not produce blueprint results');
  expectStatus(await request('/api/eve/status', { headers: identity }), 200);
  stage = 'blueprint reconciliation streaming request and response protections';
  const reconciliationBody = JSON.stringify({ characterId: 90000001 });
  for (const [headers, status] of [[{ origin }, 401], [identity, 403], [{ ...identity, origin: 'https://wrong.example' }, 403], [{ ...identity, origin, 'content-type': 'text/plain' }, 415]]) {
    const response = await post('/api/eve/blueprint-reconciliation', reconciliationBody, headers);
    expectStatus(response, status);
    check(/private.*no-store/.test(response.headers.get('cache-control') ?? ''), 'Collection rejection must not be cached');
    check(response.headers.get('vary')?.includes('Cookie') && response.headers.get('vary')?.includes('oai-authenticated-user-id'), 'Collection identity cache partition missing');
    expectStatus(await request('/api/eve/status', { headers: identity }), 200);
  }
  for (const [input, status] of [['{', 400], ['null', 400], ['[]', 400], ['true', 400], [' '.repeat(4097), 413], [JSON.stringify({ characterId: 0 }), 400], [JSON.stringify({ characterId: 90000001, page: 1 }), 400], [JSON.stringify({ characterId: 90000001, write: true }), 400]]) {
    const response = await post('/api/eve/blueprint-reconciliation', input, { ...identity, origin });
    expectStatus(response, status); check(/private.*no-store/.test(response.headers.get('cache-control') ?? ''), 'Collection invalid input must not be cached');
    expectStatus(await request('/api/eve/status', { headers: identity }), 200);
  }
  expectStatus(await request('/api/eve/blueprint-reconciliation', { headers: identity }), 404);
  const emptyReconciliation = await post('/api/eve/blueprint-reconciliation', reconciliationBody, { ...identity, origin });
  expectStatus(emptyReconciliation, 200);
  check(/^application\/x-ndjson/.test(emptyReconciliation.headers.get('content-type') ?? ''), 'Collection must use the streaming content type');
  check(/private.*no-store/.test(emptyReconciliation.headers.get('cache-control') ?? ''), 'Collection stream must not be cached');
  check(emptyReconciliation.headers.get('vary')?.includes('Cookie') && emptyReconciliation.headers.get('vary')?.includes('oai-authenticated-user-id'), 'Collection stream identity cache partition missing');
  check(emptyReconciliation.headers.get('x-content-type-options') === 'nosniff', 'Collection stream content protection missing');
  const reconciliationEvents = emptyReconciliation.text.trim().split('\n').map(line => JSON.parse(line));
  check(reconciliationEvents.at(-1)?.type === 'error' && reconciliationEvents.at(-1)?.status === 404, 'Unconnected collection must end with an ownership error');
  check(reconciliationEvents.every(event => event.type !== 'result'), 'Unconnected collection must not produce blueprint results');
  expectStatus(await request('/api/eve/status', { headers: identity }), 200);
  stage = 'preserve-permission reconnect authorization boundaries';
  const reconnectBody = JSON.stringify({ reconnectCharacterId: 90000001 });
  for (const [headers, expected] of [[{ origin }, 401], [{ ...identity, origin: 'https://wrong.example' }, 403], [{ ...identity, origin }, 404]]) {
    const response = await post('/api/eve/connect', reconnectBody, headers);
    expectStatus(response, expected);
    check(response.headers.get('cache-control')?.includes('private') && response.headers.get('cache-control')?.includes('no-store'), 'Reconnect errors must disable shared caching');
    expectStatus(await request('/api/eve/status', { headers: identity }), 200);
  }
  for (const input of [{ reconnectCharacterId: '90000001' }, { reconnectCharacterId: 0 }, { reconnectCharacterId: 90000001, corporation: true }, { reconnectCharacterId: 90000001, corporationFeatures: [] }, { reconnectCharacterId: 90000001, scopes: [] }]) {
    expectStatus(await post('/api/eve/connect', JSON.stringify(input), { ...identity, origin }), 400);
  }
  expectStatus(await request('/api/eve/status', { headers: identity }), 200);
  expectStatus(await post('/mcp', '{'), 400);
  check(typeof (await rpc('ping')).result === 'object', 'MCP ping failed after malformed input');
  stage = 'oversized MCP request';
  expectStatus(await post('/mcp', 'x'.repeat(32001)), 413);
  check(typeof (await rpc('ping')).result === 'object', 'MCP ping failed after oversized input');
  stage = 'valid legacy batch and notification';
  const batch = await post('/mcp', JSON.stringify([
    { jsonrpc: '2.0', method: 'ping', id: 1 },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', method: 'tools/list', id: 2 },
  ]));
  expectStatus(batch, 200);
  check(JSON.parse(batch.text).length === 2, 'Batch must omit notification responses');

  stage = 'production HTML and assets';
  const page = await request('/');
  expectStatus(page, 200);
  check(page.headers.get('content-type')?.includes('text/html') && page.text.includes('OptiEVE'), 'Production page did not render');
  const assetUrls = [...new Set([...page.text.matchAll(/(?:src|href)="([^"#?]+\.(?:js|css)(?:\?[^"#]*)?)"/g)].map(match => match[1]))];
  check(assetUrls.length >= 2, 'Expected production JavaScript and CSS references');
  for (const asset of assetUrls) {
    const url = new URL(asset, base);
    check(url.origin === base, 'Unexpected external asset URL');
    const response = await request(url.pathname + url.search);
    expectStatus(response, 200);
    check(/javascript|text\/css/.test(response.headers.get('content-type') ?? ''), 'Unexpected asset content type');
  }
  stage = 'React server component response';
  let rscPath = '/', rsc;
  for (let redirects = 0; redirects <= 3; redirects++) {
    rsc = await request(rscPath, { headers: { RSC: '1' } });
    if (![301, 302, 303, 307, 308].includes(rsc.status)) break;
    check(redirects < 3 && rsc.headers.has('location'), 'Unexpected React component redirect chain');
    const location = new URL(rsc.headers.get('location'), base + rscPath);
    check(location.origin === base, 'React component redirect must remain on the local worker');
    rscPath = location.pathname + location.search;
  }
  expectStatus(rsc, 200);
  check(rsc.headers.get('content-type')?.includes('text/x-component'), 'Expected a React server component response');
  console.log(`PASS: actual package start; 10 rejected-body request sequences without retries; streamed/oversized requests; overview authorization/cache boundaries; empty synthetic account; MCP manufacturing catalog/requirements without external data, HTML, ${assetUrls.length} assets and React server components`);
} catch (error) {
  console.error(`FAIL: ${stage}: ${error instanceof Failure ? error.message : 'validation operation could not complete'}`);
  process.exitCode = 1;
} finally {
  let stopped = true;
  for (const child of [...children]) {
    try { await stop(child); } catch { stopped = false; process.exitCode = 1; console.error('FAIL: temporary worker cleanup'); }
  }
  if (temporary && stopped) {
    try {
      check(dirname(resolve(temporary)) === realpathSync(tmpdir()) && basename(temporary).startsWith(prefix), 'Unsafe cleanup target');
      check(!lstatSync(temporary).isSymbolicLink(), 'Cleanup root must not be a link');
      rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch { process.exitCode = 1; console.error('FAIL: temporary validation directory cleanup'); }
  }
}
