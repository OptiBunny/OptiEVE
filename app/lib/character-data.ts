// Reviewed against CCP's https://esi.evetech.net/meta/openapi.json, 2026-10-31.
// This is an explicit read-only allowlist, never an arbitrary URL proxy.
type ParameterKind = 'id' | 'uuid' | 'page' | 'boolean' | 'ids' | 'labels' | 'search' | 'categories' | 'hash' | 'cursor' | 'limit';
type Parameter = { kind: ParameterKind; location: 'path' | 'query' | 'body'; name?: string; required?: boolean };
type Dataset = { label: string; path: string; scope: string | null; parameters?: Record<string, Parameter>; method?: 'POST'; pagination?: 'page' | 'transactions' | 'mail' | 'calendar' | 'cursor'; result: 'array' | 'object' | 'number'; public?: boolean };
const pathId = (name: string): Parameter => ({kind:'id',location:'path',name,required:true});
const pathUuid = (name: string): Parameter => ({kind:'uuid',location:'path',name,required:true});
const query = (kind: ParameterKind, name: string, required = false): Parameter => ({kind,location:'query',name,required});
const paged = {page:query('page','page')};
const cursor = {after:query('cursor','after'),before:query('cursor','before'),limit:query('limit','limit')};
const char = (path: string) => `/characters/{character_id}${path}`;
const read = (label: string, path: string, scope: string | null, result: Dataset['result'] = 'array', extra: Partial<Dataset> = {}): Dataset => ({label,path:char(path),scope,result,...extra});

