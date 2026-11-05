import { EveError, listConnections, readCharacterData, readCorporationData } from './eve';
import { overviewDate, OverviewDataError, summarizeOverview } from './overview-summary';
import type { Overview, OverviewArgs, OverviewSection, OverviewSectionId, OverviewView } from './overview-types';

type SectionSpec = { id: OverviewSectionId; title: string; dataset: string; scope: string; parameters?: Record<string, unknown> };
const personal: SectionSpec[] = [
  { id: 'wallet', title: 'Wallet', dataset: 'wallet_balance', scope: 'esi-wallet.read_character_wallet.v1' },
  { id: 'training', title: 'Training', dataset: 'skill_queue', scope: 'esi-skills.read_skillqueue.v1' },
  { id: 'orders', title: 'Market orders', dataset: 'orders', scope: 'esi-markets.read_character_orders.v1' },
  { id: 'industry', title: 'Industry', dataset: 'industry_jobs', scope: 'esi-industry.read_character_jobs.v1', parameters: { includeCompleted: false } },
  { id: 'contracts', title: 'Contracts', dataset: 'contracts', scope: 'esi-contracts.read_character_contracts.v1', parameters: { page: 1 } },
  { id: 'freelance', title: 'Freelance participation', dataset: 'freelance_jobs', scope: 'esi-characters.read_freelance_jobs.v1' },
];
const corporation: SectionSpec[] = [
  { id: 'wallet', title: 'Corporation wallets', dataset: 'wallet_balances', scope: 'esi-wallet.read_corporation_wallets.v1' },
  { id: 'contracts', title: 'Corporation contracts', dataset: 'contracts', scope: 'esi-contracts.read_corporation_contracts.v1', parameters: { page: 1 } },
  { id: 'industry', title: 'Corporation industry', dataset: 'industry_jobs', scope: 'esi-industry.read_corporation_jobs.v1', parameters: { page: 1, includeCompleted: false } },
  { id: 'projects', title: 'Corporation projects', dataset: 'projects', scope: 'esi-corporations.read_projects.v1', parameters: { limit: 100, state: 'Active' } },
  { id: 'extractions', title: 'Moon extraction schedule', dataset: 'mining_extractions', scope: 'esi-industry.read_corporation_mining.v1', parameters: { page: 1 } },
  { id: 'freelance', title: 'Corporation freelance jobs', dataset: 'freelance_jobs', scope: 'esi-corporations.read_freelance_jobs.v1', parameters: { limit: 100 } },
];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
type ReadArgs = { characterId: number; dataset: string; parameters?: Record<string, unknown> };
type Dependencies = {
  connections: (user: string) => Promise<{ characterId: number; scopes: string[] }[]>;
  character: (user: string, args: ReadArgs, signal?: AbortSignal) => Promise<unknown>;
  corporation: (user: string, args: ReadArgs, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
};
export type OverviewOptions = { signal?: AbortSignal };

function args(value: unknown): OverviewArgs {
  if (!record(value) || Object.keys(value).some(key => !['characterId', 'view'].includes(key)) || !Object.hasOwn(value, 'characterId') || !positiveId(value.characterId) || !Object.hasOwn(value, 'view') || typeof value.view !== 'string' || !['personal', 'corporation'].includes(value.view)) {
    throw new EveError('Choose one connected character and a personal or corporation overview.');
  }
  return { characterId: value.characterId, view: value.view as OverviewView };
}
function blank(spec: SectionSpec, status: OverviewSection['status'], message: string): OverviewSection {
  return { id: spec.id, title: spec.title, scope: spec.scope, status, message, metrics: [], coverage: 'unavailable', retrievedAt: null, cacheExpires: null, cacheControl: null, lastModified: null };
}
function headerDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function cacheControl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512) return null;
  // Only cache directives reach the browser, never arbitrary upstream header text.
  const safe = value.split(',').map(item => item.trim().toLowerCase()).filter(item => /^(?:public|private|no-cache|no-store|must-revalidate|immutable|(?:s-maxage|max-age|stale-while-revalidate|stale-if-error)=\d{1,10})$/.test(item));
  return safe.length ? safe.join(', ') : null;
}
function coverage(value: unknown, spec: SectionSpec, view: OverviewView): { value: OverviewSection['coverage']; message: string } {
  const expected = spec.id === 'projects' || spec.id === 'freelance' && view === 'corporation' ? 'cursor' : spec.id === 'contracts' || spec.id === 'extractions' || spec.id === 'industry' && view === 'corporation' ? 'page' : 'none';
  if (!record(value) || value.kind !== expected) throw new OverviewDataError();
  if (value.kind === 'none') return { value: 'complete', message: 'One complete ESI response; provider retention and caching limits still apply.' };
  if (value.kind === 'page') {
    if (value.page !== 1 || value.pages !== null && value.pages !== undefined && !positiveId(value.pages) || value.nextPage !== null && value.nextPage !== undefined && (value.nextPage !== 2 || typeof value.pages === 'number' && value.pages < 2)) throw new OverviewDataError();
    if (value.page === 1 && value.pages === 1) return { value: 'complete', message: 'Page 1 of 1 returned; this is the provider’s available window, not lifetime history.' };
    if (positiveId(value.pages) && value.pages > 1) return { value: 'partial', message: `Only page 1 of ${value.pages} is included. Counts are not full totals.` };
    return { value: 'unknown', message: 'Only the first page is included. EVE did not provide a usable page count; completeness is unknown.' };
  }
  for (const key of ['after', 'before']) if (value[key] !== null && value[key] !== undefined && (typeof value[key] !== 'string' || !value[key].length || value[key].length > 512 || /[\x00-\x20\x7f]/.test(value[key]))) throw new OverviewDataError();
  return { value: 'unknown', message: 'Only the first cursor batch is included; full coverage is unknown even when no next cursor is supplied.' };
}

