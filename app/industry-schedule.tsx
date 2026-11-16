'use client';
import { useId } from 'react';
import type { IndustryJob, IndustrySchedule } from './lib/industry-analytics-types';
import { utcTime } from './operations-charts';

export const industryScheduleBuckets = [
  { value: 'past', key: 'activePastEndJobs', label: 'Reported end at or before load' },
  { value: 'next24h', key: 'activeNext24hJobs', label: 'Reported end in the next 24 hours' },
  { value: 'days2To7', key: 'activeDays2To7Jobs', label: 'Reported end after 24 hours, within 7 days' },
  { value: 'days8To30', key: 'activeDays8To30Jobs', label: 'Reported end after 7 days, within 30 days' },
  { value: 'later', key: 'activeLaterJobs', label: 'Reported end after 30 days' },
] as const;
export type IndustryScheduleFilter = 'all' | 'next30d' | typeof industryScheduleBuckets[number]['value'];

export function industryScheduleMatches(job: IndustryJob, asOf: string, bucket: IndustryScheduleFilter, day: string): boolean {
  if (bucket === 'all' && !day) return true;
  if (job.status !== 'active') return false;
  const offset = Date.parse(job.endAt) - Date.parse(asOf), unit = 86400000;
  if (day && (offset <= 0 || offset > 30 * unit || job.endAt.slice(0, 10) !== day)) return false;
  switch (bucket) {
    case 'past': return offset <= 0;
    case 'next24h': return offset > 0 && offset <= unit;
    case 'days2To7': return offset > unit && offset <= 7 * unit;
    case 'days8To30': return offset > 7 * unit && offset <= 30 * unit;
    case 'later': return offset > 30 * unit;
    case 'next30d': return offset > 0 && offset <= 30 * unit;
    default: return true;
  }
}

export function IndustryScheduleCalendar({ schedule, selectBucket, selectDate }: { schedule: IndustrySchedule; selectBucket: (bucket: IndustryScheduleFilter) => void; selectDate: (day: string) => void }) {
  const id = useId(), rows = schedule.daily, maximum = Math.max(1, ...rows.map(row => row.activeJobs));
  const firstDay = schedule.asOf.slice(0, 10), first = Date.parse(firstDay + 'T00:00:00.000Z');
  // Derive the visible domain from supported returned dates. Adding 30 days to
  // a late year-9999 timestamp would produce an unsupported expanded ISO year.
  const lastDay = rows.at(-1)?.date ?? firstDay, last = Date.parse(lastDay + 'T00:00:00.000Z');
  const days = (last - first) / 86400000 + 1, width = Math.min(36, 620 / days * .7);
  const x = (day: string) => 60 + ((Date.parse(day + 'T00:00:00.000Z') - first) / 86400000 + .5) / days * 620;
  return <article className="overview-card analytics-section"><h3>Reported-active job schedule</h3>
    <p className="overview-hint">All reported-active jobs in this response, evaluated at {utcTime(schedule.asOf)}. The five groups are disjoint. Ready and paused jobs keep their reported status and are excluded here. Dates do not establish that a job is running, completed or delivered.</p>
    <dl className="overview-metrics">{industryScheduleBuckets.map(bucket => <div key={bucket.value}><dt>{bucket.label}</dt><dd>{schedule[bucket.key].toLocaleString()}</dd><dd><button className="small" onClick={() => selectBucket(bucket.value)} aria-label={'Show active jobs: ' + bucket.label.toLowerCase()}>Show jobs</button></dd></div>)}</dl>
    <figure className="analytics-figure"><figcaption id={id}>Active-job end calendar · next 30 days</figcaption>
      <p className="overview-hint">Future reported ends strictly after load and through 30 days after load, grouped by UTC date. The first and last dates may cover only part of a day. Empty dates are omitted; calendar gaps retain their actual spacing. Calendar selections show the exact contributing jobs.</p>
      {rows.length ? <div className="operations-chart-scroll" tabIndex={0} role="region" aria-label="Reported active-job schedule chart"><svg viewBox="0 0 720 240" role="img" aria-labelledby={id} className="job-end-chart"><desc>Reported-active job counts by UTC end date within the rolling 30-day window. Exact counts and date controls follow in the table.</desc>
        {[0, .5, 1].map(ratio => <g key={ratio}><line x1="60" x2="680" y1={190 - ratio * 155} y2={190 - ratio * 155} stroke="#334a5e"/><text x="49" y={194 - ratio * 155} textAnchor="end" fill="#a8bfd1" fontSize="11">{(maximum * ratio).toLocaleString()}</text></g>)}
        {rows.map(row => <rect key={row.date} x={x(row.date) - width / 2} y={190 - row.activeJobs / maximum * 155} width={width} height={row.activeJobs / maximum * 155} rx="2" fill="#81cbe8"><title>{`${row.date}: ${row.activeJobs} reported-active jobs`}</title></rect>)}
        <text x="60" y="218" fill="#a8bfd1" fontSize="11">{firstDay}</text><text x="680" y="218" textAnchor="end" fill="#a8bfd1" fontSize="11">{lastDay}</text><text x="60" y="19" fill="#a8bfd1" fontSize="11">Reported-active jobs</text>
      </svg></div> : <p className="overview-hint">No reported-active jobs have future end times within this 30-day window.</p>}
      <div className="workspace-table-scroll" tabIndex={0} role="region" aria-label="Reported active-job schedule values"><table className="workspace-table"><caption>Full response · active-job future ends within 30 days · UTC dates</caption><thead><tr><th scope="col">Reported end date</th><th scope="col">Active jobs</th><th scope="col">Browse</th></tr></thead><tbody>{rows.map(row => <tr key={row.date}><th scope="row">{row.date}</th><td>{row.activeJobs}</td><td><button className="small" onClick={() => selectDate(row.date)} aria-label={'Show active jobs ending on ' + row.date + ' within the 30-day window'}>Show jobs</button></td></tr>)}</tbody></table></div>
    </figure>
  </article>;
}
