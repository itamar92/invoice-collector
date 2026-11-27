import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api.js';
import type { ApproveResult, DraftRow, ExtractedFields, PendingDraft } from '../api.js';
import {
  Button, Empty, ErrorText, fmtDate, fmtMoney, Icon, inputCls, Loading, Notice, PageTitle, reasonLabel, useAction, useApp, useLoad,
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

const DOC_TYPES = ['tax_invoice', 'receipt', 'tax_invoice_receipt', 'credit_note', 'other'] as const;

/** The app's field behind a line, and how it is edited in place. */
type EditKey = 'vendorName' | 'vendorTaxId' | 'docNumber' | 'issueDate' | 'total' | 'vat' | 'docType' | 'category';
const NUMERIC = new Set<EditKey>(['total', 'vat']);

interface Line {
  key: MessageKey;
  field: EditKey;
  /** Our value as the editor shows it. */
  raw: string;
  /** Morning's value in our terms, offered as "take Morning's value" (null: nothing to take). */
  fromMorning: string | null;
  morning: string | null;
  ours: string | null;
  /** Plain value for the copy button (no currency sign or formatting). */
  copy: string | null;
  differs: boolean;
}

const str = (v: string | number | null | undefined) => (v == null ? '' : String(v));

function lines(d: PendingDraft, f: ExtractedFields | null, categoryLabel: string | null, morningCategory: string | null): Line[] {
  const cur = f?.currency ?? d.currency;
  const morningDoc = d.documentType !== null ? MORNING_DOC[d.documentType] ?? null : null;
  const out: Line[] = [
    { key: 'drafts.row.supplier', field: 'vendorName', raw: str(f?.vendorName), fromMorning: d.supplierName, morning: d.supplierName, ours: f?.vendorName ?? null, copy: f?.vendorName ?? null,
      differs: !!f && norm(d.supplierName) !== norm(f.vendorName) },
    { key: 'drafts.row.taxId', field: 'vendorTaxId', raw: str(f?.vendorTaxId), fromMorning: digits(d.supplierTaxId) || null, morning: d.supplierTaxId, ours: f?.vendorTaxId ?? null, copy: f?.vendorTaxId ? digits(f.vendorTaxId) : null,
      differs: !!f?.vendorTaxId && digits(d.supplierTaxId) !== digits(f.vendorTaxId) },
    { key: 'drafts.row.number', field: 'docNumber', raw: str(f?.docNumber), fromMorning: d.number, morning: d.number, ours: f?.docNumber ?? null, copy: f?.docNumber ?? null,
      differs: !!f && normNum(d.number) !== normNum(f.docNumber) },
    { key: 'drafts.row.date', field: 'issueDate', raw: str(f?.issueDate), fromMorning: d.date ? d.date.slice(0, 10) : null, morning: d.date ? fmtDate(d.date) : null, ours: f?.issueDate ? fmtDate(f.issueDate) : null,
      copy: f?.issueDate ? fmtDate(f.issueDate) : null, differs: !!f && d.date !== f.issueDate },
    { key: 'drafts.row.amount', field: 'total', raw: str(f?.total), fromMorning: d.amount !== null ? String(d.amount) : null, morning: d.amount !== null ? fmtMoney(d.amount, d.currency ?? cur) : null,
      ours: f?.total != null ? fmtMoney(f.total, cur) : null, copy: f?.total != null ? String(f.total) : null,
      differs: !!f && !sameMoney(d.amount, f.total) },
    { key: 'drafts.row.vat', field: 'vat', raw: str(f?.vat), fromMorning: d.vat !== null ? String(d.vat) : null, morning: d.vat !== null ? fmtMoney(d.vat, d.currency ?? cur) : null,
      ours: f?.vat != null ? fmtMoney(f.vat, cur) : null, copy: f?.vat != null ? String(f.vat) : null,
      differs: !!f && f.vat !== null && !sameMoney(d.vat, f.vat) },
    { key: 'drafts.row.docType', field: 'docType', raw: str(f?.docType), fromMorning: morningDoc, morning: docLabel(morningDoc), ours: docLabel(f?.docType),
      copy: null, differs: !!f?.docType && d.documentType !== null && MORNING_DOC[d.documentType] !== f.docType },
    { key: 'drafts.row.category', field: 'category', raw: str(f?.category), fromMorning: morningCategory, morning: d.classification, ours: categoryLabel, copy: null,
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
  // Fields fixed here since the list loaded, by item id (the list itself comes from Morning and is not reloaded).
  const [fixed, setFixed] = useState<Map<string, ExtractedFields>>(new Map());
  const { settings } = useApp();
  const categories = settings?.settings.categories ?? [];
  const rows = (list.data?.rows ?? []).map((r): DraftRow => {
    const f = r.item && fixed.get(r.item.id);
    if (!r.item || !f) return r;
    const cls = categories.find((c) => c.name === f.category)?.accountingClassification || null;
    return { ...r, item: { ...r.item, fields: f, classificationId: cls } };
  });
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
                onFixed={(id, f) => setFixed((m) => new Map(m).set(id, f))}
                onDone={(res) => setDone((m) => new Map(m).set(r.draft.id, res))} />
            ))}
          </ul>
        )}
    </div>
  );
}

