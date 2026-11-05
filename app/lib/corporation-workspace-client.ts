import { ConnectionResponseError } from './connection-client';
import type { CorporationWorkspace, CorporationWorkspaceColumn, CorporationWorkspaceRequest } from './corporation-workspace-types';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 2048;
const date = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
const nullableDate = (value: unknown) => value === null || date(value);
const id = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const integer = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const uuid = (value: unknown) => typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const freelanceStates = ['Unspecified', 'Active', 'Closed', 'Completed', 'Expired', 'Deleted'];
const extractionPhases = ['Start pending', 'Arrival pending', 'Arrival time passed', 'Natural fracture time passed'];
const newViewColumns: Record<string, string[]> = {
  extractions: ['structure', 'moon', 'start', 'arrival', 'decay', 'phase'],
  freelance_jobs: ['name', 'state', 'current', 'desired', 'initialReward', 'remainingReward', 'lastModified'],
};
const reward = (value: unknown) => value === 'Not reported' || typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
function request(value: unknown, characterId: number): value is CorporationWorkspaceRequest {
  if (!record(value) || !Object.hasOwn(value, 'characterId') || !Object.hasOwn(value, 'view') || value.characterId !== characterId || !id(value.characterId)) return false;
  const keys: Record<string, string[]> = { wallets: [], contracts: ['page', 'offset'], projects: ['after'], contract_items: ['contractId', 'offset'], contract_bids: ['contractId', 'page', 'offset'], project: ['projectId'], order_history: ['page', 'offset'], blueprints: ['page', 'offset'], facilities: ['offset'], structures: ['page', 'offset'], assets: ['page', 'offset'], asset_detail: ['itemId', 'page'], extractions: ['page', 'offset'], freelance_jobs: ['after'] };
  if (typeof value.view !== 'string' || !Object.hasOwn(keys, value.view) || Object.keys(value).some(key => !['view', 'characterId', 'includeNames', ...keys[value.view as string]].includes(key))) return false;
  if (value.includeNames !== undefined && typeof value.includeNames !== 'boolean') return false;
  return (value.page === undefined || integer(value.page, 1, 500)) && (value.offset === undefined || integer(value.offset, 0, 9900) && (value.offset as number) % 100 === 0) &&
    (value.after === undefined || typeof value.after === 'string' && value.after.length > 0 && value.after.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(value.after)) &&
    (!['contract_items', 'contract_bids'].includes(value.view) || Object.hasOwn(value, 'contractId') && id(value.contractId)) &&
    (value.view !== 'project' || Object.hasOwn(value, 'projectId') && uuid(value.projectId)) &&
    (value.view !== 'asset_detail' || Object.hasOwn(value, 'itemId') && Object.hasOwn(value, 'page') && id(value.itemId) && integer(value.page, 1, 500));
}
export function corporationWorkspaceResponse(value: unknown, args: CorporationWorkspaceRequest): CorporationWorkspace {
  const invalid = () => { throw new ConnectionResponseError('The corporation workspace returned an incomplete response. Please try again.'); };
  if (!request(args, args.characterId) || !record(value) || value.characterId !== args.characterId || value.view !== args.view || !date(value.generatedAt) ||
      (value.corporationId !== undefined && !id(value.corporationId)) || !text(value.message) || !text(value.scope) ||
      typeof value.status !== 'string' || !['ready', 'partial', 'needs_permission', 'unavailable', 'error'].includes(value.status) ||
      typeof value.coverage !== 'string' || !['complete', 'partial', 'unknown', 'unavailable'].includes(value.coverage) ||
      !nullableDate(value.retrievedAt) || !nullableDate(value.cacheExpires) || !Array.isArray(value.sources) || value.sources.length > 4 ||
      !value.sources.every(source => record(source) && text(source.dataset) && text(source.scope) && date(source.retrievedAt) && nullableDate(source.cacheExpires)) ||
      !Array.isArray(value.columns) || value.columns.length > 12 || !Array.isArray(value.rows) || value.rows.length > 100) return invalid();
  const columns = value.columns;
  if (!columns.every(column => record(column) && typeof column.key === 'string' && /^[a-z][A-Za-z0-9]{0,40}$/.test(column.key) &&
      !['constructor', 'prototype', '__proto__'].includes(column.key) && text(column.label) &&
      (column.unit === undefined || typeof column.unit === 'string' && ['ISK', 'count', 'datetime'].includes(column.unit))) ||
      new Set(columns.map(column => column.key)).size !== columns.length) return invalid();
  // These bounded views deliberately expose schedules and job progress only.
  // Reject extra columns so provider identity/description fields cannot be rendered.
  if (Object.hasOwn(newViewColumns, args.view) && (['ready', 'partial'].includes(value.status) || columns.length > 0) &&
      (columns.length !== newViewColumns[args.view].length || columns.some(column => !newViewColumns[args.view].includes(column.key)))) return invalid();
  if (Object.hasOwn(newViewColumns, args.view) && columns.some(column => column.unit !==
      (['start', 'arrival', 'decay', 'lastModified'].includes(column.key) ? 'datetime' : ['current', 'desired'].includes(column.key) ? 'count' : undefined))) return invalid();
  const rowIds = new Set<string>();
  for (const row of value.rows) {
    if (!record(row) || !text(row.id) || !row.id || rowIds.has(row.id) || !record(row.cells) || Object.keys(row.cells).length !== columns.length) return invalid();
    rowIds.add(row.id);
    for (const column of columns) {
      const cell = row.cells[column.key];
      if (!Object.hasOwn(row.cells, column.key) || !(text(cell) || typeof cell === 'number' && Number.isFinite(cell)) ||
          (column.unit === 'count' && (typeof cell !== 'number' || !Number.isSafeInteger(cell) || cell < 0)) ||
          (column.unit === 'ISK' && typeof cell !== 'number') || (column.unit === 'datetime' && !date(cell))) return invalid();
    }
    if (args.view === 'extractions' && (!id(row.cells.structure) || !id(row.cells.moon) || row.id !== String(row.cells.structure) ||
        !date(row.cells.start) || !date(row.cells.arrival) || !date(row.cells.decay) ||
        Date.parse(row.cells.start) > Date.parse(row.cells.arrival) || Date.parse(row.cells.arrival) > Date.parse(row.cells.decay) ||
        typeof row.cells.phase !== 'string' || !extractionPhases.includes(row.cells.phase))) return invalid();
    if (args.view === 'freelance_jobs' && (!uuid(row.id) || !text(row.cells.name) || typeof row.cells.state !== 'string' || !freelanceStates.includes(row.cells.state) ||
        !integer(row.cells.current, 0, Number.MAX_SAFE_INTEGER) || !integer(row.cells.desired, 0, Number.MAX_SAFE_INTEGER) ||
        !reward(row.cells.initialReward) || !reward(row.cells.remainingReward) || !date(row.cells.lastModified))) return invalid();
    if (row.actions !== undefined && (!Array.isArray(row.actions) || row.actions.length > 2 || args.view !== 'contracts')) return invalid();
    const actions = [...(row.action === undefined ? [] : [row.action]), ...(Array.isArray(row.actions) ? row.actions : [])];
    const actionViews = new Set<string>();
    for (const action of actions) {
      if (!record(action) || !Object.hasOwn(action, 'label') || !Object.hasOwn(action, 'request') ||
          Object.keys(action).some(key => !['label', 'request'].includes(key)) || !text(action.label) || !action.label.trim() ||
          !request(action.request, args.characterId) || actionViews.has(action.request.view) ||
          (action.request.includeNames ?? false) !== (args.includeNames ?? false)) return invalid();
      const target = action.request;
      if (!(args.view === 'contracts' && (target.view === 'contract_items' || target.view === 'contract_bids') && String(target.contractId) === row.id &&
          (target.view !== 'contract_bids' || row.cells.type === 'auction') && (target.offset ?? 0) === 0 && (target.view !== 'contract_bids' || (target.page ?? 1) === 1) ||
          args.view === 'projects' && target.view === 'project' && target.projectId.toLowerCase() === row.id.toLowerCase() ||
          args.view === 'assets' && target.view === 'asset_detail' && target.page === (args.page ?? 1) && String(target.itemId) === row.id)) return invalid();
      actionViews.add(target.view);
    }
  }
  if (value.next !== null && (!request(value.next, args.characterId) || value.next.view !== args.view ||
      (value.next.includeNames ?? false) !== (args.includeNames ?? false) ||
      !['contracts', 'projects', 'contract_items', 'contract_bids', 'order_history', 'blueprints', 'facilities', 'structures', 'assets', 'extractions', 'freelance_jobs'].includes(args.view) ||
      (args.view === 'extractions' && (value.next.view !== 'extractions' ||
        !((value.next.page ?? 1) === (args.page ?? 1) && (value.next.offset ?? 0) === (args.offset ?? 0) + 100 ||
          (value.next.page ?? 1) === (args.page ?? 1) + 1 && (value.next.offset ?? 0) === 0))) ||
      (args.view === 'freelance_jobs' && (value.next.view !== 'freelance_jobs' || !value.next.after || value.next.after === args.after)) ||
      (args.view === 'contract_items' && (value.next.view !== 'contract_items' || value.next.contractId !== args.contractId)) ||
      (args.view === 'contract_bids' && (value.next.view !== 'contract_bids' || value.next.contractId !== args.contractId ||
        !((value.next.page ?? 1) === (args.page ?? 1) && (value.next.offset ?? 0) === (args.offset ?? 0) + 100 ||
          (value.next.page ?? 1) === (args.page ?? 1) + 1 && (value.next.offset ?? 0) === 0))) ||
      JSON.stringify(value.next) === JSON.stringify(args))) return invalid();
  if (value.details !== undefined && (args.view !== 'project' || !['ready', 'partial'].includes(value.status) || !Array.isArray(value.details) || value.details.length > 20 ||
      !value.details.every(detail => record(detail) && Object.hasOwn(detail, 'label') && Object.hasOwn(detail, 'value') &&
        Object.keys(detail).every(key => ['label', 'value'].includes(key)) &&
        text(detail.label) && detail.label.trim().length > 0 && detail.label.length <= 128 &&
        (text(detail.value) || typeof detail.value === 'number' && Number.isFinite(detail.value) && Math.abs(detail.value) <= Number.MAX_SAFE_INTEGER)) ||
      new Set(value.details.map(detail => detail.label)).size !== value.details.length)) return invalid();
  if (!['ready', 'partial'].includes(value.status) && (value.rows.length || value.next !== null || (Array.isArray(value.details) && value.details.length))) return invalid();
  return value as CorporationWorkspace;
}

