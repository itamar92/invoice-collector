import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import type { AiUsageTotals, Item, Reapplied, RecipeCheck, RecipeVersion, Vendor, VendorStatus } from '../api.js';
import { RecipeCheckView } from '../components/RecipeCheck.js';
import {
  AiThinking, Avatar, Button, Card, Empty, ErrorText, fmtDate, fmtDateTime, fmtMoney, hintCls, itemTitle, Notice, Icon, inputCls, rowCls, Saved, Loading, PageTitle, usageText, useAction, useApp, useLoad,
} from '../components/ui.js';
import { t } from '../i18n/he.js';
import type { MessageKey } from '../i18n/he.js';

const STATUSES: VendorStatus[] = ['unreviewed', 'business', 'personal', 'ignored'];

const docLabel = (i: Item) => `${fmtDate(i.fields?.issueDate ?? i.createdAt)} · ${fmtMoney(i.fields?.total, i.fields?.currency)} · ${i.attachmentName ?? itemTitle(i)}`;

/**
 * Sends one of the vendor's documents and the owner's notes to the AI, which writes a new recipe. The draft lands
 * in the editor below; nothing is saved until the owner presses save.
 */
type Docs = ReturnType<typeof useVendorDocs>;
type Checked = { check: RecipeCheck; text: string };

/** The vendor's documents a recipe can be written from or tried on, and the one picked. */
function useVendorDocs(key: string) {
  const docs = useLoad(() => api.items({ vendor: key, limit: 50 }), [key]);
  const usable = (docs.data?.items ?? []).filter((i) => i.fields && i.hasText);
  const [itemId, setItemId] = useState('');
  return { loading: docs.loading && !docs.data, usable, chosen: itemId || usable[0]?.id || '', choose: setItemId };
}

function RegenerateRecipe({ vendor, docs, onDraft }: { vendor: Vendor; docs: Docs; onDraft: (json: string, checked: Checked) => void }) {
  const { usable, chosen } = docs;
  const [comment, setComment] = useState('');
  const [result, setResult] = useState<{ ok: boolean; usage: AiUsageTotals } | null>(null);
  const act = useAction();

  const run = () => act.run(async () => {
    setResult(null);
    const r = await api.regenerateRecipe(vendor.key, chosen, comment);
    onDraft(JSON.stringify(r.recipe, null, 2), { check: r.check, text: r.text });
    setResult({ ok: r.reproduces, usage: r.usage });
  });

  return (
    <div className="space-y-2 rounded-xl border border-line bg-white p-3">
      <div className="text-sm font-semibold">{t('vendors.regen.title')}</div>
      <p className={hintCls}>{t('vendors.regen.hint')}</p>
      {docs.loading ? <Loading /> : usable.length === 0 ? <p className="text-sm text-muted">{t('vendors.regen.noDocs')}</p> : (
        <>
          <label className="block text-xs">
            <span className="mb-0.5 block font-semibold text-muted">{t('vendors.regen.doc')}</span>
            <div className="flex items-center gap-2">
              <select className={inputCls} value={chosen} onChange={(e) => docs.choose(e.target.value)}>
                {usable.map((i) => <option key={i.id} value={i.id}>{docLabel(i)}</option>)}
              </select>
              <Link to={`/items/${chosen}`} className="shrink-0 text-sm font-semibold text-accent underline">{t('vendors.regen.open')}</Link>
            </div>
          </label>
          <label className="block text-xs">
            <span className="mb-0.5 block font-semibold text-muted">{t('vendors.regen.comment')}</span>
            <textarea className={`${inputCls} h-24 py-2`} value={comment} maxLength={2000}
              placeholder={t('vendors.regen.placeholder')} onChange={(e) => setComment(e.target.value)} />
          </label>
          {act.busy
            ? <AiThinking title={t('vendors.regen.running')} hint={t('item.recipeFix.thinkingHint')} />
            : <Button variant="secondary" disabled={!chosen} onClick={run}>{t('vendors.regen.run')}</Button>}
          {result !== null && <Notice tone={result.ok ? 'ok' : 'warn'}>{result.ok ? t('vendors.regen.ok') : t('vendors.regen.miss')}</Notice>}
          {result !== null && <p className="num text-xs text-muted">{t('vendors.regen.usage', { line: usageText(result.usage) })}</p>}
          <ErrorText>{act.error}</ErrorText>
        </>
      )}
    </div>
  );
}

