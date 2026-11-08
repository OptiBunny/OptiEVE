'use client';
import { useId } from 'react';
import { CountBars } from './analytics-charts';
import { RecordDonut } from './operations-charts';
import type { CharacterWorkspace } from './lib/character-workspace-types';

type StandingPoint = { sourceId: number; kind: string; standing: number };
type LoyaltyPoint = { corporationId: number; points: number };
type WarfarePoint = { period: string; label: string; kills: number; victoryPoints: number };
type ChartData =
  | { view: 'standings'; rows: StandingPoint[]; signs: { label: string; count: number }[] }
  | { view: 'loyalty_points'; rows: LoyaltyPoint[] }
  | { view: 'faction_warfare'; rows: WarfarePoint[] };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const periods = [{ period: 'yesterday', label: 'Yesterday' }, { period: 'last_week', label: 'Last week' }, { period: 'total', label: 'Reported total' }];
const kinds = ['Faction', 'NPC corporation', 'Agent'];

/** Charts use only the already validated, displayed batch, never full-response metrics. */
export function reputationChartData(result: CharacterWorkspace): ChartData | null {
  if (!['ready', 'partial'].includes(result.status) || !Array.isArray(result.rows) || result.rows.length > 100) return null;
  const seen = new Set<number>();
  if (result.view === 'standings') {
    const rows: StandingPoint[] = [];
    for (const row of result.rows) {
      if (!record(row) || !record(row.cells)) return null;
      const { sourceId, kind, standing } = row.cells;
      if (!integer(sourceId, 1) || seen.has(sourceId) || typeof kind !== 'string' || !kinds.includes(kind) ||
          typeof standing !== 'number' || !Number.isFinite(standing) || standing < -10 || standing > 10) return null;
      seen.add(sourceId); rows.push({ sourceId, kind, standing });
    }
    rows.sort((a, b) => Math.abs(b.standing) - Math.abs(a.standing) || kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.sourceId - b.sourceId);
    return { view: result.view, rows, signs: [
      { label: 'Positive', count: rows.filter(row => row.standing > 0).length },
      { label: 'Zero', count: rows.filter(row => row.standing === 0).length },
      { label: 'Negative', count: rows.filter(row => row.standing < 0).length },
    ] };
  }
  if (result.view === 'loyalty_points') {
    const rows: LoyaltyPoint[] = [];
    for (const row of result.rows) {
      if (!record(row) || !record(row.cells)) return null;
      const { corporationId, points } = row.cells;
      if (!integer(corporationId, 1) || seen.has(corporationId) || !integer(points)) return null;
      seen.add(corporationId); rows.push({ corporationId, points });
    }
    rows.sort((a, b) => b.points - a.points || a.corporationId - b.corporationId);
    return { view: result.view, rows };
  }
  if (result.view === 'faction_warfare') {
    if (result.rows.length !== periods.length) return null;
    const rows: WarfarePoint[] = [];
    for (const expected of periods) {
      const matches = result.rows.filter(row => record(row) && row.id === expected.period);
      if (matches.length !== 1 || !record(matches[0].cells)) return null;
      const { period, kills, victoryPoints } = matches[0].cells;
      if (period !== expected.label || !integer(kills) || !integer(victoryPoints)) return null;
      rows.push({ ...expected, kills, victoryPoints });
    }
    return { view: result.view, rows };
  }
  return null;
}

