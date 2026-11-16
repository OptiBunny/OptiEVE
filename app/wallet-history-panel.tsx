'use client';
import { useEffect, useRef, useState } from 'react';
import { ConnectionResponseError, type Character } from './lib/connection-client';
import { formatISK } from './lib/analytics-client';
import { fetchWalletHistory } from './lib/wallet-history-client';
import type { WalletHistoryArgs, WalletHistoryDays, WalletHistoryView } from './lib/wallet-history-types';
import { CashFlowBars } from './analytics-charts';

const time = (value: string | null) => value ? new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : 'Not recorded';
const scope = 'esi-wallet.read_character_wallet.v1';
const dayChoices: WalletHistoryDays[] = [30, 90, 365];

export function WalletHistoryResults({ result }: { result: WalletHistoryView }) {
  const { report, lastCapture } = result;
  return <div className="analytics-section">
    <div className="overview-coverage"><strong>Saved character wallet observations</strong><span>Last {report.days} days · retention {result.settings.retentionDays} days</span><span>{report.entries} saved entries · {report.missingAmountEntries} without amounts</span></div>
    <p className="overview-hint">These charts include only saved observations still inside retention. Captures may have gaps or stop before all pages. A day without saved entries is omitted, never assumed to have zero activity. Cash flow includes transfers and is not profit or wallet balance.</p>
    {report.totals ? <article className="overview-card analytics-section"><h3>Saved cash flow</h3><dl className="overview-metrics"><div><dt>Net cash flow (ISK)</dt><dd>{formatISK(report.totals.netISK)}</dd></div><div><dt>Incoming ISK</dt><dd>{formatISK(report.totals.incomingISK)}</dd></div><div><dt>Outgoing ISK</dt><dd>{formatISK(report.totals.outgoingISK)}</dd></div></dl></article> : <p className="overview-state">{report.entries ? 'Saved entries contain no reported amounts. Cash-flow totals are unknown.' : 'No saved observations in this period. Cash-flow totals are unknown.'}</p>}
    {report.entries > 0 && <div className="overview-cards"><article className="overview-card"><h3>Saved daily activity</h3><CashFlowBars title="Saved daily incoming and outgoing (UTC)" rows={report.daily.map(row => ({ ...row, label: row.date }))} coverageLabel="saved observations only" emptyLabel="No saved daily observations."/></article><article className="overview-card"><h3>Saved activity categories</h3><CashFlowBars title="Saved incoming and outgoing by category" rows={report.categories.map(row => ({ ...row, label: row.label }))} coverageLabel="saved observations only" emptyLabel="No saved activity categories."/></article></div>}
    <details className="overview-freshness"><summary>Saved coverage, precision &amp; capture details</summary><p>First saved entry in period: {time(report.earliest)}<br/>Last saved entry in period: {time(report.latest)}</p>
      {lastCapture ? <><p>Last saved capture · journal read completed: {time(lastCapture.at)}<br/>Read {lastCapture.pagesRead} of {lastCapture.pagesAdvertised ?? 'unknown'} advertised pages · {lastCapture.entriesRead} returned entries · {lastCapture.addedEntries} newly saved</p><p>Capture coverage: {lastCapture.coverage.replaceAll('_', ' ')}. Reading all advertised pages does not establish a complete calendar period.</p><p>Source freshness when journal read completed: {lastCapture.freshness}<br/>Retrieved: {time(lastCapture.retrievedAt)}<br/>Cache expiry then: {time(lastCapture.cacheExpires)}</p></> : <p>No successful capture is recorded.</p>}
      <p>Each manual capture reads at most {result.limits.maxPages} pages. Saved history is bounded to {result.limits.maxEvents.toLocaleString()} entries.</p><p>{result.precisionPolicy}</p>{result.limitations.map((note, index) => <p key={index}>{note}</p>)}
    </details>
    <p className="overview-hint">The connected OptiEVE tools in your private ChatGPT chat use this same report. Ask for saved wallet cash flow for a character and period; a report does not trigger a capture.</p>
  </div>;
}

