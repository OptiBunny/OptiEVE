import type { ManufacturingCard, ManufacturingContext, ManufacturingJob, ManufacturingRequest, ManufacturingResponse, ManufacturingReadiness } from './manufacturing-types';

export class ManufacturingResponseError extends Error { constructor(message: string, public readonly status = 400) { super(message); } }
const fail = (): never => { throw new ManufacturingResponseError('The manufacturing response did not match this selection. Load it again.'); };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const object = (value: unknown) => record(value) ? value : fail();
const text = (value: unknown, maximum = 512): string => typeof value === 'string' && value.length <= maximum && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ? value : fail();
const number = (value: unknown, minimum = 0, maximum = 1e12): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fail();
const identifier = (value: unknown) => number(value, 1, Number.MAX_SAFE_INTEGER);
const nullableNumber = (value: unknown) => value === null ? null : number(value);
const boolean = (value: unknown): boolean => typeof value === 'boolean' ? value : fail();
const nullableBoolean = (value: unknown) => value === null ? null : boolean(value);
const money = (value: unknown, signed = false): string | null => value === null ? null : typeof value === 'string' && (signed ? /^-?(0|[1-9]\d{0,18})\.\d{2}$/ : /^(0|[1-9]\d{0,18})\.\d{2}$/).test(value) ? value : fail();
const date = (value: unknown): string => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : fail();
const optionalDate = (value: unknown) => value === null ? null : date(value);
const array = (value: unknown, maximum: number): unknown[] => Array.isArray(value) && value.length <= maximum ? value : fail();
const choice = <T extends string>(value: unknown, choices: readonly T[]): T => typeof value === 'string' && choices.includes(value as T) ? value as T : fail();
const strings = (value: unknown, maximum = 200) => array(value, maximum).map(item => text(item, 2048));
const readiness = (value: unknown): ManufacturingReadiness => choice(value, ['conditional', 'unconfirmed', 'blocked']);
const contextKeys = ['characterId', 'resourceEntity', 'walletDivision', 'hangarDivisions', 'marketRegionId', 'marketStationId', 'manufacturingSystemId', 'manufacturingStructureId', 'useOwnedMaterials', 'stockLocationIds', 'otherOwnedOrdersReviewed', 'additionalOwnedOrderIds', 'maxPrivatePages', 'maxMarketPages'];
function context(value: unknown, expected: ManufacturingContext): ManufacturingContext {
  const row = object(value);
  if (Object.keys(row).some(key => !contextKeys.includes(key)) || Object.keys(row).length !== Object.keys(expected).filter(key => expected[key as keyof ManufacturingContext] !== undefined).length) return fail();
  for (const key of contextKeys) {
    const actual = row[key], wanted = expected[key as keyof ManufacturingContext];
    if (Array.isArray(wanted)) {
      if (!Array.isArray(actual) || actual.length !== wanted.length || actual.some((item, index) => item !== wanted[index])) return fail();
    } else if (actual !== wanted) return fail();
  }
  return structuredClone(expected);
}
export function assessmentContext(input: Extract<ManufacturingRequest, { operation: 'assess' }>['input']): ManufacturingContext {
  const { blueprintTypeId: _type, blueprintSource: _source, blueprintItemId: _item, blueprintPage: _page, plan: _plan, ...selected } = input;
  void _type; void _source; void _item; void _page; void _plan;
  return selected;
}
function card(value: unknown, expected: Pick<ManufacturingJob, 'key' | 'blueprintTypeId' | 'plan'>): ManufacturingCard {
  const row = object(value);
  if (row.key !== expected.key || row.blueprintTypeId !== expected.blueprintTypeId || row.runs !== expected.plan.runs) return fail();
  const materials = array(row.materials, 12).map(value => { const m = object(value); return { typeId: identifier(m.typeId), name: text(m.name), requiredQuantity: number(m.requiredQuantity), ownedQuantity: nullableNumber(m.ownedQuantity), usedQuantity: nullableNumber(m.usedQuantity), missingQuantity: nullableNumber(m.missingQuantity), buyISK: money(m.buyISK) }; });
  if (new Set(materials.map(item => item.typeId)).size !== materials.length) return fail();
  for (const material of materials) if (material.usedQuantity !== null && material.missingQuantity !== null && material.usedQuantity + material.missingQuantity !== material.requiredQuantity || material.usedQuantity !== null && material.ownedQuantity !== null && material.usedQuantity > material.ownedQuantity) return fail();
  return {
    key: expected.key, blueprintTypeId: expected.blueprintTypeId, name: text(row.name), productName: text(row.productName), runs: number(row.runs, 1, 1e6), outputQuantity: number(row.outputQuantity, 1),
    readiness: readiness(row.readiness), availableWalletISK: money(row.availableWalletISK), cashRequiredISK: money(row.cashRequiredISK), economicCostISK: money(row.economicCostISK), profitISK: money(row.profitISK, true), listedProfitISK: money(row.listedProfitISK, true), affordable: nullableBoolean(row.affordable),
    recipeCurrent: boolean(row.recipeCurrent), stockCoverage: text(row.stockCoverage), ownOrdersComplete: boolean(row.ownOrdersComplete), materials, reasons: strings(row.reasons),
    freshness: array(row.freshness, 128).map(value => { const source = object(value); return { label: text(source.label, 128), status: choice(source.status, ['fresh', 'stale', 'unknown']), cacheExpires: optionalDate(source.cacheExpires) }; }),
  };
}
function cards(value: unknown, jobs: ManufacturingJob[]): ManufacturingCard[] {
  const rows = array(value, 5); if (rows.length !== jobs.length) return fail();
  const seen = new Set<string>();
  return rows.map(value => { const row = object(value), wanted = jobs.find(job => job.key === row.key); if (!wanted || seen.has(wanted.key)) return fail(); seen.add(wanted.key); return card(row, wanted); });
}
/** Retains only bounded display fields; wrong selections never reach the UI. */
export function manufacturingResponse(value: unknown, request: ManufacturingRequest): ManufacturingResponse {
  const row = object(value); if (row.operation !== request.operation) return fail();
  const generatedAt = date(row.generatedAt);
  if (request.operation === 'search') {
    if (row.query !== request.query) return fail();
    const items = array(row.items, 50).map(value => { const item = object(value), blueprintTypeIds = array(item.blueprintTypeIds, 20).map(identifier); if (new Set(blueprintTypeIds).size !== blueprintTypeIds.length) return fail(); return { typeId: identifier(item.typeId), name: text(item.name), blueprintTypeIds }; });
    if (new Set(items.map(item => item.typeId)).size !== items.length) return fail();
    const nextOffset = row.nextOffset === null ? null : number(row.nextOffset, 1, 100000);
    if (nextOffset !== null && nextOffset <= (request.offset ?? 0)) return fail();
    return { operation: 'search', generatedAt, query: request.query, items, nextOffset, totalMatches: number(row.totalMatches, 0, 100000) };
  }
  if (request.operation === 'blueprints') {
    if (row.characterId !== request.characterId || row.resourceEntity !== request.resourceEntity || row.page !== request.page) return fail();
    const items = array(row.items, 10000).map(value => { const item = object(value); return { itemId: identifier(item.itemId), typeId: identifier(item.typeId), name: text(item.name), kind: choice(item.kind, ['original', 'copy', 'unknown']), materialEfficiency: item.materialEfficiency === null ? null : number(item.materialEfficiency, 0, 10), remainingRuns: nullableNumber(item.remainingRuns) }; });
    if (new Set(items.map(item => item.itemId)).size !== items.length) return fail();
    return { operation: 'blueprints', generatedAt, characterId: request.characterId, resourceEntity: request.resourceEntity, page: request.page, pages: row.pages === null ? null : number(row.pages, request.page, 500), coverage: choice(row.coverage, ['complete', 'partial', 'unknown']), cacheExpires: optionalDate(row.cacheExpires), items };
  }
  if (request.operation === 'catalog') return { operation: 'catalog', generatedAt, status: choice(row.status, ['current', 'update_required', 'unverified']), pinnedBuild: identifier(row.pinnedBuild), latestBuild: row.latestBuild === null ? null : identifier(row.latestBuild), message: text(row.message, 2048) };
  if (request.operation === 'assess') return { operation: 'assess', generatedAt, context: context(row.context, assessmentContext(request.input)), assessment: card(row.assessment, { key: 'selected', blueprintTypeId: request.input.blueprintTypeId, plan: request.input.plan }) };
  const selected = context(row.context, request.input.context);
  if (request.operation === 'compare') {
    const candidates = cards(row.candidates, request.input.jobs), rankedKeys = array(row.rankedKeys, 5).map(value => text(value, 40));
    if (new Set(rankedKeys).size !== rankedKeys.length || rankedKeys.some(key => !candidates.some(candidate => candidate.key === key && candidate.readiness === 'conditional' && candidate.profitISK !== null))) return fail();
    return { operation: 'compare', generatedAt, context: selected, candidates, rankedKeys, conditions: strings(row.conditions) };
  }
  const totals = object(row.totals);
  const shoppingList = array(row.shoppingList, 60).map(value => { const material = object(value); return { typeId: identifier(material.typeId), name: text(material.name), requiredQuantity: number(material.requiredQuantity), ownedAllocatedQuantity: nullableNumber(material.ownedAllocatedQuantity), missingQuantity: nullableNumber(material.missingQuantity), purchaseISK: money(material.purchaseISK), coverage: text(material.coverage, 128) }; });
  if (new Set(shoppingList.map(item => item.typeId)).size !== shoppingList.length || shoppingList.some(item => item.ownedAllocatedQuantity !== null && item.missingQuantity !== null && item.ownedAllocatedQuantity + item.missingQuantity !== item.requiredQuantity)) return fail();
  const outputs = array(row.outputs, 5).map(value => { const output = object(value); return { typeId: identifier(output.typeId), name: text(output.name), quantity: number(output.quantity, 1), grossRevenueISK: money(output.grossRevenueISK), coverage: text(output.coverage, 128) }; });
  if (new Set(outputs.map(item => item.typeId)).size !== outputs.length) return fail();
  return { operation: 'plan', generatedAt, context: selected, jobs: cards(row.jobs, request.input.jobs), shoppingList, outputs,
    totals: { walletISK: money(totals.walletISK), materialCashISK: money(totals.materialCashISK), jobAndOverheadCashISK: money(totals.jobAndOverheadCashISK), cashRequiredISK: money(totals.cashRequiredISK), affordable: nullableBoolean(totals.affordable), netRevenueISK: money(totals.netRevenueISK), economicProfitISK: money(totals.economicProfitISK, true) }, readiness: readiness(row.readiness), conditions: strings(row.conditions) };
}

