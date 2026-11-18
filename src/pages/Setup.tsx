import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { AiSection, CategoriesSection, ConnectionsSection, LabelSection } from '../components/SettingsSections.js';
import { Button, Card, ErrorText, Notice, useAction, useApp } from '../components/ui.js';
import { t } from '../i18n/he.js';
import type { MessageKey } from '../i18n/he.js';

const STEPS: MessageKey[] = ['setup.s1', 'setup.s2', 'setup.s3', 'setup.s4', 'setup.s5'];
const STEP_KEY = 'ic.setupStep';

function readStep(): number {
  try { const n = Number(sessionStorage.getItem(STEP_KEY)); return n >= 0 && n < STEPS.length ? n : 0; } catch { return 0; }
}

/**
 * Step 5 (spec §4.5, §4.13): starts the backfill, which runs in the background on the server (202), so setup is
 * marked complete right away and the Backfill page shows progress. Nothing from it is ever sent to Morning.
 */
function StartBackfill({ onStarted }: { onStarted: () => void }) {
  const { settings, setSettings } = useApp();
  const a = useAction();
  const st = settings!.settings;
  const connected = settings!.secrets.gmail_refresh && settings!.secrets.dropbox_refresh;
  const alreadyStarted = !!st.backfillStartedAt && !st.backfillError; // a failed run may be started again

  const start = () => a.run(async () => {
    await api.startBackfill();
    setSettings(await api.saveSettings({ setupComplete: true }));
    onStarted();
  });
  const finishSetup = () => a.run(async () => {
    if (!st.setupComplete) setSettings(await api.saveSettings({ setupComplete: true }));
    onStarted();
  });

  return (
    <div className="space-y-3">
      <p className="text-sm">{t('start.intro')}</p>
      <Notice tone="ok">{t('start.noMorning')}</Notice>
      <p className="text-sm text-slate-600">{t('start.cost')}</p>
      <Notice tone="warn">{t('start.n8n')}</Notice>
      {!connected && <Notice tone="warn">{t('backfill.notConnected')}</Notice>}
      {st.backfillError && <Notice tone="warn">{t('backfill.runError', { error: st.backfillError })}</Notice>}
      {st.backfillDone || alreadyStarted
        ? (
          <div className="space-y-2">
            <Notice>{st.backfillDone ? t('backfill.done') : t('start.already')}</Notice>
            <Button disabled={a.busy} onClick={finishSetup}>{t('start.toList')}</Button>
          </div>
        )
        : <Button disabled={a.busy || !connected} onClick={start}>{a.busy ? t('start.running') : t('start.run')}</Button>}
      <ErrorText>{a.error}</ErrorText>
    </div>
  );
}

export default function Setup() {
  const [step, setStepState] = useState(readStep);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { refreshSettings } = useApp();
  const connected = params.get('connected');

  const setStep = (n: number) => {
    setStepState(n);
    try { sessionStorage.setItem(STEP_KEY, String(n)); } catch { /* private mode: step resets on reload */ }
    window.scrollTo({ top: 0 });
  };

  // Back from an OAuth callback (/settings?connected=…, redirected here while setup is open): refresh status.
  useEffect(() => {
    if (!connected) return;
    void refreshSettings();
    setStep(0);
  }, [connected]);

  const body = [
    <ConnectionsSection key="c" />, <AiSection key="a" />, <LabelSection key="l" />, <CategoriesSection key="k" />,
    <StartBackfill key="b" onStarted={() => { try { sessionStorage.removeItem(STEP_KEY); } catch { /* ignore */ } navigate('/backfill'); }} />,
  ][step];

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-8">
      <header>
        <h1 className="text-2xl font-bold">{t('setup.title')}</h1>
        <p className="text-sm text-slate-600">{t('setup.intro')}</p>
      </header>

      <ol className="grid grid-cols-5 gap-1 text-center text-xs">
        {STEPS.map((k, i) => (
          <li key={k}>
            <button type="button" onClick={() => setStep(i)}
              className={`w-full rounded-lg px-1 py-2 ${i === step ? 'bg-teal-700 text-white' : i < step ? 'bg-teal-50 text-teal-900' : 'bg-white text-slate-500'} border border-slate-200`}>
              <span className="block font-bold">{i + 1}</span>
              <span className="hidden sm:block">{t(k)}</span>
            </button>
          </li>
        ))}
      </ol>

      {connected && (
        <Notice tone="ok">
          {t('setup.connectedToast', { name: connected === 'google' ? t('conn.gmail') : t('conn.dropbox') })}{' '}
          <button type="button" className="underline" onClick={() => setParams({})}>✕</button>
        </Notice>
      )}

      <Card title={`${t('setup.step', { n: step + 1 })} · ${t(STEPS[step])}`}>{body}</Card>

      <div className="flex justify-between">
        <Button variant="secondary" disabled={step === 0} onClick={() => setStep(step - 1)}>{t('common.back')}</Button>
        {step < STEPS.length - 1 && <Button onClick={() => setStep(step + 1)}>{t('common.next')}</Button>}
      </div>
    </div>
  );
}
