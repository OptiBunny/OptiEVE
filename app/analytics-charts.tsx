'use client';
import { useId } from 'react';
import { decimalMaximum, decimalWidth, formatISK } from './lib/analytics-client';
import type { CharacterQueueEntry } from './lib/character-analytics-types';
import type { WalletActivityBucket } from './lib/wallet-analytics-types';

export function CountBars({ title, rows, unit, scale }: { title: string; rows: { label: string; value: number }[]; unit: string; scale?: number }) {
  const maximum = Math.max(1, scale ?? 0, ...rows.map(row => row.value));
  return <figure className="analytics-figure"><figcaption>{title}</figcaption><div className="analytics-bars">{rows.map(row => <div className="analytics-bar-row" key={row.label}><span>{row.label}</span><div className="analytics-track" aria-hidden="true"><span style={{ width: `${row.value / maximum * 100}%` }}/></div><strong>{row.value.toLocaleString()} <small>{unit}</small></strong></div>)}</div>{!rows.length && <p>No reported values in this response.</p>}</figure>;
}

export function CashFlowBars({ title, rows }: { title: string; rows: (WalletActivityBucket & { label: string })[] }) {
  const maximum = decimalMaximum(rows.flatMap(row => row.totals ? [row.totals.incomingISK, row.totals.outgoingISK] : []));
  return <figure className="analytics-figure"><figcaption>{title}</figcaption><p className="overview-hint"><span className="analytics-key incoming"/> Incoming <span className="analytics-key outgoing"/> Outgoing · ISK · shared scale</p>
    <div className="cashflow-bars" tabIndex={0} role="region" aria-label={title + ' chart'}>{rows.map(row => <div key={row.label} className="cashflow-row"><strong>{row.label}</strong>{row.totals ? <><div className="analytics-track incoming" aria-hidden="true"><span style={{ width: `${decimalWidth(row.totals.incomingISK, maximum)}%` }}/></div><span>In {formatISK(row.totals.incomingISK)}</span><div className="analytics-track outgoing" aria-hidden="true"><span style={{ width: `${decimalWidth(row.totals.outgoingISK, maximum)}%` }}/></div><span>Out {formatISK(row.totals.outgoingISK)}</span></> : <span>Amount not reported</span>}{row.missingAmountEntries > 0 && <small>{row.missingAmountEntries} rows without amounts</small>}</div>)}</div>
    {!rows.length && <p>No journal activity returned for this page.</p>}
    <details><summary>Exact values and net cash flow</summary><div className="workspace-table-scroll" tabIndex={0} role="region" aria-label={title + ' exact values'}><table className="workspace-table"><caption>{title} — returned page only</caption><thead><tr><th scope="col">Period / category</th><th scope="col">Incoming ISK</th><th scope="col">Outgoing ISK</th><th scope="col">Net ISK</th><th scope="col">Rows / missing amounts</th></tr></thead><tbody>{rows.map(row => <tr key={row.label}><th scope="row">{row.label}</th><td>{row.totals ? formatISK(row.totals.incomingISK) : 'Unknown'}</td><td>{row.totals ? formatISK(row.totals.outgoingISK) : 'Unknown'}</td><td>{row.totals ? formatISK(row.totals.netISK) : 'Unknown'}</td><td>{row.entries} / {row.missingAmountEntries}</td></tr>)}</tbody></table></div></details>
  </figure>;
}

export function QueueTimeline({ entries }: { entries: CharacterQueueEntry[] }) {
  const titleId = useId();
  const shown = entries.slice(0, 20), timed = shown.filter(row => row.startAt && row.finishAt && Date.parse(row.finishAt) > Date.parse(row.startAt));
  const start = Math.min(...timed.map(row => Date.parse(row.startAt!))), end = Math.max(...timed.map(row => Date.parse(row.finishAt!)));
  const utc = (date: number) => new Date(date).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  return <figure className="analytics-figure"><figcaption id={titleId}>Reported queue timeline</figcaption><p className="overview-hint">First {shown.length} queue entries. Bars use reported start and finish times; they do not confirm that training is active. Entries without a full interval remain in the queue table.</p>{timed.length ? <><div className="timeline-scale"><span>{utc(start)}</span><span>{utc(end)}</span></div><svg viewBox={`0 0 760 ${timed.length * 38}`} role="img" aria-labelledby={titleId} className="queue-timeline"><desc>Relative planned training intervals. Exact dates and all entries are available in the queue table below.</desc>{timed.map((row, index) => <g key={row.position}><title>{`${row.name} level ${row.finishedLevel}: ${row.startAt} to ${row.finishAt}`}</title><text x="0" y={index * 38 + 22} fill="#badceb" fontSize="12">#{row.position + 1} · Level {row.finishedLevel}</text><rect x={110 + (Date.parse(row.startAt!) - start) / (end - start) * 640} y={index * 38 + 7} width={Math.max(1, (Date.parse(row.finishAt!) - Date.parse(row.startAt!)) / (end - start) * 640)} height="22" rx="3" fill="#81cbe8"/></g>)}</svg></> : <p>No complete start/finish intervals among these entries.</p>}</figure>;
}
