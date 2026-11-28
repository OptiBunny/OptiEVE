'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ConnectionResponseError, type Character } from './lib/connection-client';
import { historicalOrdersRequest } from './lib/historical-orders-client';
import type { HistoricalOrders } from './lib/historical-orders-types';

const pageSize = 100;

export function HistoricalOrderRows({ result }: { result: HistoricalOrders }) {
  const [query, setQuery] = useState(''), [side, setSide] = useState('all'), [state, setState] = useState('all');
  const [offset, setOffset] = useState(0);
  const names = useMemo(() => new Map(result.types.map(type => [type.typeId, type.name])), [result]);
  const matching = useMemo(() => {
    const term = query.trim().toLowerCase();
    return result.orders.filter(row => (side === 'all' || row.side === side) && (state === 'all' || row.state === state) &&
      (!term || String(row.typeId).includes(term) || names.get(row.typeId)?.toLowerCase().includes(term)));
  }, [result, names, query, side, state]);
  const shown = matching.slice(offset, offset + pageSize);
  return <section className="overview-card analytics-section">
    <h3>Orders on this page</h3>
    <div className="overview-controls">
      <label>Item name or type ID<input type="search" maxLength={128} value={query} onChange={e => { setQuery(e.target.value); setOffset(0); }}/></label>
      <label>Side<select value={side} onChange={e => { setSide(e.target.value); setOffset(0); }}><option value="all">Both sides</option><option value="buy">Buy</option><option value="sell">Sell</option></select></label>
      <label>State<select value={state} onChange={e => { setState(e.target.value); setOffset(0); }}><option value="all">All states</option><option value="cancelled">Cancelled</option><option value="expired">Expired</option><option value="other">Other</option></select></label>
    </div>
    {shown.length > 0 ? <div className="workspace-table-scroll" tabIndex={0} role="region" aria-label="Historical order details">
      <table className="workspace-table"><caption>Rows {offset + 1}–{offset + shown.length} of {matching.length} matching personal orders</caption>
        <thead><tr>{['Item', 'Side', 'State', 'Issued (UTC)', 'Unit price (ISK)', 'Original units', 'Remaining units'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{shown.map(order => <tr key={order.row}><th scope="row">{names.get(order.typeId)} <small>({order.typeId})</small></th>
          <td>{order.side}</td><td>{order.state}</td><td><time dateTime={order.issuedAt}>{order.issuedAt.replace('T', ' ').replace(/\.000Z$/, 'Z')}</time></td>
          <td>{order.unitPriceISK}</td><td>{order.originalQuantity.toLocaleString()}</td><td>{order.remainingQuantity.toLocaleString()}</td></tr>)}</tbody>
      </table></div> : <p>{result.orders.length ? 'No orders match these filters.' : 'This page contains no personal orders.'}</p>}
    {matching.length > pageSize && <div className="analytics-pagination"><button type="button" className="small" disabled={offset === 0}
      onClick={() => setOffset(n => Math.max(0, n - pageSize))}>Previous rows</button><button type="button" className="small"
      disabled={offset + pageSize >= matching.length} onClick={() => setOffset(n => Math.min(Math.floor((matching.length - 1) / pageSize) * pageSize, n + pageSize))}>Next rows</button></div>}
  </section>;
}

export function HistoricalOrderResult({ result }: { result: HistoricalOrders }) {
  const { summary, coverage, freshness } = result;
  return <>
    <p role="status">{result.message}</p>
    {summary && <>
      <div className="overview-grid"><article className="overview-card">
        <h3>Returned personal orders</h3><p>{summary.orders} orders · {summary.buy} buy · {summary.sell} sell</p>
        <p>{summary.cancelled} cancelled · {summary.expired} expired · {summary.other} other</p>
      </article><article className="overview-card"><h3>Page coverage</h3>
        <p>Source page {coverage.page} of {coverage.pages ?? 'unknown'} · {coverage.excludedCorporationRows} corporation orders excluded</p>
        <p>Source freshness: {freshness.state} · assessed {result.generatedAt}</p>
        {coverage.pageLimitReached && <p>The page limit has been reached. More orders may exist.</p>}
      </article></div>
      <HistoricalOrderRows result={result}/>
    </>}
    <details className="overview-freshness"><summary>About this history</summary>
      {result.limitations.map(line => <p key={line}>{line}</p>)}
    </details>
  </>;
}

type Props = { characters: Character[]; openConnections: () => void };

export default function HistoricalOrdersPanel({ characters, openConnections }: Props) {
  const [choice, setChoice] = useState(() => ({ characterId: characters[0]?.characterId ?? 0, page: '1' }));
  const { characterId, page } = choice;
  const [result, setResult] = useState<HistoricalOrders | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [signedOut, setSignedOut] = useState(false);
  const request = useRef<AbortController | null>(null);
  const selected = useRef<{ characterId: number; page: string } | null>(null);
  useLayoutEffect(() => {
    selected.current = choice;
    return () => { selected.current = null; request.current?.abort(); request.current = null; };
  }, [choice]);
  function clear() {
    request.current?.abort(); request.current = null;
    setBusy(false); setResult(null); setError(''); setSignedOut(false);
  }
  const pageNumber = Number(page);
  const validPage = /^[1-9]\d{0,2}$/.test(page) && pageNumber <= 500;
  async function load() {
    if (selected.current !== choice || !validPage || !characters.some(c => c.characterId === characterId)) return;
    clear();
    const controller = new AbortController(); request.current = controller; setBusy(true);
    try {
      const value = await historicalOrdersRequest({ characterId, page: pageNumber }, controller.signal);
      if (request.current === controller && !controller.signal.aborted) setResult(value);
    } catch (e) {
      if (request.current === controller && !controller.signal.aborted) {
        setError(e instanceof ConnectionResponseError ? e.message : 'Historical orders could not be loaded.');
        setSignedOut(e instanceof ConnectionResponseError && e.status === 401);
      }
    } finally { if (request.current === controller) { request.current = null; setBusy(false); } }
  }
  return <section aria-labelledby="historical-orders-heading"><div className="overview-heading">
    <h2 id="historical-orders-heading">Historical orders</h2><button type="button" className="small" onClick={openConnections}>Connection settings</button></div>
    <p>Load one page of your character’s cancelled and expired market orders. EVE reports the issue date. Closing times and sale proceeds are unavailable here.</p>
    <div className="overview-controls"><label>Character<select value={characterId} onChange={e => {
      const next = Number(e.target.value); if (next === characterId) return;
      selected.current = null; clear(); setChoice({ characterId: next, page: '1' });
    }}>{characters.map(c => <option key={c.characterId} value={c.characterId}>{c.name}</option>)}</select></label>
      <label>Source page (1–500)<input inputMode="numeric" maxLength={3} value={page} onChange={e => {
        if (e.target.value === page) return; selected.current = null; clear(); setChoice({ characterId, page: e.target.value });
      }}/></label>
      <button type="button" className="button secondary" disabled={busy || !characterId || !validPage} onClick={() => void load()}>{busy ? 'Loading…' : result ? 'Refresh page' : 'Load history page'}</button>
      {busy && <button type="button" className="small" onClick={clear}>Cancel</button>}
    </div>
    {!validPage && <p>Enter a whole page number from 1 to 500.</p>}
    {!characterId && <p>Connect a character to view historical orders.</p>}
    {error && <div role="alert" className="alert">{error}{signedOut && <p><a href="/signin-with-chatgpt?return_to=%2F" target="_top">Sign in with ChatGPT</a></p>}</div>}
    {result && <HistoricalOrderResult result={result}/>}
  </section>;
}
