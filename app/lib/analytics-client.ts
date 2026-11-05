import { z } from 'zod';
import { ConnectionResponseError } from './connection-client';
import type { CharacterAnalytics, CharacterAnalyticsRequest, CharacterSkillsAnalytics } from './character-analytics-types';
import type { WalletAnalytics, WalletAnalyticsArgs, WalletActivityBucket, WalletActivityTotals } from './wallet-analytics-types';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const id = count.min(1);
const text = z.string().max(2048);
const name = z.string().min(1).max(512).refine(value => !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value));
const date = z.string().max(64).refine(value => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  const wall = match ? Date.parse(match[1] + 'Z') : NaN;
  return !!match && Number.isFinite(wall) && new Date(wall).toISOString().slice(0, 19) === match[1] && Number.isFinite(Date.parse(value));
});
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
const status = z.enum(['ready', 'partial', 'needs_permission', 'unavailable', 'error']);
const freshness = z.enum(['fresh', 'stale', 'unknown']);
const level = count.max(5);
const section = <T extends z.ZodType>(data: T, scope: string) => z.strictObject({ status, scope: z.literal(scope), message: text, retrievedAt: date.nullable(), cacheExpires: date.nullable(), freshness, data: data.nullable() });
const skills = z.strictObject({
  totalSp: count, unallocatedSp: count.nullable(), reportedSkillSp: count, skillCount: count.max(2000), trainedSkillCount: count, activeSkillCount: count, reducedActiveSkillCount: count, boostedActiveSkillCount: count,
  levelDistribution: z.array(z.strictObject({ level, trainedCount: count, activeCount: count })).length(6),
  groups: z.array(z.strictObject({ groupId: id.nullable(), name, skillCount: count, skillpoints: count })).max(2000),
  skills: z.array(z.strictObject({ typeId: id, name, groupId: id.nullable(), groupName: name, trainedLevel: level, activeLevel: level, skillpoints: count })).max(2000),
}).refine(value => value.skillCount === value.skills.length && new Set(value.skills.map(row => row.typeId)).size === value.skillCount && value.levelDistribution.every((row, i) => row.level === i) && new Set(value.groups.map(row => row.groupId)).size === value.groups.length && value.levelDistribution.reduce((sum, row) => sum + row.trainedCount, 0) === value.skillCount && value.levelDistribution.reduce((sum, row) => sum + row.activeCount, 0) === value.skillCount && value.groups.reduce((sum, row) => sum + row.skillCount, 0) === value.skillCount && value.groups.reduce((sum, row) => sum + row.skillpoints, 0) === value.reportedSkillSp);
const queue = z.strictObject({
  entryCount: count.max(1000), timedEntryCount: count, passedFinishEntryCount: count, nextPlannedFinishAt: date.nullable(), lastPlannedFinishAt: date.nullable(),
  entries: z.array(z.strictObject({ position: count, typeId: id, name, finishedLevel: level.min(1), startAt: date.nullable(), finishAt: date.nullable(), levelStartSp: count.nullable(), levelEndSp: count.nullable(), trainingStartSp: count.nullable() })).max(1000),
}).refine(value => value.entryCount === value.entries.length && value.timedEntryCount <= value.entryCount && value.passedFinishEntryCount <= value.entryCount && new Set(value.entries.map(row => row.position)).size === value.entries.length);
const attributes = z.strictObject({ charisma: count, intelligence: count, memory: count, perception: count, willpower: count, bonusRemaps: count.nullable(), lastRemapAt: date.nullable(), accruedRemapCooldownAt: date.nullable() });
const characterSchema = z.strictObject({
  characterId: id, generatedAt: date, status, message: text,
  skills: section(skills, 'esi-skills.read_skills.v1'), queue: section(queue, 'esi-skills.read_skillqueue.v1'), attributes: section(attributes, 'esi-skills.read_skills.v1'),
});
// A received finite JSON number can contain 324 fractional digits (5e-324).
// 2,500 bounded amounts fit in 20 integer digits; exact checks below also
// constrain the combined incoming/outgoing magnitude to the reported count.
const decimal = z.string().max(345).regex(/^(?:0|[1-9]\d{0,19})(?:\.\d{1,324})?$/);
const signed = z.string().max(346).regex(/^-?(?:0|[1-9]\d{0,19})(?:\.\d{1,324})?$/);
const totals = z.strictObject({ incomingISK: decimal, outgoingISK: decimal, netISK: signed });
const bucket = { entries: count.max(2500), amountEntries: count.max(2500), missingAmountEntries: count.max(2500), totals: totals.nullable() };
const categoryIds = ['market', 'transfers', 'rewards', 'fees', 'industry', 'contracts', 'other'] as const;
const walletSchema = z.strictObject({
  characterId: id, entity: z.enum(['character', 'corporation']), division: id.max(7).nullable(), corporationId: id.nullable(), generatedAt: date, status, message: text, scope: z.enum(['esi-wallet.read_character_wallet.v1', 'esi-wallet.read_corporation_wallets.v1']),
  coverage: z.strictObject({ kind: z.enum(['complete_returned_window', 'partial', 'unknown', 'unavailable']), page: id.max(500), pages: id.nullable(), nextPage: id.max(500).nullable(), previousPage: id.max(500).nullable(), pageLimitReached: z.boolean(), entries: count.max(2500), amountEntries: count.max(2500), missingAmountEntries: count.max(2500), earliest: date.nullable(), latest: date.nullable() }),
  freshness: z.strictObject({ state: freshness, retrievedAt: date.nullable(), cacheExpires: date.nullable(), lastModified: date.nullable() }), totals: totals.nullable(),
  daily: z.array(z.strictObject({ date: day, ...bucket })).max(2500), categories: z.array(z.strictObject({ id: z.enum(categoryIds), label: name, ...bucket })).max(7), precisionPolicy: text, limitations: z.array(text).max(20),
});
const invalid = () => new ConnectionResponseError('The analytics service returned an incomplete response. Refresh and try again.');
function skillSummariesMatch(value: CharacterSkillsAnalytics): boolean {
  if (value.reportedSkillSp !== value.skills.reduce((sum, row) => sum + row.skillpoints, 0) ||
      value.trainedSkillCount !== value.skills.filter(row => row.trainedLevel > 0).length ||
      value.activeSkillCount !== value.skills.filter(row => row.activeLevel > 0).length ||
      value.reducedActiveSkillCount !== value.skills.filter(row => row.activeLevel < row.trainedLevel).length ||
      value.boostedActiveSkillCount !== value.skills.filter(row => row.activeLevel > row.trainedLevel).length) return false;
  if (value.levelDistribution.some(row => row.trainedCount !== value.skills.filter(skill => skill.trainedLevel === row.level).length || row.activeCount !== value.skills.filter(skill => skill.activeLevel === row.level).length)) return false;
  return value.groups.every(group => {
    const members = value.skills.filter(skill => skill.groupId === group.groupId);
    return members.length > 0 && members.length === group.skillCount && members.every(skill => skill.groupName === group.name) && members.reduce((sum, skill) => sum + skill.skillpoints, 0) === group.skillpoints;
  });
}
export function characterAnalyticsResponse(value: unknown, args: CharacterAnalyticsRequest): CharacterAnalytics {
  const parsed = characterSchema.safeParse(value);
  if (!parsed.success || parsed.data.characterId !== args.characterId) throw invalid();
  const result = parsed.data, sections = [result.skills, result.queue, result.attributes], generated = Date.parse(result.generatedAt);
  for (const part of sections) {
    if (part.data === null) { if (['ready', 'partial'].includes(part.status) || part.retrievedAt !== null || part.cacheExpires !== null || part.freshness !== 'unknown') throw invalid(); }
    else if (part.retrievedAt === null || part.freshness !== (part.cacheExpires === null ? 'unknown' : Date.parse(part.cacheExpires) <= generated ? 'stale' : 'fresh') || part.status !== (part.freshness === 'fresh' ? 'ready' : 'partial')) throw invalid();
  }
  const expectedStatus = sections.every(part => part.status === 'ready') ? 'ready' : sections.some(part => part.data !== null) ? 'partial' : sections.every(part => part.status === 'needs_permission') ? 'needs_permission' : sections.some(part => part.status === 'error') ? 'error' : 'unavailable';
  if (result.status !== expectedStatus || result.skills.data && !skillSummariesMatch(result.skills.data)) throw invalid();
  if (result.queue.data) {
    const queue = result.queue.data, entries = queue.entries;
    const future = entries.flatMap(row => row.finishAt !== null && Date.parse(row.finishAt) > generated ? [row.finishAt] : []).sort((a, b) => Date.parse(a) - Date.parse(b));
    if (new Set(entries.map(row => `${row.typeId}:${row.finishedLevel}`)).size !== entries.length || entries.some((row, index) => index > 0 && row.position <= entries[index - 1].position || row.startAt !== null && row.finishAt !== null && Date.parse(row.finishAt) < Date.parse(row.startAt) || row.levelStartSp !== null && row.levelEndSp !== null && row.levelEndSp < row.levelStartSp) ||
        queue.timedEntryCount !== entries.filter(row => row.startAt !== null && row.finishAt !== null).length || queue.passedFinishEntryCount !== entries.filter(row => row.finishAt !== null && Date.parse(row.finishAt) <= generated).length ||
        queue.nextPlannedFinishAt !== (future[0] ?? null) || queue.lastPlannedFinishAt !== (future[future.length - 1] ?? null)) throw invalid();
  }
  return result;
}
function exactParts(values: string[]): bigint[] {
  const scale = Math.max(0, ...values.map(value => value.split('.')[1]?.length ?? 0));
  return values.map(value => { const negative = value.startsWith('-'), [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.'); return BigInt(whole + fraction.padEnd(scale, '0')) * (negative ? -1n : 1n); });
}
function validTotals(value: WalletActivityTotals, amounts: number): boolean {
  const [incoming, outgoing, net] = exactParts([value.incomingISK, value.outgoingISK, value.netISK]);
  const [combinedIncoming, combinedOutgoing, combinedLimit] = exactParts([value.incomingISK, value.outgoingISK, String(BigInt(Number.MAX_SAFE_INTEGER) * BigInt(amounts))]);
  return incoming - outgoing === net && combinedIncoming + combinedOutgoing <= combinedLimit;
}
function validBucket(value: WalletActivityBucket): boolean {
  return value.entries === value.amountEntries + value.missingAmountEntries && (value.totals === null ? value.entries > 0 && value.amountEntries === 0 : (value.entries === 0 || value.amountEntries > 0) && validTotals(value.totals, value.amountEntries));
}
function matchingBuckets(values: WalletActivityBucket[], total: WalletActivityBucket): boolean {
  if (values.some(value => value.entries === 0 || !validBucket(value)) || values.reduce((sum, value) => sum + value.entries, 0) !== total.entries || values.reduce((sum, value) => sum + value.amountEntries, 0) !== total.amountEntries) return false;
  for (const key of ['incomingISK', 'outgoingISK', 'netISK'] as const) {
    const amounts = exactParts([total.totals?.[key] ?? '0', ...values.map(value => value.totals?.[key] ?? '0')]);
    if (amounts[0] !== amounts.slice(1).reduce((sum, amount) => sum + amount, 0n)) return false;
  }
  return true;
}
const categoryLabels = { market: 'Market activity', transfers: 'Transfers', rewards: 'Rewards and bounties', fees: 'Taxes and fees', industry: 'Industry and services', contracts: 'Contracts', other: 'Other activity' } as const;
export function walletAnalyticsResponse(value: unknown, args: WalletAnalyticsArgs): WalletAnalytics {
  const parsed = walletSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  const result = parsed.data, coverage = result.coverage;
  if (result.characterId !== args.characterId || result.entity !== args.entity || result.division !== (args.entity === 'corporation' ? args.division : null) || coverage.page !== (args.page ?? 1) || result.scope !== (args.entity === 'corporation' ? 'esi-wallet.read_corporation_wallets.v1' : 'esi-wallet.read_character_wallet.v1') || (args.entity === 'character' && result.corporationId !== null) || (['ready', 'partial'].includes(result.status) && args.entity === 'corporation' && result.corporationId === null) || new Set(result.daily.map(row => row.date)).size !== result.daily.length || new Set(result.categories.map(row => row.id)).size !== result.categories.length) throw invalid();
  if ([coverage, ...result.daily, ...result.categories].some(row => row.entries !== row.amountEntries + row.missingAmountEntries) || (coverage.nextPage !== null && coverage.nextPage !== coverage.page + 1) || coverage.previousPage !== (coverage.page > 1 ? coverage.page - 1 : null)) throw invalid();
  if (!['ready', 'partial'].includes(result.status)) {
    if (coverage.kind !== 'unavailable' || coverage.entries !== 0 || coverage.pages !== null || coverage.nextPage !== null || coverage.pageLimitReached || coverage.earliest !== null || coverage.latest !== null || result.corporationId !== null || result.totals !== null || result.daily.length || result.categories.length || result.freshness.state !== 'unknown' || result.freshness.retrievedAt !== null || result.freshness.cacheExpires !== null || result.freshness.lastModified !== null) throw invalid();
    return result;
  }
  const total = { ...coverage, totals: result.totals }, more = coverage.pages === null ? null : coverage.page < coverage.pages;
  const kind = coverage.pages === null ? 'unknown' : coverage.page === 1 && coverage.pages === 1 ? 'complete_returned_window' : 'partial';
  const expectedFreshness = result.freshness.cacheExpires === null ? 'unknown' : Date.parse(result.freshness.cacheExpires) <= Date.parse(result.generatedAt) ? 'stale' : 'fresh';
  if (!validBucket(total) || !matchingBuckets(result.daily, total) || !matchingBuckets(result.categories, total) || result.categories.some(row => row.label !== categoryLabels[row.id]) ||
      coverage.pages !== null && coverage.pages < coverage.page || coverage.nextPage !== (more && coverage.page < 500 ? coverage.page + 1 : null) || coverage.pageLimitReached !== (coverage.page === 500 && more !== false) || coverage.kind !== kind ||
      result.freshness.retrievedAt === null || result.freshness.state !== expectedFreshness || result.status !== (kind === 'complete_returned_window' && !coverage.missingAmountEntries && expectedFreshness === 'fresh' ? 'ready' : 'partial') ||
      result.daily.some((row, index) => index > 0 && row.date <= result.daily[index - 1].date)) throw invalid();
  if (coverage.entries === 0) { if (coverage.earliest !== null || coverage.latest !== null) throw invalid(); }
  else if (coverage.earliest === null || coverage.latest === null || Date.parse(coverage.earliest) > Date.parse(coverage.latest) || new Date(coverage.earliest).toISOString().slice(0, 10) !== result.daily[0]?.date || new Date(coverage.latest).toISOString().slice(0, 10) !== result.daily[result.daily.length - 1]?.date) throw invalid();
  return result;
}
async function read(path: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController(); const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, 60000);
  try {
    controller.signal.throwIfAborted();
    const response = await fetch('/api/eve/' + path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: controller.signal });
    if (!response.ok) throw new ConnectionResponseError(response.status === 401 ? 'Sign in again to load your analytics.' : response.status === 404 ? 'This character is no longer connected. Reload connection status.' : 'Analytics could not be loaded. Try again or review the connection.', response.status);
    if (!response.headers.get('content-type')?.includes('application/json')) throw invalid();
    const value: unknown = await response.json();
    controller.signal.throwIfAborted();
    return value;
  } catch (error) {
    if (error instanceof ConnectionResponseError) throw error;
    throw new ConnectionResponseError(controller.signal.aborted ? 'The analytics request was cancelled or timed out.' : 'The analytics service could not be reached. Try again.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export async function characterAnalyticsRequest(args: CharacterAnalyticsRequest, signal?: AbortSignal) { return characterAnalyticsResponse(await read('character-analytics', args, signal), args); }
export async function walletAnalyticsRequest(args: WalletAnalyticsArgs, signal?: AbortSignal) { return walletAnalyticsResponse(await read('wallet-analytics', args, signal), args); }

/** Chart geometry is approximate; the accompanying value stays an exact decimal string. */
export function decimalWidth(value: string, maximum: string): number {
  const scale = Math.max(value.split('.')[1]?.length ?? 0, maximum.split('.')[1]?.length ?? 0);
  const units = (input: string) => { const [whole, fraction = ''] = input.split('.'); return BigInt(whole + fraction.padEnd(scale, '0')); };
  const top = units(maximum); return top === 0n ? 0 : Number(units(value) * 10000n / top) / 100;
}
export function decimalMaximum(values: string[]): string {
  return values.reduce((maximum, value) => {
    const scale = Math.max(value.split('.')[1]?.length ?? 0, maximum.split('.')[1]?.length ?? 0);
    const units = (input: string) => { const [whole, fraction = ''] = input.split('.'); return BigInt(whole + fraction.padEnd(scale, '0')); };
    return units(value) > units(maximum) ? value : maximum;
  }, '0');
}
export function formatISK(value: string): string { const [whole, fraction] = value.split('.'); return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction === undefined ? '' : '.' + fraction); }
