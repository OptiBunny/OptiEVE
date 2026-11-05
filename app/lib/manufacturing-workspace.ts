import { EveError, listConnections, readCharacterData, readCorporationData } from './eve';
import { searchManufacturingItems, readManufacturingCatalogStatus, findPublishedManufacturingItem, ManufacturingCatalogError } from './manufacturing-catalog';
import { assessManufacturing, validateManufacturingAssessmentInput, manufacturingAbortable, manufacturingExpiryTime, manufacturingPrivateExpiry, type ManufacturingAssessment } from './manufacturing-assessment';
import { compareManufacturing, planManufacturing, validateManufacturingPlanningInput } from './manufacturing-planning';
import { ManufacturingInputError } from './manufacturing-estimate';
import { ManufacturingMarketError } from './manufacturing-market';
import type { ManufacturingCard, ManufacturingContext, ManufacturingJob, ManufacturingResponse } from './manufacturing-types';

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const invalid = (): never => { throw new EveError('Choose a supported, bounded manufacturing operation.'); };
function only(value: Record<string, unknown>, keys: string[]) { if (Object.keys(value).some(key => !keys.includes(key))) invalid(); }
function contextOf(input: Record<string, unknown>): ManufacturingContext {
  const { blueprintTypeId, blueprintSource, blueprintItemId, blueprintPage, plan, ...context } = input;
  void blueprintTypeId; void blueprintSource; void blueprintItemId; void blueprintPage; void plan;
  return structuredClone(context) as ManufacturingContext;
}

/** Project trusted server calculations; no raw account rows or provider text. */
export function manufacturingCard(key: string, job: Pick<ManufacturingJob, 'blueprintTypeId' | 'plan'>, value: ManufacturingAssessment): ManufacturingCard {
  const e = value.estimate;
  return {
    key, blueprintTypeId: job.blueprintTypeId, name: findPublishedManufacturingItem(job.blueprintTypeId)?.name ?? 'Published blueprint',
    productName: e.requirements.product.name, runs: job.plan.runs, outputQuantity: e.requirements.product.quantity,
    readiness: e.eligibility.readiness === 'blocked' ? 'blocked' : e.eligibility.readiness === 'conditional' ? 'conditional' : 'unconfirmed', availableWalletISK: e.eligibility.wallet.availableISK,
    cashRequiredISK: e.costs.cashRequiredISK, economicCostISK: e.costs.economicCostISK,
    profitISK: e.instantSale.economicProfitISK, listedProfitISK: e.listedSale?.economicProfitISK ?? null,
    affordable: e.eligibility.wallet.instantScenarioAffordable, recipeCurrent: value.currentRecipeVerified,
    stockCoverage: value.stockCoverage, ownOrdersComplete: value.ownOrdersComplete,
    materials: e.materials.map(row => ({ typeId: row.typeId, name: row.name, requiredQuantity: row.requiredQuantity, ownedQuantity: row.ownedAvailableQuantity, usedQuantity: row.ownedUsedQuantity, missingQuantity: row.missingQuantity, buyISK: row.additionalPurchaseISK })),
    reasons: [...new Set([...value.conditions, ...e.reasons, ...value.limitations])].slice(0, 150),
    freshness: value.privateSources.map(row => ({ label: `${row.entity} ${row.dataset}${row.page === null ? '' : ` page ${row.page}`}`, status: row.freshness, cacheExpires: row.cacheExpires })),
  };
}

