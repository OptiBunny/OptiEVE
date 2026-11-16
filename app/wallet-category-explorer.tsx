'use client';
import { useId, useState } from 'react';
import { CashFlowBars } from './analytics-charts';
import { formatISK } from './lib/analytics-client';
import type { WalletAnalytics, WalletActivityCategoryId } from './lib/wallet-analytics-types';

type CategorySelection = WalletActivityCategoryId | 'all';
const TABLE_SIZE = 100;
const CHART_DATES = 30;

/** All inputs are accepted response projections. Intersections never come from marginal totals. */
export function walletCategoryView(data: WalletAnalytics, category: CategorySelection, date: string) {
  const cells = data.categoryDaily.filter(row => (category === 'all' || row.categoryId === category) && (date === 'all' || row.date === date));
  const labels = new Map(data.categories.map(row => [row.id, row.label]));
  const daily = category === 'all'
    ? data.daily.filter(row => date === 'all' || row.date === date)
    : cells.map(row => ({ date: row.date, entries: row.entries, amountEntries: row.amountEntries, missingAmountEntries: row.missingAmountEntries, totals: row.totals }));
  const categories = date === 'all'
    ? data.categories.filter(row => category === 'all' || row.id === category).map(row => ({ ...row, label: row.label }))
    : cells.map(row => ({ ...row, label: labels.get(row.categoryId) ?? row.categoryId }));
  return { cells, daily, categories, labels };
}

/** The parent keys this child to its loaded result; local filters never fetch or persist data. */
export default function WalletCategoryExplorer({ data }: { data: WalletAnalytics }) {
  const prefix = useId(), [category, setCategory] = useState<CategorySelection>('all'), [date, setDate] = useState('all'), [page, setPage] = useState(0);
  if (!['ready', 'partial'].includes(data.status) || data.coverage.kind === 'unavailable') return <section><h3>Category and day explorer</h3><p>Category/day observations are unavailable. No counts or cash-flow values are inferred.</p></section>;
  const view = walletCategoryView(data, category, date), chartDaily = view.daily.slice(-CHART_DATES), omittedDates = view.daily.length - chartDaily.length;
  const lastPage = Math.max(0, Math.ceil(view.cells.length / TABLE_SIZE) - 1), currentPage = Math.min(page, lastPage), shown = view.cells.slice(currentPage * TABLE_SIZE, (currentPage + 1) * TABLE_SIZE);
  const categoryLabel = category === 'all' ? 'all categories' : view.labels.get(category) ?? category;
  const scope = `${date === 'all' ? 'all returned UTC days' : date} · ${categoryLabel}`;
  function chooseCategory(value: CategorySelection) { setCategory(value); setPage(0); }
  function chooseDate(value: string) { setDate(value); setPage(0); }
  function reset() { setCategory('all'); setDate('all'); setPage(0); }
  return <section aria-labelledby={prefix + '-heading'}>
    <h3 id={prefix + '-heading'}>Category and day explorer</h3>
    <p className="overview-hint">Explore actual category/day intersections in this selected journal page. Filters change only this explorer; the returned-page totals and net chart above keep their full-page scope. Missing intersections are absent observations, not zero activity.</p>
    <div className="overview-controls">
      <div><label htmlFor={prefix + '-category'}>Activity category</label><select id={prefix + '-category'} data-wallet-filter="category" value={category} onChange={event => chooseCategory(event.target.value as CategorySelection)}><option value="all">All returned categories</option>{data.categories.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}</select></div>
      <div><label htmlFor={prefix + '-date'}>UTC day</label><select id={prefix + '-date'} data-wallet-filter="date" value={date} onChange={event => chooseDate(event.target.value)}><option value="all">All returned days</option>{data.daily.map(row => <option key={row.date} value={row.date}>{row.date}</option>)}</select></div>
      <button className="small" disabled={category === 'all' && date === 'all' && currentPage === 0} onClick={reset}>Reset explorer</button>
    </div>
    <p role="status">Selected observations: {scope}. {view.cells.length} of {data.categoryDaily.length} observed category/day intersections.</p>
    {data.categoryDaily.length === 0 ? <p>This successfully read page contains no journal entries. It does not establish zero activity outside the returned page.</p> : <>
      <div className="overview-cards">
        <article className="overview-card"><h4>Selected daily cash flow</h4><p className="overview-hint">Latest {chartDaily.length} of {view.daily.length} matching returned dates; {omittedDates} earlier dates omitted from this chart. Select any returned day or use the table pages below to inspect earlier observations. Calendar gaps are not filled.</p><CashFlowBars title="Selected daily incoming and outgoing (UTC)" rows={chartDaily.map(row => ({ ...row, label: row.date }))} coverageLabel={scope + ' · selected provider page only'} emptyLabel="No observed intersections match these filters; no zero activity is inferred."/></article>
        <article className="overview-card"><h4>Selected category cash flow</h4><CashFlowBars title="Selected incoming and outgoing by category" rows={view.categories} coverageLabel={scope + ' · selected provider page only'} emptyLabel="No observed intersections match these filters; no zero activity is inferred."/></article>
      </div>
      <p className="overview-hint">Amounts describe reported cash movement, including transfers, rather than profit or a wallet balance. A cell with no reported amounts remains unknown; a partial cell shows its reported amounts and its missing count.</p>
      <div className="workspace-table-scroll" tabIndex={0} role="region" aria-label="Observed category and UTC day exact values"><table className="workspace-table">
        <caption>Observed category/day intersections · {scope} · rows {shown.length ? currentPage * TABLE_SIZE + 1 : 0}–{Math.min((currentPage + 1) * TABLE_SIZE, view.cells.length)} of {view.cells.length}</caption>
        <thead><tr><th scope="col">UTC day</th><th scope="col">Category</th><th scope="col">Incoming ISK</th><th scope="col">Outgoing ISK</th><th scope="col">Net cash flow ISK</th><th scope="col">Journal rows / missing amounts</th></tr></thead>
        <tbody>{shown.map(row => <tr key={row.date + ':' + row.categoryId}><th scope="row"><button className="small" onClick={() => chooseDate(row.date)} aria-label={'Filter to UTC day ' + row.date}>{row.date}</button></th><td><button className="small" onClick={() => chooseCategory(row.categoryId)} aria-label={'Filter to category ' + (view.labels.get(row.categoryId) ?? row.categoryId)}>{view.labels.get(row.categoryId) ?? row.categoryId}</button></td><td>{row.totals ? formatISK(row.totals.incomingISK) : 'Unknown'}</td><td>{row.totals ? formatISK(row.totals.outgoingISK) : 'Unknown'}</td><td>{row.totals ? formatISK(row.totals.netISK) : 'Unknown'}</td><td>{row.entries} / {row.missingAmountEntries}{row.missingAmountEntries > 0 && <small> · {row.amountEntries ? 'Partial reported amounts' : 'No reported amounts'}</small>}</td></tr>)}</tbody>
      </table></div>
      {!view.cells.length && <p>No observed intersections match these filters. This is not evidence of zero activity.</p>}
      <div className="analytics-pagination"><button className="small" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous observation rows</button><span>Table page {currentPage + 1} of {lastPage + 1}</span><button className="small" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Next observation rows</button></div>
    </>}
  </section>;
}
