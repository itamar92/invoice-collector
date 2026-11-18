import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../api.js';
import { Button, ErrorText, Field, inputCls } from '../components/ui.js';
import { t } from '../i18n/he.js';

export default function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.login(password);
      onLoggedIn();
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setError(status === 401 ? t('login.failed') : status === 429 ? t('login.tooMany') : (err as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-bold">{t('app.name')}</h1>
        <Field label={t('login.password')}>
          <input type="password" autoFocus autoComplete="current-password" className={inputCls}
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" className="w-full" disabled={busy || !password}>{t('login.submit')}</Button>
        <ErrorText>{error}</ErrorText>
      </form>
    </div>
  );
}
