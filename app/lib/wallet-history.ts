import { EveError, readEve, type ReadArgs } from './eve';
import {
  walletActivityCategory, walletActivityCategoryLabels, walletActivityDecimal,
  walletActivityFormat, walletActivityProject, walletActivityBucket, accumulateWalletActivity,
  walletActivityDate, walletActivityExpiry, walletActivityPrecisionPolicy,
} from './wallet-analytics';
import { walletHistoryStorage, WALLET_HISTORY_SCOPE, type WalletHistoryStorage, type WalletHistoryOwner } from './wallet-history-storage';
import type { WalletActivityCategoryId, WalletActivityTotals } from './wallet-analytics-types';
import type { WalletHistoryArgs, WalletHistoryCapture, WalletHistoryDays, WalletHistoryReportDays, WalletHistoryView } from './wallet-history-types';

const MAX_EVENTS = 10000, MAX_PAGES = 4, DAY = 86400000;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const days = (value: unknown): value is WalletHistoryDays => value === 30 || value === 90 || value === 365;
const reportDays = (value: unknown): value is WalletHistoryReportDays => value === 7 || days(value);
const ownKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
type Event = { id: number; date: string; amount: string | null; category: WalletActivityCategoryId };
type Payload = { version: 1; events: Event[]; lastCapture: WalletHistoryCapture | null };
type Dependencies = { storage: WalletHistoryStorage; journal: (user: string, args: ReadArgs, signal?: AbortSignal) => Promise<unknown>; now?: () => number; generation?: () => string };
const empty = (): Payload => ({ version: 1, events: [], lastCapture: null });
const badData = () => new EveError('The wallet history source could not be validated safely. No new events were saved.', 502);
const changed = () => new EveError('The connection or history settings changed during this request. Reload history before trying again.', 409);
const limitations = [
  'History collection is off until explicitly enabled. Captures are manual; no background collector runs, and missing days are not filled with zero.',
  'Reports contain observed journal events only. EVE exposes a limited journal window; all returned pages still do not establish a complete calendar period or lifetime history.',
  'Incoming minus outgoing is cash flow, not profit, net worth or a reconstructed wallet balance. Transfers remain activity. Tax fields and wallet transactions are not added separately.',
  'Only one character wallet is included. Names, counterparties, descriptions, reasons and balances are not retained. Missing amounts remain counted and excluded from sums.',
  'Capture freshness describes completion of the last journal read, before encrypting and committing history. Independently cached pages are not an atomic snapshot; a later report does not refresh the provider data.',
  'Retention filters every report. Expired events are physically pruned on the next history mutation; pausing collection does not erase retained history. Clear history erases it and disables capture. External backups and earlier chat results are separate.',
];