// Injection keeps all test fixtures synthetic and outside the application database.
export function createOverviewReader(dependencies: Dependencies) {
  return async function read(user: string, input: unknown, options: OverviewOptions = {}): Promise<Overview> {
    const selected = args(input), now = dependencies.now ?? Date.now;
    if (!user || typeof user !== 'string') throw new EveError('Sign in to this private connector first.', 401);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    signal.throwIfAborted();
    const connection = (await dependencies.connections(user)).find(row => row.characterId === selected.characterId);
    if (!connection) throw new EveError('Choose a character connected to this private connector.', 404);
    signal.throwIfAborted();
    const specs = selected.view === 'personal' ? personal : corporation;
    const sections: OverviewSection[] = [];
    let blocked = '', corporationId: number | undefined, corporationChanged = false;
    // Sequential requests avoid refresh-lock contention, honor rate-limit stops,
    // and ensure that corporation changes are detected before another read starts.
    for (const spec of specs) {
      if (!connection.scopes.includes(spec.scope)) {
        sections.push(blank(spec, 'needs_permission', selected.view === 'corporation' ? 'Select this optional corporation permission and authorize the character again. Existing grants are not changed automatically.' : 'Authorize this character again with the required read permission.'));
        continue;
      }
      if (signal.aborted || blocked) {
        sections.push(blank(spec, 'unavailable', blocked || 'The overview request was cancelled or reached its time limit. Refresh to try again.'));
        continue;
      }
      try {
        const reader = selected.view === 'personal' ? dependencies.character : dependencies.corporation;
        const result = await reader(user, { characterId: selected.characterId, dataset: spec.dataset, ...(spec.parameters ? { parameters: spec.parameters } : {}) }, signal);
        signal.throwIfAborted();
        if (!record(result) || result.characterId !== selected.characterId || result.dataset !== spec.dataset || !overviewDate(result.retrievedAt)) throw new OverviewDataError();
        if (selected.view === 'corporation') {
          if (!positiveId(result.corporationId)) throw new OverviewDataError();
          if (corporationId !== undefined && corporationId !== result.corporationId) {
            corporationChanged = true;
            blocked = 'The character’s corporation changed during this overview. Refresh to load one consistent corporation.';
            sections.push(blank(spec, 'unavailable', blocked));
            continue;
          }
          corporationId = result.corporationId;
        }
        const summary = summarizeOverview(spec.id, result.data, now(), selected.view === 'personal');
        const completeness = coverage(result.pagination, spec, selected.view);
        if (summary.partial) {
          completeness.value = 'partial';
          completeness.message = 'Coverage is limited to the divisions actually returned.';
        }
        sections.push({ id: spec.id, title: spec.title, scope: spec.scope, status: completeness.value === 'complete' ? 'ready' : 'partial', metrics: summary.metrics, message: `${summary.message} ${completeness.message}`, coverage: completeness.value, retrievedAt: overviewDate(result.retrievedAt), cacheExpires: headerDate(result.cacheExpires), cacheControl: cacheControl(result.cacheControl), lastModified: headerDate(result.lastModified) });
      } catch (error) {
        if (signal.aborted) {
          blocked = 'The overview request was cancelled or reached its time limit. Refresh to try again.';
          sections.push(blank(spec, 'unavailable', blocked));
        } else if (error instanceof EveError && (error.status === 401 || error.status === 404 || error.status === 409)) {
          blocked = 'The character connection changed or its authorization expired. Reload connection status and reconnect if needed.';
          sections.push(blank(spec, 'unavailable', blocked));
        } else if (error instanceof EveError && error.status === 429) {
          blocked = 'EVE is rate limiting requests. Wait before refreshing; later sections were not requested.';
          sections.push(blank(spec, 'unavailable', blocked));
        } else if (error instanceof EveError && error.status === 403) {
          sections.push(blank(spec, 'unavailable', selected.view === 'corporation' ? 'EVE denied this read. Check the granted permission and the character’s corporation role; no additional role is requested automatically.' : 'EVE denied this read. Check the character’s granted read permission.'));
        } else {
          sections.push(blank(spec, 'error', error instanceof OverviewDataError ? 'EVE returned data that could not be summarized safely. No total is shown.' : 'This EVE dataset could not be loaded. Refresh to try again; no total is assumed.'));
        }
      }
    }
    // Never label a mixed-corporation set as a single organization overview.
    if (corporationChanged) {
      corporationId = undefined;
      for (let index = 0; index < sections.length; index++) sections[index] = blank(specs[index], 'unavailable', blocked);
    }
    return {
      ...selected,
      ...(corporationId === undefined ? {} : { corporationId }),
      generatedAt: new Date(now()).toISOString(),
      coverage: selected.view === 'personal' ? 'One selected connected character. Each section reports its own freshness and coverage; other characters and accounts are not included.' : 'The selected character’s current corporation, checked at each read. Corporation data is separate from personal holdings; each section reports its own coverage.',
      sections,
    };
  };
}

export const readOverview = createOverviewReader({ connections: listConnections, character: readCharacterData, corporation: readCorporationData });