export default function WalletHistoryPanel({ characters, openConnections }: { characters: Character[]; openConnections: () => void }) {
  const [characterId, setCharacterId] = useState(characters[0]?.characterId ?? 0), [days, setDays] = useState<WalletHistoryDays>(30), [retentionDays, setRetentionDays] = useState<WalletHistoryDays>(90);
  const [result, setResult] = useState<WalletHistoryView | null>(null), [busy, setBusy] = useState<WalletHistoryArgs['operation'] | null>(null), [error, setError] = useState(''), [signedOut, setSignedOut] = useState(false), [eraseConfirmed, setEraseConfirmed] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  function clear() { request.current?.abort(); request.current = null; setResult(null); setBusy(null); setError(''); setSignedOut(false); setEraseConfirmed(false); }
  async function act(args: WalletHistoryArgs) {
    clear(); const controller = new AbortController(); request.current = controller; setBusy(args.operation);
    try {
      const value = await fetchWalletHistory(args, controller.signal);
      if (request.current === controller && !controller.signal.aborted) { setResult(value); setDays(value.report.days); setRetentionDays(value.settings.retentionDays); }
    } catch (failure) {
      if (request.current !== controller || controller.signal.aborted) return;
      setError((failure as Error).message); setSignedOut(failure instanceof ConnectionResponseError && failure.status === 401);
    } finally { if (request.current === controller) setBusy(null); }
  }
  if (!characters.length) return <section className="panel"><h2>Saved wallet history</h2><p>Connect a character to use optional private wallet history.</p><button className="button secondary" onClick={openConnections}>Set up a connection</button></section>;
  const permitted = characters.find(character => character.characterId === characterId)?.scopes.includes(scope) ?? false;
  return <section aria-labelledby="wallet-history-heading" className="analytics-section"><div className="overview-heading"><div><p className="eyebrow">OPTIONAL PRIVATE HISTORY · EVE READ ONLY</p><h2 id="wallet-history-heading">Saved wallet history</h2></div><button className="small" onClick={openConnections}>Manage connections</button></div>
    <p className="overview-hint">History starts off. Enabling it permits manual captures into this private app; it does not start a schedule. Saved amounts, dates, activity categories and deduplication identifiers are encrypted. Descriptions, counterparties and balances are not saved. These controls change local history only and cannot change EVE game state.</p>
    <div className="overview-controls"><div><label htmlFor="wallet-history-character">History character</label><select id="wallet-history-character" value={characterId} onChange={event => { clear(); setCharacterId(Number(event.target.value)); }}>{characters.map(character => <option key={character.characterId} value={character.characterId}>{character.name}</option>)}</select></div><div><label htmlFor="wallet-history-period">Report period</label><select id="wallet-history-period" value={days} onChange={event => { clear(); setDays(Number(event.target.value) as WalletHistoryDays); }}>{dayChoices.map(value => <option key={value} value={value}>Last {value} days</option>)}</select></div><button className="button secondary" disabled={busy !== null} onClick={() => void act(permitted ? { characterId, operation: 'report', days } : { characterId, operation: 'status' })}>{busy === 'report' ? 'Loading saved history…' : result ? 'Reload saved history' : 'Load saved history'}</button>{busy && <button className="small" onClick={clear}>{busy === 'report' || busy === 'status' ? 'Cancel' : 'Stop waiting'}</button>}</div>
    {!permitted && <p className="overview-hint">This character has no saved wallet read permission. Enable or capture requires that permission. <button className="small" onClick={openConnections}>Review access</button></p>}
    {busy && !['report', 'status'].includes(busy) && <p className="overview-hint">A saved change may finish even if you stop waiting. Reload saved history to check its state before retrying.</p>}
    {error && <div className="alert" role="alert">{error}{signedOut && <p><a href="/signin-with-chatgpt?return_to=%2F" target="_top">Sign in with ChatGPT</a></p>}</div>}
    <p className="overview-state" role="status">{busy ? busy === 'capture' ? 'Reading and saving a bounded journal capture…' : busy === 'configure' ? 'Saving private history settings…' : busy === 'clear' ? 'Erasing saved wallet history…' : 'Loading saved observations…' : result ? result.message : 'Choose a character, then load saved history. Loading does not collect EVE data.'}</p>
    {result && <><article className="overview-card analytics-section"><h3>History controls</h3><p>Manual capture is {result.settings.enabled ? 'enabled' : 'off'} for this character. Pausing capture keeps saved history within retention; erasing removes it and turns capture off.</p><div className="overview-controls"><div><label htmlFor="wallet-history-retention">Keep observations for</label><select id="wallet-history-retention" value={retentionDays} onChange={event => setRetentionDays(Number(event.target.value) as WalletHistoryDays)}>{dayChoices.map(value => <option key={value} value={value}>{value} days</option>)}</select></div>
      <button className="button secondary" disabled={!permitted} onClick={() => void act({ characterId, operation: 'configure', enabled: true, retentionDays })}>{result.settings.enabled ? 'Save retention' : 'Enable private history'}</button>
      {result.settings.enabled && <><button className="small" onClick={() => void act({ characterId, operation: 'configure', enabled: false })}>Pause captures</button><button className="button secondary" disabled={!permitted} onClick={() => void act({ characterId, operation: 'capture' })}>Capture recent journal now</button></>}</div><p className="overview-hint">Saving a shorter retention removes older observations. Reports exclude expired entries immediately; physical cleanup happens on the next settings change, capture or erase, with no background deletion. EVE’s available journal window limits what a capture can retrieve; selecting a longer period cannot recover missing past data.</p>
      <div className="analytics-section"><label htmlFor="wallet-history-erase"><input id="wallet-history-erase" type="checkbox" checked={eraseConfirmed} onChange={event => setEraseConfirmed(event.target.checked)}/> I want to erase this character’s saved wallet history and turn captures off.</label><p><button className="small" disabled={!eraseConfirmed} onClick={() => { if (eraseConfirmed) void act({ characterId, operation: 'clear', confirm: 'delete_wallet_history' }); }}>Erase saved history</button></p><p className="overview-hint">Erasing cannot remove earlier chat results or external backups.</p></div>
    </article><WalletHistoryResults result={result}/></>}
  </section>;
}
