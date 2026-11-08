'use client';
import { useEffect, useRef, useState } from 'react';
import { ConnectionResponseError, type Character } from './lib/connection-client';
import { fetchCloneAnalytics } from './lib/clone-analytics-client';
import type { CloneAnalytics, CloneAnalyticsSection, CloneImplant } from './lib/clone-analytics-types';
import { CountBars } from './analytics-charts';

const time = (value: string | null) => value ? new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : 'Not reported';
const statusLabels = { ready: 'Available', partial: 'Limited freshness', needs_permission: 'Permission needed', unavailable: 'Unavailable', error: 'Could not read safely' };
function Freshness({ section, openConnections }: { section: CloneAnalyticsSection<unknown>; openConnections: () => void }) {
  return <div className="overview-freshness"><p>{section.message}</p><p>Source: {section.freshness} · Fetched {time(section.retrievedAt)} · Cache expiry {time(section.cacheExpires)}</p>{section.status === 'needs_permission' && <><p>Required read permission: <code>{section.scope}</code></p><button className="small" onClick={openConnections}>Review access</button></>}</div>;
}
function ImplantList({ implants }: { implants: CloneImplant[] }) {
  return implants.length ? <ul>{implants.map((implant, index) => <li key={`${index}-${implant.typeId}`}>{implant.name} <small>· Type {implant.typeId}{!implant.mapped && ' · absent from pinned catalog'}</small></li>)}</ul> : <>No implants reported in this clone.</>;
}

/** Receives the strict browser projection, never raw ESI rows. */
export function CloneAnalyticsResults({ result, openConnections }: { result: CloneAnalytics; openConnections: () => void }) {
  const [offset, setOffset] = useState(0);
  const active = result.implants.data, stored = result.clones.data, shown = stored?.clones.slice(offset, offset + 20) ?? [];
  return <>
    <article className="overview-card analytics-section"><div className="overview-card-heading"><h3>Active implants</h3><span className={`data-status data-status-${result.implants.status}`}>{statusLabels[result.implants.status]}</span></div>
      {active && <><dl className="overview-metrics"><div><dt>Active implant entries</dt><dd>{active.implantCount}</dd></div><div><dt>Unmapped active entries</dt><dd>{active.unmappedImplants}</dd></div></dl>
        <p className="overview-hint">These entries come from the active-implants feed. They are kept separate from implants in stored jump clones. Type labels come from the pinned public catalog; no bonuses, value or training rate is estimated.</p>
        {active.implants.length ? <div className="workspace-table-scroll" tabIndex={0} role="region" aria-label="Active implants"><table className="workspace-table"><caption>Active implant entries — separate source snapshot</caption><thead><tr><th scope="col">Entry</th><th scope="col">Public type</th><th scope="col">Type ID</th></tr></thead><tbody>{active.implants.map((implant, index) => <tr key={`${index}-${implant.typeId}`}><td>{index + 1}</td><th scope="row">{implant.name}{!implant.mapped && <><br/><small>Absent from pinned catalog</small></>}</th><td>{implant.typeId}</td></tr>)}</tbody></table></div> : <p>No active implants returned in this response.</p>}</>}
      <Freshness section={result.implants} openConnections={openConnections}/>
    </article>
    <article className="overview-card analytics-section"><div className="overview-card-heading"><h3>Stored jump clones</h3><span className={`data-status data-status-${result.clones.status}`}>{statusLabels[result.clones.status]}</span></div>
      {stored && <><dl className="overview-metrics"><div><dt>Jump clones returned</dt><dd>{stored.cloneCount}</dd></div><div><dt>Stored implant entries</dt><dd>{stored.totalStoredImplants}</dd></div><div><dt>Unmapped stored entries</dt><dd>{stored.unmappedImplants}</dd></div></dl>
        <p className="overview-hint">Rows are numbered only for this response. Custom clone names and persistent clone IDs are omitted. Location IDs and kinds stay as reported; no location lookup, docking access or travel readiness is inferred.</p>
        <dl className="overview-metrics"><div><dt>Reported home location ID</dt><dd>{stored.homeLocation?.locationId ?? 'Not reported'}</dd></div><div><dt>Reported home location kind</dt><dd>{stored.homeLocation?.locationType ?? 'Not reported'}</dd></div><div><dt>Last reported clone jump</dt><dd className="analytics-date">{time(stored.lastCloneJumpAt)}</dd></div><div><dt>Reported station-change date</dt><dd className="analytics-date">{time(stored.lastHomeStationChangeAt)}</dd></div></dl>
        <p className="overview-hint">Reported dates do not determine a next-jump time or available clone capacity. Missing dates remain unknown.</p>
        <CountBars title="Implant entries per stored jump clone" unit="entries" rows={stored.clones.map(clone => ({ label: `Clone row ${clone.row}`, value: clone.implants.length }))}/>
        <p className="overview-hint">The chart covers all {stored.cloneCount} returned clone rows. It counts reported implant entries, preserving repeated types; it does not combine these with active implants.</p>
        {stored.clones.length ? <><div className="workspace-table-scroll" tabIndex={0} role="region" aria-label="Stored jump clone details"><table className="workspace-table"><caption>Stored jump clones — rows {offset + 1}–{offset + shown.length} of {stored.cloneCount}</caption><thead><tr><th scope="col">Response row</th><th scope="col">Location ID</th><th scope="col">Location kind</th><th scope="col">Implant entries</th><th scope="col">Public implant types</th></tr></thead><tbody>{shown.map(clone => <tr key={clone.row}><th scope="row">Clone row {clone.row}</th><td>{clone.locationId}</td><td>{clone.locationType}</td><td>{clone.implants.length}</td><td><ImplantList implants={clone.implants}/></td></tr>)}</tbody></table></div><div className="analytics-pagination"><button className="small" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 20))}>Previous clone rows</button><button className="small" disabled={offset + 20 >= stored.cloneCount} onClick={() => setOffset(value => value + 20)}>Next clone rows</button></div></> : <p>No stored jump clones returned in this response.</p>}
      </>}
      <Freshness section={result.clones} openConnections={openConnections}/>
    </article>
  </>;
}