type Dependencies = {
  connections: typeof listConnections; character: typeof readCharacterData; corporation: typeof readCorporationData;
  assess: typeof assessManufacturing; compare: typeof compareManufacturing; plan: typeof planManufacturing;
  catalog: typeof readManufacturingCatalogStatus; now: () => number;
};
export function createManufacturingWorkspace(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = { connections: listConnections, character: readCharacterData, corporation: readCorporationData, assess: assessManufacturing, compare: compareManufacturing, plan: planManufacturing, catalog: readManufacturingCatalogStatus, now: Date.now, ...overrides };
  return async (user: string, raw: unknown, options: { signal?: AbortSignal } = {}): Promise<ManufacturingResponse> => {
    if (!user) throw new EveError('Sign in to the private connector first.', 401);
    if (!record(raw) || typeof raw.operation !== 'string') return invalid();
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000);
    signal.throwIfAborted();
    const at = () => new Date(deps.now()).toISOString();
    try {
      switch (raw.operation) {
        case 'search': {
          only(raw, ['operation', 'query', 'limit', 'offset']);
          const result = searchManufacturingItems({ query: raw.query, ...(raw.limit === undefined ? {} : { limit: raw.limit }), ...(raw.offset === undefined ? {} : { offset: raw.offset }), manufacturableOnly: true });
          return { operation: 'search', generatedAt: at(), query: result.query, items: result.items.map(item => ({ typeId: item.typeId, name: item.name, blueprintTypeIds: item.manufacturingBlueprintTypeIds })), nextOffset: result.nextOffset, totalMatches: result.totalMatches };
        }
        case 'catalog': {
          only(raw, ['operation']);
          const value = await manufacturingAbortable(() => deps.catalog({ signal }), signal);
          return { operation: 'catalog', generatedAt: at(), status: value.status as 'current' | 'update_required' | 'unverified', pinnedBuild: value.pinned.buildNumber, latestBuild: value.latest?.buildNumber ?? null, message: value.message };
        }
        case 'blueprints': {
          only(raw, ['operation', 'characterId', 'resourceEntity', 'page']);
          if (!integer(raw.characterId) || !integer(raw.page, 1, 500) || !['character', 'corporation'].includes(raw.resourceEntity as string)) return invalid();
          const characterId = raw.characterId, entity = raw.resourceEntity as 'character' | 'corporation', page = raw.page;
          if (!(await manufacturingAbortable(() => deps.connections(user), signal)).some(c => c.characterId === characterId)) throw new EveError('Choose an owned connected manufacturing character.', 404);
          const value: unknown = await manufacturingAbortable<unknown>(() => deps[entity](user, { characterId, dataset: 'blueprints', parameters: { page } }, signal), signal);
          if (!record(value) || value.characterId !== characterId || value.dataset !== 'blueprints' || value.entity !== undefined && value.entity !== entity || entity === 'corporation' && !integer(value.corporationId) || !Array.isArray(value.data) || value.data.length > 10000 || !record(value.pagination) || value.pagination.kind !== 'page' || value.pagination.page !== page || !integer(value.pagination.pages, page, 500)) throw new EveError('Blueprint data failed ownership or page checks.', 502);
          const seen = new Set<number>();
          const items = value.data.map((row: unknown) => {
            if (!record(row) || !integer(row.item_id) || seen.has(row.item_id) || !integer(row.type_id) || !integer(row.material_efficiency, 0, 10) || !integer(row.quantity, -2) || row.quantity === 0 || !integer(row.runs, -1) || (row.quantity === -2 ? row.runs < 0 : row.runs !== -1)) throw new EveError('Blueprint data failed its shape checks.', 502);
            seen.add(row.item_id);
            return { itemId: row.item_id, typeId: row.type_id, name: findPublishedManufacturingItem(row.type_id)?.name ?? `Blueprint type ${row.type_id}`, kind: row.quantity === -2 ? 'copy' as const : 'original' as const, materialEfficiency: row.material_efficiency, remainingRuns: row.quantity === -2 ? row.runs : null };
          });
          const received = manufacturingExpiryTime(value.retrievedAt), expires = manufacturingPrivateExpiry(value, Math.min(deps.now(), received ?? deps.now())), expiry = manufacturingExpiryTime(expires);
          const fresh = expiry !== null && expiry > deps.now() && received !== null && received <= deps.now() + 60000;
          return { operation: 'blueprints', generatedAt: at(), characterId, resourceEntity: entity, page, pages: value.pagination.pages, coverage: fresh ? value.pagination.pages === 1 ? 'complete' : 'partial' : 'unknown', cacheExpires: expiry === null ? null : new Date(expiry).toISOString(), items };
        }
        case 'assess': {
          only(raw, ['operation', 'input']);
          const input = validateManufacturingAssessmentInput(raw.input);
          const value = await manufacturingAbortable(() => deps.assess(user, input, { signal }), signal);
          return { operation: 'assess', generatedAt: value.generatedAt, context: contextOf(input), assessment: manufacturingCard('selected', input, value) };
        }
        case 'compare': {
          only(raw, ['operation', 'input']);
          const input = validateManufacturingPlanningInput(raw.input);
          const value = await manufacturingAbortable(() => deps.compare(user, input, { signal }), signal);
          return { operation: 'compare', generatedAt: value.generatedAt, context: structuredClone(input.context), candidates: value.alternatives.map(row => manufacturingCard(row.key, input.jobs.find(job => job.key === row.key)!, row.assessment)), rankedKeys: value.alternatives.filter(row => row.rank !== null).sort((a, b) => a.rank! - b.rank!).map(row => row.key), conditions: value.conditions };
        }
        case 'plan': {
          only(raw, ['operation', 'input']);
          const input = validateManufacturingPlanningInput(raw.input);
          const value = await manufacturingAbortable(() => deps.plan(user, input, { signal }), signal);
          const jobs = value.jobs.map(row => {
            const card = manufacturingCard(row.key, input.jobs.find(job => job.key === row.key)!, row.assessment);
            const copy = row.copyRuns;
            card.reasons.unshift(copy.status === 'not-applicable' ? 'Verified original blueprint: sequential reuse is assumed; concurrent job slots are not established.' : `Blueprint copy allocation: ${copy.status}; requested ${copy.requested} runs, allocated ${copy.allocated ?? 'unknown'}, verified available ${copy.available ?? 'unknown'}.`);
            if (copy.overcommitted === true) card.readiness = 'blocked';
            return card;
          });
          return { operation: 'plan', generatedAt: value.generatedAt, context: structuredClone(input.context), jobs, shoppingList: value.shoppingList, outputs: value.outputs, totals: value.totals, readiness: value.readiness, conditions: [...value.conditions, ...value.limitations] };
        }
        default: return invalid();
      }
    } catch (error) {
      if (signal.aborted) throw new EveError('Manufacturing request cancelled or timed out. Reload when ready.', 408);
      if (error instanceof ManufacturingInputError || error instanceof ManufacturingCatalogError || error instanceof ManufacturingMarketError) throw new EveError(error.message.slice(0, 500));
      throw error;
    }
  };
}
export const readManufacturingWorkspace = createManufacturingWorkspace();
