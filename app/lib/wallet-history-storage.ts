import { env } from 'cloudflare:workers';
import { EveError } from './eve';
import type { WalletHistoryDays } from './wallet-history-types';

export const WALLET_HISTORY_MAX_BYTES = 1024 * 1024;
export const WALLET_HISTORY_SCOPE = 'esi-wallet.read_character_wallet.v1';
export type WalletHistoryRecord = { generation: string; enabled: boolean; retentionDays: WalletHistoryDays; encrypted: string };
export type WalletHistoryOwner = { epoch: string; scopes: string[]; record: WalletHistoryRecord | null };
export type WalletHistoryStorage = {
  load(user: string, characterId: number): Promise<WalletHistoryOwner | null>;
  save(user: string, characterId: number, expected: WalletHistoryOwner, record: WalletHistoryRecord, requireGrant: boolean): Promise<boolean>;
  seal(user: string, characterId: number, value: unknown): Promise<string>;
  open(user: string, characterId: number, encrypted: string): Promise<unknown>;
};
const failed = () => new EveError('Private wallet history storage could not be read safely. Clear this history to start again, or retry later.', 503);
function encode(bytes: Uint8Array): string {
  let value = '';
  for (let start = 0; start < bytes.length; start += 8192) value += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(value);
}
function decode(value: string) { return Uint8Array.from(atob(value), byte => byte.charCodeAt(0)); }

/** One encrypted row per owned character. Conditional SQL is the commit boundary. */
export function createWalletHistoryStorage(database: () => D1Database, keyValue: () => string): WalletHistoryStorage {
  async function key() {
    try {
      const bytes = decode(keyValue());
      if (bytes.byteLength !== 32) throw Error();
      return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    } catch { throw new EveError('Secure private history storage is not configured.', 503); }
  }
  const binding = (user: string, characterId: number) => new TextEncoder().encode(`wallet-history:v1:${JSON.stringify([user, characterId])}`);
  return {
    async load(user, characterId) {
      const row = await database().prepare('SELECT c.history_epoch,c.scopes,h.generation,h.enabled,h.retention_days,h.encrypted FROM eve_connections c LEFT JOIN eve_wallet_history h ON h.user_id=c.user_id AND h.character_id=c.character_id WHERE c.user_id=? AND c.character_id=?').bind(user, characterId).first<{ history_epoch: string; scopes: string; generation: string | null; enabled: number | null; retention_days: number | null; encrypted: string | null }>();
      if (!row) return null;
      let scopes: unknown;
      try { scopes = JSON.parse(row.scopes); } catch { throw failed(); }
      if (typeof row.history_epoch !== 'string' || row.history_epoch.length > 100 || !Array.isArray(scopes) || !scopes.every(item => typeof item === 'string')) throw failed();
      let record: WalletHistoryRecord | null = null;
      if (row.generation !== null) {
        if (!/^[a-zA-Z0-9_-]{16,100}$/.test(row.generation) || row.enabled !== 0 && row.enabled !== 1 || ![30, 90, 365].includes(row.retention_days ?? 0) || typeof row.encrypted !== 'string' || row.encrypted.length > 1_500_000) throw failed();
        record = { generation: row.generation, enabled: row.enabled === 1, retentionDays: row.retention_days as WalletHistoryDays, encrypted: row.encrypted };
      }
      return { epoch: row.history_epoch, scopes, record };
    },
    async save(user, characterId, expected, record, requireGrant) {
      // Epoch survives normal refresh, but changes on reconnect. A history
      // generation changes on every mutation, including disable and erasure.
      const previous = expected.record?.generation ?? null;
      const result = await database().prepare(`INSERT INTO eve_wallet_history(user_id,character_id,generation,enabled,retention_days,encrypted)
        SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM eve_connections c WHERE c.user_id=? AND c.character_id=? AND c.history_epoch=? AND (?=0 OR EXISTS(SELECT 1 FROM json_each(c.scopes) WHERE value=?)))
        AND ((? IS NULL AND NOT EXISTS(SELECT 1 FROM eve_wallet_history WHERE user_id=? AND character_id=?)) OR EXISTS(SELECT 1 FROM eve_wallet_history WHERE user_id=? AND character_id=? AND generation=?))
        ON CONFLICT(user_id,character_id) DO UPDATE SET generation=excluded.generation,enabled=excluded.enabled,retention_days=excluded.retention_days,encrypted=excluded.encrypted WHERE eve_wallet_history.generation=?`)
        .bind(user, characterId, record.generation, record.enabled ? 1 : 0, record.retentionDays, record.encrypted, user, characterId, expected.epoch, requireGrant ? 1 : 0, WALLET_HISTORY_SCOPE, previous, user, characterId, user, characterId, previous, previous).run();
      return result.meta.changes === 1;
    },
    async seal(user, characterId, value) {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      if (bytes.byteLength > WALLET_HISTORY_MAX_BYTES) throw new EveError('Private history storage is full. Shorten retention or clear history before capturing again. No new events were saved.', 409);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: binding(user, characterId) }, await key(), bytes);
      return `${encode(iv)}.${encode(new Uint8Array(encrypted))}`;
    },
    async open(user, characterId, encrypted) {
      const secret = await key();
      try {
        if (encrypted.length > 1_500_000) throw Error();
        const pieces = encrypted.split('.');
        if (pieces.length !== 2) throw Error();
        const iv = decode(pieces[0]), bytes = decode(pieces[1]);
        if (iv.length !== 12 || bytes.length > WALLET_HISTORY_MAX_BYTES + 16) throw Error();
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: binding(user, characterId) }, secret, bytes);
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
      } catch { throw failed(); }
    },
  };
}

export const walletHistoryStorage = createWalletHistoryStorage(
  () => { const database = (env as unknown as { DB?: D1Database }).DB; if (!database) throw failed(); return database; },
  () => (env as unknown as { EVE_TOKEN_KEY?: string }).EVE_TOKEN_KEY ?? '',
);
