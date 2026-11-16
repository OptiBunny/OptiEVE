import { z } from 'zod';
import { ConnectionResponseError } from './connection-client';
import type { WalletActivityBucket, WalletActivityTotals } from './wallet-analytics-types';
import type { WalletHistoryArgs, WalletHistoryView } from './wallet-history-types';

const count = z.number().int().min(0).max(10000);
const id = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(2048);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
const days = z.union([z.literal(30), z.literal(90), z.literal(365)]);
const reportDays = z.union([z.literal(7), days]);
const decimal = z.string().max(345).regex(/^(?:0|[1-9]\d{0,19})(?:\.\d{1,324})?$/);
const signed = z.string().max(346).regex(/^-?(?:0|[1-9]\d{0,19})(?:\.\d{1,324})?$/);
const totals = z.strictObject({ incomingISK: decimal, outgoingISK: decimal, netISK: signed });
const bucket = { entries: count, amountEntries: count, missingAmountEntries: count, totals: totals.nullable() };
const categoryIds = ['market', 'transfers', 'rewards', 'fees', 'industry', 'contracts', 'other'] as const;
const categoryLabels = { market: 'Market activity', transfers: 'Transfers', rewards: 'Rewards and bounties', fees: 'Taxes and fees', industry: 'Industry and services', contracts: 'Contracts', other: 'Other activity' } as const;
const schema = z.strictObject({
  characterId: id, generatedAt: date, observationsAvailable: z.boolean(), status: z.enum(['needs_permission', 'disabled', 'ready', 'partial', 'empty']), message: text,
  settings: z.strictObject({ enabled: z.boolean(), retentionDays: days }),
  // A rolling 365-day interval can touch 366 UTC dates; permitted clock skew
  // may add one more date just after midnight, without widening the time bound.
  report: z.strictObject({ days: reportDays, ...bucket, earliest: date.nullable(), latest: date.nullable(), daily: z.array(z.strictObject({ date: day, ...bucket })).max(367), categories: z.array(z.strictObject({ id: z.enum(categoryIds), label: text, ...bucket })).max(7) }),
  comparison: z.strictObject({
    current: z.strictObject({ startsAt: date, endsAt: date, retentionClipped: z.boolean() }),
    previous: z.strictObject({ startsAt: date, endsBefore: date, retentionClipped: z.boolean(), ...bucket, earliest: date.nullable(), latest: date.nullable() }),
    observedDelta: z.strictObject({ incomingISK: signed, outgoingISK: signed, netISK: signed }).nullable(),
  }).optional(),
  lastCapture: z.strictObject({ at: date, pagesRead: z.number().int().min(1).max(4), pagesAdvertised: id.nullable(), entriesRead: count, addedEntries: count, coverage: z.enum(['returned_pages', 'partial', 'unknown']), freshness: z.enum(['fresh', 'stale', 'unknown']), retrievedAt: date, cacheExpires: date.nullable() }).nullable(),
  limits: z.strictObject({ maxPages: z.literal(4), maxEvents: z.literal(10000) }), precisionPolicy: text, limitations: z.array(text).max(20),
});
const argsSchema = z.discriminatedUnion('operation', [
  z.strictObject({ characterId: id, operation: z.literal('status') }),
  z.strictObject({ characterId: id, operation: z.literal('capture') }),
  z.strictObject({ characterId: id, operation: z.literal('configure'), enabled: z.boolean(), retentionDays: days.optional() }).refine(value => !value.enabled || value.retentionDays !== undefined),
  z.strictObject({ characterId: id, operation: z.literal('report'), days: reportDays.optional(), comparePrevious: z.boolean().optional() }),
  z.strictObject({ characterId: id, operation: z.literal('clear'), confirm: z.literal('delete_wallet_history') }),
]);
const invalid = () => new ConnectionResponseError('The wallet history service returned an incomplete response. Reload saved history and try again.');
function selectedArgs(input: unknown): WalletHistoryArgs {
  const parsed = argsSchema.safeParse(input);
  if (!parsed.success || input === null || typeof input !== 'object' || !Object.hasOwn(input, 'characterId') || !Object.hasOwn(input, 'operation')) throw new ConnectionResponseError('Choose a connected character and a supported wallet history action.');
  return parsed.data;
}
function parts(values: string[]): bigint[] {
  const scale = Math.max(0, ...values.map(value => value.split('.')[1]?.length ?? 0));
  return values.map(value => { const negative = value.startsWith('-'), [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.'); return BigInt(whole + fraction.padEnd(scale, '0')) * (negative ? -1n : 1n); });
}
function validTotals(value: WalletActivityTotals, amounts: number): boolean {
  const [incoming, outgoing, net, bound] = parts([value.incomingISK, value.outgoingISK, value.netISK, String(BigInt(Number.MAX_SAFE_INTEGER) * BigInt(amounts))]);
  return incoming - outgoing === net && incoming + outgoing <= bound;
}
function validBucket(value: WalletActivityBucket, emptyAllowed = false): boolean {
  return value.entries === value.amountEntries + value.missingAmountEntries && (emptyAllowed || value.entries > 0) &&
    (value.totals === null ? value.amountEntries === 0 : value.amountEntries > 0 && validTotals(value.totals, value.amountEntries));
}
function matchingBuckets(rows: WalletActivityBucket[], total: WalletActivityBucket): boolean {
  if (rows.some(row => !validBucket(row)) || rows.reduce((sum, row) => sum + row.entries, 0) !== total.entries || rows.reduce((sum, row) => sum + row.amountEntries, 0) !== total.amountEntries) return false;
  return (['incomingISK', 'outgoingISK', 'netISK'] as const).every(key => {
    const values = parts([total.totals?.[key] ?? '0', ...rows.map(row => row.totals?.[key] ?? '0')]);
    return values[0] === values.slice(1).reduce((sum, value) => sum + value, 0n);
  });
}

function validComparison(result: WalletHistoryView, args: WalletHistoryArgs): boolean {
  const requested = args.operation === 'report' && args.comparePrevious === true;
  if (!requested) return result.comparison === undefined;
  const comparison = result.comparison;
  if (!comparison) return false;
  const { current, previous, observedDelta } = comparison, report = result.report;
  const at = Date.parse(result.generatedAt), width = report.days * 86400000, cutoff = at - result.settings.retentionDays * 86400000;
  if (Date.parse(current.startsAt) !== at - width || current.endsAt !== result.generatedAt ||
      Date.parse(previous.startsAt) !== at - 2 * width || previous.endsBefore !== current.startsAt ||
      current.retentionClipped !== (at - width < cutoff) || previous.retentionClipped !== (at - 2 * width < cutoff) ||
      !validBucket(previous, true) || report.entries + previous.entries > 10000 ||
      report.latest !== null && Date.parse(report.latest) > at) return false;
  if (!previous.entries) {
    if (previous.earliest !== null || previous.latest !== null || previous.totals !== null) return false;
  } else if (previous.earliest === null || previous.latest === null ||
      Date.parse(previous.earliest) > Date.parse(previous.latest) ||
      Date.parse(previous.earliest) < Math.max(at - 2 * width, cutoff) || Date.parse(previous.latest) >= at - width) return false;
  const canCompare = report.totals !== null && previous.totals !== null && !report.missingAmountEntries && !previous.missingAmountEntries && !current.retentionClipped && !previous.retentionClipped;
  if (!canCompare) return observedDelta === null;
  if (observedDelta === null) return false;
  return (['incomingISK', 'outgoingISK', 'netISK'] as const).every(key => {
    const [now, before, difference] = parts([report.totals![key], previous.totals![key], observedDelta[key]]);
    return now - before === difference;
  });
}

/** Strictly binds one shared report to its requested character and period. */
export function walletHistoryResponse(value: unknown, input: WalletHistoryArgs): WalletHistoryView {
  const args = selectedArgs(input), parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid();
  const result = parsed.data, report = result.report, generated = Date.parse(result.generatedAt);
  if (!result.observationsAvailable && (args.operation === 'report' || args.operation === 'capture' || args.operation === 'configure' && args.enabled ||
      report.entries !== 0 || report.amountEntries !== 0 || report.missingAmountEntries !== 0 || report.totals !== null ||
      report.earliest !== null || report.latest !== null || report.daily.length !== 0 || report.categories.length !== 0 ||
      result.lastCapture !== null || result.comparison !== undefined)) throw invalid();
  if (result.characterId !== args.characterId || report.days !== (args.operation === 'report' ? args.days ?? 30 : 30) ||
      !validBucket(report, true) || !matchingBuckets(report.daily, report) || !matchingBuckets(report.categories, report) ||
      report.categories.some(row => row.label !== categoryLabels[row.id]) || new Set(report.categories.map(row => row.id)).size !== report.categories.length ||
      report.daily.some((row, i) => i > 0 && row.date <= report.daily[i - 1].date) ||
      result.status !== (!result.observationsAvailable ? 'needs_permission' : !result.settings.enabled ? 'disabled' : report.entries ? 'partial' : 'empty') || !validComparison(result, args)) throw invalid();
  if (!report.entries) {
    if (report.earliest !== null || report.latest !== null || report.totals !== null || report.daily.length || report.categories.length) throw invalid();
  } else {
    if (report.earliest === null || report.latest === null || Date.parse(report.earliest) > Date.parse(report.latest) ||
        Date.parse(report.earliest) < generated - Math.min(report.days, result.settings.retentionDays) * 86400000 || Date.parse(report.latest) > generated + 60000 ||
        report.earliest.slice(0, 10) !== report.daily[0]?.date || report.latest.slice(0, 10) !== report.daily[report.daily.length - 1]?.date) throw invalid();
  }
  if (args.operation === 'configure' && (result.settings.enabled !== args.enabled || args.retentionDays !== undefined && result.settings.retentionDays !== args.retentionDays) ||
      args.operation === 'capture' && (!result.settings.enabled || result.lastCapture === null) ||
      args.operation === 'clear' && (result.settings.enabled || report.entries || result.lastCapture !== null)) throw invalid();
  const capture = result.lastCapture;
  if (capture && (Date.parse(capture.at) > generated + 60000 || Date.parse(capture.retrievedAt) > Date.parse(capture.at) + 60000 ||
      capture.entriesRead > capture.pagesRead * 2500 || capture.addedEntries > capture.entriesRead ||
      capture.pagesAdvertised !== null && capture.pagesAdvertised < capture.pagesRead ||
      capture.coverage !== (capture.pagesAdvertised === null ? 'unknown' : capture.pagesRead === capture.pagesAdvertised ? 'returned_pages' : 'partial') ||
      capture.freshness !== (capture.cacheExpires === null ? 'unknown' : Date.parse(capture.cacheExpires) <= Date.parse(capture.at) ? 'stale' : 'fresh'))) throw invalid();
  return result;
}

async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let cancel: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); });
  void interrupted.catch(() => {});
  try { const value = await Promise.race([work(), interrupted]); signal.throwIfAborted(); return value; }
  finally { signal.removeEventListener('abort', cancel); }
}

