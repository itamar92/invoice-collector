import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { AiSection, CategoriesSection, ConnectionsSection, LabelSection } from '../components/SettingsSections.js';
import { Button, Card, ErrorText, Icon, Notice, useAction, useApp } from '../components/ui.js';
import { t } from '../i18n/he.js';
import { Brand } from '../Layout.js';
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
      <p className="text-sm text-muted">{t('start.cost')}</p>
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

  const leg = (done: boolean) => <span aria-hidden="true" className={`mt-4 h-0.5 min-w-2 flex-1 rounded-full ${done ? 'bg-accent' : 'bg-line-strong'}`} />;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-8">
      <header className="space-y-2">
        <Brand />
        <h1 className="display text-[26px] md:text-3xl">{t('setup.title')}</h1>
        <p className="text-sm text-muted">{t('setup.intro')}</p>
      </header>

      <ol className="flex items-start">
        {STEPS.map((k, i) => (
          <li key={k} className="contents">
            {i > 0 && leg(i <= step)}
            <button type="button" aria-current={i === step ? 'step' : undefined} aria-label={t(k)} onClick={() => setStep(i)}
              className="flex w-10 flex-col items-center gap-1 sm:w-24">
              <span className={`display grid size-8 place-items-center rounded-full text-[15px] transition-colors ${i === step ? 'bg-accent text-white' : i < step ? 'bg-accent-tint text-accent-deep' : 'bg-ground-deep text-muted'}`}>
                {i < step ? <Icon name="check" className="size-4" /> : i + 1}
              </span>
              <span className={`hidden text-center text-xs leading-tight sm:block ${i === step ? 'font-semibold' : 'text-muted'}`}>{t(k)}</span>
            </button>
          </li>
        ))}
      </ol>

      {connected && (
        <p className="flex items-center justify-between gap-2 rounded-xl bg-ok-tint px-3 py-1 text-sm">
          {t('setup.connectedToast', { name: connected === 'google' ? t('conn.gmail') : t('conn.dropbox') })}
          <button type="button" aria-label={t('common.cancel')} className="grid size-9 place-items-center" onClick={() => setParams({})}><Icon name="close" className="size-4" /></button>
        </p>
      )}

      <Card title={`${t('setup.step', { n: step + 1 })} · ${t(STEPS[step])}`}>{body}</Card>

      <div className="flex justify-between">
        <Button variant="secondary" className="bg-white shadow-soft" disabled={step === 0} onClick={() => setStep(step - 1)}>{t('common.back')}</Button>
        {step < STEPS.length - 1 && <Button onClick={() => setStep(step + 1)}>{t('common.next')}</Button>}
      </div>
    </div>
  );
}
