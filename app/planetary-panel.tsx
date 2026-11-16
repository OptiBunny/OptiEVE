'use client';
import { useEffect, useRef, useState } from 'react';
import { ConnectionResponseError } from './lib/connection-client';
import { planetaryAnalyticsRequest } from './lib/planetary-analytics-client';
import type { PlanetaryAnalytics, PlanetaryExtractor, PlanetaryType } from './lib/planetary-analytics-types';

export type PlanetaryChoice = { planetId: number; solarSystemId: number; planetType: PlanetaryType };
const day = 86400000;
const time = (value: string | null) => value === null ? 'Not reported' : value.replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC');
const buckets = [ ['past', 'At or before load time', 'pastExpiryPins'], ['day', 'Next 24 hours', 'next24hPins'], ['week', 'After 24 hours through 7 days', 'days2To7Pins'], ['month', 'After 7 through 30 days', 'days8To30Pins'], ['later', 'After 30 days', 'laterPins'], ['missing', 'Expiry not reported', 'missingExpiryPins'] ] as const;
function bucketOf(row: PlanetaryExtractor, at: number) {
  if (row.expiresAt === null) return 'missing';
  const delta = Date.parse(row.expiresAt) - at;
  return delta <= 0 ? 'past' : delta <= day ? 'day' : delta <= 7 * day ? 'week' : delta <= 30 * day ? 'month' : 'later';
}
export function PlanetaryResults({ result }: { result: PlanetaryAnalytics }) {
  const [bucket, setBucket] = useState('all'), [date, setDate] = useState(''), [product, setProduct] = useState('all'), [query, setQuery] = useState(''), [page, setPage] = useState(0);
  const summary = result.summary, schedule = result.schedule;
  if (!summary || !schedule) return <p className="overview-hint">Extractor evidence is unavailable. No empty schedule or zero production is assumed.</p>;
  const at = Date.parse(schedule.asOf), end = at + 30 * day;
  const products = [...new Map(result.extractors.filter(row => row.productTypeId !== null).map(row => [row.productTypeId!, row.productName!])).entries()].sort(([left], [right]) => left - right);
  const search = query.trim().toLowerCase();
  const filtered = result.extractors.filter(row => (bucket === 'all' || bucket === 'next30' ? bucket === 'all' || row.expiresAt !== null && Date.parse(row.expiresAt) > at && Date.parse(row.expiresAt) <= end : bucketOf(row, at) === bucket) &&
    (!date || row.expiresAt?.slice(0, 10) === date) && (product === 'all' || (product === 'missing' ? row.productTypeId === null : String(row.productTypeId) === product)) &&
    (!search || [row.reference, row.typeId, row.typeName, row.productTypeId ?? '', row.productName ?? ''].join(' ').toLowerCase().includes(search)));
  const pages = Math.max(1, Math.ceil(filtered.length / 100)), current = Math.min(page, pages - 1), shown = filtered.slice(current * 100, current * 100 + 100);
  const reset = () => { setBucket('all'); setDate(''); setProduct('all'); setQuery(''); setPage(0); };
  function selectBucket(value: string) { setBucket(value); setDate(''); setProduct('all'); setQuery(''); setPage(0); }
  function selectDate(value: string) { setBucket(value ? 'next30' : 'all'); setDate(value); setProduct('all'); setQuery(''); setPage(0); }
  const firstDay = new Date(at).setUTCHours(0, 0, 0, 0), lastDay = new Date(end).setUTCHours(0, 0, 0, 0), maximum = Math.max(1, ...schedule.daily.map(row => row.extractorPins));
  return <div>
    <dl className="overview-metrics"><div><dt>Accepted layout pins</dt><dd>{summary.pins}</dd></div><div><dt>Pins with extractor details</dt><dd>{summary.extractorPins}</dd></div><div><dt>Pins without extractor details</dt><dd>{summary.pinsWithoutExtractorDetails}</dd></div><div><dt>Product not reported</dt><dd>{summary.missingProductPins}</dd></div></dl>
    <p className="overview-hint">These counts cover the whole accepted selected layout. Pins without extractor details do not establish idle production. Listing/layout pin counts {summary.pinCountMatchesListing ? 'match' : 'differ'}; the two reads have independent caches.</p>
    <h4>Reported extractor expiries</h4><p>Compared with {time(schedule.asOf)}. A past date is not confirmed completion; a future date is not proof of running work.</p>
    <div className="overview-controls" role="group" aria-label="Filter by reported expiry window">{buckets.map(([key, label, field]) => <button className="small" key={key} aria-pressed={bucket === key && !date} onClick={() => selectBucket(key)}>{label}: {schedule[field]}</button>)}</div>
    <figure className="analytics-chart"><figcaption>Reported expiries in the next 30 rolling days · {schedule.daily.length} returned UTC dates</figcaption>
      <p className="overview-hint">Full-layout counts, before local filters. Dates have true UTC spacing; unreported dates are not filled with zeros. Exact bounds: after {time(schedule.asOf)} through {time(new Date(end).toISOString())}.</p>
      {schedule.daily.length > 0 ? <><svg viewBox="0 0 680 180" width="100%" height="180" aria-hidden="true" focusable="false">
        <line x1="30" y1="145" x2="650" y2="145" stroke="currentColor"/>
        {schedule.daily.map(row => { const x = 30 + (Date.parse(row.date) - firstDay) / Math.max(day, lastDay - firstDay) * 620, height = row.extractorPins / maximum * 110; return <rect key={row.date} data-date={row.date} x={x - 6} y={145 - height} width="12" height={height} fill="currentColor"/>; })}
        <text x="30" y="172" fill="currentColor" fontSize="12">{new Date(firstDay).toISOString().split('T')[0]}</text><text x="650" y="172" textAnchor="end" fill="currentColor" fontSize="12">{new Date(lastDay).toISOString().split('T')[0]}</text>
      </svg><div className="workspace-table-scroll" tabIndex={0} role="region" aria-label="Exact reported expiry counts by UTC date"><table className="workspace-table"><caption>All returned expiry dates in the 30-day window · select a date to inspect its rows</caption><thead><tr><th scope="col">UTC date</th><th scope="col">Extractor pins</th></tr></thead><tbody>{schedule.daily.map(row => <tr key={row.date}><th scope="row"><button className="small" aria-pressed={date === row.date} onClick={() => selectDate(row.date)}>{row.date}</button></th><td>{row.extractorPins}</td></tr>)}</tbody></table></div></> : <p>No reported future expiries fall within this 30-day window. This does not establish production state.</p>}
    </figure>
    <div className="overview-controls">
      <div><label htmlFor="colony-expiry-filter">Reported expiry window</label><select id="colony-expiry-filter" value={bucket} onChange={event => selectBucket(event.target.value)}><option value="all">All reported extractor rows</option>{buckets.map(([key, label]) => <option key={key} value={key}>{label}</option>)}<option value="next30">Next 30 rolling days</option></select></div>
      <div><label htmlFor="colony-date-filter">UTC expiry date within next 30 days</label><select id="colony-date-filter" value={date} onChange={event => selectDate(event.target.value)}><option value="">All dates</option>{schedule.daily.map(row => <option key={row.date} value={row.date}>{row.date}</option>)}</select></div>
      <div><label htmlFor="colony-product-filter">Reported product</label><select id="colony-product-filter" value={product} onChange={event => { setProduct(event.target.value); setPage(0); }}><option value="all">All products</option><option value="missing">Not reported</option>{products.map(([id, name]) => <option key={id} value={id}>{name} · {id}</option>)}</select></div>
      <div><label htmlFor="colony-search">Type, product or row reference</label><input id="colony-search" type="search" maxLength={512} value={query} onChange={event => { setQuery(event.target.value); setPage(0); }}/></div>
      <button className="small" onClick={reset}>Reset extractor filters</button>
    </div>
    <p role="status">{filtered.length} matching extractor rows of {summary.extractorPins} accepted · {shown.length ? `showing ${current * 100 + 1}–${current * 100 + shown.length}` : 'no matching rows'} · page {current + 1} of {pages}.</p>
    {shown.length > 0 && <div className="workspace-table-scroll" tabIndex={0} role="region" aria-label="Reported extractor details"><table className="workspace-table"><caption>Reported extractor details · references apply only to this load</caption><thead><tr>{['Row', 'Extractor type', 'Reported product', 'Heads', 'Cycle seconds', 'Quantity per cycle', 'Installed UTC', 'Last cycle started UTC', 'Expiry UTC'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{shown.map(row => <tr key={row.reference}><th scope="row">{row.reference}</th><td>{row.typeName}<br/><small>Type {row.typeId}</small></td><td>{row.productTypeId === null ? 'Not reported' : <>{row.productName}<br/><small>Type {row.productTypeId}</small></>}</td><td>{row.headCount}</td><td>{row.cycleTimeSeconds ?? 'Not reported'}</td><td>{row.quantityPerCycle ?? 'Not reported'}</td><td>{time(row.installedAt)}</td><td>{time(row.lastCycleStartedAt)}</td><td>{time(row.expiresAt)}</td></tr>)}</tbody></table></div>}
    <div className="overview-controls"><button className="small" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous extractor page</button><button className="small" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>Next extractor page</button></div>
    <p className="overview-hint">Cycle seconds and quantity per cycle are separate reported fields. They are not a constant rate, accrued yield, inventory or profit. Missing optional values remain not reported.</p>
  </div>;
}

export default function PlanetaryPanel({ characterId, planets }: { characterId: number; planets: PlanetaryChoice[] }) {
  const [planetId, setPlanetId] = useState(planets[0]?.planetId ?? 0), [result, setResult] = useState<PlanetaryAnalytics | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [signedOut, setSignedOut] = useState(false);
  const [generation, setGeneration] = useState(0); const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  function clear() { setGeneration(value => value + 1); active.current?.abort(); active.current = null; setResult(null); setBusy(false); setError(''); setSignedOut(false); }
  async function load() {
    clear(); if (!planets.some(planet => planet.planetId === planetId)) return;
    const controller = new AbortController(); active.current = controller; setBusy(true);
    try { const value = await planetaryAnalyticsRequest({ characterId, planetId }, controller.signal); if (active.current === controller && !controller.signal.aborted) setResult(value); }
    catch (failure) { if (active.current === controller && !controller.signal.aborted) { setError((failure as Error).message); setSignedOut(failure instanceof ConnectionResponseError && failure.status === 401); } }
    finally { if (active.current === controller) setBusy(false); }
  }
  return <section aria-labelledby="selected-colony-heading">
    <h3 id="selected-colony-heading">Selected colony extractor evidence</h3>
    <p>Choose from this displayed planet batch, then load one colony. The owned colony list is checked again before its layout is read. Changing the choice does not load data.</p>
    <div className="overview-controls"><div><label htmlFor="colony-planet">Displayed colony planet</label><select id="colony-planet" value={planetId} onChange={event => { clear(); setPlanetId(Number(event.target.value)); }}>{planets.map(planet => <option key={planet.planetId} value={planet.planetId}>Planet {planet.planetId} · {planet.planetType} · system {planet.solarSystemId}</option>)}</select></div><button className="button secondary" disabled={busy || !planetId} onClick={() => void load()}>{busy ? 'Loading selected colony…' : result ? 'Refresh selected colony' : 'Load selected colony'}</button>{busy && <button className="small" onClick={clear}>Cancel colony load</button>}</div>
    <p className="overview-hint">EVE recalculates colony information when you view the colony in the EVE client. HTTP cache freshness is separate from simulation updates; this view cannot establish current production or running state.</p>
    {error && <div role="alert" className="alert">{error}{signedOut && <p><a href="/signin-with-chatgpt?return_to=%2F" target="_top">Sign in with ChatGPT</a></p>}</div>}
    <p role="status" aria-live="polite">{busy ? 'Reading only the selected colony; this may take up to a minute.' : result ? `Colony evidence loaded ${time(result.generatedAt)}.` : 'No colony layout loaded.'}</p>
    {result && <article className="overview-card"><p>{result.message}</p>{result.colony && <p>Planet {result.planetId} · {result.colony.planetType} · system {result.colony.solarSystemId} · upgrade {result.colony.upgradeLevel} · listing reports {result.colony.reportedPins} pins. Provider last update: {time(result.colony.lastUpdateAt)}.</p>}
      <PlanetaryResults key={`${generation}:${result.characterId}:${result.planetId}:${result.generatedAt}`} result={result}/>
      <details className="overview-freshness"><summary>Colony sources, limits &amp; freshness</summary>{(['colonies', 'layout'] as const).map(key => { const source = result.sources[key]; return <div key={key}><h4>{key === 'colonies' ? 'Owned colony list' : 'Selected layout'}: {source.status}</h4><p>{source.message}</p><p>Accepted rows: {source.rows ?? 'unknown'} · HTTP cache: {source.freshness.state}</p><p>Fetched: {time(source.freshness.retrievedAt)} · cache expiry: {time(source.freshness.cacheExpires)} · last modified: {time(source.freshness.lastModified)}</p></div>; })}<p>Existing read permission: <code>{result.scope}</code></p><ul>{result.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></details>
    </article>}
  </section>;
}
