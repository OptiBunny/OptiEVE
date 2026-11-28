import type { CharacterQueueEntry } from './lib/character-analytics-types';

type Interval = { start: number; end: number };
const dayMs = 86400000;

export function trainingCoverage(entries: CharacterQueueEntry[], start: number, end: number) {
  const changes = new Map<number, number>();
  let unclassified = 0, zeroLength = 0, outside = 0, included = 0;
  for (const entry of entries) {
    const from = entry.startAt === null ? NaN : Date.parse(entry.startAt);
    const to = entry.finishAt === null ? NaN : Date.parse(entry.finishAt);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) { unclassified++; continue; }
    if (from === to) { zeroLength++; continue; }
    const left = Math.max(start, from), right = Math.min(end, to);
    if (left >= right) { outside++; continue; }
    included++;
    changes.set(left, (changes.get(left) ?? 0) + 1);
    changes.set(right, (changes.get(right) ?? 0) - 1);
  }

  const gaps: Interval[] = [], overlaps: Interval[] = [];
  let coveredMs = 0, overlapMs = 0, gapMs = 0, active = 0;
  let previous: number | undefined;
  for (const [at, delta] of [...changes].sort(([a], [b]) => a - b)) {
    if (previous !== undefined) {
      const duration = at - previous;
      if (active > 0) coveredMs += duration;
      if (active > 1) {
        overlapMs += duration;
        const last = overlaps.at(-1);
        if (last?.end === previous) last.end = at;
        else overlaps.push({ start: previous, end: at });
      } else if (active === 0) {
        gaps.push({ start: previous, end: at });
        gapMs += duration;
      }
    }
    active += delta;
    previous = at;
  }
  return { included, unclassified, zeroLength, outside, coveredMs, gapMs, overlapMs, gaps, overlaps };
}

function duration(ms: number) {
  if (ms === 0) return '0 s';
  const days = Math.floor(ms / dayMs), hours = Math.floor(ms / 3600000) % 24;
  const minutes = Math.floor(ms / 60000) % 60, seconds = (ms % 60000) / 1000;
  return [days && days + ' d', hours && hours + ' h', minutes && minutes + ' min', seconds && seconds + ' s'].filter(Boolean).join(' ');
}

const utc = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', ' UTC');

export default function TrainingCoverage({ entries, asOf }: { entries: CharacterQueueEntry[]; asOf: string }) {
  const start = Date.parse(asOf), end = start + 30 * dayMs;
  const result = trainingCoverage(entries, start, end);
  return <details className="overview-card"><summary>Training queue gaps and overlaps · next 30 days</summary>
    <p>Reported intervals from {utc(start)} to {utc(end)}. A gap is time between two reported intervals. Entries without usable dates can leave the schedule uncertain.</p>
    <p>{result.included} entries intersect this window · {result.outside} outside · {result.zeroLength} with zero duration · {result.unclassified} with missing or invalid dates.</p>
    {result.included === 0 ? <p>No usable interval intersects this window.</p> : <>
      <dl className="overview-metrics">
        <div><dt>Time covered by reported entries</dt><dd>{duration(result.coveredMs)}</dd></div>
        <div><dt>Time in internal gaps</dt><dd>{duration(result.gapMs)}</dd></div>
        <div><dt>Time with overlapping entries</dt><dd>{duration(result.overlapMs)}</dd></div>
      </dl>
      {([['Internal gaps', result.gaps], ['Overlaps', result.overlaps]] as const).map(([label, intervals]) =>
        intervals.length > 0 && <div key={label} className="workspace-table-scroll" tabIndex={0} role="region" aria-label={label + ' in the reported queue'}>
          <table className="workspace-table"><caption>{label} · earliest {Math.min(20, intervals.length)} of {intervals.length}</caption>
            <thead><tr><th scope="col">Start (UTC)</th><th scope="col">End (UTC)</th><th scope="col">Duration</th></tr></thead>
            <tbody>{intervals.slice(0, 20).map(interval => <tr key={interval.start}><th scope="row">{utc(interval.start)}</th><td>{utc(interval.end)}</td><td>{duration(interval.end - interval.start)}</td></tr>)}</tbody>
          </table>
        </div>)}
    </>}
  </details>;
}
