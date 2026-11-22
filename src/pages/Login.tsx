import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api.js';
import { Button, ErrorText, Field, inputCls } from '../components/ui.js';
import { t, tDyn } from '../i18n/he.js';
import { Brand } from '../Layout.js';

/** "Sign in with Google": a full-page redirect through Google and back. */
export function GoogleButton({ label, invite }: { label: string; invite?: string }) {
  const href = `/api/auth/google/start${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`;
  return (
    <a href={href} className="flex min-h-10 w-full items-center justify-center gap-2 rounded-xl border border-line-strong bg-white px-3 text-sm font-medium transition-colors hover:bg-accent-tint">
      <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
        <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.5 5.5 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.7z" />
        <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
        <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1z" />
        <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z" />
      </svg>
      {label}
    </a>
  );
}

export function OrLine() {
  return (
    <div className="flex items-center gap-3 text-xs text-muted">
      <span className="h-px flex-1 bg-line" />{t('login.or')}<span className="h-px flex-1 bg-line" />
    </div>
  );
}

export default function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [google, setGoogle] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    const code = params.get('error');
    return code ? tDyn(`login.err.${code}`, 'login.err.google_failed') : null;
  });

  useEffect(() => { api.authOptions().then((o) => setGoogle(o.google), () => {}); }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.login(email.trim(), password);
      onLoggedIn();
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setError(status === 401 ? t('login.failed') : status === 429 ? t('login.tooMany') : (err as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <form onSubmit={submit} className="panel w-full max-w-sm space-y-4 !rounded-3xl !p-6">
        <h1><Brand /></h1>
        <Field label={t('login.email')}>
          <input type="text" dir="ltr" autoFocus autoComplete="username" inputMode="email" className={inputCls}
            value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t('login.password')}>
          <input type="password" autoComplete="current-password" className={inputCls}
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" className="w-full" loading={busy} disabled={!email.trim() || !password}>{t('login.submit')}</Button>
        {google && <><OrLine /><GoogleButton label={t('login.google')} /></>}
        <ErrorText>{error}</ErrorText>
      </form>
    </div>
  );
}
