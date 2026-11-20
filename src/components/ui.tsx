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

// ---------- one-shot message for the next page ----------
/** A note shown once on the page the user lands on next (e.g. "saved" after leaving a document). */
let flash: string | null = null;
export function setFlash(msg: string | null): void { flash = msg; }
export function takeFlash(): string | null { const m = flash; flash = null; return m; }

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
const BTN = 'inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl px-4 text-sm font-semibold transition-[background-color,transform] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-deep',
  secondary: 'bg-ground-deep text-ink hover:bg-line-strong',
  danger: 'bg-alert-tint text-alert-deep hover:bg-alert hover:text-white',
  ghost: 'px-2 text-accent hover:bg-accent-tint',
};
export function Button({ variant = 'primary', className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button type="button" {...p} className={`${BTN} ${VARIANTS[variant]} ${className}`} />;
}
export function ButtonLink({ to, children, variant = 'secondary' }: { to: string; children: ReactNode; variant?: Variant }) {
  return <Link to={to} className={`${BTN} ${VARIANTS[variant]}`}>{children}</Link>;
}

// ---------- icons: one 20px grid, 1.75 stroke, round joins ----------
const ICONS = {
  inbox: <><path d="M3.5 11.5 5.5 4.5h9l2 7v3a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" /><path d="M3.5 11.5h3.5l1 2h4l1-2h3.5" /></>,
  list: <><path d="M6 3.5h8a1 1 0 0 1 1 1v12l-2.5-1.5L10 16.5 7.5 15 5 16.5v-12a1 1 0 0 1 1-1z" /><path d="M8 7.5h4M8 10.5h4" /></>,
  vendor: <><path d="M3.5 8 5 4h10l1.5 4" /><path d="M4.5 8.5V16h11V8.5" /><path d="M3.5 8a2.2 2.2 0 0 0 4.3 0 2.2 2.2 0 0 0 4.4 0 2.2 2.2 0 0 0 4.3 0" /><path d="M8.5 16v-3.5h3V16" /></>,
  mail: <><rect x="3" y="4.5" width="14" height="11" rx="2" /><path d="m4 6.5 6 4.5 6-4.5" /></>,
  menu: <path d="M4 6h12M4 10h12M4 14h12" />,
  chart: <path d="M4.5 16v-5M10 16V4.5M15.5 16V8.5" strokeWidth="2.5" />,
  import: <><path d="M10 3.5v8M6.5 8.5 10 12l3.5-3.5" /><path d="M4 13.5v2a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2" /></>,
  settings: <><path d="M4 6h5M13 6h3M4 14h3M11 14h5" /><circle cx="11" cy="6" r="2" /><circle cx="9" cy="14" r="2" /></>,
  check: <path d="m4.5 10.5 3.5 3.5 7.5-8" />,
  close: <path d="m5.5 5.5 9 9M14.5 5.5l-9 9" />,
  alert: <><circle cx="10" cy="10" r="7" /><path d="M10 6.5v4" /><circle cx="10" cy="13.4" r="0.6" fill="currentColor" /></>,
  down: <path d="m5.5 8 4.5 4.5L14.5 8" />,
  up: <path d="m5.5 12 4.5-4.5 4.5 4.5" />,
  out: <><path d="M8.5 5H15v6.5" /><path d="M15 5 6 14" /></>,
  back: <path d="M4 10h12M11.5 5.5 16 10l-4.5 4.5" />,
  folder: <path d="M3.5 6a1 1 0 0 1 1-1h3.6l1.6 1.8h5.8a1 1 0 0 1 1 1V14.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />,
  camera: <><path d="M3.5 7.5a1 1 0 0 1 1-1h2l1.2-2h4.6l1.2 2h2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" /><circle cx="10" cy="10.8" r="2.6" /></>,
  share: <><path d="M10 3v9M6.5 6.5 10 3l3.5 3.5" /><path d="M7 9H5.5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1H13" /></>,
  addHome: <><rect x="3.5" y="3.5" width="13" height="13" rx="3" /><path d="M10 7v6M7 10h6" /></>,
} as const;
export type IconName = keyof typeof ICONS;
export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true" className={`shrink-0 ${className}`}>{ICONS[name]}</svg>
  );
}

/** A vendor's initial on a soft tile. The tint is picked from the name, so a vendor keeps its colour everywhere. */
const TILES = ['bg-warn-tint text-warn-deep', 'bg-alert-tint text-alert-deep', 'bg-info-tint text-info-deep', 'bg-ok-tint text-accent-deep', 'bg-lilac-tint text-lilac-deep'];
export function Avatar({ name }: { name: string }) {
  const clean = name.trim();
  let h = 0;
  for (const ch of clean) h = (h * 31 + ch.codePointAt(0)!) % 997;
  return (
    <span aria-hidden="true" className={`display grid size-9 shrink-0 place-items-center rounded-xl text-base ${TILES[h % TILES.length]}`}>
      {[...clean][0]?.toUpperCase() ?? '·'}
    </span>
  );
}

