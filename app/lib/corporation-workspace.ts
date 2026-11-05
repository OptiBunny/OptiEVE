import { EveError, listConnections, readCorporationData, readPublicNames } from './eve';
import { overviewDate, OverviewDataError, extractionRows, freelanceRows } from './overview-summary';
import type { CorporationWorkspace, CorporationWorkspaceColumn, CorporationWorkspaceRequest, CorporationWorkspaceRow } from './corporation-workspace-types';

const scopes = {
  wallets: 'esi-wallet.read_corporation_wallets.v1',
  contracts: 'esi-contracts.read_corporation_contracts.v1',
  contract_items: 'esi-contracts.read_corporation_contracts.v1',
  contract_bids: 'esi-contracts.read_corporation_contracts.v1',
  projects: 'esi-corporations.read_projects.v1',
  project: 'esi-corporations.read_projects.v1',
  order_history: 'esi-markets.read_corporation_orders.v1',
  blueprints: 'esi-corporations.read_blueprints.v1',
  facilities: 'esi-corporations.read_facilities.v1',
  structures: 'esi-corporations.read_structures.v1',
  extractions: 'esi-industry.read_corporation_mining.v1',
  freelance_jobs: 'esi-corporations.read_freelance_jobs.v1',
  assets: 'esi-assets.read_corporation_assets.v1',
  asset_detail: 'esi-assets.read_corporation_assets.v1',
} as const;
const pagedViews = ['contracts', 'contract_bids', 'order_history', 'blueprints', 'structures', 'assets', 'extractions'];
type PagedRequest = Extract<CorporationWorkspaceRequest, { view: 'contracts' | 'contract_bids' | 'order_history' | 'blueprints' | 'structures' | 'assets' | 'extractions' }>;
type SlicedRequest = PagedRequest | Extract<CorporationWorkspaceRequest, { view: 'contract_items' | 'facilities' }>;
const statuses = ['outstanding', 'in_progress', 'finished_issuer', 'finished_contractor', 'finished', 'cancelled', 'rejected', 'failed', 'deleted', 'reversed'];
const projectStates = ['Unspecified', 'Active', 'Closed', 'Completed', 'Expired', 'Deleted'];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const uuid = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const cursor = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x20\x7f]/.test(value);
const invalid = (): never => { throw new OverviewDataError(); };
const amount = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER / 100 ? Math.round(value * 100) / 100 : invalid();
const count = (value: unknown): number => integer(value) ? value : invalid();
const date = (value: unknown): string => overviewDate(value) ?? invalid();
function text(value: unknown, maximum = 256): string {
  if (typeof value !== 'string' || value.length > 16384) return invalid();
  // User-authored titles are plain text. No HTML, links, markdown or instructions
  // are interpreted by this service or its table renderer.
  return value.normalize('NFC').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, maximum);
}
function rows(value: unknown, key: string, maximum = 10000): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  const seen = new Set<string>();
  return value.map(row => {
    if (!record(row)) return invalid();
    const id = row[key];
    if (key === 'id' ? !uuid(id) : !integer(id, 1)) return invalid();
    const identity = String(id).toLowerCase();
    if (seen.has(identity)) return invalid();
    seen.add(identity);
    return row;
  });
}
function args(value: unknown): CorporationWorkspaceRequest {
  const error = () => { throw new EveError('Choose one connected character and a supported corporation workspace view.'); };
  if (!record(value) || !Object.hasOwn(value, 'characterId') || !integer(value.characterId, 1) || !Object.hasOwn(value, 'view') || typeof value.view !== 'string' || !Object.hasOwn(scopes, value.view)) return error();
  const extra = value.view === 'contract_bids' ? ['contractId', 'page', 'offset'] : pagedViews.includes(value.view) ? ['page', 'offset'] : value.view === 'asset_detail' ? ['itemId', 'page'] : value.view === 'facilities' ? ['offset'] : value.view === 'projects' || value.view === 'freelance_jobs' ? ['after'] : value.view === 'contract_items' ? ['contractId', 'offset'] : value.view === 'project' ? ['projectId'] : [];
  if (Object.keys(value).some(key => !['characterId', 'view', 'includeNames', ...extra].includes(key))) return error();
  if (value.includeNames !== undefined && typeof value.includeNames !== 'boolean') return error();
  if (value.page !== undefined && (!integer(value.page, 1) || value.page > 500)) return error();
  if (value.offset !== undefined && (!integer(value.offset) || value.offset > 9900 || value.offset % 100 !== 0)) return error();
  if (value.after !== undefined && !cursor(value.after)) return error();
  if ((value.view === 'contract_items' || value.view === 'contract_bids') && (!Object.hasOwn(value, 'contractId') || !integer(value.contractId, 1))) return error();
  if (value.view === 'project' && (!Object.hasOwn(value, 'projectId') || !uuid(value.projectId))) return error();
  if (value.view === 'asset_detail' && (!Object.hasOwn(value, 'itemId') || !integer(value.itemId, 1) || !Object.hasOwn(value, 'page') || !integer(value.page, 1))) return error();
  // Reconstruct instead of retaining caller-owned prototypes or extra fields.
  const selected = { characterId: value.characterId, view: value.view, ...(value.includeNames === undefined ? {} : { includeNames: value.includeNames as boolean }) };
  if (value.view === 'wallets') return { ...selected, view: 'wallets' };
  if (value.view === 'contracts' || value.view === 'order_history' || value.view === 'blueprints' || value.view === 'structures' || value.view === 'assets' || value.view === 'extractions') return { ...selected, view: value.view, page: (value.page as number | undefined) ?? 1, offset: (value.offset as number | undefined) ?? 0 };
  if (value.view === 'asset_detail') return { ...selected, view: 'asset_detail', itemId: value.itemId as number, page: value.page as number };
  if (value.view === 'facilities') return { ...selected, view: 'facilities', offset: (value.offset as number | undefined) ?? 0 };
  if (value.view === 'contract_items') return { ...selected, view: 'contract_items', contractId: value.contractId as number, offset: (value.offset as number | undefined) ?? 0 };
  if (value.view === 'contract_bids') return { ...selected, view: 'contract_bids', contractId: value.contractId as number, page: (value.page as number | undefined) ?? 1, offset: (value.offset as number | undefined) ?? 0 };
  if (value.view === 'projects' || value.view === 'freelance_jobs') return { ...selected, view: value.view, ...(value.after === undefined ? {} : { after: value.after as string }) };
  return { ...selected, view: 'project', projectId: (value.projectId as string).toLowerCase() };
}
type ReadArgs = { characterId: number; dataset: string; parameters?: Record<string, unknown> };
type Dependencies = {
  connections: (user: string) => Promise<{ characterId: number; scopes: string[] }[]>;
  corporation: (user: string, input: ReadArgs, signal?: AbortSignal) => Promise<unknown>;
  publicNames?: (ids: number[], signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
};
type Table = { columns: CorporationWorkspaceColumn[]; rows: CorporationWorkspaceRow[]; details?: CorporationWorkspace['details']; message: string; coverage: CorporationWorkspace['coverage']; next: CorporationWorkspaceRequest | null };
function headerDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function blank(selected: CorporationWorkspaceRequest, now: number, status: CorporationWorkspace['status'], message: string): CorporationWorkspace {
  return { view: selected.view, characterId: selected.characterId, generatedAt: new Date(now).toISOString(), status, message, scope: scopes[selected.view], coverage: 'unavailable', retrievedAt: null, cacheExpires: null, sources: [], columns: [], rows: [], next: null };
}
function definition(selected: CorporationWorkspaceRequest): ReadArgs {
  const base = { characterId: selected.characterId };
  if (selected.view === 'wallets') return { ...base, dataset: 'wallet_balances' };
  if (selected.view === 'contracts' || selected.view === 'order_history' || selected.view === 'blueprints' || selected.view === 'structures' || selected.view === 'assets') return { ...base, dataset: selected.view, parameters: { page: selected.page ?? 1 } };
  if (selected.view === 'asset_detail') return { ...base, dataset: 'assets', parameters: { page: selected.page } };
  if (selected.view === 'facilities') return { ...base, dataset: 'facilities' };
  if (selected.view === 'projects') return { ...base, dataset: 'projects', parameters: { limit: 100, state: 'Active', ...(selected.after === undefined ? {} : { after: selected.after }) } };
  if (selected.view === 'extractions') return { ...base, dataset: 'mining_extractions', parameters: { page: selected.page ?? 1 } };
  if (selected.view === 'freelance_jobs') return { ...base, dataset: 'freelance_jobs', parameters: { limit: 100, ...(selected.after === undefined ? {} : { after: selected.after }) } };
  if (selected.view === 'contract_items') return { ...base, dataset: 'contract_items', parameters: { contractId: selected.contractId } };
  if (selected.view === 'contract_bids') return { ...base, dataset: 'contract_bids', parameters: { contractId: selected.contractId, page: selected.page ?? 1 } };
  return { ...base, dataset: 'project', parameters: { projectId: selected.projectId } };
}
function pageTable(selected: SlicedRequest, all: CorporationWorkspaceRow[], pagination: unknown): Pick<Table, 'rows' | 'coverage' | 'next' | 'message'> {
  const offset = selected.offset ?? 0;
  const label = selected.view === 'contract_items' ? 'items for this contract' : selected.view === 'contract_bids' ? 'bids for this contract' : selected.view === 'order_history' ? 'historical orders' : selected.view;
  if (offset && offset >= all.length) return { rows: [], coverage: 'unknown', next: null, message: 'This slice is no longer available. The provider feed may have changed; reload its first batch.' };
  const portion = all.slice(offset, offset + 100);
  if (selected.view === 'contract_items' || selected.view === 'facilities') {
    if (!record(pagination) || pagination.kind !== 'none') return invalid();
    const next = offset + 100 < all.length ? { ...selected, offset: offset + 100 } : null;
    return { rows: portion, next, coverage: !offset && !next ? 'complete' : 'partial', message: `Showing ${portion.length} of ${all.length} ${label} returned. ${offset || next ? 'Additional slices are separate reads of a potentially changing response.' : 'This is the available provider response.'}` };
  }
  const page = selected.page ?? 1;
  if (!record(pagination) || pagination.kind !== 'page' || pagination.page !== page) return invalid();
  const pages = pagination.pages === null || pagination.pages === undefined ? null : integer(pagination.pages, page) ? pagination.pages : invalid();
  const nextPage = pagination.nextPage === null || pagination.nextPage === undefined ? null : integer(pagination.nextPage, 1) && pagination.nextPage === page + 1 && pagination.nextPage <= 500 && (pages === null || pagination.nextPage <= pages) ? pagination.nextPage : invalid();
  const next: CorporationWorkspaceRequest | null = offset + 100 < all.length ? { ...selected, offset: offset + 100 } : nextPage ? { ...selected, page: nextPage, offset: 0 } : null;
  const complete = page === 1 && pages === 1 && !offset && !next;
  return { rows: portion, next, coverage: complete ? 'complete' : pages === null && !offset && all.length <= 100 ? 'unknown' : 'partial', message: `Showing ${portion.length} of ${all.length} ${label} returned on page ${page}${pages === null ? '; the full page count is unknown' : ` of ${pages}`}. ${complete ? 'The provider’s available window is not lifetime history.' : 'This batch is not a corporation-wide total; changing pages can overlap or omit records.'}${page === 500 && pages !== null && pages > 500 ? ' The 500-page safety limit has been reached.' : ''}` };
}
function projectFields(row: Record<string, unknown>) {
  if (!uuid(row.id) || typeof row.state !== 'string' || !projectStates.includes(row.state) || !record(row.progress)) return invalid();
  return { name: text(row.name), state: row.state, current: count(row.progress.current), desired: count(row.progress.desired), lastModified: date(row.last_modified) };
}
// A project configuration can contain player identities, private structures and
// arbitrary JSON. Display only known objective fields; never serialize it.
const objectiveKinds: Record<string, { label: string; fields: string[] }> = {
  capture_fw_complex: { label: 'Capture factional warfare complexes', fields: ['archetypes', 'factions', 'locations'] },
  damage_ship: { label: 'Damage ships', fields: ['ships', 'identities', 'locations'] },
  defend_fw_complex: { label: 'Defend factional warfare complexes', fields: ['archetypes', 'factions', 'locations'] },
  deliver_item: { label: 'Deliver items', fields: ['items', 'docking_locations', 'office_id'] },
  destroy_npc: { label: 'Destroy NPCs', fields: ['locations'] },
  destroy_ship: { label: 'Destroy ships', fields: ['ships', 'identities', 'locations'] },
  earn_loyalty_point: { label: 'Earn loyalty points', fields: ['corporations'] },
  lost_ship: { label: 'Lose ships', fields: ['ships', 'identities', 'locations'] },
  manual: { label: 'Manual contribution', fields: [] },
  manufacture_item: { label: 'Manufacture items', fields: ['items', 'owner', 'docking_locations'] },
  mine_material: { label: 'Mine materials', fields: ['materials', 'locations'] },
  remote_boost_shield: { label: 'Remote shield boosting', fields: ['ships', 'identities', 'locations'] },
  remote_repair_armor: { label: 'Remote armor repair', fields: ['ships', 'identities', 'locations'] },
  salvage_wreck: { label: 'Salvage wrecks', fields: ['locations'] },
  scan_signature: { label: 'Scan signatures', fields: ['signatures', 'locations'] },
  ship_insurance: { label: 'Ship insurance', fields: ['ships', 'conflict_type', 'reimburse_implants', 'identities', 'locations'] },
};
function projectObjective(data: Record<string, unknown>): { details: NonNullable<CorporationWorkspace['details']>; incomplete: boolean } {
  const unavailable = (value: string) => ({ details: [{ label: 'Objective', value }], incomplete: true });
  if (data.configuration === undefined) return unavailable('Not reported by EVE. Review this project in EVE.');
  if (!record(data.configuration) || Object.keys(data.configuration).length !== 1) return unavailable('Objective details are unavailable because the configuration is incomplete or unsupported.');
  const kind = Object.keys(data.configuration)[0];
  if (!Object.hasOwn(objectiveKinds, kind)) return unavailable('This objective type is not supported in this view. Review this project in EVE.');
  const configuration = data.configuration[kind];
  if (!record(configuration)) return unavailable('Objective details are unavailable because the configuration is malformed.');
  try {
    const definition = objectiveKinds[kind];
    let incomplete = Object.keys(configuration).some(key => !definition.fields.includes(key));
    const details: NonNullable<CorporationWorkspace['details']> = [{ label: 'Objective', value: definition.label }];
    const filters: Record<string, { label: string; keys: Record<string, string> }> = {
      items: { label: 'Item filters', keys: { type_id: 'Type ID', group_id: 'Inventory group ID' } },
      materials: { label: 'Material filters', keys: { type_id: 'Type ID', group_id: 'Inventory group ID' } },
      ships: { label: 'Ship filters', keys: { type_id: 'Type ID', group_id: 'Ship tree group ID' } },
      archetypes: { label: 'Complex archetype filters', keys: { archetype_id: 'Archetype ID' } },
      factions: { label: 'Faction filters', keys: { faction_id: 'Faction ID' } },
      signatures: { label: 'Signature filters', keys: { signature_type_id: 'Signature type ID' } },
    };
    for (const key of definition.fields) {
      if (configuration[key] === undefined) continue;
      if (!Object.hasOwn(filters, key)) continue;
      const values = configuration[key], filter = filters[key];
      if (!Array.isArray(values) || values.length > 100) return invalid();
      const labels = values.map(value => {
        if (!record(value) || Object.keys(value).length !== 1) return invalid();
        const field = Object.keys(value)[0];
        if (!Object.hasOwn(filter.keys, field) || !integer(value[field], 1)) return invalid();
        return `${filter.keys[field]} ${value[field]}`;
      });
      if (new Set(labels).size !== labels.length) return invalid();
      details.push({ label: filter.label, value: labels.length ? labels.slice(0, 10).join('; ') + (labels.length > 10 ? `; ${labels.length - 10} more not displayed` : '') : 'No values reported; no unrestricted eligibility is inferred.' });
      if (labels.length > 10) incomplete = true;
    }
    // Location/identity predicates are intentionally not emitted or resolved.
    if (['identities', 'corporations', 'locations', 'docking_locations', 'office_id'].some(key => Object.hasOwn(configuration, key))) incomplete = true;
    if (kind === 'manufacture_item') {
      if (typeof configuration.owner !== 'string' || !['Any', 'Corporation', 'Character'].includes(configuration.owner)) return invalid();
      details.push({ label: 'Manufacturing job owner', value: configuration.owner });
    }
    if (kind === 'ship_insurance') {
      if (typeof configuration.conflict_type !== 'string' || !['Any', 'Pvp', 'Pve'].includes(configuration.conflict_type) || typeof configuration.reimburse_implants !== 'boolean') return invalid();
      details.push({ label: 'Conflict type', value: configuration.conflict_type === 'Pvp' ? 'PvP' : configuration.conflict_type === 'Pve' ? 'PvE' : 'Any' });
      details.push({ label: 'Implant reimbursement configured', value: configuration.reimburse_implants ? 'Yes' : 'No' });
    }
    const metadata = data.details === undefined ? {} : record(data.details) ? data.details : invalid();
    if (metadata.career !== undefined && (typeof metadata.career !== 'string' || !['Unspecified', 'Explorer', 'Industrialist', 'Enforcer', 'Soldier of Fortune'].includes(metadata.career))) return invalid();
    details.push({ label: 'Career', value: metadata.career as string | undefined ?? 'Not reported' });
    for (const [key, label] of [['created', 'Created (UTC)'], ['expires', 'Deadline (UTC)'], ['finished', 'Finished (UTC)']]) {
      details.push({ label, value: metadata[key] === undefined ? 'Not reported' : date(metadata[key]).replace('T', ' ').replace('Z', ' UTC') });
    }
    if (metadata.career === undefined || metadata.created === undefined) incomplete = true;
    const contribution = data.contribution === undefined ? {} : record(data.contribution) ? data.contribution : invalid();
    for (const [key, label] of [['participation_limit', 'Contribution limit per participant'], ['submission_limit', 'Contribution limit per submission']]) {
      details.push({ label, value: contribution[key] === undefined ? 'Not reported' : count(contribution[key]) });
    }
    const multiplier = contribution.submission_multiplier;
    if (multiplier !== undefined && (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier < 0 || multiplier > Number.MAX_SAFE_INTEGER)) return invalid();
    details.push({ label: 'Progress multiplier per contribution', value: multiplier as number | undefined ?? 'Not reported' });
    const isk = (value: unknown): string => {
      if (typeof value !== 'number' || value < 0) return invalid();
      return `${amount(value)} ISK`;
    };
    details.push({ label: 'Reward per contribution', value: contribution.reward_per_contribution === undefined ? 'Not reported' : isk(contribution.reward_per_contribution) });
    const reward = data.reward === undefined ? undefined : record(data.reward) ? data.reward : invalid();
    details.push({ label: 'Initial reward reserve', value: reward === undefined ? 'Not reported' : isk(reward.initial) });
    details.push({ label: 'Remaining reward reserve', value: reward === undefined ? 'Not reported' : isk(reward.remaining) });
    return { details, incomplete };
  } catch {
    return unavailable('Objective details are unavailable because reported fields are malformed or exceed this view’s limits. Verified progress is shown separately.');
  }
}
function assetRows(data: unknown): Record<string, unknown>[] {
  return rows(data, 'item_id').map(row => {
    if (!integer(row.type_id, 1) || !integer(row.quantity) || !integer(row.location_id, 1) ||
        typeof row.location_type !== 'string' || !['station', 'solar_system', 'item', 'other'].includes(row.location_type) ||
        typeof row.is_singleton !== 'boolean' || (row.is_blueprint_copy !== undefined && typeof row.is_blueprint_copy !== 'boolean') || !text(row.location_flag, 80)) return invalid();
    return row;
  });
}
function assetCells(row: Record<string, unknown>): Record<string, string | number> {
  return { item: row.item_id as number, type: row.type_id as number, quantity: row.quantity as number, location: row.location_id as number,
    locationType: (row.location_type as string).replaceAll('_', ' '), flag: text(row.location_flag, 80), singleton: row.is_singleton ? 'Yes' : 'No' };
}
function assetLookup(data: unknown, itemId: number, kind: 'name' | 'location'): Record<string, unknown> | undefined {
  const matches = rows(data, 'item_id', 1);
  const row = matches[0];
  if (!row) return undefined;
  if (row.item_id !== itemId) return invalid();
  if (kind === 'name') text(row.name);
  else {
    const position = row.position;
    if (!record(position) || !['x', 'y', 'z'].every(key => typeof position[key] === 'number' && Number.isFinite(position[key]))) return invalid();
  }
  return row;
}
type AssetDetail = { names: unknown; locations: unknown };
function table(selected: CorporationWorkspaceRequest, data: unknown, pagination: unknown, now: number, contribution?: unknown, expectedCorporationId?: number, detail?: AssetDetail): Table {
  const nameSelection = selected.includeNames === undefined ? {} : { includeNames: selected.includeNames };
  if (selected.view === 'wallets') {
    if (!record(pagination) || pagination.kind !== 'none') return invalid();
    const divisions = rows(data, 'division', 7).sort((a, b) => Number(a.division) - Number(b.division));
    const walletRows = divisions.map(row => {
      if (!integer(row.division, 1) || row.division > 7) return invalid();
      return { id: String(row.division), cells: { division: `Division ${row.division}`, balance: amount(row.balance) } };
    });
    return { columns: [{ key: 'division', label: 'Wallet division' }, { key: 'balance', label: 'Balance', unit: 'ISK' }], rows: walletRows, coverage: divisions.length === 7 ? 'complete' : 'partial', next: null, message: `${divisions.length} of seven wallet divisions returned. ${divisions.length === 7 ? 'All division balances are shown.' : 'Missing division balances are unavailable, not zero.'} Balances exclude assets and escrow and are not net worth or profit. Division names and transaction counterparties are not requested.` };
  }
  if (selected.view === 'contracts') {
    const all = rows(data, 'contract_id').map(row => {
      if (typeof row.status !== 'string' || !statuses.includes(row.status) || typeof row.type !== 'string' || !['unknown', 'item_exchange', 'auction', 'courier', 'loan'].includes(row.type)) return invalid();
      return { id: String(row.contract_id), cells: { contract: row.contract_id as number, title: row.title === undefined ? '' : text(row.title), type: row.type.replaceAll('_', ' '), status: row.status.replaceAll('_', ' '), expires: date(row.date_expired) }, action: { label: 'Load items', request: { view: 'contract_items', characterId: selected.characterId, contractId: row.contract_id as number, ...nameSelection } as CorporationWorkspaceRequest }, ...(row.type === 'auction' ? { actions: [{ label: 'Load bids', request: { view: 'contract_bids', characterId: selected.characterId, contractId: row.contract_id as number, page: 1, offset: 0, ...nameSelection } as CorporationWorkspaceRequest }] } : {}) };
    });
    const portion = pageTable(selected, all, pagination);
    return { ...portion, columns: [{ key: 'contract', label: 'Contract ID' }, { key: 'title', label: 'Title' }, { key: 'type', label: 'Type' }, { key: 'status', label: 'Status' }, { key: 'expires', label: 'Offer expiry', unit: 'datetime' }], message: `${portion.message} Offer expiry is not an accepted courier delivery deadline. Items and auction bids are loaded only when requested.` };
  }
  if (selected.view === 'contract_bids') {
    const all = rows(data, 'bid_id').map(row => {
      if (typeof row.amount !== 'number' || row.amount < 0) return invalid();
      return { id: String(row.bid_id), cells: { amount: amount(row.amount), date: date(row.date_bid) } };
    });
    const portion = pageTable(selected, all, pagination);
    return { ...portion, columns: [{ key: 'amount', label: 'Bid amount', unit: 'ISK' }, { key: 'date', label: 'Bid placed', unit: 'datetime' }], message: `Contract ${selected.contractId}. ${portion.message} Bidder identities are omitted. Bids are offers, not completed payments, profit or proof of the winning bid. No highest bid or auction outcome is inferred from this batch.` };
  }
  if (selected.view === 'contract_items') {
    const all = rows(data, 'record_id').map(row => {
      if (!integer(row.type_id, 1) || typeof row.is_included !== 'boolean' || typeof row.is_singleton !== 'boolean') return invalid();
      return { id: String(row.record_id), cells: { type: row.type_id, quantity: count(row.quantity), direction: row.is_included ? 'Offered' : 'Requested', singleton: row.is_singleton ? 'Yes' : 'No' } };
    });
    const portion = pageTable(selected, all, pagination);
    return { ...portion, columns: [{ key: 'type', label: 'Item type ID' }, { key: 'quantity', label: 'Quantity', unit: 'count' }, { key: 'direction', label: 'Contract side' }, { key: 'singleton', label: 'Singleton' }], message: `Contract ${selected.contractId}. ${portion.message} Public type labels are fetched only when selected. These are contract terms, not proof of current asset ownership.` };
  }
  if (selected.view === 'assets' || selected.view === 'asset_detail') {
    const all = assetRows(data);
    const columns: CorporationWorkspaceColumn[] = [{ key: 'item', label: 'Asset item ID' }, { key: 'type', label: 'Item type ID' }, { key: 'quantity', label: 'Quantity', unit: 'count' }, { key: 'location', label: 'Location ID' }, { key: 'locationType', label: 'Location type' }, { key: 'flag', label: 'Location flag' }, { key: 'singleton', label: 'Singleton' }];
    const rendered = all.map(row => ({ id: String(row.item_id), cells: assetCells(row), action: { label: 'Load asset details', request: { view: 'asset_detail', characterId: selected.characterId, itemId: row.item_id as number, page: selected.page ?? 1, ...nameSelection } as CorporationWorkspaceRequest } }));
    const portion = pageTable({ view: 'assets', characterId: selected.characterId, page: selected.page ?? 1, ...(selected.view === 'assets' ? { offset: selected.offset } : {}), ...nameSelection }, rendered, pagination);
    if (selected.view === 'assets') return { ...portion, columns, message: `${portion.message} Nested assets may be on other pages; location IDs are not a complete container hierarchy. Private item names and positions load only when selected. No inventory value, ownership transfer or profit is inferred. Director access is required.` };
    const selectedRow = all.find(row => row.item_id === selected.itemId);
    if (!selectedRow || !detail) return invalid();
    const named = assetLookup(detail.names, selected.itemId, 'name'), located = assetLookup(detail.locations, selected.itemId, 'location');
    const name = named ? text(named.name) : '';
    const position = located?.position as Record<string, number> | undefined;
    columns.splice(2, 0, { key: 'name', label: 'Custom item name' });
    columns.push({ key: 'x', label: 'Reported X (m)' }, { key: 'y', label: 'Reported Y (m)' }, { key: 'z', label: 'Reported Z (m)' });
    return { columns, rows: [{ id: String(selected.itemId), cells: { ...assetCells(selectedRow), name: name || 'Not reported', x: position?.x ?? 'Not reported', y: position?.y ?? 'Not reported', z: position?.z ?? 'Not reported' } }],
      coverage: name && position ? 'complete' : 'partial', next: null,
      message: `Asset ${selected.itemId} was found again on page ${selected.page} before single-item name and position reads. Custom names are available only for nameable items such as ships and containers; missing name or position data stays unavailable. Coordinates (0, 0, 0) are returned for items in hangars or stations and do not locate a tracked player or ship. The three provider snapshots may differ in time.` };
  }
  if (selected.view === 'order_history') {
    const all = rows(data, 'order_id').map(row => {
      if (!integer(row.type_id, 1) || !integer(row.location_id, 1) || !integer(row.wallet_division, 1) || row.wallet_division > 7 ||
          !integer(row.volume_total) || !integer(row.volume_remain) || row.volume_remain > row.volume_total ||
          typeof row.state !== 'string' || !['cancelled', 'expired'].includes(row.state) ||
          (row.is_buy_order !== undefined && typeof row.is_buy_order !== 'boolean') || typeof row.price !== 'number' || row.price < 0) return invalid();
      return { id: String(row.order_id), cells: { order: row.order_id as number, type: row.type_id, side: row.is_buy_order === true ? 'Buy' : 'Sell', state: row.state, price: amount(row.price), volumeTotal: row.volume_total, volumeRemain: row.volume_remain, issued: date(row.issued), location: row.location_id, division: row.wallet_division } };
    });
    const portion = pageTable(selected, all, pagination);
    return { ...portion, columns: [{ key: 'order', label: 'Order ID' }, { key: 'type', label: 'Item type ID' }, { key: 'side', label: 'Side' }, { key: 'state', label: 'Provider state' }, { key: 'price', label: 'Quoted unit price', unit: 'ISK' }, { key: 'volumeTotal', label: 'Original quantity', unit: 'count' }, { key: 'volumeRemain', label: 'Remaining quantity', unit: 'count' }, { key: 'issued', label: 'Issued', unit: 'datetime' }, { key: 'location', label: 'Location ID' }, { key: 'division', label: 'Wallet division' }], message: `${portion.message} EVE retains up to 90 days of cancelled or expired corporation orders. Remaining quantity and provider state do not prove fills, proceeds or profit; wallet transactions are separate. Issuer identities are omitted. Accountant or Trader access is required.` };
  }
  if (selected.view === 'blueprints') {
    const all = rows(data, 'item_id').map(row => {
      if (!integer(row.type_id, 1) || !integer(row.location_id, 1) || !integer(row.material_efficiency) || !integer(row.time_efficiency) ||
          !integer(row.quantity, -2) || row.quantity === 0 || !integer(row.runs, -1) ||
          (row.quantity === -2 ? row.runs < 0 : row.runs !== -1)) return invalid();
      const copy = row.quantity === -2, original = row.quantity === -1;
      return { id: String(row.item_id), cells: { item: row.item_id as number, type: row.type_id, kind: copy ? 'Copy' : original ? 'Original' : 'Original stack', units: copy || original ? 1 : row.quantity, materialEfficiency: row.material_efficiency, timeEfficiency: row.time_efficiency, runs: copy ? row.runs : 'Unlimited (original)', location: row.location_id, flag: text(row.location_flag, 80) } };
    });
    const portion = pageTable(selected, all, pagination);
    return { ...portion, columns: [{ key: 'item', label: 'Blueprint item ID' }, { key: 'type', label: 'Blueprint type ID' }, { key: 'kind', label: 'Blueprint kind' }, { key: 'units', label: 'Blueprint units', unit: 'count' }, { key: 'materialEfficiency', label: 'Material efficiency', unit: 'count' }, { key: 'timeEfficiency', label: 'Time efficiency', unit: 'count' }, { key: 'runs', label: 'Copy runs remaining / original' }, { key: 'location', label: 'Location ID' }, { key: 'flag', label: 'Location flag' }], message: `${portion.message} Copies have a finite remaining-run count; originals and fresh original stacks report unlimited original runs. Units count blueprint items, not production outputs. Material inputs, job availability and profit are not inferred. Director access is required.` };
  }
  if (selected.view === 'facilities') {
    const all = rows(data, 'facility_id').map(row => {
      if (!integer(row.type_id, 1) || !integer(row.system_id, 1)) return invalid();
      return { id: String(row.facility_id), cells: { facility: row.facility_id as number, type: row.type_id, system: row.system_id } };
    });
    const portion = pageTable(selected, all, pagination);
    return { ...portion, columns: [{ key: 'facility', label: 'Facility ID' }, { key: 'type', label: 'Facility type ID' }, { key: 'system', label: 'Solar system ID' }], message: `${portion.message} This endpoint supplies facility identifiers and systems, not service availability, manufacturing bonuses or job costs. Names are not looked up automatically. Factory Manager access is required.` };
  }
  if (selected.view === 'structures') {
    const states = ['anchor_vulnerable', 'anchoring', 'armor_reinforce', 'armor_vulnerable', 'deploy_vulnerable', 'fitting_invulnerable', 'hull_reinforce', 'hull_vulnerable', 'online_deprecated', 'onlining_vulnerable', 'shield_vulnerable', 'unanchored', 'unknown'];
    const optionalDate = (value: unknown) => value === undefined ? 'Not reported' : date(value);
    const all = rows(data, 'structure_id').map(row => {
      if (row.corporation_id !== expectedCorporationId || !integer(row.type_id, 1) || !integer(row.system_id, 1) || !integer(row.profile_id, 1) || typeof row.state !== 'string' || !states.includes(row.state)) return invalid();
      const fuelUntil = optionalDate(row.fuel_expires), timerEnd = optionalDate(row.state_timer_end), unanchorAt = optionalDate(row.unanchors_at);
      if (row.state_timer_start !== undefined) date(row.state_timer_start);
      let services = 'Not reported';
      if (row.services !== undefined) {
        if (!Array.isArray(row.services) || row.services.length > 100) return invalid();
        const serviceNames = row.services.map(service => {
          if (!record(service) || typeof service.state !== 'string' || !['online', 'offline', 'cleanup'].includes(service.state)) return invalid();
          const name = text(service.name, 80);
          if (!name) return invalid();
          return `${name}: ${service.state}`;
        });
        services = serviceNames.length ? serviceNames.slice(0, 10).join('; ') + (serviceNames.length > 10 ? `; ${serviceNames.length - 10} more services returned` : '') : 'No services returned';
      }
      return { id: String(row.structure_id), cells: { structure: row.structure_id as number, name: row.name === undefined ? 'Not reported' : text(row.name), type: row.type_id, system: row.system_id, state: row.state.replaceAll('_', ' '), fuelUntil, timerEnd, unanchorAt, services } };
    });
    const portion = pageTable(selected, all, pagination);
    return { ...portion, columns: [{ key: 'structure', label: 'Structure ID' }, { key: 'name', label: 'Name' }, { key: 'type', label: 'Structure type ID' }, { key: 'system', label: 'Solar system ID' }, { key: 'state', label: 'Provider state' }, { key: 'fuelUntil', label: 'Reported fuel expiry (UTC)' }, { key: 'timerEnd', label: 'State timer end (UTC)' }, { key: 'unanchorAt', label: 'Unanchor time (UTC)' }, { key: 'services', label: 'Reported services' }], message: `${portion.message} Missing fuel, timer and service fields are not reported, not zero or offline. Expiry and timer timestamps are cached provider schedules, not proof of current fuel quantity or destruction. Up to ten service names are shown per structure; additional services are counted explicitly. Station Manager access is required. Access profiles and reinforcement settings are omitted.` };
  }
  if (selected.view === 'extractions') {
    const all = extractionRows(data).map(row => ({ id: String(row.structure), cells: { ...row, phase: Date.parse(row.start) > now ? 'Start pending' : Date.parse(row.arrival) > now ? 'Arrival pending' : Date.parse(row.decay) > now ? 'Arrival time passed' : 'Natural fracture time passed' } }));
    const portion = pageTable(selected, all, pagination);
    return { ...portion, columns: [{ key: 'structure', label: 'Structure ID' }, { key: 'moon', label: 'Moon ID' }, { key: 'start', label: 'Extraction started (UTC)', unit: 'datetime' }, { key: 'arrival', label: 'Chunk arrival (UTC)', unit: 'datetime' }, { key: 'decay', label: 'Natural fracture (UTC)', unit: 'datetime' }, { key: 'phase', label: 'Schedule at load' }], message: `${portion.message} These are cached schedules classified at load time. Arrival is when a chunk can be fractured; natural fracture is its automatic fracture time if it was not fractured earlier. Neither date proves ore availability, mining yield or depletion. No observer history, miner identities, ore volumes or values are requested. Station Manager access is required.` };
  }
  if (selected.view === 'freelance_jobs') {
    if (!record(pagination) || pagination.kind !== 'cursor') return invalid();
    for (const key of ['after', 'before']) if (pagination[key] !== null && pagination[key] !== undefined && !cursor(pagination[key])) return invalid();
    const after = pagination.after === null || pagination.after === undefined ? null : pagination.after !== selected.after ? pagination.after as string : invalid();
    const all = freelanceRows(data, 100).map(row => ({ id: row.id, cells: { name: row.name, state: row.state, current: row.current, desired: row.desired, initialReward: row.initialReward ?? 'Not reported', remainingReward: row.remainingReward ?? 'Not reported', lastModified: row.lastModified } }));
    return { columns: [{ key: 'name', label: 'Freelance job' }, { key: 'state', label: 'Provider state' }, { key: 'current', label: 'Job progress', unit: 'count' }, { key: 'desired', label: 'Job target', unit: 'count' }, { key: 'initialReward', label: 'Initial reward reserve (ISK)' }, { key: 'remainingReward', label: 'Remaining reward reserve (ISK)' }, { key: 'lastModified', label: 'Job updated (UTC)', unit: 'datetime' }], rows: all, coverage: 'unknown', next: after ? { ...selected, after } : null, message: `One corporation freelance-job batch (${all.length} returned). Full coverage is unknown even when no next cursor is supplied. Progress uses each job’s configured units, not the selected character’s contribution; different objectives are not added together. Reward reserves are budgets, not earned, claimable or paid rewards or profit. Missing rewards stay unavailable. Descriptions, creator identities and participant lists are omitted; no participation details are requested. Project Manager access is required.` };
  }
  const columns: CorporationWorkspaceColumn[] = [{ key: 'name', label: 'Project' }, { key: 'state', label: 'State' }, { key: 'current', label: 'Reported progress', unit: 'count' }, { key: 'desired', label: 'Target', unit: 'count' }, { key: 'lastModified', label: 'Project updated', unit: 'datetime' }];
  if (selected.view === 'projects') {
    if (!record(data) || !record(pagination) || pagination.kind !== 'cursor') return invalid();
    const all = rows(data.projects, 'id', 100).map(row => ({ id: String(row.id).toLowerCase(), cells: projectFields(row), action: { label: 'Load progress', request: { view: 'project', characterId: selected.characterId, projectId: String(row.id).toLowerCase(), ...nameSelection } as CorporationWorkspaceRequest } }));
    const after = pagination.after === null || pagination.after === undefined ? null : cursor(pagination.after) && pagination.after !== selected.after ? pagination.after : invalid();
    return { columns, rows: all, coverage: 'unknown', next: after ? { ...selected, after } : null, message: `One active-project batch (${all.length} returned). Full coverage is unknown even when no next cursor is supplied. Progress and targets use each project’s configured units. Individual contribution is loaded only when requested; contributor lists are never fetched.` };
  }
  if (!record(data) || !uuid(data.id) || data.id.toLowerCase() !== selected.projectId || !record(pagination) || pagination.kind !== 'none' || !record(contribution)) return invalid();
  const cells = { ...projectFields(data), ownContribution: count(contribution.contributed) };
  if (contribution.last_modified !== undefined) date(contribution.last_modified);
  columns.splice(4, 0, { key: 'ownContribution', label: 'Selected character contribution', unit: 'count' });
  const objective = projectObjective(data);
  return { columns, rows: [{ id: selected.projectId, cells }], details: objective.details, coverage: objective.incomplete ? 'partial' : 'complete', next: null, message: 'Project progress and the selected character’s own contribution were read separately and may reflect different snapshot times. Counts use this project’s configured units; a target of zero has no inferred completion percentage. No contributor list is requested; creator identity is omitted from this view. ' + (objective.incomplete ? 'The objective summary is partial or unavailable. ' : '') + 'Only selected objective settings are displayed; identity and location filters and free-text descriptions are omitted. Missing settings are not assumed to be unrestricted or zero. Review the full requirements in EVE before contributing. Reward reserves and configured rates are not earned or claimable rewards.' };
}

async function addPublicNames(selected: CorporationWorkspaceRequest, rendered: Table, dependencies: Dependencies, sources: CorporationWorkspace['sources'], signal: AbortSignal): Promise<boolean> {
  if (selected.includeNames !== true) return false;
  const eligible = ['contract_items', 'order_history', 'blueprints', 'facilities', 'structures', 'assets', 'asset_detail'];
  if (!eligible.includes(selected.view)) return false;
  const expected = new Map<number, 'inventory_type' | 'solar_system'>();
  try {
    // Read only the fields whose semantic types are fixed by the table builder.
    // Never send asset, location, owner or other private identifiers to this API.
    for (const row of rendered.rows) for (const key of ['type', 'system'] as const) {
      const value = row.cells[key];
      if (value === undefined) continue;
      if (!integer(value, 1)) return invalid();
      const category = key === 'type' ? 'inventory_type' : 'solar_system';
      if (expected.has(value) && expected.get(value) !== category) return invalid();
      expected.set(value, category);
    }
    if (!expected.size) return false;
    if (expected.size > 200 || !dependencies.publicNames) return invalid();
    signal.throwIfAborted();
    const response = await dependencies.publicNames([...expected.keys()], signal);
    signal.throwIfAborted();
    if (!record(response) || !overviewDate(response.retrievedAt) || !Array.isArray(response.data) || response.data.length > expected.size) return invalid();
    const names = new Map<number, string>();
    for (const item of response.data) {
      if (!record(item) || !integer(item.id, 1) || !expected.has(item.id) || names.has(item.id) || item.category !== expected.get(item.id)) return invalid();
      const label = text(item.name);
      if (!label) return invalid();
      names.set(item.id, label);
    }
    sources.push({ dataset: 'public_names', scope: 'Public ESI (no scope)', retrievedAt: date(response.retrievedAt), cacheExpires: headerDate(response.cacheExpires) });
    for (const row of rendered.rows) for (const key of ['type', 'system'] as const) {
      const value = row.cells[key];
      if (typeof value === 'number' && names.has(value)) row.cells[key] = `${names.get(value)} (${value})`;
    }
    for (const column of rendered.columns) if (column.key === 'type' || column.key === 'system') column.label = column.label.replace(/ ID$/, ' / ID');
    rendered.message += ` Public labels resolved for ${names.size} of ${expected.size} displayed type/system IDs. Unresolved IDs remain visible; public labels do not expand the private dataset's coverage.`;
    return names.size < expected.size;
  } catch {
    signal.throwIfAborted();
    rendered.message += ' Public type/system labels could not be loaded safely. Original IDs are preserved; no retry or extra private lookup was made.';
    return true;
  }
}

// Dependencies are injected to exercise all privacy and coverage behavior with
// synthetic fixtures. No workspace result is stored, logged or cached here.
export function createCorporationWorkspaceReader(dependencies: Dependencies) {
  return async function read(user: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<CorporationWorkspace> {
    const selected = args(input), now = dependencies.now ?? Date.now;
    if (!user || typeof user !== 'string') throw new EveError('Sign in to this private connector first.', 401);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    signal.throwIfAborted();
    const connection = (await dependencies.connections(user)).find(row => row.characterId === selected.characterId);
    if (!connection) throw new EveError('Choose a character connected to this private connector.', 404);
    signal.throwIfAborted();
    if (!connection.scopes.includes(scopes[selected.view])) return blank(selected, now(), 'needs_permission', 'This character has not granted the required read permission. Select that optional permission and authorize again; existing grants are not changed automatically.');
    const sources: CorporationWorkspace['sources'] = [];
    let corporationId: number | undefined;
    try {
      const fetchOne = async (request: ReadArgs) => {
        signal.throwIfAborted();
        const result = await dependencies.corporation(user, request, signal);
        signal.throwIfAborted();
        if (!record(result) || result.entity !== 'corporation' || result.characterId !== selected.characterId || result.dataset !== request.dataset || !integer(result.corporationId, 1) || !overviewDate(result.retrievedAt)) return invalid();
        if (corporationId !== undefined && corporationId !== result.corporationId) throw new EveError('Corporation changed.', 409);
        corporationId = result.corporationId;
        sources.push({ dataset: request.dataset, scope: scopes[selected.view], retrievedAt: date(result.retrievedAt), cacheExpires: headerDate(result.cacheExpires) });
        return result;
      };
      const result = await fetchOne(definition(selected));
      let contribution: unknown;
      let assetDetail: AssetDetail | undefined;
      if (selected.view === 'asset_detail') {
        // Re-establish page membership before sending even one private item ID.
        const found = assetRows(result.data).find(row => row.item_id === selected.itemId);
        if (!found) throw new EveError('Asset is no longer on the selected page.', 404);
        // Validate the complete page envelope before item-specific requests.
        pageTable({ view: 'assets', characterId: selected.characterId, page: selected.page }, [], result.pagination);
        const names = await fetchOne({ characterId: selected.characterId, dataset: 'asset_names', parameters: { itemIds: [found.item_id] } });
        if (!record(names.pagination) || names.pagination.kind !== 'none') return invalid();
        assetLookup(names.data, selected.itemId, 'name');
        const locations = await fetchOne({ characterId: selected.characterId, dataset: 'asset_locations', parameters: { itemIds: [found.item_id] } });
        if (!record(locations.pagination) || locations.pagination.kind !== 'none') return invalid();
        assetLookup(locations.data, selected.itemId, 'location');
        assetDetail = { names: names.data, locations: locations.data };
      }
      if (selected.view === 'project') {
        // Validate the first response before issuing even the second bounded read.
        if (!record(result.data) || !uuid(result.data.id) || result.data.id.toLowerCase() !== selected.projectId) return invalid();
        projectFields(result.data);
        if (!record(result.pagination) || result.pagination.kind !== 'none') return invalid();
        const own = await fetchOne({ characterId: selected.characterId, dataset: 'project_contribution', parameters: { projectId: selected.projectId } });
        if (!record(own.pagination) || own.pagination.kind !== 'none') return invalid();
        contribution = own.data;
      }
      const rendered = table(selected, result.data, result.pagination, now(), contribution, corporationId, assetDetail);
      const namesIncomplete = await addPublicNames(selected, rendered, dependencies, sources, signal);
      signal.throwIfAborted();
      const retrievedAt = sources.map(source => source.retrievedAt).sort()[0];
      const cacheExpires = sources.every(source => source.cacheExpires !== null) ? sources.map(source => source.cacheExpires as string).sort()[0] : null;
      const stale = sources.some(source => source.cacheExpires !== null && Date.parse(source.cacheExpires) <= now());
      return { ...blank(selected, now(), rendered.coverage === 'complete' && !stale && !namesIncomplete ? 'ready' : 'partial', rendered.message), ...rendered, ...(corporationId === undefined ? {} : { corporationId }), retrievedAt, cacheExpires, sources, message: rendered.message + (stale ? ' At least one snapshot has reached its reported cache expiry; refresh before relying on it.' : '') };
    } catch (error) {
      if (signal.aborted) return blank(selected, now(), 'unavailable', 'The request was cancelled or reached its time limit. Load the view again to retry.');
      if (error instanceof EveError && error.status === 403) return blank(selected, now(), 'unavailable', 'EVE denied this read. Check the granted read permission and the character’s corporation role; no additional role is requested automatically.');
      if (error instanceof EveError && error.status === 429) return blank(selected, now(), 'unavailable', 'EVE is rate limiting requests. Wait before loading the view again. No automatic retry was made.');
      if (error instanceof EveError && [401, 404, 409].includes(error.status)) return blank(selected, now(), 'unavailable', 'The connection, corporation membership or selected record changed, or authorization expired. Reload connection status and the first batch. No mixed or partial detail is shown.');
      return blank(selected, now(), 'error', error instanceof OverviewDataError ? 'EVE returned data that could not be displayed safely. No balance or contribution is assumed.' : 'This EVE read could not be loaded. Try again; no missing balance or contribution is assumed to be zero.');
    }
  };
}

export const readCorporationWorkspace = createCorporationWorkspaceReader({ connections: listConnections, corporation: readCorporationData, publicNames: readPublicNames });
