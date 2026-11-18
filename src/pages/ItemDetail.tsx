import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import type { ExtractedFields, ItemState, Reason } from '../api.js';
import {
  Button, Card, ErrorText, Field, fmtDateTime, inputCls, itemTitle, Loading, Notice, PageTitle, reasonLabel,
  StateBadge, stateLabel, useAction, useApp, useLoad,
} from '../components/ui.js';
import { t } from '../i18n/he.js';
import type { MessageKey } from '../i18n/he.js';

const EDITABLE: ItemState[] = ['needs_attention', 'awaiting_vendor', 'awaiting_backfill_approval', 'ready'];
const TERMINAL: ItemState[] = ['done', 'ignored', 'dismissed'];
const DOC_TYPES = ['tax_invoice', 'receipt', 'tax_invoice_receipt', 'credit_note', 'other'] as const;

type Draft = Record<keyof ExtractedFields, string>;
const KEYS: (keyof ExtractedFields)[] = [
  'vendorName', 'vendorTaxId', 'docType', 'docNumber', 'issueDate', 'total', 'vat', 'net', 'currency',
  'allocationNumber', 'description', 'category',
];
const NUMERIC = new Set<keyof ExtractedFields>(['total', 'vat', 'net']);

const toDraft = (f: ExtractedFields | null): Draft =>
  Object.fromEntries(KEYS.map((k) => [k, f?.[k] == null ? '' : String(f[k])])) as Draft;

/** Only the changed fields, typed for the API ('' → null, numbers parsed). Returns null on a bad number. */
function diff(draft: Draft, orig: Draft): Partial<ExtractedFields> | null {
  const out: Record<string, unknown> = {};
  for (const k of KEYS) {
    if (draft[k] === orig[k]) continue;
    const v = draft[k].trim();
    if (NUMERIC.has(k)) {
      if (v === '') { out[k] = null; continue; }
      const n = Number(v.replace(/,/g, ''));
      if (!Number.isFinite(n)) return null;
      out[k] = n;
    } else out[k] = v === '' ? null : v;
  }
  return out as Partial<ExtractedFields>;
}

