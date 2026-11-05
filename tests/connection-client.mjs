import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync('app/lib/connection-client.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function harness(fetch = () => { throw Error('Unexpected request'); }, timers = {}) {
  const fixtureModule = { exports: {} };
  vm.runInNewContext(code, { module: fixtureModule, exports: fixtureModule.exports, URL, AbortController, setTimeout, clearTimeout, fetch, ...timers });
  return fixtureModule.exports;
}
const validStatus = () => ({
  configured: false, clientId: null,
  setupUrl: 'https://connector.example', callbackUrl: 'https://connector.example/eve/callback',
  characters: [{ characterId: 90000001, corporationId: 98000001, name: 'Synthetic Pilot', scopes: ['esi-fixture.read.v1'] }],
  scopes: { character: ['esi-fixture.read.v1'], corporation: [] },
});

test('callback failures use only own allowlisted keys', () => {
  const { callbackError } = harness();
  const fallback = callbackError(null);
  assert.match(callbackError('expired'), /expired/);
  for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '', 'unknown', '<b>unexpected</b>']) {
    assert.equal(callbackError(key), fallback);
    assert.equal(typeof callbackError(key), 'string');
  }
});

test('complete status accepts synthetic data and ignores future optional fields', () => {
  const status = { ...validStatus(), future: { value: true } };
  assert.equal(harness().connectionStatus(status), status);
});

test('eight independently selectable read features are accepted and scope substitutions rejected', () => {
  const definitions = [
    ['contracts', 'esi-contracts.read_corporation_contracts.v1'], ['industry', 'esi-industry.read_corporation_jobs.v1'],
    ['projects', 'esi-corporations.read_projects.v1'], ['blueprints', 'esi-corporations.read_blueprints.v1'],
    ['facilities', 'esi-corporations.read_facilities.v1'], ['structures', 'esi-corporations.read_structures.v1'],
    ['extractions', 'esi-industry.read_corporation_mining.v1'], ['freelance', 'esi-corporations.read_freelance_jobs.v1'],
  ];
  const status = { ...validStatus(), corporationFeatures: definitions.map(([id, scope]) => ({ id, scope, label: id, description: 'Synthetic read option.' })) };
  assert.equal(harness().connectionStatus(status), status);
  for (const feature of status.corporationFeatures) {
    const selected = { ...validStatus(), corporationFeatures: [feature] };
    assert.equal(harness().connectionStatus(selected), selected);
    for (const scope of ['esi-ui.open_window.v1', 'esi-mail.send_mail.v1', 'esi-wallet.read_character_wallet.v1']) {
      assert.throws(() => harness().connectionStatus({ ...selected, corporationFeatures: [{ ...feature, scope }] }), /incomplete status/);
    }
  }
  status.corporationFeatures.push({ ...status.corporationFeatures[0] });
  assert.throws(() => harness().connectionStatus(status), /incomplete status/);
});

for (const [name, mutate] of [
  ['missing characters', status => { delete status.characters; }],
  ['wrong character collection', status => { status.characters = {}; }],
  ['missing scopes', status => { delete status.scopes; }],
  ['non-string scope', status => { status.scopes.character = [false]; }],
  ['malformed character name', status => { status.characters[0].name = {}; }],
  ['unsafe identifier', status => { status.characters[0].characterId = Number.MAX_SAFE_INTEGER + 1; }],
  ['invalid corporation identifier', status => { status.characters[0].corporationId = -1; }],
  ['duplicate character identifier', status => { status.characters.push({ ...status.characters[0], name: 'Another synthetic name' }); }],
  ['script link', status => { status.setupUrl = 'javascript:alert(1)'; }],
  ['relative callback', status => { status.callbackUrl = '/eve/callback'; }],
  ['non-boolean configured flag', status => { status.configured = 'false'; }],
  ['unknown optional corporation feature', status => { status.corporationFeatures = [{ id: 'member_tracking', label: 'Invalid', scope: 'esi-fixture.read.v1', description: 'Invalid' }]; }],
  ['invalid corporation feature shape', status => { status.corporationFeatures = [null]; }],
  ['coerced corporation feature', status => { status.corporationFeatures = [{ id: ['projects'], label: 'Projects', scope: 'esi-corporations.read_projects.v1', description: 'Read projects' }]; }],
  ['duplicate corporation features', status => { const feature = { id: 'projects', label: 'Projects', scope: 'esi-corporations.read_projects.v1', description: 'Read projects' }; status.corporationFeatures = [feature, feature]; }],
]) {
  test(`malformed status rejects ${name} before rendering`, () => {
    const status = validStatus(); mutate(status);
    assert.throws(() => harness().connectionStatus(status), /incomplete status/);
  });
}

