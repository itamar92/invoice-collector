import { useState } from 'react';
import { api } from '../api.js';
import { t } from '../i18n/he.js';
import { Button, Check, ErrorText, Field, fmtDate, hintCls, inputCls, Notice, rowCls, Saved, useAction, useApp, useLoad } from './ui.js';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); };
  return <Button variant="secondary" onClick={copy}>{copied ? t('users.copied') : t('users.copy')}</Button>;
}

/** Shown once: a secret the server keeps only as a hash (invite link, API token). */
function OneTime({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-2">
      <Notice tone="ok">{label}</Notice>
      <div className="flex gap-2">
        <input readOnly dir="ltr" className={`${inputCls} font-mono text-xs`} value={value} onFocus={(e) => e.target.select()} />
        <CopyButton text={value} />
      </div>
    </div>
  );
}

/** The logged-in user's own login: email, name, password, Google, API token. */
export function AccountSection() {
  const { me, setMe } = useApp();
  const [email, setEmail] = useState(me.email);
  const [name, setName] = useState(me.name ?? '');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pwDone, setPwDone] = useState(false);
  const profile = useAction();
  const pw = useAction();
  const tok = useAction();

  const dirty = email.trim() !== me.email || name.trim() !== (me.name ?? '');
  const saveProfile = () => profile.run(async () => {
    setMe(await api.updateAccount({ email: email.trim(), name: name.trim() || null }));
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  });
  const savePassword = () => pw.run(async () => {
    await api.changePassword(me.hasPassword ? current : undefined, next);
    setCurrent(''); setNext(''); setPwDone(true);
    if (!me.hasPassword) setMe({ ...me, hasPassword: true });
  });
  const makeToken = () => tok.run(async () => {
    const r = await api.createApiToken();
    setToken(r.token); setMe({ ...me, hasApiToken: true });
  });
  const revokeToken = () => tok.run(async () => {
    await api.deleteApiToken();
    setToken(null); setMe({ ...me, hasApiToken: false });
  });

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('account.email')}>
          <input type="text" dir="ltr" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t('account.name')}>
          <input type="text" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Button loading={profile.busy} disabled={!dirty || !email.trim()} onClick={() => void saveProfile()}>{t('common.save')}</Button>
        <Saved show={saved} />
      </div>
      <ErrorText>{profile.error}</ErrorText>

      {me.googleLogin && (
        <div className={`space-y-1 border-t border-line pt-4 ${rowCls}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{t('account.google')}</span>
            <Check ok={me.hasGoogle} />
          </div>
          <p className={hintCls}>{me.hasGoogle ? t('account.googleLinked') : t('account.googleHint')}</p>
        </div>
      )}

      <div className="space-y-3 border-t border-line pt-4">
        <span className="text-sm font-medium">{t('account.password')}</span>
        <div className="grid gap-3 sm:grid-cols-2">
          {me.hasPassword && (
            <Field label={t('account.currentPassword')}>
              <input type="password" autoComplete="current-password" className={inputCls} value={current} onChange={(e) => setCurrent(e.target.value)} />
            </Field>
          )}
          <Field label={t('account.newPassword')}>
            <input type="password" autoComplete="new-password" className={inputCls} value={next} onChange={(e) => { setNext(e.target.value); setPwDone(false); }} />
          </Field>
        </div>
        <Button variant="secondary" loading={pw.busy} disabled={next.length < 10 || (me.hasPassword && !current)} onClick={() => void savePassword()}>
          {me.hasPassword ? t('account.changePassword') : t('account.setPassword')}
        </Button>
        {pwDone && <Notice tone="ok">{t('account.passwordChanged')}</Notice>}
        <ErrorText>{pw.error}</ErrorText>
      </div>

      <div className="space-y-3 border-t border-line pt-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">{t('account.apiToken')}</span>
          <Check ok={me.hasApiToken} />
        </div>
        <p className={hintCls}>{t('account.apiTokenHint')}</p>
        {token && <OneTime label={t('account.apiTokenOnce')} value={token} />}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" loading={tok.busy} onClick={() => void makeToken()}>
            {me.hasApiToken ? t('account.apiTokenReplace') : t('account.apiTokenCreate')}
          </Button>
          {me.hasApiToken && <Button variant="ghost" disabled={tok.busy} onClick={() => void revokeToken()}>{t('account.apiTokenRevoke')}</Button>}
        </div>
        <ErrorText>{tok.error}</ErrorText>
      </div>
    </div>
  );
}

/** Owner only: who has an account, invite links, disabling a user. */
export function UsersSection() {
  const list = useLoad(() => api.adminUsers(), []);
  const [inviteEmail, setInviteEmail] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const a = useAction();

  const invite = () => a.run(async () => {
    const r = await api.createInvite(inviteEmail.trim() || undefined);
    setLink(r.url); setInviteEmail('');
    await list.reload();
  }, 'invite');
  const toggle = (id: string, email: string, disabled: boolean) => {
    if (disabled && !window.confirm(t('users.disableConfirm', { email }))) return;
    void a.run(async () => { await api.setUserDisabled(id, disabled); await list.reload(); }, id);
  };
  const revoke = (id: string) => a.run(async () => { await api.revokeInvite(id); await list.reload(); }, `inv-${id}`);

  const users = list.data?.users ?? [];
  const open = (list.data?.invites ?? []).filter((i) => !i.usedAt && i.expiresAt > Date.now());

  return (
    <div className="space-y-4">
      <p className="text-sm">{t('users.intro')}</p>
      <ul>
        {users.map((u) => (
          <li key={u.id} className={`flex flex-wrap items-center justify-between gap-2 py-2.5 ${rowCls}`}>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium" dir="ltr">{u.email}</div>
              <div className={hintCls}>
                {[u.name, u.isAdmin ? t('users.owner') : null, u.disabled ? t('users.disabled') : null, fmtDate(u.createdAt)].filter(Boolean).join(' · ')}
              </div>
            </div>
            {!u.isAdmin && (
              <Button variant={u.disabled ? 'secondary' : 'ghost'} loading={a.is(u.id)} onClick={() => toggle(u.id, u.email, !u.disabled)}>
                {u.disabled ? t('users.enable') : t('users.disable')}
              </Button>
            )}
          </li>
        ))}
      </ul>

      <div className="space-y-3 border-t border-line pt-4">
        <Field label={t('users.inviteEmail')}>
          <input type="email" dir="ltr" className={inputCls} value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
        </Field>
        <Button loading={a.is('invite')} onClick={() => void invite()}>{t('users.invite')}</Button>
        {link && <OneTime label={t('users.inviteReady')} value={link} />}
      </div>

      {open.length > 0 && (
        <div className="space-y-1 border-t border-line pt-4">
          <span className="text-sm font-medium">{t('users.pending')}</span>
          <ul>
            {open.map((i) => (
              <li key={i.id} className={`flex items-center justify-between gap-2 py-2 ${rowCls}`}>
                <div className="min-w-0 text-sm">
                  <span dir="ltr">{i.email ?? t('users.anyone')}</span>
                  <span className={`${hintCls} ms-2`}>{t('users.expires', { date: fmtDate(new Date(i.expiresAt).toISOString()) })}</span>
                </div>
                <Button variant="ghost" loading={a.is(`inv-${i.id}`)} onClick={() => void revoke(i.id)}>{t('users.revoke')}</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ErrorText>{a.error ?? list.error}</ErrorText>
    </div>
  );
}
