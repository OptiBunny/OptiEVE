import { ConnectionResponseError } from './connection-client';
import type { CharacterWorkspace, CharacterWorkspaceRequest } from './character-workspace-types';

const industryViews = ['blueprints', 'research', 'planets', 'mining'];
const views = ['standings', 'loyalty_points', 'faction_warfare', ...industryViews];
const workspaceName = (value: unknown) => record(value) && typeof value.view === 'string' && industryViews.includes(value.view) ? 'industry' : 'reputation';
const scopes: Record<string, string> = {
  standings: 'esi-characters.read_standings.v1', loyalty_points: 'esi-characters.read_loyalty.v1', faction_warfare: 'esi-characters.read_fw_stats.v1',
  blueprints: 'esi-characters.read_blueprints.v1', research: 'esi-characters.read_agents_research.v1', planets: 'esi-planets.manage_planets.v1', mining: 'esi-industry.read_character_mining.v1',
};
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 2048;
const integer = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const date = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const nullableDate = (value: unknown) => value === null || date(value);
const ledgerDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const standing = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= -10 && value <= 10;
const researchPoints = (value: unknown, signed = false): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER && (signed || value >= 0);
// Match the official character-blueprint enum; never display unknown free text.
const blueprintLocationFlags = ['AutoFit', 'Cargo', 'CorpseBay', 'DroneBay', 'FleetHangar', 'Deliveries', 'HiddenModifiers', 'Hangar', 'HangarAll', 'LoSlot0', 'LoSlot1', 'LoSlot2', 'LoSlot3', 'LoSlot4', 'LoSlot5', 'LoSlot6', 'LoSlot7', 'MedSlot0', 'MedSlot1', 'MedSlot2', 'MedSlot3', 'MedSlot4', 'MedSlot5', 'MedSlot6', 'MedSlot7', 'HiSlot0', 'HiSlot1', 'HiSlot2', 'HiSlot3', 'HiSlot4', 'HiSlot5', 'HiSlot6', 'HiSlot7', 'AssetSafety', 'Locked', 'Unlocked', 'Implant', 'QuafeBay', 'RigSlot0', 'RigSlot1', 'RigSlot2', 'RigSlot3', 'RigSlot4', 'RigSlot5', 'RigSlot6', 'RigSlot7', 'ShipHangar', 'SpecializedFuelBay', 'SpecializedOreHold', 'SpecializedGasHold', 'SpecializedMineralHold', 'SpecializedSalvageHold', 'SpecializedShipHold', 'SpecializedSmallShipHold', 'SpecializedMediumShipHold', 'SpecializedLargeShipHold', 'SpecializedIndustrialShipHold', 'SpecializedAmmoHold', 'SpecializedCommandCenterHold', 'SpecializedPlanetaryCommoditiesHold', 'SpecializedMaterialBay', 'SubSystemSlot0', 'SubSystemSlot1', 'SubSystemSlot2', 'SubSystemSlot3', 'SubSystemSlot4', 'SubSystemSlot5', 'SubSystemSlot6', 'SubSystemSlot7', 'FighterBay', 'FighterTube0', 'FighterTube1', 'FighterTube2', 'FighterTube3', 'FighterTube4', 'Module'];

