import { EveError, listConnections, readEve, type ReadArgs } from './eve';
import { overviewDate } from './overview-summary';
import type { WalletActivityBucket, WalletActivityCategoryId, WalletActivityTotals, WalletAnalytics, WalletAnalyticsArgs } from './wallet-analytics-types';

type Dependencies = {
  connections: (user: string) => Promise<{ characterId: number; scopes: string[] }[]>;
  journal: (user: string, args: ReadArgs, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
};
type Selection = WalletAnalyticsArgs & { page: number };
type Decimal = { units: bigint; scale: number };
type Bucket = { entries: number; amountEntries: number; incoming: Decimal; outgoing: Decimal };
const scopes = { character: 'esi-wallet.read_character_wallet.v1', corporation: 'esi-wallet.read_corporation_wallets.v1' };
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
class JournalDataError extends Error {}
const badData = (): never => { throw new JournalDataError(); };

const precisionPolicy = 'Amounts use exact integer arithmetic on the decimal representation of each received JSON number. This cannot recover precision already lost by the provider or JSON number parsing. No cent rounding is applied to totals.';
const limitations = [
  'Only the selected journal page and wallet are included. EVE retains a limited journal window; these are not lifetime totals or a complete calendar period.',
  'Positive amounts are incoming and negative amounts are outgoing. Net activity is cash flow, not profit or a reconstructed wallet balance. Transfers remain activity in the selected wallet.',
  'Only journal amount fields are summed. Separate tax fields, balances and wallet transaction values are never added, avoiding duplicate accounting.',
  'Days without returned entries are omitted, not filled with zero. Missing amounts are excluded and counted explicitly. Category labels group selected known reference types; other types remain Other activity.',
  'Each page is loaded independently and replaces the previous chart. Pages can change between requests and are never combined or persisted. The application accepts at most 2,500 rows per response.',
];
const categoryLabels: Record<WalletActivityCategoryId, string> = {
  market: 'Market activity', transfers: 'Transfers', rewards: 'Rewards and bounties', fees: 'Taxes and fees',
  industry: 'Industry and services', contracts: 'Contracts', other: 'Other activity',
};
// Fixed categories prevent arbitrary upstream reference strings from becoming labels.
const categoryTypes: Array<[WalletActivityCategoryId, Set<string>]> = [
  ['market', new Set(['market_transaction', 'market_escrow'])],
  ['transfers', new Set(['player_donation', 'corporation_account_withdrawal', 'corporation_payment', 'corporation_bulk_payment', 'cash_transfer', 'inheritance'])],
  ['rewards', new Set(['bounty', 'bounty_prizes', 'agent_mission_reward', 'agent_mission_time_bonus_reward', 'agent_mission_reward_corporation_tax', 'agent_mission_time_bonus_reward_corporation_tax', 'bounty_prize_corporation_tax', 'ess_escrow_transfer', 'ess_escrow_payout', 'daily_challenge_reward'])],
  ['fees', new Set(['transaction_tax', 'brokers_fee', 'contract_brokers_fee', 'contract_sales_tax', 'reprocessing_tax', 'asset_safety_recovery_tax', 'jump_clone_installation_fee', 'jump_clone_activation_fee', 'office_rental_fee', 'corporation_registration_fee', 'alliance_maintenance_fee', 'alliance_registration_fee', 'structure_gate_jump'])],
  ['industry', new Set(['industry_job_tax', 'manufacturing', 'researching_time_productivity', 'researching_material_productivity', 'copying', 'duplicating', 'reverse_engineering', 'reaction', 'repair_bill', 'planetary_import_tax', 'planetary_export_tax', 'planetary_construction'])],
  ['contracts', new Set(['contract_price', 'contract_reward', 'contract_deposit', 'contract_deposit_refund', 'contract_collateral', 'contract_collateral_refund', 'contract_collateral_payout', 'contract_price_payment_corp', 'contract_reward_deposited', 'contract_reward_refund', 'contract_auction_bid', 'contract_auction_bid_refund', 'contract_auction_sold'])],
];
function category(value: string): WalletActivityCategoryId { return categoryTypes.find(([, values]) => values.has(value))?.[0] ?? 'other'; }

export function validateWalletAnalyticsArgs(value: unknown): Selection {
  if (!record(value) || Object.keys(value).some(key => !['characterId', 'entity', 'division', 'page'].includes(key)) ||
      !Object.hasOwn(value, 'characterId') || !integer(value.characterId) || !Object.hasOwn(value, 'entity') ||
      value.entity !== 'character' && value.entity !== 'corporation' ||
      value.entity === 'corporation' && (!Object.hasOwn(value, 'division') || !integer(value.division, 1, 7)) ||
      value.entity === 'character' && Object.hasOwn(value, 'division') ||
      Object.hasOwn(value, 'page') && !integer(value.page, 1, 500)) {
    throw new EveError('Choose one connected character, a wallet owner, an explicit corporation division when applicable, and a page from 1 to 500.');
  }
  return { characterId: value.characterId, entity: value.entity, ...(value.entity === 'corporation' ? { division: value.division as number } : {}), page: Object.hasOwn(value, 'page') ? value.page as number : 1 };
}

function iso(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100) return null;
  // ESI date-time fields permit offsets and fractional seconds. Normalize
  // valid dates to UTC before grouping, while rejecting calendar rollovers.
  const normalized = overviewDate(value);
  return normalized?.length === 24 ? normalized : null;
}
function headerTime(value: unknown): number | null {
  const stamp = iso(value);
  if (stamp) return Date.parse(stamp);
  if (typeof value !== 'string' || value.length > 100) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toUTCString() === value ? parsed : null;
}
function expiry(result: Record<string, unknown>, received: number): string | null {
  const expires = headerTime(result.cacheExpires), date = headerTime(result.responseDate);
  const control = typeof result.cacheControl === 'string' && result.cacheControl.length <= 512 ? result.cacheControl : '';
  if (/(?:^|,)\s*(?:no-cache|no-store)(?=\s*(?:,|$))/i.test(control)) return new Date(received).toISOString();
  const age = result.cacheAge == null ? 0 : typeof result.cacheAge === 'string' && /^\d{1,10}$/.test(result.cacheAge) ? Number(result.cacheAge) : NaN;
  if (!integer(age, 0, 604800)) return null;
  const match = /(?:^|,)\s*max-age=(\d+)(?=\s*(?:,|$))/i.exec(control), maxAge = match ? Number(match[1]) : null;
  const cached = integer(maxAge, 0, 604800) && integer(age, 0, 604800) && date !== null && date <= received + 60000 ? Math.min(date + maxAge * 1000, received + (maxAge - age) * 1000) : null;
  const until = expires === null ? cached : cached === null ? expires : Math.min(expires, cached);
  return until === null ? null : new Date(until).toISOString();
}
async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); });
  void interrupted.catch(() => {});
  try { const result = await Promise.race([work(), interrupted]); signal.throwIfAborted(); return result; }
  finally { signal.removeEventListener('abort', cancel); }
}
function decimal(value: unknown): Decimal {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) return badData();
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(value));
  if (!match) return badData();
  const fraction = match[3] ?? '', exponent = Number(match[4] ?? 0) - fraction.length;
  let units = BigInt(match[2] + fraction) * (match[1] ? -1n : 1n);
  if (exponent > 0) units *= 10n ** BigInt(exponent);
  return { units, scale: Math.max(0, -exponent) };
}
function add(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return { units: left.units * 10n ** BigInt(scale - left.scale) + right.units * 10n ** BigInt(scale - right.scale), scale };
}
function formatted(value: Decimal): string {
  const sign = value.units < 0n ? '-' : '', digits = String(value.units < 0n ? -value.units : value.units).padStart(value.scale + 1, '0');
  const whole = value.scale ? digits.slice(0, -value.scale) : digits;
  const fraction = (value.scale ? digits.slice(-value.scale) : '').replace(/0+$/, '').padEnd(2, '0');
  return `${sign}${whole}.${fraction}`;
}
const bucket = (): Bucket => ({ entries: 0, amountEntries: 0, incoming: { units: 0n, scale: 0 }, outgoing: { units: 0n, scale: 0 } });
function accumulate(target: Bucket, amount: Decimal | null) {
  target.entries++;
  if (!amount) return;
  target.amountEntries++;
  if (amount.units < 0n) target.outgoing = add(target.outgoing, { ...amount, units: -amount.units });
  else target.incoming = add(target.incoming, amount);
}
function project(target: Bucket): WalletActivityBucket {
  const totals: WalletActivityTotals | null = target.entries && !target.amountEntries ? null : {
    incomingISK: formatted(target.incoming), outgoingISK: formatted(target.outgoing), netISK: formatted(add(target.incoming, { ...target.outgoing, units: -target.outgoing.units })),
  };
  return { entries: target.entries, amountEntries: target.amountEntries, missingAmountEntries: target.entries - target.amountEntries, totals };
}

