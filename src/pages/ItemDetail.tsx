import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import type { ExtractedFields, ItemState, Reason, Reapplied } from '../api.js';
import {
  AiThinking, Button, Card, ErrorText, Field, fmtDateTime, hintCls, Icon, inputCls, itemTitle, Loading, Notice, reasonLabel, rowCls,
  setFlash, StateBadge, stateLabel, usageText, useAction, useApp, useLoad,
} from '../components/ui.js';
import { t } from '../i18n/he.js';
import type { MessageKey } from '../i18n/he.js';

const EDITABLE: ItemState[] = ['needs_attention', 'awaiting_vendor', 'awaiting_backfill_approval', 'ready'];
const TERMINAL: ItemState[] = ['done', 'ignored', 'dismissed'];
const DOC_TYPES = ['tax_invoice', 'receipt', 'tax_invoice_receipt', 'credit_note', 'other'] as const;

type FieldKey = Exclude<keyof ExtractedFields, 'vatConfirmed'>;
type Draft = Record<FieldKey, string>;
const KEYS: FieldKey[] = [
  'vendorName', 'vendorTaxId', 'docType', 'docNumber', 'issueDate', 'total', 'vat', 'net', 'currency',
  'allocationNumber', 'description', 'category',
];
const NUMERIC = new Set<FieldKey>(['total', 'vat', 'net']);

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
  const [vatOk, setVatOk] = useState(false);
  const [problems, setProblems] = useState<Reason[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [reparseNote, setReparseNote] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const act = useAction();
  // Arriving straight from an upload: say what happened to the file.
  const uploaded = (useLocation().state as { uploaded?: 'new' | 'duplicate' } | null)?.uploaded;

  useEffect(() => { if (item) { setDraft(toDraft(item.fields)); setVatOk(!!item.fields?.vatConfirmed); } }, [item]);

  if (load.loading && !item) return <Loading rows={4} />;
  if (!item) return <ErrorText>{load.error}</ErrorText>;

  const orig = toDraft(item.fields);
  const editable = EDITABLE.includes(item.state);
  const fieldPatch = diff(draft, orig);
  // The VAT approval travels with the fields; it only matters while the VAT does not add up.
  const patch = fieldPatch === null ? null
    : vatOk !== !!item.fields?.vatConfirmed ? { ...fieldPatch, vatConfirmed: vatOk } : fieldPatch;
  const dirty = patch !== null && Object.keys(patch).length > 0;
  const vatQuestion = vatOk || item.reason === 'vat_mismatch' || problems.includes('vat_mismatch');
  const categories = settings!.settings.categories.map((c) => c.name);

  const refresh = async (note: string | null) => { await load.reload(); await refreshSummary(); setMsg(note); };
  /** Done with this document: back to the list (and the spot in it) the user came from, with the outcome. */
  const leave = async (note: string) => {
    await refreshSummary();
    setFlash(note);
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1); else navigate('/attention', { replace: true });
  };
  const save = (andSend: boolean) => act.run(async () => {
    setMsg(null);
    let valid = item.state === 'ready';
    if (dirty) {
      const r = await api.saveFields(item.id, patch!);
      setProblems(r.problems);
      valid = r.valid;
    }
    if (!valid) { await refresh(null); return; } // still something to fix: stay here
    if (andSend) {
      try { await api.runWorker(); } catch { /* the worker picks it up on its next tick anyway */ }
      await leave(t('item.sentNamed', { name: itemTitle(item) }));
    } else await leave(t('item.savedNamed', { name: itemTitle(item) }));
  }, andSend ? 'send' : 'save');
  const reparse = () => {
    if (dirty || item.provenance === 'manual') { if (!window.confirm(t('item.reparseConfirm'))) return; }
    void act.run(async () => {
      setMsg(null); setProblems([]);
      const r = await api.reparse(item.id);
      await load.reload(); await refreshSummary();
      if (r.outcome === 'invalid') {
        setReparseNote({ tone: 'warn', text: `${t('item.reparse.invalid')} ${r.problems.map(reasonLabel).join(', ')}` });
        return;
      }
      setReparseNote({ tone: r.outcome === 'updated' || r.outcome === 'same' ? 'ok' : 'warn', text: t(`item.reparse.${r.outcome}` as MessageKey) });
    }, 'reparse');
  };
  const retry = () => act.run(async () => { await api.retry(item.id); await leave(t('item.retriedNamed', { name: itemTitle(item) })); }, 'retry');
  // Set aside as the receipt of a tax invoice already on file (only the invoice counts as the expense).
  const invoiceOf = item.state === 'ignored'
    ? item.events.map((e) => /^receipt_of_invoice:(.+)$/.exec(e.note ?? '')?.[1]).filter(Boolean).pop() ?? null
    : null;
  const keepReceipt = () => act.run(async () => {
    await api.keepReceipt(item.id);
    await leave(t('item.receiptKeptNamed', { name: itemTitle(item) }));
  }, 'keep-receipt');
  const dismiss = () => {
    if (!window.confirm(t('item.dismissConfirm'))) return;
    void act.run(async () => { await api.dismiss(item.id); await leave(t('item.dismissedNamed', { name: itemTitle(item) })); }, 'dismiss');
  };
  /** Saves the owner's corrections (if any) so the recipe writer reads them as the right answer; returns the vendor. */
  const saveForRecipe = async (): Promise<string | null> => {
    if (!dirty) return item.vendorKey;
    const r = await api.saveFields(item.id, patch!);
    setProblems(r.problems);
    await load.reload(); await refreshSummary();
    return r.item.vendorKey;
  };

  const input = (k: FieldKey, extra: { type?: string; ltr?: boolean } = {}) => (
    <input type={extra.type ?? 'text'} inputMode={NUMERIC.has(k) ? 'decimal' : undefined} disabled={!editable}
      className={`${inputCls} ${extra.ltr ? 'ltr' : ''}`} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
  );

  return (
    <div className="space-y-4">
      <div>
        <button type="button" onClick={() => navigate(-1)} className="mb-1 inline-flex min-h-9 items-center gap-1 text-sm font-semibold text-accent">
          <Icon name="back" className="size-4" />{t('common.back')}
        </button>
        <h1 className="display text-[26px] md:text-3xl">{itemTitle(item)}</h1>
        <div className="mt-1.5"><StateBadge state={item.state} /></div>
      </div>
      {item.reason && item.state === 'needs_attention' && <ErrorText>{t('common.reason')}: {reasonLabel(item.reason)}</ErrorText>}
      {uploaded && !msg && !(uploaded === 'new' && item.state === 'needs_attention') && <Notice tone={uploaded === 'new' ? 'ok' : 'warn'}>{t(`upload.${uploaded}`)}</Notice>}
      {msg && <Notice tone="ok">{msg}</Notice>}
      {invoiceOf && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-info-tint px-3 py-2 text-sm">
          <span>{t('item.receiptSetAside')}</span>
          <Link className="font-semibold text-accent underline" to={`/items/${invoiceOf}`}>{t('item.openInvoice')}</Link>
          <Button variant="ghost" className="ms-auto" loading={act.is('keep-receipt')} disabled={act.busy} onClick={keepReceipt}>{t('item.keepReceipt')}</Button>
        </div>
      )}

      {/* Phone: fields first, the document below. Desktop: side by side, the document stays in view. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
        <Card title={t('item.fields')}>
          {!editable && <p className="mb-2 text-xs text-muted">{t('item.readOnly')}</p>}
          <div className="grid grid-cols-6 gap-x-2.5 gap-y-2.5">
            <Field className="col-span-6" label={t('field.vendorName')}>{input('vendorName')}</Field>
            <Field className="col-span-2" label={t('field.total')}>{input('total', { ltr: true })}</Field>
            <Field className="col-span-2" label={t('field.vat')}>{input('vat', { ltr: true })}</Field>
            <Field className="col-span-2" label={t('field.net')}>{input('net', { ltr: true })}</Field>
            <Field className="col-span-3" label={t('field.issueDate')}>{input('issueDate', { type: 'date', ltr: true })}</Field>
            <Field className="col-span-3" label={t('field.currency')}>{input('currency', { ltr: true })}</Field>
            <Field className="col-span-3" label={t('field.docType')}>
              <select disabled={!editable} className={inputCls} value={draft.docType} onChange={(e) => setDraft({ ...draft, docType: e.target.value })}>
                <option value="">{t('field.choose')}</option>
                {DOC_TYPES.map((d) => <option key={d} value={d}>{t(`docType.${d}` as MessageKey)}</option>)}
              </select>
            </Field>
            <Field className="col-span-3" label={t('field.docNumber')}>{input('docNumber', { ltr: true })}</Field>
            <Field className="col-span-6" label={t('field.category')}>
              <select disabled={!editable} className={inputCls} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
                <option value="">{t('field.choose')}</option>
                {[...new Set([...categories, ...(draft.category ? [draft.category] : [])])].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field className="col-span-3" label={t('field.vendorTaxId')}>{input('vendorTaxId', { ltr: true })}</Field>
            <Field className="col-span-3" label={t('field.allocationNumber')}>{input('allocationNumber', { ltr: true })}</Field>
            <Field className="col-span-6" label={t('field.description')}>{input('description')}</Field>
            {vatQuestion && (
              <label className="col-span-6 flex items-start gap-2 rounded-xl bg-warn-tint p-3 text-sm">
                <input type="checkbox" className="mt-0.5 size-5" disabled={!editable} checked={vatOk} onChange={(e) => setVatOk(e.target.checked)} />
                <span><span className="font-semibold">{t('item.vatConfirm')}</span><span className="block text-xs text-muted">{t('item.vatConfirmHint')}</span></span>
              </label>
            )}
          </div>

          {reparseNote && <div className="mt-3"><Notice tone={reparseNote.tone}>{reparseNote.text}</Notice></div>}
          {patch === null && <ErrorText>{t('error.invalid_request')}</ErrorText>}
          {problems.length > 0 && (
            <div className="mt-3 rounded-xl bg-warn-tint p-3 text-sm">
              {t('item.invalid')}
              <ul className="list-disc ps-5">{problems.map((p) => <li key={p}>{reasonLabel(p)}</li>)}</ul>
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {editable && <Button loading={act.is('save')} disabled={!dirty || act.busy} onClick={() => save(false)}>{t('item.save')}</Button>}
            {editable && item.emailMode !== 'backfill' && <Button variant="secondary" loading={act.is('send')} disabled={act.busy || patch === null || (!dirty && item.state !== 'ready')} onClick={() => save(true)}>{t('item.saveSend')}</Button>}
            {editable && !item.storagePath && item.hasText && <Button variant="ghost" loading={act.is('reparse')} disabled={act.busy} onClick={reparse}>{t('item.reparse')}</Button>}
            {item.state === 'needs_attention' && <Button variant="secondary" loading={act.is('retry')} disabled={act.busy} onClick={retry}>{t('item.retry')}</Button>}
            {!TERMINAL.includes(item.state) && <Button variant="danger" className="ms-auto" loading={act.is('dismiss')} disabled={act.busy} onClick={dismiss}>{t('item.dismiss')}</Button>}
          </div>
          <ErrorText>{act.error}</ErrorText>

          {item.hasText && (editable || item.vendorKey) && (
            <RecipeFromFix canSave={patch !== null} dirty={dirty} disabled={act.busy} saveFirst={saveForRecipe} onRecipeSaved={() => void refreshSummary()} />
          )}

          <dl className="mt-4 space-y-1 text-xs text-muted">
            {item.attachmentName && <div><dt className="inline font-semibold">{t('item.attachment')}: </dt><dd className="inline"><bdi>{item.attachmentName}</bdi></dd></div>}
            {item.provenance && <div><dt className="inline font-semibold">{t('item.provenance')}: </dt><dd className="inline">{t(`item.provenance.${item.provenance}` as MessageKey)}</dd></div>}
            {item.aiUsage.calls > 0 && <div><dt className="inline font-semibold">{t('item.aiUsage')}: </dt><dd className="num inline">{usageText(item.aiUsage)}</dd></div>}
            {item.storagePath && <div><dt className="inline font-semibold">{t('item.storagePath')}: </dt><dd className="inline"><bdi className="ltr break-all font-mono">{item.storagePath}</bdi></dd></div>}
            {item.accountingRef && <div><dt className="inline font-semibold">{t('item.accounting')}: </dt><dd className="inline"><bdi className="ltr break-all font-mono">{item.accountingMode} · {item.accountingRef}</bdi></dd></div>}
          </dl>
        </Card>

        <Card title={t('item.pdfTitle')} className="lg:sticky lg:top-8 lg:self-start">
          {item.hasPdf
            ? <iframe title={t('item.pdfTitle')} src={api.pdfUrl(item.id)} className="h-[70dvh] w-full rounded-xl border border-line bg-ground lg:h-[calc(100dvh-10rem)]" />
            : <p className="text-sm text-muted">{t('item.noPdf')}</p>}
        </Card>
      </div>

      <Card title={t('item.history')}>
        <ol className="text-sm">
          {item.events.map((e, i) => (
            <li key={i} className={`flex flex-wrap gap-x-3 gap-y-0.5 py-1.5 ${rowCls}`}>
              <span className="num text-muted">{fmtDateTime(e.at)}</span>
              <span>{e.from && e.from !== e.to ? `${stateLabel(e.from)} ← ` : ''}{stateLabel(e.to)}</span>
              {e.note && <bdi className="ltr break-all font-mono text-xs text-muted">{e.note}</bdi>}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

/**
 * The recipe read this document wrong: the owner corrects the fields above, then asks the AI for a new recipe that
 * reads them that way. The corrections are saved first (they are what the recipe must reproduce); the new recipe
 * is saved only when the owner presses save.
 */
function RecipeFromFix({ canSave, dirty, disabled, saveFirst, onRecipeSaved }: {
  canSave: boolean; dirty: boolean; disabled: boolean; saveFirst: () => Promise<string | null>; onRecipeSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [draft, setDraft] = useState<{
    vendorKey: string; recipe: Record<string, unknown>; reproduces: boolean; usage: Parameters<typeof usageText>[0];
  } | null>(null);
  const [savedRecipe, setSavedRecipe] = useState<Reapplied | null>(null);
  const act = useAction();
  const { id = '' } = useParams();

  const build = () => act.run(async () => {
    setDraft(null); setSavedRecipe(null);
    const vendorKey = await saveFirst();
    if (!vendorKey) throw new Error(t('item.recipeFix.noVendor'));
    const r = await api.regenerateRecipe(vendorKey, id, comment.trim());
    setDraft({ vendorKey, ...r });
  }, 'build');
  const keep = () => act.run(async () => {
    if (!draft) return;
    const r = await api.saveRecipe(draft.vendorKey, draft.recipe);
    setSavedRecipe(r.reapplied);
    onRecipeSaved();
  }, 'keep');

  if (!open) {
    return (
      <div className="mt-4 rounded-xl border border-dashed border-line-strong p-3">
        <div className="text-sm font-semibold">{t('item.recipeFix.title')}</div>
        <p className={`mt-0.5 ${hintCls}`}>{t('item.recipeFix.teaser')}</p>
        <Button variant="ghost" className="mt-1 -ms-2" onClick={() => setOpen(true)}>{t('item.recipeFix.open')}</Button>
      </div>
    );
  }
  return (
    <div className="mt-4 space-y-2 rounded-xl border border-line bg-ground p-3">
      <div className="text-sm font-semibold">{t('item.recipeFix.title')}</div>
      <ol className="list-decimal space-y-0.5 ps-5 text-xs text-muted">
        <li>{t('item.recipeFix.step1')}</li>
        <li>{t('item.recipeFix.step2')}</li>
        <li>{t('item.recipeFix.step3')}</li>
      </ol>
      {dirty && <Notice tone="info">{t('item.recipeFix.willSave')}</Notice>}
      <label className="block text-xs">
        <span className="mb-0.5 block font-semibold text-muted">{t('vendors.regen.comment')}</span>
        <textarea className={`${inputCls} h-20 py-2`} value={comment} maxLength={2000} disabled={act.busy}
          placeholder={t('vendors.regen.placeholder')} onChange={(e) => setComment(e.target.value)} />
      </label>
      {act.is('build')
        ? <AiThinking title={t('item.recipeFix.thinking')} hint={t('item.recipeFix.thinkingHint')} />
        : (
          <Button variant="secondary" className="bg-white" disabled={disabled || act.busy || !canSave} onClick={build}>
            {t('item.recipeFix.run')}
          </Button>
        )}
      {draft && (
        <div className="space-y-2">
          <Notice tone={draft.reproduces ? 'ok' : 'warn'}>{draft.reproduces ? t('item.recipeFix.ok') : t('item.recipeFix.miss')}</Notice>
          <p className="num text-xs text-muted">{t('vendors.regen.usage', { line: usageText(draft.usage) })}</p>
          <details className="text-xs">
            <summary className="cursor-pointer font-semibold text-accent">{t('item.recipeFix.show')}</summary>
            <pre className="ltr mt-1 max-h-64 overflow-auto rounded-lg bg-white p-2 font-mono text-[11px]">{JSON.stringify(draft.recipe, null, 2)}</pre>
          </details>
          {savedRecipe
            ? <Notice tone="ok">{savedRecipe.updated > 0 ? t('item.recipeFix.reapplied', { ...savedRecipe })
              : savedRecipe.checked > 0 ? t('item.recipeFix.reappliedSame', { ...savedRecipe }) : t('item.recipeFix.saved')}</Notice>
            : (
              <div className="flex flex-wrap gap-2">
                <Button loading={act.is('keep')} disabled={act.busy} onClick={keep}>{t('item.recipeFix.keep')}</Button>
                <Button variant="ghost" disabled={act.busy} onClick={build}>{t('item.recipeFix.again')}</Button>
              </div>
            )}
        </div>
      )}
      <ErrorText>{act.error}</ErrorText>
    </div>
  );
}