export function validateWalletHistoryArgs(value: unknown): WalletHistoryArgs {
  if (!record(value) || !Object.hasOwn(value, 'characterId') || !integer(value.characterId) || !Object.hasOwn(value, 'operation')) throw new EveError('Choose a connected character and a supported history operation.');
  const common = ['characterId', 'operation'];
  switch (value.operation) {
    case 'status': case 'capture': if (ownKeys(value, common)) return value as WalletHistoryArgs; break;
    case 'configure': if (ownKeys(value, [...common, 'enabled', 'retentionDays']) && typeof value.enabled === 'boolean' && (days(value.retentionDays) || value.enabled === false && !Object.hasOwn(value, 'retentionDays'))) return value as WalletHistoryArgs; break;
    case 'report': if (ownKeys(value, [...common, 'days', 'comparePrevious']) && (!Object.hasOwn(value, 'days') || reportDays(value.days)) && (!Object.hasOwn(value, 'comparePrevious') || typeof value.comparePrevious === 'boolean')) return value as WalletHistoryArgs; break;
    case 'clear': if (ownKeys(value, [...common, 'confirm']) && value.confirm === 'delete_wallet_history') return value as WalletHistoryArgs; break;
  }
  throw new EveError('Supply only the accepted options for this history operation. Erasure requires delete_wallet_history confirmation.');
}
function storedAmount(value: string) {
  if (value.length > 350 || !/^-?(?:0|[1-9]\d*)\.\d{2,324}$/.test(value)) throw badData();
  const [whole, fraction] = value.split('.');
  const amount = { units: BigInt(whole + fraction), scale: fraction.length };
  if (walletActivityFormat(amount) !== value) throw badData();
  return amount;
}
function validCapture(value: unknown): value is WalletHistoryCapture {
  if (!record(value) || !ownKeys(value, ['at', 'pagesRead', 'pagesAdvertised', 'entriesRead', 'addedEntries', 'coverage', 'freshness', 'retrievedAt', 'cacheExpires']) ||
      !walletActivityDate(value.at) || !walletActivityDate(value.retrievedAt) || !integer(value.pagesRead, 1, MAX_PAGES) || value.pagesAdvertised !== null && !integer(value.pagesAdvertised) ||
      !integer(value.entriesRead, 0, MAX_EVENTS) || !integer(value.addedEntries, 0, value.entriesRead) || !['returned_pages', 'partial', 'unknown'].includes(String(value.coverage)) ||
      !['fresh', 'stale', 'unknown'].includes(String(value.freshness)) || value.cacheExpires !== null && !walletActivityDate(value.cacheExpires)) return false;
  if (value.pagesAdvertised === null ? value.coverage !== 'unknown' || value.pagesRead !== 1 : value.pagesRead > value.pagesAdvertised || value.coverage !== (value.pagesRead === value.pagesAdvertised ? 'returned_pages' : 'partial')) return false;
  return true;
}
function validatePayload(value: unknown): Payload {
  if (!record(value) || !ownKeys(value, ['version', 'events', 'lastCapture']) || value.version !== 1 || !Array.isArray(value.events) || value.events.length > MAX_EVENTS || value.lastCapture !== null && !validCapture(value.lastCapture)) throw badData();
  const ids = new Set<number>();
  for (const event of value.events) {
    if (!record(event) || !ownKeys(event, ['id', 'date', 'amount', 'category']) || !integer(event.id) || ids.has(event.id) || walletActivityDate(event.date) !== event.date || typeof event.category !== 'string' || !Object.hasOwn(walletActivityCategoryLabels, event.category) || event.amount !== null && typeof event.amount !== 'string') throw badData();
    if (event.amount !== null) storedAmount(event.amount as string);
    ids.add(event.id);
  }
  return value as Payload;
}
async function cancellable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel = () => {};
  const interrupted = new Promise<never>((_, reject) => { cancel = () => reject(new EveError('History request cancelled or timed out. Reload history to check whether a completed mutation was saved.', 408)); signal.addEventListener('abort', cancel, { once: true }); });
  void interrupted.catch(() => {});
  try { const result = await Promise.race([work(), interrupted]); signal.throwIfAborted(); return result; }
  finally { signal.removeEventListener('abort', cancel); }
}
function retained(payload: Payload, retentionDays: WalletHistoryDays, at: number): Payload {
  const cutoff = at - retentionDays * DAY;
  return { ...payload, events: payload.events.filter(event => Date.parse(event.date) >= cutoff && Date.parse(event.date) <= at + 60000), lastCapture: payload.lastCapture && Date.parse(payload.lastCapture.at) >= cutoff ? payload.lastCapture : null };
}
function observedDifference(current: WalletActivityTotals, previous: WalletActivityTotals): { incomingISK: string; outgoingISK: string; netISK: string } {
  const difference = (key: keyof WalletActivityTotals) => {
    const left = storedAmount(current[key]), right = storedAmount(previous[key]), scale = Math.max(left.scale, right.scale);
    return walletActivityFormat({ units: left.units * 10n ** BigInt(scale - left.scale) - right.units * 10n ** BigInt(scale - right.scale), scale });
  };
  return { incomingISK: difference('incomingISK'), outgoingISK: difference('outgoingISK'), netISK: difference('netISK') };
}
function view(characterId: number, owner: WalletHistoryOwner, payload: Payload, range: WalletHistoryReportDays, at: number, message: string, comparePrevious = false): WalletHistoryView {
  const observationsAvailable = owner.scopes.includes(WALLET_HISTORY_SCOPE);
  const settings = { enabled: owner.record?.enabled ?? false, retentionDays: owner.record?.retentionDays ?? 90 };
  const saved = retained(payload, settings.retentionDays, at), currentStart = at - range * DAY;
  // Only explicitly requested comparisons use exact adjacent intervals. Preserve
  // legacy report behavior for provider timestamps within its 60-second tolerance.
  const events = saved.events.filter(event => Date.parse(event.date) >= currentStart && (!comparePrevious || Date.parse(event.date) <= at));
  const total = walletActivityBucket(), daily = new Map<string, ReturnType<typeof walletActivityBucket>>(), categories = new Map<WalletActivityCategoryId, ReturnType<typeof walletActivityBucket>>();
  let earliest: string | null = null, latest: string | null = null;
  for (const event of events) {
    const amount = event.amount === null ? null : storedAmount(event.amount), day = event.date.slice(0, 10);
    if (!daily.has(day)) daily.set(day, walletActivityBucket());
    if (!categories.has(event.category)) categories.set(event.category, walletActivityBucket());
    accumulateWalletActivity(total, amount); accumulateWalletActivity(daily.get(day)!, amount); accumulateWalletActivity(categories.get(event.category)!, amount);
    earliest = earliest === null || event.date.localeCompare(earliest) < 0 ? event.date : earliest;
    latest = latest === null || event.date.localeCompare(latest) > 0 ? event.date : latest;
  }
  const summary = walletActivityProject(total);
  let comparison: WalletHistoryView['comparison'];
  if (comparePrevious) {
    const previousStart = currentStart - range * DAY, retentionStart = at - settings.retentionDays * DAY, prior = walletActivityBucket();
    let previousEarliest: string | null = null, previousLatest: string | null = null;
    for (const event of saved.events) {
      const date = Date.parse(event.date);
      if (date < previousStart || date >= currentStart) continue;
      accumulateWalletActivity(prior, event.amount === null ? null : storedAmount(event.amount));
      previousEarliest = previousEarliest === null || event.date.localeCompare(previousEarliest) < 0 ? event.date : previousEarliest;
      previousLatest = previousLatest === null || event.date.localeCompare(previousLatest) > 0 ? event.date : previousLatest;
    }
    const previousSummary = walletActivityProject(prior), previousTotals = prior.entries ? previousSummary.totals : null;
    const currentClipped = currentStart < retentionStart, previousClipped = previousStart < retentionStart;
    comparison = {
      current: { startsAt: new Date(currentStart).toISOString(), endsAt: new Date(at).toISOString(), retentionClipped: currentClipped },
      previous: { startsAt: new Date(previousStart).toISOString(), endsBefore: new Date(currentStart).toISOString(), retentionClipped: previousClipped, ...previousSummary, totals: previousTotals, earliest: previousEarliest, latest: previousLatest },
      observedDelta: events.length && summary.totals && previousTotals && !summary.missingAmountEntries && !previousSummary.missingAmountEntries && !currentClipped && !previousClipped ? observedDifference(summary.totals, previousTotals) : null,
    };
  }
  return {
    characterId, generatedAt: new Date(at).toISOString(), observationsAvailable, status: !observationsAvailable ? 'needs_permission' : !settings.enabled ? 'disabled' : events.length ? 'partial' : 'empty', message, settings,
    report: { days: range, ...summary, totals: events.length ? summary.totals : null, earliest, latest,
      daily: [...daily].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, ...walletActivityProject(value) })),
      categories: [...categories].sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => ({ id, label: walletActivityCategoryLabels[id], ...walletActivityProject(value) })),
    },
    ...(comparison ? { comparison } : {}),
    lastCapture: saved.lastCapture, limits: { maxPages: MAX_PAGES, maxEvents: MAX_EVENTS }, precisionPolicy: walletActivityPrecisionPolicy, limitations: [...limitations],
  };
}

