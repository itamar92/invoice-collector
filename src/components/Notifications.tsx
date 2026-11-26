import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import type { AppNotification } from '../api.js';
import { CountBadge, fmtDateTime, fmtMoney, Icon, useApp } from './ui.js';
import { t } from '../i18n/he.js';

/** "<supplier> · <amount>" and where it went, for the list and the device notification. */
function describe(n: AppNotification): { title: string; body: string } {
  const name = n.data.vendor?.trim() || t('item.title');
  const amount = n.data.total !== null ? ` · ${fmtMoney(n.data.total, n.data.currency)}` : '';
  return { title: `${name}${amount}`, body: n.data.sent ? t('notif.sent') : t('notif.filed') };
}

type PushState = 'unsupported' | 'needs_install' | 'off' | 'on' | 'denied';

/** iPhone/iPad Safari: push only works once the app is added to the home screen. */
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

function urlKey(b64url: string): Uint8Array {
  const raw = atob(b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/**
 * Web Push on this device: whether it is possible and on, and turning it on/off. A subscription that exists is sent
 * to the server again on load (idempotent), so a server that lost it gets it back.
 */
function usePush() {
  const [state, setState] = useState<PushState>('off');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  useEffect(() => {
    if (!supported()) { setState(isIos() && !standalone() ? 'needs_install' : 'unsupported'); return; }
    if (Notification.permission === 'denied') { setState('denied'); return; }
    void navigator.serviceWorker.ready.then(async (reg) => {
      const sub = await reg.pushManager.getSubscription();
      if (sub && Notification.permission === 'granted') {
        setState('on');
        await api.pushSubscribe(sub.toJSON()).catch(() => {});
      }
    }).catch(() => {});
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message || t('notif.pushFailed')); } finally { setBusy(false); }
  };
  const enable = () => run(async () => {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { setState(perm === 'denied' ? 'denied' : 'off'); return; }
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await api.pushKey();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(publicKey) as BufferSource });
    await api.pushSubscribe(sub.toJSON());
    setState('on');
  });
  const disable = () => run(async () => {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (sub) { await api.pushUnsubscribe(sub.endpoint); await sub.unsubscribe(); }
    setState('off');
  });
  const test = () => run(async () => {
    const r = await api.pushTest();
    if (r.sent === 0) throw new Error(t('notif.pushFailed'));
  });
  return { state, busy, error, enable, disable, test };
}

export function NotificationBell({ align = 'end' }: { align?: 'start' | 'end' }) {
  const { summary } = useApp();
  const unread = summary?.notificationsUnread ?? 0;
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<AppNotification[] | null>(null);
  const push = usePush();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stop = false;
    api.notifications(true).then((r) => { if (!stop) setList(r.notifications); }).catch(() => { /* keeps the last list */ });
    return () => { stop = true; };
  }, [unread]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);

  const markAll = async () => {
    try { await api.readNotifications(); setList((l) => l?.map((n) => ({ ...n, read: true })) ?? l); } catch { /* retried next open */ }
  };

  return (
    <div ref={box} className="relative">
      <button type="button" aria-label={t('notif.title')} title={t('notif.title')} aria-expanded={open} onClick={() => setOpen(!open)}
        className="relative grid size-10 place-items-center rounded-xl bg-white text-ink shadow-soft hover:bg-ground-deep">
        <Icon name="bell" />
        {unread > 0 && <span className="absolute -top-1.5 -end-1.5"><CountBadge n={unread} tone="red" /></span>}
      </button>
      {open && (
        <div role="dialog" aria-label={t('notif.title')}
          className={`absolute top-12 z-40 w-[min(22rem,calc(100vw-2rem))] rounded-2xl bg-white p-2 shadow-soft ring-1 ring-line ${align === 'end' ? 'end-0' : 'start-0'}`}>
          <div className="flex items-center justify-between gap-2 px-2 py-1">
            <span className="font-semibold">{t('notif.title')}</span>
            {unread > 0 && <button type="button" onClick={() => void markAll()} className="min-h-8 text-xs font-semibold text-accent underline">{t('notif.markAll')}</button>}
          </div>
          {!list?.length ? <p className="px-2 py-4 text-sm text-muted">{t('notif.empty')}</p> : (
            <ul className="max-h-[60dvh] overflow-y-auto">
              {list.map((n) => {
                const d = describe(n);
                return (
                  <li key={n.id}>
                    <Link to={n.itemId ? `/items/${n.itemId}` : '/invoices'} onClick={() => { setOpen(false); if (!n.read) void api.readNotifications([n.id]).catch(() => {}); }}
                      className={`flex gap-2 rounded-xl px-2 py-2 hover:bg-ground ${n.read ? '' : 'bg-accent-tint/60'}`}>
                      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${n.read ? 'bg-transparent' : 'bg-accent'}`} />
                      <span className="min-w-0">
                        <span className="block text-xs text-muted">{t('notif.processed')} · <span className="num">{fmtDateTime(n.at)}</span></span>
                        <span className="block truncate font-medium"><bdi>{d.title}</bdi></span>
                        <span className="block text-xs text-muted">{d.body}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="space-y-1 border-t border-line px-2 pt-2 text-xs">
            {push.state === 'on' && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-muted">{t('notif.enabled')}</span>
                <button type="button" disabled={push.busy} onClick={() => void push.test()} className="min-h-8 font-semibold text-accent underline">{t('notif.test')}</button>
                <button type="button" disabled={push.busy} onClick={() => void push.disable()} className="min-h-8 font-semibold text-muted underline">{t('notif.disable')}</button>
              </div>
            )}
            {push.state === 'off' && <button type="button" disabled={push.busy} onClick={() => void push.enable()} className="min-h-8 font-semibold text-accent underline">{t('notif.enable')}</button>}
            {push.state === 'denied' && <p className="text-muted">{t('notif.blocked')}</p>}
            {push.state === 'needs_install' && <p className="text-muted">{t('notif.installFirst')}</p>}
            {push.state === 'unsupported' && <p className="text-muted">{t('notif.unsupported')}</p>}
            {push.error && <p className="text-alert-deep">{push.error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
