import { EveError, listConnections, readEve, type ReadArgs } from './eve';
import { overviewDate } from './overview-summary';
import { findPublishedManufacturingItem } from './manufacturing-catalog';
import { walletActivityDecimal, walletActivityBucket, accumulateWalletActivity, walletActivityProject, walletActivityExpiry } from './wallet-analytics';
import type { MarketTransactionsAnalytics, MarketTransactionCell, MarketTransactionType } from './market-transactions-types';

type Dependencies = {
  connections: (user: string) => Promise<{ characterId: number; scopes: string[] }[]>;
  transactions: (user: string, args: ReadArgs, signal?: AbortSignal, options?: { maxResponseBytes?: number }) => Promise<unknown>;
  now?: () => number;
};
type Selection = { characterId: number; entity: 'character' | 'corporation'; division: number | null; fromId: number | null };
type Cell = { date: string; typeId: number; side: 'buy' | 'sell'; entries: number; quantity: bigint; amounts: ReturnType<typeof walletActivityBucket> };
const rowLimit = 2500, responseByteLimit = 2097152, projectionByteLimit = 3145728;
const scopes = { character: 'esi-wallet.read_character_wallet.v1', corporation: 'esi-wallet.read_corporation_wallets.v1' };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
class TransactionDataError extends Error { constructor(readonly kind: 'data' | 'limit' = 'data') { super(); } }
const invalid = (): never => { throw new TransactionDataError(); };
const precisionPolicy = 'Gross values use exact arithmetic on the decimal representation of each received unit-price number multiplied by its reported integer quantity. Totals are not rounded to cents. Quantity sums are exact integer strings within each item; precision already lost in provider JSON numbers cannot be recovered.';
const limitations = [
  'Only one returned transaction batch is included. A cursor can request an older batch, which replaces this result; batches are not combined or saved. A null next cursor does not establish complete account or calendar history.',
  'Cursor boundary records may repeat in a later batch. Returned and included boundary counts are separate; only included rows contribute to the displayed values.',
  'Character results include only rows explicitly marked personal. Corporation-marked rows are counted as excluded, but still determine safe cursor continuation. Corporation results cover only the selected wallet division.',
  'Gross purchase and sale values are traded values, not wallet journal cash flow, fees, taxes, balance, profit, cost basis or current holdings. Do not add these totals to wallet-journal totals.',
  'Quantities are grouped only for the same item, UTC date and side. Dates without included records are omitted, never filled with zero; an observed zero is limited to this batch.',
  'Public item labels come from the pinned catalog; unknown types retain their numeric ID. No counterparty, location, journal reference, individual transaction row or private name is returned or looked up.',
  'The app accepts at most 2,500 received rows and rejects responses exceeding its supported size or numeric limits instead of truncating totals. No history collection or new permission is enabled.',
];

