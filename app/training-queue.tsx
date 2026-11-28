'use client';
import { useId, useState } from 'react';
import { CountBars, QueueTimeline } from './analytics-charts';
import TrainingCoverage from './training-queue-coverage';
import type { CharacterQueueAnalytics, CharacterQueueEntry } from './lib/character-analytics-types';

const dayMs = 86400000;
const time = (value: string | null) => value ? new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : 'Not reported';
const bucketLabels = {
  elapsed: 'Finish date elapsed', next24h: 'Next 24 hours', days2to7: 'After 24 hours through 7 days',
  days8to30: 'After 7 days through 30 days', later: 'After 30 days', missing: 'No reported finish date',
};
type Bucket = keyof typeof bucketLabels;
type Filter = 'all' | 'next30d' | Bucket;
function bucketFor(entry: CharacterQueueEntry, asOf: number): Bucket {
  if (entry.finishAt === null) return 'missing';
  const remaining = Date.parse(entry.finishAt) - asOf;
  return remaining <= 0 ? 'elapsed' : remaining <= dayMs ? 'next24h' : remaining <= 7 * dayMs ? 'days2to7' : remaining <= 30 * dayMs ? 'days8to30' : 'later';
}

export function TrainingFinishChart({ schedule, selectDay }: { schedule: CharacterQueueAnalytics['schedule']; selectDay: (date: string) => void }) {
  const id = useId(), rows = schedule.daily;
  const first = Date.parse(new Date(schedule.asOf).toISOString().slice(0, 10) + 'T00:00:00Z');
  const end = Date.parse(schedule.asOf) + 30 * dayMs, last = Date.parse(new Date(end).toISOString().slice(0, 10) + 'T00:00:00Z');
  const span = (last - first) / dayMs + 1, maximum = Math.max(1, ...rows.map(row => row.entries));
  const x = (date: string) => 60 + ((Date.parse(date + 'T00:00:00Z') - first) / dayMs + .5) / span * 620;
  const width = Math.min(40, 620 / span * .7), ticks = [...new Set([0, Math.ceil(maximum / 2), maximum])];
  return <figure className="analytics-figure"><figcaption id={id}>Scheduled finishes by UTC date · next 30 days</figcaption>
    <p className="overview-hint">Full returned queue, regardless of the filters below. After {time(schedule.asOf)} through {time(new Date(end).toISOString())}. Only reported future finish dates in this rolling window are counted; the first and last UTC days can be partial. Gaps are omitted, not filled with assumed zero activity. Dates are scheduled evidence, not confirmed completions.</p>
    {rows.length ? <div className="operations-chart-scroll" tabIndex={0} role="region" aria-label="Training scheduled-finish chart"><svg viewBox="0 0 720 240" role="img" aria-labelledby={id} className="job-end-chart"><desc>Returned queue entries grouped by scheduled finish date with real UTC calendar spacing. Exact counts and date selection are in the following table.</desc>
      {ticks.map(value => <g key={value}><line x1="60" x2="680" y1={190 - value / maximum * 155} y2={190 - value / maximum * 155} stroke="#334a5e"/><text x="49" y={194 - value / maximum * 155} textAnchor="end" fill="#a8bfd1" fontSize="11">{value}</text></g>)}
      {rows.map(row => <rect key={row.date} x={x(row.date) - width / 2} y={190 - row.entries / maximum * 155} width={width} height={row.entries / maximum * 155} rx="2" fill="#81cbe8"><title>{row.date + ': ' + row.entries + ' scheduled queue finishes'}</title></rect>)}
      <text x="60" y="218" fill="#a8bfd1" fontSize="11">{new Date(first).toISOString().slice(0, 10)}</text><text x="680" y="218" textAnchor="end" fill="#a8bfd1" fontSize="11">{new Date(last).toISOString().slice(0, 10)}</text><text x="60" y="19" fill="#a8bfd1" fontSize="11">Scheduled queue entries</text>
    </svg></div> : <p className="overview-state">No reported future finish dates in the next 30 days. Entries with missing dates and later dates remain separate below.</p>}
    <details><summary>Exact scheduled-finish counts and date drill-down</summary><div className="workspace-table-scroll" tabIndex={0} role="region" aria-label="Training scheduled-finish values"><table className="workspace-table"><caption>Full returned queue · reported future finish dates within the next 30 days</caption><thead><tr><th scope="col">Date (UTC)</th><th scope="col">Queue entries</th><th scope="col">Inspect entries</th></tr></thead><tbody>{rows.map(row => <tr key={row.date}><th scope="row">{row.date}</th><td>{row.entries}</td><td><button className="small" aria-label={'Show queue entries scheduled on ' + row.date} onClick={() => selectDay(row.date)}>Show this date</button></td></tr>)}</tbody></table></div></details>
  </figure>;
}

