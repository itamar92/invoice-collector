import crypto from 'node:crypto';
import express from 'express';
import { AccountError, acceptInvite, linkGoogle, openInvite, userByEmail, userByGoogle } from './accounts.js';
import type { User } from './accounts.js';
import { currentUser, googleLoginConfigured, optionalUser, requireUser, startSession } from './auth.js';
import { DRIVE_SCOPE } from './destinations/gdrive.js';
import { chooseStorage } from './destinations/storage.js';
import { setSecret } from './secrets.js';
import { updateSettings } from './settings.js';

const TTL_MS = 10 * 60 * 1000;
/**
 * `userId`: who started a connect flow; its callback must come back in that user's session.
 * 'login' (Sign in with Google) has no user yet; `invite` is the invite token it signs up with, if any.
 */
interface Pending { verifier: string; expires: number; provider: 'dropbox' | 'google' | 'gdrive' | 'login'; userId: string | null; invite?: string }
const pending = new Map<string, Pending>(); // single process

const b64url = (b: Buffer) => b.toString('base64url');

function redirectUri(provider: 'dropbox' | 'google' = 'dropbox'): string {
  return `${(process.env.PUBLIC_URL ?? '').replace(/\/+$/, '')}/api/oauth/${provider}/callback`;
}

export const GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
export const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';

export function oauthRouter(): express.Router {
  const r = express.Router();

  r.get('/api/oauth/dropbox/start', requireUser, (_req, res) => {
    const userId = currentUser(res)?.id ?? null;
    const appKey = process.env.DROPBOX_APP_KEY;
    if (!appKey || !process.env.PUBLIC_URL) { res.status(500).json({ error: 'dropbox_not_configured' }); return; }
    const now = Date.now();
    for (const [k, v] of pending) if (v.expires <= now) pending.delete(k);
    const verifier = b64url(crypto.randomBytes(48));
    const state = b64url(crypto.randomBytes(24));
    pending.set(state, { verifier, expires: now + TTL_MS, provider: 'dropbox', userId });
    const u = new URL('https://www.dropbox.com/oauth2/authorize');
    u.search = new URLSearchParams({
      client_id: appKey,
      response_type: 'code',
      redirect_uri: redirectUri(),
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      token_access_type: 'offline',
      state,
    }).toString();
    res.redirect(u.toString());
  });

  r.get('/api/oauth/dropbox/callback', requireUser, async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const p = pending.get(state);
    pending.delete(state); // one-time use
    if (!p || p.provider !== 'dropbox' || p.expires <= Date.now() || !code || p.userId !== (currentUser(res)?.id ?? null)) {
      res.status(400).json({ error: 'invalid_state' }); return;
    }
    try {
      const tr = await fetch('https://api.dropbox.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code, code_verifier: p.verifier,
          client_id: process.env.DROPBOX_APP_KEY ?? '', redirect_uri: redirectUri(),
        }).toString(),
      });
      const body = await tr.json().catch(() => ({})) as { refresh_token?: string };
      if (!tr.ok || !body.refresh_token) { res.status(502).json({ error: 'token_exchange_failed' }); return; }
      chooseStorage('dropbox'); // only one cloud at a time: this disconnects Google Drive
      setSecret('dropbox_refresh', body.refresh_token);
      res.redirect('/settings?connected=dropbox');
    } catch {
      res.status(502).json({ error: 'token_exchange_failed' });
    }
  });

  /** Gmail and Google Drive share the Google client and its one registered redirect URI, but not a token. */
  const googleStart = (provider: 'google' | 'gdrive' | 'login', scopes: string[], res: express.Response, invite?: string) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId || !process.env.GOOGLE_CLIENT_SECRET || !process.env.PUBLIC_URL) {
      res.status(500).json({ error: 'google_not_configured' }); return;
    }
    const now = Date.now();
    for (const [k, v] of pending) if (v.expires <= now) pending.delete(k);
    const verifier = b64url(crypto.randomBytes(48));
    const state = b64url(crypto.randomBytes(24));
    pending.set(state, { verifier, expires: now + TTL_MS, provider, userId: currentUser(res)?.id ?? null, invite });
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.search = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri('google'),
      scope: scopes.join(' '),
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      // Sign-in needs no offline token, and should not ask again every time.
      ...(provider === 'login' ? { prompt: 'select_account' } : { access_type: 'offline', prompt: 'consent' }),
      // Gmail's grant grows (send is added later); Drive's token stays Drive-only.
      ...(provider === 'google' ? { include_granted_scopes: 'true' } : {}),
      state,
    }).toString();
    res.redirect(u.toString());
  };

  r.get('/api/oauth/google/start', requireUser, (req, res) => {
    const scopes = [GMAIL_MODIFY];
    if (req.query.send === '1') scopes.push(GMAIL_SEND);
    googleStart('google', scopes, res);
  });

  r.get('/api/oauth/gdrive/start', requireUser, (_req, res) => { googleStart('gdrive', [DRIVE_SCOPE], res); });

  /** Sign in (or, with ?invite=<token>, sign up) with a Google account. Public. */
  r.get('/api/auth/google/start', (req, res) => {
    const invite = typeof req.query.invite === 'string' && req.query.invite ? req.query.invite : undefined;
    googleStart('login', ['openid', 'email', 'profile'], res, invite);
  });

  // One registered redirect URI for every Google flow: sign-in runs without a session, the connect flows with one.
  r.get('/api/oauth/google/callback', optionalUser, async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const p = pending.get(state);
    pending.delete(state); // one-time use
    if (p?.provider === 'login') {
      if (p.expires <= Date.now() || !code) { res.redirect('/login?error=google_failed'); return; }
      await googleLogin(code, p, res);
      return;
    }
    if (!p || (p.provider !== 'google' && p.provider !== 'gdrive') || p.expires <= Date.now() || !code) {
      res.status(400).json({ error: 'invalid_state' }); return;
    }
    if (!currentUser(res) && p.userId !== null) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (p.userId !== (currentUser(res)?.id ?? null)) { res.status(400).json({ error: 'invalid_state' }); return; }
    try {
      const tr = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code, code_verifier: p.verifier,
          client_id: process.env.GOOGLE_CLIENT_ID ?? '', client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
          redirect_uri: redirectUri('google'),
        }).toString(),
      });
      const body = await tr.json().catch(() => ({})) as { refresh_token?: string; scope?: string };
      if (!tr.ok || !body.refresh_token) { res.status(502).json({ error: 'token_exchange_failed' }); return; }
      if (p.provider === 'gdrive') {
        chooseStorage('gdrive'); // only one cloud at a time: this disconnects Dropbox
        setSecret('gdrive_refresh', body.refresh_token);
        res.redirect('/settings?connected=gdrive');
        return;
      }
      setSecret('gmail_refresh', body.refresh_token);
      updateSettings({ gmailScopes: (body.scope ?? '').split(/\s+/).filter(Boolean) });
      res.redirect('/settings?connected=google');
    } catch {
      res.status(502).json({ error: 'token_exchange_failed' });
    }
  });

  return r;
}

