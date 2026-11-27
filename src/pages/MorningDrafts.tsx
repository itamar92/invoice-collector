import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api.js';
import type { ApproveResult, DraftRow, ExtractedFields, PendingDraft } from '../api.js';
import {
  Button, Empty, ErrorText, fmtDate, fmtMoney, Icon, Loading, Notice, PageTitle, useAction, useLoad,
} from '../components/ui.js';
import { t, tDyn } from '../i18n/he.js';
import type { MessageKey } from '../i18n/he.js';

/** Morning's expense documentType codes (official v2 spec) as our document types. */
const MORNING_DOC: Record<number, string> = { 305: 'tax_invoice', 320: 'tax_invoice_receipt', 330: 'credit_note', 400: 'receipt', 20: 'other' };
const docLabel = (code: string | null | undefined) => (code ? tDyn(`docType.${code}`, 'common.none') : null);

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');
const norm = (s: string | null | undefined) => (s ?? '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const normNum = (s: string | null | undefined) => norm(s).replace(/^0+(?=\d)/, '');
const sameMoney = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) <= 0.01;

interface Line {
  key: MessageKey;
  morning: string | null;
  ours: string | null;
  /** Plain value for the copy button (no currency sign or formatting). */
  copy: string | null;
  differs: boolean;
}

function lines(d: PendingDraft, f: ExtractedFields | null, categoryLabel: string | null): Line[] {
  const cur = f?.currency ?? d.currency;
  const out: Line[] = [
    { key: 'drafts.row.supplier', morning: d.supplierName, ours: f?.vendorName ?? null, copy: f?.vendorName ?? null,
      differs: !!f && norm(d.supplierName) !== norm(f.vendorName) },
    { key: 'drafts.row.taxId', morning: d.supplierTaxId, ours: f?.vendorTaxId ?? null, copy: f?.vendorTaxId ? digits(f.vendorTaxId) : null,
      differs: !!f?.vendorTaxId && digits(d.supplierTaxId) !== digits(f.vendorTaxId) },
    { key: 'drafts.row.number', morning: d.number, ours: f?.docNumber ?? null, copy: f?.docNumber ?? null,
      differs: !!f && normNum(d.number) !== normNum(f.docNumber) },
    { key: 'drafts.row.date', morning: d.date ? fmtDate(d.date) : null, ours: f?.issueDate ? fmtDate(f.issueDate) : null,
      copy: f?.issueDate ? fmtDate(f.issueDate) : null, differs: !!f && d.date !== f.issueDate },
    { key: 'drafts.row.amount', morning: d.amount !== null ? fmtMoney(d.amount, d.currency ?? cur) : null,
      ours: f?.total != null ? fmtMoney(f.total, cur) : null, copy: f?.total != null ? String(f.total) : null,
      differs: !!f && !sameMoney(d.amount, f.total) },
    { key: 'drafts.row.vat', morning: d.vat !== null ? fmtMoney(d.vat, d.currency ?? cur) : null,
      ours: f?.vat != null ? fmtMoney(f.vat, cur) : null, copy: f?.vat != null ? String(f.vat) : null,
      differs: !!f && f.vat !== null && !sameMoney(d.vat, f.vat) },
    { key: 'drafts.row.docType', morning: docLabel(d.documentType !== null ? MORNING_DOC[d.documentType] : null), ours: docLabel(f?.docType),
      copy: null, differs: !!f?.docType && d.documentType !== null && MORNING_DOC[d.documentType] !== f.docType },
    { key: 'drafts.row.category', morning: d.classification, ours: categoryLabel, copy: null,
      differs: !!categoryLabel && !!d.classification && norm(categoryLabel) !== norm(d.classification) },
  ];
  return out;
}

/**
 * Expense drafts waiting for the owner's approval in Morning, each next to the document the app sent (when it did).
 * The owner approves with the app's details here, or copies values and approves in Morning.
 */