/** One explicit action. Local history writes are never retried automatically. */
export async function fetchWalletHistory(input: WalletHistoryArgs, signal?: AbortSignal): Promise<WalletHistoryView> {
  const args = selectedArgs(input), controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(abort, 90000); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await abortable(() => fetch('/api/eve/wallet-history', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: controller.signal }), controller.signal);
    if (!response.ok) throw new ConnectionResponseError(response.status === 401 ? 'Sign in again to use wallet history.' : response.status === 404 ? 'This character is no longer connected. Reload connection status.' : response.status === 403 ? 'Wallet history access was denied. Review the connection and its read permission.' : response.status === 409 ? 'Wallet history changed during this request. Reload saved history before trying again.' : 'The wallet history action could not be confirmed. Reload saved history before trying again.', response.status);
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || !response.body) throw invalid();
    reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true }); let received = 0, body = '';
    while (true) {
      const chunk = await abortable(() => reader!.read(), controller.signal);
      if (chunk.done) { body += decoder.decode(); break; }
      received += chunk.value.byteLength; if (received > 2 * 1024 * 1024) throw invalid();
      body += decoder.decode(chunk.value, { stream: true });
    }
    controller.signal.throwIfAborted(); return walletHistoryResponse(JSON.parse(body), args);
  } catch (error) {
    const cancelled = controller.signal.aborted; controller.abort();
    if (error instanceof ConnectionResponseError) throw error;
    throw new ConnectionResponseError(cancelled ? 'Waiting for wallet history was cancelled or timed out. A saved change may still have completed; reload saved history to check.' : 'The wallet history response could not be read safely. Reload saved history before trying again.');
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* A pending read may already have released the lock. */ } }
  }
}