async function capture(user: string, characterId: number, payload: Payload, retentionDays: WalletHistoryDays, deps: Dependencies, signal: AbortSignal): Promise<Payload> {
  const now = deps.now ?? Date.now, observed = new Map<number, Event>(), expiryTimes: Array<number | null> = [];
  let advertised: number | null = null, page = 1, retrievedAt = '', lastModified: unknown = undefined;
  for (; page <= MAX_PAGES; page++) {
    const result = await cancellable(() => deps.journal(user, { characterId, entity: 'character', dataset: 'wallet_journal', page }, signal), signal);
    const completed = now();
    if (!record(result) || result.characterId !== characterId || result.entity !== 'character' || result.dataset !== 'wallet_journal' || result.page !== page || result.corporationId != null || result.division != null ||
        result.pages !== null && (!integer(result.pages) || result.pages < page) || !Array.isArray(result.data) || result.data.length > 2500) throw badData();
    const received = walletActivityDate(result.retrievedAt);
    if (!received || Date.parse(received) > completed + 60000 || received < retrievedAt) throw badData();
    if (page === 1) { advertised = result.pages as number | null; lastModified = result.lastModified; }
    else if (advertised !== result.pages || result.lastModified !== lastModified) throw new EveError('EVE journal pages changed while capturing. No events were saved; retry this capture.', 409);
    const more = advertised === null ? null : page < advertised;
    if (result.nextPage !== (more === true ? page + 1 : null) || result.pageLimit !== undefined && result.pageLimit !== 500 || result.morePagesAvailable !== undefined && result.morePagesAvailable !== more || result.pageLimitReached !== undefined && result.pageLimitReached !== false) throw badData();
    retrievedAt = received;
    const expires = walletActivityExpiry(result, Date.parse(received));
    expiryTimes.push(expires === null ? null : Date.parse(expires));
    for (const raw of result.data) {
      if (!record(raw) || !integer(raw.id) || observed.has(raw.id) || typeof raw.ref_type !== 'string' || !/^[a-z][a-z0-9_]{0,99}$/.test(raw.ref_type)) throw badData();
      const date = walletActivityDate(raw.date);
      if (!date || Date.parse(date) > Date.parse(received) + 60000) throw badData();
      let amount: string | null = null;
      try { if (Object.hasOwn(raw, 'amount')) amount = walletActivityFormat(walletActivityDecimal(raw.amount)); } catch { throw badData(); }
      observed.set(raw.id, { id: raw.id, date, amount, category: walletActivityCategory(raw.ref_type) });
    }
    if (more !== true || page === MAX_PAGES) break;
  }
  signal.throwIfAborted();
  const completed = now(), previous = retained(payload, retentionDays, completed), merged = new Map(previous.events.map(event => [event.id, event]));
  let addedEntries = 0;
  for (const event of observed.values()) {
    if (Date.parse(event.date) < completed - retentionDays * DAY) continue;
    const prior = merged.get(event.id);
    if (prior && (prior.date !== event.date || prior.amount !== event.amount || prior.category !== event.category)) throw new EveError('An existing journal event conflicts with this capture. No events were saved.', 409);
    if (!prior) { merged.set(event.id, event); addedEntries++; }
  }
  if (merged.size > MAX_EVENTS) throw new EveError('Private history storage is full. Shorten retention or clear history before capturing again. No new events were saved.', 409);
  const known = expiryTimes.filter((value): value is number => value !== null), minimum = known.length ? Math.min(...known) : null;
  const freshness = known.some(value => value <= completed) ? 'stale' : known.length !== expiryTimes.length ? 'unknown' : 'fresh';
  return { version: 1, events: [...merged.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id), lastCapture: {
    at: new Date(completed).toISOString(), pagesRead: page, pagesAdvertised: advertised, entriesRead: observed.size, addedEntries,
    coverage: advertised === null ? 'unknown' : page === advertised ? 'returned_pages' : 'partial', freshness,
    retrievedAt, cacheExpires: minimum === null || freshness === 'unknown' ? null : new Date(minimum).toISOString(),
  } };
}