// ---------- sections ----------
/** A white rounded panel with an optional heading row. */
export function Card({ title, children, actions, className = '', id }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={`panel ${className}`}>
      {(title || actions) && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="display text-lg">{title}</h2>}
          {actions && <div className="ms-auto flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h1 className="display text-[26px] md:text-3xl">{children}</h1>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

// ---------- states: a dot and a label. Filled dot = settled, ring = still on its way. ----------
const DOT: Record<ItemState, string> = {
  needs_attention: 'bg-alert', awaiting_vendor: 'bg-warn', waiting_ai: 'border-2 border-warn',
  queued: 'border-2 border-info', awaiting_backfill_approval: 'bg-info', ready: 'bg-info',
  stored: 'border-2 border-ok', done: 'bg-ok',
  ignored: 'border-2 border-idle', dismissed: 'bg-idle',
};
export function Dot({ className }: { className: string }) {
  return <span aria-hidden="true" className={`inline-block size-2.5 shrink-0 rounded-full ${className}`} />;
}
export function StateBadge({ state }: { state: ItemState }) {
  return (
    <span className="inline-flex items-center gap-1.5 align-middle text-[13px] text-muted">
      <Dot className={DOT[state]} />{stateLabel(state)}
    </span>
  );
}
export function CountBadge({ n, tone = 'red' }: { n: number; tone?: 'red' | 'slate' }) {
  if (!n) return null;
  return (
    <span className={`inline-grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-xs font-semibold leading-none ${tone === 'red' ? 'bg-alert text-white' : 'bg-ground-deep text-ink'}`}>
      <span className="num">{n}</span>
    </span>
  );
}
export function Check({ ok, labels = [t('common.configured'), t('common.notConfigured')] }: { ok: boolean; labels?: [string, string] }) {
  return ok
    ? <span className="inline-flex items-center gap-1 text-[13px] font-medium text-accent-deep"><Icon name="check" className="size-4" />{labels[0]}</span>
    : <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-alert-deep"><Dot className="bg-alert" />{labels[1]}</span>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="mt-2 flex gap-2 rounded-xl bg-alert-tint px-3 py-2 text-sm text-alert-deep">
      <Icon name="alert" className="mt-px" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </p>
  );
}
const NOTICE = { info: 'bg-info-tint', ok: 'bg-ok-tint', warn: 'bg-warn-tint' } as const;
export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'ok' | 'warn' }) {
  return <p className={`rounded-xl px-3 py-2 text-sm ${NOTICE[tone]}`}>{children}</p>;
}
/** A small inline flag on a row (e.g. likely duplicate). */
export function Flag({ children }: { children: ReactNode }) {
  return <span className="inline-block rounded-md bg-warn-tint px-1.5 py-0.5 text-xs font-semibold text-warn-deep">{children}</span>;
}
export function Saved({ show }: { show: boolean }) {
  if (!show) return null;
  return <span className="inline-flex items-center gap-1 text-sm font-medium text-accent-deep"><Icon name="check" className="size-4" />{t('common.saved')}</span>;
}
export function Loading() { return <p className="py-4 text-sm text-muted">{t('app.loading')}</p>; }
export function Empty({ children }: { children?: ReactNode }) {
  return <p className="py-8 text-center text-sm text-muted">{children ?? t('common.empty')}</p>;
}

export function Field({ label, hint, children, className = '' }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-[13px] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}
export const inputCls = 'w-full min-h-10 rounded-xl border border-line-strong bg-white px-3 py-1.5 text-base sm:text-sm placeholder:text-muted/80 transition-shadow focus:border-accent focus:outline-none focus:ring-4 focus:ring-accent/15 disabled:border-line disabled:bg-ground disabled:text-ink';
export const hintCls = 'text-xs text-muted';

/**
 * A write-only secret: shows configured or not only, never a value. Saving sends the typed value and clears the box.
 */
export function SecretInput({ label, configured, onSave, multiline }: {
  label: string; configured: boolean; onSave: (v: string) => Promise<void>; multiline?: boolean;
}) {
  const [v, setV] = useState('');
  const a = useAction();
  const save = () => a.run(async () => { await onSave(v.trim()); setV(''); });
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-muted">{label}</span>
        <Check ok={configured} />
      </div>
      <div className="flex gap-2">
        {multiline
          ? <textarea aria-label={label} className={`${inputCls} ltr h-20 font-mono text-xs`} value={v} onChange={(e) => setV(e.target.value)} autoComplete="off" spellCheck={false} />
          : <input aria-label={label} type="password" className={`${inputCls} ltr`} value={v} onChange={(e) => setV(e.target.value)} autoComplete="new-password" />}
        <Button variant="secondary" disabled={!v.trim() || a.busy} onClick={save}>{a.busy ? t('common.saving') : t('common.save')}</Button>
      </div>
      <p className={hintCls}>{t('common.writeOnlyHint')}</p>
      <ErrorText>{a.error}</ErrorText>
    </div>
  );
}

/** Thin rule between rows; the last row in a list has none. */
export const rowCls = 'border-b border-line last:border-b-0';
/** Horizontal scroll for the few true tables (settings categories). */
export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="-mx-4 overflow-x-auto px-4"><table className="w-full min-w-[32rem] text-sm">{children}</table></div>;
}
export const th = 'px-1.5 py-1.5 text-start text-xs font-medium text-muted';
export const td = 'border-t border-line px-1.5 py-1.5 align-middle';
