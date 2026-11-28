import { buildCharacterRequest, type CharacterReadArgs } from './character-data';
import { EveError, listConnections, readCharacterData } from './eve';
import { findPublishedManufacturingItem } from './manufacturing-catalog';
import { walletActivityDate, walletActivityExpiry } from './wallet-analytics';
import type { HistoricalOrder, HistoricalOrders, HistoricalOrdersArgs, HistoricalOrderType } from './historical-orders-types';

const scope = 'esi-markets.read_character_orders.v1';
const limitations = [
  'CCP provides up to 90 days of cancelled and expired orders. The counts describe personal orders in this returned page. Other pages and older orders may be absent.',
  'Dates describe when orders were issued. Closure times, fills and wallet proceeds cannot be determined from these quantities or states.',
  'Unit prices preserve the decimal value received from ESI. Public item labels come from the local catalog. Row numbers apply only to this page.',
];
type Dependencies = {
  connections: (user: string) => Promise<{ characterId: number; scopes: string[] }[]>;
  character: (user: string, args: CharacterReadArgs, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
};
type Selection = Required<HistoricalOrdersArgs>;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
function invalid(): never { throw new Error('Invalid historical order evidence.'); }

export function validateHistoricalOrdersArgs(value: unknown): Selection {
  const fail = (): never => { throw new EveError('Choose a connected character and a history page from 1 to 500.'); };
  if (!record(value)) return fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return fail();
  for (const key of Reflect.ownKeys(value)) {
    if ((key !== 'characterId' && key !== 'page') || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')) return fail();
  }
  for (const key in value) if (!Object.hasOwn(value, key)) return fail();
  if (!Object.hasOwn(value, 'characterId') || !integer(value.characterId, 1)) return fail();
  const page = Object.hasOwn(value, 'page') ? value.page : 1;
  if (!integer(page, 1) || page > 500) return fail();
  return { characterId: value.characterId, page };
}

function blank({ characterId, page }: Selection, at: number, status: HistoricalOrders['status'], message: string): HistoricalOrders {
  return {
    characterId, generatedAt: new Date(at).toISOString(), status, message, scope,
    coverage: { kind: 'unavailable', page, pages: null, previousPage: page > 1 ? page - 1 : null, nextPage: null, pageLimitReached: false, returnedRows: null, includedRows: null, excludedCorporationRows: null },
    freshness: { state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null },
    summary: null, orders: [], types: [], limitations: [...limitations],
  };
}

function pageEvidence(value: unknown, page: number) {
  if (!record(value) || value.kind !== 'page' || value.page !== page ||
      ['nextBeforeId', 'nextFromId', 'nextFromEvent', 'after', 'before'].some(key => value[key] != null)) return invalid();
  const pages = value.pages;
  if (pages !== null && !integer(pages, page)) return invalid();
  const more = pages === null ? null : pages > page;
  const nextPage = more && page < 500 ? page + 1 : null;
  const pageLimitReached = page === 500 && more !== false;
  if (value.pageLimit !== 500 || value.morePagesAvailable !== more || value.nextPage !== nextPage || value.pageLimitReached !== pageLimitReached) return invalid();
  return { page, pages, previousPage: page > 1 ? page - 1 : null, nextPage, pageLimitReached };
}

function headerDate(value: unknown): string | null {
  const iso = walletActivityDate(value);
  if (iso) return iso;
  if (typeof value !== 'string' || value.length > 100) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toUTCString() !== value) return null;
  const stamp = date.toISOString();
  return stamp.length === 24 ? stamp : null;
}

function unitPrice(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return invalid();
  const text = String(value);
  // At this upper bound the only exponential spellings are below one.
  const [coefficient, negativeExponent] = text.split('e-');
  if (negativeExponent === undefined) return text;
  return '0.' + '0'.repeat(Number(negativeExponent) - 1) + coefficient.replace('.', '');
}

function typeLabel(typeId: number): HistoricalOrderType {
  const name = findPublishedManufacturingItem(typeId)?.name;
  if (typeof name === 'string' && name.length > 0 && name.length <= 128 && name.trim() === name &&
      !/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(name)) return { typeId, name, mapped: true };
  return { typeId, name: 'Type ' + typeId, mapped: false };
}

function normalize(value: unknown, selected: Selection, args: CharacterReadArgs, now: () => number): HistoricalOrders {
  if (!record(value) || value.characterId !== selected.characterId || value.dataset !== 'order_history' ||
      value.source !== 'https://esi.evetech.net' + buildCharacterRequest(args).path ||
      value.entity !== undefined && value.entity !== 'character' || value.corporationId != null || value.division != null || value.page != null ||
      !Array.isArray(value.data) || value.data.length > 5000) return invalid();
  const paging = pageEvidence(value.pagination, selected.page);
  const retrievedAt = walletActivityDate(value.retrievedAt);
  if (!retrievedAt) return invalid();
  const ids = new Set<number>(), types = new Map<number, HistoricalOrderType>();
  const included: HistoricalOrder[] = [];
  let buy = 0, cancelled = 0, expired = 0;
  for (const row of value.data) {
    if (!record(row) || !integer(row.order_id, 1) || ids.has(row.order_id) || !integer(row.type_id, 1) ||
        typeof row.is_corporation !== 'boolean' || Object.hasOwn(row, 'is_buy_order') && typeof row.is_buy_order !== 'boolean' ||
        typeof row.state !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(row.state) ||
        !integer(row.volume_total) || !integer(row.volume_remain) || row.volume_remain > row.volume_total) return invalid();
    ids.add(row.order_id);
    const issuedAt = walletActivityDate(row.issued), unitPriceISK = unitPrice(row.price);
    if (!issuedAt) return invalid();
    if (row.is_corporation) continue;
    const state = row.state === 'cancelled' || row.state === 'expired' ? row.state : 'other';
    const side = row.is_buy_order ? 'buy' : 'sell';
    if (side === 'buy') buy++;
    if (state === 'cancelled') cancelled++;
    if (state === 'expired') expired++;
    if (!types.has(row.type_id)) types.set(row.type_id, typeLabel(row.type_id));
    // Use the provider ID to break ties only until the page ordinals are assigned.
    included.push({ row: row.order_id, typeId: row.type_id, state, side, unitPriceISK, issuedAt,
      originalQuantity: row.volume_total, remainingQuantity: row.volume_remain });
  }
  included.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt) || a.row - b.row);
  included.forEach((order, index) => { order.row = index + 1; });
  const labels = [...types.values()].sort((a, b) => a.typeId - b.typeId);
  const at = now();
  if (Date.parse(retrievedAt) > at + 60000) return invalid();
  const cacheExpires = walletActivityDate(walletActivityExpiry(value, Date.parse(retrievedAt)));
  const freshness = { state: cacheExpires === null ? 'unknown' : Date.parse(cacheExpires) <= at ? 'stale' : 'fresh', retrievedAt, cacheExpires, lastModified: headerDate(value.lastModified) } as const;
  const other = included.length - expired - cancelled;
  const ready = paging.pages === 1 && freshness.state === 'fresh' && other === 0;
  const result = blank(selected, at, ready ? 'ready' : 'partial', 'One returned page of personal historical orders.');
  result.freshness = freshness;
  result.coverage = { kind: 'returned_page', ...paging, returnedRows: value.data.length, includedRows: included.length, excludedCorporationRows: value.data.length - included.length };
  result.orders = included;
  result.types = labels;
  result.summary = { orders: included.length, types: labels.length, buy, sell: included.length - buy, cancelled, expired, other,
    unmappedTypes: labels.filter(type => !type.mapped).length,
    latestIssuedAt: included[0]?.issuedAt ?? null, earliestIssuedAt: included.at(-1)?.issuedAt ?? null };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 4 * 1024 * 1024) return invalid();
  return result;
}

