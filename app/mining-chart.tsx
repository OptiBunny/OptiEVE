'use client';
import { useId, useState } from 'react';
import { characterPublicName } from './lib/character-workspace-client';
import type { CharacterWorkspace, CharacterWorkspaceRow } from './lib/character-workspace-types';

export type MiningDay = { date: string; quantity: number; records: number };
export function miningChartDays(rows: CharacterWorkspaceRow[], typeId: number): MiningDay[] | null {
  if (!Number.isSafeInteger(typeId) || typeId <= 0 || rows.length > 100) return null;
  const days = new Map<string, MiningDay>(), seen = new Set<string>();
  for (const row of rows) {
    const { date, type, system, quantity } = row.cells;
    if (type !== typeId) continue;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + 'T00:00:00Z')) ||
        new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date || !Number.isSafeInteger(system) || Number(system) <= 0 ||
        typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 0) return null;
    const record = `${date}-${type}-${system}`;
    if (seen.has(record)) return null;
    seen.add(record);
    const day = days.get(date) ?? { date, quantity: 0, records: 0 };
    if (day.quantity > Number.MAX_SAFE_INTEGER - quantity) return null;
    day.quantity += quantity; day.records++;
    days.set(date, day);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const compact = (value: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const exact = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
const dayStamp = (value: string) => Date.parse(value + 'T00:00:00Z');
const utcDay = (value: number) => new Date(value).toISOString().slice(0, 10);

export default function MiningChart({ result }: { result: CharacterWorkspace }) {
  const types = [...new Set(result.rows.map(row => row.cells.type).filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0))].sort((a, b) => a - b);
  const [selectedType, setSelectedType] = useState(types[0] ?? 0);
  const id = useId();
  if (result.view !== 'mining' || !types.length || !['ready', 'partial'].includes(result.status)) return null;
  const typeId = types.includes(selectedType) ? selectedType : types[0];
  const days = miningChartDays(result.rows, typeId);
  const material = (value: number) => {
    const name = characterPublicName(result, 'type', value);
    return name ? `${name} · Type ${value}` : `Type ${value}`;
  };
  const selectedLabel = material(typeId);
  const width = 680, height = 270, left = 76, right = 24, top = 28, bottom = 54;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const maximum = days?.length ? Math.max(...days.map(day => day.quantity)) : 0;
  const first = days?.length ? dayStamp(days[0].date) : 0, last = days?.length ? dayStamp(days[days.length - 1].date) : 0;
  const countDays = (last - first) / 86400000 + 1;
  const x = (date: string) => left + ((dayStamp(date) - first) / 86400000 + 0.5) / countDays * plotWidth;
  const y = (quantity: number) => top + plotHeight - (maximum ? quantity / maximum * plotHeight : 0);
  const barWidth = Math.max(1, Math.min(44, plotWidth / countDays * 0.65));
  const ticks = days?.length ? [...new Set([first, first + Math.floor((countDays - 1) / 2) * 86400000, last])].map(utcDay) : [];
  return <section aria-labelledby={`${id}-heading`} style={{ borderTop: '1px solid var(--line, #334155)', marginTop: '1.25rem', paddingTop: '1.25rem' }}>
    <div className="overview-card-heading"><div><p className="eyebrow">MINING ACTIVITY</p><h4 id={`${id}-heading`}>Daily material quantities</h4></div></div>
    <div className="overview-controls"><div><label htmlFor={`${id}-material`}>Material in this batch</label><select id={`${id}-material`} value={typeId} onChange={event => setSelectedType(Number(event.target.value))}>{types.map(type => <option key={type} value={type}>{material(type)}</option>)}</select></div></div>
    <p id={`${id}-description`} className="overview-hint">Only the {result.rows.length} displayed records in this batch are charted. Quantities for the selected material are grouped by UTC date across the displayed solar systems. Other batches and pages are excluded. Dates without a returned record are unknown, not zero; this is not a complete 30-day history, volume, income or profit.</p>
    {!days || !days.length ? <p className="overview-message" role="status">A reliable chart is unavailable for this batch. Review the reported records below.</p> : <>
      <svg role="img" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', width: '100%', height: 'auto', maxHeight: '340px', overflow: 'visible' }}>
        <title id={`${id}-title`}>{`Reported mining quantities for ${selectedLabel}, ${days.length} returned UTC dates`}</title>
        {(maximum ? [0, 0.5, 1] : [0]).map(fraction => <g key={fraction}>
          <line x1={left} y1={top + plotHeight * (1 - fraction)} x2={width - right} y2={top + plotHeight * (1 - fraction)} stroke="currentColor" strokeOpacity="0.15"/>
          <text x={left - 10} y={top + plotHeight * (1 - fraction) + 4} textAnchor="end" fill="currentColor" fontSize="11">{compact(maximum * fraction)}</text>
        </g>)}
        <text x={left} y={14} fill="currentColor" fontSize="12">Units of selected material</text>
        {days.map(day => <g key={day.date}>
          <title>{`${day.date} UTC: ${exact(day.quantity)} units from ${day.records} displayed ${day.records === 1 ? 'record' : 'records'}`}</title>
          {day.quantity === 0 ? <circle cx={x(day.date)} cy={y(0)} r="3" fill="currentColor"/> : <rect x={x(day.date) - barWidth / 2} y={y(day.quantity)} width={barWidth} height={Math.max(1, plotHeight * day.quantity / maximum)} rx="2" fill="var(--accent, #38bdf8)"/>}
        </g>)}
        {ticks.map(date => <text key={date} x={x(date)} y={height - 30} textAnchor="middle" fill="currentColor" fontSize="11">{date}</text>)}
        <text x={left + plotWidth / 2} y={height - 8} textAnchor="middle" fill="currentColor" fontSize="11">Date (UTC) · gaps are unreported dates</text>
      </svg>
      <details className="overview-freshness"><summary>Chart values · {selectedLabel}</summary><div className="workspace-table-scroll" tabIndex={0} role="region" aria-label="Mining chart values"><table className="workspace-table">
        <caption>{selectedLabel} · displayed batch only</caption>
        <thead><tr><th scope="col">Date (UTC)</th><th scope="col">Reported quantity</th><th scope="col">Displayed records</th></tr></thead>
        <tbody>{days.map(day => <tr key={day.date}><th scope="row">{day.date}</th><td>{exact(day.quantity)}</td><td>{day.records}</td></tr>)}</tbody>
      </table></div></details>
    </>}
  </section>;
}