export default function CloneAnalyticsPanel({ characters, openConnections }: { characters: Character[]; openConnections: () => void }) {
  const [characterId, setCharacterId] = useState(characters[0]?.characterId ?? 0), [result, setResult] = useState<CloneAnalytics | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [signedOut, setSignedOut] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  function clear() { request.current?.abort(); request.current = null; setResult(null); setBusy(false); setError(''); setSignedOut(false); }
  async function load() {
    clear(); const controller = new AbortController(); request.current = controller; setBusy(true);
    try { const value = await fetchCloneAnalytics({ characterId }, controller.signal); if (request.current === controller && !controller.signal.aborted) setResult(value); }
    catch (failure) { if (request.current !== controller || controller.signal.aborted) return; setError((failure as Error).message); setSignedOut(failure instanceof ConnectionResponseError && failure.status === 401); }
    finally { if (request.current === controller) setBusy(false); }
  }
  if (!characters.length) return <section className="panel"><h2>Clones &amp; implants</h2><p>Connect a character to inspect its reported clones and implants.</p><button className="button secondary" onClick={openConnections}>Set up a connection</button></section>;
  return <section aria-labelledby="clones-heading"><div className="overview-heading"><div><p className="eyebrow">CHARACTER SNAPSHOTS · READ ONLY</p><h2 id="clones-heading">Clones &amp; implants</h2></div><button className="small" onClick={openConnections}>Manage connections</button></div>
    <div className="overview-controls"><div><label htmlFor="clones-character">Character</label><select id="clones-character" value={characterId} onChange={event => { clear(); setCharacterId(Number(event.target.value)); }}>{characters.map(character => <option key={character.characterId} value={character.characterId}>{character.name}</option>)}</select></div><button className="button secondary" disabled={busy} onClick={() => void load()}>{busy ? 'Loading clones…' : result ? 'Refresh clones' : 'Load clones'}</button>{busy && <button className="small" onClick={clear}>Cancel</button>}</div>
    <p className="overview-hint">Loads clone and active-implant feeds for one character using its existing read grants. Each feed keeps separate freshness. No clone jump, relocation or implant change can be performed here. Results stay in this view only.</p>
    {error && <div className="alert" role="alert">{error}{signedOut && <p><a href="/signin-with-chatgpt?return_to=%2F" target="_top">Sign in with ChatGPT</a></p>}</div>}
    <p className="overview-state" role="status">{busy ? 'Reading the selected clone and implant snapshots…' : result ? result.message : 'Choose a character, then load clones.'}</p>
    {result && <CloneAnalyticsResults key={`${result.characterId}-${result.generatedAt}`} result={result} openConnections={openConnections}/>}
  </section>;
}