function RecipeEditor({ vendor }: { vendor: Vendor }) {
  const history = useLoad(() => api.recipes(vendor.key), [vendor.key]);
  const versions = [...(history.data ?? [])].sort((a, b) => b.version - a.version);
  const latest = versions[0] as RecipeVersion | undefined;
  const [text, setText] = useState<string | null>(null);
  const act = useAction();
  const [saved, setSaved] = useState(false);
  const [reapplied, setReapplied] = useState<Reapplied | null>(null);
  const [checked, setChecked] = useState<Checked | null>(null);
  const docs = useVendorDocs(vendor.key);
  const { refreshSummary } = useApp();
  const value = text ?? (latest ? JSON.stringify(latest.recipe, null, 2) : '');

  const save = () => act.run(async () => {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { throw new Error(t('vendors.invalidJson')); }
    const r = await api.saveRecipe(vendor.key, parsed);
    setText(null); setSaved(true); setReapplied(r.reapplied); await history.reload(); await refreshSummary();
  });
  // Tries what is in the editor (saved or not) on the picked document; nothing is saved.
  const test = () => act.run(async () => {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { throw new Error(t('vendors.invalidJson')); }
    setChecked(await api.testRecipe(vendor.key, docs.chosen, parsed));
  }, 'test');
  const toggleAi = (v: boolean) => act.run(async () => {
    const r = await api.setAiAlways(vendor.key, v);
    setSaved(false); setReapplied(r.reapplied.checked > 0 ? r.reapplied : null); await history.reload(); await refreshSummary();
  });

  if (history.loading && !history.data) return <Loading />;
  return (
    <div className="space-y-3 rounded-xl bg-ground p-3">
      {latest
        ? (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 size-5" checked={!!latest.recipe.aiAlways} disabled={act.busy} onChange={(e) => toggleAi(e.target.checked)} />
            <span><span className="font-semibold">{t('vendors.aiAlways')}</span><span className="block text-xs text-muted">{t('vendors.aiAlwaysHint')}</span></span>
          </label>
        )
        : <p className="text-sm text-muted">{t('vendors.noRecipe')}</p>}
      <RegenerateRecipe vendor={vendor} docs={docs} onDraft={(json, c) => { setText(json); setSaved(false); setChecked(c); }} />
      <div>
        <p className={`mb-1 ${hintCls}`}>{t('vendors.recipeHint')}</p>
        <textarea aria-label={t('vendors.recipeHint')} className={`${inputCls} ltr h-64 font-mono text-xs`} spellCheck={false} value={value}
          onChange={(e) => { setText(e.target.value); setSaved(false); setReapplied(null); setChecked(null); }} />
      </div>
      <div className="flex items-center gap-2">
        <Button disabled={act.busy || !value.trim() || text === null} onClick={save}>{t('vendors.saveRecipe')}</Button>
        <Button variant="secondary" className="bg-white" loading={act.is('test')} disabled={act.busy || !value.trim() || !docs.chosen} onClick={test}>
          {t('recipeCheck.run')}
        </Button>
        <Saved show={saved} />
      </div>
      {checked && (
        <div className="space-y-2 rounded-xl border border-line bg-white p-3">
          <Notice tone={checked.check.ok ? 'ok' : 'warn'}>{checked.check.ok ? t('recipeCheck.ok') : t('recipeCheck.miss')}</Notice>
          <RecipeCheckView check={checked.check} text={checked.text} />
        </div>
      )}
      {reapplied && reapplied.checked > 0 && (
        <Notice tone="ok">{reapplied.updated > 0 ? t('vendors.reapplied', { ...reapplied }) : t('vendors.reappliedSame', { ...reapplied })}</Notice>
      )}
      <ErrorText>{act.error}</ErrorText>
      {versions.length > 0 && (
        <div>
          <h4 className="text-[13px] font-semibold">{t('vendors.history')}</h4>
          <ul className="text-sm">
            {versions.map((v) => (
              <li key={v.version} className={`flex flex-wrap items-center justify-between gap-2 py-1 ${rowCls}`}>
                <span>{t('vendors.version', { n: v.version })} · {t(`vendors.source.${v.source}` as MessageKey)} · {fmtDateTime(v.createdAt)}</span>
                <Button variant="ghost" onClick={() => { setText(JSON.stringify(v.recipe, null, 2)); setSaved(false); }}>{t('vendors.load')}</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function VendorRow({ vendor, categories, onChange }: { vendor: Vendor; categories: string[]; onChange: (v: Vendor) => void }) {
  const [open, setOpen] = useState(false);
  const act = useAction();
  const { refreshSummary } = useApp();
  const [pending, setPending] = useState(false);

  const update = (patch: { status?: VendorStatus; defaultCategory?: string | null }) => act.run(async () => {
    const r = await api.setVendor(vendor.key, patch);
    onChange(r.vendor);
    setPending(!r.processed);
    await refreshSummary();
  });

  return (
    <li className={`py-3 ${rowCls}`}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-40 items-center gap-3">
          <Avatar name={vendor.displayName} />
          <div>
            <div className="font-semibold">{vendor.displayName}</div>
            <bdi className="ltr block font-mono text-xs text-muted">{vendor.key}</bdi>
          </div>
        </div>
        <div className="grid w-full grid-cols-2 items-end gap-2 sm:w-auto sm:grid-cols-[9rem_11rem_auto]">
          <label className="text-xs">
            <span className="mb-0.5 block font-semibold text-muted">{t('vendors.status')}</span>
            <select className={inputCls} value={vendor.status} disabled={act.busy} onChange={(e) => update({ status: e.target.value as VendorStatus })}>
              {STATUSES.map((s) => <option key={s} value={s}>{t(`vendorStatus.${s}` as MessageKey)}</option>)}
            </select>
          </label>
          <label className="text-xs">
            <span className="mb-0.5 block font-semibold text-muted">{t('vendors.defaultCategory')}</span>
            <select className={inputCls} value={vendor.defaultCategory ?? ''} disabled={act.busy}
              onChange={(e) => update({ defaultCategory: e.target.value || null })}>
              <option value="">{t('field.choose')}</option>
              {[...new Set([...categories, ...(vendor.defaultCategory ? [vendor.defaultCategory] : [])])].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <Button variant="ghost" className="col-span-2 justify-self-start sm:col-span-1" aria-expanded={open} onClick={() => setOpen(!open)}>{t('vendors.edit')}<Icon name={open ? 'up' : 'down'} className="size-4" /></Button>
        </div>
      </div>
      {pending && <p className="mt-2 rounded-lg bg-warn-tint px-2 py-1 text-xs">{t('vendors.pending')}</p>}
      <ErrorText>{act.error}</ErrorText>
      {open && <div className="mt-3"><RecipeEditor vendor={vendor} /></div>}
    </li>
  );
}

export default function Vendors() {
  const { settings } = useApp();
  const list = useLoad(() => api.vendors());
  const categories = settings!.settings.categories.map((c) => c.name);
  const replace = (v: Vendor) => list.setData((list.data ?? []).map((x) => (x.key === v.key ? v : x)));

  return (
    <div className="space-y-4">
      <PageTitle>{t('vendors.title')}</PageTitle>
      <dl className="grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-3">
        {(['business', 'personal', 'ignored'] as const).map((s) => (
          <div key={s}><dt className="inline font-semibold">{t(`vendorStatus.${s}` as MessageKey)}: </dt><dd className="inline text-muted">{t(`vendorStatus.${s}Hint` as MessageKey)}</dd></div>
        ))}
      </dl>
      <Card>
        {list.loading && !list.data ? <Loading rows={5} /> : list.error ? <ErrorText>{list.error}</ErrorText> : !list.data?.length ? <Empty>{t('vendors.empty')}</Empty> : (
          <ul>
            {list.data.map((v) => <VendorRow key={v.key} vendor={v} categories={categories} onChange={replace} />)}
          </ul>
        )}
      </Card>
    </div>
  );
}