export const characterDatasets: Record<string, Dataset> = {
  orders:read('Open market orders','/orders','esi-markets.read_character_orders.v1'),
  order_history:read('Market order history','/orders/history','esi-markets.read_character_orders.v1','array',{parameters:paged,pagination:'page'}),
  assets:read('Assets','/assets','esi-assets.read_assets.v1','array',{parameters:paged,pagination:'page'}),
  asset_names:read('Asset names','/assets/names','esi-assets.read_assets.v1','array',{method:'POST',parameters:{itemIds:{kind:'ids',location:'body',required:true}}}),
  asset_locations:read('Asset locations','/assets/locations','esi-assets.read_assets.v1','array',{method:'POST',parameters:{itemIds:{kind:'ids',location:'body',required:true}}}),
  wallet_balance:read('Wallet balance','/wallet','esi-wallet.read_character_wallet.v1','number'),
  wallet_journal:read('Wallet journal','/wallet/journal','esi-wallet.read_character_wallet.v1','array',{parameters:paged,pagination:'page'}),
  wallet_transactions:read('Wallet transactions','/wallet/transactions','esi-wallet.read_character_wallet.v1','array',{parameters:{fromId:query('id','from_id')},pagination:'transactions'}),
  skills:read('Skills','/skills','esi-skills.read_skills.v1','object'),
  attributes:read('Attributes','/attributes','esi-skills.read_skills.v1','object'),
  skill_queue:read('Skill queue','/skillqueue','esi-skills.read_skillqueue.v1'),
  clones:read('Clones','/clones','esi-clones.read_clones.v1','object'),
  implants:read('Active implants','/implants','esi-clones.read_implants.v1'),
  location:read('Current location','/location','esi-location.read_location.v1','object'),
  ship:read('Current ship','/ship','esi-location.read_ship_type.v1','object'),
  online:read('Online status','/online','esi-location.read_online.v1','object'),
  fatigue:read('Jump fatigue','/fatigue','esi-characters.read_fatigue.v1','object'),
  fittings:read('Saved fittings','/fittings','esi-fittings.read_fittings.v1'),
  blueprints:read('Blueprints','/blueprints','esi-characters.read_blueprints.v1','array',{parameters:paged,pagination:'page'}),
  industry_jobs:read('Industry jobs','/industry/jobs','esi-industry.read_character_jobs.v1','array',{parameters:{includeCompleted:query('boolean','include_completed')}}),
  mining:read('Mining ledger','/mining','esi-industry.read_character_mining.v1','array',{parameters:paged,pagination:'page'}),
  research:read('Research agents','/agents_research','esi-characters.read_agents_research.v1'),
  planets:read('Planetary colonies','/planets','esi-planets.manage_planets.v1'),
  planet:read('Planetary colony layout','/planets/{planet_id}','esi-planets.manage_planets.v1','object',{parameters:{planetId:pathId('planet_id')}}),
  contracts:read('Contracts','/contracts','esi-contracts.read_character_contracts.v1','array',{parameters:paged,pagination:'page'}),
  contract_items:read('Contract items','/contracts/{contract_id}/items','esi-contracts.read_character_contracts.v1','array',{parameters:{contractId:pathId('contract_id')}}),
  contract_bids:read('Contract bids','/contracts/{contract_id}/bids','esi-contracts.read_character_contracts.v1','array',{parameters:{contractId:pathId('contract_id')}}),
  contacts:read('Contacts','/contacts','esi-characters.read_contacts.v1','array',{parameters:paged,pagination:'page'}),
  contact_labels:read('Contact labels','/contacts/labels','esi-characters.read_contacts.v1'),
  cspa_cost:read('CSPA communication cost estimate','/cspa','esi-characters.read_contacts.v1','number',{method:'POST',parameters:{recipientIds:{kind:'ids',location:'body',required:true}}}),
  standings:read('Standings','/standings','esi-characters.read_standings.v1'),
  loyalty_points:read('Loyalty points','/loyalty/points','esi-characters.read_loyalty.v1'),
  mail:read('Mail headers','/mail','esi-mail.read_mail.v1','array',{parameters:{beforeId:query('id','last_mail_id'),labels:query('labels','labels')},pagination:'mail'}),
  mail_body:read('Mail body','/mail/{mail_id}','esi-mail.read_mail.v1','object',{parameters:{mailId:pathId('mail_id')}}),
  mail_labels:read('Mail labels and unread counts','/mail/labels','esi-mail.read_mail.v1','object'),
  mailing_lists:read('Mailing list subscriptions','/mail/lists','esi-mail.read_mail.v1'),
  notifications:read('Notifications','/notifications','esi-characters.read_notifications.v1'),
  contact_notifications:read('Contact notifications','/notifications/contacts','esi-characters.read_notifications.v1'),
  calendar:read('Calendar events','/calendar','esi-calendar.read_calendar_events.v1','array',{parameters:{fromEvent:query('id','from_event')},pagination:'calendar'}),
  calendar_event:read('Calendar event','/calendar/{event_id}','esi-calendar.read_calendar_events.v1','object',{parameters:{eventId:pathId('event_id')}}),
  calendar_attendees:read('Calendar attendees','/calendar/{event_id}/attendees','esi-calendar.read_calendar_events.v1','array',{parameters:{eventId:pathId('event_id')}}),
  killmails:read('Recent kills and losses','/killmails/recent','esi-killmails.read_killmails.v1','array',{parameters:paged,pagination:'page'}),
  killmail:read('Killmail details','','esi-killmails.read_killmails.v1','object',{path:'/killmails/{killmail_id}/{killmail_hash}',public:true,parameters:{killmailId:pathId('killmail_id'),killmailHash:{kind:'hash',location:'path',name:'killmail_hash',required:true}}}),
  faction_warfare:read('Faction warfare statistics','/fw/stats','esi-characters.read_fw_stats.v1','object'),
  medals:read('Medals','/medals','esi-characters.read_medals.v1'),
  roles:read('Character corporation roles','/roles','esi-characters.read_corporation_roles.v1','object'),
  titles:read('Character corporation titles','/titles','esi-characters.read_titles.v1'),
  fleet:read('Current fleet membership','/fleet','esi-fleets.read_fleet.v1','object'),
  fleet_info:read('Fleet information','','esi-fleets.read_fleet.v1','object',{path:'/fleets/{fleet_id}',parameters:{fleetId:pathId('fleet_id')}}),
  fleet_members:read('Fleet members','','esi-fleets.read_fleet.v1','array',{path:'/fleets/{fleet_id}/members',parameters:{fleetId:pathId('fleet_id')}}),
  fleet_wings:read('Fleet wings','','esi-fleets.read_fleet.v1','array',{path:'/fleets/{fleet_id}/wings',parameters:{fleetId:pathId('fleet_id')}}),
  search:read('Search accessible EVE entities','/search','esi-search.search_structures.v1','object',{parameters:{search:query('search','search',true),categories:query('categories','categories',true),strict:query('boolean','strict')}}),
  structure:read('Accessible structure information','','esi-universe.read_structures.v1','object',{path:'/universe/structures/{structure_id}',parameters:{structureId:pathId('structure_id')}}),
  structure_orders:read('Accessible structure market orders','','esi-markets.structure_markets.v1','array',{path:'/markets/structures/{structure_id}',parameters:{structureId:pathId('structure_id'),...paged},pagination:'page'}),
  access_lists:read('Access lists','/access-lists','esi-access.read_lists.v1','object'),
  access_list:read('Access list details','/access-lists/{access_list_id}','esi-access.read_lists.v1','object',{parameters:{accessListId:pathId('access_list_id')}}),
  freelance_jobs:read('Freelance jobs','/freelance-jobs','esi-characters.read_freelance_jobs.v1','object'),
  freelance_participation:read('Freelance job participation','/freelance-jobs/{job_id}/participation','esi-characters.read_freelance_jobs.v1','object',{parameters:{jobId:pathUuid('job_id')}}),
  mercenary_operations:read('Mercenary tactical operations','/mercenary-tactical-operations','esi-activities.read_character.v1','object'),
  mercenary_operation:read('Mercenary tactical operation','/mercenary-tactical-operations/{operation_id}','esi-activities.read_character.v1','object',{parameters:{operationId:pathUuid('operation_id')}}),
  mercenary_dens:read('Mercenary dens','/structures/mercenary-dens','esi-structures.read_character.v1','object'),
  mercenary_den:read('Mercenary den details','/structures/mercenary-dens/{mercenary_den_id}','esi-structures.read_character.v1','object',{parameters:{denId:pathId('mercenary_den_id')}}),
  military_campaigns:read('Military campaign participation','/military-campaigns/objectives','esi.activity.char:read','object',{parameters:cursor,pagination:'cursor'}),
  military_objective:read('Military objective participation','/military-campaigns/objectives/{objective_id}','esi.activity.char:read','object',{parameters:{objectiveId:pathUuid('objective_id')}}),
  skinr_licenses:read('Owned SKINR licenses','/cosmetics/skinr','esi.cosmetic.char:read','object'),
  skinr_components:read('Owned SKINR components','/cosmetics/skinr/components','esi.cosmetic.char:read','object'),
  skinr_listings:read('Paragon Hub SKINR listings','/paragon-hub/skinr','esi.cosmetic.char:read','object',{parameters:cursor,pagination:'cursor'}),
};