export default function MorningDrafts() {
  const list = useLoad(() => api.morningDrafts());
  const classes = useLoad(() => api.morningClassifications().catch(() => ({ classifications: [] })));
  const clsTitle = useMemo(() => new Map((classes.data?.classifications ?? []).map((c) => [c.id, c.title])), [classes.data]);
  const [done, setDone] = useState<Map<string, ApproveResult>>(new Map());
  const rows = list.data?.rows ?? [];
  // Approved cards stay in place with their outcome until the next refresh.
  const open = rows.filter((r) => !done.has(r.draft.id));
  const ours = open.filter((r) => r.item).length;

  return (
    <div className="space-y-4">
      <PageTitle actions={(
        <Button variant="secondary" loading={list.loading && !!list.data} onClick={() => void list.reload()}>
          <Icon name="refresh" />{t('drafts.refresh')}
        </Button>
      )}>{t('drafts.title')}</PageTitle>
      <p className="text-sm text-muted">{t('drafts.intro')}</p>

      {list.data && !list.data.configured && (
        <Notice tone="warn">
          {t('drafts.notConfigured')} <Link to="/settings" className="font-semibold underline">{t('drafts.toSettings')}</Link>
        </Notice>
      )}
      <ErrorText>{list.error}</ErrorText>
      {list.data?.configured && open.length > 0 && (
        <p className="text-sm font-medium">{t('drafts.count', { n: open.length, ours })}</p>
      )}

      {list.loading && !list.data ? <Loading rows={4} />
        : list.data?.configured && rows.length === 0 ? <section className="panel"><Empty>{t('drafts.empty')}</Empty></section>
        : (
          <ul className="space-y-3">
            {rows.map((r) => (
              <DraftCard key={r.draft.id} row={r} clsTitle={clsTitle} result={done.get(r.draft.id)}
                onDone={(res) => setDone((m) => new Map(m).set(r.draft.id, res))} />
            ))}
          </ul>
        )}
    </div>
  );
}

const MATCH_TONE = { ref: 'bg-ok-tint text-accent-deep', found: 'bg-ok-tint text-accent-deep', maybe: 'bg-warn-tint', none: 'bg-ground-deep' } as const;

