import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import type { ItemState } from '../api.js';
import {
  Button, Card, Empty, ErrorText, fmtDate, fmtMoney, inputCls, itemTitle, Loading, PageTitle, reasonLabel, StateBadge,
  stateLabel, TableWrap, td, th, useLoad,
} from '../components/ui.js';
import { t } from '../i18n/he.js';

const STATES: ItemState[] = [
  'needs_attention', 'awaiting_vendor', 'waiting_ai', 'queued', 'awaiting_backfill_approval', 'ready', 'stored', 'done',
  'ignored', 'dismissed',
];
const PAGE = 50;

export default function Invoices() {
  const [params, setParams] = useSearchParams();
  const state = (params.get('state') as ItemState | null) || undefined;
  const q = params.get('q') ?? '';
  const page = Math.max(0, Number(params.get('page') ?? 0) || 0);
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);

  const list = useLoad(() => api.items({ state, q: q || undefined, limit: PAGE, offset: page * PAGE }), [state, q, page]);
  const set = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); }
    if (!('page' in patch)) n.delete('page');
    setParams(n);
  };
  const items = list.data?.items ?? [];

  return (
    <div className="space-y-4">
      <PageTitle>{t('invoices.title')}</PageTitle>
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); set({ q: text.trim() || null }); }}>
        <select className={`${inputCls} sm:w-56`} value={state ?? ''} onChange={(e) => set({ state: e.target.value || null })} aria-label={t('common.state')}>
          <option value="">{t('common.all')}</option>
          {STATES.map((s) => <option key={s} value={s}>{stateLabel(s)}</option>)}
        </select>
        <input type="search" className={inputCls} placeholder={t('invoices.searchPlaceholder')} value={text} onChange={(e) => setText(e.target.value)} />
        <Button type="submit" variant="secondary">{t('common.search')}</Button>
      </form>

      <Card>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorText>{list.error}</ErrorText> : items.length === 0 ? <Empty /> : (
          <TableWrap>
            <thead><tr>
              <th className={th}>{t('common.vendor')}</th><th className={th}>{t('common.date')}</th>
              <th className={th}>{t('common.total')}</th><th className={th}>{t('common.state')}</th>
              <th className={th}>{t('common.reason')}</th>
            </tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className="hover:bg-slate-50">
                  <td className={td}><Link className="font-medium text-teal-800 hover:underline" to={`/items/${i.id}`}>{itemTitle(i)}</Link></td>
                  <td className={`${td} whitespace-nowrap`}>{fmtDate(i.fields?.issueDate ?? i.createdAt)}</td>
                  <td className={`${td} whitespace-nowrap`}>{fmtMoney(i.fields?.total, i.fields?.currency)}</td>
                  <td className={td}><StateBadge state={i.state} /></td>
                  <td className={`${td} text-xs text-slate-600`}>{i.state === 'needs_attention' ? reasonLabel(i.reason) : ''}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
        <div className="mt-3 flex items-center justify-between text-sm">
          <Button variant="secondary" disabled={page === 0} onClick={() => set({ page: String(page - 1) })}>{t('common.prev')}</Button>
          <span className="text-slate-500">{t('common.page', { n: page + 1 })}</span>
          <Button variant="secondary" disabled={items.length < PAGE} onClick={() => set({ page: String(page + 1) })}>{t('common.more')}</Button>
        </div>
      </Card>
    </div>
  );
}