test('sign-in destinations require the exact EVE HTTPS origin without credentials', () => {
  const { signInUrl } = harness();
  assert.equal(signInUrl({ url: 'https://login.eveonline.com/v2/oauth/authorize?state=synthetic' }), 'https://login.eveonline.com/v2/oauth/authorize?state=synthetic');
  const withCredentials = new URL('https://login.eveonline.com/');
  withCredentials.username = 'synthetic';
  withCredentials.password = 'fixture';
  for (const value of [null, {}, { url: false }, { url: 'https://login.eveonline.com.example/' }, { url: 'javascript:alert(1)' }, { url: 'http://login.eveonline.com/' }, { url: withCredentials.href }]) {
    assert.throws(() => signInUrl(value), /unexpected sign-in address/);
  }
});

test('signed-out responses provide sign-in recovery even when the gateway returns HTML', async () => {
  const { connectionRequest } = harness(async () => new Response('<html>private gateway details</html>', { status: 401 }));
  await assert.rejects(connectionRequest('status'), error => error.status === 401 && /Sign in/.test(error.message) && !/html|gateway/.test(error.message));
});

test('signed-out responses release the unread body without retaining gateway text', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const client = harness(async () => new Response(body, { status: 401 }));
  await assert.rejects(client.connectionRequest('status'), error => error.status === 401);
  assert.equal(cancelled, true);
});

test('unreadable gateway responses never expose raw content or parser excerpts', async () => {
  const { connectionRequest } = harness(async () => new Response('<html>synthetic upstream details</html>', { status: 502 }));
  await assert.rejects(connectionRequest('status'), error => error.status === 502 && /unreadable response/.test(error.message) && !/html|synthetic/.test(error.message));
});

test('safe backend error strings survive, malformed error values use a generic message', async () => {
  for (const error of ['Reconnect the character.', {}, false, '', 'x'.repeat(513)]) {
    const { connectionRequest } = harness(async () => Response.json({ error }, { status: 403 }));
    await assert.rejects(connectionRequest('status'), result => result.status === 403 && result.message === (error === 'Reconnect the character.' ? error : 'The request could not be completed. Please try again.'));
  }
});

test('network failures use actionable text without leaking transport details', async () => {
  const { connectionRequest } = harness(async () => { throw Error('synthetic transport internals'); });
  await assert.rejects(connectionRequest('status'), /Could not reach the connection service/);
});

test('timeout covers body reads and clears its timer', async () => {
  let expire, cleared = false;
  const { connectionRequest } = harness(async (_url, { signal }) => ({
    ok: true, status: 200,
    json: () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Error('synthetic abort')), { once: true });
      expire();
    }),
  }), { setTimeout: callback => { expire = callback; return 7; }, clearTimeout: id => { assert.equal(id, 7); cleared = true; } });
  await assert.rejects(connectionRequest('status'), /took too long/);
  assert.equal(cleared, true);
});

test('requests stay same-origin, disable caching and send only the explicit body', async () => {
  let calls = [];
  const { connectionRequest } = harness(async (url, options) => { calls.push({ url, options }); return Response.json({ ok: true }); });
  await connectionRequest('status');
  await connectionRequest('disconnect', { characterId: 90000001 });
  assert.equal(calls[0].url, '/api/eve/status');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.method, undefined);
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.body, '{"characterId":90000001}');
});