export function formatCorporationCell(value: string | number, column: CorporationWorkspaceColumn): string {
  if (['fuelUntil', 'timerEnd', 'unanchorAt', 'start', 'arrival', 'decay', 'lastModified'].includes(column.key) && date(value)) {
    return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
  }
  if (column.unit === 'datetime' && date(value)) return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  // Identifiers and untyped numeric values retain their exact digits. Formatting
  // counts or prices must never introduce separators into IDs copied for lookups.
  const currency = column.unit === 'ISK' || ['initialReward', 'remainingReward'].includes(column.key);
  if (typeof value === 'number' && (currency || column.unit === 'count')) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: currency ? 2 : 0 }).format(value) + (currency ? ' ISK' : '');
  }
  return String(value);
}

export async function corporationWorkspaceRequest(args: CorporationWorkspaceRequest, signal: AbortSignal): Promise<CorporationWorkspace> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, 75000);
  try {
    const response = await fetch('/api/eve/corporation-workspace', {
      method: 'POST', cache: 'no-store', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args),
    });
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      throw new ConnectionResponseError('Sign in to this private connector to load corporation data.', 401);
    }
    let value: unknown;
    try { value = await response.json(); } catch { throw new ConnectionResponseError('The corporation service returned an unreadable response. Please try again.'); }
    if (!response.ok) throw new ConnectionResponseError('Corporation data could not be loaded. Please try again or review your connection.', response.status);
    return corporationWorkspaceResponse(value, args);
  } catch (error) {
    if (controller.signal.aborted) throw new ConnectionResponseError(signal.aborted ? 'Corporation request cancelled.' : 'The corporation service took too long to respond. Please try again.');
    if (error instanceof ConnectionResponseError) throw error;
    throw new ConnectionResponseError('Could not reach the corporation service. Please try again.');
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