function request(value: unknown): value is CharacterWorkspaceRequest {
  return record(value) && integer(value.characterId, 1) && typeof value.view === 'string' && views.includes(value.view) &&
    keys(value, ['characterId', 'view', ...(value.view === 'faction_warfare' ? [] : ['offset']), ...(['blueprints', 'mining'].includes(value.view) ? ['page'] : []), ...(industryViews.includes(value.view) ? ['resolveNames'] : [])]) &&
    (value.offset === undefined || integer(value.offset, 0, 9900) && value.offset % 100 === 0) &&
    (value.page === undefined || integer(value.page, 1, 500)) && (value.resolveNames === undefined || typeof value.resolveNames === 'boolean');
}
const namesChoice = (value: CharacterWorkspaceRequest) => 'resolveNames' in value ? value.resolveNames : undefined;
function publicCategory(view: CharacterWorkspace['view'], column: string): 'inventory_type' | 'solar_system' | null {
  if ((view === 'blueprints' || view === 'mining') && column === 'type' || view === 'research' && column === 'skill') return 'inventory_type';
  if ((view === 'planets' || view === 'mining') && column === 'system') return 'solar_system';
  return null;
}
function validLabels(value: Record<string, unknown>, args: CharacterWorkspaceRequest): boolean {
  const rows = value.rows as CharacterWorkspace['rows'];
  const requested = namesChoice(args) === true && ['ready', 'partial'].includes(value.status as string) && rows.length > 0;
  if (!requested) return !Object.hasOwn(value, 'labels');
  const labels = value.labels;
  if (!record(labels) || !keys(labels, ['status', 'message', 'retrievedAt', 'cacheExpires', 'names']) || !text(labels.message) ||
      !nullableDate(labels.retrievedAt) || !nullableDate(labels.cacheExpires) || !Array.isArray(labels.names) || labels.names.length > 200) return false;
  if (labels.status === 'unavailable') return labels.retrievedAt === null && labels.cacheExpires === null && labels.names.length === 0;
  if (!['ready', 'partial'].includes(labels.status as string) || !date(labels.retrievedAt)) return false;
  const expected = new Map<number, Set<string>>();
  for (const row of rows) for (const [key, id] of Object.entries(row.cells)) {
    const category = publicCategory(args.view, key);
    if (category && integer(id, 1)) { const categories = expected.get(id) ?? new Set<string>(); categories.add(category); expected.set(id, categories); }
  }
  if ([...expected.values()].some(categories => categories.size !== 1)) return false;
  const seen = new Set<number>();
  for (const entry of labels.names) {
    if (!record(entry) || !keys(entry, ['id', 'category', 'name']) || !integer(entry.id, 1) || seen.has(entry.id) ||
        typeof entry.category !== 'string' || !expected.get(entry.id)?.has(entry.category) || typeof entry.name !== 'string' ||
        !entry.name.trim() || entry.name !== entry.name.trim() || entry.name.length > 512 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(entry.name)) return false;
    seen.add(entry.id);
  }
  const stale = date(labels.cacheExpires) && Date.parse(labels.cacheExpires) <= Date.parse(value.generatedAt as string);
  const complete = seen.size === expected.size && !stale;
  return labels.status === (complete ? 'ready' : 'partial');
}

export function characterPublicName(workspace: CharacterWorkspace, column: string, value: string | number): string | undefined {
  const category = publicCategory(workspace.view, column);
  return category && typeof value === 'number' ? workspace.labels?.names.find(entry => entry.id === value && entry.category === category)?.name : undefined;
}
const columnSpecs: Record<string, { key: string; label: string; unit?: string }[]> = {
  standings: [{ key: 'kind', label: 'Source kind' }, { key: 'sourceId', label: 'Source ID' }, { key: 'standing', label: 'Reported standing', unit: 'standing' }],
  loyalty_points: [{ key: 'corporationId', label: 'NPC corporation ID' }, { key: 'points', label: 'Loyalty points', unit: 'LP' }],
  faction_warfare: [{ key: 'period', label: 'Period' }, { key: 'kills', label: 'Kills', unit: 'count' }, { key: 'victoryPoints', label: 'Victory points', unit: 'count' }],
  blueprints: [{ key: 'item', label: 'Blueprint item ID' }, { key: 'type', label: 'Blueprint type ID' }, { key: 'kind', label: 'Blueprint kind' }, { key: 'units', label: 'Blueprint units', unit: 'count' }, { key: 'materialEfficiency', label: 'Material efficiency', unit: 'count' }, { key: 'timeEfficiency', label: 'Time efficiency', unit: 'count' }, { key: 'runs', label: 'Copy runs remaining / original' }, { key: 'location', label: 'Location ID' }, { key: 'flag', label: 'Location flag' }],
  research: [{ key: 'agent', label: 'Agent ID' }, { key: 'skill', label: 'Research skill type ID' }, { key: 'started', label: 'Research started (UTC)', unit: 'datetime' }, { key: 'daily', label: 'Reported rate', unit: 'RP/day' }, { key: 'remainder', label: 'Reported remainder', unit: 'RP' }],
  planets: [{ key: 'planet', label: 'Planet ID' }, { key: 'system', label: 'Solar system ID' }, { key: 'type', label: 'Planet type' }, { key: 'upgrade', label: 'Command center upgrade', unit: 'count' }, { key: 'pins', label: 'Reported pins', unit: 'count' }, { key: 'updated', label: 'Colony updated (UTC)', unit: 'datetime' }],
  mining: [{ key: 'date', label: 'Date (UTC)' }, { key: 'type', label: 'Type ID' }, { key: 'system', label: 'Solar system ID' }, { key: 'quantity', label: 'Quantity', unit: 'count' }],
};
const metricLabels: Record<string, string[]> = {
  standings: ['Standings returned', 'Positive standings', 'Negative standings', 'Zero standings'],
  loyalty_points: ['NPC corporations returned', 'Corporations with LP'],
  faction_warfare: ['Enrollment', 'Faction ID', 'Enlisted (UTC)', 'Current rank', 'Highest rank'],
  blueprints: ['Blueprint rows in this page', 'Original rows', 'Copy rows', 'Original stack rows'],
  research: ['Research agents returned'],
  planets: ['Colonies returned'],
  mining: ['Mining records in this page', 'Types in this page', 'Solar systems in this page'],
};

