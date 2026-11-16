import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync('app/lib/wallet-history-storage.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
class EveError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const module = { exports: {} };
vm.runInNewContext(code, { module, exports: module.exports, require: name => name === 'cloudflare:workers' ? { env: {} } : { EveError }, crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, atob, btoa });
const { createWalletHistoryStorage, WALLET_HISTORY_MAX_BYTES } = module.exports;
const migrations = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')).entries.map(entry => readFileSync(`drizzle/${entry.tag}.sql`, 'utf8'));
const scope = 'esi-wallet.read_character_wallet.v1', characterId = 90000001;
const insertOld = (sqlite, user = 'synthetic-owner') => sqlite.prepare('INSERT INTO eve_connections(user_id,character_id,name,corporation_id,scopes,encrypted,expires) VALUES(?,?,?,?,?,?,?)').run(user, characterId, 'Synthetic pilot', 98000001, JSON.stringify([scope]), 'synthetic-encrypted-token-unchanged', 9000000000000);
function harness() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON;');
  for (const migration of migrations) sqlite.exec(migration);
  insertOld(sqlite);
  const d1 = { prepare(sql) { return { bind(...args) { return {
    async first() { return sqlite.prepare(sql).get(...args) ?? null; },
    async run() { return { meta: sqlite.prepare(sql).run(...args) }; },
  }; } }; } };
  let secret = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64');
  return { sqlite, storage: createWalletHistoryStorage(() => d1, () => secret), key: value => { secret = value; } };
}
const next = (encrypted = 'synthetic-ciphertext', generation = 'first-generation-000000000000') => ({ generation, enabled: true, retentionDays: 90, encrypted });

