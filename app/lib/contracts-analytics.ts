import { EveError, listConnections, readCharacterData, readCorporationData } from './eve';
import { overviewDate } from './overview-summary';
import { walletActivityExpiry as analyticsExpiry } from './wallet-analytics';
import type { ContractRecord, ContractsAnalytics, ContractStatus, ContractType } from './contracts-analytics-types';

type DatasetArgs = { characterId: number; dataset: string; parameters: { page: number } };
type Dependencies = {
  connections: (user: string) => Promise<{ characterId: number; scopes: string[] }[]>;
  character: (user: string, args: DatasetArgs, signal?: AbortSignal) => Promise<unknown>;
  corporation: (user: string, args: DatasetArgs, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
};
type Selection = { characterId: number; entity: 'character' | 'corporation'; page: number };
const scopes = { character: 'esi-contracts.read_character_contracts.v1', corporation: 'esi-contracts.read_corporation_contracts.v1' };
// CCP ESI schema, compatibility date 2026-10-31. Unrecognized enum values fail safely.
const statuses: ContractStatus[] = ['outstanding', 'in_progress', 'finished_issuer', 'finished_contractor', 'finished', 'cancelled', 'rejected', 'failed', 'deleted', 'reversed'];
const types: ContractType[] = ['unknown', 'item_exchange', 'auction', 'courier', 'loan'];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
class ContractDataError extends Error {}
const invalid = (): never => { throw new ContractDataError(); };
const limitations = [
  'Only the selected contract page is included. Changing pages replaces the result; pages are not combined and no additional page is fetched automatically.',
  'EVE lists contracts involving the selected character or corporation as issuer, acceptor or assignee. Its documented window excludes contracts older than thirty days unless they are in progress. A returned page does not establish personal ownership or complete contract history.',
  'Offer-expiry counts and charts include outstanding contracts only, using the report completion time. A passed offer date does not change the provider status or prove a contract has ended.',
  'Offer expiry is not an accepted courier delivery deadline. Acceptance dates and days to complete are reported inputs only; no courier deadline, delivery, failure, payment or profit is inferred.',
  'Titles, counterparties, locations, money, items and bids are omitted. No related detail or public name lookup is requested. Results stay in request memory with no saved history.',
  'The application rejects responses above 1,000 contracts instead of truncating summaries.',
];

export function validateContractsAnalyticsArgs(value: unknown): Selection {
  if (!record(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['characterId', 'entity', 'page'].includes(key)) ||
      !Object.hasOwn(value, 'characterId') || !integer(value.characterId, 1) || !Object.hasOwn(value, 'entity') ||
      value.entity !== 'character' && value.entity !== 'corporation' ||
      'page' in value && !Object.hasOwn(value, 'page') || Object.hasOwn(value, 'page') && !integer(value.page, 1, 500)) {
    throw new EveError('Choose one connected character, a contract feed and an optional page from 1 to 500.');
  }
  return { characterId: value.characterId, entity: value.entity, page: value.page as number | undefined ?? 1 };
}
function timestamp(value: unknown): string | null {
  const parsed = overviewDate(value);
  return parsed?.length === 24 ? parsed : null;
}
function optionalDate(value: unknown): string | null { return value == null ? null : timestamp(value) ?? invalid(); }
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
function blank(selection: Selection, at: number, status: ContractsAnalytics['status'], message: string): ContractsAnalytics {
  return {
    characterId: selection.characterId, entity: selection.entity, corporationId: null, generatedAt: new Date(at).toISOString(), status, message, scope: scopes[selection.entity],
    coverage: { kind: 'unavailable', page: selection.page, pages: null, nextPage: null, previousPage: selection.page > 1 ? selection.page - 1 : null, pageLimitReached: false, rows: 0 },
    freshness: { state: 'unknown', retrievedAt: null, cacheExpires: null, lastModified: null },
    summary: null, statusCounts: [], typeCounts: [], contracts: [], limitations: [...limitations],
  };
}
function coverage(selection: Selection, pagination: unknown, rows: number): ContractsAnalytics['coverage'] {
  if (!record(pagination) || pagination.kind !== 'page' || pagination.page !== selection.page ||
      pagination.pages !== null && !integer(pagination.pages, 1) || typeof pagination.pages === 'number' && pagination.pages < selection.page ||
      ['after', 'before', 'nextFromId', 'nextBeforeId', 'nextFromEvent'].some(key => pagination[key] != null)) return invalid();
  const page = selection.page, pages = pagination.pages as number | null, more = pages === null ? null : page < pages;
  const nextPage = more === true && page < 500 ? page + 1 : null, pageLimitReached = page === 500 && more !== false;
  if (pagination.nextPage !== nextPage || pagination.pageLimit !== undefined && pagination.pageLimit !== 500 ||
      pagination.morePagesAvailable !== undefined && pagination.morePagesAvailable !== more ||
      pagination.pageLimitReached !== undefined && pagination.pageLimitReached !== pageLimitReached) return invalid();
  return { kind: pages === null ? 'unknown' : page === 1 && pages === 1 ? 'complete_returned_response' : 'partial', page, pages, nextPage, previousPage: page > 1 ? page - 1 : null, pageLimitReached, rows };
}
function summarize(selection: Selection, response: unknown, completed: number): ContractsAnalytics {
  if (!record(response) || response.characterId !== selection.characterId || response.dataset !== 'contracts' ||
      selection.entity === 'corporation' && (response.entity !== 'corporation' || !integer(response.corporationId, 1)) ||
      selection.entity === 'character' && (response.entity !== undefined && response.entity !== 'character' || response.corporationId != null) ||
      !Array.isArray(response.data) || response.data.length > 1000) return invalid();
  const retrievedAt = timestamp(response.retrievedAt);
  if (!retrievedAt || Date.parse(retrievedAt) > completed + 60000) return invalid();
  const selectedCoverage = coverage(selection, response.pagination, response.data.length);
  const seen = new Set<number>(), statusCounts = statuses.map(status => ({ status, count: 0 })), typeCounts = types.map(type => ({ type, count: 0 }));
  const contracts: ContractRecord[] = response.data.map(row => {
    if (!record(row) || !integer(row.contract_id, 1) || seen.has(row.contract_id) ||
        typeof row.type !== 'string' || !types.includes(row.type as ContractType) ||
        typeof row.status !== 'string' || !statuses.includes(row.status as ContractStatus) ||
        row.days_to_complete != null && !integer(row.days_to_complete)) return invalid();
    seen.add(row.contract_id);
    const issuedAt = timestamp(row.date_issued), offerExpiresAt = timestamp(row.date_expired), acceptedAt = optionalDate(row.date_accepted);
    if (!issuedAt || !offerExpiresAt || Date.parse(offerExpiresAt) < Date.parse(issuedAt) || acceptedAt !== null && Date.parse(acceptedAt) < Date.parse(issuedAt)) return invalid();
    statusCounts.find(value => value.status === row.status)!.count++;
    typeCounts.find(value => value.type === row.type)!.count++;
    return { contractId: row.contract_id, type: row.type as ContractType, status: row.status as ContractStatus, issuedAt, offerExpiresAt, acceptedAt, daysToComplete: row.days_to_complete as number | null | undefined ?? null };
  }).sort((left, right) => left.offerExpiresAt.localeCompare(right.offerExpiresAt) || left.contractId - right.contractId);
  const outstanding = contracts.filter(row => row.status === 'outstanding');
  const summary = {
    contracts: contracts.length, outstanding: outstanding.length, inProgress: statusCounts.find(row => row.status === 'in_progress')!.count,
    outstandingPastExpiry: outstanding.filter(row => Date.parse(row.offerExpiresAt) <= completed).length,
    outstandingDueWithin24h: outstanding.filter(row => Date.parse(row.offerExpiresAt) > completed && Date.parse(row.offerExpiresAt) <= completed + 86400000).length,
  };
  const cacheExpires = timestamp(analyticsExpiry(response, Date.parse(retrievedAt)));
  const freshness: ContractsAnalytics['freshness'] = { state: cacheExpires === null ? 'unknown' : Date.parse(cacheExpires) <= completed ? 'stale' : 'fresh', retrievedAt, cacheExpires, lastModified: headerDate(response.lastModified) };
  const complete = selectedCoverage.kind === 'complete_returned_response' && freshness.state === 'fresh';
  const message = `${selection.entity === 'character' ? 'Character' : 'Corporation'} contract page ${selection.page}${selectedCoverage.pages === null ? '; page count unknown' : ` of ${selectedCoverage.pages}`}. ` +
    `Counts describe available records in this response; source freshness is ${freshness.state}. Offer expiry and reported contract status remain separate evidence. No history is saved.`;
  return { ...blank(selection, completed, complete ? 'ready' : 'partial', message), corporationId: selection.entity === 'corporation' ? response.corporationId as number : null,
    coverage: selectedCoverage, freshness, summary, statusCounts, typeCounts, contracts };
}

/** One owned contract page; no items, bids, name lookup, automatic continuation or storage. */
export function createContractsAnalyticsReader(dependencies: Dependencies) {
  return async (user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<ContractsAnalytics> => {
    const selection = validateContractsAnalyticsArgs(input), now = dependencies.now ?? Date.now;
    if (typeof user !== 'string' || !user) throw new EveError('Sign in to this private connector first.', 401);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    signal.throwIfAborted();
    let connection: { characterId: number; scopes: string[] } | undefined;
    try { connection = (await abortable(() => dependencies.connections(user), signal)).find(row => row.characterId === selection.characterId); }
    catch { return blank(selection, now(), 'unavailable', signal.aborted ? 'The contracts request was cancelled or reached its time limit.' : 'Connection status could not be checked. Refresh to try again.'); }
    if (!connection) throw new EveError('Choose a character connected to this private connector.', 404);
    if (!connection.scopes.includes(scopes[selection.entity])) return blank(selection, now(), 'needs_permission', 'This character has not granted the required contracts read permission. Review Connections; no extra access is requested automatically.');
    try {
      const args: DatasetArgs = { characterId: selection.characterId, dataset: 'contracts', parameters: { page: selection.page } };
      const read = selection.entity === 'corporation' ? dependencies.corporation : dependencies.character;
      const response = await abortable(() => read(user, args, signal), signal);
      return summarize(selection, response, now());
    } catch (error) {
      if (signal.aborted) return blank(selection, now(), 'unavailable', 'The contracts request was cancelled or reached its time limit. Refresh to try again.');
      if (error instanceof EveError && [401, 404, 409].includes(error.status)) return blank(selection, now(), 'unavailable', 'The connection changed or its authorization expired. Reload connection status before trying again.');
      if (error instanceof EveError && error.status === 403) return blank(selection, now(), 'unavailable', 'EVE denied this contracts read. Check the saved permission and, for corporation access, the character’s current membership and EVE access.');
      if (error instanceof EveError && error.status === 429) return blank(selection, now(), 'unavailable', 'EVE is rate limiting requests. Wait before refreshing; no automatic retry was made.');
      return blank(selection, now(), 'error', error instanceof ContractDataError ? 'EVE returned contracts that could not be summarized safely. Missing data is unknown, not zero.' : 'Contracts could not be loaded. No counts are assumed.');
    }
  };
}
export const readContractsAnalytics = createContractsAnalyticsReader({ connections: listConnections, character: readCharacterData, corporation: readCorporationData });