export function characterWorkspaceResponse(value: unknown, args: CharacterWorkspaceRequest): CharacterWorkspace {
  const invalid = (): never => { throw new ConnectionResponseError(`The ${workspaceName(args)} service returned an incomplete response. Please try again.`); };
  if (!request(args) || !record(value) || !keys(value, ['view', 'characterId', 'generatedAt', 'status', 'coverage', 'message', 'scope', 'retrievedAt', 'cacheExpires', 'metrics', 'columns', 'rows', 'next', 'labels']) ||
      value.characterId !== args.characterId || value.view !== args.view || !date(value.generatedAt) || !text(value.message) || value.scope !== scopes[args.view] ||
      typeof value.status !== 'string' || !['ready', 'partial', 'needs_permission', 'unavailable', 'error'].includes(value.status) ||
      typeof value.coverage !== 'string' || !['complete', 'partial', 'unknown', 'unavailable'].includes(value.coverage) ||
      !nullableDate(value.retrievedAt) || !nullableDate(value.cacheExpires) || !Array.isArray(value.metrics) || !Array.isArray(value.columns) ||
      !Array.isArray(value.rows) || value.rows.length > 100) return invalid();
  const available = value.status === 'ready' || value.status === 'partial';
  if (!available) {
    if (value.coverage !== 'unavailable' || value.metrics.length || value.columns.length || value.rows.length || value.next !== null || !validLabels(value, args)) return invalid();
    return value as CharacterWorkspace;
  }
  const stale = date(value.cacheExpires) && Date.parse(value.cacheExpires) <= Date.parse(value.generatedAt);
  if (!date(value.retrievedAt) || value.coverage === 'unavailable' || value.status === 'ready' && (value.coverage !== 'complete' || stale) ||
      value.status === 'partial' && value.coverage === 'complete' && !stale) return invalid();
  const specs = columnSpecs[args.view];
  if (value.columns.length !== specs.length || value.columns.some((column, index) => !record(column) || !keys(column, ['key', 'label', 'unit']) ||
      column.key !== specs[index].key || column.label !== specs[index].label || column.unit !== specs[index].unit)) return invalid();
  const labels = metricLabels[args.view];
  // A fresh unpaginated response may shrink while the user is on a later slice.
  // The service reports an obsolete slice without fabricating summary zeros.
  if (args.view !== 'faction_warfare' && (args.offset ?? 0) > 0 && value.status === 'partial' && value.coverage === 'unknown' &&
      value.metrics.length === 0 && value.rows.length === 0 && value.next === null) { if (!validLabels(value, args)) return invalid(); return value as CharacterWorkspace; }
  if (value.metrics.length !== labels.length) return invalid();
  for (let index = 0; index < labels.length; index++) {
    const metric = value.metrics[index];
    if (!record(metric) || !keys(metric, ['label', 'value', 'unit']) || metric.label !== labels[index]) return invalid();
    if (args.view !== 'faction_warfare') {
      if (metric.unit !== 'count' || !integer(metric.value, 0, 10000)) return invalid();
    } else if (index === 0) {
      if (metric.unit !== undefined || typeof metric.value !== 'string' || !['Reported', 'Not reported', 'Incomplete fields'].includes(metric.value)) return invalid();
    } else if (metric.value === 'Not reported') {
      if (metric.unit !== undefined) return invalid();
    } else if (index === 1 ? !integer(metric.value, 1) || metric.unit !== undefined : index === 2 ? !date(metric.value) || metric.unit !== 'datetime' : !integer(metric.value) || metric.unit !== 'count') return invalid();
  }
  const seen = new Set<string>();
  const kindKeys: Record<string, string> = { Agent: 'agent', 'NPC corporation': 'npc_corp', Faction: 'faction' };
  const periods: Record<string, string> = { yesterday: 'Yesterday', last_week: 'Last week', total: 'Reported total' };
  for (const row of value.rows) {
    if (!record(row) || !keys(row, ['id', 'cells']) || typeof row.id !== 'string' || !row.id || row.id.length > 128 || seen.has(row.id) || !record(row.cells) ||
        Object.keys(row.cells).length !== specs.length || !keys(row.cells, specs.map(column => column.key))) return invalid();
    seen.add(row.id);
    if (args.view === 'standings') {
      if (typeof row.cells.kind !== 'string' || !Object.hasOwn(kindKeys, row.cells.kind) || !integer(row.cells.sourceId, 1) || !standing(row.cells.standing) || row.id !== `${kindKeys[row.cells.kind]}-${row.cells.sourceId}`) return invalid();
    } else if (args.view === 'loyalty_points') {
      if (!integer(row.cells.corporationId, 1) || row.id !== String(row.cells.corporationId) || !integer(row.cells.points)) return invalid();
    } else if (args.view === 'faction_warfare') {
      if (!Object.hasOwn(periods, row.id) || row.cells.period !== periods[row.id] || !integer(row.cells.kills) || !integer(row.cells.victoryPoints)) return invalid();
    } else if (args.view === 'blueprints') {
      if (!integer(row.cells.item, 1) || row.id !== String(row.cells.item) || !integer(row.cells.type, 1) || !integer(row.cells.location, 1) ||
          !['Original', 'Copy', 'Original stack'].includes(row.cells.kind as string) || !integer(row.cells.units, 1) ||
          !integer(row.cells.materialEfficiency) || !integer(row.cells.timeEfficiency) || typeof row.cells.flag !== 'string' || !blueprintLocationFlags.includes(row.cells.flag) ||
          (row.cells.kind === 'Copy' ? !integer(row.cells.runs) || row.cells.units !== 1 : row.cells.runs !== 'Unlimited (original)' || row.cells.kind === 'Original' && row.cells.units !== 1)) return invalid();
    } else if (args.view === 'research') {
      if (!integer(row.cells.agent, 1) || row.id !== String(row.cells.agent) || !integer(row.cells.skill, 1) || !date(row.cells.started) || !researchPoints(row.cells.daily) || !researchPoints(row.cells.remainder, true)) return invalid();
    } else if (args.view === 'mining') {
      if (!ledgerDate(row.cells.date) || !integer(row.cells.type, 1) || !integer(row.cells.system, 1) || !integer(row.cells.quantity) || row.id !== `${row.cells.date}-${row.cells.type}-${row.cells.system}`) return invalid();
    } else if (!integer(row.cells.planet, 1) || row.id !== String(row.cells.planet) || !integer(row.cells.system, 1) || typeof row.cells.type !== 'string' ||
        !['temperate', 'barren', 'oceanic', 'ice', 'gas', 'lava', 'storm', 'plasma'].includes(row.cells.type) || !integer(row.cells.upgrade) || !integer(row.cells.pins) || !date(row.cells.updated)) return invalid();
  }
  if (args.view === 'faction_warfare') {
    if (value.rows.length !== 3 || value.next !== null) return invalid();
    const enrollment = value.metrics[0].value, faction = value.metrics[1].value, enlisted = value.metrics[2].value;
    const reported = Number(faction !== 'Not reported') + Number(enlisted !== 'Not reported');
    if (enrollment !== (reported === 2 ? 'Reported' : reported === 0 ? 'Not reported' : 'Incomplete fields') || reported === 1 && value.coverage !== 'unknown') return invalid();
  } else if (args.view === 'blueprints' || args.view === 'mining') {
    const total = value.metrics[0].value as number, offset = args.offset ?? 0, page = args.page ?? 1;
    if (args.view === 'blueprints' && value.metrics.slice(1).reduce((sum, metric) => sum + metric.value, 0) !== total || offset > 0 && offset >= total || value.rows.length !== Math.min(100, total - offset)) return invalid();
    if (args.view === 'mining') {
      const types = new Set(value.rows.map(row => row.cells.type)).size, systems = new Set(value.rows.map(row => row.cells.system)).size;
      if (value.metrics.slice(1).some(metric => metric.value > total) || value.metrics[1].value < types || value.metrics[2].value < systems ||
          total === value.rows.length && (value.metrics[1].value !== types || value.metrics[2].value !== systems)) return invalid();
    }
    const moreInPage = offset + value.rows.length < total;
    if (value.coverage === 'complete' && (page !== 1 || offset !== 0 || moreInPage || value.next !== null)) return invalid();
    if (moreInPage && value.next === null) return invalid();
    if (value.next !== null) {
      if (!request(value.next) || value.next.characterId !== args.characterId || value.next.view !== args.view || namesChoice(value.next) !== namesChoice(args) || value.coverage === 'complete') return invalid();
      if (moreInPage ? value.next.page !== page || value.next.offset !== offset + 100 : value.next.page !== page + 1 || value.next.offset !== 0) return invalid();
    }
  } else {
    const total = value.metrics[0].value as number, offset = args.offset ?? 0;
    if (value.rows.length > total || value.metrics.slice(1).some(metric => metric.value > total)) return invalid();
    if (args.view === 'standings' && value.metrics.slice(1).reduce((sum, metric) => sum + metric.value, 0) !== total) return invalid();
    if (offset > 0 && offset >= total || value.rows.length !== Math.min(100, total - offset)) return invalid();
    const more = offset + value.rows.length < total;
    if ((value.next !== null) !== more || value.coverage !== (offset === 0 && !more ? 'complete' : 'partial')) return invalid();
    if (value.next !== null && (!request(value.next) || value.next.characterId !== args.characterId || value.next.view !== args.view ||
        namesChoice(value.next) !== namesChoice(args) || value.next.offset !== offset + 100 || value.rows.length !== 100 || value.coverage !== 'partial')) return invalid();
  }
  if (!validLabels(value, args)) return invalid();
  return value as CharacterWorkspace;
}