// Preserve the first three legacy scopes for existing read_private_data clients.
export const characterReadScopes = [...new Set(['esi-markets.read_character_orders.v1','esi-assets.read_assets.v1','esi-wallet.read_character_wallet.v1',...Object.values(characterDatasets).map(d=>d.scope).filter((s):s is string=>!!s)])];
export const characterDatasetInfo = Object.entries(characterDatasets).map(([dataset,d])=>({dataset,label:d.label,scope:d.scope,requiredParameters:Object.entries(d.parameters??{}).filter(([,p])=>p.required).map(([key])=>key),optionalParameters:Object.entries(d.parameters??{}).filter(([,p])=>!p.required).map(([key])=>key),pagination:d.pagination??'none'}));
export type CharacterReadArgs = {characterId:number;dataset:string;parameters?:Record<string,unknown>};
export class CharacterArgumentError extends Error {}
const fail = (message:string):never => {throw new CharacterArgumentError(message);};
function positiveId(value:unknown){return typeof value==='number'&&Number.isSafeInteger(value)&&value>0;}
const searchCategories=['agent','alliance','character','constellation','corporation','faction','inventory_type','region','solar_system','station','structure'];
function validate(key:string,value:unknown,kind:ParameterKind):string|number|boolean|number[]|string[]{
  switch(kind){
    case 'id':if(positiveId(value))return value as number;break;
    case 'page':if(positiveId(value)&&Number(value)<=500)return value as number;break;
    case 'limit':if(positiveId(value)&&Number(value)>=10&&Number(value)<=100)return value as number;break;
    case 'boolean':if(typeof value==='boolean')return value;break;
    case 'uuid':if(typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))return value;break;
    case 'hash':if(typeof value==='string'&&/^[0-9a-f]{40}$/i.test(value))return value;break;
    case 'cursor':if(typeof value==='string'&&value.length>=1&&value.length<=512&&!/[\x00-\x20\x7f]/.test(value))return value;break;
    case 'search':if(typeof value==='string'&&value.trim().length>=3&&value.length<=200&&!/[\x00-\x1f\x7f]/.test(value))return value;break;
    case 'ids':case 'labels':{
      const max=kind==='labels'?25:key==='recipientIds'?100:1000;
      if(Array.isArray(value)&&value.length>=1&&value.length<=max&&value.every(positiveId)&&new Set(value).size===value.length)return value as number[];break;
    }
    case 'categories':if(Array.isArray(value)&&value.length>=1&&value.length<=11&&value.every(v=>typeof v==='string'&&searchCategories.includes(v))&&new Set(value).size===value.length)return value as string[];break;
  }
  return fail(`Invalid ${key} parameter for this dataset.`);
}
export function buildCharacterRequest(args:CharacterReadArgs){
  if(!args||typeof args!=='object'||Array.isArray(args)||!positiveId(args.characterId)||typeof args.dataset!=='string'||!Object.hasOwn(characterDatasets,args.dataset))return fail('Choose a connected character and a supported character dataset.');
  if(Object.keys(args).some(k=>!['characterId','dataset','parameters'].includes(k)))return fail('Unexpected character-read argument. Supply dataset-specific options inside parameters.');
  const dataset=characterDatasets[args.dataset],parameters=args.parameters===undefined?{}:args.parameters;
  if(typeof parameters!=='object'||parameters===null||Array.isArray(parameters))return fail('parameters must be an object.');
  const specs=dataset.parameters??{};
  if(Object.keys(parameters).some(k=>!Object.hasOwn(specs,k)))return fail('This dataset does not accept one of the supplied parameters.');
  if(parameters.after!==undefined&&parameters.before!==undefined)return fail('Use either after or before, not both.');
  let path=dataset.path.replace('{character_id}',String(args.characterId));
  const queryValues=new URLSearchParams();let body:number[]|undefined;
  for(const [key,spec]of Object.entries(specs)){
    const input=parameters[key];if(input===undefined){if(spec.required)return fail(`Supply ${key} for this dataset.`);continue;}
    const value=validate(key,input,spec.kind);
    if(spec.location==='path')path=path.replace(`{${spec.name}}`,encodeURIComponent(String(value)));
    else if(spec.location==='query')queryValues.set(spec.name!,Array.isArray(value)?value.join(','):String(value));
    else body=value as number[];
  }
  if(path.includes('{'))return fail('A required path parameter is missing.');
  const queryString=queryValues.toString();
  return {dataset,path:path+(queryString?`?${queryString}`:''),method:dataset.method??'GET',body,page:Number(parameters.page??1)};
}

