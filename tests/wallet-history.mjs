import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const base = Date.parse('2026-03-15T12:00:00Z'), characterId = 90000001, scope = 'esi-wallet.read_character_wallet.v1';
const plain = value => JSON.parse(JSON.stringify(value));
class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
function loadModules() {
  const cache = new Map();
  function load(name) {
    if (name === './eve') return { EveError, readEve: () => { throw Error('Unexpected production read'); } };
    if (name === './wallet-history-storage') return { WALLET_HISTORY_SCOPE: scope, walletHistoryStorage: {} };
    if (cache.has(name)) return cache.get(name);
    const module = { exports: {} };
    vm.runInNewContext(ts.transpileModule(readFileSync(`app/lib/${name.slice(2)}.ts`, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
      module, exports: module.exports, require: load, Date, AbortSignal, crypto: webcrypto,
    });
    cache.set(name, module.exports); return module.exports;
  }
  return load('./wallet-history');
}
const api = loadModules();
const row = (id, amount = 1, extra = {}) => ({ id, amount, date: '2026-03-14T12:00:00Z', ref_type: 'market_transaction', description: 'PRIVATE_DESCRIPTION', reason: 'PRIVATE_REASON', first_party_id: 99999999, balance: 999999, ...extra });
function response(args, extra = {}) {
  return { ...args, pages: 1, nextPage: null, pageLimit: 500, morePagesAvailable: false, pageLimitReached: false, data: [row(1)], retrievedAt: new Date(base).toISOString(), cacheExpires: 'Sun, 15 Mar 2026 13:00:00 GMT', responseDate: 'Sun, 15 Mar 2026 12:00:00 GMT', cacheControl: 'private, max-age=3600', cacheAge: '0', lastModified: 'Sun, 15 Mar 2026 11:00:00 GMT', ...extra };
}
function harness(options = {}) {
  let owner = { epoch: 'epoch-one', scopes: [scope], record: null }, counter = 0, at = base;
  const calls = [], saved = [];
  const store = {
    async load(user, id) { calls.push(['load', user, id]); if (options.onLoad) await options.onLoad(owner); return user === 'synthetic-owner' && id === characterId && owner ? plain(owner) : null; },
    async save(user, id, expected, next, requireGrant) {
      calls.push(['save', user, id]);
      if (options.beforeSave) await options.beforeSave(owner);
      if (!owner || owner.epoch !== expected.epoch || owner.record?.generation !== expected.record?.generation || requireGrant && !owner.scopes.includes(scope)) return false;
      owner.record = plain(next); saved.push(plain(next)); return true;
    },
    async seal(user, id, value) { calls.push(['seal', user, id]); return JSON.stringify(value); },
    async open(user, id, value) { calls.push(['open', user, id]); if (options.onOpen) await options.onOpen(owner); return JSON.parse(value); },
  };
  const run = api.createWalletHistoryService({ storage: store, now: () => at, generation: () => String(++counter).padStart(32, '0'), journal: async (user, args, signal) => { calls.push(['journal', user, plain(args)]); return options.journal ? options.journal(args, signal, owner) : response(args, options.result); } });
  return {
    run: (args, context) => run('synthetic-owner', { characterId, ...args }, context), raw: run,
    enable: (retentionDays = 90) => run('synthetic-owner', { characterId, operation: 'configure', enabled: true, retentionDays }),
    calls, saved, owner: () => owner, disconnect: () => { owner = null; }, time: value => { at = value; },
  };
}

test('default off, no automatic read, and capture requires explicit opt-in', async () => {
  const h = harness(), view = await h.run({ operation: 'status' });
  assert.equal(view.status, 'disabled'); assert.equal(view.settings.enabled, false); assert.equal(view.report.totals, null);
  await assert.rejects(h.run({ operation: 'capture' }), error => error.status === 409);
  assert(!h.calls.some(call => call[0] === 'journal')); assert.equal(h.saved.length, 0);
  await h.enable(); assert(!h.calls.some(call => call[0] === 'journal'));
});
test('manual captures retain only minimal events, deduplicate overlap, and report exact cash flow', async () => {
  const h = harness({ result: { data: [row(1, 0.1), row(2, 0.2), row(3, -0.3), row(4, 12.125, { ref_type: 'player_donation' })] } });
  await h.enable(); const first = await h.run({ operation: 'capture' }), second = await h.run({ operation: 'capture' });
  assert.deepEqual(plain(first.report.totals), { incomingISK: '12.425', outgoingISK: '0.30', netISK: '12.125' });
  assert.equal(second.report.entries, 4); assert.equal(first.lastCapture.addedEntries, 4); assert.equal(second.lastCapture.addedEntries, 0);
  assert.equal(first.status, 'partial'); assert.equal(first.lastCapture.coverage, 'returned_pages');
  assert.equal(first.lastCapture.freshness, 'fresh');
  const report = await h.run({ operation: 'report', days: 90 });
  assert.deepEqual(plain(report.report.totals), plain(first.report.totals)); assert.equal(report.report.days, 90);
  for (const forbidden of ['PRIVATE_DESCRIPTION', 'PRIVATE_REASON', '99999999', 'first_party', '"balance":']) {
    assert(!JSON.stringify(h.saved).includes(forbidden), forbidden); assert(!JSON.stringify(report).includes(forbidden), forbidden);
  }
  assert.equal(report.report.daily.length, 1); assert.equal(report.report.categories.length, 2);
  assert.match(report.limitations.join(' '), /cash flow, not profit/);
});
test('unknown amounts and empty history never become known zero totals', async () => {
  const unknown = row(1); delete unknown.amount;
  const h = harness({ result: { data: [unknown] } }); await h.enable();
  const view = await h.run({ operation: 'capture' }); assert.equal(view.report.totals, null); assert.equal(view.report.missingAmountEntries, 1);
  assert.equal(view.report.daily[0].totals, null);
  const empty = harness({ result: { data: [] } }); await empty.enable();
  const zero = await empty.run({ operation: 'capture' }); assert.equal(zero.status, 'empty'); assert.equal(zero.report.totals, null); assert.equal(zero.report.daily.length, 0);
});
test('at most four journal pages are accepted, with explicit partial coverage', async () => {
  const h = harness({ journal: async args => response(args, { pages: 8, nextPage: args.page + 1, morePagesAvailable: true, data: [row(args.page)] }) }); await h.enable();
  const view = await h.run({ operation: 'capture' }); assert.equal(h.calls.filter(call => call[0] === 'journal').length, 4);
  assert.equal(view.lastCapture.pagesRead, 4); assert.equal(view.lastCapture.pagesAdvertised, 8); assert.equal(view.lastCapture.coverage, 'partial'); assert.equal(view.report.entries, 4);
});
test('unknown pagination accepts only the observed page and reports unknown coverage', async () => {
  const h = harness({ result: { pages: null, morePagesAvailable: null } }); await h.enable();
  const view = await h.run({ operation: 'capture' }); assert.equal(view.lastCapture.pagesRead, 1); assert.equal(view.lastCapture.coverage, 'unknown');
});
for (const [name, changes] of [
  ['wrong owner', { characterId: 90000002 }], ['wrong entity', { entity: 'corporation' }], ['wrong dataset', { dataset: 'wallet_transactions' }],
  ['invalid rows', { data: [row(1), row(1)] }], ['invalid amount', { data: [row(1, '5')] }], ['invalid date', { data: [row(1, 5, { date: '2026-02-30T00:00:00Z' })] }],
  ['invalid reference', { data: [row(1, 5, { ref_type: '<script>' })] }], ['missing page count', { pages: undefined }], ['invalid next page', { nextPage: 2 }],
  ['future response', { retrievedAt: '2027-01-01T00:00:00Z' }], ['oversized page', { data: Array.from({ length: 2501 }, (_, index) => row(index + 1)) }],
]) test(`${name} rejects the entire capture without changing stored history`, async () => {
  const h = harness({ result: changes }); await h.enable(); const before = h.owner().record.encrypted;
  await assert.rejects(h.run({ operation: 'capture' })); assert.equal(h.owner().record.encrypted, before); assert.equal(h.saved.length, 1);
});
test('a failed or conflicting later page cannot leave a partially committed capture', async () => {
  for (const failure of ['duplicate', 'page-count', 'cache-generation', 'error']) {
    const h = harness({ journal: async args => {
      if (args.page === 2 && failure === 'error') throw new EveError('Synthetic denied page', 403);
      return response(args, { pages: args.page === 2 && failure === 'page-count' ? 3 : 2, nextPage: args.page === 1 ? 2 : null, morePagesAvailable: args.page === 1,
        data: [row(args.page === 2 && failure === 'duplicate' ? 1 : args.page)], lastModified: args.page === 2 && failure === 'cache-generation' ? 'changed' : 'Sun, 15 Mar 2026 11:00:00 GMT' });
    } }); await h.enable(); const before = h.owner().record.encrypted;
    await assert.rejects(h.run({ operation: 'capture' })); assert.equal(h.owner().record.encrypted, before);
  }
});
test('conflicting retained event prevents overwrite', async () => {
  let amount = 5; const h = harness({ journal: async args => response(args, { data: [row(1, amount)] }) }); await h.enable(); await h.run({ operation: 'capture' });
  const before = h.owner().record.encrypted; amount = 8;
  await assert.rejects(h.run({ operation: 'capture' }), error => error.status === 409); assert.equal(h.owner().record.encrypted, before);
});
test('retention filters reads without storing anything, and mutation prunes expired events', async () => {
  const h = harness({ result: { data: [row(1, 5, { date: '2026-02-01T00:00:00Z' }), row(2, 7)] } }); await h.enable(); await h.run({ operation: 'capture' });
  assert.equal((await h.run({ operation: 'report', days: 90 })).report.entries, 2);
  assert.equal((await h.run({ operation: 'report', days: 30 })).report.entries, 1);
  const saved = h.saved.length; h.time(base + 100 * 86400000);
  assert.equal((await h.run({ operation: 'report', days: 365 })).report.entries, 0); assert.equal(h.saved.length, saved);
  await h.run({ operation: 'configure', enabled: false, retentionDays: 30 }); assert.equal(JSON.parse(h.owner().record.encrypted).events.length, 0);
});
test('pause preserves observations, clear erases them and leaves capture disabled', async () => {
  const h = harness(); await h.enable(); await h.run({ operation: 'capture' });
  const paused = await h.run({ operation: 'configure', enabled: false, retentionDays: 90 }); assert.equal(paused.report.entries, 1); assert.equal(paused.settings.enabled, false);
  await assert.rejects(h.run({ operation: 'clear', confirm: 'yes' }));
  const cleared = await h.run({ operation: 'clear', confirm: 'delete_wallet_history' }); assert.equal(cleared.settings.enabled, false); assert.equal(cleared.report.entries, 0); assert.equal(cleared.lastCapture, null);
  assert.deepEqual(JSON.parse(h.owner().record.encrypted), { version: 1, events: [], lastCapture: null });
});
test('pause without a retention option preserves the current server choice after another client changes it', async () => {
  const h = harness({ result: { data: [row(1, 5, { date: '2026-01-15T12:00:00Z' })] } });
  await h.enable(90); await h.run({ operation: 'capture' });
  const staleClient = await h.run({ operation: 'status' }); assert.equal(staleClient.settings.retentionDays, 90);
  await h.run({ operation: 'configure', enabled: true, retentionDays: 365 });
  h.time(base + 100 * 86400000);
  const paused = await h.run({ operation: 'configure', enabled: false });
  assert.equal(paused.settings.enabled, false); assert.equal(paused.settings.retentionDays, 365);
  assert.equal(JSON.parse(h.owner().record.encrypted).events.length, 1);
  const report = await h.run({ operation: 'report', days: 365 }); assert.equal(report.report.entries, 1); assert.equal(report.report.totals.netISK, '5.00');
  await assert.rejects(h.run({ operation: 'configure', enabled: true }), error => error.status === 400);
  await assert.rejects(h.run({ operation: 'configure', enabled: false, retentionDays: 12 }), error => error.status === 400);
  await assert.rejects(h.run({ operation: 'configure', enabled: false, retentionDays: undefined }), error => error.status === 400);
});
test('increasing retention cannot resurrect logically expired observations or capture metadata', async () => {
  const h = harness(); await h.enable(30); await h.run({ operation: 'capture' });
  h.time(base + 40 * 86400000);
  assert.equal((await h.run({ operation: 'status' })).lastCapture, null);
  const expanded = await h.run({ operation: 'configure', enabled: true, retentionDays: 365 });
  assert.equal(expanded.report.entries, 0); assert.equal(expanded.lastCapture, null);
  assert.equal(JSON.parse(h.owner().record.encrypted).events.length, 0);
  assert.equal((await h.run({ operation: 'report', days: 365 })).report.entries, 0);
});
test('scope loss hides stored data but still permits pause and erasure', async () => {
  const h = harness(); await h.enable(); await h.run({ operation: 'capture' }); h.owner().scopes = [];
  const status = await h.run({ operation: 'status' }); assert.equal(status.report.entries, 0); assert.equal(status.lastCapture, null);
  for (const operation of ['capture', 'report']) await assert.rejects(h.run({ operation }), error => error.status === 403);
  await assert.rejects(h.enable(), error => error.status === 403);
  const paused = await h.run({ operation: 'configure', enabled: false, retentionDays: 90 }); assert.equal(paused.report.entries, 0);
  h.owner().record.encrypted = 'corrupted'; await h.run({ operation: 'clear', confirm: 'delete_wallet_history' });
  assert.equal(h.owner().record.enabled, false);
});
test('scope loss during pause still permits disabling but cannot expose retained financial data', async () => {
  let revoke = false;
  const h = harness({ beforeSave: owner => { if (revoke) owner.scopes = []; } });
  await h.enable(); await h.run({ operation: 'capture' }); revoke = true;
  const paused = await h.run({ operation: 'configure', enabled: false, retentionDays: 90 });
  assert.equal(paused.settings.enabled, false); assert.equal(paused.report.entries, 0); assert.equal(paused.lastCapture, null);
  assert.equal(JSON.parse(h.owner().record.encrypted).events.length, 1);
});
test('a full bounded history rejects new events without replacing the saved payload', async () => {
  const h = harness({ result: { data: [row(10001)] } }); await h.enable();
  h.owner().record.encrypted = JSON.stringify({ version: 1, lastCapture: null, events: Array.from({ length: 10000 }, (_, index) => ({ id: index + 1, date: '2026-03-14T12:00:00.000Z', amount: '1.00', category: 'market' })) });
  const before = h.owner().record.encrypted;
  await assert.rejects(h.run({ operation: 'capture' }), error => error.status === 409 && /storage is full/.test(error.message));
  assert.equal(h.owner().record.encrypted, before);
});
for (const change of ['pause', 'clear', 'reconnect', 'disconnect', 'scope-loss']) test(`${change} during capture prevents stale work from committing`, async () => {
  let release, reached; const ready = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const h = harness({ journal: async args => { reached(); await gate; return response(args); } }); await h.enable();
  const pending = h.run({ operation: 'capture' }), rejected = assert.rejects(pending, error => error.status === 409); await ready;
  if (change === 'pause') await h.run({ operation: 'configure', enabled: false, retentionDays: 90 });
  if (change === 'clear') await h.run({ operation: 'clear', confirm: 'delete_wallet_history' });
  if (change === 'reconnect') h.owner().epoch = 'replacement';
  if (change === 'disconnect') h.disconnect();
  if (change === 'scope-loss') h.owner().scopes = [];
  release(); await rejected; assert.equal(h.owner()?.record ? JSON.parse(h.owner().record.encrypted).events.length : 0, 0);
});
test('late clear during decryption prevents a report from exposing erased data', async () => {
  let clear = false; const h = harness({ onOpen: async owner => { if (clear) owner.record.generation = 'replacement-generation'; } });
  await h.enable(); await h.run({ operation: 'capture' }); clear = true;
  await assert.rejects(h.run({ operation: 'report' }), error => error.status === 409);
});
test('cancellation while reading prevents storage mutation', async () => {
  const controller = new AbortController(); const h = harness({ journal: async () => { controller.abort(); return new Promise(() => {}); } }); await h.enable();
  await assert.rejects(h.run({ operation: 'capture' }, { signal: controller.signal })); assert.equal(h.saved.length, 1);
});
test('source freshness is checked at capture completion', async () => {
  let h; h = harness({ journal: async args => { h.time(base + 3600001); return response(args); } }); await h.enable();
  const result = await h.run({ operation: 'capture' }); assert.equal(result.lastCapture.freshness, 'stale');
});
test('strict operation arguments and ownership are enforced before upstream reads', async () => {
  const h = harness();
  for (const args of [{ operation: 'status', user: 'other' }, { operation: 'configure', enabled: true }, { operation: 'configure', enabled: 'true', retentionDays: 90 }, { operation: 'report', days: 10000 }, { operation: 'capture', entity: 'corporation' }, { operation: 'clear' }, { operation: 'erase' }]) await assert.rejects(h.run(args), error => error.status === 400);
  await assert.rejects(h.raw('other-user', { characterId, operation: 'status' }), error => error.status === 404);
  await assert.rejects(h.raw('', { characterId, operation: 'status' }), error => error.status === 401);
  assert(!h.calls.some(call => call[0] === 'journal'));
});
