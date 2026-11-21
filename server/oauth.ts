import crypto from 'node:crypto';
import express from 'express';
import { requireUser } from './auth.js';
import { DRIVE_SCOPE } from './destinations/gdrive.js';
import { chooseStorage } from './destinations/storage.js';
import { setSecret } from './secrets.js';
import { updateSettings } from './settings.js';

const TTL_MS = 10 * 60 * 1000;
interface Pending { verifier: string; expires: number; provider: 'dropbox' | 'google' | 'gdrive' }
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
    const appKey = process.env.DROPBOX_APP_KEY;
    if (!appKey || !process.env.PUBLIC_URL) { res.status(500).json({ error: 'dropbox_not_configured' }); return; }
    const now = Date.now();
    for (const [k, v] of pending) if (v.expires <= now) pending.delete(k);
    const verifier = b64url(crypto.randomBytes(48));
    const state = b64url(crypto.randomBytes(24));
    pending.set(state, { verifier, expires: now + TTL_MS, provider: 'dropbox' });
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
    if (!p || p.provider !== 'dropbox' || p.expires <= Date.now() || !code) { res.status(400).json({ error: 'invalid_state' }); return; }
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
  const googleStart = (provider: 'google' | 'gdrive', scopes: string[], res: express.Response) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId || !process.env.GOOGLE_CLIENT_SECRET || !process.env.PUBLIC_URL) {
      res.status(500).json({ error: 'google_not_configured' }); return;
    }
    const now = Date.now();
    for (const [k, v] of pending) if (v.expires <= now) pending.delete(k);
    const verifier = b64url(crypto.randomBytes(48));
    const state = b64url(crypto.randomBytes(24));
    pending.set(state, { verifier, expires: now + TTL_MS, provider });
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.search = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri('google'),
      scope: scopes.join(' '),
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
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

  r.get('/api/oauth/google/callback', requireUser, async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const p = pending.get(state);
    pending.delete(state); // one-time use
    if (!p || (p.provider !== 'google' && p.provider !== 'gdrive') || p.expires <= Date.now() || !code) {
      res.status(400).json({ error: 'invalid_state' }); return;
    }
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
