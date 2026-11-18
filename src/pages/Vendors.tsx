import { useState } from 'react';
import { api } from '../api.js';
import type { RecipeVersion, Vendor, VendorStatus } from '../api.js';
import {
  Button, Card, Empty, ErrorText, fmtDateTime, inputCls, Loading, Notice, PageTitle, useAction, useApp, useLoad,
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
    <div className="space-y-3 border-t border-slate-100 pt-3">
      {latest
        ? (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 h-5 w-5" checked={!!latest.recipe.aiAlways} disabled={act.busy} onChange={(e) => toggleAi(e.target.checked)} />
            <span><span className="font-medium">{t('vendors.aiAlways')}</span><span className="block text-xs text-slate-500">{t('vendors.aiAlwaysHint')}</span></span>
          </label>
        )
        : <p className="text-sm text-slate-500">{t('vendors.noRecipe')}</p>}
      <div>
        <p className="mb-1 text-xs text-slate-500">{t('vendors.recipeHint')}</p>
        <textarea className={`${inputCls} ltr h-64 font-mono text-xs`} spellCheck={false} value={value}
          onChange={(e) => { setText(e.target.value); setSaved(false); }} />
      </div>
      <div className="flex items-center gap-2">
        <Button disabled={act.busy || !value.trim() || text === null} onClick={save}>{t('vendors.saveRecipe')}</Button>
        {saved && <span className="text-sm text-green-700">{t('common.saved')}</span>}
      </div>
      <ErrorText>{act.error}</ErrorText>
      {versions.length > 0 && (
        <div>
          <h4 className="mb-1 text-sm font-medium">{t('vendors.history')}</h4>
          <ul className="divide-y divide-slate-100 text-sm">
            {versions.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
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
    <li className="py-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-40">
          <div className="font-medium">{vendor.displayName}</div>
          <bdi className="ltr text-xs text-slate-500">{vendor.key}</bdi>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs">
            <span className="mb-0.5 block text-slate-500">{t('vendors.status')}</span>
            <select className={`${inputCls} w-36`} value={vendor.status} disabled={act.busy} onChange={(e) => update({ status: e.target.value as VendorStatus })}>
              {STATUSES.map((s) => <option key={s} value={s}>{t(`vendorStatus.${s}` as MessageKey)}</option>)}
            </select>
          </label>
          <label className="text-xs">
            <span className="mb-0.5 block text-slate-500">{t('vendors.defaultCategory')}</span>
            <select className={`${inputCls} w-44`} value={vendor.defaultCategory ?? ''} disabled={act.busy}
              onChange={(e) => update({ defaultCategory: e.target.value || null })}>
              <option value="">{t('field.choose')}</option>
              {[...new Set([...categories, ...(vendor.defaultCategory ? [vendor.defaultCategory] : [])])].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <Button variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{t('vendors.edit')} {open ? '▴' : '▾'}</Button>
        </div>
      </div>
      {pending && <p className="mt-1 text-xs text-amber-800">{t('vendors.pending')}</p>}
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
      <Notice>{t('vendorStatus.businessHint')} · {t('vendorStatus.personalHint')} · {t('vendorStatus.ignoredHint')}</Notice>
      <Card>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorText>{list.error}</ErrorText> : !list.data?.length ? <Empty>{t('vendors.empty')}</Empty> : (
          <ul className="divide-y divide-slate-100">
            {list.data.map((v) => <VendorRow key={v.key} vendor={v} categories={categories} onChange={replace} />)}
          </ul>
        )}
      </Card>
    </div>
  );
}
