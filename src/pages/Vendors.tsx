import { useState } from 'react';
import { api } from '../api.js';
import type { RecipeVersion, Vendor, VendorStatus } from '../api.js';
import {
  Avatar, Button, Card, Empty, ErrorText, fmtDateTime, hintCls, Icon, inputCls, rowCls, Saved, Loading, PageTitle, useAction, useApp, useLoad,
} from '../components/ui.js';
import { t } from '../i18n/he.js';
import type { MessageKey } from '../i18n/he.js';

const STATUSES: VendorStatus[] = ['unreviewed', 'business', 'personal', 'ignored'];

function RecipeEditor({ vendor }: { vendor: Vendor }) {
  const history = useLoad(() => api.recipes(vendor.key), [vendor.key]);
  const versions = [...(history.data ?? [])].sort((a, b) => b.version - a.version);
  const latest = versions[0] as RecipeVersion | undefined;
  const [text, setText] = useState<string | null>(null);
  const act = useAction();
  const [saved, setSaved] = useState(false);
  const value = text ?? (latest ? JSON.stringify(latest.recipe, null, 2) : '');

  const save = () => act.run(async () => {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { throw new Error(t('vendors.invalidJson')); }
    await api.saveRecipe(vendor.key, parsed);
    setText(null); setSaved(true); await history.reload();
  });
  const toggleAi = (v: boolean) => act.run(async () => { await api.setAiAlways(vendor.key, v); setSaved(false); await history.reload(); });

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
      <div>
        <p className={`mb-1 ${hintCls}`}>{t('vendors.recipeHint')}</p>
        <textarea aria-label={t('vendors.recipeHint')} className={`${inputCls} ltr h-64 font-mono text-xs`} spellCheck={false} value={value}
          onChange={(e) => { setText(e.target.value); setSaved(false); }} />
      </div>
      <div className="flex items-center gap-2">
        <Button disabled={act.busy || !value.trim() || text === null} onClick={save}>{t('vendors.saveRecipe')}</Button>
        <Saved show={saved} />
      </div>
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
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorText>{list.error}</ErrorText> : !list.data?.length ? <Empty>{t('vendors.empty')}</Empty> : (
          <ul>
            {list.data.map((v) => <VendorRow key={v.key} vendor={v} categories={categories} onChange={replace} />)}
          </ul>
        )}
      </Card>
    </div>
  );
}
