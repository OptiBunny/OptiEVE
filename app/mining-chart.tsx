'use client';
import { useId, useState } from 'react';
import { characterPublicName } from './lib/character-workspace-client';
import type { CharacterWorkspace, CharacterWorkspaceRow } from './lib/character-workspace-types';

export type MiningDay = { date: string; quantity: string; records: number };
export type MiningRecord = { date: string; system: number; quantity: string };
export type MiningSystem = { system: number; quantity: string; records: number; dates: number };
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const dayStamp = (value: string) => Date.parse(value + 'T00:00:00Z');
const utcDay = (value: number) => new Date(value).toISOString().slice(0, 10);
const exact = (value: string) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(BigInt(value));
const quantitySum = (rows: { quantity: string }[]) => String(rows.reduce((sum, row) => sum + BigInt(row.quantity), 0n));

/** Only one material in the displayed slice is combined; no provider-page totals. */
export function miningChartData(rows: CharacterWorkspaceRow[], typeId: number): { records: MiningRecord[]; systems: MiningSystem[] } | null {
  if (!positive(typeId) || rows.length > 100) return null;
  const records: MiningRecord[] = [], seen = new Set<string>();
  const systems = new Map<number, { system: number; quantity: bigint; records: number; dates: Set<string> }>();
  for (const row of rows) {
    const { date, type, system, quantity } = row.cells;
    if (type !== typeId) continue;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(dayStamp(date)) ||
        utcDay(dayStamp(date)) !== date || !positive(system) || typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 0) return null;
    const key = `${date}-${type}-${system}`;
    if (seen.has(key)) return null;
    seen.add(key); records.push({ date, system, quantity: String(quantity) });
    const group = systems.get(system) ?? { system, quantity: 0n, records: 0, dates: new Set<string>() };
    group.quantity += BigInt(quantity); group.records++; group.dates.add(date); systems.set(system, group);
  }
  records.sort((a, b) => a.date.localeCompare(b.date) || a.system - b.system);
  return { records, systems: [...systems.values()].sort((a, b) => a.quantity === b.quantity ? a.system - b.system : a.quantity > b.quantity ? -1 : 1)
    .map(row => ({ system: row.system, quantity: String(row.quantity), records: row.records, dates: row.dates.size })) };
}
function groupDays(records: MiningRecord[]): MiningDay[] {
  const days = new Map<string, MiningDay>();
  for (const record of records) {
    const day = days.get(record.date) ?? { date: record.date, quantity: '0', records: 0 };
    day.quantity = String(BigInt(day.quantity) + BigInt(record.quantity)); day.records++; days.set(record.date, day);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}
export function miningChartDays(rows: CharacterWorkspaceRow[], typeId: number, systemId: number | null = null): MiningDay[] | null {
  if (systemId !== null && !positive(systemId)) return null;
  const data = miningChartData(rows, typeId);
  return data ? groupDays(data.records.filter(row => systemId === null || row.system === systemId)) : null;
}
/** Approximate geometry after exact integer scaling; never an amount calculation. */
function ratio(value: string, maximum: string) { return maximum === '0' ? 0 : Number(BigInt(value) * 1_000_000n / BigInt(maximum)) / 1_000_000; }

export default function MiningChart({ result }: { result: CharacterWorkspace }) {
  const types = [...new Set(result.rows.map(row => row.cells.type).filter(positive))].sort((a, b) => a - b);
  const [selection, setSelection] = useState<{ type: number; system: number | null }>({ type: types[0] ?? 0, system: null });
  const id = useId();
  if (result.view !== 'mining' || !types.length || !['ready', 'partial'].includes(result.status)) return null;
  const typeId = types.includes(selection.type) ? selection.type : types[0], data = miningChartData(result.rows, typeId);
  const systemId = selection.type === typeId && data?.systems.some(row => row.system === selection.system) ? selection.system : null;
  const records = data?.records.filter(row => systemId === null || row.system === systemId) ?? [], days = groupDays(records);
  const material = (value: number) => { const name = characterPublicName(result, 'type', value); return name ? `${name} · Type ${value}` : `Type ${value}`; };
  const systemName = (value: number) => { const name = characterPublicName(result, 'system', value); return name ? `${name} · System ${value}` : `System ${value}`; };
  const selectType = (value: number) => { if (types.includes(value)) setSelection({ type: value, system: null }); };
  const selectSystem = (value: number | null) => {
    if (value !== null && !data?.systems.some(row => row.system === value)) return;
    setSelection(current => current.type === typeId ? { type: current.type, system: value } : current);
  };
  const selectedLabel = material(typeId), selectedSystem = systemId === null ? 'all displayed solar systems' : systemName(systemId);
  const width = 680, height = 270, left = 76, right = 24, top = 28, bottom = 54, plotWidth = width - left - right, plotHeight = height - top - bottom;
  const maximum = days.reduce((maximum, day) => BigInt(day.quantity) > BigInt(maximum) ? day.quantity : maximum, '0');
  const first = days.length ? dayStamp(days[0].date) : 0, last = days.length ? dayStamp(days[days.length - 1].date) : 0, countDays = (last - first) / 86400000 + 1;
  const x = (date: string) => left + ((dayStamp(date) - first) / 86400000 + 0.5) / countDays * plotWidth;
  const barHeight = (quantity: string) => quantity === '0' ? 0 : Math.max(1, ratio(quantity, maximum) * plotHeight);
  const barWidth = Math.max(1, Math.min(44, plotWidth / countDays * 0.65));
  const ticks = days.length ? [...new Set([first, first + Math.floor((countDays - 1) / 2) * 86400000, last])].map(utcDay) : [];
  const topSystems = data?.systems.slice(0, 12) ?? [], systemMaximum = data?.systems[0]?.quantity ?? '0';
  return <section aria-labelledby={`${id}-heading`} style={{ borderTop: '1px solid var(--line, #334155)', marginTop: '1.25rem', paddingTop: '1.25rem' }}>
    <div className="overview-card-heading"><div><p className="eyebrow">MINING ACTIVITY</p><h4 id={`${id}-heading`}>Material quantities by system and date</h4></div></div>
    <div className="overview-controls"><div><label htmlFor={`${id}-material`}>Material in this batch</label><select id={`${id}-material`} value={typeId} onChange={event => selectType(Number(event.target.value))}>{types.map(type => <option key={type} value={type}>{material(type)}</option>)}</select></div>
      <div><label htmlFor={`${id}-system`}>Solar system in this batch</label><select id={`${id}-system`} value={systemId ?? 'all'} onChange={event => selectSystem(event.target.value === 'all' ? null : Number(event.target.value))}><option value="all">All displayed systems</option>{data?.systems.map(row => <option key={row.system} value={row.system}>{systemName(row.system)}</option>)}</select></div></div>
    <p id={`${id}-description`} className="overview-hint">Only the {result.rows.length} displayed records in this batch are charted. Quantities combine one selected material only. Other batches and pages are excluded. Dates or systems without a returned record are unknown, not zero; this is not a complete 30-day history, volume, income or profit. Ledger records are date/material/system entries, not trips, sessions or mining cycles.</p>
    {!data || !days.length ? <p className="overview-message" role="status">A reliable chart is unavailable for this batch. Review the reported records below.</p> : <>
      <section className="overview-card analytics-section" aria-labelledby={`${id}-systems`}><h5 id={`${id}-systems`}>Reported systems · {selectedLabel}</h5><p>This ranking uses the selected material across the full displayed batch, independently of the system filter. {topSystems.length} of {data.systems.length} systems shown; {data.systems.length - topSystems.length} omitted from bars. Every observed system is available in the table.</p>
        <div className="analytics-bars" role="group" aria-label="Mining quantities by solar system">{topSystems.map(row => <div key={row.system} className="analytics-bar-row"><button type="button" className="small" aria-pressed={systemId === row.system} onClick={() => selectSystem(row.system)}>{systemName(row.system)}</button><svg viewBox="0 0 300 16" role="img" aria-label={`${systemName(row.system)}: ${exact(row.quantity)} units`} style={{ width: 'min(100%, 300px)', height: '16px' }}><title>{`${selectedLabel} · ${systemName(row.system)}: ${exact(row.quantity)} units from ${row.records} displayed records`}</title>{row.quantity === '0' ? <circle cx="2" cy="8" r="2" fill="currentColor"/> : <rect x="0" y="3" width={Math.max(1, ratio(row.quantity, systemMaximum) * 300)} height="10" fill="var(--accent, #38bdf8)"/>}</svg><span>{exact(row.quantity)} units · {row.records} records</span></div>)}</div>
        <p>Bar maximum: {exact(systemMaximum)} units. Positive quantities below one plot unit use a one-unit marker; zero uses a dot. Exact quantities are unchanged.</p>
        <div className="workspace-table-scroll" tabIndex={0} role="region" aria-label="All reported mining systems"><table className="workspace-table"><caption>{selectedLabel} · all {data.systems.length} reported systems in the displayed batch</caption><thead><tr><th scope="col">Solar system</th><th scope="col">Reported quantity</th><th scope="col">Displayed records</th><th scope="col">Reported dates</th></tr></thead><tbody>{data.systems.map(row => <tr key={row.system}><th scope="row"><button type="button" className="small" aria-pressed={systemId === row.system} onClick={() => selectSystem(row.system)}>{systemName(row.system)}</button></th><td>{exact(row.quantity)}</td><td>{row.records}</td><td>{row.dates}</td></tr>)}</tbody></table></div>
      </section>
      <h5>Daily material quantities · {selectedSystem}</h5><p>{selectedLabel}: {exact(quantitySum(records))} units from {records.length} matching displayed records across {days.length} returned UTC dates. This system filter changes the daily chart and contributing rows only.</p>
      <svg role="img" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', width: '100%', height: 'auto', maxHeight: '340px', overflow: 'visible' }}>
        <title id={`${id}-title`}>{`Reported mining quantities for ${selectedLabel}, ${selectedSystem}, ${days.length} returned UTC dates`}</title>
        {[0, ...(maximum !== '0' ? [1] : [])].map(fraction => <g key={fraction}><line x1={left} y1={top + plotHeight * (1 - fraction)} x2={width - right} y2={top + plotHeight * (1 - fraction)} stroke="currentColor" strokeOpacity="0.15"/><text x={left - 10} y={top + plotHeight * (1 - fraction) + 4} textAnchor="end" fill="currentColor" fontSize="11">{fraction === 0 ? '0' : 'maximum'}</text></g>)}
        <text x={left} y={14} fill="currentColor" fontSize="12">Units of selected material</text>
        {days.map(day => <g key={day.date}><title>{`${day.date} UTC: ${exact(day.quantity)} units from ${day.records} displayed ${day.records === 1 ? 'record' : 'records'}`}</title>{day.quantity === '0' ? <circle cx={x(day.date)} cy={top + plotHeight} r="3" fill="currentColor"/> : <rect x={x(day.date) - barWidth / 2} y={top + plotHeight - barHeight(day.quantity)} width={barWidth} height={barHeight(day.quantity)} rx="2" fill="var(--accent, #38bdf8)"/>}</g>)}
        {ticks.map(date => <text key={date} x={x(date)} y={height - 30} textAnchor="middle" fill="currentColor" fontSize="11">{date}</text>)}<text x={left + plotWidth / 2} y={height - 8} textAnchor="middle" fill="currentColor" fontSize="11">Date (UTC) · gaps are unreported dates</text>
      </svg>
      <p>Daily maximum: {exact(maximum)} units. Chart geometry is rounded; tiny positive quantities use a minimum one-unit marker. Exact values follow.</p>
      <details className="overview-freshness"><summary>Chart values · {selectedLabel} · {selectedSystem}</summary><div className="workspace-table-scroll" tabIndex={0} role="region" aria-label="Mining chart values"><table className="workspace-table"><caption>{selectedLabel} · {selectedSystem} · displayed batch only</caption><thead><tr><th scope="col">Date (UTC)</th><th scope="col">Reported quantity</th><th scope="col">Displayed records</th></tr></thead><tbody>{days.map(day => <tr key={day.date}><th scope="row">{day.date}</th><td>{exact(day.quantity)}</td><td>{day.records}</td></tr>)}</tbody></table></div></details>
      <details className="overview-freshness"><summary>Contributing displayed records · {records.length}</summary><p>This selected-material/system subset is separate from the full batch table below.</p><div className="workspace-table-scroll" tabIndex={0} role="region" aria-label="Contributing mining records"><table className="workspace-table"><caption>{selectedLabel} · {selectedSystem}</caption><thead><tr><th scope="col">Date (UTC)</th><th scope="col">Solar system</th><th scope="col">Reported quantity</th></tr></thead><tbody>{records.map(row => <tr key={`${row.date}-${row.system}`}><th scope="row">{row.date}</th><td>{systemName(row.system)}</td><td>{exact(row.quantity)}</td></tr>)}</tbody></table></div></details>
    </>}
  </section>;
}
