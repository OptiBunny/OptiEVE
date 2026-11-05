import { requireUser, finishConnect, cancelConnect, publicError, EveError, connectionFailureReasons } from "../../lib/eve";
export const dynamic="force-dynamic";
export async function GET(request:Request){
 const url=new URL(request.url);let result="failed",reason="",upstreamStatus:number|undefined;
 try{const user=requireUser(request);if(url.searchParams.has("error")){await cancelConnect(user,url.searchParams.get("state")||"");result="cancelled";}else{await finishConnect(user,url.searchParams.get("code")||"",url.searchParams.get("state")||"");result="connected";}}
 catch(error){
  const safe=publicError(error);
  reason=error instanceof EveError&&error.reason&&connectionFailureReasons.includes(error.reason)?error.reason:/expired sign-in|sign-in expired|already been used/.test(safe.error)?"expired":/sign-in could not be verified|Invalid character identity/.test(safe.error)?"verification":/(?:required|requested) read permissions/.test(safe.error)?"permissions":safe.status===401?"authorization":safe.status>=500?"service":"failed";
  if(error instanceof EveError&&typeof error.upstreamStatus==='number'&&Number.isInteger(error.upstreamStatus)&&error.upstreamStatus>=100&&error.upstreamStatus<=599)upstreamStatus=error.upstreamStatus;
 }
 return new Response(null,{status:303,headers:{Location:`/?eve=${result}${reason?`&reason=${reason}`:""}${upstreamStatus?`&http=${upstreamStatus}`:""}`,"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
}