function blank(selected: Selection, at: number, status: WalletAnalytics['status'], message: string): WalletAnalytics {
  return {
    characterId: selected.characterId, entity: selected.entity, division: selected.division ?? null, corporationId: null,
    generatedAt: new Date(at).toISOString(), status, message, scope: scopes[selected.entity],
    coverage: { kind: 'unavailable', page: selected.page, pages: null, nextPage: null, previousPage: selected.page > 1 ? selected.page - 1 : null, pageLimitReached: false, entries: 0, amountEntries: 0, missingAmountEntries: 0, earliest: null, latest: null },
    freshness: { state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null },
    totals: null, daily: [], categories: [], precisionPolicy, limitations: [...limitations],
  };
}

function summarize(selected: Selection, result: unknown, completed: number): WalletAnalytics {
  if (!record(result) || result.characterId !== selected.characterId || result.entity !== selected.entity || result.dataset !== 'wallet_journal' || result.page !== selected.page ||
      selected.entity === 'corporation' && (!integer(result.corporationId) || result.division !== selected.division) ||
      selected.entity === 'character' && (result.corporationId != null || result.division != null) ||
      result.pages !== null && !integer(result.pages) || typeof result.pages === 'number' && result.pages < selected.page ||
      !Array.isArray(result.data) || result.data.length > 2500) return badData();
  const retrievedAt = iso(result.retrievedAt);
  if (!retrievedAt || Date.parse(retrievedAt) > completed + 60000) return badData();
  const pages = result.pages as number | null, more = pages === null ? null : selected.page < pages;
  const nextPage = more === true && selected.page < 500 ? selected.page + 1 : null;
  if (result.nextPage !== nextPage || result.pageLimit !== undefined && result.pageLimit !== 500 || result.morePagesAvailable !== undefined && result.morePagesAvailable !== more ||
      result.pageLimitReached !== undefined && result.pageLimitReached !== (selected.page === 500 && more !== false)) return badData();
  const total = bucket(), daily = new Map<string, Bucket>(), categories = new Map<WalletActivityCategoryId, Bucket>(), ids = new Set<number>();
  let earliest: string | null = null, latest: string | null = null;
  for (const row of result.data) {
    if (!record(row) || !integer(row.id) || ids.has(row.id) || typeof row.ref_type !== 'string' || !/^[a-z][a-z0-9_]{0,99}$/.test(row.ref_type)) return badData();
    ids.add(row.id);
    const date = iso(row.date);
    if (!date || Date.parse(date) > Date.parse(retrievedAt) + 60000) return badData();
    const amount = Object.hasOwn(row, 'amount') ? decimal(row.amount) : null;
    earliest = earliest === null || date.localeCompare(earliest) < 0 ? date : earliest;
    latest = latest === null || date.localeCompare(latest) > 0 ? date : latest;
    const day = date.slice(0, 10), group = category(row.ref_type);
    if (!daily.has(day)) daily.set(day, bucket());
    if (!categories.has(group)) categories.set(group, bucket());
    accumulate(total, amount); accumulate(daily.get(day)!, amount); accumulate(categories.get(group)!, amount);
  }
  const summary = project(total), cacheExpires = expiry(result, Date.parse(retrievedAt));
  const freshness: WalletAnalytics['freshness'] = {
    state: cacheExpires === null ? 'unknown' : Date.parse(cacheExpires) <= completed ? 'stale' : 'fresh', retrievedAt, cacheExpires,
    lastModified: headerTime(result.lastModified) === null ? null : new Date(headerTime(result.lastModified)!).toISOString(),
  };
  const kind = pages === null ? 'unknown' : selected.page === 1 && pages === 1 ? 'complete_returned_window' : 'partial';
  const complete = kind === 'complete_returned_window' && !summary.missingAmountEntries && freshness.state === 'fresh';
  const resultView = blank(selected, completed, complete ? 'ready' : 'partial',
    `Selected journal page ${selected.page}${pages === null ? '; provider page count is unknown' : ` of ${pages}`}. ` +
    (pages === 1 && selected.page === 1 ? 'This is the complete returned provider window, not lifetime history. ' : 'Figures describe this page only. ') +
    (summary.missingAmountEntries ? `${summary.missingAmountEntries} entries omit an amount; only reported amounts are included. ` : '') +
    (selected.page === 500 && more !== false ? 'The application page limit is reached; additional activity may be unavailable. ' : '') +
    `Source freshness is ${freshness.state}.`);
  return {
    ...resultView, corporationId: selected.entity === 'corporation' ? result.corporationId as number : null,
    coverage: { kind, page: selected.page, pages, nextPage, previousPage: selected.page > 1 ? selected.page - 1 : null, pageLimitReached: selected.page === 500 && more !== false, entries: summary.entries, amountEntries: summary.amountEntries, missingAmountEntries: summary.missingAmountEntries, earliest, latest },
    freshness, totals: summary.totals,
    daily: [...daily].sort(([left], [right]) => left.localeCompare(right)).map(([date, value]) => ({ date, ...project(value) })),
    categories: [...categories].map(([id, value]) => ({ id, label: categoryLabels[id], ...project(value) })),
  };
}