export function validateMarketTransactionsArgs(value: unknown): Selection {
  if (!record(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['characterId', 'entity', 'division', 'fromId'].includes(key)) ||
      !Object.hasOwn(value, 'characterId') || !integer(value.characterId, 1) || !Object.hasOwn(value, 'entity') || value.entity !== 'character' && value.entity !== 'corporation' ||
      value.entity === 'corporation' && (!Object.hasOwn(value, 'division') || !integer(value.division, 1, 7)) ||
      value.entity === 'character' && 'division' in value || 'fromId' in value && !Object.hasOwn(value, 'fromId') ||
      Object.hasOwn(value, 'fromId') && !integer(value.fromId, 1)) {
    throw new EveError('Choose one connected character, a wallet owner, an explicit corporation division when applicable, and an optional positive transaction cursor.');
  }
  return { characterId: value.characterId, entity: value.entity, division: value.entity === 'corporation' ? value.division as number : null, fromId: Object.hasOwn(value, 'fromId') ? value.fromId as number : null };
}
function timestamp(value: unknown): string | null {
  const parsed = overviewDate(value);
  return parsed?.length === 24 ? parsed : null;
}
function headerDate(value: unknown): string | null {
  const parsed = timestamp(value);
  if (parsed) return parsed;
  if (typeof value !== 'string' || value.length > 100) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toUTCString() !== value) return null;
  const normalized = new Date(time).toISOString();
  return normalized.length === 24 ? normalized : null;
}
async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); });
  void interrupted.catch(() => {});
  try { const result = await Promise.race([work(), interrupted]); signal.throwIfAborted(); return result; }
  finally { signal.removeEventListener('abort', cancel); }
}
function blank(selection: Selection, at: number, status: MarketTransactionsAnalytics['status'], message: string): MarketTransactionsAnalytics {
  return {
    characterId: selection.characterId, entity: selection.entity, corporationId: null, division: selection.division, generatedAt: new Date(at).toISOString(), status, message, scope: scopes[selection.entity],
    coverage: { kind: 'unavailable', fromId: selection.fromId, nextFromId: null, returnedEntries: 0, includedEntries: 0, excludedCorporationEntries: 0, boundaryEntries: 0, includedBoundaryEntries: 0, firstIncludedDate: null, lastIncludedDate: null },
    freshness: { state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null }, summary: null, cells: [], types: [], precisionPolicy, limitations: [...limitations],
  };
}
function label(typeId: number): MarketTransactionType {
  const item = findPublishedManufacturingItem(typeId), name = item?.name;
  return typeof name === 'string' && name.trim() === name && name.length > 0 && name.length <= 512 && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(name)
    ? { typeId, name, mapped: true } : { typeId, name: `Type ${typeId}`, mapped: false };
}
function summarize(selection: Selection, response: unknown, now: () => number): MarketTransactionsAnalytics {
  if (!record(response) || response.characterId !== selection.characterId || response.entity !== selection.entity || response.dataset !== 'wallet_transactions' ||
      selection.entity === 'corporation' && (!integer(response.corporationId, 1) || response.division !== selection.division) ||
      selection.entity === 'character' && (response.corporationId != null || response.division != null) ||
      ['page', 'pages', 'pageLimit', 'morePagesAvailable', 'pageLimitReached'].some(key => response[key] !== undefined) || response.nextPage !== null || !Array.isArray(response.data)) return invalid();
  if (response.data.length > rowLimit) throw new TransactionDataError('limit');
  const retrievedAt = timestamp(response.retrievedAt);
  if (!retrievedAt) return invalid();
  const seen = new Set<number>(), grouped = new Map<string, Cell>(), labels = new Map<number, MarketTransactionType>(), total = walletActivityBucket();
  let minimumId: number | null = null, excludedCorporationEntries = 0, boundaryEntries: 0 | 1 = 0, includedBoundaryEntries: 0 | 1 = 0, buyEntries = 0, sellEntries = 0;
  for (const row of response.data) {
    // Both flags are required on character transactions; only is_buy exists in
    // the corporation schema. CCP's omitted-false rule is for optional flags.
    if (!record(row) || !integer(row.transaction_id, 1) || seen.has(row.transaction_id) || selection.fromId !== null && row.transaction_id > selection.fromId ||
        !integer(row.type_id, 1) || !integer(row.quantity) || typeof row.is_buy !== 'boolean' ||
        selection.entity === 'character' && typeof row.is_personal !== 'boolean' ||
        typeof row.unit_price !== 'number' || !Number.isFinite(row.unit_price) || row.unit_price < 0 || row.unit_price > Number.MAX_SAFE_INTEGER) return invalid();
    const date = timestamp(row.date);
    if (!date || Date.parse(date) > Date.parse(retrievedAt) + 60000) return invalid();
    seen.add(row.transaction_id);
    minimumId = minimumId === null || row.transaction_id < minimumId ? row.transaction_id : minimumId;
    const boundary = selection.fromId !== null && row.transaction_id === selection.fromId;
    if (boundary) boundaryEntries = 1;
    // Validate every row before filtering, so excluded rows cannot silently
    // steer the cursor or make malformed inputs appear to be empty activity.
    const price = walletActivityDecimal(row.unit_price);
    const side = row.is_buy ? 'buy' : 'sell', quantity = BigInt(row.quantity);
    const amount = { units: price.units * quantity * (side === 'buy' ? -1n : 1n), scale: price.scale };
    if (selection.entity === 'character' && row.is_personal === false) { excludedCorporationEntries++; continue; }
    if (boundary) includedBoundaryEntries = 1;
    if (side === 'buy') buyEntries++; else sellEntries++;
    const day = date.slice(0, 10), key = `${day}:${row.type_id}:${side}`;
    const cell = grouped.get(key) ?? { date: day, typeId: row.type_id, side, entries: 0, quantity: 0n, amounts: walletActivityBucket() };
    cell.entries++; cell.quantity += quantity; accumulateWalletActivity(cell.amounts, amount); grouped.set(key, cell); accumulateWalletActivity(total, amount);
    if (!labels.has(row.type_id)) labels.set(row.type_id, label(row.type_id));
  }
  const nextFromId = minimumId !== null && (selection.fromId === null || minimumId < selection.fromId) ? minimumId : null;
  if (response.nextFromId !== nextFromId) return invalid();
  const cells: MarketTransactionCell[] = [...grouped.values()].map(cell => {
    const amounts = walletActivityProject(cell.amounts).totals!;
    return { date: cell.date, typeId: cell.typeId, side: cell.side, entries: cell.entries, quantity: String(cell.quantity), grossISK: cell.side === 'buy' ? amounts.outgoingISK : amounts.incomingISK };
  }).sort((left, right) => left.date.localeCompare(right.date) || left.typeId - right.typeId || (left.side === right.side ? 0 : left.side === 'buy' ? -1 : 1));
  const types = [...labels.values()].sort((left, right) => left.typeId - right.typeId), totals = walletActivityProject(total).totals!;
  const completed = now();
  if (Date.parse(retrievedAt) > completed + 60000) return invalid();
  const cacheExpires = timestamp(walletActivityExpiry(response, Date.parse(retrievedAt)));
  const freshness: MarketTransactionsAnalytics['freshness'] = { state: cacheExpires === null ? 'unknown' : Date.parse(cacheExpires) <= completed ? 'stale' : 'fresh', retrievedAt, cacheExpires, lastModified: headerDate(response.lastModified) };
  const kind = selection.fromId === null && response.data.length === 0 ? 'complete_returned_window' : 'partial';
  const result: MarketTransactionsAnalytics = {
    ...blank(selection, completed, kind === 'complete_returned_window' && freshness.state === 'fresh' ? 'ready' : 'partial',
      `One ${selection.entity === 'character' ? 'character' : 'corporation division'} transaction batch. ${buyEntries + sellEntries} of ${response.data.length} returned records are included. Source freshness is ${freshness.state}; this is not complete trading history.`),
    corporationId: selection.entity === 'corporation' ? response.corporationId as number : null,
    coverage: { kind, fromId: selection.fromId, nextFromId, returnedEntries: response.data.length, includedEntries: buyEntries + sellEntries, excludedCorporationEntries, boundaryEntries, includedBoundaryEntries,
      firstIncludedDate: cells[0]?.date ?? null, lastIncludedDate: cells[cells.length - 1]?.date ?? null },
    freshness, summary: { entries: buyEntries + sellEntries, buyEntries, sellEntries, types: types.length, unmappedTypes: types.filter(type => !type.mapped).length, grossPurchasesISK: totals.outgoingISK, grossSalesISK: totals.incomingISK }, cells, types,
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > projectionByteLimit) throw new TransactionDataError('limit');
  return result;
}

