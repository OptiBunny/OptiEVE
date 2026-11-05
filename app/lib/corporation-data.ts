// These optional grants are separate from the legacy corporation finance access.
// GET datasets and two documented asset lookup POSTs only; no game-state mutation.
export const corporationReadFeatures = [
  { id: 'contracts', label: 'Corporation contracts', scope: 'esi-contracts.read_corporation_contracts.v1', description: 'Review corporation contracts. EVE controls which records the character may access.' },
  { id: 'industry', label: 'Corporation industry', scope: 'esi-industry.read_corporation_jobs.v1', description: 'Review corporation industry jobs. Requires the Factory Manager role in EVE.' },
  { id: 'projects', label: 'Corporation projects', scope: 'esi-corporations.read_projects.v1', description: 'Review active corporation projects. Does not read contributor lists.' },
  { id: 'blueprints', label: 'Corporation blueprints', scope: 'esi-corporations.read_blueprints.v1', description: 'Review the corporation blueprint library. Requires the Director role in EVE; includes private industrial inventory.' },
  { id: 'facilities', label: 'Corporation facilities', scope: 'esi-corporations.read_facilities.v1', description: 'Review corporation industry facility IDs and locations. Requires the Factory Manager role in EVE.' },
  { id: 'structures', label: 'Corporation structures', scope: 'esi-corporations.read_structures.v1', description: 'Review structure state, reported fuel expiry and services. Requires the Station Manager role in EVE.' },
  { id: 'extractions', label: 'Corporation extraction schedules', scope: 'esi-industry.read_corporation_mining.v1', description: 'Review moon extraction arrival and natural fracture timers. Requires the Station Manager role in EVE. Does not read mining observers or ledgers.' },
  { id: 'freelance', label: 'Corporation freelance jobs', scope: 'esi-corporations.read_freelance_jobs.v1', description: 'Review freelance job progress and reserved rewards. Requires the Project Manager role in EVE. Does not read participant lists.' },
] as const;
export type CorporationFeature = typeof corporationReadFeatures[number]['id'];
export class CorporationArgumentError extends Error {}
const fail = (message: string): never => { throw new CorporationArgumentError(message); };
const record = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
};
const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const projectIdPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const corporationDatasets = {
  assets: { label: 'Corporation assets', path: '/assets', scope: 'esi-assets.read_corporation_assets.v1', pagination: 'page', resultType: 'array', requiredParameters: [], optionalParameters: ['page'] },
  asset_names: { label: 'Corporation asset names', path: '/assets/names', scope: 'esi-assets.read_corporation_assets.v1', method: 'POST', pagination: 'none', resultType: 'array', requiredParameters: ['itemIds'], optionalParameters: [] },
  asset_locations: { label: 'Corporation asset coordinates', path: '/assets/locations', scope: 'esi-assets.read_corporation_assets.v1', method: 'POST', pagination: 'none', resultType: 'array', requiredParameters: ['itemIds'], optionalParameters: [] },
  wallet_balances: { label: 'Corporation wallet balances', path: '/wallets', scope: 'esi-wallet.read_corporation_wallets.v1', pagination: 'none', resultType: 'array', requiredParameters: [], optionalParameters: [] },
  order_history: { label: 'Corporation order history', path: '/orders/history', scope: 'esi-markets.read_corporation_orders.v1', pagination: 'page', resultType: 'array', requiredParameters: [], optionalParameters: ['page'] },
  contracts: { label: 'Corporation contracts', path: '/contracts', scope: corporationReadFeatures[0].scope, pagination: 'page', resultType: 'array', requiredParameters: [], optionalParameters: ['page'] },
  contract_items: { label: 'Corporation contract items', path: '/contracts/{contract_id}/items', scope: corporationReadFeatures[0].scope, pagination: 'none', resultType: 'array', requiredParameters: ['contractId'], optionalParameters: [] },
  contract_bids: { label: 'Corporation contract bids', path: '/contracts/{contract_id}/bids', scope: corporationReadFeatures[0].scope, pagination: 'page', resultType: 'array', requiredParameters: ['contractId'], optionalParameters: ['page'] },
  industry_jobs: { label: 'Corporation industry jobs', path: '/industry/jobs', scope: corporationReadFeatures[1].scope, pagination: 'page', resultType: 'array', requiredParameters: [], optionalParameters: ['page', 'includeCompleted'] },
  projects: { label: 'Corporation projects', path: '/projects', scope: corporationReadFeatures[2].scope, pagination: 'cursor', resultType: 'object', requiredParameters: [], optionalParameters: ['before', 'after', 'limit', 'state'] },
  project: { label: 'Corporation project detail', path: '/projects/{project_id}', scope: corporationReadFeatures[2].scope, pagination: 'none', resultType: 'object', requiredParameters: ['projectId'], optionalParameters: [] },
  project_contribution: { label: 'Your corporation project contribution', path: '/projects/{project_id}/contribution/{character_id}', scope: corporationReadFeatures[2].scope, pagination: 'none', resultType: 'object', requiredParameters: ['projectId'], optionalParameters: [] },
  blueprints: { label: 'Corporation blueprints', path: '/blueprints', scope: corporationReadFeatures[3].scope, pagination: 'page', resultType: 'array', requiredParameters: [], optionalParameters: ['page'] },
  facilities: { label: 'Corporation facilities', path: '/facilities', scope: corporationReadFeatures[4].scope, pagination: 'none', resultType: 'array', requiredParameters: [], optionalParameters: [] },
  structures: { label: 'Corporation structures', path: '/structures', scope: corporationReadFeatures[5].scope, pagination: 'page', resultType: 'array', requiredParameters: [], optionalParameters: ['page'] },
  // This ESI route uses the singular root. Only this fixed catalog entry may select it.
  mining_extractions: { label: 'Corporation extraction schedules', pathRoot: 'corporation', path: '/mining/extractions', scope: corporationReadFeatures[6].scope, pagination: 'page', resultType: 'array', requiredParameters: [], optionalParameters: ['page'] },
  freelance_jobs: { label: 'Corporation freelance jobs', path: '/freelance-jobs', scope: corporationReadFeatures[7].scope, pagination: 'cursor', resultType: 'object', requiredParameters: [], optionalParameters: ['before', 'after', 'limit'] },
} as const;
export const corporationDatasetInfo = Object.entries(corporationDatasets).map(([dataset, definition]) => ({ dataset, label: definition.label, scope: definition.scope, pagination: definition.pagination, requiredParameters: [...definition.requiredParameters], optionalParameters: [...definition.optionalParameters] }));
export type CorporationReadArgs = { characterId: number; dataset: string; parameters?: Record<string, unknown> };