test('additive migration preserves nonempty v26 settings, authorizations and pending OAuth bytes', () => {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON;'); sqlite.exec(migrations[0]);
  insertOld(sqlite); sqlite.prepare('INSERT INTO eve_settings VALUES(?,?)').run('synthetic-owner', 'synthetic-client-id');
  sqlite.prepare('INSERT INTO eve_oauth_states VALUES(?,?,?,?)').run('synthetic-state', 'synthetic-owner', 'synthetic-encrypted-state', 9000000000000);
  const before = ['eve_connections', 'eve_settings', 'eve_oauth_states'].map(table => sqlite.prepare(`SELECT * FROM ${table}`).all());
  for (const migration of migrations.slice(1)) sqlite.exec(migration);
  const connection = sqlite.prepare('SELECT * FROM eve_connections').get();
  assert.equal(connection.history_epoch, ''); delete connection.history_epoch;
  assert.deepEqual(connection, before[0][0]);
  assert.deepEqual(sqlite.prepare('SELECT * FROM eve_settings').all(), before[1]);
  assert.deepEqual(sqlite.prepare('SELECT * FROM eve_oauth_states').all(), before[2]);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM eve_wallet_history').get().n, 0);
  // An old worker's existing refresh update remains valid after migration.
  sqlite.prepare('UPDATE eve_connections SET encrypted=?,expires=?,refresh_lock=NULL,refresh_until=NULL WHERE user_id=? AND character_id=?').run('synthetic-refresh', 9000000000001, 'synthetic-owner', characterId);
  assert.equal(sqlite.prepare('SELECT history_epoch FROM eve_connections').get().history_epoch, '');
  sqlite.close();
});
test('fresh installation has composite history ownership and a cascading connection reference', () => {
  const h = harness();
  assert.throws(() => h.sqlite.prepare('INSERT INTO eve_wallet_history VALUES(?,?,?,?,?,?)').run('not-connected', characterId, 'generation', 1, 90, 'cipher'), /FOREIGN KEY/);
  assert.equal(h.sqlite.prepare('PRAGMA foreign_key_check').all().length, 0); h.sqlite.close();
});
test('history encryption binds user and character, resists tampering, and supports a bounded large payload', async () => {
  const h = harness(), payload = { version: 1, synthetic: 'x'.repeat(100000) };
  const cipher = await h.storage.seal('synthetic-owner', characterId, payload);
  assert(!cipher.includes('synthetic')); assert(!cipher.includes('x'.repeat(50)));
  assert.deepEqual(JSON.parse(JSON.stringify(await h.storage.open('synthetic-owner', characterId, cipher))), payload);
  for (const [user, id, value] of [['different-owner', characterId, cipher], ['synthetic-owner', characterId + 1, cipher], ['synthetic-owner', characterId, `${cipher.slice(0, -8)}AAAAAAAA`]]) await assert.rejects(h.storage.open(user, id, value), error => error.status === 503);
  await assert.rejects(h.storage.seal('synthetic-owner', characterId, { value: 'x'.repeat(WALLET_HISTORY_MAX_BYTES) }), error => error.status === 409);
  h.key('not-a-key'); await assert.rejects(h.storage.open('synthetic-owner', characterId, cipher), error => error.status === 503); h.sqlite.close();
});
test('actual SQL binds ownership and rejects stale generations without clobbering newer settings', async () => {
  const h = harness(), owner = await h.storage.load('synthetic-owner', characterId);
  assert.equal(owner.record, null);
  assert.equal(await h.storage.load("synthetic-owner' OR 1=1 --", characterId), null);
  assert.equal(await h.storage.save('synthetic-owner', characterId, owner, next(), true), true);
  assert.equal(await h.storage.save('synthetic-owner', characterId, owner, next('late', 'late-generation-0000000000000'), true), false);
  const current = await h.storage.load('synthetic-owner', characterId);
  assert.equal(await h.storage.save('other-owner', characterId, current, next('cross-user'), false), false);
  assert.equal(await h.storage.save('synthetic-owner', characterId, current, { ...next('cleared', 'clear-generation-000000000000'), enabled: false }, false), true);
  assert.equal(await h.storage.save('synthetic-owner', characterId, current, next('late-capture', 'capture-generation-0000000000'), true), false);
  assert.equal((await h.storage.load('synthetic-owner', characterId)).record.encrypted, 'cleared'); h.sqlite.close();
});
test('reconnect epoch, scope loss and disconnect block the real conditional SQL commit', async () => {
  for (const mutation of ['epoch', 'scope', 'disconnect']) {
    const h = harness(), expected = await h.storage.load('synthetic-owner', characterId);
    if (mutation === 'epoch') h.sqlite.prepare('UPDATE eve_connections SET history_epoch=?').run('reconnected');
    if (mutation === 'scope') h.sqlite.prepare('UPDATE eve_connections SET scopes=?').run('[]');
    if (mutation === 'disconnect') h.sqlite.prepare('DELETE FROM eve_connections WHERE user_id=? AND character_id=?').run('synthetic-owner', characterId);
    assert.equal(await h.storage.save('synthetic-owner', characterId, expected, next(), true), false, mutation);
    assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM eve_wallet_history').get().n, 0); h.sqlite.close();
  }
});
test('pause and erase can update the owned row after scope loss without authorizing collection', async () => {
  const h = harness(); await h.storage.save('synthetic-owner', characterId, await h.storage.load('synthetic-owner', characterId), next(), true);
  h.sqlite.prepare('UPDATE eve_connections SET scopes=?').run('[]');
  const owner = await h.storage.load('synthetic-owner', characterId);
  assert.equal(await h.storage.save('synthetic-owner', characterId, owner, { ...next('erased', 'erasure-generation-0000000000'), enabled: false }, false), true);
  h.sqlite.close();
});
test('old and new worker disconnect SQL both cascade history without touching another owner', async () => {
  const h = harness(); insertOld(h.sqlite, 'second-owner');
  for (const user of ['synthetic-owner', 'second-owner']) await h.storage.save(user, characterId, await h.storage.load(user, characterId), next(), true);
  h.sqlite.prepare('DELETE FROM eve_connections WHERE user_id=? AND character_id=?').run('synthetic-owner', characterId);
  assert.equal(await h.storage.load('synthetic-owner', characterId), null);
  assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM eve_wallet_history').get().n, 1);
  assert.equal((await h.storage.load('second-owner', characterId)).record.encrypted, 'synthetic-ciphertext'); h.sqlite.close();
});
test('database write failure does not leave a half-replaced encrypted payload', async () => {
  const h = harness(); await h.storage.save('synthetic-owner', characterId, await h.storage.load('synthetic-owner', characterId), next('before'), true);
  h.sqlite.exec("CREATE TRIGGER fail_history BEFORE UPDATE ON eve_wallet_history BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
  await assert.rejects(h.storage.save('synthetic-owner', characterId, await h.storage.load('synthetic-owner', characterId), next('after', 'replacement-generation-000000'), true), /synthetic failure/);
  assert.equal((await h.storage.load('synthetic-owner', characterId)).record.encrypted, 'before'); h.sqlite.close();
});
