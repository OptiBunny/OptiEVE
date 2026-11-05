'use client';
import { useEffect, useRef, useState } from 'react';
import { ConnectionResponseError, type Character } from './lib/connection-client';
import { characterPublicName, characterWorkspaceRequest, formatCharacterValue } from './lib/character-workspace-client';
import type { CharacterWorkspace, CharacterWorkspaceRequest } from './lib/character-workspace-types';
import MiningChart from './mining-chart';

const titles = { faction_warfare: 'Faction warfare', standings: 'NPC standings', loyalty_points: 'Loyalty points', blueprints: 'Blueprint library', research: 'Research agents', planets: 'Planetary colonies', mining: 'Mining ledger' };
const modeViews = { reputation: ['faction_warfare', 'standings', 'loyalty_points'], industry: ['blueprints', 'research', 'planets', 'mining'] } as const;
const hints = {
  faction_warfare: 'Review reported enlistment, ranks, kills and victory points. Missing enrollment fields remain not reported. A failed read does not establish whether this character is enlisted.',
  standings: 'Review standings reported by NPC agents, corporations and factions for this character. These values do not establish skill-adjusted standing, agent access, docking rights or safe travel.',
  loyalty_points: 'Review the character’s reported loyalty-point balance with each NPC corporation. Separate balances are not an interchangeable pool, earned ISK or a cash valuation.',
  blueprints: 'Review your reported blueprint originals, copies and original stacks, including efficiency and remaining copy runs. Location IDs may identify a station, ship or container; no private item name or location-resolution read is made.',
  research: 'Review research-agent IDs, research skill types, start times and the provider’s reported rate and remainder. These inputs are not a current spendable research-point balance or an ISK value.',
  planets: 'This view shows your colony planet and solar-system IDs, planet types, reported pin counts, upgrade levels and last update times. It does not load colony layouts or extractor programs, or establish current production and expiry times.',
  mining: 'Review your reported mining quantities by UTC date, type and solar system in EVE’s past-30-day ledger. Loading this view reveals the listed mining locations. Each page covers only its returned records; quantities are not income, volume or profit.',
};
const statusLabels = { ready: 'Available', partial: 'Limited coverage', needs_permission: 'Permission needed', unavailable: 'Unavailable', error: 'Could not load' };
const time = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';