export function selectedCorporationScopes(features: unknown = []): string[] {
  if (!Array.isArray(features) || features.length > corporationReadFeatures.length ||
      !features.every(value => typeof value === 'string' && corporationReadFeatures.some(feature => feature.id === value)) ||
      new Set(features).size !== features.length) return fail('Choose only the supported optional corporation read features.');
  return corporationReadFeatures.filter(feature => features.includes(feature.id)).map(feature => feature.scope);
}

// Validate before looking up tokens, refreshing, or sending any network request.
export function buildCorporationRequest(args: CorporationReadArgs) {
  if (!record(args) || !Object.hasOwn(args, 'characterId') || !Object.hasOwn(args, 'dataset') || !positiveId(args.characterId) || typeof args.dataset !== 'string' || !Object.hasOwn(corporationDatasets, args.dataset)) return fail('Choose a connected character and a supported corporation dataset.');
  if (Reflect.ownKeys(args).some(key => typeof key !== 'string' || !['characterId', 'dataset', 'parameters'].includes(key))) return fail('Unexpected corporation-read argument. Supply dataset-specific options inside parameters.');
  const dataset = corporationDatasets[args.dataset as keyof typeof corporationDatasets];
  const parameters = args.parameters === undefined ? {} : args.parameters;
  if (!record(parameters)) return fail('parameters must be an object.');
  const accepted: readonly string[] = [...dataset.requiredParameters, ...dataset.optionalParameters];
  if (Reflect.ownKeys(parameters).some(key => typeof key !== 'string' || !accepted.includes(key))) return fail('This corporation dataset does not accept one of the supplied parameters.');
  for (const key of dataset.requiredParameters) if (!Object.hasOwn(parameters, key)) return fail(`Missing required ${key} parameter.`);
  let body: number[] | undefined;
  if (accepted.includes('itemIds')) {
    const ids = parameters.itemIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 1000 || !Array.from(ids).every(positiveId) || new Set(ids).size !== ids.length) return fail('itemIds must contain 1–1000 unique positive safe integers.');
    body = [...ids] as number[];
  }
  let path: string = dataset.path;
  if (accepted.includes('contractId')) {
    if (!positiveId(parameters.contractId)) return fail('contractId must be a positive safe integer.');
    path = path.replace('{contract_id}', String(parameters.contractId));
  }
  if (accepted.includes('projectId')) {
    if (typeof parameters.projectId !== 'string' || parameters.projectId.length !== 36 || !projectIdPattern.test(parameters.projectId)) return fail('projectId must be a UUID.');
    path = path.replace('{project_id}', parameters.projectId.toLowerCase());
  }
  // Own contribution only: no independently supplied target character is accepted.
  path = path.replace('{character_id}', String(args.characterId));
  const query = new URLSearchParams();
  const page = parameters.page === undefined ? 1 : parameters.page;
  if (!positiveId(page) || page > 500) return fail('Page must be 1–500.');
  if (dataset.pagination === 'page') query.set('page', String(page));
  if (parameters.includeCompleted !== undefined) {
    if (typeof parameters.includeCompleted !== 'boolean') return fail('includeCompleted must be a boolean.');
    query.set('include_completed', String(parameters.includeCompleted));
  }
  if (parameters.before !== undefined && parameters.after !== undefined) return fail('Use either after or before, not both.');
  for (const key of ['before', 'after'] as const) {
    const cursor = parameters[key];
    if (cursor === undefined) continue;
    if (typeof cursor !== 'string' || !cursor.length || cursor.length > 512 || /[\x00-\x20\x7f]/.test(cursor)) return fail(`Invalid ${key} cursor.`);
    query.set(key, cursor);
  }
  if (parameters.limit !== undefined) {
    if (!positiveId(parameters.limit) || parameters.limit < 10 || parameters.limit > 100) return fail('limit must be 10–100.');
    query.set('limit', String(parameters.limit));
  }
  if (parameters.state !== undefined) {
    if (parameters.state !== 'Active' && parameters.state !== 'All') return fail('Project state must be Active or All.');
    query.set('state', parameters.state);
  }
  const suffix = query.toString();
  return { dataset, path: path + (suffix ? `?${suffix}` : ''), method: 'method' in dataset ? dataset.method : 'GET' as const, page, body };
}

export const corporationReadInputSchema = {
  type: 'object', required: ['characterId', 'dataset'],
  properties: {
    characterId: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    dataset: { type: 'string', enum: Object.keys(corporationDatasets) },
    parameters: { type: 'object', properties: {
      itemIds: { type: 'array', minItems: 1, maxItems: 1000, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
      contractId: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      projectId: { type: 'string', format: 'uuid', minLength: 36, maxLength: 36, pattern: projectIdPattern.source },
      page: { type: 'integer', minimum: 1, maximum: 500 },
      includeCompleted: { type: 'boolean' },
      before: { type: 'string', minLength: 1, maxLength: 512 },
      after: { type: 'string', minLength: 1, maxLength: 512 },
      limit: { type: 'integer', minimum: 10, maximum: 100 },
      state: { type: 'string', enum: ['Active', 'All'] },
    }, additionalProperties: false },
  }, additionalProperties: false,
};
