import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigationType } from 'react-router-dom';
import { api, GMAIL_SEND_SCOPE, storageConnected } from './api.js';
import type { SettingsResponse } from './api.js';
import { AiThinking, Button, CountBadge, ErrorText, fmtDateTime, Icon, LoadingBar, Notice, takeFlash, useAction, useApp } from './components/ui.js';
import { useUploadReceipt } from './components/UploadReceipt.js';
import { InstallBanner, useInstallApp } from './components/InstallApp.js';
import type { IconName } from './components/ui.js';
import { t } from './i18n/he.js';
import type { MessageKey } from './i18n/he.js';

/** Which destinations/sources are not usable right now (Hebrew names), for the banner and settings. */
export function connectionProblems(s: SettingsResponse): string[] {
  const out: string[] = [];
  if (!s.secrets.gmail_refresh) out.push(t('conn.gmail'));
  if (!storageConnected(s)) out.push(t(s.settings.storageProvider === 'gdrive' ? 'conn.gdrive' : 'conn.dropbox'));
  const m = s.settings.morning;
  const morningOk = m.mode === 'email'
    ? !!m.inboxEmail && s.settings.gmailScopes.includes(GMAIL_SEND_SCOPE)
    : m.mode !== null && s.secrets.morning_id && s.secrets.morning_secret;
  if (!morningOk) out.push(t('conn.morning'));
  return out;
}

/** The `?connected=` value an OAuth callback sends back, as the service's name. */
export function connectedName(connected: string): string {
  return connected === 'google' ? t('conn.gmail') : connected === 'gdrive' ? t('conn.gdrive') : t('conn.dropbox');
}

type NavItem = { to: string; key: MessageKey; icon: IconName; count?: 'attention' | 'missedOpen' };
const NAV: NavItem[] = [
  { to: '/attention', key: 'nav.attention', icon: 'inbox', count: 'attention' },
  { to: '/invoices', key: 'nav.invoices', icon: 'list' },
  { to: '/dashboard', key: 'nav.dashboard', icon: 'chart' },
  { to: '/missed', key: 'nav.missed', icon: 'mail', count: 'missedOpen' },
  { to: '/vendors', key: 'nav.vendors', icon: 'vendor' },
  { to: '/backfill', key: 'nav.backfill', icon: 'import' },
  { to: '/settings', key: 'nav.settings', icon: 'settings' },
];
/** Phone: the first four are tabs; the rest live behind the menu tab. */
const TABS = NAV.slice(0, 4);
const MORE = NAV.slice(4);

/** Scroll position per history entry, so Back lands where the user was (lists load async, so it retries). */
const scrollAt = new Map<string, number>();

function useScrollMemory(): void {
  const loc = useLocation();
  const nav = useNavigationType();
  const key = useRef(loc.key);
  useEffect(() => {
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
    const save = () => { scrollAt.set(key.current, window.scrollY); };
    window.addEventListener('scroll', save, { passive: true });
    return () => window.removeEventListener('scroll', save);
  }, []);
  // Layout effect: the key must switch before the browser reports the scroll the new page causes.
  useLayoutEffect(() => {
    key.current = loc.key;
    const target = nav === 'POP' ? scrollAt.get(loc.key) : undefined;
    if (target === undefined) { if (nav === 'PUSH' && !loc.hash) window.scrollTo(0, 0); return; }
    let tries = 0;
    let frame = 0;
    const tryRestore = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, Math.min(target, Math.max(0, max)));
      if (max < target && tries++ < 90) frame = requestAnimationFrame(tryRestore); // page still loading
    };
    tryRestore();
    // The user scrolling meanwhile wins over the restore.
    const stop = () => cancelAnimationFrame(frame);
    window.addEventListener('wheel', stop, { once: true, passive: true });
    window.addEventListener('touchmove', stop, { once: true, passive: true });
    return () => { stop(); window.removeEventListener('wheel', stop); window.removeEventListener('touchmove', stop); };
  }, [loc.key]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function Brand({ className = '' }: { className?: string }) {
  return (
    <span className={`flex items-center gap-2 ${className}`}>
      <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-accent text-white"><Icon name="list" /></span>
      <span className="display text-xl">{t('app.name')}</span>
    </span>
  );
}