const MATCH_TONE = { ref: 'bg-ok-tint text-accent-deep', found: 'bg-ok-tint text-accent-deep', maybe: 'bg-warn-tint', none: 'bg-ground-deep' } as const;

function DraftCard({ row, clsTitle, result, onDone, onFixed }: {
  row: DraftRow; clsTitle: Map<string, string>; result?: ApproveResult; onDone: (r: ApproveResult) => void;
  onFixed: (itemId: string, f: ExtractedFields) => void;
}) {
  const { settings } = useApp();
  const categories = settings?.settings.categories ?? [];
  const { draft: d, item } = row;
  const f = item?.fields ?? null;
  const act = useAction();
  const [copied, setCopied] = useState<string | null>(null);
  const categoryLabel = f?.category
    ? (item?.classificationId && clsTitle.get(item.classificationId)) || f.category
    : null;
  // Morning's classification as one of our categories (the category mapped to a classification of that name).
  const morningCategory = d.classification
    ? categories.find((c) => c.accountingClassification && norm(clsTitle.get(c.accountingClassification)) === norm(d.classification))?.name ?? null
    : null;
  const ls = lines(d, f, categoryLabel, morningCategory);
  const [editing, setEditing] = useState<EditKey | null>(null);
  const [fixNote, setFixNote] = useState<string[]>([]);
  const canEdit = !!item && !result;
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
            {ls.filter((l) => l.morning || l.ours || (canEdit && f)).map((l) => (
              <tr key={l.key} className={`border-t border-line ${l.differs ? 'bg-warn-tint' : ''}`}>
                <td className="py-1.5 pe-2 text-muted">{t(l.key)}</td>
                <td className="py-1.5 pe-2 [overflow-wrap:anywhere]">{l.morning ?? <span className="text-muted">—</span>}</td>
                {f && editing === l.field && item && (
                  <td className="py-1.5">
                    <EditCell line={l} itemId={item.id} categories={categories.map((c) => c.name)}
                      onCancel={() => setEditing(null)}
                      onSaved={(nf, p) => { setEditing(null); setFixNote(p); onFixed(item.id, nf); }} />
                  </td>
                )}
                {f && editing !== l.field && (
                  <td className="py-1.5">
                    <span className="flex items-center gap-1.5">
                      {canEdit ? (
                        <button type="button" onClick={() => setEditing(l.field)} title={t('drafts.edit')} aria-label={`${t('drafts.edit')} ${t(l.key)}`}
                          className={`group -mx-1 inline-flex min-h-8 items-center gap-1 rounded-lg px-1 text-start hover:bg-ground [overflow-wrap:anywhere] ${l.differs ? 'font-semibold' : ''}`}>
                          {l.ours ?? <span className="text-muted">—</span>}
                          <Icon name="pencil" className="size-3.5 text-muted opacity-60 group-hover:opacity-100" />
                        </button>
                      ) : <span className={`[overflow-wrap:anywhere] ${l.differs ? 'font-semibold' : ''}`}>{l.ours ?? <span className="text-muted">—</span>}</span>}
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

      {fixNote.length > 0 && <Notice tone="warn">{t('drafts.editProblems', { list: fixNote.join(', ') })}</Notice>}
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

/** One of the app's values edited in place: saved to the document on ✓ / Enter, dropped on ✕ / Escape. */
function EditCell({ line, itemId, categories, onCancel, onSaved }: {
  line: Line; itemId: string; categories: string[]; onCancel: () => void; onSaved: (f: ExtractedFields, problems: string[]) => void;
}) {
  const [v, setV] = useState(line.raw);
  const [problems, setProblems] = useState<string[]>([]);
  const act = useAction();
  const ref = useRef<HTMLInputElement & HTMLSelectElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const k = line.field;

  const save = () => {
    const s = v.trim();
    if (s === line.raw.trim()) { onCancel(); return; }
    let value: string | number | null = s === '' ? null : s;
    if (NUMERIC.has(k) && s !== '') {
      const n = Number(s.replace(/,/g, ''));
      if (!Number.isFinite(n)) { setProblems([t('error.invalid_request')]); return; }
      value = n;
    }
    void act.run(async () => {
      const r = await api.saveFields(itemId, { [k]: value } as Partial<ExtractedFields>);
      if (!r.item.fields) return;
      onSaved(r.item.fields, r.problems.map(reasonLabel));
    }, 'save');
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };
  const cls = `${inputCls} min-h-9 py-1 ${k === 'vendorName' || k === 'category' || k === 'docType' ? '' : 'ltr'}`;
  const choices = k === 'category' ? [...new Set([...categories, ...(v ? [v] : [])])] : null;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        {k === 'docType' ? (
          <select ref={ref} className={cls} value={v} disabled={act.busy} onChange={(e) => setV(e.target.value)} onKeyDown={keys}>
            <option value="">{t('field.choose')}</option>
            {DOC_TYPES.map((d) => <option key={d} value={d}>{t(`docType.${d}` as MessageKey)}</option>)}
          </select>
        ) : choices ? (
          <select ref={ref} className={cls} value={v} disabled={act.busy} onChange={(e) => setV(e.target.value)} onKeyDown={keys}>
            <option value="">{t('field.choose')}</option>
            {choices.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        ) : (
          <input ref={ref} type={k === 'issueDate' ? 'date' : 'text'} inputMode={NUMERIC.has(k) ? 'decimal' : undefined}
            className={cls} value={v} disabled={act.busy} onChange={(e) => setV(e.target.value)} onKeyDown={keys} />
        )}
        <button type="button" onClick={save} disabled={act.busy} title={t('drafts.editSave')} aria-label={t('drafts.editSave')}
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-white hover:bg-accent-deep disabled:opacity-60">
          <Icon name="check" className="size-4" />
        </button>
        <button type="button" onClick={onCancel} disabled={act.busy} title={t('common.cancel')} aria-label={t('common.cancel')}
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-ground">
          <Icon name="close" className="size-4" />
        </button>
      </div>
      {line.fromMorning !== null && line.fromMorning !== v && (
        <button type="button" onClick={() => { setV(line.fromMorning!); ref.current?.focus(); }} disabled={act.busy}
          className="inline-flex min-h-8 items-center rounded-lg px-1.5 text-xs font-medium text-accent-deep hover:bg-ground">
          {t('drafts.takeMorning')}
        </button>
      )}
      {problems.length > 0 && <p className="text-xs text-warn-deep">{problems.join(', ')}</p>}
      <ErrorText>{act.error}</ErrorText>
    </div>
  );
}