function StandingBars({ rows }: { rows: StandingPoint[] }) {
  const titleId = useId(), shown = rows.slice(0, 12), zero = 520, scale = 26;
  return <figure className="analytics-figure"><figcaption id={titleId}>Largest absolute standings in this batch</figcaption>
    <p className="overview-hint">Showing {shown.length} of {rows.length} displayed standings. The fixed scale is −10 to +10, with zero at the center. Values are reported standings, without skill adjustments or access guarantees. The table below contains every displayed row.</p>
    <div className="operations-chart-scroll" tabIndex={0} role="region" aria-label="Signed standings chart"><svg viewBox={`0 0 1000 ${shown.length * 44 + 56}`} role="img" aria-labelledby={titleId} className="industry-timeline">
      <desc>Negative standings extend left of zero; positive standings extend right. Exact values appear beside each bar and in the standings table.</desc>
      {[-10, -5, 0, 5, 10].map(value => <g key={value}><line x1={zero + value * scale} x2={zero + value * scale} y1="28" y2={shown.length * 44 + 30} stroke={value === 0 ? '#e6f3ff' : '#334a5e'} strokeDasharray={value === 0 ? undefined : '3 4'}/><text x={zero + value * scale} y="18" textAnchor="middle" fill="#badceb" fontSize="14">{value > 0 ? '+' : ''}{value}</text></g>)}
      {shown.map((row, index) => <g key={row.sourceId}><title>{`${row.kind} ${row.sourceId}: ${row.standing > 0 ? '+' : ''}${row.standing}`}</title><text x="0" y={index * 44 + 45} fill="#badceb" fontSize="14">{row.kind}</text><text x="0" y={index * 44 + 61} fill="#badceb" fontSize="13">{String(row.sourceId)}</text><rect x={row.standing < 0 ? zero + row.standing * scale : zero} y={index * 44 + 35} width={Math.abs(row.standing) * scale} height="26" rx="3" fill={row.standing < 0 ? '#ec9eac' : '#9ad6b0'}/><text x="990" y={index * 44 + 54} textAnchor="end" fill="#e6f3ff" fontSize="13">{row.standing > 0 ? '+' : ''}{String(row.standing)}</text></g>)}
    </svg></div>
  </figure>;
}

export default function ReputationCharts({ result }: { result: CharacterWorkspace }) {
  if (!['standings', 'loyalty_points', 'faction_warfare'].includes(result.view) || !['ready', 'partial'].includes(result.status) || !result.rows.length) return null;
  const data = reputationChartData(result);
  if (!data) return <p className="overview-hint">Reliable reputation charts are unavailable for this batch. No values are inferred.</p>;
  if (data.view === 'standings') return <section className="analytics-section" aria-label="Standings charts"><p className="overview-hint">Charts cover only the {data.rows.length} rows displayed in this batch. Other batches and full-response summary counts are excluded. Missing NPC entries are unknown, not neutral standings.</p><div className="overview-cards" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}><article className="overview-card"><RecordDonut title="Standing signs in the displayed batch" rows={data.signs} unit="displayed standings"/></article><article className="overview-card"><StandingBars rows={data.rows}/></article></div></section>;
  if (data.view === 'loyalty_points') return <section className="analytics-section" aria-label="Loyalty points chart"><p className="overview-hint">Largest {Math.min(12, data.rows.length)} separate balances among the {data.rows.length} corporations displayed in this batch, with ties ordered by corporation ID. Other batches are excluded. LP is not added across corporations or converted to ISK; missing corporations are unknown, not zero balances. All displayed balances remain in the table below.</p><CountBars title="Separate LP balances in this batch" rows={data.rows.slice(0, 12).map(row => ({ label: `NPC corporation ${row.corporationId}`, value: row.points }))} unit="LP"/></section>;
  return <section className="analytics-section" aria-label="Faction warfare charts"><p className="overview-hint">Yesterday and last week are reported windows; total is cumulative since enlistment. These periods overlap and have different lengths. They are never added together or presented as a trend or rate. Kills and victory points use separate scales, and exact counters remain in the table below.</p><div className="overview-cards"><article className="overview-card"><CountBars title="Reported faction-warfare kills" rows={data.rows.map(row => ({ label: row.label, value: row.kills }))} unit="kills"/></article><article className="overview-card"><CountBars title="Reported faction-warfare victory points" rows={data.rows.map(row => ({ label: row.label, value: row.victoryPoints }))} unit="victory points"/></article></div></section>;
}
