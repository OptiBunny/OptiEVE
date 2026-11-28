'use client';
import { useId, useState } from 'react';
import { formatISK } from './lib/analytics-client';
import type { WalletAnalytics } from './lib/wallet-analytics-types';

type Day = WalletAnalytics['daily'][number];
type CalendarProps = { daily: Day[]; start: string | null; end: string | null; source: 'journal page' | 'saved report' };
const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const dayMs = 86400000;
const utcDate = (date: Date) => date.toISOString().split('T')[0];

function dayLabel(row: Day | undefined) {
  if (!row) return 'No observation';
  if (row.totals === null) return 'Amounts unknown';
  if (row.missingAmountEntries) return 'Partial amounts';
  if (!/[1-9]/.test(row.totals.netISK)) return 'Zero net';
  return row.totals.netISK.startsWith('-') ? 'Net outflow' : 'Net inflow';
}

export default function WalletActivityCalendar({ daily, start, end, source }: CalendarProps) {
  const id = useId();
  const [selection, setSelection] = useState('');
  if (start === null || end === null) return <p>No dated observations on this {source}.</p>;
  const first = utcDate(new Date(start)), last = utcDate(new Date(end));
  const selected = selection >= first && selection <= last ? selection : last;
  const selectedDate = new Date(selected + 'T00:00:00Z');
  const monthStart = new Date(selectedDate);
  monthStart.setUTCDate(1);
  const nextMonth = new Date(monthStart);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const monthEnd = new Date(+nextMonth - dayMs);
  const previousDay = utcDate(new Date(+monthStart - dayMs));
  const leading = (monthStart.getUTCDay() + 6) % 7;
  const weeks = Math.ceil((leading + monthEnd.getUTCDate()) / 7);
  const byDate = new Map(daily.map(row => [row.date, row]));
  const current = byDate.get(selected);
  const outside = daily.filter(row => row.date < first || row.date > last);

  return <details className="overview-card"><summary>Wallet activity calendar · {source}</summary>
    <p className="overview-hint">{first} through {last} UTC. Boundary days can be partial. A date without observations has unknown activity.</p>
    <div className="overview-controls">
      <button type="button" className="small" disabled={+monthStart <= Date.parse(first + 'T00:00:00Z')} onClick={() => setSelection(previousDay)}>Previous month</button>
      <div><label htmlFor={id}>Inspect UTC date</label><input id={id} type="date" min={first} max={last} value={selected} onChange={event => {
        const date = event.target.value;
        const instant = Date.parse(date + 'T00:00:00Z');
        if (date >= first && date <= last && Number.isFinite(instant) && utcDate(new Date(instant)) === date) setSelection(date);
      }}/></div>
      <button type="button" className="small" disabled={+nextMonth > Date.parse(last + 'T00:00:00Z')} onClick={() => setSelection(utcDate(nextMonth))}>Next month</button>
    </div>
    <div className="workspace-table-scroll" role="region" aria-label={'Wallet calendar for this ' + source} tabIndex={0}><table className="workspace-table">
      <caption>{selected.slice(0, 7)} UTC · {source}</caption>
      <thead><tr>{weekdays.map(day => <th scope="col" key={day}>{day}</th>)}</tr></thead>
      <tbody>{Array.from({ length: weeks }, (_, week) => <tr key={week}>{weekdays.map((weekday, index) => {
        const day = week * 7 + index - leading + 1;
        if (day < 1 || day > monthEnd.getUTCDate()) return <td key={weekday}/>;
        const date = utcDate(new Date(+monthStart + (day - 1) * dayMs));
        if (date < first || date > last) return <td key={weekday}>{day}<br/><small>Outside range</small></td>;
        const label = dayLabel(byDate.get(date));
        return <td key={weekday}><button type="button" className="small" aria-label={date + ', ' + label} aria-pressed={selected === date} onClick={() => setSelection(date)}>{day}<br/><small>{label}</small></button></td>;
      })}</tr>)}</tbody>
    </table></div>
    <div aria-live="polite"><h4>{selected} UTC · {dayLabel(current)}</h4>
      {current ? <><p>{current.entries} entries · {current.missingAmountEntries} without amounts</p>
        {current.totals && <dl className="overview-metrics">
          <div><dt>Observed incoming (ISK)</dt><dd>{formatISK(current.totals.incomingISK)}</dd></div>
          <div><dt>Observed outgoing (ISK)</dt><dd>{formatISK(current.totals.outgoingISK)}</dd></div>
          <div><dt>Observed net (ISK)</dt><dd>{formatISK(current.totals.netISK)}</dd></div>
        </dl>}</> : <p>No entries for this date in the loaded {source}.</p>}
    </div>
    {outside.length > 0 && <p>Outside this calendar range: {outside.map(row => row.date + ' (' + row.entries + ' entries)').join(', ')}.</p>}
  </details>;
}
