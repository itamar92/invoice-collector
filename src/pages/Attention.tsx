import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import type { Item, Vendor, VendorStatus } from '../api.js';
import {
  Avatar, Button, ButtonLink, Card, Dot, Icon, ErrorText, fmtDate, fmtDateTime, fmtMoney, itemTitle, Loading, Notice, PageTitle,
  reasonLabel, rowCls, useAction, useApp, useLoad,
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
    const byVendor = new Map<string, Item[]>();
    for (const i of waiting.items) if (i.vendorKey) byVendor.set(i.vendorKey, [...(byVendor.get(i.vendorKey) ?? []), i]);
    return vendors.filter((v) => v.status === 'unreviewed' && byVendor.has(v.key)).map((v) => ({ v, items: byVendor.get(v.key)! }));
  });
  const [open, setOpen] = useState<string | null>(null);
  const act = useAction();
  const decide = (v: Vendor, status: VendorStatus) => act.run(async () => {
    await api.setVendor(v.key, { status });
    await load.reload(); await refreshSummary(); onDecided?.();
  }, `${v.key}:${status}`);

  if (!load.data?.length) return load.error ? <ErrorText>{load.error}</ErrorText> : null;
  return (
    <Card title={t('attention.newVendors')}>
      <p className="text-[13px] text-muted">{t('attention.newVendorsHint')}</p>
      <ul>
        {load.data.map(({ v, items }) => (
          <li key={v.key} className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 py-3 ${rowCls}`}>
            {/* The vendor opens its waiting documents, so the decision can be made after a look at them. */}
            <button type="button" aria-expanded={open === v.key} aria-controls={`vendor-docs-${v.key}`}
              onClick={() => setOpen(open === v.key ? null : v.key)}
              className="-mx-2 flex min-w-0 items-center gap-3 rounded-xl px-2 py-1 text-start transition-colors hover:bg-ground">
              <Avatar name={v.displayName} />
              <span className="min-w-0">
                <span className="block font-semibold">{v.displayName}</span>
                <span className="flex items-center gap-1 text-[13px] text-accent-deep underline decoration-dotted underline-offset-2">
                  {t('attention.waitingItems', { n: items.length })}
                  <Icon name={open === v.key ? 'up' : 'down'} className="size-3.5" />
                </span>
              </span>
            </button>
            {/* The discarding choice stands apart from the two that keep the documents. */}
            <div className="flex w-full gap-2 sm:w-auto">
              {DECISIONS.map((s) => (
                <Button key={s} variant={s === 'business' ? 'primary' : s === 'ignored' ? 'danger' : 'secondary'}
                  className={s === 'ignored' ? 'ms-auto sm:ms-3' : 'min-w-20 flex-1 sm:flex-none'}
                  loading={act.is(`${v.key}:${s}`)} disabled={act.busy} title={t(`vendorStatus.${s}Hint`)} onClick={() => decide(v, s)}>
                  {t(`vendorStatus.${s}`)}
                </Button>
              ))}
            </div>
            {open === v.key && (
              <div id={`vendor-docs-${v.key}`} className="w-full rounded-xl border border-line px-3 py-1">
                <ItemList items={items} />
              </div>
            )}
          </li>
        ))}
      </ul>
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

export function ItemList({ items }: { items: Item[] }) {
  return (
    <ul>
      {items.map((i) => (
        <li key={i.id} className={rowCls}>
          <Link to={`/items/${i.id}`} className="-mx-2 grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-xl px-2 py-2 transition-colors hover:bg-ground">
            <Avatar name={itemTitle(i)} />
            <span className="min-w-0">
              <span className="block truncate font-medium">{itemTitle(i)}</span>
              <span className="num block text-[13px] text-muted">{fmtDate(i.fields?.issueDate ?? i.createdAt)}</span>
            </span>
            <span className="num font-semibold">{fmtMoney(i.fields?.total, i.fields?.currency)}</span>
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
      {data.loading && !d && <Loading rows={4} />}
      <ErrorText>{data.error}</ErrorText>
      {empty && (
        <div className="panel flex flex-col items-center gap-3 py-10 text-center">
          <span className="grid size-14 place-items-center rounded-full bg-ok-tint text-accent-deep"><Icon name="check" className="size-7" /></span>
          <p className="display text-lg">{t('attention.allClear')}</p>
        </div>
      )}

      {d && d.byReason.length > 0 && (
        <Card title={t('attention.needs')}>
          <div className="space-y-3">
            {d.byReason.map(([reason, items]) => (
              <div key={reason}>
                <h3 className="flex items-center gap-2 rounded-lg bg-alert-tint px-2.5 py-1.5 text-[13px] font-semibold text-alert-deep">
                  <Dot className="bg-alert" /><span className="flex-1">{reasonLabel(reason)}</span><span className="num">{items.length}</span>
                </h3>
                <ItemList items={items} />
              </div>
            ))}
          </div>
        </Card>
      )}

      {d && d.lateBackfill.length > 0 && (
        <Card title={t('attention.backfillLate')} actions={<ButtonLink to="/backfill" variant="secondary">{t('nav.backfill')}</ButtonLink>}>
          <p className="text-[13px] text-muted">{t('attention.backfillLateHint')}</p>
          <ItemList items={d.lateBackfill} />
        </Card>
      )}

      {d && d.failures.length > 0 && (
        <Card title={t('attention.ingest')}>
          <p className="text-[13px] text-muted">{t('attention.ingestHint')}</p>
          <ul className="text-sm">
            {d.failures.map((f) => (
              <li key={f.messageId} className={`py-2 ${rowCls}`}>
                <div className="[overflow-wrap:anywhere]">{f.error}</div>
                <div className="text-xs text-muted">{t('common.attempts')}: {f.attempts} · {fmtDateTime(f.lastAt)}</div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {d && d.waitingAi.length > 0 && (
        <Card title={t('attention.waitingAi')}>
          <p className="text-[13px] text-muted">{t('attention.waitingAiHint')}</p>
          <ItemList items={d.waitingAi} />
        </Card>
      )}

      {d && d.worth.length > 0 && (
        <Card title={t('attention.worth')}>
          <p className="text-[13px] text-muted">{t('attention.worthHint')}</p>
          <ItemList items={d.worth} />
        </Card>
      )}

      {!!summary?.missedOpen && (
        <p className="flex flex-wrap items-center gap-x-2 rounded-xl bg-info-tint px-3 py-2 text-sm">
          {t('attention.missedLink', { n: summary.missedOpen })}
          <Link to="/missed" className="font-semibold text-accent-deep underline">{t('nav.missed')}</Link>
        </p>
      )}
    </div>
  );
}
