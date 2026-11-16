import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { z } from 'zod';

const at = Date.parse('2026-03-15T12:00:00.000Z'), characterId = 90000001, scope = 'esi-wallet.read_character_wallet.v1';
const plain = value => JSON.parse(JSON.stringify(value));
class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
function modules() {
  const cache = new Map();
  function load(name) {
    if (name === './eve') return { EveError, readEve: () => { throw Error('Production EVE reads are forbidden in this contract test'); } };
    if (name === './wallet-history-storage') return { WALLET_HISTORY_SCOPE: scope, walletHistoryStorage: {} };
    if (name === 'zod') return { z };
    if (cache.has(name)) return cache.get(name);
    const module = { exports: {} };
    const code = ts.transpileModule(readFileSync(`app/lib/${name.slice(2)}.ts`, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(code, { module, exports: module.exports, require: load, Date, AbortSignal, crypto: webcrypto });
    cache.set(name, module.exports); return module.exports;
  }
  return { service: load('./wallet-history'), client: load('./wallet-history-client') };
}
const { service, client } = modules();
const event = (id, amount, age = 1) => ({ id, date: new Date(at - age * 86400000).toISOString(), ref_type: id === 1 ? 'player_donation' : 'market_transaction', ...(amount === undefined ? {} : { amount }), description: 'OMIT_PRIVATE_DESCRIPTION', balance: 999999, first_party_id: 99000009 });
function page(args, extra = {}) {
  return { ...args, pages: 1, nextPage: null, pageLimit: 500, morePagesAvailable: false, pageLimitReached: false, data: [event(1, 0.1), event(2, 0.2), event(3, -0.3)], retrievedAt: new Date(at).toISOString(), cacheExpires: 'Sun, 15 Mar 2026 13:00:00 GMT', responseDate: 'Sun, 15 Mar 2026 12:00:00 GMT', cacheControl: 'private, max-age=3600', cacheAge: '0', lastModified: 'Sun, 15 Mar 2026 11:00:00 GMT', ...extra };
}
function harness(journal = async args => page(args), clock = at) {
  let owner = { epoch: 'synthetic-epoch', scopes: [scope], record: null }, generation = 0;
  const calls = [];
  // A synthetic persistence adapter isolates the shared service/response contract.
  // Crypto and SQL behavior are exercised separately by storage tests.
  const storage = {
    async load(user, id) { assert.equal(user, 'synthetic-owner'); assert.equal(id, characterId); return plain(owner); },
    async save(_user, _id, previous, next, requireGrant) {
      if (previous.epoch !== owner.epoch || previous.record?.generation !== owner.record?.generation || requireGrant && !owner.scopes.includes(scope)) return false;
      owner.record = plain(next); return true;
    },
    async open(_user, _id, value) { return JSON.parse(value); },
    async seal(_user, _id, value) { return JSON.stringify(value); },
  };
  const run = service.createWalletHistoryService({ storage, journal: async (_user, args) => { calls.push(plain(args)); return journal(args); }, now: () => clock, generation: () => String(++generation).padStart(32, '0') });
  return {
    async action(operation) {
      const args = { characterId, ...operation }, result = await run('synthetic-owner', args);
      // Use real browser validation against the real backend projection.
      const checked = client.walletHistoryResponse(result, args); assert.deepEqual(plain(checked), plain(result)); return checked;
    },
    revokeScope() { owner.scopes = []; }, calls,
  };
}

test('real history service and client agree across opt-in, repeated capture, reports, pause and erase', async () => {
  const h = harness();
  const off = await h.action({ operation: 'status' }); assert.equal(off.status, 'disabled'); assert.equal(off.report.totals, null); assert.equal(h.calls.length, 0);
  const enabled = await h.action({ operation: 'configure', enabled: true, retentionDays: 90 }); assert.equal(enabled.status, 'empty'); assert.equal(h.calls.length, 0);
  const captured = await h.action({ operation: 'capture' }); assert.deepEqual(plain(captured.report.totals), { incomingISK: '0.30', outgoingISK: '0.30', netISK: '0.00' }); assert.equal(captured.status, 'partial');
  assert.equal(captured.lastCapture.addedEntries, 3); const repeated = await h.action({ operation: 'capture' }); assert.equal(repeated.lastCapture.addedEntries, 0); assert.equal(repeated.report.entries, 3);
  for (const days of [30, 90, 365]) { const report = await h.action({ operation: 'report', days }); assert.equal(report.report.days, days); assert.equal(report.report.entries, 3); }
  const paused = await h.action({ operation: 'configure', enabled: false, retentionDays: 90 }); assert.equal(paused.status, 'disabled'); assert.equal(paused.report.entries, 3); assert.equal(h.calls.length, 2);
  const erased = await h.action({ operation: 'clear', confirm: 'delete_wallet_history' }); assert.equal(erased.status, 'disabled'); assert.equal(erased.report.totals, null); assert.equal(erased.lastCapture, null); assert.equal(h.calls.length, 2);
  assert(!JSON.stringify(captured).includes('OMIT_PRIVATE')); assert(!JSON.stringify(captured).includes('first_party_id'));
});

test('real partial multi-page capture produces independently correct 30, 90 and 365-day reports', async () => {
  const rows = [event(1, 10, 1), event(2, -3, 45), event(3, 0.1, 120), event(4, 0.2, 360)];
  const h = harness(async args => page(args, { pages: 6, nextPage: args.page + 1, morePagesAvailable: true, data: [rows[args.page - 1]] }));
  await h.action({ operation: 'configure', enabled: true, retentionDays: 365 });
  const capture = await h.action({ operation: 'capture' }); assert.equal(h.calls.length, 4); assert.equal(capture.lastCapture.coverage, 'partial'); assert.equal(capture.lastCapture.pagesAdvertised, 6);
  assert.equal(capture.report.entries, 1); assert.equal(capture.report.totals.netISK, '10.00');
  const ninety = await h.action({ operation: 'report', days: 90 }); assert.equal(ninety.report.entries, 2); assert.equal(ninety.report.totals.netISK, '7.00');
  const year = await h.action({ operation: 'report', days: 365 }); assert.equal(year.report.entries, 4); assert.deepEqual(plain(year.report.totals), { incomingISK: '10.30', outgoingISK: '3.00', netISK: '7.30' });
  const shorter = await h.action({ operation: 'configure', enabled: true, retentionDays: 30 }); assert.equal(shorter.report.entries, 1);
  const bounded = await h.action({ operation: 'report', days: 365 }); assert.equal(bounded.report.entries, 1); assert.equal(bounded.report.totals.netISK, '10.00');
});

test('mixed page freshness remains unknown, and known stale evidence takes precedence', async () => {
  for (const stale of [false, true]) {
    const h = harness(async args => page(args, { pages: 2, nextPage: args.page === 1 ? 2 : null, morePagesAvailable: args.page === 1, data: [event(args.page, 1)], ...(args.page === 2 ? { cacheExpires: null, cacheControl: null, responseDate: null } : stale ? { cacheExpires: 'Sun, 15 Mar 2026 11:00:00 GMT', cacheControl: 'no-cache' } : {}) }));
    await h.action({ operation: 'configure', enabled: true, retentionDays: 90 }); const value = await h.action({ operation: 'capture' });
    assert.equal(value.lastCapture.coverage, 'returned_pages'); assert.equal(value.lastCapture.freshness, stale ? 'stale' : 'unknown');
    if (!stale) assert.equal(value.lastCapture.cacheExpires, null);
  }
});

test('scope loss preserves status and erasure controls without exposing saved finance', async () => {
  const h = harness(); await h.action({ operation: 'configure', enabled: true, retentionDays: 90 }); await h.action({ operation: 'capture' }); h.revokeScope();
  await assert.rejects(h.action({ operation: 'report', days: 30 }), error => error.status === 403);
  const status = await h.action({ operation: 'status' }); assert.equal(status.settings.enabled, true); assert.equal(status.report.entries, 0); assert.equal(status.lastCapture, null);
  const paused = await h.action({ operation: 'configure', enabled: false, retentionDays: 30 }); assert.equal(paused.status, 'disabled'); assert.equal(paused.report.totals, null);
  const erased = await h.action({ operation: 'clear', confirm: 'delete_wallet_history' }); assert.equal(erased.report.entries, 0); assert.equal(erased.lastCapture, null); assert.equal(h.calls.length, 1);
});

test('real empty and missing-amount captures never become numeric zero reports', async () => {
  for (const data of [[], [event(1, undefined)]]) {
    const h = harness(async args => page(args, { data })); await h.action({ operation: 'configure', enabled: true, retentionDays: 90 });
    const value = await h.action({ operation: 'capture' }); assert.equal(value.report.entries, data.length); assert.equal(value.report.totals, null); assert.equal(value.report.missingAmountEntries, data.length);
  }
});

test('pause without a retention override preserves another client’s current settings and older observations', async () => {
  const h = harness(async args => page(args, { data: [event(1, 12, 45)] }));
  await h.action({ operation: 'configure', enabled: true, retentionDays: 90 }); await h.action({ operation: 'capture' });
  const oldView = await h.action({ operation: 'report', days: 90 }); assert.equal(oldView.settings.retentionDays, 90); assert.equal(oldView.report.entries, 1);
  await h.action({ operation: 'configure', enabled: true, retentionDays: 365 });
  const paused = await h.action({ operation: 'configure', enabled: false }); assert.equal(paused.settings.retentionDays, 365); assert.equal(paused.settings.enabled, false);
  const retained = await h.action({ operation: 'report', days: 365 }); assert.equal(retained.report.entries, 1); assert.equal(retained.report.totals.netISK, '12.00');
});

test('rolling year with permitted midnight clock skew can cover 367 UTC dates', async () => {
  const clock = Date.parse('2026-03-15T23:59:30.000Z');
  const data = Array.from({ length: 366 }, (_, i) => ({ ...event(i + 1, 1), date: new Date(clock - i * 86400000).toISOString() }));
  data.push({ ...event(367, 1), date: new Date(clock + 45000).toISOString() });
  const h = harness(async args => page(args, { data, retrievedAt: new Date(clock).toISOString(), responseDate: new Date(clock).toUTCString(), cacheExpires: new Date(clock + 3600000).toUTCString() }), clock);
  await h.action({ operation: 'configure', enabled: true, retentionDays: 365 }); await h.action({ operation: 'capture' });
  const year = await h.action({ operation: 'report', days: 365 });
  assert.equal(year.report.daily.length, 367); assert.equal(year.report.entries, 367); assert.equal(year.report.totals.netISK, '367.00');
  assert.equal(year.report.earliest, new Date(clock - 365 * 86400000).toISOString()); assert.equal(year.report.latest, '2026-03-16T00:00:15.000Z');
  const tooFar = plain(year); tooFar.report.latest = '2026-03-16T00:00:31.000Z';
  assert.throws(() => client.walletHistoryResponse(tooFar, { characterId, operation: 'report', days: 365 }), /incomplete response/);
});


test('real service and client agree on adjacent seven-day observed cashflow without another capture', async () => {
  const data = [event(1, 0.1, 1), event(2, 0.2, 7), event(3, -0.3, 8), event(4, 4, 14), event(5, 100, 14.00001)];
  const h = harness(async args => page(args, { data }));
  await h.action({ operation: 'configure', enabled: true, retentionDays: 30 }); await h.action({ operation: 'capture' });
  const result = await h.action({ operation: 'report', days: 7, comparePrevious: true });
  assert.equal(result.report.entries, 2); assert.equal(result.report.totals.netISK, '0.30');
  assert.equal(result.comparison.previous.entries, 2); assert.equal(result.comparison.previous.totals.netISK, '3.70');
  assert.deepEqual(plain(result.comparison.observedDelta), { incomingISK: '-3.70', outgoingISK: '-0.30', netISK: '-3.40' });
  assert.equal(result.comparison.current.startsAt, '2026-03-08T12:00:00.000Z');
  assert.equal(result.comparison.previous.startsAt, '2026-03-01T12:00:00.000Z');
  assert.equal(result.comparison.previous.endsBefore, result.comparison.current.startsAt);
  await h.action({ operation: 'configure', enabled: false });
  assert.equal((await h.action({ operation: 'report', days: 7, comparePrevious: true })).comparison.observedDelta.netISK, '-3.40');
  assert.equal(h.calls.length, 1);
  h.revokeScope(); await assert.rejects(h.action({ operation: 'report', days: 7, comparePrevious: true }), error => error.status === 403);
  assert.equal((await h.action({ operation: 'status' })).comparison, undefined);
});

test('real comparison keeps retention limits and missing amounts visible to browser validation', async () => {
  for (const missing of [false, true]) {
    const h = harness(async args => page(args, { data: [event(1, 2, 1), event(2, missing ? undefined : 4, 10)] }));
    await h.action({ operation: 'configure', enabled: true, retentionDays: 30 }); await h.action({ operation: 'capture' });
    const week = await h.action({ operation: 'report', days: 7, comparePrevious: true });
    assert.equal(week.comparison.previous.missingAmountEntries, missing ? 1 : 0);
    assert.equal(week.comparison.observedDelta?.netISK ?? null, missing ? null : '-2.00');
    const month = await h.action({ operation: 'report', days: 30, comparePrevious: true });
    assert.equal(month.comparison.previous.retentionClipped, true); assert.equal(month.comparison.previous.totals, null); assert.equal(month.comparison.observedDelta, null);
    assert.equal((await h.action({ operation: 'report', days: 7 })).comparison, undefined); assert.equal(h.calls.length, 1);
  }
});
