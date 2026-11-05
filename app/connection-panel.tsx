'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callbackError, connectionAccessPreset, connectionRequest, connectionStatus, ConnectionResponseError, reconnectAuthorization, reconnectReviewIsCurrent, reviewReconnect, selectedConnectionScopes, signInUrl, type ConnectionStatus, type ReconnectReview } from './lib/connection-client';
import OverviewPanel from './overview-panel';
import CorporationPanel from './corporation-panel';
import CharacterPanel from './character-panel';
import ManufacturingPanel from './manufacturing-panel';
import CharacterAnalyticsPanel from './character-analytics-panel';
import WalletAnalyticsPanel from './wallet-analytics-panel';
import InventoryAnalyticsPanel from './inventory-analytics-panel';
import IndustryAnalyticsPanel from './industry-analytics-panel';
import OrderAnalyticsPanel from './order-analytics-panel';
import BlueprintAnalyticsPanel from './blueprint-analytics-panel';
export default function ConnectionPanel(){
 const [origin,setOrigin]=useState('');
 const [status,setStatus]=useState<ConnectionStatus|null>(null),[clientId,setClientId]=useState(''),[corporation,setCorporation]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
 const [statusLoading,setStatusLoading]=useState(true),[statusError,setStatusError]=useState(''),[signedOut,setSignedOut]=useState(false);
 const [tab,setTab]=useState<'overview'|'corporation'|'reputation'|'industry'|'manufacturing'|'training'|'wallet'|'inventory'|'jobs'|'orders'|'blueprints'|'connections'>('overview');
 const [corporationFeatures,setCorporationFeatures]=useState<string[]>([]);
 const [accessPreset,setAccessPreset]=useState<'character'|'all'|'custom'>('character');
 const [reconnectReview,setReconnectReview]=useState<ReconnectReview|null>(null);
 const accessReview=useRef<HTMLElement|null>(null);
 const requestSequence=useRef(0);
 const reload=useCallback(async()=>{
  const sequence=++requestSequence.current;setStatusLoading(true);setStatusError('');setSignedOut(false);
  try{const value=connectionStatus(await connectionRequest('status'));if(sequence!==requestSequence.current)return false;setStatus(value);setClientId(value.clientId||'');setReconnectReview(current=>current&&reconnectReviewIsCurrent(value,current)?current:null);return true;}
  catch(e){if(sequence!==requestSequence.current)return false;setStatus(null);setReconnectReview(null);setStatusError((e as Error).message);setSignedOut(e instanceof ConnectionResponseError&&e.status===401);return false;}
  finally{if(sequence===requestSequence.current)setStatusLoading(false);}
 },[]);
 const invalidateStatusRequests=useCallback(()=>{requestSequence.current++;},[]);
 useEffect(()=>{
  // Consume browser-only OAuth redirect state once, after server hydration.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  setOrigin(window.location.origin);
  void reload();
  const q=new URLSearchParams(location.search);
  if(q.get('eve')==='connected')setNotice('Character connected. Load an overview or use the OptiEVE plugin in ChatGPT.');
  if(q.get('eve')==='failed')setError(callbackError(q.get('reason')));
  if(q.get('eve')==='cancelled')setError('EVE authorization was cancelled. You can start again below.');
  if(q.size)history.replaceState(null,'','/');
  return invalidateStatusRequests;
 },[reload,invalidateStatusRequests]);
 async function connect(){setBusy(true);setError('');try{if(!status)throw new ConnectionResponseError('Reload connection status before continuing.');let body;if(reconnectReview){body=reconnectAuthorization(status,reconnectReview);}else{selectedConnectionScopes(status,{corporation,corporationFeatures});if(!status.configured||clientId!==status.clientId)await connectionRequest('config',{clientId:clientId.trim()});body={corporation,corporationFeatures};}const result=await connectionRequest('connect',body);window.location.assign(signInUrl(result));}catch(e){setError((e as Error).message);if(e instanceof ConnectionResponseError&&e.status===401)void reload();setBusy(false);}}
 function choosePreset(preset:'character'|'all'){if(!status)return;const selection=connectionAccessPreset(status,preset);setReconnectReview(null);setAccessPreset(preset);setCorporation(selection.corporation);setCorporationFeatures(selection.corporationFeatures);setError('');setNotice('');}
 function reconnect(id:number){if(!status)return;try{setReconnectReview(reviewReconnect(status,id));setError('');setNotice('');accessReview.current?.focus();accessReview.current?.scrollIntoView({block:'start'});}catch(e){setError((e as Error).message);}}
 async function disconnect(id:number){setBusy(true);setError('');try{await connectionRequest('disconnect',{characterId:id});setNotice('Character removed and pending sign-ins cancelled. You can also revoke the app on EVE’s Authorized Applications page.');await reload();}catch(e){setError((e as Error).message);if(e instanceof ConnectionResponseError&&e.status===401)void reload();}finally{setBusy(false);}}
 async function copy(value:string){try{await navigator.clipboard.writeText(value);setNotice('Copied.');}catch{setError('Copy unavailable. Select and copy the value shown.');}}
 const features=status?.corporationFeatures??[];
 const selection={corporation,corporationFeatures};
 const validSelection=features.length===0?corporationFeatures.length===0:corporationFeatures.every(id=>features.some(feature=>feature.id===id));
 const scopes=reconnectReview?.scopes??(status&&validSelection?selectedConnectionScopes(status,selection):[]);
 return <main className="shell">
  <header><div className="brand"><span className="mark">O</span><span>Opti<span className="muted">EVE</span></span></div><span className="badge">PRIVATE · READ ONLY</span></header>
  <section className="hero"><p className="eyebrow">YOUR OPERATIONS, CONNECTED</p><h1>Your EVE operations,<br/>at a glance.</h1><p className="intro">A private overview of your finances, training and work in progress. Connect your characters and bring the details into the conversation.</p><a className="button secondary" href="/demo">Explore the synthetic manufacturing demo</a></section>
  <nav className="workspace-nav" aria-label="OptiEVE workspace"><button aria-current={tab==='training'?'page':undefined} onClick={()=>setTab('training')}>Skills &amp; training</button><button aria-current={tab==='wallet'?'page':undefined} onClick={()=>setTab('wallet')}>Wallet activity</button><button aria-current={tab==='overview'?'page':undefined} onClick={()=>setTab('overview')}>Overview</button><button aria-current={tab==='corporation'?'page':undefined} onClick={()=>setTab('corporation')}>Corporation</button><button aria-current={tab==='orders'?'page':undefined} onClick={()=>setTab('orders')}>Open orders</button><button aria-current={tab==='blueprints'?'page':undefined} onClick={()=>setTab('blueprints')}>Blueprint analytics</button><button aria-current={tab==='inventory'?'page':undefined} onClick={()=>setTab('inventory')}>Inventory</button><button aria-current={tab==='jobs'?'page':undefined} onClick={()=>setTab('jobs')}>Industry jobs</button><button aria-current={tab==='industry'?'page':undefined} onClick={()=>setTab('industry')}>Industry</button><button aria-current={tab==='manufacturing'?'page':undefined} onClick={()=>setTab('manufacturing')}>Manufacturing</button><button aria-current={tab==='reputation'?'page':undefined} onClick={()=>setTab('reputation')}>Reputation</button><button aria-current={tab==='connections'?'page':undefined} onClick={()=>setTab('connections')}>Connections</button></nav>
  {error&&<div className="alert" role="alert">{error}</div>}{notice&&<div className="notice" role="status">{notice}</div>}
  {statusError&&<div className="alert" role="alert"><p>{statusError}</p>{signedOut&&<a className="button secondary" href="/signin-with-chatgpt?return_to=%2F" target="_top">Sign in with ChatGPT</a>} <button className="small" disabled={statusLoading||busy} onClick={()=>void reload()}>Try again</button></div>}
  {tab==='training'&&status&&!statusLoading&&<CharacterAnalyticsPanel key={'training-'+JSON.stringify(status.characters)} characters={status.characters} openConnections={()=>setTab('connections')}/>}
  {tab==='orders'&&status&&!statusLoading&&<OrderAnalyticsPanel key={'orders-'+JSON.stringify(status.characters)} characters={status.characters} openConnections={()=>setTab('connections')}/>}
  {tab==='blueprints'&&status&&!statusLoading&&<BlueprintAnalyticsPanel key={'blueprints-'+JSON.stringify(status.characters)} characters={status.characters} openConnections={()=>setTab('connections')}/>}
  {tab==='inventory'&&status&&!statusLoading&&<InventoryAnalyticsPanel key={'inventory-'+JSON.stringify(status.characters)} characters={status.characters} openConnections={()=>setTab('connections')}/>}
  {tab==='jobs'&&status&&!statusLoading&&<IndustryAnalyticsPanel key={'jobs-'+JSON.stringify(status.characters)} characters={status.characters} openConnections={()=>setTab('connections')}/>}
  {tab==='wallet'&&status&&!statusLoading&&<WalletAnalyticsPanel key={'wallet-'+JSON.stringify(status.characters)} characters={status.characters} openConnections={()=>setTab('connections')}/>}
  {tab==='overview'&&status&&!statusLoading&&<OverviewPanel key={JSON.stringify(status.characters)} characters={status.characters} openConnections={()=>setTab('connections')}/>}
  {tab==='corporation'&&status&&!statusLoading&&<CorporationPanel key={JSON.stringify(status.characters)} characters={status.characters} openConnections={()=>setTab('connections')}/>}
  {tab==='reputation'&&status&&!statusLoading&&<CharacterPanel key={'reputation-'+JSON.stringify(status.characters)} mode="reputation" characters={status.characters} openConnections={()=>setTab('connections')}/>}
  {tab==='industry'&&status&&!statusLoading&&<CharacterPanel key={'industry-'+JSON.stringify(status.characters)} mode="industry" characters={status.characters} openConnections={()=>setTab('connections')}/> }
  {tab==='manufacturing'&&status&&!statusLoading&&<ManufacturingPanel key={'manufacturing-'+JSON.stringify(status.characters)} characters={status.characters} openConnections={()=>setTab('connections')}/>}
  {tab!=='connections'&&statusLoading&&<p className="overview-state" role="status">Loading connection status…</p>}
  {tab==='connections'&&<div className="grid"><section className="panel"><div className="section-title"><span className="step">01</span><h2>{status?.configured?'EVE application ready':'Register your EVE application'}</h2></div>
   <p>This one-time setup gives your private connector permission to use EVE’s official sign-in.</p>
   {!status?.configured&&<><a className="button secondary" href="https://developers.eveonline.com/applications" target="_blank" rel="noreferrer">Open EVE Developer Applications ↗</a><ol><li>Create an application named <strong>OptiEVE</strong>.</li><li>Select <strong>Authentication &amp; API Access</strong> if a connection type is requested.</li><li>Use the callback URL below and add the read scopes shown.</li><li>Create the application, then copy its <strong>Client ID</strong> here.</li></ol></>}
   <label>Callback URL</label><div className="copy"><code>{status?.callbackUrl||(origin?origin+'/eve/callback':'Loading callback URL…')}</code><button disabled={!status?.callbackUrl&&!origin} onClick={()=>copy(status?.callbackUrl||origin+'/eve/callback')}>Copy</button></div>
   <details><summary>Application details &amp; read scopes</summary><p>Website URL: <a href={status?.setupUrl||origin||undefined}>{status?.setupUrl||origin||'Loading website URL…'}</a></p><p>Description: Private read-only review of EVE character data.</p><p>Add these scopes to the developer application. This list matches your access selection in Step 2, including the exact retained permissions when reviewing a reconnect.</p><pre>{scopes.length?scopes.join('\n'):statusLoading?'Loading scope list…':'No supported permissions are selected. Review Step 2 or reload connection status.'}</pre><button className="small" disabled={!scopes.length} onClick={()=>copy(scopes.join('\n'))}>Copy scope list</button><p>EVE calls the planetary-data scope “manage_planets”; OptiEVE uses it only to read your colonies.</p><p>No Client Secret is needed. Your EVE password is entered only on EVE’s login page.</p></details>
   <label htmlFor="clientId">Client ID</label><input id="clientId" value={clientId} onChange={e=>setClientId(e.target.value)} placeholder="Paste the public Client ID" autoComplete="off" spellCheck={false} disabled={busy||!!status?.characters.length}/>
  </section><div><section ref={accessReview} tabIndex={-1} className="panel access-review" aria-labelledby="authorization-heading"><div className="section-title"><span className="step">02</span><h2 id="authorization-heading">{reconnectReview?'Reconnect '+reconnectReview.name:'Add a character or change access'}</h2></div>
   <p>{reconnectReview?'Review the permissions to keep, then choose this character on EVE’s sign-in page.':'Choose the intended character on EVE’s sign-in page. This selection replaces the requested permissions for that character, or adds a new connection.'}</p>
   <fieldset className="access-presets"><legend>Read access</legend>
    {reconnectReview&&<label className="check"><input type="radio" name="read-access" aria-label="Keep existing permissions" checked readOnly disabled={busy}/><span><strong>Keep existing permissions</strong><small>Retain this character’s supported saved permissions. Newly available read permissions are not added.</small></span></label>}
    <label className="check"><input type="radio" name="read-access" aria-label="Character only" checked={!reconnectReview&&accessPreset==='character'} onChange={()=>choosePreset('character')} disabled={busy||statusLoading||!status}/><span><strong>Character only</strong><small>All supported character reads, including finances, inventory, training, private mail and current location.</small></span></label>
    <label className="check"><input type="radio" name="read-access" aria-label="All read-only access" checked={!reconnectReview&&accessPreset==='all'} onChange={()=>choosePreset('all')} disabled={busy||statusLoading||!status}/><span><strong>All read-only access</strong><small>All supported character and corporation reads. EVE corporation roles still control which data is available.</small></span></label>
   </fieldset>
   <div className="access-selection" role="status"><strong>{reconnectReview?'Keep existing permissions':accessPreset==='all'?'All read-only access':accessPreset==='custom'?'Custom read access':'Character only'} · {scopes.length} read permissions</strong>
    {reconnectReview?<><p>This reconnect preserves the selected permissions for {reconnectReview.name}. Choosing a preset above starts a new permission selection instead.</p>{reconnectReview.omittedScopeCount>0&&<p>{reconnectReview.omittedScopeCount} unsupported saved {reconnectReview.omittedScopeCount===1?'permission will':'permissions will'} not be requested.</p>}{!scopes.length&&<p>No supported permissions remain. Choose an access preset to continue.</p>}<button className="small" disabled={busy} onClick={()=>{setReconnectReview(null);setError('');}}>Cancel reconnect review</button></>:<p>Review the scope list in Step 1 and add any missing scopes to your EVE developer application before continuing. Existing character permissions change only after authorization.</p>}
   </div>
   <details className="advanced-access"><summary>Advanced corporation permissions</summary>
    {reconnectReview?<p className="fine">To change permissions, choose Character only or All read-only access above first. Keeping existing permissions preserves even a smaller saved selection.</p>:<fieldset className="permission-options"><legend>Optional corporation reads</legend><p className="fine">Choose individual corporation features. This changes the current preset to Custom read access.</p>
     <label className="check"><input type="checkbox" checked={corporation} onChange={e=>{setCorporation(e.target.checked);setAccessPreset('custom');}} disabled={busy||statusLoading||!status}/><span><strong>Orders, wallet &amp; assets</strong><small>Orders and wallet history require appropriate corporation roles; corporation assets require Director. These are separate from the optional permissions below.</small></span></label>
     {features.map(feature=><label className="check" key={feature.id}><input type="checkbox" checked={corporationFeatures.includes(feature.id)} onChange={event=>{setCorporationFeatures(current=>event.target.checked?[...current,feature.id]:current.filter(id=>id!==feature.id));setAccessPreset('custom');}} disabled={busy||statusLoading||!status}/><span><strong>{feature.label}</strong><small>{feature.description}</small></span></label>)}
     {!features.length&&<p className="fine">Optional corporation permissions are unavailable until the connection service is updated.</p>}</fieldset>}
   </details>
   {!validSelection&&!reconnectReview&&<p className="alert" role="alert">Available permissions changed. Choose an access preset again.</p>}
   <button className="button primary" onClick={connect} disabled={busy||statusLoading||!clientId.trim()||!status||!scopes.length||(!reconnectReview&&!validSelection)}>{busy?'Working…':'Continue to EVE sign-in →'}</button><p className="fine">Data is fetched when requested; the connector does not keep account history. This connection cannot place orders, change prices, move assets or spend ISK. EVE caches data, so updates may take time to appear.</p><a className="button secondary" href="/demo">Explore the synthetic manufacturing demo</a></section>
   <section className="panel connected"><div className="section-title"><span className="step">03</span><h2>Connected characters</h2></div>{!status?<p>{statusLoading?'Loading connection status…':'Connection status is unavailable.'}</p>:status.characters.length===0?<p className="empty">No EVE characters connected yet.</p>:status.characters.map(c=><div className="character" key={c.characterId}><div><strong>{c.name}</strong><small>Character {c.characterId} · Corporation {c.corporationId}</small>{status.scopes.character.some(scope=>!c.scopes.includes(scope))&&<small>New read features available. Choose an access preset to add them; Reconnect keeps existing permissions.</small>}</div><div className="character-actions"><button className="small" aria-label={'Reconnect '+c.name} disabled={busy||statusLoading} onClick={()=>reconnect(c.characterId)}>Reconnect</button><button className="small" disabled={busy||statusLoading} onClick={()=>disconnect(c.characterId)}>Disconnect</button></div></div>)}<p>In ChatGPT, select <strong>OptiEVE</strong> from your personal plugins. Then ask: “Summarize my market orders and inventory.”</p><a className="text-link" href="https://chatgpt.com/plugins" target="_blank" rel="noreferrer">Open ChatGPT Plugins ↗</a></section></div></div>}
  <footer>Connected through CCP’s ESI API · Access credentials stay encrypted on the server · <a href="https://developers.eveonline.com/authorized-apps" target="_blank" rel="noreferrer">Manage EVE authorization ↗</a></footer>
  </main>;
}
