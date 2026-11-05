'use client';
import { useEffect, useRef, useState } from 'react';
import { ConnectionResponseError, type Character } from './lib/connection-client';
import { corporationWorkspaceRequest, formatCorporationCell } from './lib/corporation-workspace-client';
import type { CorporationWorkspace, CorporationWorkspaceRequest } from './lib/corporation-workspace-types';

type ListView = 'wallets' | 'contracts' | 'projects' | 'order_history' | 'blueprints' | 'facilities' | 'structures' | 'assets' | 'extractions' | 'freelance_jobs';
const titles = { wallets: 'Wallet divisions', contracts: 'Corporation contracts', projects: 'Active projects', contract_items: 'Contract items', contract_bids: 'Contract bids', project: 'Project progress', order_history: 'Market order history', blueprints: 'Blueprint library', facilities: 'Corporation facilities', structures: 'Structure fuel & services', assets: 'Corporation assets', asset_detail: 'Asset details', extractions: 'Moon extraction schedule', freelance_jobs: 'Corporation freelance jobs' };
const hints: Record<ListView, string> = {
  wallets: 'Balances cover only returned wallet divisions. Requires the corporation wallet read permission and the appropriate corporation role.',
  contracts: 'Open contract items or auction bid amounts when needed. Bidder identities are omitted. Requires corporation contract read access.',
  projects: 'Open project progress, objective and your selected character’s contribution when needed. Requires corporation project read access.',
  order_history: 'Review cancelled and expired corporation orders in EVE’s available history window. Requires corporation market read access and Accountant or Trader. This is not a profit or transaction report.',
  blueprints: 'Review originals, copies, stacks, efficiency and remaining copy runs. Requires the optional blueprint read permission and Director. Item and location IDs are shown without extra lookups.',
  facilities: 'Review the corporation’s reported facilities and their system and type IDs. Requires the optional facilities read permission and Factory Manager. This list is not a complete structure inventory.',
  structures: 'Review reported structure state, services and fuel expiry. Requires the optional structures read permission and Station Manager. Missing fuel or service information stays unavailable.',
  assets: 'Browse the corporation’s returned asset inventory. Open an item’s details to look up its custom name and available coordinates. Requires the existing corporation assets read permission and Director. Containers and item location IDs are not resolved automatically.',
  extractions: 'Review returned moon extraction schedules in UTC. Arrival and natural fracture times describe the schedule; they do not report mining output or confirm when a chunk was fractured. Requires the optional corporation mining read permission and Station Manager. Structure and moon IDs stay exact without name lookups.',
  freelance_jobs: 'Review returned freelance job progress and reserved reward balances. Rewards are not earned payouts, and progress is shared job progress. Requires the optional corporation freelance read permission and Project Manager. This provider window is not a complete job history; participant identities and descriptions are omitted.',
};
const statuses = { ready: 'Available', partial: 'Limited coverage', needs_permission: 'Permission needed', unavailable: 'Unavailable', error: 'Could not load' };
const time = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export default function CorporationPanel({ characters, openConnections }: { characters: Character[]; openConnections: () => void }) {
  const [characterId, setCharacterId] = useState(characters[0]?.characterId ?? 0);
  const [view, setView] = useState<ListView>('wallets');
  const [includeNames, setIncludeNames] = useState(false);
  const [result, setResult] = useState<CorporationWorkspace | null>(null);
  const [current, setCurrent] = useState<CorporationWorkspaceRequest | null>(null);
  const [trail, setTrail] = useState<CorporationWorkspaceRequest[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [signedOut, setSignedOut] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  function clear() {
    active.current?.abort(); active.current = null;
    setResult(null); setCurrent(null); setTrail([]); setBusy(false); setError(''); setSignedOut(false);
  }
  async function load(args: CorporationWorkspaceRequest, history: CorporationWorkspaceRequest[] = []) {
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    setResult(null); setCurrent(args); setTrail(history); setBusy(true); setError(''); setSignedOut(false);
    try {
      const next = await corporationWorkspaceRequest(args, controller.signal);
      if (active.current === controller && !controller.signal.aborted) setResult(next);
    } catch (failure) {
      if (active.current !== controller || controller.signal.aborted) return;
      setError((failure as Error).message); setSignedOut(failure instanceof ConnectionResponseError && failure.status === 401);
    } finally { if (active.current === controller) setBusy(false); }
  }
  if (!characters.length) return <section className="panel overview-empty"><h2>Connect a character to browse corporation data</h2><p>Choose the corporation read permissions you need, then authorize a character with the appropriate corporation access.</p><button className="button secondary" onClick={openConnections}>Set up a connection →</button></section>;
  return <section aria-labelledby="corporation-heading">
    <div className="overview-heading"><div><p className="eyebrow">ON DEMAND · READ ONLY</p><h2 id="corporation-heading">Corporation workspace</h2></div><button className="small" onClick={openConnections}>Manage connections</button></div>
    <div className="overview-controls">
      <div><label htmlFor="corporation-character">Character</label><select id="corporation-character" value={characterId} onChange={event => { clear(); setCharacterId(Number(event.target.value)); }}>{characters.map(character => <option key={character.characterId} value={character.characterId}>{character.name}</option>)}</select></div>
      <div><label htmlFor="corporation-view">Browse</label><select id="corporation-view" value={view} onChange={event => { clear(); setView(event.target.value as ListView); }}><optgroup label="Finance & contracts"><option value="wallets">Wallet divisions</option><option value="order_history">Market order history</option><option value="contracts">Contracts</option></optgroup><optgroup label="Industry & infrastructure"><option value="assets">Assets</option><option value="blueprints">Blueprint library</option><option value="facilities">Facilities</option><option value="structures">Structure fuel & services</option><option value="extractions">Mining extractions</option></optgroup><optgroup label="Projects"><option value="projects">Active projects</option><option value="freelance_jobs">Freelance jobs</option></optgroup></select></div>
      <button className="button secondary" disabled={busy || !characterId} onClick={() => void load(current ?? { characterId, view, ...(includeNames ? { includeNames: true } : {}) }, trail)}>{busy ? 'Loading corporation data…' : result ? 'Refresh this view' : 'Load corporation data'}</button>
      {busy && <button className="small" onClick={clear}>Cancel</button>}
    </div>
    <label className="check workspace-name-option"><input type="checkbox" checked={includeNames} disabled={view === 'extractions' || view === 'freelance_jobs'} onChange={event => { clear(); setIncludeNames(event.target.checked); }}/><span><strong>Include public type and system names</strong><small>{view === 'extractions' || view === 'freelance_jobs' ? 'This view has no public type or system name lookup. Its IDs stay exact.' : 'Look up names for the displayed item types and solar systems when you load a view. Private item, character and location IDs are not sent to this lookup. Missing names keep their IDs.'}</small></span></label>
    <p className="overview-hint">{hints[view]} Use one character’s current corporation access. Data loads only when requested; no background polling or account history is saved.</p>
    {error && <div className="alert" role="alert">{error}{signedOut && <p><a href="/signin-with-chatgpt?return_to=%2F" target="_top">Sign in with ChatGPT</a></p>}</div>}
    <div role="status" aria-live="polite" className="overview-state">{busy ? 'Reading the selected data from EVE. This can take up to a minute.' : result ? `Loaded ${time(result.generatedAt)}.` : 'Choose what to browse, then load corporation data.'}</div>
    {!busy && trail.length > 0 && <button className="small workspace-back" onClick={() => void load(trail[trail.length - 1], trail.slice(0, -1))}>← Back to previous view</button>}
    {result && <article className="overview-card corporation-results">
      <div className="overview-card-heading"><h3>{titles[result.view]}</h3><span className={`data-status data-status-${result.status}`}>{statuses[result.status]}</span></div>
      <p className="overview-message">{result.message}</p>
      {result.corporationId && <p className="fine">Corporation {result.corporationId}</p>}
      {result.status === 'needs_permission' && <button className="small" onClick={openConnections}>Review access</button>}
      {result.rows.length > 0 && <div className="workspace-table-scroll" tabIndex={0} role="region" aria-label={titles[result.view]}><table className="workspace-table">
        <caption>{titles[result.view]} · {result.rows.length} displayed</caption>
        <thead><tr>{result.columns.map(column => <th scope="col" key={column.key}>{column.label}</th>)}{result.rows.some(row => row.action || row.actions?.length) && <th scope="col">Details</th>}</tr></thead>
        <tbody>{result.rows.map(row => <tr key={row.id}>{result.columns.map(column => <td key={column.key}>{formatCorporationCell(row.cells[column.key], column)}</td>)}
          {result.rows.some(item => item.action || item.actions?.length) && <td><div className="workspace-actions">{[...(row.action ? [row.action] : []), ...(row.actions ?? [])].map(action => <button key={action.request.view} className="small" onClick={() => void load(action.request, current ? [...trail, current] : trail)}>{action.label}</button>)}</div></td>}
        </tr>)}</tbody>
      </table></div>}
      {result.details && result.details.length > 0 && <section className="workspace-objective" aria-labelledby="project-objective-heading">
        <h4 id="project-objective-heading">Project objective</h4>
        <dl>{result.details.map(detail => <div key={detail.label}><dt>{detail.label}</dt><dd>{String(detail.value)}</dd></div>)}</dl>
      </section>}
      {result.next && <button className="button secondary workspace-next" onClick={() => void load(result.next!, current ? [...trail, current] : trail)}>Load next batch →</button>}
      <details className="overview-freshness"><summary>Coverage &amp; freshness</summary><p>Coverage: {result.coverage}. Batches are fetched separately and can change between requests. A recent fetch can still contain cached EVE data.</p>{result.sources.map(source => <div key={source.dataset}><p>{source.dataset.replaceAll('_', ' ')}: fetched {time(source.retrievedAt)}{source.cacheExpires ? ` · ESI cache expiry ${time(source.cacheExpires)}` : ''}</p><p>Required read permission: <code>{source.scope}</code></p></div>)}{result.sources.length === 0 && <p>Required read permission: <code>{result.scope}</code></p>}</details>
    </article>}
  </section>;
}