export function formatCharacterValue(value: string | number, item: CharacterWorkspace['columns'][number] | CharacterWorkspace['metrics'][number]): string {
  if (item.unit === 'datetime' && date(value)) return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
  if (typeof value === 'number' && item.unit === 'standing') return (value > 0 ? '+' : '') + String(value);
  if (typeof value === 'number' && (item.unit === 'count' || item.unit === 'LP')) return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value) + (item.unit === 'LP' ? ' LP' : '');
  if (typeof value === 'number' && (item.unit === 'RP' || item.unit === 'RP/day')) return `${String(value)} ${item.unit}`;
  return String(value);
}

export async function characterWorkspaceRequest(args: CharacterWorkspaceRequest, signal: AbortSignal): Promise<CharacterWorkspace> {
  const workspace = workspaceName(args);
  if (!request(args)) throw new ConnectionResponseError(`Choose a connected character and a supported ${workspace} view.`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, 75000);
  try {
    controller.signal.throwIfAborted();
    const response = await fetch('/api/eve/character-workspace', {
      method: 'POST', cache: 'no-store', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args),
    });
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      throw new ConnectionResponseError(`Sign in to this private connector to load ${workspace} data.`, 401);
    }
    let value: unknown;
    try { value = await response.json(); } catch { throw new ConnectionResponseError(`The ${workspace} service returned an unreadable response. Please try again.`); }
    if (!response.ok) throw new ConnectionResponseError(`${workspace === 'industry' ? 'Industry' : 'Reputation'} data could not be loaded. Please try again or review your connection.`, response.status);
    return characterWorkspaceResponse(value, args);
  } catch (error) {
    if (controller.signal.aborted) throw new ConnectionResponseError(signal.aborted ? `${workspace === 'industry' ? 'Industry' : 'Reputation'} request cancelled.` : `The ${workspace} service took too long to respond. Please try again.`);
    if (error instanceof ConnectionResponseError) throw error;
    throw new ConnectionResponseError(`Could not reach the ${workspace} service. Please try again.`);
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