async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
  });
  void interrupted.catch(() => {});
  try {
    const result = await Promise.race([interrupted, work()]);
    signal.throwIfAborted();
    return result;
  } finally { signal.removeEventListener('abort', cancel); }
}

export function createHistoricalOrdersReader(dependencies: Dependencies) {
  return async (user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<HistoricalOrders> => {
    if (typeof user !== 'string' || !user) throw new EveError('Sign in to read order history.', 401);
    const selected = validateHistoricalOrdersArgs(input), now = dependencies.now ?? Date.now;
    const deadline = now() + 55000, timeout = AbortSignal.timeout(55000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const check = () => { signal.throwIfAborted(); if (now() >= deadline) throw Error('Deadline reached'); };
    let owned;
    try {
      check();
      owned = (await abortable(() => dependencies.connections(user), signal)).find(row => row.characterId === selected.characterId);
      check();
    } catch { return blank(selected, now(), 'unavailable', 'Connection status could not be checked.'); }
    if (!owned) throw new EveError('Choose a character connected to this account.', 404);
    if (!owned.scopes.includes(scope)) return blank(selected, now(), 'needs_permission', 'Review the market order read permission in Connections.');
    try {
      const args = { characterId: selected.characterId, dataset: 'order_history', parameters: { page: selected.page } };
      const raw = await abortable(() => dependencies.character(user, args, signal), signal);
      check();
      const result = normalize(raw, selected, args, now);
      check();
      return result;
    } catch (error) {
      if (signal.aborted || now() >= deadline) return blank(selected, now(), 'unavailable', 'The history request was cancelled or timed out.');
      if (error instanceof EveError && [401, 403, 404, 409, 429].includes(error.status)) return blank(selected, now(), 'unavailable', 'This page is unavailable with the current connection or provider response.');
      return blank(selected, now(), 'error', 'The historical order page could not be validated.');
    }
  };
}

export const readHistoricalOrders = createHistoricalOrdersReader({ connections: listConnections, character: readCharacterData });
