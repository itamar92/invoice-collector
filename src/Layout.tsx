import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { api, GMAIL_SEND_SCOPE } from './api.js';
import type { SettingsResponse } from './api.js';
import { Button, CountBadge, ErrorText, fmtDateTime, useAction, useApp } from './components/ui.js';
import { t } from './i18n/he.js';
import type { MessageKey } from './i18n/he.js';

/** Which destinations/sources are not usable right now (Hebrew names), for the banner and settings. */
export function connectionProblems(s: SettingsResponse): string[] {
  const out: string[] = [];
  if (!s.secrets.gmail_refresh) out.push(t('conn.gmail'));
  if (!s.secrets.dropbox_refresh) out.push(t('conn.dropbox'));
  const m = s.settings.morning;
  const morningOk = m.mode === 'email'
    ? !!m.inboxEmail && s.settings.gmailScopes.includes(GMAIL_SEND_SCOPE)
    : m.mode !== null && s.secrets.morning_id && s.secrets.morning_secret;
  if (!morningOk) out.push(t('conn.morning'));
  return out;
}

const NAV: { to: string; key: MessageKey; count?: 'attention' | 'missedOpen' }[] = [
  { to: '/attention', key: 'nav.attention', count: 'attention' },
  { to: '/invoices', key: 'nav.invoices' },
  { to: '/backfill', key: 'nav.backfill' },
  { to: '/vendors', key: 'nav.vendors' },
  { to: '/missed', key: 'nav.missed', count: 'missedOpen' },
  { to: '/settings', key: 'nav.settings' },
];

export default function Layout({ onLogout }: { onLogout: () => void }) {
  const { summary, settings, refreshSummary } = useApp();
  const [open, setOpen] = useState(false);
  const run = useAction();
  const problems = settings ? connectionProblems(settings) : [];
  const active = !!settings?.settings.setupComplete && !!settings?.settings.backfillDone;

  const runNow = () => run.run(async () => { await api.runWorker(); await refreshSummary(); });
  const logout = async () => { try { await api.logout(); } finally { onLogout(); } };

  const nav = (
    <nav className="flex flex-col gap-1">
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} onClick={() => setOpen(false)}
          className={({ isActive }) => `flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium ${isActive ? 'bg-teal-50 text-teal-900' : 'text-slate-700 hover:bg-slate-100'}`}>
          <span>{t(n.key)}</span>
          {n.count && summary && <CountBadge n={summary[n.count]} tone={n.count === 'attention' ? 'red' : 'slate'} />}
        </NavLink>
      ))}
    </nav>
  );

  const status = (
    <div className="space-y-2 border-t border-slate-200 pt-3 text-xs text-slate-500">
      <p>{summary?.lastTickAt ? t('worker.lastRun', { when: fmtDateTime(summary.lastTickAt) }) : t('worker.neverRan')}</p>
      {!active && <p>{t('worker.notActive')}</p>}
      <Button variant="secondary" className="w-full" disabled={run.busy} onClick={runNow}>
        {run.busy ? t('worker.running') : t('worker.runNow')}
      </Button>
      <ErrorText>{run.error}</ErrorText>
      <button type="button" onClick={() => void logout()} className="text-slate-500 underline hover:text-slate-800">{t('logout')}</button>
    </div>
  );

  return (
    <div className="min-h-dvh md:flex">
      {/* phone: top bar + collapsible menu */}
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2 md:hidden">
        <Link to="/attention" className="font-bold">{t('app.name')}</Link>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
          className="flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm">
          {t('nav.menu')}
          {summary && <CountBadge n={summary.attention} />}
        </button>
      </header>
      {open && <div className="space-y-3 border-b border-slate-200 bg-white p-4 md:hidden">{nav}{status}</div>}

      {/* desktop: sidebar on the start (right) side */}
      <aside className="hidden w-60 shrink-0 flex-col gap-4 border-e border-slate-200 bg-white p-4 md:flex md:min-h-dvh">
        <Link to="/attention" className="px-3 text-lg font-bold">{t('app.name')}</Link>
        {nav}
        <div className="mt-auto">{status}</div>
      </aside>

      <main className="min-w-0 flex-1 p-4 md:p-6">
        <div className="mx-auto max-w-5xl space-y-3">
          {summary?.lastTickError && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
              {t('banner.tickError', { error: summary.lastTickError })}
            </div>
          )}
          {problems.length > 0 && (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <span>{t('banner.disconnected', { names: problems.join(', ') })}</span>
              <Link to="/settings" className="font-medium underline">{t('banner.fix')}</Link>
            </div>
          )}
          <Outlet />
        </div>
      </main>
    </div>
  );
}
