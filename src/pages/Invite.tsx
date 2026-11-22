import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { Button, ErrorText, Field, inputCls, Loading, Notice } from '../components/ui.js';
import { t, tDyn } from '../i18n/he.js';
import { Brand } from '../Layout.js';
import { GoogleButton, OrLine } from './Login.js';

/** /invite/:token — sign up with an invite link: email + password, or Google. */
export default function Invite({ onLoggedIn }: { onLoggedIn: () => void }) {
  const { token = '' } = useParams();
  const [params] = useSearchParams();
  const [info, setInfo] = useState<{ email: string | null; google: boolean } | null | 'invalid'>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    const code = params.get('error');
    return code ? tDyn(`error.${code}`, 'login.err.google_failed') : null;
  });

  useEffect(() => {
    api.invite(token).then((i) => { setInfo(i); if (i.email) setEmail(i.email); }, () => setInfo('invalid'));
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.acceptInvite(token, { email: email.trim(), name: name.trim() || undefined, password });
      window.history.replaceState(null, '', '/');
      onLoggedIn();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  if (info === null) return <Loading />;
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <div className="panel w-full max-w-sm space-y-4 !rounded-3xl !p-6">
        <h1><Brand /></h1>
        {info === 'invalid' ? (
          <>
            <Notice tone="warn">{t('invite.invalid')}</Notice>
            <Link to="/" className="text-sm text-accent underline">{t('invite.toLogin')}</Link>
          </>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <h2 className="text-lg font-semibold">{t('invite.title')}</h2>
            <p className="text-sm text-muted">{t('invite.intro')}</p>
            {info.google && <><GoogleButton label={t('invite.google')} invite={token} /><OrLine /></>}
            <Field label={t('login.email')}>
              <input type="email" dir="ltr" autoComplete="email" className={inputCls} readOnly={!!info.email}
                value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label={t('invite.name')}>
              <input type="text" autoComplete="name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={t('login.password')} hint={t('invite.passwordHint')}>
              <input type="password" autoComplete="new-password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Button type="submit" className="w-full" loading={busy} disabled={!email.trim() || password.length < 10}>{t('invite.submit')}</Button>
          </form>
        )}
        <ErrorText>{error}</ErrorText>
      </div>
    </div>
  );
}
