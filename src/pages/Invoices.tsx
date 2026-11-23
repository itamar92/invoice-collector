import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import type { ItemSort, ItemState } from '../api.js';
import {
  Avatar, Button, Empty, ErrorText, Icon, fmtDate, fmtMoney, inputCls, itemTitle, Loading, PageTitle, reasonLabel, rowCls, StateBadge,
  stateLabel, useLoad,
} from '../components/ui.js';
import { t } from '../i18n/he.js';

const STATES: ItemState[] = [
  'needs_attention', 'awaiting_vendor', 'waiting_ai', 'queued', 'awaiting_backfill_approval', 'ready', 'stored', 'done',
  'ignored', 'dismissed',
];
const PAGE = 50;
const SORTS: ItemSort[] = ['vendor', 'category', 'state', 'date', 'total'];
/** First click on a column: names A→Z, dates and amounts largest/newest first. */
const FIRST_DIR: Record<ItemSort, 'asc' | 'desc'> = { vendor: 'asc', category: 'asc', state: 'asc', date: 'desc', total: 'desc' };

export default function Invoices() {
  const [params, setParams] = useSearchParams();
  const state = (params.get('state') as ItemState | null) || undefined;
  const q = params.get('q') ?? '';
  const page = Math.max(0, Number(params.get('page') ?? 0) || 0);
  const sortParam = params.get('sort') as ItemSort | null;
  const sort = sortParam && SORTS.includes(sortParam) ? sortParam : undefined;
  const dir = params.get('dir') === 'asc' ? 'asc' : params.get('dir') === 'desc' ? 'desc' : sort ? FIRST_DIR[sort] : undefined;
  const category = params.get('category') || undefined;
  const year = Number(params.get('year')) || undefined;
  const filed = params.get('filed') === '1';
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);

  const list = useLoad(
    () => api.items({ state, q: q || undefined, category, year, filed, sort, dir, limit: PAGE, offset: page * PAGE }),
    [state, q, category, year, filed, sort, dir, page],
  );
  const set = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); }
    if (!('page' in patch)) n.delete('page');
    setParams(n);
  };
  const items = list.data?.items ?? [];
  const sortBy = (col: ItemSort) => set({ sort: col, dir: sort === col ? (dir === 'asc' ? 'desc' : 'asc') : FIRST_DIR[col] });
  /** A column title that sorts the list by it; a second click flips the direction. */
  const Head = ({ col, className = '', children }: { col: ItemSort; className?: string; children: string }) => (
    <span className={className} aria-sort={sort === col ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button type="button" onClick={() => sortBy(col)} title={t('invoices.sortBy', { col: children })}
        className={`-mx-1 inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 hover:bg-ground hover:text-ink ${sort === col ? 'font-semibold text-ink' : ''}`}>
        {children}
        {sort === col && <Icon name={dir === 'asc' ? 'up' : 'down'} className="size-3.5" />}
      </button>
    </span>
  );
  const scope = [
    category && { key: 'category', label: category === '-' ? t('dash.noCategory') : category },
    year && { key: 'year', label: String(year) },
    filed && { key: 'filed', label: t('invoices.filedOnly') },
  ].filter((x): x is { key: string; label: string } => !!x);

  // Phone: two lines per invoice. Desktop: one line, four aligned columns.
  const cols = 'grid grid-cols-[2.25rem_minmax(0,1fr)_auto] gap-x-3 md:grid-cols-[2.25rem_minmax(0,5fr)_minmax(0,3fr)_minmax(0,5fr)_6rem_7rem]';

  return (
    <div className="space-y-4">
      <PageTitle>{t('invoices.title')}</PageTitle>
      <form className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[14rem_minmax(0,1fr)_auto]" onSubmit={(e) => { e.preventDefault(); set({ q: text.trim() || null }); }}>
        <select className={`${inputCls} col-span-2 sm:col-span-1`} value={state ?? ''} onChange={(e) => set({ state: e.target.value || null })} aria-label={t('common.state')}>
          <option value="">{t('common.all')}</option>
          {STATES.map((s) => <option key={s} value={s}>{stateLabel(s)}</option>)}
        </select>
        <input type="search" className={inputCls} placeholder={t('invoices.searchPlaceholder')} aria-label={t('common.search')} value={text} onChange={(e) => setText(e.target.value)} />
        <Button type="submit" variant="secondary">{t('common.search')}</Button>
      </form>

      {scope.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted">{t('invoices.scope')}</span>
          {scope.map((f) => (
            <button key={f.key} type="button" onClick={() => set({ [f.key]: null })} aria-label={t('invoices.removeFilter', { name: f.label })}
              className="inline-flex min-h-8 items-center gap-1 rounded-full border border-line-strong bg-white px-3 hover:bg-ground">
              {f.label}<span aria-hidden="true" className="text-muted">×</span>
            </button>
          ))}
        </div>
      )}

      <section className="panel">
        <div className={`${cols} border-b border-line pb-2 text-xs font-medium text-muted`}>
          <Head col="vendor" className="col-span-2">{t('common.vendor')}</Head>
          <Head col="category" className="hidden md:block">{t('field.category')}</Head>
          <Head col="state" className="hidden md:block">{t('common.state')}</Head>
          <Head col="date" className="hidden md:block">{t('common.date')}</Head>
          <Head col="total" className="text-end">{t('common.total')}</Head>
        </div>
        {list.loading && !list.data ? <Loading rows={6} /> : list.error ? <ErrorText>{list.error}</ErrorText> : items.length === 0 ? <Empty /> : (
          <ul>
            {items.map((i) => (
              <li key={i.id} className={rowCls}>
                <Link to={`/items/${i.id}`} className={`${cols} -mx-2 min-h-14 items-center rounded-xl px-2 py-2 transition-colors hover:bg-ground`}>
                  <span className="col-start-1 row-span-2 row-start-1 md:row-span-1"><Avatar name={itemTitle(i)} /></span>
                  <span className="col-start-2 row-start-1 truncate font-medium">{itemTitle(i)}</span>
                  <span className="hidden min-w-0 truncate text-sm md:col-start-3 md:row-start-1 md:block">{i.fields?.category ?? <span className="text-idle">—</span>}</span>
                  <span className="col-start-2 row-start-2 min-w-0 md:col-start-4 md:row-start-1">
                    <StateBadge state={i.state} />
                    {i.fields?.category && <span className="ms-2 inline-block rounded-md bg-ground-deep px-1.5 py-0.5 align-middle text-xs md:hidden">{i.fields.category}</span>}
                    {i.state === 'needs_attention' && i.reason && <span className="ms-2 text-xs text-muted">{reasonLabel(i.reason)}</span>}
                  </span>
                  <span className="num col-start-3 row-start-2 justify-self-end text-[13px] text-muted md:col-start-5 md:row-start-1 md:justify-self-start">{fmtDate(i.fields?.issueDate ?? i.createdAt)}</span>
                  <span className="num col-start-3 row-start-1 justify-self-end font-semibold md:col-start-6">{fmtMoney(i.fields?.total, i.fields?.currency)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex items-center justify-between text-sm">
          <Button variant="secondary" disabled={page === 0} onClick={() => set({ page: String(page - 1) })}>{t('common.prev')}</Button>
          <span className="text-muted">{t('common.page', { n: page + 1 })}</span>
          <Button variant="secondary" disabled={items.length < PAGE} onClick={() => set({ page: String(page + 1) })}>{t('common.more')}</Button>
        </div>
      </section>
    </div>
  );
}
