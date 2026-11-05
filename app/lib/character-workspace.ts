import { EveError, listConnections, readCharacterData, readPublicNames } from './eve';
import { OverviewDataError, overviewDate } from './overview-summary';
import type { CharacterWorkspace, CharacterWorkspaceColumn, CharacterWorkspaceLabels, CharacterWorkspaceMetric, CharacterWorkspaceRequest, CharacterWorkspaceRow } from './character-workspace-types';

const scopes = {
  standings: 'esi-characters.read_standings.v1',
  loyalty_points: 'esi-characters.read_loyalty.v1',
  faction_warfare: 'esi-characters.read_fw_stats.v1',
  blueprints: 'esi-characters.read_blueprints.v1',
  research: 'esi-characters.read_agents_research.v1',
  planets: 'esi-planets.manage_planets.v1',
  mining: 'esi-industry.read_character_mining.v1',
} as const;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const invalid = (): never => { throw new OverviewDataError(); };
const count = (label: string, value: number): CharacterWorkspaceMetric => ({ label, value, unit: 'count' });
const date = (value: unknown): string => overviewDate(value) ?? invalid();
type Dependencies = {
  connections: (user: string) => Promise<{ characterId: number; scopes: string[] }[]>;
  character: (user: string, request: { characterId: number; dataset: string; parameters?: { page: number } }, signal?: AbortSignal) => Promise<unknown>;
  publicNames?: (ids: number[], signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
};
type Table = Pick<CharacterWorkspace, 'metrics' | 'columns' | 'rows' | 'coverage' | 'message' | 'next'>;
type UnpagedRequest = Exclude<CharacterWorkspaceRequest, { view: 'faction_warfare' } | { view: 'blueprints' } | { view: 'mining' }>;
type BlueprintRequest = Extract<CharacterWorkspaceRequest, { view: 'blueprints' }>;
type MiningRequest = Extract<CharacterWorkspaceRequest, { view: 'mining' }>;

function args(value: unknown): CharacterWorkspaceRequest {
  const fail = (): never => { throw new EveError('Choose one connected character and a supported character view.'); };
  if (!record(value) || !Object.hasOwn(value, 'characterId') || !integer(value.characterId, 1) || !Object.hasOwn(value, 'view') || typeof value.view !== 'string' || !Object.hasOwn(scopes, value.view)) return fail();
  const sliced = value.view !== 'faction_warfare';
  const paged = value.view === 'blueprints' || value.view === 'mining';
  const industry = ['blueprints', 'research', 'planets', 'mining'].includes(value.view);
  if (Object.keys(value).some(key => !['characterId', 'view', ...(sliced ? ['offset'] : []), ...(paged ? ['page'] : []), ...(industry ? ['resolveNames'] : [])].includes(key))) return fail();
  if (value.resolveNames !== undefined && typeof value.resolveNames !== 'boolean') return fail();
  const names = value.resolveNames === undefined ? {} : { resolveNames: value.resolveNames as boolean };
  if (value.offset !== undefined && (!integer(value.offset) || value.offset > 9900 || value.offset % 100 !== 0)) return fail();
  if (paged) {
    if (value.page !== undefined && (!integer(value.page, 1) || value.page > 500)) return fail();
    return { characterId: value.characterId, view: value.view as 'blueprints' | 'mining', page: (value.page as number | undefined) ?? 1, offset: (value.offset as number | undefined) ?? 0, ...names };
  }
  return sliced ? { characterId: value.characterId, view: value.view as 'standings' | 'loyalty_points' | 'research' | 'planets', offset: (value.offset as number | undefined) ?? 0, ...names } : { characterId: value.characterId, view: 'faction_warfare' };
}

function blank(selected: CharacterWorkspaceRequest, now: number, status: CharacterWorkspace['status'], message: string): CharacterWorkspace {
  return { view: selected.view, characterId: selected.characterId, generatedAt: new Date(now).toISOString(), status, coverage: 'unavailable', message, scope: scopes[selected.view], retrievedAt: null, cacheExpires: null, metrics: [], columns: [], rows: [], next: null };
}
function headerDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function list(value: unknown, idKey: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 10000) return invalid();
  const seen = new Set<number>();
  return value.map(row => {
    if (!record(row) || !integer(row[idKey], 1) || seen.has(row[idKey])) return invalid();
    seen.add(row[idKey]);
    return row;
  });
}
function slice(selected: UnpagedRequest, all: CharacterWorkspaceRow[], metrics: CharacterWorkspaceMetric[], columns: CharacterWorkspaceColumn[], message: string): Table {
  const offset = selected.offset ?? 0;
  if (offset && offset >= all.length) return { metrics: [], columns, rows: [], next: null, coverage: 'unknown', message: 'This slice is no longer available. The provider response may have changed; reload the first batch. ' + (selected.view === 'research' || selected.view === 'planets' ? 'No missing value is assumed.' : 'No balance or standing is assumed.') };
  const rows = all.slice(offset, offset + 100), more = offset + rows.length < all.length;
  return { metrics, columns, rows, next: more ? { ...selected, offset: offset + 100 } : null, coverage: offset === 0 && !more ? 'complete' : 'partial', message: `${message} Summary counts cover the ${all.length} entries in this ESI response; this table shows ${rows.length}${all.length ? ` from positions ${offset + 1}–${offset + rows.length}` : ''}. Each batch rereads the current response, so changes may overlap or omit entries between batches. This is not a saved history.` };
}
function standings(selected: UnpagedRequest, data: unknown): Table {
  const kinds = { agent: 'Agent', npc_corp: 'NPC corporation', faction: 'Faction' } as const;
  const priority = { faction: 0, npc_corp: 1, agent: 2 } as const;
  const all = list(data, 'from_id').map(row => {
    if (typeof row.from_type !== 'string' || !Object.hasOwn(kinds, row.from_type) || typeof row.standing !== 'number' || !Number.isFinite(row.standing) || row.standing < -10 || row.standing > 10) return invalid();
    return { kind: row.from_type as keyof typeof kinds, source: row.from_id as number, standing: row.standing };
  }).sort((a, b) => priority[a.kind] - priority[b.kind] || a.source - b.source);
  const metrics = [count('Standings returned', all.length), count('Positive standings', all.filter(row => row.standing > 0).length), count('Negative standings', all.filter(row => row.standing < 0).length), count('Zero standings', all.filter(row => row.standing === 0).length)];
  const rows = all.map(row => ({ id: `${row.kind}-${row.source}`, cells: { kind: kinds[row.kind], sourceId: row.source, standing: row.standing } }));
  return slice(selected, rows, metrics, [{ key: 'kind', label: 'Source kind' }, { key: 'sourceId', label: 'Source ID' }, { key: 'standing', label: 'Reported standing', unit: 'standing' }], 'Reported standings from NPC agents, NPC corporations and factions to this character. No skills-based adjustment is applied, and these values do not guarantee agent, station or faction access. Missing NPC entries are not neutral standings. Rows are ordered by source kind and ID; no contact list or name lookup is requested.');
}
function loyalty(selected: UnpagedRequest, data: unknown): Table {
  const all = list(data, 'corporation_id').map(row => {
    if (!integer(row.loyalty_points)) return invalid();
    return { corporation: row.corporation_id as number, points: row.loyalty_points };
  }).sort((a, b) => a.corporation - b.corporation);
  const metrics = [count('NPC corporations returned', all.length), count('Corporations with LP', all.filter(row => row.points > 0).length)];
  const rows = all.map(row => ({ id: String(row.corporation), cells: { corporationId: row.corporation, points: row.points } }));
  return slice(selected, rows, metrics, [{ key: 'corporationId', label: 'NPC corporation ID' }, { key: 'points', label: 'Loyalty points', unit: 'LP' }], 'Loyalty points are shown separately for each returned NPC corporation. They are not ISK, are not added across corporations, and no redemption value or profit is estimated. Missing corporations are not zero balances. Rows are ordered by corporation ID; no store offers, transactions or name lookup are requested.');
}
// Official character-blueprint enum; unknown values are not displayed as free text.
const blueprintLocationFlags = ['AutoFit', 'Cargo', 'CorpseBay', 'DroneBay', 'FleetHangar', 'Deliveries', 'HiddenModifiers', 'Hangar', 'HangarAll', 'LoSlot0', 'LoSlot1', 'LoSlot2', 'LoSlot3', 'LoSlot4', 'LoSlot5', 'LoSlot6', 'LoSlot7', 'MedSlot0', 'MedSlot1', 'MedSlot2', 'MedSlot3', 'MedSlot4', 'MedSlot5', 'MedSlot6', 'MedSlot7', 'HiSlot0', 'HiSlot1', 'HiSlot2', 'HiSlot3', 'HiSlot4', 'HiSlot5', 'HiSlot6', 'HiSlot7', 'AssetSafety', 'Locked', 'Unlocked', 'Implant', 'QuafeBay', 'RigSlot0', 'RigSlot1', 'RigSlot2', 'RigSlot3', 'RigSlot4', 'RigSlot5', 'RigSlot6', 'RigSlot7', 'ShipHangar', 'SpecializedFuelBay', 'SpecializedOreHold', 'SpecializedGasHold', 'SpecializedMineralHold', 'SpecializedSalvageHold', 'SpecializedShipHold', 'SpecializedSmallShipHold', 'SpecializedMediumShipHold', 'SpecializedLargeShipHold', 'SpecializedIndustrialShipHold', 'SpecializedAmmoHold', 'SpecializedCommandCenterHold', 'SpecializedPlanetaryCommoditiesHold', 'SpecializedMaterialBay', 'SubSystemSlot0', 'SubSystemSlot1', 'SubSystemSlot2', 'SubSystemSlot3', 'SubSystemSlot4', 'SubSystemSlot5', 'SubSystemSlot6', 'SubSystemSlot7', 'FighterBay', 'FighterTube0', 'FighterTube1', 'FighterTube2', 'FighterTube3', 'FighterTube4', 'Module'];
function blueprints(selected: BlueprintRequest, data: unknown, pagination: unknown): Table {
  const page = selected.page ?? 1, offset = selected.offset ?? 0;
  if (!record(pagination) || pagination.kind !== 'page' || pagination.page !== page) return invalid();
  const pages = pagination.pages === null || pagination.pages === undefined ? null : integer(pagination.pages, page) ? pagination.pages : invalid();
  const expectedNext = pages !== null && page < pages && page < 500 ? page + 1 : null;
  if ((pagination.nextPage ?? null) !== expectedNext) return invalid();
  const all = list(data, 'item_id').map(row => {
    if (!integer(row.type_id, 1) || !integer(row.location_id, 1) || !integer(row.material_efficiency) || !integer(row.time_efficiency) ||
        !integer(row.quantity, -2) || row.quantity === 0 || !integer(row.runs, -1) || (row.quantity === -2 ? row.runs < 0 : row.runs !== -1) ||
        typeof row.location_flag !== 'string' || !blueprintLocationFlags.includes(row.location_flag)) return invalid();
    const kind = row.quantity === -2 ? 'Copy' : row.quantity === -1 ? 'Original' : 'Original stack';
    return { id: String(row.item_id), cells: { item: row.item_id as number, type: row.type_id, kind, units: row.quantity < 0 ? 1 : row.quantity, materialEfficiency: row.material_efficiency, timeEfficiency: row.time_efficiency, runs: row.quantity === -2 ? row.runs : 'Unlimited (original)', location: row.location_id, flag: row.location_flag } };
  }).sort((a, b) => a.cells.item - b.cells.item);
  const columns: CharacterWorkspaceColumn[] = [{ key: 'item', label: 'Blueprint item ID' }, { key: 'type', label: 'Blueprint type ID' }, { key: 'kind', label: 'Blueprint kind' }, { key: 'units', label: 'Blueprint units', unit: 'count' }, { key: 'materialEfficiency', label: 'Material efficiency', unit: 'count' }, { key: 'timeEfficiency', label: 'Time efficiency', unit: 'count' }, { key: 'runs', label: 'Copy runs remaining / original' }, { key: 'location', label: 'Location ID' }, { key: 'flag', label: 'Location flag' }];
  if (offset && offset >= all.length) return { metrics: [], columns, rows: [], next: null, coverage: 'unknown', message: 'This blueprint slice is no longer available. The provider page may have changed; reload its first batch. No blueprint quantity is assumed.' };
  const rows = all.slice(offset, offset + 100), moreInPage = offset + rows.length < all.length;
  const next = moreInPage ? { ...selected, page, offset: offset + 100 } : expectedNext ? { ...selected, page: expectedNext, offset: 0 } : null;
  const complete = page === 1 && pages === 1 && offset === 0 && !next;
  const metrics = [count('Blueprint rows in this page', all.length), count('Original rows', all.filter(row => row.cells.kind === 'Original').length), count('Copy rows', all.filter(row => row.cells.kind === 'Copy').length), count('Original stack rows', all.filter(row => row.cells.kind === 'Original stack').length)];
  return { metrics, columns, rows, next, coverage: complete ? 'complete' : pages === null ? 'unknown' : 'partial', message: `Summary counts cover ${all.length} blueprint rows on page ${page}${pages === null ? '; the full page count is unknown' : ` of ${pages}`}. Showing ${rows.length}${all.length ? ` from positions ${offset + 1}–${offset + rows.length}` : ''}. ${complete ? 'This is the provider’s available blueprint response.' : 'This batch is not a complete character inventory.'} Each batch rereads a changing page and may overlap or omit records. Originals and fresh original stacks report unlimited original runs; copies have finite remaining runs. Blueprint units are items, not manufacturing output. Location IDs may be stations, ships or containers and are not resolved. No material requirements, production capacity, job availability or profit is inferred.${page === 500 && (pages === null || pages > 500) ? ' The 500-page safety limit has been reached; completeness is not assumed.' : ''}` };
}
function mining(selected: MiningRequest, data: unknown, pagination: unknown): Table {
  const page = selected.page ?? 1, offset = selected.offset ?? 0;
  if (!record(pagination) || pagination.kind !== 'page' || pagination.page !== page) return invalid();
  const pages = pagination.pages === null || pagination.pages === undefined ? null : integer(pagination.pages, page) ? pagination.pages : invalid();
  const expectedNext = pages !== null && page < pages && page < 500 ? page + 1 : null;
  if ((pagination.nextPage ?? null) !== expectedNext || !Array.isArray(data) || data.length > 10000) return invalid();
  const seen = new Set<string>();
  const all = data.map(row => {
    if (!record(row) || typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
        !Number.isFinite(Date.parse(row.date + 'T00:00:00Z')) || new Date(row.date + 'T00:00:00Z').toISOString().slice(0, 10) !== row.date ||
        !integer(row.type_id, 1) || !integer(row.solar_system_id, 1) || !integer(row.quantity)) return invalid();
    const id = `${row.date}-${row.type_id}-${row.solar_system_id}`;
    if (seen.has(id)) return invalid();
    seen.add(id);
    return { id, cells: { date: row.date, type: row.type_id, system: row.solar_system_id, quantity: row.quantity } };
  }).sort((a, b) => b.cells.date.localeCompare(a.cells.date) || a.cells.type - b.cells.type || a.cells.system - b.cells.system);
  const columns: CharacterWorkspaceColumn[] = [{ key: 'date', label: 'Date (UTC)' }, { key: 'type', label: 'Type ID' }, { key: 'system', label: 'Solar system ID' }, { key: 'quantity', label: 'Quantity', unit: 'count' }];
  if (offset && offset >= all.length) return { metrics: [], columns, rows: [], next: null, coverage: 'unknown', message: 'This mining slice is no longer available. The provider page may have changed; reload its first batch. No missing mining quantity is assumed.' };
  const rows = all.slice(offset, offset + 100), moreInPage = offset + rows.length < all.length;
  const next = moreInPage ? { ...selected, page, offset: offset + 100 } : expectedNext ? { ...selected, page: expectedNext, offset: 0 } : null;
  const complete = page === 1 && pages === 1 && offset === 0 && !next;
  const metrics = [count('Mining records in this page', all.length), count('Types in this page', new Set(all.map(row => row.cells.type)).size), count('Solar systems in this page', new Set(all.map(row => row.cells.system)).size)];
  return { metrics, columns, rows, next, coverage: complete ? 'complete' : pages === null ? 'unknown' : 'partial', message: `Summary counts cover ${all.length} mining records on page ${page}${pages === null ? '; the full page count is unknown' : ` of ${pages}`}. Showing ${rows.length}${all.length ? ` from positions ${offset + 1}–${offset + rows.length}` : ''}. Records report quantities by UTC date, type and solar system. ESI describes a rolling past-30-day ledger, not all-time mining history. ${complete ? 'Coverage is complete only for this available provider response.' : 'This batch does not establish complete ledger coverage.'} Each batch rereads a changing page and may overlap or omit records. Quantities stay separate by type; no mixed-item total, volume, ore value, income or profit is calculated. Selecting this view reveals the listed mining dates and solar-system IDs; no observer or corporation mining read is made.${page === 500 && (pages === null || pages > 500) ? ' The 500-page safety limit has been reached; completeness is not assumed.' : ''}` };
}
function research(selected: UnpagedRequest, data: unknown): Table {
  const amount = (value: unknown, signed = false): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER && (signed || value >= 0);
  const all = list(data, 'agent_id').map(row => {
    if (!integer(row.skill_type_id, 1) || !amount(row.points_per_day) || !amount(row.remainder_points, true)) return invalid();
    return { id: String(row.agent_id), cells: { agent: row.agent_id as number, skill: row.skill_type_id, started: date(row.started_at), daily: row.points_per_day, remainder: row.remainder_points } };
  }).sort((a, b) => a.cells.agent - b.cells.agent);
  return slice(selected, all, [count('Research agents returned', all.length)], [{ key: 'agent', label: 'Agent ID' }, { key: 'skill', label: 'Research skill type ID' }, { key: 'started', label: 'Research started (UTC)', unit: 'datetime' }, { key: 'daily', label: 'Reported rate', unit: 'RP/day' }, { key: 'remainder', label: 'Reported remainder', unit: 'RP' }], 'Research rates, signed remainders and start times are reported inputs for each agent. No accrued, current, redeemable or lifetime research-point balance is calculated, and rates from different research fields are not added together. No agent or station lookup is performed; skill labels are optional public type names. Datacore yields and profit are not inferred.');
}
function planets(selected: UnpagedRequest, data: unknown): Table {
  const kinds = ['temperate', 'barren', 'oceanic', 'ice', 'gas', 'lava', 'storm', 'plasma'];
  const all = list(data, 'planet_id').map(row => {
    if (row.owner_id !== selected.characterId || !integer(row.solar_system_id, 1) || typeof row.planet_type !== 'string' || !kinds.includes(row.planet_type) || !integer(row.upgrade_level) || !integer(row.num_pins)) return invalid();
    return { id: String(row.planet_id), cells: { planet: row.planet_id as number, system: row.solar_system_id, type: row.planet_type, upgrade: row.upgrade_level, pins: row.num_pins, updated: date(row.last_update) } };
  }).sort((a, b) => a.cells.planet - b.cells.planet);
  return slice(selected, all, [count('Colonies returned', all.length)], [{ key: 'planet', label: 'Planet ID' }, { key: 'system', label: 'Solar system ID' }, { key: 'type', label: 'Planet type' }, { key: 'upgrade', label: 'Command center upgrade', unit: 'count' }, { key: 'pins', label: 'Reported pins', unit: 'count' }, { key: 'updated', label: 'Colony updated (UTC)', unit: 'datetime' }], 'This deliberately selected colony list reveals planet and solar-system IDs for this character. Last update is provider metadata, not proof of current extraction, production, inventory or readiness. Pin counts and command-center upgrade levels do not measure output. Colony layout, pin contents, routes and extractor programs are not requested; no production forecast, customs cost or profit is inferred.');
}
function warfare(data: unknown): Table {
  if (!record(data) || !record(data.kills) || !record(data.victory_points)) return invalid();
  const periods = [{ id: 'yesterday', label: 'Yesterday' }, { id: 'last_week', label: 'Last week' }, { id: 'total', label: 'Reported total' }];
  const rows = periods.map(period => {
    const kills = (data.kills as Record<string, unknown>)[period.id], victoryPoints = (data.victory_points as Record<string, unknown>)[period.id];
    if (!integer(kills) || !integer(victoryPoints)) return invalid();
    return { id: period.id, cells: { period: period.label, kills, victoryPoints } };
  });
  if (data.faction_id !== undefined && !integer(data.faction_id, 1)) return invalid();
  const enlisted = data.enlisted_on === undefined ? undefined : date(data.enlisted_on);
  for (const key of ['current_rank', 'highest_rank']) if (data[key] !== undefined && !integer(data[key])) return invalid();
  const hasFaction = data.faction_id !== undefined, hasDate = enlisted !== undefined;
  const incomplete = hasFaction !== hasDate;
  const metrics: CharacterWorkspaceMetric[] = [
    { label: 'Enrollment', value: incomplete ? 'Incomplete fields' : hasFaction ? 'Reported' : 'Not reported' },
    { label: 'Faction ID', value: data.faction_id as number | undefined ?? 'Not reported' },
    { label: 'Enlisted (UTC)', value: enlisted ?? 'Not reported', ...(enlisted ? { unit: 'datetime' as const } : {}) },
    { label: 'Current rank', value: data.current_rank as number | undefined ?? 'Not reported', ...(data.current_rank === undefined ? {} : { unit: 'count' as const }) },
    { label: 'Highest rank', value: data.highest_rank as number | undefined ?? 'Not reported', ...(data.highest_rank === undefined ? {} : { unit: 'count' as const }) },
  ];
  return { metrics, columns: [{ key: 'period', label: 'Period' }, { key: 'kills', label: 'Kills', unit: 'count' }, { key: 'victoryPoints', label: 'Victory points', unit: 'count' }], rows, next: null, coverage: incomplete ? 'unknown' : 'complete', message: 'EVE reports yesterday, last week and total faction-warfare counters; no today counter or live combat feed is provided. EVE describes total counters as since enlistment, not lifetime history. These periods overlap and must not be added together. Rank numbers and enrollment fields are displayed as reported; missing optional fields remain unreported, not zero. Counters do not reveal individual killmails, opponents, locations, rewards or profit.' + (incomplete ? ' Enrollment fields are incomplete; current enlistment cannot be determined from this response.' : !hasFaction ? ' This successful response reports no current enrollment fields; request failures are never interpreted as non-enrollment.' : '') };
}

