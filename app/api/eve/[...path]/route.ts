import { requireUser, checkOrigin, getStatus, saveConfig, startConnect, startReconnect, disconnect, publicError, EveError } from "../../../lib/eve";
import { readRequestBody, drainRequestBody, RequestBodyTooLargeError } from "../../../lib/request-body";
import { readOverview } from "../../../lib/overview";
import { readCorporationWorkspace } from "../../../lib/corporation-workspace";
import { readCharacterWorkspace } from "../../../lib/character-workspace";
import { readManufacturingWorkspace } from "../../../lib/manufacturing-workspace";
import { readCharacterAnalytics } from "../../../lib/character-analytics";
import { readWalletAnalytics } from "../../../lib/wallet-analytics";
import { readInventoryAnalytics } from "../../../lib/inventory-analytics";
import { readIndustryAnalytics } from "../../../lib/industry-analytics";
import { readOrderAnalytics } from "../../../lib/order-analytics";
import { readBlueprintAnalytics } from "../../../lib/blueprint-analytics";
import { blueprintReconciliationResponse } from "../../../lib/blueprint-reconciliation-stream";
import { blueprintCollectionResponse } from "../../../lib/blueprint-collection-stream";
export const dynamic="force-dynamic";
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"Cache-Control":"private, no-store","Vary":"oai-authenticated-user-id, Cookie","X-Content-Type-Options":"nosniff"}});
export async function GET(request:Request){try{const user=requireUser(request);if(new URL(request.url).pathname!=="/api/eve/status")throw new EveError("Unknown connection operation.",404);return json(await getStatus(user));}catch(e){const value=publicError(e);return json({error:value.error},value.status);}}
export async function POST(request:Request){
 try{
  const user=requireUser(request);checkOrigin(request);if(!request.headers.get("content-type")?.startsWith("application/json"))throw new EveError("Send a JSON request.",415);const raw=await readRequestBody(request,new URL(request.url).pathname==="/api/eve/manufacturing"?65536:4096);let parsed:unknown;try{parsed=JSON.parse(raw);}catch{throw new EveError("Invalid JSON request.");}if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw new EveError("Invalid request.");const data=parsed as Record<string,unknown>;
  switch(new URL(request.url).pathname){case "/api/eve/config":return json(await saveConfig(user,data.clientId));case "/api/eve/connect":if(Object.hasOwn(data,'reconnectCharacterId')){if(Object.keys(data).some(key=>key!=='reconnectCharacterId'))throw new EveError("Reconnect must keep existing read permissions or use a separate explicit access choice.");return json(await startReconnect(user,data.reconnectCharacterId));}if(Object.keys(data).some(key=>!['corporation','corporationFeatures'].includes(key)))throw new EveError("Unexpected connection option.");if(data.corporation!==undefined&&typeof data.corporation!=="boolean")throw new EveError("Choose whether to include corporation data.");return json(await startConnect(user,data.corporation===true,data.corporationFeatures));case "/api/eve/overview":return json(await readOverview(user,data,{signal:request.signal}));case "/api/eve/corporation-workspace":return json(await readCorporationWorkspace(user,data,{signal:request.signal}));case "/api/eve/character-workspace":return json(await readCharacterWorkspace(user,data,{signal:request.signal}));case "/api/eve/character-analytics":return json(await readCharacterAnalytics(user,data,{signal:request.signal}));case "/api/eve/wallet-analytics":return json(await readWalletAnalytics(user,data,{signal:request.signal}));case "/api/eve/inventory-analytics":return json(await readInventoryAnalytics(user,data,{signal:request.signal}));case "/api/eve/industry-analytics":return json(await readIndustryAnalytics(user,data,{signal:request.signal}));case "/api/eve/order-analytics":return json(await readOrderAnalytics(user,data,{signal:request.signal}));case "/api/eve/blueprint-analytics":return json(await readBlueprintAnalytics(user,data,{signal:request.signal}));case "/api/eve/blueprint-reconciliation":return blueprintReconciliationResponse(user,data,request.signal);case "/api/eve/blueprint-collection":return blueprintCollectionResponse(user,data,request.signal);case "/api/eve/manufacturing":return json(await readManufacturingWorkspace(user,data,{signal:request.signal}));case "/api/eve/disconnect":return json(await disconnect(user,data.characterId));default:throw new EveError("Unknown connection operation.",404);}
 }catch(e){if(e instanceof RequestBodyTooLargeError)return json({error:e.message},413);const value=publicError(e);return json({error:value.error},value.status);}
 finally {
  // Vinext transfers the body to this Request, so Wrangler's outer middleware
  // cannot drain it after an early 401/403/415. Leaving it unread can break the
  // next local request on Windows. Discard chunks without buffering or logging.
  await drainRequestBody(request);
 }
}