export async function manufacturingRequest(request: ManufacturingRequest, signal: AbortSignal): Promise<ManufacturingResponse> {
  const controller = new AbortController(), cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
  const timeout = setTimeout(cancel, 65000);
  try {
    const response = await fetch('/api/eve/manufacturing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), cache: 'no-store', signal: controller.signal });
    if (response.status === 401) { await response.body?.cancel(); throw new ManufacturingResponseError('Sign in to the private app before loading manufacturing data.', 401); }
    const length = response.headers.get('content-length'); if (length && Number(length) > 2 * 1024 * 1024) { await response.body?.cancel(); throw new ManufacturingResponseError('The manufacturing response exceeded the display limit.'); }
    const reader = response.body?.getReader(); if (!reader) throw new ManufacturingResponseError('Manufacturing returned an unreadable response.');
    const decoder = new TextDecoder('utf-8', { fatal: true }); let body = '', bytes = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new ManufacturingResponseError('The manufacturing response exceeded the display limit.'); } body += decoder.decode(part.value, { stream: true }); } body += decoder.decode(); }
    finally { reader.releaseLock(); }
    let value: unknown; try { value = JSON.parse(body); } catch { throw new ManufacturingResponseError('Manufacturing returned an unreadable response.'); }
    if (!response.ok) throw new ManufacturingResponseError(record(value) && typeof value.error === 'string' && value.error.length <= 512 ? value.error : 'Manufacturing could not be loaded. Try again.', response.status);
    if (controller.signal.aborted) throw new ManufacturingResponseError('Manufacturing request cancelled.');
    return manufacturingResponse(value, request);
  } catch (error) {
    if (controller.signal.aborted) throw new ManufacturingResponseError(signal.aborted ? 'Manufacturing request cancelled.' : 'Manufacturing took too long. Reduce the selection and try again.');
    if (error instanceof ManufacturingResponseError) throw error;
    throw new ManufacturingResponseError('Could not reach the manufacturing service. Try again.');
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', cancel); }
}