/** One owned cursor batch. No raw transaction rows, extra feeds, retention or writes. */
export function createMarketTransactionsReader(dependencies: Dependencies) {
  return async (user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<MarketTransactionsAnalytics> => {
    const selection = validateMarketTransactionsArgs(input), now = dependencies.now ?? Date.now;
    if (typeof user !== 'string' || !user) throw new EveError('Sign in to this private connector first.', 401);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    signal.throwIfAborted();
    let connection: { characterId: number; scopes: string[] } | undefined;
    try { connection = (await abortable(() => dependencies.connections(user), signal)).find(row => row.characterId === selection.characterId); }
    catch { return blank(selection, now(), 'unavailable', signal.aborted ? 'The market activity request was cancelled or reached its time limit.' : 'Connection status could not be checked. Refresh to try again.'); }
    if (!connection) throw new EveError('Choose a character connected to this private connector.', 404);
    if (!connection.scopes.includes(scopes[selection.entity])) return blank(selection, now(), 'needs_permission', 'This character has not granted the required wallet read permission. Review Connections; no extra access is requested automatically.');
    try {
      const args: ReadArgs = { characterId: selection.characterId, entity: selection.entity, dataset: 'wallet_transactions', ...(selection.division === null ? {} : { division: selection.division }), ...(selection.fromId === null ? {} : { fromId: selection.fromId }) };
      const response = await abortable(() => dependencies.transactions(user, args, signal, { maxResponseBytes: responseByteLimit }), signal);
      const result = summarize(selection, response, now); signal.throwIfAborted(); return result;
    } catch (error) {
      if (signal.aborted) return blank(selection, now(), 'unavailable', 'The market activity request was cancelled or reached its time limit. Refresh to try again.');
      if (error instanceof EveError && [401, 404, 409].includes(error.status)) return blank(selection, now(), 'unavailable', 'The connection changed or its authorization expired. Reload connection status before trying again.');
      if (error instanceof EveError && error.status === 403) return blank(selection, now(), 'unavailable', 'EVE denied this wallet read. Check the saved permission and, for corporation wallets, the character’s current corporation roles.');
      if (error instanceof EveError && error.status === 429) return blank(selection, now(), 'unavailable', 'EVE is rate limiting requests. Wait before refreshing; no automatic retry was made.');
      return blank(selection, now(), 'error', error instanceof TransactionDataError && error.kind === 'limit' ? 'This transaction batch exceeds the app’s supported response limits. No values are shown.' : error instanceof TransactionDataError ? 'EVE returned transactions that could not be summarized safely. Missing data is unknown, not zero.' : 'Market transactions could not be loaded. No values are assumed.');
    }
  };
}
export const readMarketTransactions = createMarketTransactionsReader({ connections: listConnections, transactions: readEve });