export function createWalletHistoryService(deps: Dependencies) {
  return async (user: string, input: unknown, context: { signal?: AbortSignal } = {}): Promise<WalletHistoryView> => {
    if (!user || typeof user !== 'string') throw new EveError('Sign in to this private connector first.', 401);
    const args = validateWalletHistoryArgs(input), now = deps.now ?? Date.now;
    const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    const owner = await cancellable(() => deps.storage.load(user, args.characterId), signal);
    if (!owner) throw new EveError('Choose a character connected to this private connector.', 404);
    const granted = owner.scopes.includes(WALLET_HISTORY_SCOPE);
    const requiresGrant = args.operation === 'capture' || args.operation === 'report' || args.operation === 'configure' && args.enabled;
    if (requiresGrant && !granted) throw new EveError('This character has not granted wallet read access. Review Connections; history never adds permissions automatically.', 403);
    let payload = empty();
    // Erasure deliberately does not decrypt the prior payload. Status after a
    // scope loss returns configuration only, never retained financial results.
    if (owner.record && args.operation !== 'clear' && (granted || args.operation === 'configure')) {
      payload = validatePayload(await cancellable(() => deps.storage.open(user, args.characterId, owner.record!.encrypted), signal));
      payload = retained(payload, owner.record.retentionDays, now());
    }
    if (args.operation === 'status' || args.operation === 'report') {
      const current = await cancellable(() => deps.storage.load(user, args.characterId), signal);
      if (!current || current.epoch !== owner.epoch || current.record?.generation !== owner.record?.generation || current.scopes.includes(WALLET_HISTORY_SCOPE) !== granted) throw changed();
      return view(args.characterId, owner, payload, args.operation === 'report' ? args.days ?? 30 : 30, now(), granted ? 'Observed character-wallet cash flow only; gaps and older uncaptured activity remain unknown.' : 'Wallet read permission is missing. Stored history is hidden; you can pause or erase it.', args.operation === 'report' && args.comparePrevious === true);
    }
    let enabled = owner.record?.enabled ?? false, retentionDays = owner.record?.retentionDays ?? 90;
    let message: string;
    if (args.operation === 'configure') { enabled = args.enabled; retentionDays = args.retentionDays ?? retentionDays; message = enabled ? 'Private history enabled. Capture manually to save the currently available journal window.' : 'Collection paused. Retained observations remain available within the retention period; clear history to erase them.'; }
    else if (args.operation === 'clear') { enabled = false; payload = empty(); message = 'Private wallet history erased and collection disabled. Earlier chat results and external backups are separate.'; }
    else {
      if (!enabled) throw new EveError('Enable private history explicitly before capturing. No data was saved.', 409);
      payload = await capture(user, args.characterId, payload, retentionDays, deps, signal);
      message = 'Manual capture saved. Reports cover observed journal events only; uncaptured periods remain unknown.';
    }
    // Increasing retention cannot resurrect observations that already expired
    // under the previous choice while physical cleanup was pending.
    payload = retained(payload, Math.min(owner.record?.retentionDays ?? retentionDays, retentionDays) as WalletHistoryDays, now());
    const encrypted = await cancellable(() => deps.storage.seal(user, args.characterId, payload), signal);
    const next = { generation: deps.generation?.() ?? crypto.randomUUID().replaceAll('-', ''), enabled, retentionDays, encrypted };
    signal.throwIfAborted();
    if (!await cancellable(() => deps.storage.save(user, args.characterId, owner, next, requiresGrant), signal)) throw changed();
    const current = await cancellable(() => deps.storage.load(user, args.characterId), signal);
    if (!current || current.epoch !== owner.epoch || current.record?.generation !== next.generation) throw changed();
    const currentGrant = current.scopes.includes(WALLET_HISTORY_SCOPE);
    if (requiresGrant && !currentGrant) throw new EveError('Wallet permission changed after this history action. Reload history status to check the saved result.', 403);
    return view(args.characterId, current, currentGrant ? payload : empty(), 30, now(), message);
  };
}
export const runWalletHistory = createWalletHistoryService({ storage: walletHistoryStorage, journal: (user, args, signal) => readEve(user, args, signal, { maxResponseBytes: 2 * 1024 * 1024 }) });
