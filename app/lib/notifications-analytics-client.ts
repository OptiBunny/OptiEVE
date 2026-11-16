import { z } from 'zod';
import { ConnectionResponseError } from './connection-client';
import { notificationTypes, type NotificationsAnalytics, type NotificationsAnalyticsArgs, type NotificationType } from './notifications-analytics-types';
const id=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),count=z.number().int().min(0).max(1000),positive=count.min(1),type=z.enum(notificationTypes).nullable();
const stamp=z.string().length(24).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v);
const day=z.string().length(10).regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v),text=z.string().max(2048);
const schema=z.strictObject({characterId:id,generatedAt:stamp,status:z.enum(['ready','partial','needs_permission','unavailable','error']),message:text,scope:z.literal('esi-characters.read_notifications.v1'),coverage:z.strictObject({kind:z.enum(['returned_response','unavailable']),notifications:count.nullable()}),freshness:z.strictObject({state:z.enum(['fresh','stale','unknown']),retrievedAt:stamp.nullable(),cacheExpires:stamp.nullable(),lastModified:stamp.nullable()}),summary:z.strictObject({notifications:count,read:count,unread:count,unrecognizedTypeNotifications:count,reportedDates:count,knownTypeGroups:count.max(254),firstDate:day.nullable(),lastDate:day.nullable()}).nullable(),daily:z.array(z.strictObject({date:day,notifications:positive,read:count,unread:count})).max(1000),byType:z.array(z.strictObject({type,notifications:positive,read:count,unread:count})).max(255),cells:z.array(z.strictObject({date:day,type,isRead:z.boolean(),notifications:positive})).max(1000),limitations:z.array(text).max(20)});
const invalid=()=>new ConnectionResponseError('The notifications response could not be validated safely. Load it again.');
function selection(value:unknown):NotificationsAnalyticsArgs{const fail=()=>new ConnectionResponseError('Choose one connected character.');if(!value||typeof value!=='object'||Array.isArray(value))throw fail();const prototype=Object.getPrototypeOf(value);if(prototype!==null&&Object.getPrototypeOf(prototype)!==null)throw fail();for(const key of Reflect.ownKeys(value))if(key!=='characterId'||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)??{},'value'))throw fail();for(const key in value)if(!Object.hasOwn(value,key))throw fail();const input=value as NotificationsAnalyticsArgs;if(!Object.hasOwn(input,'characterId')||!id.safeParse(input.characterId).success)throw fail();return{characterId:input.characterId};}
const compareType=(a:NotificationType|null,b:NotificationType|null)=>a===b?0:a===null?1:b===null?-1:a<b?-1:1;
export function notificationsAnalyticsResponse(value:unknown,input:NotificationsAnalyticsArgs):NotificationsAnalytics{
 const selected=selection(input),parsed=schema.safeParse(value);if(!parsed.success)throw invalid();const result=parsed.data,now=Date.parse(result.generatedAt),fresh=result.freshness;
 if(result.characterId!==selected.characterId||new TextEncoder().encode(JSON.stringify(result)).byteLength>2*1024*1024)throw invalid();
 if(result.summary===null){if(result.status==='ready'||result.status==='partial'||result.coverage.kind!=='unavailable'||result.coverage.notifications!==null||result.cells.length||result.daily.length||result.byType.length||fresh.state!=='unknown'||fresh.retrievedAt!==null||fresh.cacheExpires!==null||fresh.lastModified!==null)throw invalid();return result;}
 if(fresh.retrievedAt===null||Date.parse(fresh.retrievedAt)>now+60000||fresh.state!==(fresh.cacheExpires===null?'unknown':Date.parse(fresh.cacheExpires)<=now?'stale':'fresh'))throw invalid();
 const dates=new Map<string,{date:string;notifications:number;read:number;unread:number}>(),types=new Map<NotificationType|null,{type:NotificationType|null;notifications:number;read:number;unread:number}>();let total=0,read=0,unrecognized=0;
 for(let i=0;i<result.cells.length;i++){const cell=result.cells[i],previous=result.cells[i-1];if(previous){const order=previous.date===cell.date?compareType(previous.type,cell.type):previous.date<cell.date?-1:1;if(order>0||order===0&&Number(previous.isRead)>=Number(cell.isRead))throw invalid();}
 total+=cell.notifications;if(total>1000)throw invalid();read+=cell.isRead?cell.notifications:0;if(cell.type===null)unrecognized+=cell.notifications;
 const daily=dates.get(cell.date)??{date:cell.date,notifications:0,read:0,unread:0};daily.notifications+=cell.notifications;daily[cell.isRead?'read':'unread']+=cell.notifications;dates.set(cell.date,daily);
 const group=types.get(cell.type)??{type:cell.type,notifications:0,read:0,unread:0};group.notifications+=cell.notifications;group[cell.isRead?'read':'unread']+=cell.notifications;types.set(cell.type,group);
 }
 const daily=[...dates.values()].sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:0),byType=[...types.values()].sort((a,b)=>compareType(a.type,b.type)),summary={notifications:total,read,unread:total-read,unrecognizedTypeNotifications:unrecognized,reportedDates:daily.length,knownTypeGroups:byType.filter(v=>v.type!==null).length,firstDate:daily[0]?.date??null,lastDate:daily.at(-1)?.date??null};
 if(JSON.stringify(daily)!==JSON.stringify(result.daily)||JSON.stringify(byType)!==JSON.stringify(result.byType)||Object.entries(summary).some(([key,value])=>result.summary![key as keyof typeof summary]!==value)||result.coverage.kind!=='returned_response'||result.coverage.notifications!==total||result.status!==(fresh.state==='fresh'&&unrecognized===0?'ready':'partial'))throw invalid();return result;
}
async function readBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw invalid();
  const limit = 2 * 1024 * 1024, reader = response.body.getReader(); let buffer = new Uint8Array(16384), length = 0;
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
export async function notificationsAnalyticsRequest(args: NotificationsAnalyticsArgs, signal?: AbortSignal): Promise<NotificationsAnalytics> {
  const selected = selection(args), controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(abort, 60000); let response: Response | undefined;
  try {
    controller.signal.throwIfAborted(); response = await fetch('/api/eve/notifications-analytics', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selected), signal: controller.signal }); controller.signal.throwIfAborted();
    if (!response.ok) throw new ConnectionResponseError(response.status === 401 ? 'Sign in again to read notifications.' : response.status === 404 ? 'This character is no longer connected. Reload connection status.' : 'Notifications could not be loaded. Try again or review the connection.', response.status);
    if (!response.headers.get('content-type')?.includes('application/json')) throw invalid();
    const result = notificationsAnalyticsResponse(await readBody(response, controller.signal), selected); controller.signal.throwIfAborted(); return result;
  } catch (error) {
    if (error instanceof ConnectionResponseError) throw error;
    throw new ConnectionResponseError(controller.signal.aborted ? 'The notifications request was cancelled or timed out.' : 'The notifications service could not be reached. Try again.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
}