export default function TrainingQueue({ queue }: { queue: CharacterQueueAnalytics }) {
  const [filter, setFilter] = useState<Filter>('all'), [date, setDate] = useState(''), [query, setQuery] = useState(''), [page, setPage] = useState(0);
  const id = useId(), schedule = queue.schedule, asOf = Date.parse(schedule.asOf);
  const counts = { elapsed: schedule.elapsedEntries, next24h: schedule.next24hEntries, days2to7: schedule.days2To7Entries, days8to30: schedule.days8To30Entries, later: schedule.laterEntries, missing: schedule.missingFinishEntries };
  const matching = queue.entries.filter(row => {
    const bucket = bucketFor(row, asOf);
    if (filter === 'next30d' ? !['next24h', 'days2to7', 'days8to30'].includes(bucket) : filter !== 'all' && filter !== bucket) return false;
    if (date && (row.finishAt === null || new Date(row.finishAt).toISOString().slice(0, 10) !== date)) return false;
    return (row.name + ' ' + row.typeId).toLowerCase().includes(query.trim().toLowerCase());
  });
  const currentPage = Math.min(page, Math.max(0, Math.ceil(matching.length / 100) - 1)), offset = currentPage * 100, shown = matching.slice(offset, offset + 100);
  const selectDay = (next: string) => { setDate(next); setFilter('next30d'); setQuery(''); setPage(0); };
  return <div className="analytics-section">
    <dl className="overview-metrics"><div><dt>Reported entries</dt><dd>{queue.entryCount}</dd></div><div><dt>Next planned finish (UTC)</dt><dd className="analytics-date">{time(queue.nextPlannedFinishAt)}</dd></div><div><dt>Last reported future finish (UTC)</dt><dd className="analytics-date">{time(queue.lastPlannedFinishAt)}</dd></div></dl>
    <p className="overview-hint">Schedule assessed at {time(schedule.asOf)}. These are fixed observations, not a live countdown. A past finish date does not confirm completion; absent dates do not establish a paused or empty queue. No active-training state, current SP or training rate is inferred. A last reported finish does not establish a complete queue horizon when other dates are missing.</p>
    <CountBars title="Reported queue schedule · all returned entries" unit="entries" rows={(Object.keys(bucketLabels) as Bucket[]).map(key => ({ label: bucketLabels[key], value: counts[key] }))}/>
    <p className="overview-hint">The six groups are disjoint: elapsed includes the assessment instant; each future group includes its upper boundary. Missing finish dates stay separate. Counts describe returned entries only.</p>
    <TrainingFinishChart schedule={schedule} selectDay={selectDay}/>
    <TrainingCoverage entries={queue.entries} asOf={schedule.asOf}/>
    <h4>Inspect reported queue entries</h4><p className="overview-hint">Filters change only this timeline and table. Summary counts and the daily chart above always cover the full returned queue. Filtering makes no new request.</p>
    <div className="overview-controls"><div><label htmlFor={id + '-bucket'}>Schedule group</label><select id={id + '-bucket'} value={filter} onChange={event => { setFilter(event.target.value as Filter); setDate(''); setPage(0); }}><option value="all">All returned entries</option><option value="next30d">Future finishes within 30 days</option>{(Object.keys(bucketLabels) as Bucket[]).map(key => <option key={key} value={key}>{bucketLabels[key]}</option>)}</select></div>
      <div><label htmlFor={id + '-date'}>Date from the 30-day chart</label><select id={id + '-date'} value={date} onChange={event => { if (event.target.value) selectDay(event.target.value); else { setDate(''); setPage(0); } }}><option value="">Any date in the selected group</option>{schedule.daily.map(row => <option key={row.date} value={row.date}>{row.date} UTC · {row.entries} entries</option>)}</select></div>
      <div><label htmlFor={id + '-query'}>Skill name or type ID</label><input id={id + '-query'} type="search" maxLength={200} value={query} onChange={event => { setQuery(event.target.value); setPage(0); }}/></div>
    </div>
    <p className="overview-state" role="status">{matching.length} matching entries. Timeline shows the first {Math.min(20, matching.length)} in reported queue order; table shows {shown.length ? offset + 1 : 0}–{offset + shown.length}.</p>
    <QueueTimeline entries={matching}/>
    <div className="workspace-table-scroll" tabIndex={0} role="region" aria-label="Filtered training queue dates"><table className="workspace-table"><caption>Matching queue entries · reported order and exact UTC dates</caption><thead><tr><th scope="col">Position</th><th scope="col">Skill</th><th scope="col">Target level</th><th scope="col">Start (UTC)</th><th scope="col">Finish (UTC)</th><th scope="col">Schedule group</th></tr></thead><tbody>{shown.map(row => <tr key={row.position}><td>{row.position + 1}</td><th scope="row">{row.name}<br/><small>Type {row.typeId}</small></th><td>{row.finishedLevel}</td><td>{time(row.startAt)}</td><td>{time(row.finishAt)}</td><td>{bucketLabels[bucketFor(row, asOf)]}</td></tr>)}</tbody></table></div>
    {!matching.length && <p className="overview-state">No returned queue entries match these filters.</p>}
    <div className="analytics-pagination"><button className="small" disabled={currentPage === 0} onClick={() => setPage(Math.max(0, currentPage - 1))}>Previous 100 queue entries</button><span>Page {currentPage + 1} of {Math.max(1, Math.ceil(matching.length / 100))}</span><button className="small" disabled={offset + 100 >= matching.length} onClick={() => setPage(currentPage + 1)}>Next 100 queue entries</button></div>
  </div>;
}