export default function ItemDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { settings, refreshSummary } = useApp();
  const load = useLoad(() => api.item(id), [id]);
  const item = load.data;
  const [draft, setDraft] = useState<Draft>(toDraft(null));
  const [problems, setProblems] = useState<Reason[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const act = useAction();

  useEffect(() => { if (item) setDraft(toDraft(item.fields)); }, [item]);

  if (load.loading && !item) return <Loading />;
  if (!item) return <ErrorText>{load.error}</ErrorText>;

  const orig = toDraft(item.fields);
  const editable = EDITABLE.includes(item.state);
  const patch = diff(draft, orig);
  const dirty = patch !== null && Object.keys(patch).length > 0;
  const categories = settings!.settings.categories.map((c) => c.name);

  const refresh = async (note: string | null) => { await load.reload(); await refreshSummary(); setMsg(note); };
  const save = (andSend: boolean) => act.run(async () => {
    setMsg(null);
    let valid = item.state === 'ready';
    if (dirty) {
      const r = await api.saveFields(item.id, patch!);
      setProblems(r.problems);
      valid = r.valid;
    }
    if (!valid) { await refresh(null); return; }
    if (andSend) {
      try { await api.runWorker(); } catch { /* the worker picks it up on its next tick anyway */ }
      await refresh(t('item.sent'));
    } else await refresh(t('item.validSaved'));
  });
  const retry = () => act.run(async () => { await api.retry(item.id); await refresh(t('item.retried')); });
  const dismiss = () => {
    if (!window.confirm(t('item.dismissConfirm'))) return;
    void act.run(async () => { await api.dismiss(item.id); await refresh(null); });
  };

  const input = (k: keyof ExtractedFields, extra: { type?: string; ltr?: boolean } = {}) => (
    <input type={extra.type ?? 'text'} inputMode={NUMERIC.has(k) ? 'decimal' : undefined} disabled={!editable}
      className={`${inputCls} ${extra.ltr ? 'ltr' : ''}`} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
  );

  return (
    <div className="space-y-4">
      <PageTitle actions={<Button variant="ghost" onClick={() => navigate(-1)}>{t('common.back')}</Button>}>
        <span className="me-2">{itemTitle(item)}</span><StateBadge state={item.state} />
      </PageTitle>
      {item.reason && item.state === 'needs_attention' && <Notice tone="warn">{t('common.reason')}: {reasonLabel(item.reason)}</Notice>}
      {msg && <Notice tone="ok">{msg}</Notice>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('item.pdfTitle')} className="lg:order-2">
          {item.hasPdf
            ? <iframe title={t('item.pdfTitle')} src={api.pdfUrl(item.id)} className="h-[70vh] w-full rounded-lg border border-slate-200 bg-slate-100" />
            : <p className="text-sm text-slate-500">{t('item.noPdf')}</p>}
        </Card>

        <Card title={t('item.fields')}>
          {!editable && <p className="mb-3 text-xs text-slate-500">{t('item.readOnly')}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('field.vendorName')}>{input('vendorName')}</Field>
            <Field label={t('field.vendorTaxId')}>{input('vendorTaxId', { ltr: true })}</Field>
            <Field label={t('field.docType')}>
              <select disabled={!editable} className={inputCls} value={draft.docType} onChange={(e) => setDraft({ ...draft, docType: e.target.value })}>
                <option value="">{t('field.choose')}</option>
                {DOC_TYPES.map((d) => <option key={d} value={d}>{t(`docType.${d}` as MessageKey)}</option>)}
              </select>
            </Field>
            <Field label={t('field.docNumber')}>{input('docNumber', { ltr: true })}</Field>
            <Field label={t('field.issueDate')}>{input('issueDate', { type: 'date', ltr: true })}</Field>
            <Field label={t('field.category')}>
              <select disabled={!editable} className={inputCls} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
                <option value="">{t('field.choose')}</option>
                {[...new Set([...categories, ...(draft.category ? [draft.category] : [])])].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field label={t('field.total')}>{input('total', { ltr: true })}</Field>
            <Field label={t('field.vat')}>{input('vat', { ltr: true })}</Field>
            <Field label={t('field.net')}>{input('net', { ltr: true })}</Field>
            <Field label={t('field.currency')}>{input('currency', { ltr: true })}</Field>
            <Field label={t('field.allocationNumber')}>{input('allocationNumber', { ltr: true })}</Field>
            <Field label={t('field.description')}>{input('description')}</Field>
          </div>

          {patch === null && <ErrorText>{t('error.invalid_request')}</ErrorText>}
          {problems.length > 0 && (
            <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              {t('item.invalid')}
              <ul className="list-disc ps-5">{problems.map((p) => <li key={p}>{reasonLabel(p)}</li>)}</ul>
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {editable && <Button disabled={!dirty || act.busy} onClick={() => save(false)}>{t('item.save')}</Button>}
            {editable && item.emailMode !== 'backfill' && <Button variant="secondary" disabled={act.busy || patch === null || (!dirty && item.state !== 'ready')} onClick={() => save(true)}>{t('item.saveSend')}</Button>}
            {item.state === 'needs_attention' && <Button variant="secondary" disabled={act.busy} onClick={retry}>{t('item.retry')}</Button>}
            {!TERMINAL.includes(item.state) && <Button variant="danger" disabled={act.busy} onClick={dismiss}>{t('item.dismiss')}</Button>}
          </div>
          <ErrorText>{act.error}</ErrorText>

          <dl className="mt-4 space-y-1 text-xs text-slate-600">
            {item.attachmentName && <div><dt className="inline font-medium">{t('item.attachment')}: </dt><dd className="inline"><bdi>{item.attachmentName}</bdi></dd></div>}
            {item.provenance && <div><dt className="inline font-medium">{t('item.provenance')}: </dt><dd className="inline">{t(`item.provenance.${item.provenance}` as MessageKey)}</dd></div>}
            {item.storagePath && <div><dt className="inline font-medium">{t('item.storagePath')}: </dt><dd className="inline"><bdi className="ltr font-mono">{item.storagePath}</bdi></dd></div>}
            {item.accountingRef && <div><dt className="inline font-medium">{t('item.accounting')}: </dt><dd className="inline"><bdi className="ltr font-mono">{item.accountingMode} · {item.accountingRef}</bdi></dd></div>}
          </dl>
        </Card>
      </div>

      <Card title={t('item.history')}>
        <ol className="space-y-2 text-sm">
          {item.events.map((e, i) => (
            <li key={i} className="flex flex-wrap gap-x-3 gap-y-0.5 border-b border-slate-100 pb-2">
              <span className="whitespace-nowrap text-slate-500">{fmtDateTime(e.at)}</span>
              <span>{e.from && e.from !== e.to ? `${stateLabel(e.from)} ← ` : ''}{stateLabel(e.to)}</span>
              {e.note && <bdi className="ltr font-mono text-xs text-slate-500">{e.note}</bdi>}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