const characterCatalogue = { exports: {} };
vm.runInNewContext(ts.transpileModule(readFileSync('app/lib/character-data.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { module: characterCatalogue, exports: characterCatalogue.exports });
const featureDefinitions = [
  ['contracts', 'esi-contracts.read_corporation_contracts.v1'], ['industry', 'esi-industry.read_corporation_jobs.v1'],
  ['projects', 'esi-corporations.read_projects.v1'], ['blueprints', 'esi-corporations.read_blueprints.v1'],
  ['facilities', 'esi-corporations.read_facilities.v1'], ['structures', 'esi-corporations.read_structures.v1'],
  ['extractions', 'esi-industry.read_corporation_mining.v1'], ['freelance', 'esi-corporations.read_freelance_jobs.v1'],
];
function permissionStatus(saved = ['esi-assets.read_assets.v1', 'esi-assets.read_corporation_assets.v1']) {
  const value = validStatus();
  value.configured = true; value.clientId = 'synthetic-public-client-id';
  value.scopes = { character: [...characterCatalogue.exports.characterReadScopes], corporation: ['esi-markets.read_corporation_orders.v1', 'esi-assets.read_corporation_assets.v1', 'esi-wallet.read_corporation_wallets.v1'] };
  value.corporationFeatures = featureDefinitions.map(([id, scope]) => ({ id, scope, label: id, description: 'Synthetic read option.' }));
  value.characters[0].scopes = saved;
  return value;
}
const plain = value => JSON.parse(JSON.stringify(value));

test('explicit character and all presets use only the available supported read choices', () => {
  const client = harness(), status = permissionStatus(), original = structuredClone(status);
  const character = client.connectionAccessPreset(status, 'character');
  assert.deepEqual(plain(character), { corporation: false, corporationFeatures: [] });
  assert.equal(client.selectedConnectionScopes(status, character).length, 39);
  const all = client.connectionAccessPreset(status, 'all');
  assert.deepEqual(plain(all), { corporation: true, corporationFeatures: featureDefinitions.map(([id]) => id) });
  const scopes = plain(client.selectedConnectionScopes(status, all));
  assert.equal(scopes.length, 50); assert.equal(new Set(scopes).size, 50);
  assert.ok(!scopes.some(scope => /write_|send_mail|open_window|respond_calendar|organize_calendar|ui\.write/.test(scope)));
  assert.deepEqual(status, original);
  delete status.corporationFeatures;
  assert.equal(client.selectedConnectionScopes(status, client.connectionAccessPreset(status, 'all')).length, 42);
});

test('custom access rejects stale, duplicate and unknown feature selections', () => {
  const client = harness(), status = permissionStatus();
  assert.equal(client.selectedConnectionScopes(status, { corporation: false, corporationFeatures: ['projects'] }).length, 40);
  for (const selection of [
    { corporation: 'true', corporationFeatures: [] }, { corporation: true, corporationFeatures: 'projects' },
    { corporation: false, corporationFeatures: ['projects', 'projects'] },
    { corporation: true, corporationFeatures: ['unknown'] }, { corporation: true, corporationFeatures: ['__proto__'] },
  ]) assert.throws(() => client.selectedConnectionScopes(status, selection), /selection has changed/);
  status.corporationFeatures = [];
  assert.throws(() => client.selectedConnectionScopes(status, { corporation: true, corporationFeatures: ['projects'] }), /selection has changed/);
});

test('reconnect review preserves older character and partial legacy corporation permissions exactly', () => {
  const client = harness(), status = permissionStatus();
  const review = client.reviewReconnect(status, 90000001);
  assert.deepEqual(plain(review.scopes), ['esi-assets.read_assets.v1', 'esi-assets.read_corporation_assets.v1']);
  assert.equal(review.omittedScopeCount, 0);
  assert.equal(review.characterId, 90000001);
  assert.equal(review.name, 'Synthetic Pilot');
  assert.equal(client.reconnectReviewIsCurrent(status, review), true);
  assert.deepEqual(plain(client.reconnectAuthorization(status, review)), { reconnectCharacterId: 90000001 });
  assert.equal(status.characters[0].scopes.length, 2);
});

test('existing 48-scope reconnect stays unchanged when only explicit All expands to 50', () => {
  const client = harness(), status = permissionStatus();
  const newFeatures = status.corporationFeatures.splice(6);
  const oldScopes = plain(client.selectedConnectionScopes(status, client.connectionAccessPreset(status, 'all')));
  assert.equal(oldScopes.length, 48);
  status.characters[0].scopes = oldScopes;
  const review = client.reviewReconnect(status, 90000001);
  status.corporationFeatures.push(...newFeatures);
  assert.equal(client.connectionStatus(status), status);
  assert.equal(client.reconnectReviewIsCurrent(status, review), true);
  assert.deepEqual(plain(client.reviewReconnect(status, 90000001).scopes), oldScopes);
  assert.deepEqual(plain(client.reconnectAuthorization(status, review)), { reconnectCharacterId: 90000001 });
  const explicitAll = plain(client.selectedConnectionScopes(status, client.connectionAccessPreset(status, 'all')));
  assert.equal(explicitAll.length, 50);
  for (const feature of newFeatures) {
    assert.ok(explicitAll.includes(feature.scope));
    assert.ok(!review.scopes.includes(feature.scope));
    assert.ok(!status.characters[0].scopes.includes(feature.scope));
  }
});

test('new corporation permissions can each be selected without legacy corporation access', () => {
  const client = harness(), status = permissionStatus();
  for (const [id, scope] of featureDefinitions.slice(6)) {
    const scopes = plain(client.selectedConnectionScopes(status, { corporation: false, corporationFeatures: [id] }));
    assert.equal(scopes.length, 40); assert.ok(scopes.includes(scope));
    assert.ok(status.scopes.corporation.every(legacy => !scopes.includes(legacy)));
  }
});

test('unsupported saved permissions are counted and excluded from the reconnect scope display', () => {
  const client = harness(), status = permissionStatus(['esi-assets.read_assets.v1', 'esi-mail.send_mail.v1', 'esi-ui.open_window.v1', 'esi-future.read_unknown.v1', 'esi-mail.send_mail.v1']);
  const review = client.reviewReconnect(status, 90000001);
  assert.deepEqual(plain(review.scopes), ['esi-assets.read_assets.v1']);
  assert.equal(review.omittedScopeCount, 3);
  assert.deepEqual(plain(client.reconnectAuthorization(status, review)), { reconnectCharacterId: 90000001 });
});

test('reviews never combine permissions from different owned characters', () => {
  const client = harness(), status = permissionStatus(['esi-assets.read_assets.v1']);
  status.characters.push({ characterId: 90000002, corporationId: 98000002, name: 'Other synthetic pilot', scopes: [...status.scopes.character, ...status.scopes.corporation, ...status.corporationFeatures.map(feature => feature.scope)] });
  const first = client.reviewReconnect(status, 90000001), second = client.reviewReconnect(status, 90000002);
  assert.equal(first.scopes.length, 1); assert.equal(second.scopes.length, 50);
  assert.deepEqual(plain(client.reconnectAuthorization(status, first)), { reconnectCharacterId: 90000001 });
  assert.deepEqual(plain(client.reconnectAuthorization(status, second)), { reconnectCharacterId: 90000002 });
  assert.throws(() => client.reviewReconnect(status, 90000003), /no longer ready/);
  assert.throws(() => client.reviewReconnect(status, '90000001'), /no longer ready/);
});

for (const [name, mutate] of [
  ['character removed', status => status.characters = []],
  ['character renamed', status => status.characters[0].name = 'Changed synthetic name'],
  ['saved grant removed', status => status.characters[0].scopes.pop()],
  ['saved grant added', status => status.characters[0].scopes.push('esi-wallet.read_character_wallet.v1')],
  ['unsupported grant changed', status => status.characters[0].scopes.push('esi-ui.open_window.v1')],
  ['supported scope retired', status => status.scopes.corporation = []],
  ['configuration removed', status => status.configured = false],
]) test(`reconnect review becomes stale when ${name}`, () => {
  const client = harness(), status = permissionStatus(), review = client.reviewReconnect(status, 90000001);
  mutate(status);
  assert.equal(client.reconnectReviewIsCurrent(status, review), false);
  assert.throws(() => client.reconnectAuthorization(status, review), /permissions changed/);
});

test('a supported catalogue update does not silently add permissions to an existing reconnect', () => {
  const client = harness(), status = permissionStatus(), review = client.reviewReconnect(status, 90000001);
  status.scopes.character.push('esi-future.read_character_context.v1');
  assert.equal(client.reconnectReviewIsCurrent(status, review), true);
  assert.equal(client.reviewReconnect(status, 90000001).scopes.length, 2);
  assert.deepEqual(plain(client.reconnectAuthorization(status, review)), { reconnectCharacterId: 90000001 });
});

test('review tampering and an empty supported subset cannot continue', () => {
  const client = harness(), status = permissionStatus(), review = client.reviewReconnect(status, 90000001);
  for (const mutate of [review => review.scopes.push('esi-wallet.read_character_wallet.v1'), review => review.characterId++, review => review.omittedScopeCount++, review => review.grantSnapshot = '[]']) {
    const changed = structuredClone(review); mutate(changed);
    assert.throws(() => client.reconnectAuthorization(status, changed), /permissions changed/);
  }
  const retired = permissionStatus(['esi-future.read_unknown.v1']);
  const empty = client.reviewReconnect(retired, 90000001);
  assert.equal(empty.scopes.length, 0); assert.equal(empty.omittedScopeCount, 1);
  assert.throws(() => client.reconnectAuthorization(retired, empty), /No supported permissions remain/);
});

test('reconnect review performs no request and explicit continue sends only the character target', async () => {
  const calls = [], status = permissionStatus();
  const client = harness(async (url, options) => { calls.push({ url, options }); return Response.json({ url: 'https://login.eveonline.com/v2/oauth/authorize?state=synthetic' }); });
  const review = client.reviewReconnect(status, 90000001), body = client.reconnectAuthorization(status, review);
  assert.equal(calls.length, 0);
  await client.connectionRequest('connect', body);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/eve/connect');
  assert.equal(calls[0].options.body, '{"reconnectCharacterId":90000001}');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(status.clientId, 'synthetic-public-client-id');
});

test('wrong-character and permission-set callback failures have safe recovery text', () => {
  const client = harness();
  assert.match(client.callbackError('character_mismatch'), /different character/);
  assert.match(client.callbackError('permissions'), /do not match this sign-in/);
});