function DraftCard({ row, clsTitle, result, onDone }: {
  row: DraftRow; clsTitle: Map<string, string>; result?: ApproveResult; onDone: (r: ApproveResult) => void;
}) {
  const { draft: d, item } = row;
  const f = item?.fields ?? null;
  const act = useAction();
  const [copied, setCopied] = useState<string | null>(null);
  const categoryLabel = f?.category
    ? (item?.classificationId && clsTitle.get(item.classificationId)) || f.category
    : null;
  const ls = lines(d, f, categoryLabel);
  const diffs = ls.filter((l) => l.differs).length;
  const unread = !d.number && d.amount === null && !d.supplierName;
  const matchKey = row.match ?? 'none';
  const title = f?.vendorName ?? d.supplierName ?? t('drafts.untitled');
  const amount = f?.total ?? d.amount;

  const copy = async (key: string, v: string) => {
    try { await navigator.clipboard.writeText(v); setCopied(key); setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500); } catch { /* clipboard blocked */ }
  };

  const approve = () => {
    if (!item || !f) return;
    const msg = t('drafts.approveConfirm', {
      supplier: f.vendorName ?? d.supplierName ?? '—', number: f.docNumber ?? d.number ?? '—',
      amount: fmtMoney(f.total ?? d.amount, f.currency ?? d.currency), date: fmtDate(f.issueDate ?? d.date), category: categoryLabel ?? '—',
    });
    if (!window.confirm(msg)) return;
    void act.run(async () => {
      try {
        onDone((await api.approveDraft(d.id, item.id)).result);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'morning_unavailable' && typeof e.body.message === 'string') {
          throw new Error(`${e.message} (${e.body.message})`);
        }
        throw e;
      }
    }, 'approve');
  };

  const reason = result?.draftReason ?? '';
  const known = `drafts.why.${reason.split(':')[0]}`;
  const why = reason ? tDyn(known, 'common.none', {}) !== t('common.none') ? tDyn(known, 'common.none') : reason : '';

  return (
    <li className="panel space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <div className="truncate text-base font-semibold">{title}</div>
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
            <span className={`rounded-md px-1.5 py-0.5 text-xs font-medium text-ink ${MATCH_TONE[matchKey]}`}>{t(`drafts.match.${matchKey}` as MessageKey)}</span>
            {f && !unread && (
              <span className={`rounded-md px-1.5 py-0.5 text-xs font-medium ${diffs ? 'bg-warn-tint text-warn-deep' : 'bg-ok-tint text-accent-deep'}`}>
                {diffs ? t('drafts.diffs', { n: diffs }) : t('drafts.same')}
              </span>
            )}
            {unread && <span className="rounded-md bg-ground-deep px-1.5 py-0.5 text-xs">{t('drafts.notRead')}</span>}
            {d.createdAt && <span className="num">{fmtDate(d.createdAt)}</span>}
          </div>
        </div>
        <span className="num shrink-0 text-lg font-semibold">{fmtMoney(amount, f?.currency ?? d.currency)}</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted">
              <th className="py-1 pe-2 text-start font-medium">{t('drafts.col.field')}</th>
              <th className="py-1 pe-2 text-start font-medium">{t('drafts.col.morning')}</th>
              {f && <th className="py-1 text-start font-medium">{t('drafts.col.ours')}</th>}
            </tr>
          </thead>
          <tbody>
            {ls.filter((l) => l.morning || l.ours).map((l) => (
              <tr key={l.key} className={`border-t border-line ${l.differs ? 'bg-warn-tint' : ''}`}>
                <td className="py-1.5 pe-2 text-muted">{t(l.key)}</td>
                <td className="py-1.5 pe-2 [overflow-wrap:anywhere]">{l.morning ?? <span className="text-muted">—</span>}</td>
                {f && (
                  <td className="py-1.5">
                    <span className="flex items-center gap-1.5">
                      <span className={`[overflow-wrap:anywhere] ${l.differs ? 'font-semibold' : ''}`}>{l.ours ?? <span className="text-muted">—</span>}</span>
                      {l.copy && (
                        <button type="button" onClick={() => void copy(l.key, l.copy!)} title={t('drafts.copy')} aria-label={`${t('drafts.copy')} ${t(l.key)}`}
                          className="inline-flex min-h-8 shrink-0 items-center rounded-lg px-1.5 text-xs text-accent-deep hover:bg-ground">
                          {copied === l.key ? t('drafts.copied') : t('drafts.copy')}
                        </button>
                      )}
                    </span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!item && <p className="text-xs text-muted">{t('drafts.noItem')}</p>}
      {item && !item.classificationId && (
        <Notice tone="warn">
          {t('drafts.noClassification', { category: f?.category ?? '—' })}{' '}
          <Link to="/settings" className="font-semibold underline">{t('drafts.toSettings')}</Link>
        </Notice>
      )}
      <ErrorText>{act.error}</ErrorText>
      {result && (
        <Notice tone={result.draftRemoved ? 'ok' : 'warn'}>
          {result.existed ? t('drafts.doneExisted') : t('drafts.done')}
          {!result.draftRemoved && <> {t('drafts.draftKept', { why: why || '—' })}</>}
        </Notice>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {item && !result && (
          <Button loading={act.is('approve')} disabled={act.busy || !item.classificationId} onClick={approve}>
            <Icon name="check" />{t('drafts.approve')}
          </Button>
        )}
        {d.fileUrl && (
          <a href={d.fileUrl} target="_blank" rel="noreferrer noopener"
            className="inline-flex min-h-10 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-accent-deep hover:bg-ground">
            <Icon name="out" />{t('drafts.openFile')}
          </a>
        )}
        {item && (
          <Link to={`/items/${item.id}`} className="inline-flex min-h-10 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-accent-deep hover:bg-ground">
            {t('drafts.openItem')}
          </Link>
        )}
      </div>
    </li>
  );
}