/** The verified Google identity in a token response's id_token (received straight from Google over TLS). */
function idTokenClaims(idToken: string | undefined): { sub: string; email: string; name: string | null } | null {
  const part = idToken?.split('.')[1];
  if (!part) return null;
  try {
    const c = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
    const issOk = c.iss === 'https://accounts.google.com' || c.iss === 'accounts.google.com';
    if (!issOk || c.aud !== process.env.GOOGLE_CLIENT_ID || typeof c.sub !== 'string' || typeof c.email !== 'string') return null;
    if (c.email_verified !== true && c.email_verified !== 'true') return null;
    if (typeof c.exp === 'number' && c.exp * 1000 < Date.now()) return null;
    return { sub: c.sub, email: c.email, name: typeof c.name === 'string' ? c.name : null };
  } catch { return null; }
}

/**
 * Finds the account for a Google identity: by Google id, else by the same (verified) email, which links it.
 * No account: an invite in the flow creates one; otherwise sign-in is refused (accounts are by invite only).
 */
async function googleLogin(code: string, p: Pending, res: express.Response): Promise<void> {
  if (!googleLoginConfigured()) { res.redirect('/login?error=google_failed'); return; }
  let claims: ReturnType<typeof idTokenClaims> = null;
  try {
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, code_verifier: p.verifier,
        client_id: process.env.GOOGLE_CLIENT_ID ?? '', client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
        redirect_uri: redirectUri('google'),
      }).toString(),
    });
    const body = await tr.json().catch(() => ({})) as { id_token?: string };
    if (tr.ok) claims = idTokenClaims(body.id_token);
  } catch { /* claims stays null */ }
  if (!claims) { res.redirect('/login?error=google_failed'); return; }

  let user: User | null = userByGoogle(claims.sub);
  if (!user) {
    user = userByEmail(claims.email);
    if (user && !user.hasGoogle) linkGoogle(user.id, claims.sub);
  }
  if (!user && p.invite && openInvite(p.invite)) {
    try {
      user = acceptInvite(p.invite, { email: claims.email, name: claims.name, googleSub: claims.sub });
    } catch (e) {
      const code = e instanceof AccountError ? e.code : 'google_failed';
      res.redirect(`/invite/${encodeURIComponent(p.invite)}?error=${code}`); return;
    }
  }
  if (!user) { res.redirect('/login?error=no_account'); return; }
  if (user.disabled) { res.redirect('/login?error=disabled'); return; }
  startSession(res, user.id);
  res.redirect('/');
}
