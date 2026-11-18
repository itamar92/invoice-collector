import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api.js';
import type { Item, ItemState, SettingsResponse, Summary } from '../api.js';
import { t, tDyn } from '../i18n/he.js';

// ---------- app-wide state ----------
export interface AppState {
  summary: Summary | null;
  settings: SettingsResponse | null;
  refreshSummary: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  setSettings: (s: SettingsResponse) => void;
}
export const AppContext = createContext<AppState | null>(null);
export function useApp(): AppState {
  const v = useContext(AppContext);
  if (!v) throw new Error('useApp outside AppContext');
  return v;
}

// ---------- data loading ----------
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await fn()); setError(null); setCode(null); } catch (e) {
      setError((e as Error).message); setCode(e instanceof ApiError ? e.code : null);
    } finally { setLoading(false); }
  }, deps);
  useEffect(() => { void reload(); }, [reload]);
  /** `code` is the API error code (e.g. not_connected) for pages that explain it. */
  return { data, error, code, loading, reload, setData };
}

/** Wraps an action: tracks busy state and turns a thrown error into a Hebrew message. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError(null);
    try { return await fn(); } catch (e) { setError((e as Error).message); return undefined; } finally { setBusy(false); }
  }, []);
  return { busy, error, setError, run };
}

// ---------- formatting ----------
const dateFmt = new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateFmt.format(d);
}
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateTimeFmt.format(d);
}
export function fmtMoney(n: number | null | undefined, currency: string | null | undefined): string {
  if (n == null) return '—';
  try {
    return new Intl.NumberFormat('he-IL', { style: 'currency', currency: currency || 'ILS', maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${n} ${currency ?? ''}`.trim();
  }
}
export const stateLabel = (s: string) => tDyn(`state.${s}`, 'common.none');
export const reasonLabel = (r: string | null) => (r ? tDyn(`reason.${r}`, 'error.generic') : '');
export const itemTitle = (i: Item) => i.fields?.vendorName || i.attachmentName || t('item.title');

// ---------- primitives ----------
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-teal-700 text-white hover:bg-teal-800 disabled:bg-teal-700/50',
  secondary: 'bg-white text-slate-800 border border-slate-300 hover:bg-slate-100 disabled:text-slate-400',
  danger: 'bg-white text-red-700 border border-red-300 hover:bg-red-50 disabled:text-red-300',
  ghost: 'text-teal-800 hover:bg-teal-50 disabled:text-slate-400',
};
export function Button({ variant = 'primary', className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button type="button" {...p}
      className={`inline-flex items-center justify-center gap-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed min-h-10 ${VARIANTS[variant]} ${className}`} />
  );
}
export function ButtonLink({ to, children, variant = 'secondary' }: { to: string; children: ReactNode; variant?: Variant }) {
  return <Link to={to} className={`inline-flex items-center rounded-lg px-3 py-2 text-sm font-medium min-h-10 ${VARIANTS[variant]}`}>{children}</Link>;
}

export function Card({ title, children, actions, className = '' }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white p-4 shadow-sm ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-xl font-bold">{children}</h1>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

const STATE_TONE: Record<ItemState, string> = {
  queued: 'bg-slate-100 text-slate-700', waiting_ai: 'bg-amber-100 text-amber-800',
  needs_attention: 'bg-red-100 text-red-800', awaiting_vendor: 'bg-amber-100 text-amber-800',
  awaiting_backfill_approval: 'bg-sky-100 text-sky-800', ready: 'bg-sky-100 text-sky-800',
  stored: 'bg-teal-100 text-teal-800', done: 'bg-green-100 text-green-800',
  ignored: 'bg-slate-100 text-slate-500', dismissed: 'bg-slate-100 text-slate-500',
};
export function StateBadge({ state }: { state: ItemState }) {
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATE_TONE[state]}`}>{stateLabel(state)}</span>;
}
export function CountBadge({ n, tone = 'red' }: { n: number; tone?: 'red' | 'slate' }) {
  if (!n) return null;
  return <span className={`min-w-6 rounded-full px-1.5 text-center text-xs font-bold leading-6 ${tone === 'red' ? 'bg-red-600 text-white' : 'bg-slate-200 text-slate-700'}`}>{n}</span>;
}
export function Check({ ok, labels = [t('common.configured'), t('common.notConfigured')] }: { ok: boolean; labels?: [string, string] }) {
  return ok
    ? <span className="text-sm font-medium text-green-700">✓ {labels[0]}</span>
    : <span className="text-sm font-medium text-red-700">✗ {labels[1]}</span>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{children}</p>;
}
export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'ok' | 'warn' }) {
  const c = tone === 'ok' ? 'bg-green-50 text-green-900' : tone === 'warn' ? 'bg-amber-50 text-amber-900' : 'bg-sky-50 text-sky-900';
  return <p className={`rounded-lg px-3 py-2 text-sm ${c}`}>{children}</p>;
}
export function Loading() { return <p className="p-4 text-slate-500">{t('app.loading')}</p>; }
export function Empty({ children }: { children?: ReactNode }) {
  return <p className="py-6 text-center text-sm text-slate-500">{children ?? t('common.empty')}</p>;
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}
export const inputCls = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base sm:text-sm focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20 disabled:bg-slate-100';

/**
 * A write-only secret: shows configured ✓/✗ only, never a value. Saving sends the typed value and clears the box.
 */
export function SecretInput({ label, configured, onSave, multiline }: {
  label: string; configured: boolean; onSave: (v: string) => Promise<void>; multiline?: boolean;
}) {
  const [v, setV] = useState('');
  const a = useAction();
  const save = () => a.run(async () => { await onSave(v.trim()); setV(''); });
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-medium text-slate-700">{label}</span>
        <Check ok={configured} />
      </div>
      <div className="flex gap-2">
        {multiline
          ? <textarea className={`${inputCls} ltr h-20 font-mono text-xs`} value={v} onChange={(e) => setV(e.target.value)} autoComplete="off" spellCheck={false} />
          : <input type="password" className={`${inputCls} ltr`} value={v} onChange={(e) => setV(e.target.value)} autoComplete="new-password" />}
        <Button variant="secondary" disabled={!v.trim() || a.busy} onClick={save}>{a.busy ? t('common.saving') : t('common.save')}</Button>
      </div>
      <p className="text-xs text-slate-500">{t('common.writeOnlyHint')}</p>
      <ErrorText>{a.error}</ErrorText>
    </div>
  );
}

/** Horizontal scroll for wide tables on phones. */
export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="-mx-4 overflow-x-auto px-4"><table className="w-full min-w-[36rem] text-sm">{children}</table></div>;
}
export const th = 'border-b border-slate-200 px-2 py-2 text-start font-medium text-slate-500';
export const td = 'border-b border-slate-100 px-2 py-2 align-top';