export default function CharacterPanel({ characters, openConnections, mode = 'reputation' }: { characters: Character[]; openConnections: () => void; mode?: 'reputation' | 'industry' }) {
  const [characterId, setCharacterId] = useState(characters[0]?.characterId ?? 0);
  const [view, setView] = useState<CharacterWorkspaceRequest['view']>(modeViews[mode][0]);
  const [resolveNames, setResolveNames] = useState(false);
  const [result, setResult] = useState<CharacterWorkspace | null>(null);
  const [current, setCurrent] = useState<CharacterWorkspaceRequest | null>(null);
  const [trail, setTrail] = useState<CharacterWorkspaceRequest[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [signedOut, setSignedOut] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  function clear() {
    active.current?.abort(); active.current = null;
    setResult(null); setCurrent(null); setTrail([]); setBusy(false); setError(''); setSignedOut(false);
  }
  async function load(args: CharacterWorkspaceRequest, history: CharacterWorkspaceRequest[] = []) {
    if (!(modeViews[mode] as readonly string[]).includes(args.view)) { clear(); return; }
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    setResult(null); setCurrent(args); setTrail(history); setBusy(true); setError(''); setSignedOut(false);
    try {
      const next = await characterWorkspaceRequest(args, controller.signal);
      if (active.current === controller && !controller.signal.aborted) setResult(next);
    } catch (failure) {
      if (active.current !== controller || controller.signal.aborted) return;
      setError((failure as Error).message); setSignedOut(failure instanceof ConnectionResponseError && failure.status === 401);
    } finally { if (active.current === controller) setBusy(false); }
  }
  if (!characters.length) return <section className="panel overview-empty"><h2>{mode === 'industry' ? 'Connect a character to review industry' : 'Connect a character to review reputation'}</h2><p>{mode === 'industry' ? 'Review personal blueprints, research agents, planetary colonies and mining records with a connected character’s existing read permissions.' : 'Review faction warfare, NPC standings and loyalty points with a connected character’s existing read permissions.'}</p><button className="button secondary" onClick={openConnections}>Set up a connection →</button></section>;
  return <section aria-labelledby={`${mode}-heading`}>
    <div className="overview-heading"><div><p className="eyebrow">ON DEMAND · READ ONLY</p><h2 id={`${mode}-heading`}>{mode === 'industry' ? 'Personal industry' : 'Reputation & loyalty'}</h2></div><button className="small" onClick={openConnections}>Manage connections</button></div>
    <div className="overview-controls">
      <div><label htmlFor={`${mode}-character`}>Character</label><select id={`${mode}-character`} value={characterId} onChange={event => { clear(); setCharacterId(Number(event.target.value)); }}>{characters.map(character => <option key={character.characterId} value={character.characterId}>{character.name}</option>)}</select></div>
      <div><label htmlFor={`${mode}-view`}>Browse</label><select id={`${mode}-view`} value={view} onChange={event => { clear(); setView(event.target.value as CharacterWorkspaceRequest['view']); }}>{modeViews[mode].map(choice => <option key={choice} value={choice}>{titles[choice]}</option>)}</select></div>
      <button className="button secondary" disabled={busy || !characterId} onClick={() => void load(current ?? { characterId, view, ...(mode === 'industry' && resolveNames ? { resolveNames: true } : {}) }, trail)}>{busy ? `Loading ${mode} data…` : result ? 'Refresh this view' : `Load ${mode} data`}</button>
      {busy && <button className="small" onClick={clear}>Cancel</button>}
    </div>
    {mode === 'industry' && <label className="check workspace-name-option"><input type="checkbox" checked={resolveNames} onChange={event => { clear(); setResolveNames(event.target.checked); }}/><span><strong>Show public type and system names</strong><small>Look up displayed blueprint, research-skill and mined-material types or solar systems when you load a view. Private item, location, planet and agent IDs are not sent. Exact IDs remain visible when names are unavailable.</small></span></label>}
    <p className="overview-hint">{hints[view]} One selected character is read only when requested; no background polling or account history is saved.</p>
    {error && <div className="alert" role="alert">{error}{signedOut && <p><a href="/signin-with-chatgpt?return_to=%2F" target="_top">Sign in with ChatGPT</a></p>}</div>}
    <div role="status" aria-live="polite" className="overview-state">{busy ? 'Reading the selected data from EVE. This can take up to a minute.' : result ? `Loaded ${time(result.generatedAt)}.` : `Choose what to review, then load ${mode} data.`}</div>
    {!busy && trail.length > 0 && <button className="small workspace-back" onClick={() => void load(trail[trail.length - 1], trail.slice(0, -1))}>← Back to previous view</button>}
    {result && <article className={`overview-card character-results ${mode}-results`}>
      <div className="overview-card-heading"><h3>{titles[result.view]}</h3><span className={`data-status data-status-${result.status}`}>{statusLabels[result.status]}</span></div>
      {result.metrics.length > 0 && <dl className="overview-metrics">{result.metrics.map(metric => <div key={metric.label}><dt>{metric.label}</dt><dd>{formatCharacterValue(metric.value, metric)}</dd></div>)}</dl>}
      <p className="overview-message">{result.message}</p>
      {result.labels && <p className="overview-hint" role="status">Public names: {result.labels.status === 'ready' ? 'available' : result.labels.status === 'partial' ? 'limited coverage' : 'unavailable'}. {result.labels.message}</p>}
      {result.status === 'needs_permission' && <button className="small" onClick={openConnections}>Review access</button>}
      {result.view === 'mining' && <MiningChart key={result.generatedAt} result={result}/>}
      {result.rows.length > 0 && <div className="workspace-table-scroll" tabIndex={0} role="region" aria-label={titles[result.view]}><table className="workspace-table">
        <caption>{titles[result.view]} · {result.rows.length} displayed</caption>
        <thead><tr>{result.columns.map(column => <th scope="col" key={column.key}>{column.label}</th>)}</tr></thead>
        <tbody>{result.rows.map(row => <tr key={row.id}>{result.columns.map(column => {
          const name = characterPublicName(result, column.key, row.cells[column.key]);
          return <td key={column.key}>{formatCharacterValue(row.cells[column.key], column)}{name && <><br/><small>{name}</small></>}</td>;
        })}</tr>)}</tbody>
      </table></div>}
      {result.next && <button className="button secondary workspace-next" onClick={() => void load(result.next!, current ? [...trail, current] : trail)}>Load next batch →</button>}
      <details className="overview-freshness"><summary>Coverage &amp; freshness</summary><p>Coverage: {result.coverage}. Batches are fetched separately and can change between requests. A recent fetch can still contain cached EVE data.</p>{result.retrievedAt && <p>Fetched: {time(result.retrievedAt)}</p>}{result.cacheExpires && <p>ESI cache expiry: {time(result.cacheExpires)}</p>}{result.labels?.retrievedAt && <p>Public names fetched: {time(result.labels.retrievedAt)}</p>}{result.labels?.cacheExpires && <p>Public names cache expiry: {time(result.labels.cacheExpires)}</p>}<p>Required read permission: <code>{result.scope}</code></p></details>
    </article>}
  </section>;
}
