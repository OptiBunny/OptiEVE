import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import assert from 'node:assert/strict';
const code=ts.transpileModule(readFileSync('app/lib/eve.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const catalogModule={exports:{}};
vm.runInNewContext(ts.transpileModule(readFileSync('app/lib/character-data.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module:catalogModule,exports:catalogModule.exports,URLSearchParams});
const catalog=catalogModule.exports;
const corporationModule={exports:{}};
vm.runInNewContext(ts.transpileModule(readFileSync('app/lib/corporation-data.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module:corporationModule,exports:corporationModule.exports,URLSearchParams});
const requestBodyModule={exports:{}};
vm.runInNewContext(ts.transpileModule(readFileSync('app/lib/request-body.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module:requestBodyModule,exports:requestBodyModule.exports,TextDecoder,Uint8Array});
const sqlite=new DatabaseSync(':memory:');
sqlite.exec(`CREATE TABLE eve_settings(user_id TEXT PRIMARY KEY,client_id TEXT NOT NULL);CREATE TABLE eve_oauth_states(state_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,encrypted TEXT NOT NULL,expires INTEGER NOT NULL);CREATE TABLE eve_connections(user_id TEXT NOT NULL,character_id INTEGER NOT NULL,name TEXT NOT NULL,corporation_id INTEGER NOT NULL,scopes TEXT NOT NULL,encrypted TEXT NOT NULL,expires INTEGER NOT NULL,refresh_lock TEXT,refresh_until INTEGER,PRIMARY KEY(user_id,character_id));`);
const dbHooks={afterFirst:null,beforeRun:null,afterRun:null};
const env={EVE_SITE_ORIGIN:'https://example.chatgpt.site',EVE_TOKEN_KEY:Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64'),DB:{prepare(sql){return {bind(...args){return {async first(){const row=sqlite.prepare(sql).get(...args)||null;await dbHooks.afterFirst?.(sql,args,row);return row;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){await dbHooks.beforeRun?.(sql,args);const result={meta:sqlite.prepare(sql).run(...args)};await dbHooks.afterRun?.(sql,args,result);return result;}};}};}}};
const clientId='0123456789abcdef0123456789abcdef';
const rsa=await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk=await webcrypto.subtle.exportKey('jwk',rsa.publicKey);jwk.kid='test-key';
const charScopes=catalog.characterReadScopes;
async function jwt(overrides={},headOverrides={}){const h=Buffer.from(JSON.stringify({alg:'RS256',kid:'test-key',...headOverrides})).toString('base64url');const c=Buffer.from(JSON.stringify({sub:'CHARACTER:EVE:12345',name:'Pilot',owner:'owner-one',iss:'https://login.eveonline.com',aud:[clientId,'EVE Online'],exp:Math.floor(Date.now()/1000)+3600,scp:charScopes,...overrides})).toString('base64url');return `${h}.${c}.${Buffer.from(await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',rsa.privateKey,new TextEncoder().encode(`${h}.${c}`))).toString('base64url')}`;}
let authCodeUses=0,refreshUses=0,refreshGate=null,refreshStarted=null;
const esiRequests=[];
const fetchOverrides=new Map();
const fetcher=async(url,init)=>{
 assert.equal(init?.redirect,'manual','Workers supports manual redirects; never follow EVE redirects with credentials.');
 if(fetchOverrides.has(url)){const value=fetchOverrides.get(url);if(value instanceof Error)throw value;return typeof value==='function'?await value(url,init):value.clone();}
 if(url==='https://login.eveonline.com/oauth/jwks')return Response.json({keys:[jwk]});
 if(url==='https://login.eveonline.com/v2/oauth/token'){
  const body=new URLSearchParams(init.body);if(body.get('grant_type')==='authorization_code'){authCodeUses++;assert.equal(body.get('client_id'),clientId);assert.equal(body.get('code_verifier').length,43);return Response.json({access_token:await jwt(),refresh_token:'refresh-one'});}
  refreshUses++;if(refreshStarted)refreshStarted();if(refreshGate)await refreshGate;return Response.json({access_token:await jwt(),refresh_token:'refresh-rotated'});
 }
 if(url.startsWith('https://esi.evetech.net'))esiRequests.push({url,method:init?.method??'GET',headers:init?.headers,body:init?.body});
 if(url==='https://esi.evetech.net/characters/12345')return Response.json({name:'Pilot',corporation_id:999});
 if(url==='https://esi.evetech.net/characters/12345/skills')return Response.json({skills:[{skill_id:3300,trained_skill_level:4}],total_sp:100000});
 if(url==='https://esi.evetech.net/characters/12345/assets/names')return Response.json([{item_id:123456,name:'Synthetic asset'}]);
 if(url==='https://esi.evetech.net/characters/12345/mail?last_mail_id=900')return Response.json([{mail_id:800},{mail_id:700}]);
 if(url==='https://esi.evetech.net/characters/12345/calendar?from_event=900')return Response.json([{event_id:950},{event_id:800}]);
 if(url==='https://esi.evetech.net/characters/12345/orders/history?page=2')return Response.json([{order_id:455}],{headers:{'x-pages':'3'}});
 if(url==='https://esi.evetech.net/characters/12345/military-campaigns/objectives?after=0&limit=10')return Response.json({objectives:[],cursor:{after:'next-cursor',before:'previous-cursor'}});
 if(url==='https://esi.evetech.net/characters/12345/wallet')return Response.json(1234.5);
 if(url==='https://esi.evetech.net/killmails/444/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')return Response.json({killmail_id:444});
 if(url.includes('/wallet/transactions'))return Response.json([{transaction_id:789,quantity:10}],{headers:{expires:new Date(Date.now()+60000).toUTCString()}});
 if(url.endsWith('/orders'))return Response.json([{order_id:456}]);
 throw new Error('Unexpected external request');
};
const fixtureModule={exports:{}};
const sandbox={module:fixtureModule,exports:fixtureModule.exports,require:n=>{if(n==='cloudflare:workers')return {env};if(n==='./character-data')return catalog;if(n==='./corporation-data')return corporationModule.exports;throw new Error(n);},crypto:webcrypto,fetch:fetcher,TextEncoder,TextDecoder,URL,URLSearchParams,Response,Request,AbortSignal,Uint8Array,atob,btoa,console};
vm.runInNewContext(code+'\nmodule.exports.test={encrypt,decrypt,verifyJwt};',sandbox);
const api=fixtureModule.exports;
const secret={secret:'private-token'},cipher=await api.test.encrypt(secret,'token:user-a:12345');
assert(!cipher.includes('private-token'));assert.equal((await api.test.decrypt(cipher,'token:user-a:12345')).secret,'private-token');
await assert.rejects(api.test.decrypt(cipher,'token:user-b:12345'),e=>e.status===401);
await assert.rejects(api.test.decrypt(cipher.slice(0,-5)+'AAAAA','token:user-a:12345'),e=>e.status===401);
assert.equal((await api.test.verifyJwt(await jwt(),clientId)).sub,'CHARACTER:EVE:12345');
const invalidSignature=(await jwt()).split('.');invalidSignature[2]=(invalidSignature[2][0]==='A'?'B':'A')+invalidSignature[2].slice(1);await assert.rejects(api.test.verifyJwt(invalidSignature.join('.'),clientId));
const validKey=env.EVE_TOKEN_KEY;
try{
 for(const badKey of [undefined,'','invalid-key',Buffer.alloc(31).toString('base64')]){
  if(badKey===undefined)delete env.EVE_TOKEN_KEY;else env.EVE_TOKEN_KEY=badKey;
  await assert.rejects(api.test.encrypt(secret,'token:user-a:12345'),e=>e.status===503);
  await assert.rejects(api.test.decrypt(cipher,'token:user-a:12345'),e=>e.status===503&&!e.message.includes('Reconnect'));
 }
}finally{env.EVE_TOKEN_KEY=validKey;}
assert.equal((await api.test.decrypt(cipher,'token:user-a:12345')).secret,'private-token');
for(const claims of [{aud:['other','EVE Online']},{iss:'https://attacker.example'},{exp:1},{sub:'CORPORATION:EVE:12345'}])await assert.rejects(api.test.verifyJwt(await jwt(claims),clientId));
await assert.rejects(api.test.verifyJwt(await jwt({}, {alg:'HS256'}),clientId));
for(const nbf of [null,false,true,'0',String(Math.floor(Date.now()/1000)),'invalid',{},[],[0]])await assert.rejects(api.test.verifyJwt(await jwt({nbf}),clientId),e=>e.status===401&&e.reason==='verification');
for(const nbf of [0,Date.now()/1000-10.5,Date.now()/1000+30])assert.equal((await api.test.verifyJwt(await jwt({nbf}),clientId)).sub,'CHARACTER:EVE:12345');
await assert.rejects(api.test.verifyJwt(await jwt({nbf:Date.now()/1000+120}),clientId),e=>e.status===401&&e.reason==='verification');
await api.saveConfig('user-a',clientId);
const begun=await api.startConnect('user-a',false),oauth=new URL(begun.url),state=oauth.searchParams.get('state');
assert.equal(oauth.searchParams.get('redirect_uri'),'https://example.chatgpt.site/eve/callback');assert.equal(oauth.searchParams.get('code_challenge_method'),'S256');
assert.equal(oauth.searchParams.get('scope').split(' ').length,39);assert(!oauth.searchParams.get('scope').includes('write_'));assert(!oauth.searchParams.get('scope').includes('send_mail'));
await assert.rejects(api.finishConnect('user-b','some-code',state));assert.equal(authCodeUses,0);
await api.finishConnect('user-a','some-code',state);assert.equal(authCodeUses,1);
await assert.rejects(api.finishConnect('user-a','some-code',state));assert.equal(authCodeUses,1);
const expiredState=new URL((await api.startConnect('user-a',false)).url).searchParams.get('state');sqlite.prepare('UPDATE eve_oauth_states SET expires=0').run();await assert.rejects(api.finishConnect('user-a','some-code',expiredState));assert.equal(authCodeUses,1);
assert.equal((await api.listConnections('user-a')).length,1);assert.equal((await api.listConnections('user-b')).length,0);
const status=JSON.stringify(await api.getStatus('user-a'));assert(!status.includes('refresh-one'));assert(!status.includes('accessToken'));
const beforeKeyFailure=sqlite.prepare('SELECT encrypted FROM eve_connections WHERE user_id=?').get('user-a').encrypted;
const requestsBeforeKeyFailure=esiRequests.length;
delete env.EVE_TOKEN_KEY;
try{await assert.rejects(api.readEve('user-a',{characterId:12345,entity:'character',dataset:'orders'}),e=>e.status===503&&!e.message.includes('Reconnect'));}finally{env.EVE_TOKEN_KEY=validKey;}
assert.equal(esiRequests.length,requestsBeforeKeyFailure);assert.equal(refreshUses,0);
assert.equal(sqlite.prepare('SELECT encrypted FROM eve_connections WHERE user_id=?').get('user-a').encrypted,beforeKeyFailure);
await assert.rejects(api.readEve('user-b',{characterId:12345,entity:'character',dataset:'orders'}));
const trans=await api.readEve('user-a',{characterId:12345,entity:'character',dataset:'wallet_transactions',fromId:1000});assert.equal(trans.nextFromId,789);assert(trans.source.endsWith('?from_id=1000'));
await assert.rejects(api.readEve('user-a',{characterId:12345,entity:'character',dataset:'wallet_transactions',page:2}));
await assert.rejects(api.readEve('user-a',{characterId:12345,entity:'corporation',dataset:'orders'}));
const skills=await api.readCharacterData('user-a',{characterId:12345,dataset:'skills'});assert.equal(skills.data.total_sp,100000);assert.equal(esiRequests.at(-1).method,'GET');assert(esiRequests.at(-1).headers.Authorization.startsWith('Bearer '));
assert.equal((await api.readCharacterData('user-a',{characterId:12345,dataset:'wallet_balance'})).data,1234.5);
await api.readCharacterData('user-a',{characterId:12345,dataset:'asset_names',parameters:{itemIds:[123456]}});assert.equal(esiRequests.at(-1).method,'POST');assert.equal(esiRequests.at(-1).body,'[123456]');
assert.equal((await api.readCharacterData('user-a',{characterId:12345,dataset:'mail',parameters:{beforeId:900}})).pagination.nextBeforeId,700);
assert.equal((await api.readCharacterData('user-a',{characterId:12345,dataset:'calendar',parameters:{fromEvent:900}})).pagination.nextFromEvent,800);
assert.equal((await api.readCharacterData('user-a',{characterId:12345,dataset:'order_history',parameters:{page:2}})).pagination.nextPage,3);
assert.equal((await api.readCharacterData('user-a',{characterId:12345,dataset:'military_campaigns',parameters:{after:'0',limit:10}})).pagination.after,'next-cursor');
await api.readCharacterData('user-a',{characterId:12345,dataset:'killmail',parameters:{killmailId:444,killmailHash:'a'.repeat(40)}});assert.equal(esiRequests.at(-1).headers.Authorization,undefined);
const callsBeforeRejections=esiRequests.length;
for(const args of [
 {characterId:12345,dataset:'__proto__'},
 {characterId:12345,dataset:'skills',url:'https://attacker.example'},
 {characterId:12345,dataset:'skills',parameters:{page:1}},
 {characterId:12345,dataset:'planet'},
 {characterId:12345,dataset:'planet',parameters:{planetId:'../wallet'}},
 {characterId:12345,dataset:'asset_names',parameters:{itemIds:[1,1]}},
 {characterId:12345,dataset:'asset_names',parameters:{itemIds:Array.from({length:1001},(_,i)=>i+1)}},
 {characterId:12345,dataset:'military_campaigns',parameters:{before:'0',after:'0'}},
 {characterId:12345,dataset:'freelance_participation',parameters:{jobId:'../../wallet'}},
 {characterId:12345,dataset:'search',parameters:{search:'abc',categories:['unknown']}},
 {characterId:12345,dataset:'order_history',parameters:{page:501}},
])await assert.rejects(api.readCharacterData('user-a',args),e=>e.status===400);
await assert.rejects(api.readCharacterData('user-b',{characterId:12345,dataset:'skills'}),e=>e.status===404);
sqlite.prepare('UPDATE eve_connections SET scopes=?,expires=0').run(JSON.stringify(['esi-markets.read_character_orders.v1']));
const refreshBeforeDenied=refreshUses;
await assert.rejects(api.readCharacterData('user-a',{characterId:12345,dataset:'skills'}),e=>e.status===403);
await assert.rejects(api.readEve('user-a',{characterId:12345,entity:'character',dataset:'assets'}),e=>e.status===403);
assert.equal(refreshUses,refreshBeforeDenied);assert.equal(esiRequests.length,callsBeforeRejections);
sqlite.prepare('UPDATE eve_connections SET scopes=?').run(JSON.stringify(charScopes));
sqlite.prepare('UPDATE eve_connections SET expires=0').run();
let release;refreshGate=new Promise(r=>release=r);const started=new Promise(r=>refreshStarted=r);
const first=api.readEve('user-a',{characterId:12345,entity:'character',dataset:'orders'});await started;
await assert.rejects(api.readEve('user-a',{characterId:12345,entity:'character',dataset:'orders'}),e=>e.status===409);
release();await first;assert.equal(refreshUses,1);
const saved=sqlite.prepare('SELECT encrypted FROM eve_connections').get();assert.equal((await api.test.decrypt(saved.encrypted,'token:user-a:12345')).refreshToken,'refresh-rotated');
assert.throws(()=>api.requireUser(new Request('https://example.chatgpt.site/api/eve/status')));
assert.throws(()=>api.checkOrigin(new Request('https://example.chatgpt.site/api/eve/config',{headers:{origin:'https://attacker.example'}})));
await api.disconnect('user-a',12345);assert.equal((await api.listConnections('user-a')).length,0);
for(const [endpoint,response,reason,http]of [
 ['https://login.eveonline.com/v2/oauth/token',new Response(null,{status:302,headers:{Location:'https://attacker.example/collect'}}),'token_request',302],
 ['https://login.eveonline.com/v2/oauth/token',Response.json({error:'private upstream details'},{status:400}),'token_request',400],
 ['https://login.eveonline.com/v2/oauth/token',Response.json({}),'token_response',undefined],
 ['https://esi.evetech.net/characters/12345',Response.json({error:'private profile details'},{status:503}),'profile_request',503],
 ['https://esi.evetech.net/characters/12345',Response.json({}),'profile_response',undefined],
 ]){
 const faultState=new URL((await api.startConnect('user-a',false)).url).searchParams.get('state');fetchOverrides.set(endpoint,response);
 await assert.rejects(api.finishConnect('user-a','synthetic-code',faultState),e=>e.reason===reason&&e.upstreamStatus===http&&!e.message.includes('private upstream details')&&!e.message.includes('private profile details'));
 fetchOverrides.clear();assert.equal((await api.listConnections('user-a')).length,0);
}
const callbackModule={exports:{}};let callbackFailure=null;
vm.runInNewContext(ts.transpileModule(readFileSync('app/eve/callback/route.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module:callbackModule,exports:callbackModule.exports,require:n=>{assert.equal(n,'../../lib/eve');return {...api,finishConnect:async()=>{if(callbackFailure)throw callbackFailure;}};},URL,Response});
const callbackRequest=new Request('https://example.chatgpt.site/eve/callback?code=secret-code&state=secret-state',{headers:{'oai-authenticated-user-id':'user-a'}});
for(const [error,reason]of [[new api.EveError('This sign-in expired or has already been used.'),'expired'],[new api.EveError('EVE sign-in could not be verified.',401),'verification'],[new api.EveError('EVE did not grant all requested read permissions. Please reconnect.',403),'permissions'],[new api.EveError('Private upstream details',502),'service'],[new Error('secret-code secret-state'),'service']]){
 callbackFailure=error;const r=await callbackModule.exports.GET(callbackRequest);assert.equal(r.status,303);assert.equal(r.headers.get('location'),`/?eve=failed&reason=${reason}`);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('referrer-policy'),'no-referrer');assert.equal(await r.text(),'');
}
callbackFailure=null;assert.equal((await callbackModule.exports.GET(callbackRequest)).headers.get('location'),'/?eve=connected');
assert.equal((await callbackModule.exports.GET(new Request('https://example.chatgpt.site/eve/callback?error=access_denied&error_description=secret-code',{headers:{'oai-authenticated-user-id':'user-a'}}))).headers.get('location'),'/?eve=cancelled');
callbackFailure=new api.EveError('secret-code secret-state',502,'token_request',400);assert.equal((await callbackModule.exports.GET(callbackRequest)).headers.get('location'),'/?eve=failed&reason=token_request&http=400');
callbackFailure=new api.EveError('secret-code secret-state',502,'secret-state',999999);assert.equal((await callbackModule.exports.GET(callbackRequest)).headers.get('location'),'/?eve=failed&reason=service');
const mcpModule={exports:{}};let mcpFetchCount=0;
vm.runInNewContext(ts.transpileModule(readFileSync('app/mcp/route.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module:mcpModule,exports:mcpModule.exports,require:n=>n==='../lib/eve'?api:n==='../lib/character-data'?catalog:n==='../lib/corporation-data'?corporationModule.exports:n==='../lib/request-body'?requestBodyModule.exports:n==='../lib/manufacturing-tools'?{manufacturingToolset:[],manufacturingInstructions:'Synthetic isolated EVE regression',callManufacturingTool:()=>{throw new Error('Manufacturing integration belongs to mcp-security tests.');}}:null,Request,Response,AbortSignal,TextEncoder,fetch:async(url,init)=>{mcpFetchCount++;assert.equal(init.redirect,'manual');return new Response(null,{status:302,headers:{Location:'https://attacker.example/collect'}});}});
const marketReply=await mcpModule.exports.POST(new Request('https://example.chatgpt.site/mcp',{method:'POST',headers:{'oai-authenticated-user-id':'user-a'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'public_market',arguments:{regionId:10000002,typeId:34}}})}));
const marketResult=(await marketReply.json()).result;assert.equal(marketResult.isError,true);assert(marketResult.content[0].text.includes('HTTP 302'));assert.equal(mcpFetchCount,1);assert(!marketResult.content[0].text.includes('attacker'));
// Force lifecycle interleavings without network calls, timers, or real credentials.
const tokenEndpoint='https://login.eveonline.com/v2/oauth/token';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const begin=async(user='user-a')=>new URL((await api.startConnect(user,false)).url).searchParams.get('state');
const connect=async(user='user-a')=>{await api.saveConfig(user,clientId);await api.finishConnect(user,'synthetic-code',await begin(user));};
const connection=()=>sqlite.prepare('SELECT * FROM eve_connections WHERE user_id=? AND character_id=?').get('user-a',12345);
const readOrders=()=>api.readEve('user-a',{characterId:12345,entity:'character',dataset:'orders'});
await connect();
await api.saveConfig('user-b',clientId);
const otherUserState=await begin('user-b');
const callbackReached=deferred(),callbackRelease=deferred();
fetchOverrides.set(tokenEndpoint,async()=>{callbackReached.resolve();await callbackRelease.promise;return Response.json({access_token:await jwt(),refresh_token:'synthetic-callback-refresh'});});
const pausedState=await begin();
const pausedCallback=api.finishConnect('user-a','synthetic-code',pausedState);
const pausedCallbackResult=assert.rejects(pausedCallback,e=>e.status===409);
await callbackReached.promise;
await assert.rejects(api.finishConnect('user-a','synthetic-replay',pausedState));
// Starting another flow must not delete the already claimed callback row.
const pendingState=await begin();
assert.equal(sqlite.prepare('SELECT count(*) AS n FROM eve_oauth_states WHERE user_id=?').get('user-a').n,2);
assert.equal(sqlite.prepare("SELECT count(*) AS n FROM eve_oauth_states WHERE user_id=? AND encrypted='' ").get('user-a').n,1);
await api.disconnect('user-a',12345);
assert.equal(connection(),undefined);
assert.equal(sqlite.prepare('SELECT count(*) AS n FROM eve_oauth_states WHERE user_id=?').get('user-a').n,0);
// An old callback's finally cleanup must not delete a new sign-in after disconnect.
const freshState=await begin();
callbackRelease.resolve();await pausedCallbackResult;
assert.equal(connection(),undefined);
assert.equal(sqlite.prepare('SELECT count(*) AS n FROM eve_oauth_states WHERE user_id=?').get('user-a').n,1);
fetchOverrides.clear();
await assert.rejects(api.finishConnect('user-a','synthetic-code',pendingState));
await api.finishConnect('user-a','synthetic-code',freshState);
assert(connection());
await api.finishConnect('user-b','synthetic-code',otherUserState);
assert.equal((await api.listConnections('user-b')).length,1);
await api.disconnect('user-a',12345);
assert.equal(connection(),undefined);
assert.equal((await api.listConnections('user-b')).length,1);

// Both callers read the same unclaimed state before either attempts its CAS.
const replayState=await begin(),bothReaders=deferred();let stateReaders=0,exchanges=0;
dbHooks.afterFirst=async(sql)=>{if(sql.startsWith('SELECT encrypted FROM eve_oauth_states')){if(++stateReaders===2)bothReaders.resolve();await bothReaders.promise;}};
fetchOverrides.set(tokenEndpoint,async()=>{exchanges++;return Response.json({access_token:await jwt(),refresh_token:'synthetic-replay-refresh'});});
const replayResults=await Promise.allSettled([api.finishConnect('user-a','synthetic-code',replayState),api.finishConnect('user-a','synthetic-code',replayState)]);
dbHooks.afterFirst=null;fetchOverrides.clear();
assert.equal(replayResults.filter(r=>r.status==='fulfilled').length,1);
assert.equal(replayResults.filter(r=>r.status==='rejected').length,1);
assert.equal(exchanges,1);
assert.equal(sqlite.prepare('SELECT count(*) AS n FROM eve_oauth_states WHERE user_id=?').get('user-a').n,0);

// Disconnect wins even after callback commit but before callback cleanup completes.
const committed=deferred(),returnCommit=deferred();
dbHooks.afterRun=async(sql)=>{if(sql.startsWith('INSERT INTO eve_connections')){committed.resolve();await returnCommit.promise;}};
const committedCallback=api.finishConnect('user-a','synthetic-code',await begin());
await committed.promise;assert(connection());
await api.disconnect('user-a',12345);assert.equal(connection(),undefined);
returnCommit.resolve();await committedCallback;dbHooks.afterRun=null;
assert.equal(connection(),undefined);

// Expiry while a callback is in flight must also prevent its final write.
const expiryReached=deferred(),expiryRelease=deferred();
fetchOverrides.set(tokenEndpoint,async()=>{expiryReached.resolve();await expiryRelease.promise;return Response.json({access_token:await jwt(),refresh_token:'synthetic-expiry-refresh'});});
const expiringCallback=api.finishConnect('user-a','synthetic-code',await begin());
const expiringResult=assert.rejects(expiringCallback,e=>e.status===409);
await expiryReached.promise;sqlite.prepare('UPDATE eve_oauth_states SET expires=0 WHERE user_id=?').run('user-a');
expiryRelease.resolve();await expiringResult;fetchOverrides.clear();assert.equal(connection(),undefined);

// Cleanup outages cannot resurrect a consumed claim or hide the original result.
dbHooks.beforeRun=async(sql)=>{if(sql.startsWith('DELETE FROM eve_oauth_states WHERE state_hash='))throw new Error('Synthetic cleanup outage');};
const cleanupState=await begin();await api.finishConnect('user-a','synthetic-code',cleanupState);assert(connection());
await assert.rejects(api.finishConnect('user-a','synthetic-replay',cleanupState));
assert.equal(sqlite.prepare("SELECT count(*) AS n FROM eve_oauth_states WHERE user_id=? AND encrypted='' ").get('user-a').n,1);
const failedCleanupState=await begin();
fetchOverrides.set(tokenEndpoint,Response.json({error:'invalid_grant',error_description:'synthetic confidential upstream detail'},{status:400}));
await assert.rejects(api.finishConnect('user-a','synthetic-code',failedCleanupState),e=>e.status===401&&e.reason==='token_request'&&!e.message.includes('confidential'));
await assert.rejects(api.finishConnect('user-a','synthetic-replay',failedCleanupState));
dbHooks.beforeRun=null;fetchOverrides.clear();
sqlite.prepare('UPDATE eve_oauth_states SET expires=0 WHERE user_id=?').run('user-a');
await begin();
assert.equal(sqlite.prepare("SELECT count(*) AS n FROM eve_oauth_states WHERE user_id=? AND encrypted='' ").get('user-a').n,0);
await api.disconnect('user-a',12345);

// Failed token responses must preserve the saved authorization and release its lock.
await connect();
const validAccess=await jwt();
for(const malformed of [null,[],{}, {access_token:''},{access_token:' '},{access_token:validAccess,refresh_token:''},{access_token:validAccess,refresh_token:' '},{access_token:validAccess,refresh_token:null},{access_token:validAccess,refresh_token:42}]){
 sqlite.prepare('UPDATE eve_connections SET expires=0 WHERE user_id=?').run('user-a');
 const before=connection();fetchOverrides.set(tokenEndpoint,Response.json(malformed));
 await assert.rejects(readOrders(),e=>e.status===502);
 const after=connection();assert.equal(after.encrypted,before.encrypted);assert.equal(after.scopes,before.scopes);assert.equal(after.expires,before.expires);assert.equal(after.refresh_lock,null);assert.equal(after.refresh_until,null);
}
fetchOverrides.set(tokenEndpoint,Response.json({error:'invalid_grant',error_description:'synthetic confidential upstream detail'},{status:400}));
await assert.rejects(readOrders(),e=>e.status===401&&e.upstreamStatus===400&&e.message.includes('Reconnect')&&!e.message.includes('confidential'));
assert.equal(connection().refresh_lock,null);
fetchOverrides.set(tokenEndpoint,Response.json({error:'temporarily_unavailable',error_description:'synthetic confidential upstream detail'},{status:400}));
await assert.rejects(readOrders(),e=>e.status===502&&!e.message.includes('confidential'));
fetchOverrides.set(tokenEndpoint,new Response('not-json',{status:400}));await assert.rejects(readOrders(),e=>e.status===502);
const beforeOmitted=await api.test.decrypt(connection().encrypted,'token:user-a:12345');
fetchOverrides.set(tokenEndpoint,Response.json({access_token:validAccess}));await readOrders();
assert.equal((await api.test.decrypt(connection().encrypted,'token:user-a:12345')).refreshToken,beforeOmitted.refreshToken);
fetchOverrides.clear();

// A callback with an unusable initial refresh token must never create a connection.
await api.disconnect('user-a',12345);
for(const initialRefresh of ['', ' ',null,42]){
 const invalidState=await begin();fetchOverrides.set(tokenEndpoint,Response.json({access_token:validAccess,refresh_token:initialRefresh}));
 await assert.rejects(api.finishConnect('user-a','synthetic-code',invalidState),e=>e.status===502&&e.reason==='token_response');
 assert.equal(connection(),undefined);
 assert.equal(sqlite.prepare('SELECT count(*) AS n FROM eve_oauth_states WHERE user_id=?').get('user-a').n,0);
}
fetchOverrides.clear();await connect();

// Refresh must not resurrect a disconnect or overwrite a new connection's tokens.
for(const change of ['disconnect','disconnect-and-reconnect','reconnect']){
 const reconnect=change!=='disconnect';
 sqlite.prepare('UPDATE eve_connections SET expires=0 WHERE user_id=?').run('user-a');
 const refreshReached=deferred(),refreshRelease=deferred();
 fetchOverrides.set(tokenEndpoint,async(_url,init)=>{
  if(new URLSearchParams(init.body).get('grant_type')==='refresh_token'){refreshReached.resolve();await refreshRelease.promise;return Response.json({access_token:await jwt(),refresh_token:'synthetic-stale-refresh'});}
  return Response.json({access_token:await jwt(),refresh_token:'synthetic-reconnected-refresh'});
 });
 const pendingRead=readOrders(),pendingReadResult=assert.rejects(pendingRead,e=>e.status===409);
 await refreshReached.promise;
 if(change!=='reconnect')await api.disconnect('user-a',12345);
 if(reconnect)await api.finishConnect('user-a','synthetic-code',await begin());
 const replacement=connection()?.encrypted;
 refreshRelease.resolve();await pendingReadResult;
 if(reconnect){assert.equal(connection().encrypted,replacement);assert.equal((await api.test.decrypt(replacement,'token:user-a:12345')).refreshToken,'synthetic-reconnected-refresh');assert.equal(connection().refresh_lock,null);}
 else assert.equal(connection(),undefined);
 fetchOverrides.clear();if(!reconnect)await connect();
}
// ESI metadata must not invent completeness or discard usable cooldown advice.
const assetsEndpoint='https://esi.evetech.net/characters/12345/assets?page=1';
const transactionsEndpoint='https://esi.evetech.net/characters/12345/wallet/transactions';
for(const pageCount of [null,'0','-1','1.5','NaN','Infinity','9007199254740992']){
 const headers=pageCount===null?{}:{'x-pages':pageCount};
 fetchOverrides.set(assetsEndpoint,Response.json([{item_id:1}],{headers}));
 const data=await api.readEve('user-a',{characterId:12345,entity:'character',dataset:'assets'});
 assert.equal(data.pages,null);assert.equal(data.nextPage,null);assert(data.pagination.includes('completeness is unknown'));
}
for(const [pages,nextPage]of [['1',null],['3',2]]){
 fetchOverrides.set(assetsEndpoint,Response.json([{item_id:1}],{headers:{'x-pages':pages}}));
 const data=await api.readEve('user-a',{characterId:12345,entity:'character',dataset:'assets'});
 assert.equal(data.pages,Number(pages));assert.equal(data.nextPage,nextPage);
}
const readTransactions=[
 ()=>api.readEve('user-a',{characterId:12345,entity:'character',dataset:'wallet_transactions'}),
 ()=>api.readCharacterData('user-a',{characterId:12345,dataset:'wallet_transactions'}),
];
for(const read of readTransactions){
 for(const rows of [[null],[{}],[{transaction_id:-1}],[{transaction_id:0}],[{transaction_id:1.5}],[{transaction_id:9007199254740992}],[{transaction_id:3},null]]){
  fetchOverrides.set(transactionsEndpoint,Response.json(rows));
  await assert.rejects(read(),e=>e.status===502&&e.message==='EVE returned an unexpected dataset.');
 }
 fetchOverrides.set(transactionsEndpoint,Response.json([{transaction_id:9},{transaction_id:7}]));
 const valid=await read();assert.equal(valid.nextFromId??valid.pagination.nextFromId,7);
 fetchOverrides.set(transactionsEndpoint,Response.json([]));
 const empty=await read();assert.equal(Object.hasOwn(empty,'nextFromId')?empty.nextFromId:empty.pagination.nextFromId,null);
}
for(const [status,header,seconds]of [[429,'retry-after','120'],[420,'x-esi-error-limit-reset','55'],[429,'retry-after','0']]){
 fetchOverrides.set(assetsEndpoint,Response.json({error:'synthetic confidential upstream detail'},{status,headers:{[header]:seconds}}));
 await assert.rejects(api.readEve('user-a',{characterId:12345,entity:'character',dataset:'assets'}),e=>e.status===429&&e.upstreamStatus===status&&e.message.includes(`Retry after ${seconds} seconds.`)&&!e.message.includes('confidential'));
}
for(const delay of ['-1','1.5','Infinity','9007199254740992','synthetic confidential header']){
 fetchOverrides.set(assetsEndpoint,Response.json({error:'synthetic confidential upstream detail'},{status:429,headers:{'retry-after':delay}}));
 await assert.rejects(api.readEve('user-a',{characterId:12345,entity:'character',dataset:'assets'}),e=>e.status===429&&e.message==="EVE's request limit was reached. Please wait before retrying.");
}
const snapshotHeaders={'x-pages':'1','expires':'Sun, 01 Nov 2026 12:30:00 GMT','last-modified':'Sun, 01 Nov 2026 12:25:00 GMT','cache-control':'public, max-age=300'};
fetchOverrides.set(assetsEndpoint,Response.json([],{headers:snapshotHeaders}));
const snapshot=await api.readEve('user-a',{characterId:12345,entity:'character',dataset:'assets'});
assert.equal(snapshot.cacheExpires,snapshotHeaders.expires);assert.equal(snapshot.lastModified,snapshotHeaders['last-modified']);assert.equal(snapshot.cacheControl,snapshotHeaders['cache-control']);assert(Number.isFinite(Date.parse(snapshot.retrievedAt)));
const pagedReaders=[
 page=>api.readEve('user-a',{characterId:12345,entity:'character',dataset:'assets',page}),
 page=>api.readCharacterData('user-a',{characterId:12345,dataset:'assets',parameters:{page}}),
];
for(const read of pagedReaders)for(const [page,pages,nextPage,more,limited]of [[499,501,500,true,false],[500,501,null,true,true],[500,500,null,false,false],[500,null,null,null,true],[1,3,2,true,false],[1,null,null,null,false]]){
 const endpoint=`https://esi.evetech.net/characters/12345/assets?page=${page}`;
 fetchOverrides.set(endpoint,Response.json([{item_id:1}],{headers:pages===null?{}:{'x-pages':String(pages)}}));
 const result=await read(page),metadata=typeof result.pagination==='object'?result.pagination:result;
 assert.equal(metadata.pageLimit,500);assert.equal(metadata.nextPage,nextPage);assert.equal(metadata.morePagesAvailable,more);assert.equal(metadata.pageLimitReached,limited);
 const notice=typeof result.pagination==='string'?result.pagination:result.notes;
 if(limited)assert(notice.includes(more===true?'additional pages exist':'completeness cannot be determined'));
 if(limited&&more===true)assert(notice.includes('incomplete'));
}
for(const read of pagedReaders)for(const status of [201,202,206]){
 fetchOverrides.set(assetsEndpoint,Response.json([{item_id:1}],{status}));
 await assert.rejects(read(1),error=>error.status===502&&error.upstreamStatus===status&&error.message==='EVE returned an unexpected response.');
}
fetchOverrides.clear();
// Provider cancellation consumes only that authenticated user's matching flow.
const actualCallbackModule={exports:{}};
vm.runInNewContext(ts.transpileModule(readFileSync('app/eve/callback/route.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module:actualCallbackModule,exports:actualCallbackModule.exports,require:()=>api,URL,Response});
const stateDigest=async value=>Buffer.from(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).toString('base64url');
const stateRecord=async value=>sqlite.prepare('SELECT * FROM eve_oauth_states WHERE state_hash=?').get(await stateDigest(value));
const cancelCallback=(value,user='user-a')=>actualCallbackModule.exports.GET(new Request('https://example.chatgpt.site/eve/callback?error=access_denied'+(value===undefined?'':'&state='+encodeURIComponent(value)),{headers:user?{'oai-authenticated-user-id':user}:{}}));
await api.disconnect('user-a',12345);
const cancelledPending=await begin(),survivingPending=await begin(),otherOwnerPending=await begin('user-b');
const cancelResult=await cancelCallback(cancelledPending);
assert.equal(cancelResult.headers.get('location'),'/?eve=cancelled');assert.equal(cancelResult.headers.get('cache-control'),'no-store');assert.equal(cancelResult.headers.get('referrer-policy'),'no-referrer');
assert.equal(await stateRecord(cancelledPending),undefined);assert(await stateRecord(survivingPending));assert(await stateRecord(otherOwnerPending));
const exchangesBeforeCancellationReplay=authCodeUses;
await assert.rejects(api.finishConnect('user-a','synthetic-code',cancelledPending));assert.equal(authCodeUses,exchangesBeforeCancellationReplay);
await cancelCallback(survivingPending,'user-b');await cancelCallback(survivingPending,null);
for(const invalidState of [undefined,'','invalid-state','0'.repeat(43)])await cancelCallback(invalidState);
assert(await stateRecord(survivingPending));assert(await stateRecord(otherOwnerPending));
const failedCancellation=await begin(),failedCancellationHash=await stateDigest(failedCancellation);
dbHooks.beforeRun=async(sql,args)=>{if(sql==='DELETE FROM eve_oauth_states WHERE state_hash=? AND user_id=?'&&args[0]===failedCancellationHash)throw new Error('synthetic private cancellation detail');};
const failedCancellationResult=await cancelCallback(failedCancellation);dbHooks.beforeRun=null;
assert.equal(failedCancellationResult.headers.get('location'),'/?eve=failed&reason=state_storage');assert.equal(await failedCancellationResult.text(),'');
assert(await stateRecord(failedCancellation));await cancelCallback(failedCancellation);assert.equal(await stateRecord(failedCancellation),undefined);
await api.finishConnect('user-a','synthetic-code',survivingPending);
const priorCancellationConnection=connection().encrypted;
const cancellationReached=deferred(),cancellationRelease=deferred();
fetchOverrides.set(tokenEndpoint,async()=>{cancellationReached.resolve();await cancellationRelease.promise;return Response.json({access_token:await jwt(),refresh_token:'synthetic-cancelled-refresh'});});
const cancellingState=await begin();
const cancellingFlow=api.finishConnect('user-a','synthetic-code',cancellingState),cancelledFlowResult=assert.rejects(cancellingFlow,e=>e.status===409);
await cancellationReached.promise;assert.equal((await stateRecord(cancellingState)).encrypted,'');
await cancelCallback(cancellingState);assert.equal(await stateRecord(cancellingState),undefined);
const newerPending=await begin();cancellationRelease.resolve();await cancelledFlowResult;fetchOverrides.clear();
assert.equal(connection().encrypted,priorCancellationConnection);assert(await stateRecord(newerPending));assert(await stateRecord(otherOwnerPending));
await api.finishConnect('user-b','synthetic-code',otherOwnerPending);

// Expired attempts purge only the matching expired row, including expiry during CAS.
const expiredPending=await begin(),freshPending=await begin(),otherExpiredPending=await begin('user-b');
const expiredHash=await stateDigest(expiredPending),otherExpiredHash=await stateDigest(otherExpiredPending);
sqlite.prepare('UPDATE eve_oauth_states SET expires=0 WHERE state_hash IN (?,?)').run(expiredHash,otherExpiredHash);
await assert.rejects(api.finishConnect('user-b','synthetic-code',expiredPending));assert(await stateRecord(expiredPending));
await assert.rejects(api.finishConnect('user-a','synthetic-code',expiredPending));assert.equal(await stateRecord(expiredPending),undefined);
assert(await stateRecord(freshPending));assert(await stateRecord(otherExpiredPending));
const expiresDuringClaim=await begin(),expiresDuringClaimHash=await stateDigest(expiresDuringClaim);
dbHooks.afterFirst=async(sql,args)=>{if(sql.startsWith('SELECT encrypted FROM eve_oauth_states')&&args[0]===expiresDuringClaimHash)sqlite.prepare('UPDATE eve_oauth_states SET expires=0 WHERE state_hash=?').run(expiresDuringClaimHash);};
await assert.rejects(api.finishConnect('user-a','synthetic-code',expiresDuringClaim));dbHooks.afterFirst=null;
assert.equal(await stateRecord(expiresDuringClaim),undefined);assert(await stateRecord(freshPending));
const failedExpiryCleanup=await begin(),failedExpiryHash=await stateDigest(failedExpiryCleanup);
sqlite.prepare('UPDATE eve_oauth_states SET expires=0 WHERE state_hash=?').run(failedExpiryHash);
dbHooks.beforeRun=async(sql,args)=>{if(sql.startsWith('DELETE FROM eve_oauth_states WHERE state_hash=')&&sql.includes('expires<=')&&args[0]===failedExpiryHash)throw new Error('synthetic private database detail');};
await assert.rejects(api.finishConnect('user-a','synthetic-code',failedExpiryCleanup),e=>e.status===500&&e.reason==='state_storage'&&!e.message.includes('private database'));
dbHooks.beforeRun=null;assert(await stateRecord(failedExpiryCleanup));
await assert.rejects(api.finishConnect('user-a','synthetic-code',failedExpiryCleanup));assert.equal(await stateRecord(failedExpiryCleanup),undefined);

// Validate profile metadata before storing a connection or constructing a corporation URL.
await api.disconnect('user-a',12345);
const profileEndpoint='https://esi.evetech.net/characters/12345';
const malformedProfiles=[null,[],{},
 {name:'Synthetic Pilot',corporation_id:0},{name:'Synthetic Pilot',corporation_id:-1},
 {name:'Synthetic Pilot',corporation_id:Number.MAX_SAFE_INTEGER+1},{name:'Synthetic Pilot',corporation_id:'999'},
 {corporation_id:999},{name:null,corporation_id:999},{name:{text:'Synthetic Pilot'},corporation_id:999},
 {name:'',corporation_id:999},{name:' \t ',corporation_id:999},{name:'Synthetic\nPilot',corporation_id:999},{name:'x'.repeat(257),corporation_id:999}];
for(const profile of malformedProfiles){
 const profileState=await begin();fetchOverrides.set(profileEndpoint,Response.json(profile));
 await assert.rejects(api.finishConnect('user-a','synthetic-code',profileState),e=>e.status===502&&e.reason==='profile_response');
 assert.equal(connection(),undefined);assert.equal(await stateRecord(profileState),undefined);
}
fetchOverrides.set(profileEndpoint,Response.json({name:' Synthetic Pilot ',corporation_id:999}));
await connect();assert.equal(connection().name,'Synthetic Pilot');
const beforeBadReconnect=connection().encrypted,badReconnectState=await begin();
fetchOverrides.set(profileEndpoint,Response.json({name:'Synthetic Pilot',corporation_id:0}));
await assert.rejects(api.finishConnect('user-a','synthetic-code',badReconnectState),e=>e.status===502&&e.reason==='profile_response');
assert.equal(connection().encrypted,beforeBadReconnect);assert.equal(connection().name,'Synthetic Pilot');assert.equal(await stateRecord(badReconnectState),undefined);
sqlite.prepare('UPDATE eve_connections SET scopes=? WHERE user_id=?').run(JSON.stringify([...charScopes,...api.scopes.corporation]),'user-a');
for(const profile of malformedProfiles){
 fetchOverrides.set(profileEndpoint,Response.json(profile));const beforeRead=esiRequests.length;
 await assert.rejects(api.readEve('user-a',{characterId:12345,entity:'corporation',dataset:'orders'}),e=>e.status===502&&e.message.includes('character profile'));
 assert.equal(esiRequests.length,beforeRead);
}
fetchOverrides.set(profileEndpoint,Response.json({name:'Synthetic Pilot',corporation_id:999}));
fetchOverrides.set('https://esi.evetech.net/corporations/999/orders?page=1',Response.json([]));
assert.equal((await api.readEve('user-a',{characterId:12345,entity:'corporation',dataset:'orders'})).corporationId,999);
fetchOverrides.clear();
// Optional corporation reads: selection is explicit and separate from legacy finance.
const extras=corporationModule.exports.corporationReadFeatures;
assert.equal(extras.length,8);
assert.deepEqual(Array.from(extras,feature=>feature.id),['contracts','industry','projects','blueprints','facilities','structures','extractions','freelance']);
const legacyScopes=new URL((await api.startConnect('user-a',true)).url).searchParams.get('scope').split(' ');
assert.equal(legacyScopes.length,42);
assert(extras.every(feature=>!legacyScopes.includes(feature.scope)));
for(const feature of extras){
 const chosen=new URL((await api.startConnect('user-a',false,[feature.id])).url).searchParams.get('scope').split(' ');
 assert.equal(chosen.length,40);assert(chosen.includes(feature.scope));
 assert(extras.filter(other=>other.id!==feature.id).every(other=>!chosen.includes(other.scope)));
}
const allReads=new URL((await api.startConnect('user-a',true,extras.map(feature=>feature.id))).url).searchParams.get('scope').split(' ');
assert.equal(allReads.length,50);assert.equal(new Set(allReads).size,50);
assert(!allReads.some(scope=>scope.includes('contributors')||scope.includes('track_members')||scope.includes('write_')||scope.includes('send_mail')));
const actionScopes=['esi-calendar.respond_calendar_events.v1','esi-characters.write_contacts.v1','esi-fittings.write_fittings.v1','esi-fleets.write_fleet.v1','esi-mail.organize_mail.v1','esi-mail.send_mail.v1','esi-ui.open_window.v1','esi-ui.write_waypoint.v1'];
assert(actionScopes.every(scope=>!allReads.includes(scope)));
const statesBeforeInvalid=sqlite.prepare('SELECT COUNT(*) count FROM eve_oauth_states').get().count;
for(const features of [null,true,'contracts',{},['__proto__'],['contributors'],['contracts','contracts'],['contracts','industry','projects','contracts'],[{}]])await assert.rejects(api.startConnect('user-a',false,features),e=>e.status===400);
assert.equal(sqlite.prepare('SELECT COUNT(*) count FROM eve_oauth_states').get().count,statesBeforeInvalid);
const optionalPending=new URL((await api.startConnect('user-a',false,['contracts'])).url).searchParams.get('state');
const existingBeforeMissingOptional=connection().encrypted;
await assert.rejects(api.finishConnect('user-a','synthetic-code',optionalPending),e=>e.status===403&&e.reason==='permissions');
assert.equal(connection().encrypted,existingBeforeMissingOptional);

let corporationProfileReads=0,corporationDataReads=0;
fetchOverrides.set(profileEndpoint,()=>{corporationProfileReads++;return Response.json({name:'Synthetic Pilot',corporation_id:1001});});
fetchOverrides.set('https://esi.evetech.net/corporations/1001/contracts?page=1',(_url,init)=>{
 corporationDataReads++;assert.equal(init.method,'GET');assert(init.headers.Authorization.startsWith('Bearer '));
 return Response.json([{contract_id:1,status:'outstanding'}],{headers:{'x-pages':'3','cache-control':'max-age=300','last-modified':'Sat, 01 Nov 2025 00:00:00 GMT'}});
});
const badCorporationArgs=[
 {characterId:12345,dataset:'__proto__'},{characterId:12345,dataset:'contributors'},
 {characterId:12345,dataset:'contracts',corporationId:999},{characterId:12345,dataset:'projects',parameters:{page:1}},
 {characterId:12345,dataset:'contracts',parameters:{page:501}},{characterId:12345,dataset:'projects',parameters:{after:'0',before:'0'}},
 {characterId:12345,dataset:'industry_jobs',parameters:{includeCompleted:'true'}},{characterId:12345,dataset:'contracts',parameters:null},
 {characterId:12345,dataset:'wallet_balances',parameters:{page:1}},
 {characterId:12345,dataset:'contract_items'}, {characterId:12345,dataset:'contract_bids',parameters:{contractId:'10'}},
 {characterId:12345,dataset:'contract_items',parameters:{contractId:10,page:1}},
 {characterId:12345,dataset:'project'}, {characterId:12345,dataset:'project',parameters:{projectId:'../other'}},
 {characterId:12345,dataset:'project_contribution',parameters:{projectId:'00000000-0000-0000-0000-000000000001',characterId:54321}},
 {characterId:12345,dataset:'project_contribution',parameters:{projectId:'00000000-0000-0000-0000-000000000001',corporationId:999}},
 {characterId:12345,dataset:'order_history',parameters:{url:'https://attacker.example'}},
 {characterId:12345,dataset:'blueprints',parameters:{page:'1'}},
 {characterId:12345,dataset:'blueprints',parameters:{corporationId:999}},
 {characterId:12345,dataset:'facilities',parameters:{page:1}},
 {characterId:12345,dataset:'structures',parameters:{page:501}},
 {characterId:12345,dataset:'structures',parameters:{url:'https://attacker.example'}},
 {characterId:12345,dataset:'mining_extractions',pathRoot:'corporations'},
 {characterId:12345,dataset:'mining_extractions',parameters:{corporationId:999}},
 {characterId:12345,dataset:'mining_extractions',parameters:{page:501}},
 {characterId:12345,dataset:'mining_extractions',parameters:{after:'0'}},
 {characterId:12345,dataset:'mining_observers'},
 {characterId:12345,dataset:'freelance_participants'},
 {characterId:12345,dataset:'freelance_jobs',parameters:{state:'Active'}},
 {characterId:12345,dataset:'freelance_jobs',parameters:{after:'0',before:'0'}},
 {characterId:12345,dataset:'freelance_jobs',parameters:{limit:101}},
 {characterId:12345,dataset:'freelance_jobs',parameters:{page:1}},
 {characterId:12345,dataset:'freelance_jobs',parameters:{url:'https://attacker.example'}},
 {characterId:12345,dataset:'assets',parameters:{itemIds:[2001]}},
 {characterId:12345,dataset:'asset_names'},
 {characterId:12345,dataset:'asset_names',parameters:{itemIds:[2001],page:1}},
 {characterId:12345,dataset:'asset_locations',parameters:{itemIds:[2001],corporationId:999}},
 {characterId:12345,dataset:'asset_locations',parameters:{itemIds:[2001],url:'https://attacker.example'}},
 {characterId:12345,dataset:'project',parameters:JSON.parse('{"__proto__":"x"}')},
 Object.create({characterId:12345,dataset:'contracts'}),
 {characterId:12345,dataset:'contract_items',parameters:Object.create({contractId:10})},
];
for(const contractId of [null,0,-1,1.5,Number.MAX_SAFE_INTEGER+1,Infinity,NaN,true,[],{}])badCorporationArgs.push({characterId:12345,dataset:'contract_items',parameters:{contractId}});
for(const projectId of [null,123,true,[],{},'','https://attacker.example','00000000-0000-0000-0000-000000000001/','00000000-0000-0000-0000-000000000001\n'])badCorporationArgs.push({characterId:12345,dataset:'project',parameters:{projectId}});
for(const itemIds of [null,123,'2001',{},[],[0],[-1],[1.5],[Number.MAX_SAFE_INTEGER+1],[NaN],[Infinity],[true],[[2001]],[{}],[2001,2001],Array(1),Array.from({length:1001},(_,index)=>index+1)])for(const dataset of ['asset_names','asset_locations'])badCorporationArgs.push({characterId:12345,dataset,parameters:{itemIds}});
for(const args of badCorporationArgs)await assert.rejects(api.readCorporationData('user-a',args),e=>e.status===400);
await assert.rejects(api.readCorporationData('unconnected-user',{characterId:12345,dataset:'contracts'}),e=>e.status===404);
await assert.rejects(api.readCorporationData('user-a',{characterId:12345,dataset:'contracts'}),e=>e.status===403);
assert.equal(corporationProfileReads,0);assert.equal(corporationDataReads,0);
sqlite.prepare('UPDATE eve_connections SET scopes=?,expires=? WHERE user_id=?').run(JSON.stringify(allReads),Date.now()+3600000,'user-a');
const corporationContracts=await api.readCorporationData('user-a',{characterId:12345,dataset:'contracts'});
assert.equal(corporationContracts.corporationId,1001);assert.equal(corporationContracts.pagination.nextPage,2);assert.equal(corporationContracts.pagination.morePagesAvailable,true);
assert.equal(corporationContracts.cacheControl,'max-age=300');assert.equal(corporationContracts.lastModified,'Sat, 01 Nov 2025 00:00:00 GMT');
assert.equal(corporationProfileReads,1);assert.equal(corporationDataReads,1);
assert(!JSON.stringify(corporationContracts).includes('accessToken'));assert(!JSON.stringify(corporationContracts).includes('Bearer'));
fetchOverrides.set('https://esi.evetech.net/corporations/1001/contracts?page=500',Response.json([],{headers:{'x-pages':'501'}}));
const cappedCorporation=await api.readCorporationData('user-a',{characterId:12345,dataset:'contracts',parameters:{page:500}});
assert.equal(cappedCorporation.pagination.nextPage,null);assert.equal(cappedCorporation.pagination.pageLimitReached,true);assert.equal(cappedCorporation.pagination.morePagesAvailable,true);
fetchOverrides.set('https://esi.evetech.net/corporations/1001/contracts?page=1',Response.json([]));
assert.equal((await api.readCorporationData('user-a',{characterId:12345,dataset:'contracts'})).pagination.morePagesAvailable,null);
fetchOverrides.set('https://esi.evetech.net/corporations/1001/industry/jobs?page=2&include_completed=false',Response.json([{job_id:10,status:'active'}],{headers:{'x-pages':'2'}}));
const jobs=await api.readCorporationData('user-a',{characterId:12345,dataset:'industry_jobs',parameters:{page:2,includeCompleted:false}});
assert.equal(jobs.pagination.nextPage,null);assert.equal(jobs.pagination.morePagesAvailable,false);
fetchOverrides.set('https://esi.evetech.net/corporations/1001/projects?after=0&limit=100&state=Active',Response.json({projects:[{id:'00000000-0000-0000-0000-000000000001',name:'Synthetic project'}],cursor:{after:'next-cursor',before:'older-cursor'}}));
const projects=await api.readCorporationData('user-a',{characterId:12345,dataset:'projects',parameters:{after:'0',limit:100,state:'Active'}});
assert.equal(projects.pagination.kind,'cursor');assert.equal(projects.pagination.after,'next-cursor');assert.equal(projects.pagination.before,'older-cursor');
for(const body of [[],{}, {projects:{}},{projects:[],cursor:'bad'},{projects:[],cursor:{after:'next\ncursor'}},{projects:[],cursor:{before:7}}]){
 fetchOverrides.set('https://esi.evetech.net/corporations/1001/projects',Response.json(body));
 await assert.rejects(api.readCorporationData('user-a',{characterId:12345,dataset:'projects'}),e=>e.status===502);
}
fetchOverrides.set('https://esi.evetech.net/corporations/1001/projects',Response.json({projects:[]}));
assert.equal((await api.readCorporationData('user-a',{characterId:12345,dataset:'projects'})).pagination.after,null);
fetchOverrides.set('https://esi.evetech.net/corporations/1001/projects',Response.json({projects:[],cursor:{after:'',before:''}}));
const emptyProjectCursor=await api.readCorporationData('user-a',{characterId:12345,dataset:'projects'});
assert.equal(emptyProjectCursor.pagination.after,null);assert.equal(emptyProjectCursor.pagination.before,null);
// Detail endpoints are fixed GETs; own contribution cannot target another pilot.
const syntheticProjectId='00000000-0000-0000-0000-000000000001';
const newCorporationReads=[
 {dataset:'assets',parameters:{page:2},suffix:'/assets?page=2',body:[{item_id:2001,type_id:3001,quantity:4,is_singleton:false,location_id:4001,location_type:'station',location_flag:'CorpSAG1'}],kind:'page'},
 {dataset:'asset_names',parameters:{itemIds:[2001]},suffix:'/assets/names',body:[{item_id:2001,name:'Synthetic container'}],kind:'none',method:'POST'},
 {dataset:'asset_locations',parameters:{itemIds:[2001]},suffix:'/assets/locations',body:[{item_id:2001,position:{x:0,y:0,z:0}}],kind:'none',method:'POST'},
 {dataset:'wallet_balances',suffix:'/wallets',body:[{division:1,balance:125.5}],kind:'none'},
 {dataset:'order_history',parameters:{page:2},suffix:'/orders/history?page=2',body:[{order_id:20,state:'expired'}],kind:'page'},
 {dataset:'contract_items',parameters:{contractId:10},suffix:'/contracts/10/items',body:[{record_id:20,type_id:30,quantity:2,is_singleton:false,is_included:true}],kind:'none'},
 {dataset:'contract_bids',parameters:{contractId:10,page:2},suffix:'/contracts/10/bids?page=2',body:[{bid_id:20,bidder_id:12345,date_bid:'2025-01-01T00:00:00Z',amount:3}],kind:'page'},
 {dataset:'project',parameters:{projectId:syntheticProjectId},suffix:`/projects/${syntheticProjectId}`,body:{id:syntheticProjectId,name:'Synthetic project',state:'Active',last_modified:'2025-01-01T00:00:00Z',details:{description:'Synthetic description'},creator:{id:12345,name:'Synthetic Pilot'},configuration:{manual:{}},progress:{current:2,desired:10}},kind:'none'},
 {dataset:'project_contribution',parameters:{projectId:syntheticProjectId},suffix:`/projects/${syntheticProjectId}/contribution/12345`,body:{contributed:0},kind:'none'},
 {dataset:'blueprints',parameters:{page:2},suffix:'/blueprints?page=2',body:[{item_id:2001,type_id:3001,location_id:4001,location_flag:'CorpSAG1',quantity:-2,runs:10,material_efficiency:2,time_efficiency:4}],kind:'page'},
 {dataset:'facilities',suffix:'/facilities',body:[{facility_id:2002,type_id:3002,system_id:4002}],kind:'none'},
 {dataset:'structures',parameters:{page:2},suffix:'/structures?page=2',body:[{structure_id:2003,type_id:3003,corporation_id:1002,system_id:4003,profile_id:5003,state:'shield_vulnerable',name:'Synthetic structure',fuel_expires:'2026-11-02T00:00:00Z',services:[{name:'Synthetic service',state:'online'}]}],kind:'page'},
];
const info=corporationModule.exports.corporationDatasetInfo;
assert.equal(info.length,17);
for(const dataset of ['asset_names','asset_locations']){
 const ids=Array.from({length:1000},(_,index)=>index+1),request=corporationModule.exports.buildCorporationRequest({characterId:12345,dataset,parameters:{itemIds:ids}});
 assert.equal(request.method,'POST');assert.equal(request.path,dataset==='asset_names'?'/assets/names':'/assets/locations');assert.equal(request.body.length,1000);
 ids[0]=0;assert.equal(request.body[0],1,'Validated request bodies are snapshots of caller input');
 assert.equal(info.find(entry=>entry.dataset===dataset).scope,'esi-assets.read_corporation_assets.v1');
}
for(const [dataset,featureId,pagination] of [['blueprints','blueprints','page'],['facilities','facilities','none'],['structures','structures','page']]){
 const entry=info.find(item=>item.dataset===dataset);
 assert.equal(entry.scope,extras.find(feature=>feature.id===featureId).scope);
 assert.equal(entry.pagination,pagination);assert.equal(entry.requiredParameters.length,0);
 assert.equal(entry.optionalParameters.join(','),pagination==='page'?'page':'');
 const request=corporationModule.exports.buildCorporationRequest({characterId:12345,dataset});
 assert.equal(request.method,'GET');assert.equal(request.path,`/${dataset}${pagination==='page'?'?page=1':''}`);
}
assert.equal(info.find(entry=>entry.dataset==='contract_items').requiredParameters.join(','),'contractId');
assert.equal(info.find(entry=>entry.dataset==='project_contribution').requiredParameters.join(','),'projectId');
assert.equal(corporationModule.exports.buildCorporationRequest({characterId:12345,dataset:'project',parameters:{projectId:'ABCDEF00-0000-0000-0000-000000000001'}}).path,'/projects/abcdef00-0000-0000-0000-000000000001');
sqlite.prepare('UPDATE eve_connections SET scopes=?,expires=0 WHERE user_id=?').run(JSON.stringify(charScopes),'user-a');
const beforeMissingReadScopes={profile:corporationProfileReads,refresh:refreshUses};
for(const {dataset,parameters} of newCorporationReads){
 await assert.rejects(api.readCorporationData('unconnected-user',{characterId:12345,dataset,parameters}),e=>e.status===404);
 await assert.rejects(api.readCorporationData('user-a',{characterId:12345,dataset,parameters}),e=>e.status===403);
}
assert.equal(corporationProfileReads,beforeMissingReadScopes.profile);assert.equal(refreshUses,beforeMissingReadScopes.refresh);
sqlite.prepare('UPDATE eve_connections SET scopes=?,expires=? WHERE user_id=?').run(JSON.stringify(allReads),Date.now()+3600000,'user-a');
// Stored corporation remains different: each response must use fresh membership.
fetchOverrides.set(profileEndpoint,()=>{corporationProfileReads++;return Response.json({name:'Synthetic Pilot',corporation_id:1002});});
for(const {dataset,parameters,suffix,body,kind,method='GET'} of newCorporationReads){
 const endpoint=`https://esi.evetech.net/corporations/1002${suffix}`;
 const readsBefore=corporationProfileReads;
 fetchOverrides.set(endpoint,(_url,init)=>{assert.equal(init.method,method);assert.equal(init.body,method==='POST'?JSON.stringify(parameters.itemIds):undefined);assert(init.headers.Authorization.startsWith('Bearer '));if(method==='POST')assert.equal(init.headers['Content-Type'],'application/json');return Response.json(body,{headers:{'x-pages':'3','cache-control':'max-age=300'}});});
 const result=await api.readCorporationData('user-a',{characterId:12345,dataset,parameters});
 assert.equal(corporationProfileReads,readsBefore+1);assert.equal(result.corporationId,1002);assert.equal(result.source,endpoint);
 assert.equal(result.pagination.kind,kind);assert.equal(result.cacheControl,'max-age=300');
 assert.equal(result.pagination.nextPage,kind==='page'?3:null);
 if(kind==='none'){assert.equal(result.pagination.page,undefined);assert.equal(result.pagination.pages,undefined);assert.equal(result.pagination.after,null);assert.equal(result.pagination.before,null);assert(result.notes.includes('unpaginated'));}
 for(const malformed of [null,'bad',...(Array.isArray(body)?[{}]:[[]])]){
  fetchOverrides.set(endpoint,Response.json(malformed));
  await assert.rejects(api.readCorporationData('user-a',{characterId:12345,dataset,parameters}),e=>e.status===502);
 }
 fetchOverrides.set(endpoint,Response.json({error:'synthetic private role context'},{status:403}));
 await assert.rejects(api.readCorporationData('user-a',{characterId:12345,dataset,parameters}),e=>e.status===403&&!e.message.includes('private role'));
}
for(const dataset of ['asset_names','asset_locations']){
 const endpoint=`https://esi.evetech.net/corporations/1002/assets/${dataset==='asset_names'?'names':'locations'}`;
 const good=dataset==='asset_names'?{item_id:2001,name:'Synthetic container'}:{item_id:2001,position:{x:0,y:-1,z:2.5}};
 for(const body of [[good,good],[{...good,item_id:2002}],[null],[{...good,item_id:'2001'}],dataset==='asset_names'?[{item_id:2001,name:123}]:[{item_id:2001,position:{x:0,y:0,z:null}}]]){
  fetchOverrides.set(endpoint,Response.json(body));
  await assert.rejects(api.readCorporationData('user-a',{characterId:12345,dataset,parameters:{itemIds:[2001]}}),e=>e.status===502);
 }
 fetchOverrides.set(endpoint,Response.json([]));
 assert.equal((await api.readCorporationData('user-a',{characterId:12345,dataset,parameters:{itemIds:[2001]}})).data.length,0);
}
for(const body of [{},{contributed:null},{contributed:'1'},{contributed:-1},{contributed:1.1},{contributed:Number.MAX_SAFE_INTEGER+1}]){
 fetchOverrides.set(`https://esi.evetech.net/corporations/1002/projects/${syntheticProjectId}/contribution/12345`,Response.json(body));
 await assert.rejects(api.readCorporationData('user-a',{characterId:12345,dataset:'project_contribution',parameters:{projectId:syntheticProjectId}}),e=>e.status===502);
}
fetchOverrides.set(profileEndpoint,()=>{corporationProfileReads++;return Response.json({name:'Synthetic Pilot',corporation_id:1001});});
for(const [status,headers]of [[403,{}],[429,{'retry-after':'17'}],[420,{'x-esi-error-limit-reset':'23'}]]){
 fetchOverrides.set('https://esi.evetech.net/corporations/1001/contracts?page=1',Response.json({error:'synthetic private upstream details'},{status,headers}));
 await assert.rejects(api.readCorporationData('user-a',{characterId:12345,dataset:'contracts'}),e=>e.status===(status===420?429:status)&&!e.message.includes('private upstream'));
}
// Extraction and freelance reads use only the selected owner's grants and fresh membership.
const extractionScope='esi-industry.read_corporation_mining.v1',freelanceScope='esi-corporations.read_freelance_jobs.v1';
assert.equal(info.find(row=>row.dataset==='mining_extractions').scope,extractionScope);
assert.equal(info.find(row=>row.dataset==='mining_extractions').pagination,'page');
assert.equal(info.find(row=>row.dataset==='freelance_jobs').scope,freelanceScope);
assert.equal(info.find(row=>row.dataset==='freelance_jobs').optionalParameters.join(','),'before,after,limit');
assert.equal(catalog.characterDatasetInfo.find(row=>row.dataset==='freelance_jobs').pagination,'none');
for(const parameters of [{page:1},{after:'0'},{limit:10},{characterId:54321}])await assert.rejects(api.readCharacterData('user-a',{characterId:12345,dataset:'freelance_jobs',parameters}),error=>error.status===400);
const v10Scopes=allReads.filter(scope=>scope!==extractionScope&&scope!==freelanceScope);
assert.equal(v10Scopes.length,48);
sqlite.prepare('UPDATE eve_connections SET scopes=?,expires=0 WHERE user_id=?').run(JSON.stringify(v10Scopes),'user-a');
const v11BeforeScopes={profile:corporationProfileReads,refresh:refreshUses};
for(const dataset of ['mining_extractions','freelance_jobs']){
 await assert.rejects(api.readCorporationData('unconnected-user',{characterId:12345,dataset}),error=>error.status===404);
 await assert.rejects(api.readCorporationData('user-a',{characterId:12345,dataset}),error=>error.status===403);
}
assert.equal(corporationProfileReads,v11BeforeScopes.profile);assert.equal(refreshUses,v11BeforeScopes.refresh);
const v10Reconnect=new URL((await api.startReconnect('user-a',12345)).url);
assert.deepEqual(v10Reconnect.searchParams.get('scope').split(' '),v10Scopes,'A v10 reconnect never silently requests new v11 scopes');
await api.cancelConnect('user-a',v10Reconnect.searchParams.get('state'));
sqlite.prepare('UPDATE eve_connections SET scopes=?,expires=? WHERE user_id=?').run(JSON.stringify(allReads),Date.now()+3600000,'user-a');
fetchOverrides.set(profileEndpoint,()=>{corporationProfileReads++;return Response.json({name:'Synthetic Pilot',corporation_id:1002});});
const extractionRow={structure_id:700001,moon_id:400001,extraction_start_time:'2026-11-01T00:00:00Z',chunk_arrival_time:'2026-11-04T00:00:00Z',natural_decay_time:'2026-11-06T00:00:00Z'};
const extractionEndpoint='https://esi.evetech.net/corporation/1002/mining/extractions?page=2';
fetchOverrides.set(extractionEndpoint,(_url,init)=>{
 assert.equal(init.method,'GET');assert.equal(init.body,undefined);assert(init.headers.Authorization.startsWith('Bearer '));assert.equal(init.headers['X-Compatibility-Date'],'2026-10-31');
 return Response.json([extractionRow],{headers:{'x-pages':'3','cache-control':'max-age=1800'}});
});
const extractionResult=await api.readCorporationData('user-a',{characterId:12345,dataset:'mining_extractions',parameters:{page:2}});
assert.equal(extractionResult.source,extractionEndpoint);assert.equal(extractionResult.corporationId,1002);assert.equal(extractionResult.pagination.nextPage,3);assert.equal(extractionResult.cacheControl,'max-age=1800');
for(const body of [null,{},[null],[{}],[{...extractionRow,moon_id:'400001'}],[{...extractionRow,structure_id:Number.MAX_SAFE_INTEGER+1}],[{...extractionRow,chunk_arrival_time:'tomorrow'}],[{...extractionRow,natural_decay_time:'2026-11-06T00:00:00Z\n'}]]){
 fetchOverrides.set(extractionEndpoint,Response.json(body));await assert.rejects(api.readCorporationData('user-a',{characterId:12345,dataset:'mining_extractions',parameters:{page:2}}),error=>error.status===502);
}
fetchOverrides.set(extractionEndpoint,Response.json([]));
assert.equal((await api.readCorporationData('user-a',{characterId:12345,dataset:'mining_extractions',parameters:{page:2}})).pagination.morePagesAvailable,null);
const extractionCapEndpoint='https://esi.evetech.net/corporation/1002/mining/extractions?page=500';
fetchOverrides.set(extractionCapEndpoint,Response.json([],{headers:{'x-pages':'501'}}));
const extractionCap=await api.readCorporationData('user-a',{characterId:12345,dataset:'mining_extractions',parameters:{page:500}});
assert.equal(extractionCap.pagination.nextPage,null);assert.equal(extractionCap.pagination.pageLimitReached,true);assert.equal(extractionCap.pagination.morePagesAvailable,true);
const freelanceRow={id:'11111111-1111-4111-8111-111111111111',name:'Synthetic job',state:'Active',last_modified:'2026-11-01T00:00:00Z',progress:{current:25,desired:100},reward:{initial:5000,remaining:3750}};
const corpFreelanceEndpoint='https://esi.evetech.net/corporations/1002/freelance-jobs?after=0&limit=10',charFreelanceEndpoint='https://esi.evetech.net/characters/12345/freelance-jobs';
fetchOverrides.set(corpFreelanceEndpoint,(_url,init)=>{assert.equal(init.method,'GET');assert.equal(init.body,undefined);return Response.json({freelance_jobs:[freelanceRow],cursor:{after:'next-cursor',before:'previous-cursor'}});});
const freelanceResult=await api.readCorporationData('user-a',{characterId:12345,dataset:'freelance_jobs',parameters:{after:'0',limit:10}});
assert.equal(freelanceResult.source,corpFreelanceEndpoint);assert.equal(freelanceResult.corporationId,1002);assert.equal(freelanceResult.pagination.kind,'cursor');assert.equal(freelanceResult.pagination.after,'next-cursor');assert.equal(freelanceResult.pagination.before,'previous-cursor');assert(!freelanceResult.notes.includes('Active projects'));
const beforeFreelanceEndpoint='https://esi.evetech.net/corporations/1002/freelance-jobs?before=next%2Fcursor%2B&limit=100';
fetchOverrides.set(beforeFreelanceEndpoint,Response.json({freelance_jobs:[],cursor:{after:'',before:''}}));
const beforeFreelance=await api.readCorporationData('user-a',{characterId:12345,dataset:'freelance_jobs',parameters:{before:'next/cursor+',limit:100}});
assert.equal(beforeFreelance.source,beforeFreelanceEndpoint);assert.equal(beforeFreelance.pagination.after,null);assert.equal(beforeFreelance.pagination.before,null);
const malformedFreelanceRows=[null,{}, {...freelanceRow,id:'../participants'},{...freelanceRow,id:freelanceRow.id+'\n'},{...freelanceRow,name:123},{...freelanceRow,state:null},{...freelanceRow,last_modified:'yesterday'},{...freelanceRow,progress:{current:-1,desired:100}},{...freelanceRow,progress:{current:1,desired:Number.MAX_SAFE_INTEGER+1}},{...freelanceRow,reward:null},{...freelanceRow,reward:{initial:1}},{...freelanceRow,reward:{initial:-1,remaining:0}}];
for(const [endpoint,read] of [[corpFreelanceEndpoint,()=>api.readCorporationData('user-a',{characterId:12345,dataset:'freelance_jobs',parameters:{after:'0',limit:10}})],[charFreelanceEndpoint,()=>api.readCharacterData('user-a',{characterId:12345,dataset:'freelance_jobs'})]]){
 for(const body of [[],{}, {freelance_jobs:null},{freelance_jobs:[freelanceRow,freelanceRow]},...malformedFreelanceRows.map(row=>({freelance_jobs:[row]}))]){
  fetchOverrides.set(endpoint,Response.json(body));await assert.rejects(read,error=>error.status===502);
 }
 for(const row of [freelanceRow,{...freelanceRow,reward:undefined,progress:{current:0,desired:0}}, {...freelanceRow,state:'FutureState'}]){
  fetchOverrides.set(endpoint,Response.json({freelance_jobs:[row]}));const result=await read();assert.equal(result.data.freelance_jobs.length,1);
  if(endpoint===charFreelanceEndpoint){assert.equal(result.pagination.kind,'none');assert.equal(result.pagination.after,null);assert.equal(result.pagination.pages,undefined);}
 }
 fetchOverrides.set(endpoint,Response.json({freelance_jobs:[]}));assert.equal((await read()).data.freelance_jobs.length,0);
 fetchOverrides.set(endpoint,Response.json({error:'synthetic private role detail'},{status:403}));await assert.rejects(read,error=>error.status===403&&!error.message.includes('private role'));
}
for(const cursor of [null,'bad',{after:42},{before:'next\ncursor'},{after:'x'.repeat(513)}]){
 fetchOverrides.set(corpFreelanceEndpoint,Response.json({freelance_jobs:[],cursor}));await assert.rejects(api.readCorporationData('user-a',{characterId:12345,dataset:'freelance_jobs',parameters:{after:'0',limit:10}}),error=>error.status===502);
}
// A cancellation between fresh membership and either new corporation GET sends no data request.
for(const [dataset,endpoint] of [['mining_extractions','https://esi.evetech.net/corporation/1002/mining/extractions?page=1'],['freelance_jobs','https://esi.evetech.net/corporations/1002/freelance-jobs']]){
 const controller=new AbortController();let dataReads=0;
 fetchOverrides.set(profileEndpoint,()=>{controller.abort();return Response.json({name:'Synthetic Pilot',corporation_id:1002});});
 fetchOverrides.set(endpoint,()=>{dataReads++;return Response.json([]);});
 await assert.rejects(api.readCorporationData('user-a',{characterId:12345,dataset},controller.signal),error=>error.status===502);assert.equal(dataReads,0);
}
fetchOverrides.set(profileEndpoint,()=>{corporationProfileReads++;return Response.json({name:'Synthetic Pilot',corporation_id:1001});});
// Cancellation stops chained corporation/refresh reads; no token enters public metadata.
const preAborted=new AbortController();preAborted.abort();const beforeAbortReads=corporationProfileReads;
await assert.rejects(api.readCorporationData('user-a',{characterId:12345,dataset:'contracts'},preAborted.signal),e=>e.status===502);
assert.equal(corporationProfileReads,beforeAbortReads);
const midAbort=new AbortController();fetchOverrides.set(profileEndpoint,()=>{midAbort.abort();return Response.json({name:'Synthetic Pilot',corporation_id:1001});});
let abortedDataReads=0;fetchOverrides.set('https://esi.evetech.net/corporations/1001/contracts?page=1',()=>{abortedDataReads++;return Response.json([]);});
await assert.rejects(api.readCorporationData('user-a',{characterId:12345,dataset:'contracts'},midAbort.signal),e=>e.status===502);
assert.equal(abortedDataReads,0);
await assert.rejects(api.readCharacterData('user-a',{characterId:12345,dataset:'orders'},preAborted.signal),e=>e.status===502);
sqlite.prepare('UPDATE eve_connections SET expires=0 WHERE user_id=?').run('user-a');
const refreshBeforeAbort=refreshUses;
await assert.rejects(api.readCharacterData('user-a',{characterId:12345,dataset:'orders'},preAborted.signal),e=>e.status===502);
assert.equal(refreshUses,refreshBeforeAbort);assert.equal(connection().refresh_lock,null);
// Public labels are bounded lookup-only POSTs, without runtime settings or grants.
const namesEndpoint='https://esi.evetech.net/universe/names';
let publicNameRequests=0;
const publicFixture=[{id:34,name:'Synthetic mineral',category:'inventory_type',privateExtra:'not returned'},{id:30000142,name:'Synthetic system',category:'solar_system'}];
fetchOverrides.set(namesEndpoint,(_url,init)=>{
 publicNameRequests++;assert.equal(init.method,'POST');assert.equal(init.headers.Authorization,undefined);assert.equal(init.headers['User-Agent'],'OptiEVE/1.0');
 assert.equal(init.headers['Content-Type'],'application/json');assert.equal(init.body,'[34,30000142]');assert.equal(init.signal.aborted,false);
 return Response.json(publicFixture,{headers:{expires:'Sun, 01 Nov 2026 00:00:00 GMT'}});
});
const runtimeSnapshot={...env},refreshBeforeNames=refreshUses;
delete env.DB;delete env.EVE_TOKEN_KEY;delete env.EVE_SITE_ORIGIN;
try{
 const resolved=await api.readPublicNames([34,30000142]);
 assert.equal(resolved.data.length,2);assert.equal(resolved.data[0].id,34);assert.equal(resolved.data[0].privateExtra,undefined);assert.equal(resolved.cacheExpires,'Sun, 01 Nov 2026 00:00:00 GMT');assert(Number.isFinite(Date.parse(resolved.retrievedAt)));
 assert.equal(refreshUses,refreshBeforeNames);assert.equal(publicNameRequests,1);
 for(const ids of [null,{},'34',[],[0],[-1],[1.5],[Number.MAX_SAFE_INTEGER+1],[34,34],[null],[true],Array(1),Array.from({length:201},(_,index)=>index+1)])await assert.rejects(api.readPublicNames(ids),e=>e.status===400);
 assert.equal(publicNameRequests,1);
 for(const body of [null,{},[publicFixture[0],publicFixture[0]],[{id:35,name:'Synthetic',category:'inventory_type'}],[{id:34,name:'Synthetic pilot',category:'character'}],[{id:34,name:'Synthetic station',category:'station'}],[{id:34,name:'',category:'inventory_type'}],[{id:34,name:'x'.repeat(16385),category:'inventory_type'}],[{id:'34',name:'Synthetic',category:'inventory_type'}]]){
  fetchOverrides.set(namesEndpoint,Response.json(body));await assert.rejects(api.readPublicNames([34,30000142]),e=>e.status===502);
 }
 for(const body of [[],[publicFixture[0]]]){fetchOverrides.set(namesEndpoint,Response.json(body));assert.equal((await api.readPublicNames([34,30000142])).data.length,body.length);}
 fetchOverrides.set(namesEndpoint,Response.json({error:'private upstream text'},{status:429,headers:{'retry-after':'17'}}));
 await assert.rejects(api.readPublicNames([34]),e=>e.status===429&&!e.message.includes('private upstream'));
 let abortedLookupCalls=0;fetchOverrides.set(namesEndpoint,()=>{abortedLookupCalls++;return Response.json([]);});
 await assert.rejects(api.readPublicNames([34],preAborted.signal),e=>e.status===502);assert.equal(abortedLookupCalls,0);
 const lookupAbort=new AbortController();fetchOverrides.set(namesEndpoint,(_url,init)=>new Promise((resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(Error('Synthetic cancellation')),{once:true});lookupAbort.abort();}));
 await assert.rejects(api.readPublicNames([34],lookupAbort.signal),e=>e.status===502);
}finally{Object.assign(env,runtimeSnapshot);}
fetchOverrides.clear();
// Reconnect preserves the selected owned connection's exact supported subset.
// The scope snapshot and target stay inside encrypted OAuth state, not client input.
await connect();
const reconnectSubset=[charScopes[0],api.scopes.corporation[1],extras[0].scope];
const savedReconnectScopes=JSON.stringify([...reconnectSubset,reconnectSubset[0],'synthetic.unknown.read','esi-mail.send_mail.v1']);
sqlite.prepare('UPDATE eve_connections SET scopes=? WHERE user_id=? AND character_id=?').run(savedReconnectScopes,'user-a',12345);
const reconnectStateCount=()=>sqlite.prepare('SELECT COUNT(*) count FROM eve_oauth_states').get().count;
const reconnectStart=async()=>new URL((await api.startReconnect('user-a',12345)).url).searchParams.get('state');
const unchangedConnection=before=>{const after=connection();for(const key of ['encrypted','scopes','expires','name','corporation_id'])assert.equal(after[key],before[key]);assert.equal(after.refresh_lock,null);assert.equal(after.refresh_until,null);};
for(const invalidId of [undefined,null,0,-1,1.5,'12345',Number.MAX_SAFE_INTEGER+1,{},[]]){
 const before=reconnectStateCount();await assert.rejects(api.startReconnect('user-a',invalidId),error=>error.status===400);assert.equal(reconnectStateCount(),before);
}
for(const [user,id]of [['unconnected-owner',12345],['user-a',54321]]){
 const before=reconnectStateCount();await assert.rejects(api.startReconnect(user,id),error=>error.status===404);assert.equal(reconnectStateCount(),before);
}
for(const malformed of ['not-json','null','{}','[]','[1]','[null]','[""]',JSON.stringify(['esi-mail.send_mail.v1']),JSON.stringify(Array(257).fill(charScopes[0])),JSON.stringify(['x'.repeat(161)]),' '.repeat(32769)]){
 sqlite.prepare('UPDATE eve_connections SET scopes=? WHERE user_id=? AND character_id=?').run(malformed,'user-a',12345);
 const before=reconnectStateCount();await assert.rejects(api.startReconnect('user-a',12345),error=>error.status===400);assert.equal(reconnectStateCount(),before);
}
sqlite.prepare('UPDATE eve_connections SET scopes=? WHERE user_id=? AND character_id=?').run(savedReconnectScopes,'user-a',12345);
const reconnectUrl=new URL((await api.startReconnect('user-a',12345)).url),preserveState=reconnectUrl.searchParams.get('state');
assert.deepEqual(reconnectUrl.searchParams.get('scope').split(' '),reconnectSubset);
assert.equal(reconnectUrl.searchParams.get('code_challenge_method'),'S256');
const preserveRecord=await stateRecord(preserveState),preserveFlow=await api.test.decrypt(preserveRecord.encrypted,`state:user-a:${preserveState}`);
assert.equal(preserveFlow.reconnectCharacterId,12345);assert.equal(preserveFlow.savedScopes,savedReconnectScopes);assert.deepEqual(Array.from(preserveFlow.requested),reconnectSubset);
assert(!preserveRecord.encrypted.includes('reconnectCharacterId'));assert(!reconnectUrl.searchParams.has('reconnectCharacterId'));assert(!reconnectUrl.searchParams.has('savedScopes'));
await api.cancelConnect('user-a',preserveState);
let reconnectProfileReads=0,reconnectTokenReads=0;
fetchOverrides.set(profileEndpoint,()=>{reconnectProfileReads++;return Response.json({name:'Synthetic Pilot',corporation_id:999});});
const reconnectToken=(overrides={})=>fetchOverrides.set(tokenEndpoint,async()=>{reconnectTokenReads++;return Response.json({access_token:await jwt({scp:reconnectSubset,...overrides}),refresh_token:'synthetic-preserved-refresh'});});
const wrongCharacterState=await reconnectStart(),beforeWrongCharacter=connection();
reconnectToken({sub:'CHARACTER:EVE:54321'});
await assert.rejects(api.finishConnect('user-a','synthetic-code',wrongCharacterState),error=>error.status===403&&error.reason==='character_mismatch');
unchangedConnection(beforeWrongCharacter);assert.equal(reconnectProfileReads,0);assert.equal(await stateRecord(wrongCharacterState),undefined);
await assert.rejects(api.finishConnect('user-a','synthetic-replay',wrongCharacterState));assert.equal(reconnectTokenReads,1);
for(const returnedScopes of [reconnectSubset.slice(1),[...reconnectSubset,charScopes[1]],[...reconnectSubset,'esi-mail.send_mail.v1'],[...reconnectSubset,'synthetic.future.read'],[...reconnectSubset,null]]){
 const before=connection(),pending=await reconnectStart();reconnectToken({scp:returnedScopes});
 await assert.rejects(api.finishConnect('user-a','synthetic-code',pending),error=>error.status===403&&error.reason==='permissions');unchangedConnection(before);assert.equal(reconnectProfileReads,0);
}
// Reordered or repeated scope claims are the same set, with no implicit expansion.
reconnectToken({scp:[...reconnectSubset].reverse().concat(reconnectSubset[0])});
await api.finishConnect('user-a','synthetic-code',await reconnectStart());
assert.deepEqual(JSON.parse(connection().scopes),reconnectSubset);assert.equal(reconnectProfileReads,1);
const boundToken=await api.test.decrypt(connection().encrypted,'token:user-a:12345');assert.deepEqual(Array.from(boundToken.authorizedScopes),reconnectSubset);
// A reconnect's bound survives refresh; changed grants leave saved authorization intact.
for(const returnedScopes of [reconnectSubset.slice(1),[...reconnectSubset,charScopes[1]],[...reconnectSubset,'esi-mail.send_mail.v1']]){
 sqlite.prepare('UPDATE eve_connections SET expires=0 WHERE user_id=? AND character_id=?').run('user-a',12345);
 const before=connection();reconnectToken({scp:returnedScopes});
 await assert.rejects(readOrders(),error=>error.status===401&&/changed read permissions/.test(error.message));unchangedConnection(before);
}
reconnectToken({scp:[...reconnectSubset].reverse()});await readOrders();
assert.deepEqual(JSON.parse(connection().scopes),reconnectSubset);assert.deepEqual(Array.from((await api.test.decrypt(connection().encrypted,'token:user-a:12345')).authorizedScopes),reconnectSubset);
// Stale state is rejected before exchange, then checked atomically again at commit.
const earlyStale=await reconnectStart(),beforeEarlyStale=connection(),exchangesBeforeStale=reconnectTokenReads;
sqlite.prepare('UPDATE eve_connections SET scopes=? WHERE user_id=? AND character_id=?').run(JSON.stringify([charScopes[0]]),'user-a',12345);
await assert.rejects(api.finishConnect('user-a','synthetic-code',earlyStale),error=>error.status===409);assert.equal(reconnectTokenReads,exchangesBeforeStale);assert.equal(connection().encrypted,beforeEarlyStale.encrypted);
sqlite.prepare('UPDATE eve_connections SET scopes=? WHERE user_id=? AND character_id=?').run(JSON.stringify(reconnectSubset),'user-a',12345);
const lateStale=await reconnectStart(),beforeLateStale=connection();reconnectToken();
dbHooks.beforeRun=async(sql)=>{if(sql.startsWith('INSERT INTO eve_connections'))sqlite.prepare('UPDATE eve_connections SET scopes=? WHERE user_id=? AND character_id=?').run(JSON.stringify([charScopes[0]]),'user-a',12345);};
try{await assert.rejects(api.finishConnect('user-a','synthetic-code',lateStale),error=>error.status===409);}finally{dbHooks.beforeRun=null;}
assert.equal(connection().encrypted,beforeLateStale.encrypted);assert.deepEqual(JSON.parse(connection().scopes),[charScopes[0]]);
sqlite.prepare('UPDATE eve_connections SET scopes=? WHERE user_id=? AND character_id=?').run(JSON.stringify(reconnectSubset),'user-a',12345);
const cancelledReconnect=await reconnectStart(),beforeReconnectCancel=connection();await api.cancelConnect('user-a',cancelledReconnect);
await assert.rejects(api.finishConnect('user-a','synthetic-code',cancelledReconnect));unchangedConnection(beforeReconnectCancel);
const reconnectReached=deferred(),reconnectRelease=deferred();
fetchOverrides.set(tokenEndpoint,async()=>{reconnectReached.resolve();await reconnectRelease.promise;return Response.json({access_token:await jwt({scp:reconnectSubset}),refresh_token:'synthetic-cancelled-reconnect'});});
const reconnectPending=api.finishConnect('user-a','synthetic-code',await reconnectStart()),reconnectRejected=assert.rejects(reconnectPending,error=>error.status===409);
await reconnectReached.promise;await api.disconnect('user-a',12345);reconnectRelease.resolve();await reconnectRejected;assert.equal(connection(),undefined);
fetchOverrides.clear();await connect();assert.equal((await api.test.decrypt(connection().encrypted,'token:user-a:12345')).authorizedScopes,undefined);
// Old pending flow shape remains compatible and has no reconnect scope bound.
const legacyPending=await begin(),legacyRecord=await stateRecord(legacyPending),legacyFlow=await api.test.decrypt(legacyRecord.encrypted,`state:user-a:${legacyPending}`);
assert.equal(legacyFlow.reconnectCharacterId,undefined);assert.equal(legacyFlow.savedScopes,undefined);
await api.finishConnect('user-a','synthetic-code',legacyPending);assert.equal((await api.test.decrypt(connection().encrypted,'token:user-a:12345')).authorizedScopes,undefined);
// The actual JSON route permits only the target selector for preserved access.
const reconnectRouteModule={exports:{}};
vm.runInNewContext(ts.transpileModule(readFileSync('app/api/eve/[...path]/route.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module:reconnectRouteModule,exports:reconnectRouteModule.exports,require:name=>name==='../../../lib/eve'?api:name==='../../../lib/request-body'?requestBodyModule.exports:{},Request,Response,URL});
const reconnectPost=(body,headers={})=>reconnectRouteModule.exports.POST(new Request('https://example.chatgpt.site/api/eve/connect',{method:'POST',headers:{'oai-authenticated-user-id':'user-a',origin:'https://example.chatgpt.site','content-type':'application/json',...headers},body:JSON.stringify(body)}));
for(const body of [{reconnectCharacterId:12345,corporation:false},{reconnectCharacterId:12345,corporationFeatures:[]},{reconnectCharacterId:12345,scopes:charScopes},{reconnectCharacterId:12345,characterId:12345},{reconnectCharacterId:null},{reconnectCharacterId:'12345'}]){
 const before=reconnectStateCount(),reply=await reconnectPost(body);assert.equal(reply.status,400);assert.equal(reconnectStateCount(),before);
}
assert.equal((await reconnectPost({reconnectCharacterId:12345},{origin:'https://attacker.example'})).status,403);
const reconnectRouteReply=await reconnectPost({reconnectCharacterId:12345});assert.equal(reconnectRouteReply.status,200);assert.equal(reconnectRouteReply.headers.get('cache-control'),'private, no-store');
const reconnectRouteUrl=new URL((await reconnectRouteReply.json()).url);assert.deepEqual(reconnectRouteUrl.searchParams.get('scope').split(' '),Array.from(charScopes));
await api.cancelConnect('user-a',reconnectRouteUrl.searchParams.get('state'));
sqlite.close();
console.log('PASS: encrypted user binding/tamper rejection; signed JWT checks; user-bound one-time OAuth state; no token disclosure; 39-character-scope read-only authorization; optional corporation consent and scope isolation; current corporation reads and role failures; character read ownership/scope checks before refresh; strict endpoint/argument allowlists; object/number/array data; page/mail/calendar/project cursor pagination; lookup-only POST; concurrent refresh lock and rotation; auth/CSRF/disconnect; claimed-state replay/disconnect/expiry/cleanup interleavings; malformed token response preservation; safe invalid-grant recovery; refresh/disconnect/reconnect races; validated ESI page and transaction cursors; safe numeric cooldown advice; cache snapshot metadata; cancellation before refresh and between chained corporation reads; exact supported-subset reconnect; encrypted character/scope binding; callback and refresh grant equality; stale-scope atomic commit; reconnect route exclusivity and legacy-flow compatibility.');