export default function Layout({ onLogout }: { onLogout: () => void }) {
  const { summary, settings, refreshSummary } = useApp();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const run = useAction();
  const upload = useUploadReceipt();
  const install = useInstallApp();
  const problems = settings ? connectionProblems(settings) : [];
  const active = !!settings?.settings.setupComplete && !!settings?.settings.backfillDone;
  const inMore = MORE.some((n) => loc.pathname.startsWith(n.to));

  useEffect(() => { setOpen(false); }, [loc.pathname]);
  useScrollMemory();
  // A note left by the page we came from (e.g. a document just approved), shown once here.
  const [flash, setFlashNote] = useState<string | null>(null);
  useEffect(() => {
    const m = takeFlash();
    setFlashNote(m);
    if (!m) return;
    const id = setTimeout(() => setFlashNote(null), 6000);
    return () => clearTimeout(id);
  }, [loc.key]);

  const runNow = () => run.run(async () => { await api.runWorker(); await refreshSummary(); });
  const logout = async () => { try { await api.logout(); } finally { onLogout(); } };
  const lastRun = summary?.lastTickAt ? t('worker.lastRun', { when: fmtDateTime(summary.lastTickAt) }) : t('worker.neverRan');
  const count = (n: NavItem) => (n.count && summary ? summary[n.count] : 0);

  const tab = (on: boolean, icon: IconName, label: string, n = 0, tone: 'red' | 'slate' = 'red') => (
    <>
      <span className={`relative grid h-7 w-14 place-items-center rounded-full transition-colors ${on ? 'bg-accent-tint text-accent-deep' : 'text-muted'}`}>
        <Icon name={icon} />
        {n > 0 && <span className="absolute -top-1.5 start-9"><CountBadge n={n} tone={tone} /></span>}
      </span>
      <span className={`text-[11px] leading-tight ${on ? 'font-semibold text-accent-deep' : 'font-medium text-muted'}`}>{label}</span>
    </>
  );
  const tabCls = 'flex min-h-16 flex-col items-center justify-center gap-1 px-1 text-center';

  return (
    <div className="min-h-dvh md:flex">
      <LoadingBar />
      {/* phone: top bar with the worker status */}
      <header className="sticky top-0 z-20 border-b border-line bg-ground md:hidden">
        <div className="flex items-center justify-between gap-2 px-4 py-2">
          <Link to="/attention" className="min-w-0">
            <Brand />
          </Link>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="secondary" className="bg-white px-3 shadow-soft" loading={run.busy} onClick={runNow}>
              {run.busy ? t('worker.running') : t('worker.runNow')}
            </Button>
            <Button className="w-11 px-0 shadow-soft" loading={upload.busy} onClick={upload.pick} aria-label={t('upload.button')} title={t('upload.button')}>
              {upload.busy ? <span className="ai-dots"><span /><span /><span /></span> : <Icon name="camera" />}
            </Button>
          </div>
        </div>
      </header>
      {upload.input}
      {install.sheet}

      {/* desktop: rail on the start (right) side */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-e border-line p-4 md:flex">
        <Link to="/attention" className="px-2 pb-5 pt-2"><Brand /></Link>
        <nav className="flex flex-col gap-1">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to}
              className={({ isActive }) => `flex min-h-10 items-center gap-2.5 rounded-xl px-3 text-[15px] transition-colors ${isActive ? 'bg-white font-semibold text-accent-deep shadow-soft' : 'font-medium hover:bg-ground-deep'}`}>
              <Icon name={n.icon} />
              <span className="flex-1">{t(n.key)}</span>
              <CountBadge n={count(n)} tone={n.count === 'attention' ? 'red' : 'slate'} />
            </NavLink>
          ))}
        </nav>
        <Button className="mx-2 mt-4 shadow-soft" loading={upload.busy} onClick={upload.pick}>
          {!upload.busy && <Icon name="camera" />}{upload.busy ? t('upload.busyShort') : t('upload.button')}
        </Button>
        {install.available && (
          <button type="button" onClick={() => void install.install()}
            className="mx-2 mt-2 flex min-h-10 items-center justify-center gap-1.5 rounded-xl text-sm font-semibold text-accent hover:bg-accent-tint">
            <Icon name="addHome" />{t('install.menu')}
          </button>
        )}
        <div className="mt-auto space-y-2 px-2 text-xs text-muted">
          <p>{lastRun}</p>
          {!active && <p>{t('worker.notActive')}</p>}
          <Button variant="secondary" className="w-full bg-white shadow-soft" loading={run.busy} onClick={runNow}>
            {run.busy ? t('worker.running') : t('worker.runNow')}
          </Button>
          <button type="button" onClick={() => void logout()} className="min-h-8 font-medium text-ink underline">{t('logout')}</button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-4 pb-28 pt-4 md:p-8">
        <div className="mx-auto max-w-4xl space-y-4">
          <p className="text-xs text-muted md:hidden">{lastRun}</p>
          <div className="md:hidden"><InstallBanner install={install} /></div>
          <ErrorText>{run.error}</ErrorText>
          {flash && <div role="status" className="sticky top-16 z-20 md:top-4"><Notice tone="ok">{flash}</Notice></div>}
          {upload.busy && <div className="sticky top-16 z-20 md:top-4"><AiThinking title={t('upload.busy')} hint={t('upload.busyHint')} /></div>}
          <ErrorText>{upload.error}</ErrorText>
          {summary?.lastTickError && <ErrorText>{t('banner.tickError', { error: summary.lastTickError })}</ErrorText>}
          {problems.length > 0 && (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-warn-tint px-3 py-2 text-sm">
              <span>{t('banner.disconnected', { names: problems.join(', ') })}</span>
              <Link to="/settings" className="font-semibold text-accent-deep underline">{t('banner.fix')}</Link>
            </div>
          )}
          <Outlet />
        </div>
      </main>

      {/* phone: the rest of the navigation, as a sheet above the tab bar */}
      {open && (
        <>
          <button type="button" aria-label={t('common.cancel')} className="fixed inset-0 z-20 bg-ink/30 md:hidden" onClick={() => setOpen(false)} />
          <div id="more-menu" className="fixed inset-x-3 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-30 rounded-2xl bg-white p-2 shadow-soft md:hidden">
            {MORE.map((n) => (
              <NavLink key={n.to} to={n.to}
                className={({ isActive }) => `flex min-h-12 items-center gap-3 rounded-xl px-3 font-medium ${isActive ? 'bg-accent-tint text-accent-deep' : ''}`}>
                <Icon name={n.icon} />{t(n.key)}
              </NavLink>
            ))}
            {install.available && (
              <button type="button" onClick={() => { setOpen(false); void install.install(); }} className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 font-medium">
                <Icon name="addHome" />{t('install.menu')}
              </button>
            )}
            <button type="button" onClick={() => void logout()} className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 font-medium">
              <Icon name="out" />{t('logout')}
            </button>
            {!active && <p className="px-3 py-2 text-xs text-muted">{t('worker.notActive')}</p>}
          </div>
        </>
      )}

      {/* phone: bottom tab bar, within thumb reach */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 rounded-t-3xl bg-white px-1 pb-[env(safe-area-inset-bottom)] shadow-bar md:hidden">
        {TABS.map((n) => (
          <NavLink key={n.to} to={n.to} className={tabCls}>
            {({ isActive }) => tab(isActive && !open, n.icon, t(n.key), count(n), n.count === 'attention' ? 'red' : 'slate')}
          </NavLink>
        ))}
        <button type="button" aria-expanded={open} aria-controls="more-menu" onClick={() => setOpen(!open)} className={tabCls}>
          {tab(open || inMore, open ? 'close' : 'menu', t('nav.menu'))}
        </button>
      </nav>
    </div>
  );
}
