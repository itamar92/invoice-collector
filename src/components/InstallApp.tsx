import { useEffect, useState, useSyncExternalStore } from 'react';
import { t } from '../i18n/he.js';
import { Button, Icon } from './ui.js';

/**
 * "Add to home screen". Chrome/Edge/Android fire `beforeinstallprompt` (often before React mounts, so it is
 * caught at import time) and we replay it on a click. iPhone/iPad Safari has no API: the button opens a short
 * how-to (Share, then Add to Home Screen). Nothing shows once the app runs from the home screen.
 */
interface InstallEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as InstallEvent; notify(); });
  window.addEventListener('appinstalled', () => { deferred = null; notify(); });
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

const standalone = () => window.matchMedia('(display-mode: standalone)').matches
  || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1); // iPadOS reports as a Mac

const DISMISS_KEY = 'installBannerDismissed';
const readDismissed = () => { try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; } };

export function useInstallApp() {
  const prompt = useSyncExternalStore(subscribe, () => deferred);
  const [howTo, setHowTo] = useState(false);
  const mode: 'prompt' | 'ios' | null = standalone() ? null : prompt ? 'prompt' : isIos() ? 'ios' : null;

  const install = async () => {
    if (mode === 'ios') { setHowTo(true); return; }
    if (!deferred) return;
    const e = deferred;
    await e.prompt();
    await e.userChoice.catch(() => undefined);
    deferred = null; notify(); // the event can be used once
  };
  const sheet = howTo ? <IosHowTo onClose={() => setHowTo(false)} /> : null;
  return { available: mode !== null, install, sheet };
}

export function AppIcon({ className = 'size-12' }: { className?: string }) {
  return <img src="/apple-touch-icon.png" alt="" className={`${className} shrink-0 rounded-[22%] shadow-soft`} />;
}

/** A one-time card inviting the user to install, until they install or close it. */
export function InstallBanner({ install }: { install: ReturnType<typeof useInstallApp> }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  if (!install.available || dismissed) return null;
  const close = () => { setDismissed(true); try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* private mode */ } };
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-white p-3 shadow-soft">
      <AppIcon />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{t('install.title')}</p>
        <p className="text-xs text-muted">{t('install.body')}</p>
      </div>
      <Button className="shrink-0" onClick={() => void install.install()}>{t('install.button')}</Button>
      <button type="button" onClick={close} aria-label={t('install.dismiss')} title={t('install.dismiss')}
        className="grid size-9 shrink-0 place-items-center rounded-full text-muted hover:bg-ground-deep">
        <Icon name="close" />
      </button>
    </div>
  );
}

function IosHowTo({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <button type="button" aria-label={t('common.cancel')} className="fixed inset-0 z-40 bg-ink/30" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby="install-howto"
        className="fixed inset-x-3 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-50 mx-auto max-w-md rounded-2xl bg-white p-4 shadow-soft">
        <div className="flex items-center gap-3">
          <AppIcon className="size-14" />
          <div className="min-w-0 flex-1">
            <p id="install-howto" className="font-semibold">{t('install.title')}</p>
            <p className="text-xs text-muted">{t('app.name')}</p>
          </div>
        </div>
        <ol className="mt-4 space-y-3 text-sm">
          <li className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-ground-deep text-accent-deep"><Icon name="share" /></span>
            <span>{t('install.ios.step1')}</span>
          </li>
          <li className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-ground-deep text-accent-deep"><Icon name="addHome" /></span>
            <span>{t('install.ios.step2')}</span>
          </li>
        </ol>
        <Button variant="secondary" className="mt-4 w-full" onClick={onClose}>{t('install.ios.done')}</Button>
      </div>
    </>
  );
}
