'use client';
import { useEffect, useRef, useState } from 'react';
import { ConnectionResponseError, type Character } from './lib/connection-client';
import { orderAnalyticsRequest } from './lib/order-analytics-client';
import type { OrderAnalytics } from './lib/order-analytics-types';
import { utcTime } from './operations-charts';
import OrderExplorer from './order-explorer';
export default function OrderAnalyticsPanel({ characters, openConnections, initialCharacterId }: { characters: Character[]; openConnections: () => void; initialCharacterId?: number }) {
  const [characterId, setCharacterId] = useState(initialCharacterId === undefined ? characters[0]?.characterId ?? 0 : characters.some(character => character.characterId === initialCharacterId) ? initialCharacterId : 0), [entity, setEntity] = useState<'character' | 'corporation'>('character');
  const [result, setResult] = useState<OrderAnalytics | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [signedOut, setSignedOut] = useState(false), [generation, setGeneration] = useState(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  function clear() { request.current?.abort(); request.current = null; setGeneration(value => value + 1); setResult(null); setBusy(false); setError(''); setSignedOut(false); }
  async function load(page = 1) { if (!characters.some(character => character.characterId === characterId)) return;
    clear(); const controller = new AbortController(); request.current = controller; setBusy(true);
    try { const value = await orderAnalyticsRequest({ characterId, entity, ...(entity === 'corporation' ? { page } : {}) }, controller.signal); if (request.current === controller && !controller.signal.aborted) setResult(value); }
    catch (failure) { if (request.current !== controller || controller.signal.aborted) return; setError((failure as Error).message); setSignedOut(failure instanceof ConnectionResponseError && failure.status === 401); }
    finally { if (request.current === controller) setBusy(false); }
  }
  if (!characters.length) return <section className="panel"><h2>Open orders</h2><p>Connect a character to explore its reported open orders and expiry dates.</p><button className="button secondary" onClick={openConnections}>Set up a connection</button></section>;
  return <section aria-labelledby="orders-heading"><div className="overview-heading"><div><p className="eyebrow">MARKET ORDERS · READ ONLY</p><h2 id="orders-heading">Open orders</h2></div><button className="small" onClick={openConnections}>Manage connections</button></div>
    <div className="overview-controls"><div><label htmlFor="orders-character">Character</label><select id="orders-character" value={characterId} onChange={event => { clear(); setCharacterId(Number(event.target.value)); }}>{!characterId && <option value={0}>Choose a connected character</option>}{characters.map(character => <option key={character.characterId} value={character.characterId}>{character.name}</option>)}</select></div><div><label htmlFor="orders-entity">Order owner</label><select id="orders-entity" value={entity} onChange={event => { clear(); setEntity(event.target.value as 'character' | 'corporation'); }}><option value="character">Selected character</option><option value="corporation">Character’s corporation</option></select></div><button className="button secondary" disabled={busy || !characterId} onClick={() => void load()}>{busy ? 'Loading open orders…' : result ? 'Refresh open orders' : 'Load open orders'}</button>{busy && <button className="small" onClick={clear}>Cancel</button>}</div>
    <p className="overview-hint">One personal response or one corporation page. Counts and remaining quoted values cover the included response. Buy bids and sell asks remain separate; these are reported listings, not established sales, escrow, profit or portfolio value.</p>
    {error && <div className="alert" role="alert">{error}{signedOut && <p><a href="/signin-with-chatgpt?return_to=%2F" target="_top">Sign in with ChatGPT</a></p>}</div>}<p className="overview-state" role="status">{busy ? 'Reading the selected open orders…' : result ? result.message : 'Choose an order owner, then load open orders.'}</p>
    {result && <><div className="overview-coverage"><strong>{result.entity === 'corporation' ? `Corporation ${result.corporationId ?? 'unavailable'}` : 'Selected character orders'}</strong><span>{result.coverage.page === null ? 'Single response' : `Page ${result.coverage.page} of ${result.coverage.pages ?? 'unknown'}`} · {result.summary === null ? 'Returned row count unavailable' : `${result.coverage.rows} returned rows`}</span><span>{result.coverage.kind.replaceAll('_', ' ')}</span></div>
      {result.summary ? <OrderExplorer key={`${result.characterId}:${result.entity}:${result.coverage.page}:${result.generatedAt}:${generation}`} result={result}/> : <p className="overview-state">Orders are unavailable for this selection. No orders or balances are inferred.{result.status === 'needs_permission' && <> <button className="small" onClick={openConnections}>Review access</button></>}</p>}
      <div className="analytics-pagination">{result.coverage.previousPage !== null && <button className="small" disabled={busy} onClick={() => void load(result.coverage.previousPage!)}>Previous corporation order page</button>}{result.coverage.nextPage !== null && <button className="small" disabled={busy} onClick={() => void load(result.coverage.nextPage!)}>Next corporation order page</button>}{result.coverage.pageLimitReached && <p>The application page limit is reached; more orders may be outside this view.</p>}</div>
      <details className="overview-freshness"><summary>Coverage &amp; source freshness</summary><p>Source: {result.freshness.state} · Fetched {utcTime(result.freshness.retrievedAt)}<br/>Cache expiry: {utcTime(result.freshness.cacheExpires)}<br/>Last modified: {utcTime(result.freshness.lastModified)}</p>{result.limitations.map((note, index) => <p key={index}>{note}</p>)}<p>Required read permission: <code>{result.scope}</code></p></details>
    </>}
  </section>;
}
