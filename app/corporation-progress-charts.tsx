'use client';
import { CountBars } from './analytics-charts';
import type { CorporationWorkspace } from './lib/corporation-workspace-types';

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function ratio(current: unknown, target: unknown) {
  if (!count(current) || !count(target) || target === 0) return null;
  const numerator = BigInt(current), denominator = BigInt(target);
  const hundredths = numerator * 10000n / denominator;
  const label = numerator > 0n && hundredths === 0n ? '<0.01%' : numerator > denominator && hundredths === 10000n ? '>100%' : `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}%`;
  const width = numerator === 0n ? 0 : Math.max(0.75, Number(hundredths > 10000n ? 10000n : hundredths) / 100);
  return { label, width };
}
function ProgressRatio({ name, current, target, currentLabel = 'Current' }: { name: string; current: unknown; target: unknown; currentLabel?: string }) {
  const reported = ratio(current, target);
  return <div className="analytics-bar-row"><span>{name}</span><div className="analytics-track" aria-hidden="true">{reported && <span style={{ width: `${reported.width}%` }}/>}</div><strong>{reported?.label ?? 'Unknown'}<small> · {currentLabel} {count(current) ? String(current) : 'unknown'} / target {count(target) ? String(target) : 'unknown'}</small></strong></div>;
}
export default function CorporationProgressCharts({ result }: { result: CorporationWorkspace }) {
  if (!['projects', 'project', 'freelance_jobs'].includes(result.view)) return null;
  if (result.status !== 'ready' && result.status !== 'partial') return <p className="overview-hint">Reported progress charts are unavailable. State counts and target ratios are unknown.</p>;
  const counts = new Map<string, number>();
  for (const row of result.rows) {
    const state = typeof row.cells.state === 'string' && row.cells.state ? row.cells.state : 'Unknown';
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  const shown = result.rows.slice(0, 12), omitted = result.rows.length - shown.length;
  return <section aria-label="Reported project and freelance progress">
    <CountBars title="Reported states · all displayed rows" rows={[...counts].sort(([a], [b]) => a.localeCompare(b)).map(([label, value]) => ({ label, value }))} unit="rows"/>
    <figure className="analytics-figure"><figcaption>Reported progress / target</figcaption>
      <p className="overview-hint">Showing {shown.length} of {result.rows.length} displayed rows in table order; {omitted} omitted from these ratio bars. The exact table below retains every displayed row. These are this response’s rows, not corporation-wide totals or complete history.</p>
      <p className="overview-hint">Each objective uses its own units; progress and reward budgets are not added together. Ratios do not establish completion, earned rewards or payout. A zero or missing target has an unknown ratio. Percentages truncate to two decimals, with labels for tiny positive and just-over-target values. Bars stop at 100% and keep a small marker for positive values.</p>
      <div className="analytics-bars">{shown.map(row => <ProgressRatio key={row.id} name={typeof row.cells.name === 'string' ? row.cells.name : 'Unnamed objective'} current={row.cells.current} target={row.cells.desired}/>)}</div>
      {!shown.length && <p>No project or freelance rows were returned in this response.</p>}
    </figure>
    {result.view === 'project' && shown.length > 0 && <figure className="analytics-figure"><figcaption>Selected character’s reported contribution / project target</figcaption><p className="overview-hint">Contribution and project progress are independently retrieved snapshots. This separate target ratio does not compare contribution with current progress or assume the snapshots align.</p><div className="analytics-bars">{shown.map(row => <ProgressRatio key={row.id} name="Selected character contribution" currentLabel="Contribution" current={row.cells.ownContribution} target={row.cells.desired}/>)}</div></figure>}
  </section>;
}