/** On-demand, one-page, owner-scoped projection. No raw journal rows are returned or stored. */
export function createWalletAnalyticsReader(dependencies: Dependencies) {
  return async (user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<WalletAnalytics> => {
    const selected = validateWalletAnalyticsArgs(input), now = dependencies.now ?? Date.now;
    if (!user || typeof user !== 'string') throw new EveError('Sign in to this private connector first.', 401);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    signal.throwIfAborted();
    let connection: { characterId: number; scopes: string[] } | undefined;
    try { connection = (await abortable(() => dependencies.connections(user), signal)).find(row => row.characterId === selected.characterId); }
    catch { return blank(selected, now(), 'unavailable', signal.aborted ? 'The wallet request was cancelled or reached its time limit.' : 'Connection status could not be checked. Refresh to try again.'); }
    if (!connection) throw new EveError('Choose a character connected to this private connector.', 404);
    if (!connection.scopes.includes(scopes[selected.entity])) return blank(selected, now(), 'needs_permission', 'The selected character has not granted the required wallet read permission. Review Connections; permissions are never added automatically.');
    try {
      const result = await abortable(() => dependencies.journal(user, { ...selected, dataset: 'wallet_journal' }, signal), signal);
      return summarize(selected, result, now());
    } catch (error) {
      if (signal.aborted) return blank(selected, now(), 'unavailable', 'The wallet request was cancelled or reached its time limit. Refresh to try again.');
      if (error instanceof EveError && [401, 404, 409].includes(error.status)) return blank(selected, now(), 'unavailable', 'The connection changed or its authorization expired. Reload connection status before trying again.');
      if (error instanceof EveError && error.status === 403) return blank(selected, now(), 'unavailable', selected.entity === 'corporation' ? 'EVE denied this read. Check the character’s granted permission and corporation wallet roles.' : 'EVE denied this wallet read. Check the character’s granted permission.');
      if (error instanceof EveError && error.status === 429) return blank(selected, now(), 'unavailable', 'EVE is rate limiting requests. Wait before refreshing the selected page.');
      return blank(selected, now(), 'error', error instanceof JournalDataError ? 'EVE returned a page that could not be summarized safely. No totals are shown.' : 'The selected wallet page could not be loaded. No totals are assumed.');
    }
  };
}
export const readWalletAnalytics = createWalletAnalyticsReader({ connections: listConnections, journal: readEve });