async function publicLabels(selected: CharacterWorkspaceRequest, rendered: Table, dependencies: Dependencies, signal: AbortSignal): Promise<CharacterWorkspaceLabels | undefined> {
  if (!('resolveNames' in selected) || selected.resolveNames !== true || !rendered.rows.length) return undefined;
  const fallback: CharacterWorkspaceLabels = { status: 'unavailable', message: 'Public type/system labels could not be loaded safely. Original IDs remain visible; no retry or additional private lookup was made.', retrievedAt: null, cacheExpires: null, names: [] };
  try {
    const expected = new Map<number, 'inventory_type' | 'solar_system'>();
    // Only semantic public IDs from the displayed slice leave the private result.
    // Never send item, container, location, planet, agent or character identifiers.
    const keys = selected.view === 'research' ? ['skill'] : selected.view === 'blueprints' ? ['type'] : selected.view === 'planets' ? ['system'] : selected.view === 'mining' ? ['type', 'system'] : [];
    for (const row of rendered.rows) for (const key of keys) {
      const id = row.cells[key], category = key === 'system' ? 'solar_system' : 'inventory_type';
      if (!integer(id, 1) || expected.has(id) && expected.get(id) !== category) return invalid();
      expected.set(id, category);
    }
    if (!expected.size || expected.size > 200 || !dependencies.publicNames) return fallback;
    signal.throwIfAborted();
    const result = await dependencies.publicNames([...expected.keys()], signal);
    signal.throwIfAborted();
    if (!record(result) || !overviewDate(result.retrievedAt) || !Array.isArray(result.data) || result.data.length > expected.size) return invalid();
    const seen = new Set<number>();
    const names: CharacterWorkspaceLabels['names'] = result.data.map(item => {
      if (!record(item) || !integer(item.id, 1) || seen.has(item.id) || !expected.has(item.id) || item.category !== expected.get(item.id) ||
          typeof item.name !== 'string' || !item.name.trim() || item.name.length > 512 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(item.name)) return invalid();
      seen.add(item.id);
      return { id: item.id, category: expected.get(item.id)!, name: item.name.trim() };
    });
    return { status: names.length < expected.size ? 'partial' : 'ready', message: `Public labels resolved for ${names.length} of ${expected.size} displayed type/system IDs. Unresolved IDs remain visible. Labels do not expand the private dataset’s coverage.`, retrievedAt: date(result.retrievedAt), cacheExpires: headerDate(result.cacheExpires), names };
  } catch {
    signal.throwIfAborted();
    return fallback;
  }
}

