'use client';
import { useEffect, useRef, useState } from 'react';
import type { Character } from './lib/connection-client';
import { ConnectionResponseError } from './lib/connection-client';
import { formatMetric, overviewRequest } from './lib/overview-client';
import type { Overview, OverviewView } from './lib/overview-types';

const statusLabels = { ready: 'Available', partial: 'Limited coverage', needs_permission: 'Permission needed', unavailable: 'Unavailable', error: 'Could not load' };
const time = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export default function OverviewPanel({ characters, openConnections }: { characters: Character[]; openConnections: () => void }) {
  const [characterId, setCharacterId] = useState(characters[0]?.characterId ?? 0);
  const [view, setView] = useState<OverviewView>('personal');
  const [result, setResult] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [signedOut, setSignedOut] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  function clear() {
    request.current?.abort(); request.current = null;
    setResult(null); setBusy(false); setError(''); setSignedOut(false);
  }
  async function load() {
    clear();
    const controller = new AbortController(); request.current = controller; setBusy(true);
    try {
      const next = await overviewRequest({ characterId, view }, controller.signal);
      if (request.current === controller && !controller.signal.aborted) setResult(next);
    } catch (failure) {
      if (request.current !== controller || controller.signal.aborted) return;
      setError((failure as Error).message);
      setSignedOut(failure instanceof ConnectionResponseError && failure.status === 401);
    } finally { if (request.current === controller) setBusy(false); }
  }
  if (!characters.length) return <section className="panel overview-empty">
    <span className="eyebrow">YOUR PRIVATE OPERATIONS DESK</span><h2>Connect a character to get started</h2>
    <p>Review your wallet, training queue, market orders, industry jobs, contracts and freelance participation. Add corporation operations when you need them.</p>
    <button className="button secondary" onClick={openConnections}>Set up a connection →</button>
    <p className="fine">No example balances or account data are loaded. Your overview uses only the character you select.</p>
  </section>;
  return <section aria-labelledby="overview-heading">
    <div className="overview-heading"><div><p className="eyebrow">ON DEMAND · READ ONLY</p><h2 id="overview-heading">Operations overview</h2></div><button className="small" onClick={openConnections}>Manage connections</button></div>
    <div className="overview-controls">
      <div><label htmlFor="overview-character">Character</label><select id="overview-character" value={characterId} onChange={event => { clear(); setCharacterId(Number(event.target.value)); }}>{characters.map(character => <option key={character.characterId} value={character.characterId}>{character.name}</option>)}</select></div>
      <div><label htmlFor="overview-view">Workspace</label><select id="overview-view" value={view} onChange={event => { clear(); setView(event.target.value as OverviewView); }}><option value="personal">Personal overview</option><option value="corporation">Corporation operations</option></select></div>
      <button className="button secondary" disabled={busy || !characterId} onClick={() => void load()}>{busy ? 'Loading overview…' : result ? 'Refresh overview' : 'Load overview'}</button>
      {busy && <button className="small" onClick={clear}>Cancel</button>}
    </div>
    <p className="overview-hint">{view === 'personal' ? 'One selected character. Wallet cash and order commitments are separate; this is not a profit or net-worth report.' : 'Corporation-owned activity, separate from your personal holdings. Optional permissions and corporation roles control what is available.'} Data loads only when you ask; no background polling or account history is saved.</p>
    {error && <div className="alert" role="alert">{error}{signedOut && <p><a href="/signin-with-chatgpt?return_to=%2F" target="_top">Sign in with ChatGPT</a></p>}</div>}
    <div role="status" aria-live="polite" className="overview-state">{busy ? 'Reading the selected datasets from EVE. This can take up to a minute.' : result ? `Overview loaded ${time(result.generatedAt)}.` : 'Choose a workspace, then load your overview.'}</div>
    {result && <>
      <div className="overview-coverage"><strong>{result.view === 'corporation' ? 'Corporation operations' : 'Personal overview'}</strong><span>{result.coverage}</span>{result.corporationId && <span>Corporation {result.corporationId}</span>}</div>
      <div className="overview-cards">{result.sections.map(section => <article className="overview-card" key={section.id}>
        <div className="overview-card-heading"><h3>{section.title}</h3><span className={`data-status data-status-${section.status}`}>{statusLabels[section.status]}</span></div>
        {section.metrics.length > 0 && <dl className="overview-metrics">{section.metrics.map((metric, index) => <div key={`${metric.label}-${index}`}><dt>{metric.label}</dt><dd>{formatMetric(metric)}{metric.unit === 'ISK' && <span className="metric-unit"> ISK</span>}</dd></div>)}</dl>}
        <p className="overview-message">{section.message}</p>
        {section.status === 'needs_permission' && <button className="small" onClick={openConnections}>Review access</button>}
        <details className="overview-freshness"><summary>Coverage &amp; freshness</summary><p>Coverage: {section.coverage}. A recent fetch can still contain cached EVE data.</p>{section.retrievedAt && <p>Fetched: {time(section.retrievedAt)}</p>}{section.lastModified && <p>ESI last modified: {time(section.lastModified)}</p>}{section.cacheExpires && <p>ESI cache expiry: {time(section.cacheExpires)}</p>}{section.cacheControl && <p>ESI cache policy: <code>{section.cacheControl}</code></p>}<p>Required read permission: <code>{section.scope}</code></p></details>
      </article>)}</div>
    </>}
  </section>;
}
