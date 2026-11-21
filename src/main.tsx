import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import './index.css';
import { api, setUnauthorizedHandler } from './api.js';
import type { SettingsResponse, Summary } from './api.js';
import { AppContext, Button, ErrorText, Loading } from './components/ui.js';
import { setCloudName, t } from './i18n/he.js';
import Layout from './Layout.js';
import Attention from './pages/Attention.js';
import Backfill from './pages/Backfill.js';
import Dashboard from './pages/Dashboard.js';
import Invoices from './pages/Invoices.js';
import ItemDetail from './pages/ItemDetail.js';
import Login from './pages/Login.js';
import Missed from './pages/Missed.js';
import Settings from './pages/Settings.js';
import Setup from './pages/Setup.js';
import Vendors from './pages/Vendors.js';

/** Until setup is complete every page leads to /setup (keeping ?connected=… from an OAuth callback). */
function ToSetup() {
  const loc = useLocation();
  return <Navigate to={`/setup${loc.search}`} replace />;
}

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const refreshSummary = useCallback(async () => { try { setSummary(await api.summary(true)); } catch { /* banner keeps last value */ } }, []);
  const refreshSettings = useCallback(async () => { setSettings(await api.settings()); }, []);

  const boot = useCallback(async () => {
    setBootError(null);
    try {
      await api.me();
      const [s, sum] = await Promise.all([api.settings(), api.summary()]);
      setSettings(s); setSummary(sum); setAuthed(true);
    } catch (e) {
      if ((e as { status?: number }).status === 401) setAuthed(false);
      else setBootError((e as Error).message);
    }
  }, []);

  useEffect(() => { setUnauthorizedHandler(() => setAuthed(false)); void boot(); }, [boot]);
  useEffect(() => {
    if (!authed) return;
    const id = setInterval(() => { void refreshSummary(); }, 30_000);
    return () => clearInterval(id);
  }, [authed, refreshSummary]);

  if (bootError) {
    return (
      <div className="mx-auto max-w-md p-6">
        <ErrorText>{bootError}</ErrorText>
        <Button className="mt-3" onClick={() => void boot()}>{t('app.retry')}</Button>
      </div>
    );
  }
  if (authed === null) return <Loading />;
  if (!authed) return <Login onLoggedIn={() => void boot()} />;
  if (!settings) return <Loading />;

  // Every "{cloud}" in the Hebrew text names the chosen storage; set before the tree below renders.
  setCloudName(settings.settings.storageProvider === 'gdrive' ? t('conn.gdrive') : t('conn.dropbox'));
  const setupDone = settings.settings.setupComplete;
  const page = (el: React.ReactNode) => (setupDone ? el : <ToSetup />);

  return (
    <AppContext.Provider value={{ summary, settings, refreshSummary, refreshSettings, setSettings }}>
      <Routes>
        <Route path="/setup" element={<Setup />} />
        <Route element={<Layout onLogout={() => setAuthed(false)} />}>
          <Route index element={page(<Navigate to="/attention" replace />)} />
          <Route path="attention" element={page(<Attention />)} />
          <Route path="items/:id" element={page(<ItemDetail />)} />
          <Route path="invoices" element={page(<Invoices />)} />
          <Route path="dashboard" element={page(<Dashboard />)} />
          <Route path="backfill" element={page(<Backfill />)} />
          <Route path="vendors" element={page(<Vendors />)} />
          <Route path="missed" element={page(<Missed />)} />
          <Route path="settings" element={page(<Settings />)} />
          <Route path="*" element={page(<Navigate to="/attention" replace />)} />
        </Route>
      </Routes>
    </AppContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter><App /></BrowserRouter>
  </StrictMode>,
);
