import { z } from 'zod';
import { ConnectionResponseError } from './connection-client';
import type { MarketHistoryArgs, MarketHistoryResponse } from './market-history-types';
const LIMIT=512*1024,DAY=86400000,MAX=Number.MAX_SAFE_INTEGER;
const id=z.number().int().min(1).max(MAX),count=z.number().int().min(0).max(MAX);
const stamp=z.string().length(24).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v);
const date=z.string().length(10).regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v);
const decimal=z.string().max(64).regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/),whole=z.string().max(18).regex(/^(?:0|[1-9]\d*)$/),text=z.string().max(2048);
const schema=z.strictObject({regionId:id,typeId:id,generatedAt:stamp,window:z.strictObject({days:id.max(90),startUTC:date,endExclusiveUTC:date,reportedDays:count.max(90),missingDays:count.max(90)}),rows:z.array(z.strictObject({date,volume:count,orderCount:count,lowestISK:decimal,highestISK:decimal,averageISK:decimal})).max(90),totalReportedVolume:whole,totalReportedOrderCount:whole,averageVolumePerReportedDay:z.string().max(20).regex(/^(?:0|[1-9]\d*)\.\d{2}$/).nullable(),sourceFreshness:z.enum(['fresh','stale','unknown']),sources:z.array(z.strictObject({url:z.string().max(2048),retrievedAt:stamp,cacheExpires:stamp.nullable(),lastModified:stamp.nullable(),cacheControl:z.string().max(256).regex(/^[^\x00-\x1f\x7f]*$/).nullable()})).length(1),limitations:z.array(text).max(20)});
const invalid=()=>new ConnectionResponseError('The regional market history could not be validated safely. Load it again.');
function selection(value:unknown):Required<MarketHistoryArgs>{
 const fail=()=>new ConnectionResponseError('Choose public region and item IDs, and 1–90 days.');
 if(!value||typeof value!=='object'||Array.isArray(value))throw fail();const prototype=Object.getPrototypeOf(value);if(prototype!==null&&Object.getPrototypeOf(prototype)!==null)throw fail();
 for(const key of Reflect.ownKeys(value))if(!['regionId','typeId','days'].includes(key as string)||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)??{},'value'))throw fail();for(const key in value)if(!Object.hasOwn(value,key))throw fail();
 const input=value as MarketHistoryArgs;if(!Object.hasOwn(input,'regionId')||!Object.hasOwn(input,'typeId')||!id.safeParse(input.regionId).success||!id.safeParse(input.typeId).success||Object.hasOwn(input,'days')&&!id.max(90).safeParse(input.days).success)throw fail();return{regionId:input.regionId,typeId:input.typeId,days:input.days??30};
}
function compare(a:string,b:string){const scale=Math.max(a.split('.')[1]?.length??0,b.split('.')[1]?.length??0),units=(v:string)=>{const[w,f='']=v.split('.');return BigInt(w+f.padEnd(scale,'0'));},left=units(a),right=units(b);return left<right?-1:left>right?1:0;}
export function marketHistoryResponse(value:unknown,input:MarketHistoryArgs):MarketHistoryResponse{
 const selected=selection(input),parsed=schema.safeParse(value);if(!parsed.success)throw invalid();const result=parsed.data,now=Date.parse(result.generatedAt),today=result.generatedAt.slice(0,10),end=Date.parse(today+'T00:00:00Z'),startStamp=new Date(end-selected.days*DAY).toISOString(),source=result.sources[0];
 if(startStamp.length!==24||result.regionId!==selected.regionId||result.typeId!==selected.typeId||result.window.days!==selected.days||result.window.startUTC!==startStamp.slice(0,10)||result.window.endExclusiveUTC!==today||result.window.reportedDays!==result.rows.length||result.window.missingDays!==selected.days-result.rows.length||new TextEncoder().encode(JSON.stringify(result)).byteLength>LIMIT)throw invalid();
 if(source.url!==`https://esi.evetech.net/markets/${selected.regionId}/history?type_id=${selected.typeId}`||Date.parse(source.retrievedAt)>now+60000||result.sourceFreshness!==(source.cacheExpires===null?'unknown':Date.parse(source.cacheExpires)<=now?'stale':'fresh'))throw invalid();
 let volume=0n,orders=0n;for(let i=0;i<result.rows.length;i++){const row=result.rows[i];if(row.date<result.window.startUTC||row.date>=today||i>0&&result.rows[i-1].date>=row.date||compare(row.highestISK,'1000000000000000')>0||compare(row.lowestISK,row.averageISK)>0||compare(row.averageISK,row.highestISK)>0)throw invalid();volume+=BigInt(row.volume);orders+=BigInt(row.orderCount);}
 const rounded=result.rows.length?(volume*100n+BigInt(Math.floor(result.rows.length/2)))/BigInt(result.rows.length):null,mean=rounded===null?null:`${rounded/100n}.${String(rounded%100n).padStart(2,'0')}`;
 if(result.totalReportedVolume!==String(volume)||result.totalReportedOrderCount!==String(orders)||result.averageVolumePerReportedDay!==mean)throw invalid();return result;
}
async function readBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw invalid();
  const limit = 512 * 1024, reader = response.body.getReader(); let buffer = new Uint8Array(16384), length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) { abort(); return; }
        reader.read().then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
      });
      signal.throwIfAborted(); if (part.done) break;
      if (!(part.value instanceof Uint8Array) || part.value.byteLength > limit - length) throw invalid();
      if (length + part.value.byteLength > buffer.length) { const next = new Uint8Array(Math.min(limit, Math.max(buffer.length * 2, length + part.value.byteLength))); next.set(buffer.subarray(0, length)); buffer = next; }
      buffer.set(part.value, length); length += part.value.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))); signal.throwIfAborted(); return value;
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function marketHistoryRequest(args: MarketHistoryArgs, signal?: AbortSignal): Promise<MarketHistoryResponse> {
  const selected = selection(args), controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(abort, 60000); let response: Response | undefined;
  try {
    controller.signal.throwIfAborted(); response = await fetch('/api/eve/market-history', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selected), signal: controller.signal }); controller.signal.throwIfAborted();
    if (!response.ok) throw new ConnectionResponseError(response.status === 401 ? 'Sign in again to read regional market history.' : response.status === 404 ? 'This public region or item history was not found. Review the selection.' : 'Regional market history could not be loaded. Review the selection or try later.', response.status);
    if (!response.headers.get('content-type')?.includes('application/json')) throw invalid();
    const result = marketHistoryResponse(await readBody(response, controller.signal), selected); controller.signal.throwIfAborted(); return result;
  } catch (error) {
    if (error instanceof ConnectionResponseError) throw error;
    throw new ConnectionResponseError(controller.signal.aborted ? 'The market history request was cancelled or timed out.' : 'The market history service could not be reached. Try again.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
}