const idSchema={type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER};
const parameterProperties:Record<string,unknown>={};
for(const d of Object.values(characterDatasets))for(const [key,p]of Object.entries(d.parameters??{})){
  parameterProperties[key]=p.kind==='id'?idSchema:p.kind==='page'?{...idSchema,maximum:500}:p.kind==='limit'?{type:'integer',minimum:10,maximum:100}:p.kind==='boolean'?{type:'boolean'}:p.kind==='ids'||p.kind==='labels'?{type:'array',items:idSchema,minItems:1,maxItems:p.kind==='labels'?25:key==='recipientIds'?100:1000,uniqueItems:true}:p.kind==='categories'?{type:'array',items:{type:'string',enum:searchCategories},minItems:1,maxItems:11,uniqueItems:true}:p.kind==='uuid'?{type:'string',pattern:'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'}:p.kind==='hash'?{type:'string',pattern:'^[0-9a-fA-F]{40}$'}:{type:'string',minLength:p.kind==='search'?3:1,maxLength:p.kind==='search'?200:512};
}
export const characterReadInputSchema={type:'object',required:['characterId','dataset'],properties:{characterId:idSchema,dataset:{type:'string',enum:Object.keys(characterDatasets)},parameters:{type:'object',properties:parameterProperties,additionalProperties:false}},additionalProperties:false};