// Synthetic dependency injection keeps development tests independent of live accounts.
export function createCharacterWorkspaceReader(dependencies: Dependencies) {
  return async function read(user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<CharacterWorkspace> {
    const selected = args(input), now = dependencies.now ?? Date.now;
    if (!user || typeof user !== 'string') throw new EveError('Sign in to this private connector first.', 401);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    signal.throwIfAborted();
    const connection = (await dependencies.connections(user)).find(row => row.characterId === selected.characterId);
    if (!connection) throw new EveError('Choose a character connected to this private connector.', 404);
    signal.throwIfAborted();
    if (!connection.scopes.includes(scopes[selected.view])) return blank(selected, now(), 'needs_permission', 'This character has not granted the required read permission. Explicitly choose character read access and authorize again; existing grants are not changed automatically.');
    try {
      const result = await dependencies.character(user, { characterId: selected.characterId, dataset: selected.view, ...(selected.view === 'blueprints' || selected.view === 'mining' ? { parameters: { page: selected.page ?? 1 } } : {}) }, signal);
      signal.throwIfAborted();
      if (!record(result) || (result.entity !== undefined && result.entity !== 'character') || result.characterId !== selected.characterId || result.dataset !== selected.view || !overviewDate(result.retrievedAt) || !record(result.pagination) || (selected.view !== 'blueprints' && selected.view !== 'mining' && result.pagination.kind !== 'none')) return invalid();
      const rendered = selected.view === 'standings' ? standings(selected, result.data) : selected.view === 'loyalty_points' ? loyalty(selected, result.data) : selected.view === 'blueprints' ? blueprints(selected, result.data, result.pagination) : selected.view === 'research' ? research(selected, result.data) : selected.view === 'planets' ? planets(selected, result.data) : selected.view === 'mining' ? mining(selected, result.data, result.pagination) : warfare(result.data);
      const labels = await publicLabels(selected, rendered, dependencies, signal);
      signal.throwIfAborted();
      // Classify every expiry against the same completion time exposed to the
      // client; a clock boundary between separate checks must not contradict it.
      const completedAt = now(), cacheExpires = headerDate(result.cacheExpires), stale = cacheExpires !== null && Date.parse(cacheExpires) <= completedAt;
      if (labels && labels.status !== 'unavailable' && labels.cacheExpires !== null && Date.parse(labels.cacheExpires) <= completedAt) {
        labels.status = 'partial';
        labels.message += ' Public label data has reached its reported cache expiry.';
      }
      return { ...blank(selected, completedAt, rendered.coverage === 'complete' && !stale ? 'ready' : 'partial', rendered.message), ...rendered, ...(labels ? { labels } : {}), retrievedAt: date(result.retrievedAt), cacheExpires, message: rendered.message + (stale ? ' This response has reached its reported cache expiry; refresh before relying on it.' : '') };
    } catch (error) {
      if (signal.aborted) return blank(selected, now(), 'unavailable', 'The request was cancelled or reached its time limit. Load the view again to retry.');
      if (error instanceof EveError && error.status === 403) return blank(selected, now(), 'unavailable', 'EVE denied this read. Check this character’s granted read permission. No additional access is requested automatically.');
      if (error instanceof EveError && error.status === 429) return blank(selected, now(), 'unavailable', 'EVE is rate limiting requests. Wait before loading the view again. No automatic retry was made.');
      if (error instanceof EveError && [401, 404, 409].includes(error.status)) return blank(selected, now(), 'unavailable', 'The connection changed or its authorization expired. Reload connection status and reconnect if needed.');
      if (selected.view === 'faction_warfare' && error instanceof EveError && error.upstreamStatus === 404) return blank(selected, now(), 'unavailable', 'EVE did not return faction-warfare statistics. This response does not establish enrollment status; load the view again later.');
      return blank(selected, now(), 'error', error instanceof OverviewDataError ? 'EVE returned data that could not be displayed safely. No missing standing, balance or statistic is assumed to be zero.' : 'This EVE read could not be loaded. Try again; no missing standing, balance or statistic is assumed to be zero.');
    }
  };
}

export const readCharacterWorkspace = createCharacterWorkspaceReader({ connections: listConnections, character: readCharacterData, publicNames: readPublicNames });
