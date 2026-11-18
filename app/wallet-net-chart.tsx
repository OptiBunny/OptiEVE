'use client';
import { useId } from 'react';
import { decimalMaximum, decimalWidth, formatISK } from './lib/analytics-client';
import type { WalletAnalytics } from './lib/wallet-analytics-types';

const magnitude = (value: string) => value.startsWith('-') ? value.slice(1) : value;
const isZero = (value: string) => /^0(?:\.0+)?$/.test(magnitude(value));
const signedLabel = (value: string) => isZero(value) ? formatISK(magnitude(value)) : (value.startsWith('-') ? '' : '+') + formatISK(value);

export default function WalletNetChart({ daily }: { daily: WalletAnalytics['daily'] }) {
  const id = useId(), shown = daily.slice(-30), hasKnownAmounts = shown.some(row => row.totals !== null);
  const maximum = decimalMaximum(shown.flatMap(row => row.totals ? [magnitude(row.totals.netISK)] : []));
  const center = 430, halfWidth = 230, height = 62 + shown.length * 28;
  return <figure className="analytics-figure"><figcaption id={id}>Observed daily net cash flow (UTC)</figcaption>
    <p className="overview-hint">Showing {shown.length} of {daily.length} returned UTC dates: the latest returned dates, not a complete 30-day period. Each row is a returned date; gaps are omitted. Full-page totals and the incoming/outgoing tables cover all returned dates. Net cash flow includes transfers and is not profit, wallet balance or a cumulative balance.</p>
    <p className="overview-hint">Negative net extends left; positive net extends right on one shared absolute scale for the displayed dates. A circle marks reported zero net, which does not mean no transactions. Unknown amounts have no bar. Partial means some entries lack amounts. Small nonzero values use a minimum-width marker; bar geometry is approximate and exact values follow below.</p>
    {!shown.length ? <p className="overview-state">No returned daily observations to chart.</p> : <>
      {hasKnownAmounts ? <p className="overview-hint" style={{ overflowWrap: 'anywhere' }}>Shared scale magnitude: {formatISK(maximum)} ISK.</p> : <p className="overview-hint">All displayed dates lack reported amounts; no net scale is available.</p>}
      <div className="operations-chart-scroll" tabIndex={0} role="region" aria-label="Daily net cash-flow chart" style={{ maxHeight: 640, overflowY: 'auto' }}>
        <svg viewBox={'0 0 800 ' + height} role="img" aria-labelledby={id} style={{ display: 'block', width: '100%', minWidth: 800, height: 'auto' }}><desc>Horizontal bars compare each displayed date&apos;s observed net ISK. Negative values extend left of zero and positive values extend right. Unknown values have no amount mark; zero has a circle. Exact amounts and missing-entry counts are in the table.</desc>
          <text x="200" y="20" fill="#e8b576" fontSize="12">Negative net</text><text x={center} y="20" textAnchor="middle" fill="#d6e4ef" fontSize="12">0</text><text x="660" y="20" textAnchor="end" fill="#81cbe8" fontSize="12">Positive net</text>
          <line x1={center} x2={center} y1="32" y2={height - 12} stroke="#6b8295"/>
          {shown.map((row, index) => {
            const y = 48 + index * 28, net = row.totals?.netISK ?? null, zero = net !== null && isZero(net), negative = net !== null && !zero && net.startsWith('-');
            const width = net === null || zero ? 0 : Math.max(1, decimalWidth(magnitude(net), maximum) / 100 * halfWidth);
            return <g key={row.date}><title>{row.date + ': ' + (net === null ? 'Unknown net ISK' : signedLabel(net) + ' net ISK') + '; ' + row.entries + ' entries; ' + row.missingAmountEntries + ' missing amounts'}</title><text x="8" y={y + 4} fill="#badceb" fontSize="11">{row.date}</text>
              {net === null ? <text x={center} y={y + 4} textAnchor="middle" fill="#badceb" fontSize="11">Unknown</text> : zero ? <circle cx={center} cy={y} r="3" fill="#0b1723" stroke="#d6e4ef" strokeWidth="2"/> : <rect x={negative ? center - width : center} y={y - 7} width={width} height="14" fill={negative ? '#e8b576' : '#81cbe8'}/>}
              {row.missingAmountEntries > 0 && <text x="690" y={y + 4} fill="#e8c593" fontSize="11">{net === null ? 'No amounts' : 'Partial'}</text>}
            </g>;
          })}
        </svg>
      </div>
      <details><summary>Exact net values for the displayed dates</summary><div className="workspace-table-scroll" tabIndex={0} role="region" aria-label="Daily net cash-flow exact values"><table className="workspace-table"><caption>Latest {shown.length} of {daily.length} returned UTC dates · observed amounts only</caption><thead><tr><th scope="col">Date (UTC)</th><th scope="col">Observed net ISK</th><th scope="col">Amount evidence</th><th scope="col">Entries / missing amounts</th></tr></thead><tbody>{shown.map(row => <tr key={row.date}><th scope="row">{row.date}</th><td>{row.totals ? signedLabel(row.totals.netISK) : 'Unknown'}</td><td>{row.totals === null ? 'No reported amounts' : row.missingAmountEntries ? 'Partial reported amounts' : 'All returned entries have amounts'}</td><td>{row.entries} / {row.missingAmountEntries}</td></tr>)}</tbody></table></div></details>
    </>}
  </figure>;
}
