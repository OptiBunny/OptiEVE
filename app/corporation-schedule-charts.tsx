'use client';
import { useState } from 'react';
import { CountBars } from './analytics-charts';
import type { CorporationWorkspace, CorporationWorkspaceRow } from './lib/corporation-workspace-types';

const day = 86400000;
const structureSeries = [{ key: 'fuelUntil', label: 'Reported fuel expiry' }, { key: 'timerEnd', label: 'Reported state timer end' }, { key: 'unanchorAt', label: 'Reported unanchor time' }] as const;
const extractionSeries = [{ key: 'arrival', label: 'Reported chunk arrival' }, { key: 'decay', label: 'Reported natural fracture' }] as const;
const windows = ['At or before load', 'Next 24 hours', 'After 24 hours through 7 days', 'After 7 through 30 days', 'After 30 days', 'Missing or invalid date'];
/** Accept explicit ISO instants only; invalid calendar dates must not roll forward. */
function instant(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const match = /^((?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const calendar = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`, wall = Date.parse(calendar), parsed = Date.parse(value);
  if (!Number.isFinite(wall) || new Date(wall).toISOString() !== calendar || !Number.isFinite(parsed)) return null;
  return parsed;
}
const utc = (value: number) => new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC');
function windowOf(value: number | null, at: number) {
  if (value === null) return 5;
  const delta = value - at;
  return delta <= 0 ? 0 : delta <= day ? 1 : delta <= 7 * day ? 2 : delta <= 30 * day ? 3 : 4;
}
function summarize(rows: CorporationWorkspaceRow[], key: string, at: number) {
  const counts = [0, 0, 0, 0, 0, 0], daily = new Map<string, number>();
  for (const row of rows) {
    const value = instant(row.cells[key]), index = windowOf(value, at); counts[index]++;
    if (value !== null && value > at && value <= at + 30 * day) { const date = new Date(value).toISOString().split('T')[0]; daily.set(date, (daily.get(date) ?? 0) + 1); }
  }
  return { counts, daily: [...daily].sort(([a], [b]) => Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')).map(([date, count]) => ({ date, count })) };
}

export default function CorporationScheduleCharts({ result }: { result: CorporationWorkspace }) {
  const series = result.view === 'structures' ? structureSeries : extractionSeries;
  const [chosen, setChosen] = useState<string>(series[0].key), [window, setWindow] = useState('all'), [date, setDate] = useState('');
  if (result.view !== 'structures' && result.view !== 'extractions') return null;
  if (result.status !== 'ready' && result.status !== 'partial') return <p className="overview-hint">Schedule charts are unavailable. Failed reads do not establish zero structures or extraction schedules.</p>;
  const at = instant(result.generatedAt), end = at === null ? NaN : at + 30 * day;
  if (at === null || !Number.isFinite(new Date(end).getTime()) || result.rows.length > 100) return <p className="overview-hint">The displayed schedule cannot be charted within its date and row limits. Review the source table; unknown dates are not zero.</p>;
  const selected = series.find(item => item.key === chosen) ?? series[0], summaries = series.map(item => ({ ...item, ...summarize(result.rows, item.key, at) })), summary = summaries.find(item => item.key === selected.key)!;
  const stateCounts = new Map<string, number>();
  for (const row of result.rows) { const state = row.cells[result.view === 'structures' ? 'state' : 'phase'], label = typeof state === 'string' && state ? state : 'Unknown'; stateCounts.set(label, (stateCounts.get(label) ?? 0) + 1); }
  const filtered = result.rows.filter(row => { const value = instant(row.cells[selected.key]); return (window === 'all' || window === 'next30' ? window === 'all' || value !== null && value > at && value <= end : windowOf(value, at) === Number(window)) && (!date || value !== null && new Date(value).toISOString().split('T')[0] === date); });
  const firstDay = new Date(at).setUTCHours(0, 0, 0, 0), lastDay = new Date(end).setUTCHours(0, 0, 0, 0), maximum = Math.max(1, ...summary.daily.map(row => row.count)), inWindow = summary.counts[1] + summary.counts[2] + summary.counts[3];
  function chooseSeries(value: string) { setChosen(value); setWindow('all'); setDate(''); }
  function chooseDay(value: string) { setDate(value); setWindow(value ? 'next30' : 'all'); }
  return <section aria-label="Displayed structure and extraction schedules">
    <h3>{result.view === 'structures' ? 'Structure schedules' : 'Moon extraction schedules'}</h3>
    <p className="overview-hint">Only the {result.rows.length} rows in this displayed response are summarized; coverage is {result.coverage}. Other provider pages and batches are not combined. Comparisons are fixed at load time, {utc(at)}; refreshing remains manual.</p>
    <CountBars title={result.view === 'structures' ? 'Reported structure states · all displayed rows' : 'Reported extraction schedule phases · all displayed rows'} rows={[...stateCounts].sort(([a], [b]) => a.localeCompare(b)).map(([label, value]) => ({ label, value }))} unit="rows"/>
    <p className="overview-hint">{result.view === 'structures' ? 'Fuel expiry, state timer end and unanchor time are independent reported dates. They do not establish fuel quantity, low-power or abandoned state, destruction or a completed unanchor. The shortened service-name list is not counted or used to infer structure state.' : 'Arrival and natural fracture are separate provider schedules. A chunk may be fractured earlier; these dates do not establish actual fracture, ore availability, mining yield or depletion. Reported phases describe the schedule at load time.'}</p>
    <div className="workspace-table-scroll" tabIndex={0} role="region" aria-label="Independent schedule window counts"><table className="workspace-table"><caption>Each date series separately partitions all {result.rows.length} displayed rows · do not add series together</caption><thead><tr><th scope="col">Date series</th>{windows.map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{summaries.map(item => <tr key={item.key}><th scope="row">{item.label}</th>{item.counts.map((count, index) => <td key={index}>{count}</td>)}</tr>)}</tbody></table></div>
    <div className="overview-controls"><div><label htmlFor="corporation-schedule-series">Date series</label><select id="corporation-schedule-series" value={selected.key} onChange={event => chooseSeries(event.target.value)}>{series.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></div><div><label htmlFor="corporation-schedule-window">Reported time window</label><select id="corporation-schedule-window" value={window} onChange={event => { setWindow(event.target.value); setDate(''); }}><option value="all">All displayed rows</option>{windows.map((label, index) => <option key={label} value={index}>{label}</option>)}<option value="next30">Next 30 rolling days</option></select></div><div><label htmlFor="corporation-schedule-day">UTC date in next 30 days</label><select id="corporation-schedule-day" value={date} onChange={event => chooseDay(event.target.value)}><option value="">All dates</option>{summary.daily.map(item => <option key={item.date} value={item.date}>{item.date}</option>)}</select></div><button className="small" onClick={() => { setWindow('all'); setDate(''); }}>Reset schedule filters</button></div>
    <figure className="analytics-figure"><figcaption>{selected.label} · next 30 rolling days</figcaption>
      <p className="overview-hint">Calendar uses all displayed rows before local filters. {inWindow} dated rows shown across {summary.daily.length} returned UTC dates; {result.rows.length - inWindow} rows omitted from this calendar because their dates are past, later or unknown. Dates are spaced by UTC day and gaps are not filled with zeros. Bounds: after {utc(at)} through {utc(end)}.</p>
      {summary.daily.length ? <><svg viewBox="0 0 680 180" width="100%" height="180" aria-hidden="true" focusable="false"><line x1="30" y1="145" x2="650" y2="145" stroke="currentColor"/>{summary.daily.map(item => { const x = 30 + (Date.parse(item.date + 'T00:00:00Z') - firstDay) / Math.max(day, lastDay - firstDay) * 620, height = item.count / maximum * 110; return <rect key={item.date} data-date={item.date} x={x - 6} y={145 - height} width="12" height={height} fill="currentColor"/>; })}<text x="30" y="172" fontSize="12" fill="currentColor">{new Date(firstDay).toISOString().split('T')[0]}</text><text x="650" y="172" textAnchor="end" fontSize="12" fill="currentColor">{new Date(lastDay).toISOString().split('T')[0]}</text></svg><div className="workspace-table-scroll" tabIndex={0} role="region" aria-label={selected.label + ' exact UTC dates'}><table className="workspace-table"><caption>All returned calendar dates · select one to inspect matching rows</caption><thead><tr><th scope="col">UTC date</th><th scope="col">Rows in this series</th></tr></thead><tbody>{summary.daily.map(item => <tr key={item.date}><th scope="row"><button className="small" aria-pressed={date === item.date} onClick={() => chooseDay(item.date)}>{item.date}</button></th><td>{item.count}</td></tr>)}</tbody></table></div></> : <p>No valid reported dates fall within this series’ 30-day calendar. This is not a statement of current game state.</p>}
    </figure>
    <p role="status">{filtered.length} matching rows of {result.rows.length} displayed. The original source table below retains all displayed rows.</p>
    {filtered.length ? <div className="workspace-table-scroll" tabIndex={0} role="region" aria-label="Selected schedule rows"><table className="workspace-table"><caption>{selected.label} · matching displayed rows</caption><thead><tr><th scope="col">Structure ID</th><th scope="col">{result.view === 'structures' ? 'Reported name' : 'Moon ID'}</th><th scope="col">{selected.label} (UTC)</th><th scope="col">{result.view === 'structures' ? 'Reported state' : 'Schedule at load'}</th></tr></thead><tbody>{filtered.map(row => { const value = instant(row.cells[selected.key]); return <tr key={row.id}><th scope="row">{row.cells.structure ?? row.id}</th><td>{row.cells[result.view === 'structures' ? 'name' : 'moon'] ?? 'Not reported'}</td><td>{value === null ? 'Missing or invalid date' : utc(value)}</td><td>{row.cells[result.view === 'structures' ? 'state' : 'phase'] ?? 'Unknown'}</td></tr>; })}</tbody></table></div> : <p>No displayed rows match these schedule filters.</p>}
  </section>;
}
