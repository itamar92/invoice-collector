import { Link } from 'react-router-dom';
import { api } from '../api.js';
import type { Item, Vendor, VendorStatus } from '../api.js';
import {
  Button, ButtonLink, Card, ErrorText, fmtDate, fmtDateTime, fmtMoney, itemTitle, Loading, Notice, PageTitle,
  reasonLabel, useAction, useApp, useLoad,
} from '../components/ui.js';
import { t } from '../i18n/he.js';

const DECISIONS = ['business', 'personal', 'ignored'] as const satisfies readonly VendorStatus[];

/**
 * New vendors with items waiting on a decision: business / personal / ignore, one click each.
 * Used by Attention and inline on the Backfill page.
 */
export function VendorDecisions({ onDecided }: { onDecided?: () => void }) {
  const { refreshSummary } = useApp();
  const load = useLoad(async () => {
    const [vendors, waiting] = await Promise.all([api.vendors(), api.items({ state: 'awaiting_vendor', limit: 200 })]);
    const counts = new Map<string, number>();
    for (const i of waiting.items) if (i.vendorKey) counts.set(i.vendorKey, (counts.get(i.vendorKey) ?? 0) + 1);
    return vendors.filter((v) => v.status === 'unreviewed' && counts.has(v.key)).map((v) => ({ v, n: counts.get(v.key)! }));
  });
  const act = useAction();
  const decide = (v: Vendor, status: VendorStatus) => act.run(async () => {
    await api.setVendor(v.key, { status });
    await load.reload(); await refreshSummary(); onDecided?.();
  });

  if (!load.data?.length) return load.error ? <ErrorText>{load.error}</ErrorText> : null;
  return (
    <Card title={t('attention.newVendors')}>
      <p className="mb-3 text-sm text-slate-600">{t('attention.newVendorsHint')}</p>
      <ul className="divide-y divide-slate-100">
        {load.data.map(({ v, n }) => (
          <li key={v.key} className="flex flex-wrap items-center justify-between gap-2 py-3">
            <div>
              <div className="font-medium">{v.displayName}</div>
              <div className="text-xs text-slate-500">{t('attention.waitingItems', { n })}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              {DECISIONS.map((s) => (
                <Button key={s} variant={s === 'business' ? 'primary' : s === 'ignored' ? 'danger' : 'secondary'}
                  disabled={act.busy} title={t(`vendorStatus.${s}Hint`)} onClick={() => decide(v, s)}>
                  {t(`vendorStatus.${s}`)}
                </Button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

export function ItemList({ items }: { items: Item[] }) {
  return (
    <ul className="divide-y divide-slate-100">
      {items.map((i) => (
        <li key={i.id}>
          <Link to={`/items/${i.id}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 hover:bg-slate-50">
            <span className="font-medium text-teal-900">{itemTitle(i)}</span>
            <span className="flex gap-4 text-sm text-slate-600">
              <span>{fmtDate(i.fields?.issueDate ?? i.createdAt)}</span>
              <span>{fmtMoney(i.fields?.total, i.fields?.currency)}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function Attention() {
  const { summary } = useApp();
  const data = useLoad(async () => {
    const [needs, waitingAi, worth, failures, lateBackfill] = await Promise.all([
      api.items({ state: 'needs_attention', limit: 200 }), api.items({ state: 'waiting_ai', limit: 200 }),
      api.items({ worth: true, limit: 200 }), api.ingestFailures(),
      // Only counted once the first run was finished; before that they are the backfill list itself.
      summary?.awaitingBackfillApproval ? api.items({ state: 'awaiting_backfill_approval', limit: 200 }) : Promise.resolve({ items: [] as Item[] }),
    ]);
    const byReason = new Map<string, Item[]>();
    for (const i of needs.items) {
      const k = i.reason ?? 'internal_error';
      byReason.set(k, [...(byReason.get(k) ?? []), i]);
    }
    return { byReason: [...byReason.entries()], waitingAi: waitingAi.items, worth: worth.items, failures, lateBackfill: lateBackfill.items };
  }, [summary?.attention, summary?.waitingAi, summary?.worthALook, summary?.awaitingBackfillApproval]);

  const d = data.data;
  const empty = d && !d.byReason.length && !d.waitingAi.length && !d.worth.length && !d.failures.length && !d.lateBackfill.length
    && !summary?.awaitingVendor;

  return (
    <div className="space-y-4">
      <PageTitle>{t('attention.title')}</PageTitle>
      <VendorDecisions />
      {data.loading && !d && <Loading />}
      <ErrorText>{data.error}</ErrorText>
      {empty && <Notice tone="ok">{t('attention.allClear')}</Notice>}

      {d && d.byReason.length > 0 && (
        <Card title={t('attention.needs')}>
          <div className="space-y-4">
            {d.byReason.map(([reason, items]) => (
              <div key={reason}>
                <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-red-800">
                  {reasonLabel(reason)} <span className="rounded-full bg-red-100 px-2 text-xs">{items.length}</span>
                </h3>
                <ItemList items={items} />
              </div>
            ))}
          </div>
        </Card>
      )}

      {d && d.lateBackfill.length > 0 && (
        <Card title={t('attention.backfillLate')} actions={<ButtonLink to="/backfill" variant="secondary">{t('nav.backfill')}</ButtonLink>}>
          <p className="mb-2 text-sm text-slate-600">{t('attention.backfillLateHint')}</p>
          <ItemList items={d.lateBackfill} />
        </Card>
      )}

      {d && d.failures.length > 0 && (
        <Card title={t('attention.ingest')}>
          <p className="mb-2 text-sm text-slate-600">{t('attention.ingestHint')}</p>
          <ul className="divide-y divide-slate-100 text-sm">
            {d.failures.map((f) => (
              <li key={f.messageId} className="py-2">
                <div className="text-slate-800">{f.error}</div>
                <div className="text-xs text-slate-500">{t('common.attempts')}: {f.attempts} · {fmtDateTime(f.lastAt)}</div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {d && d.waitingAi.length > 0 && (
        <Card title={t('attention.waitingAi')}>
          <p className="mb-2 text-sm text-slate-600">{t('attention.waitingAiHint')}</p>
          <ItemList items={d.waitingAi} />
        </Card>
      )}

      {d && d.worth.length > 0 && (
        <Card title={t('attention.worth')}>
          <p className="mb-2 text-sm text-slate-600">{t('attention.worthHint')}</p>
          <ItemList items={d.worth} />
        </Card>
      )}

      {!!summary?.missedOpen && (
        <Notice>
          {t('attention.missedLink', { n: summary.missedOpen })} <ButtonLink to="/missed" variant="ghost">{t('nav.missed')}</ButtonLink>
        </Notice>
      )}
    </div>
  );
}
