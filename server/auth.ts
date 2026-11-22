import crypto from 'node:crypto';
import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, ZodError } from 'zod';
import {
  AccountError, acceptInvite, adminUser, apiTokenUser, checkPassword, createApiToken, createInvite, createSession,
  deleteApiToken, deleteOtherSessions, deleteSession, getUser, hasApiToken, listInvites, listUsers, MIN_PASSWORD,
  openInvite, revokeInvite, SESSION_MS, sessionUser, setDisabled, setPassword, updateProfile, verifyPassword,
  accountsDb,
} from './accounts.js';
import type { User } from './accounts.js';
import { runAsTenant } from './db.js';
import type { TenantScope } from './db.js';

export const SESSION_COOKIE = 'ic_session';
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest();

/** Constant-time string compare; an unset/empty expected value never matches. */
function safeEqual(given: string, expected: string | undefined): boolean {
  if (!expected) return false;
  return crypto.timingSafeEqual(sha256(given), sha256(expected));
}

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

// In-memory login failure limiter (single process). Keyed by req.ip.
const failures = new Map<string, number[]>();
export function resetLoginLimiter(): void { failures.clear(); }
function recent(ip: string): number[] {
  const now = Date.now();
  const list = (failures.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length) failures.set(ip, list); else failures.delete(ip);
  return list;
}
const limited = (req: Request) => recent(req.ip ?? 'unknown').length >= MAX_FAILURES;
const fail = (req: Request) => { const ip = req.ip ?? 'unknown'; failures.set(ip, [...recent(ip), Date.now()]); };

function cookieOptions(): express.CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' };
}

/** Logs `user` in on this response (a new session cookie). */
export function startSession(res: Response, userId: string): void {
  res.cookie(SESSION_COOKIE, createSession(userId), { ...cookieOptions(), maxAge: SESSION_MS });
}

// ---------- tenants ----------

/**
 * How a user maps to their invoice database. The server installs one (server/tenants.ts); without one
 * (tests), every user shares the default database.
 */
export interface TenantHooks {
  resolve(user: User): TenantScope | null;
  /** A user was disabled: stop their background work. */
  disabled?(userId: string): void;
}
let hooks: TenantHooks | null = null;
export function setTenantHooks(h: TenantHooks | null): void { hooks = h; }

/** Runs the rest of the request as `user`: res.locals.user, and that user's database for getDb(). */
function enter(user: User, res: Response, next: NextFunction): void {
  res.locals.user = user;
  let t: TenantScope | null;
  try { t = hooks?.resolve(user) ?? null; } catch (e) { next(e); return; }
  if (t) runAsTenant(t, next); else next();
}

export const currentUser = (res: Response): User | null => (res.locals.user as User | undefined) ?? null;

export const requireUser: RequestHandler = (req, res, next) => {
  const token = readCookie(req, SESSION_COOKIE);
  const user = token ? sessionUser(token) : null;
  if (user) { enter(user, res, next); return; }
  res.status(401).json({ error: 'unauthorized' });
};

/** Like requireUser, but lets the request through without a session (res.locals.user stays unset). */
export const optionalUser: RequestHandler = (req, res, next) => {
  const token = readCookie(req, SESSION_COOKIE);
  const user = token ? sessionUser(token) : null;
  if (user) enter(user, res, next); else next();
};

export const requireAdmin: RequestHandler = (_req, res, next) => {
  if (currentUser(res)?.isAdmin) return next();
  res.status(403).json({ error: 'forbidden' });
};

/** Bearer token for /api/v1: a user's own token, or API_TOKEN (the owner's, from the environment). */
export const requireApiToken: RequestHandler = (req, res, next) => {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  if (m) {
    const user = apiTokenUser(m[1]) ?? (safeEqual(m[1], process.env.API_TOKEN) ? adminUser() : null);
    if (user && !user.disabled) { enter(user, res, next); return; }
  }
  res.status(401).json({ error: 'unauthorized' });
};

// ---------- routes ----------

const Login = z.object({ email: z.string().max(320), password: z.string().max(1000) });
const Accept = z.object({
  email: z.string().trim().min(3).max(320), name: z.string().trim().max(100).optional(),
  password: z.string().min(MIN_PASSWORD).max(1000),
}).strict();
const Profile = z.object({ email: z.string().trim().min(1).max(320), name: z.string().trim().max(100).nullable() }).partial().strict();
const Password = z.object({ current: z.string().max(1000).optional(), next: z.string().min(MIN_PASSWORD).max(1000) }).strict();
const NewInvite = z.object({ email: z.string().trim().max(320).optional() }).strict();
const Disable = z.object({ disabled: z.boolean() }).strict();

const publicUrl = () => (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '');
export const googleLoginConfigured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.PUBLIC_URL);

const me = (u: User) => ({
  id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin, hasPassword: u.hasPassword, hasGoogle: u.hasGoogle,
  hasApiToken: hasApiToken(u.id), googleLogin: googleLoginConfigured(),
});

type Handler = (req: Request, res: Response) => void;
const wrap = (fn: Handler): RequestHandler => (req, res, next) => {
  try { fn(req, res); } catch (e) {
    if (e instanceof AccountError) res.status(e.status).json({ error: e.code });
    else if (e instanceof ZodError) res.status(400).json({ error: 'invalid_request' });
    else next(e);
  }
};

export function authRouter(): express.Router {
  const r = express.Router();

  r.post('/api/login', wrap((req, res) => {
    if (limited(req)) { res.status(429).json({ error: 'too_many_attempts' }); return; }
    const { email, password } = Login.parse(req.body ?? {});
    const user = checkPassword(email, password);
    if (!user) { fail(req); res.status(401).json({ error: 'invalid_credentials' }); return; }
    failures.delete(req.ip ?? 'unknown');
    startSession(res, user.id);
    res.status(204).end();
  }));

  r.post('/api/logout', (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) deleteSession(token);
    res.clearCookie(SESSION_COOKIE, cookieOptions());
    res.status(204).end();
  });

  /** For the login page: which sign-in options exist. */
  r.get('/api/auth/options', (_req, res) => { res.json({ google: googleLoginConfigured() }); });

  r.get('/api/me', requireUser, (_req, res) => { res.json(me(currentUser(res)!)); });

  // ----- invites (public: the token is the credential) -----

  r.get('/api/invites/:token', (req, res) => {
    const inv = openInvite(String(req.params.token));
    if (!inv) { res.status(404).json({ error: 'invite_invalid' }); return; }
    res.json({ email: inv.email, google: googleLoginConfigured() });
  });

  r.post('/api/invites/:token/accept', wrap((req, res) => {
    if (limited(req)) { res.status(429).json({ error: 'too_many_attempts' }); return; }
    const body = Accept.parse(req.body ?? {});
    let user: User;
    try { user = acceptInvite(String(req.params.token), body); } catch (e) {
      if (e instanceof AccountError && e.code === 'invite_invalid') fail(req);
      throw e;
    }
    startSession(res, user.id);
    res.status(201).json(me(user));
  }));

  // ----- own account -----

  r.put('/api/account', requireUser, wrap((req, res) => {
    const patch = Profile.parse(req.body ?? {});
    res.json(me(updateProfile(currentUser(res)!.id, patch)));
  }));

  r.post('/api/account/password', requireUser, wrap((req, res) => {
    const { current, next } = Password.parse(req.body ?? {});
    const u = currentUser(res)!;
    if (u.hasPassword) {
      const stored = accountsDb().prepare('SELECT password_hash FROM users WHERE id = ?').pluck().get(u.id) as string | null;
      if (!verifyPassword(current ?? '', stored)) { res.status(403).json({ error: 'wrong_password' }); return; }
    }
    setPassword(u.id, next);
    deleteOtherSessions(u.id, readCookie(req, SESSION_COOKIE));
    res.status(204).end();
  }));

  r.post('/api/account/api-token', requireUser, (_req, res) => {
    res.status(201).json({ token: createApiToken(currentUser(res)!.id) });
  });
  r.delete('/api/account/api-token', requireUser, (_req, res) => {
    deleteApiToken(currentUser(res)!.id);
    res.status(204).end();
  });

  // ----- admin: users and invites -----

  r.get('/api/admin/users', requireUser, requireAdmin, (_req, res) => {
    res.json({
      users: listUsers().map((u) => ({ id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin, disabled: u.disabled, createdAt: u.createdAt, hasPassword: u.hasPassword, hasGoogle: u.hasGoogle })),
      invites: listInvites(),
    });
  });

  r.post('/api/admin/invites', requireUser, requireAdmin, wrap((req, res) => {
    const { email } = NewInvite.parse(req.body ?? {});
    const { token, expiresAt } = createInvite(currentUser(res)!.id, email || null);
    res.status(201).json({ url: `${publicUrl()}/invite/${token}`, expiresAt });
  }));

  r.delete('/api/admin/invites/:id', requireUser, requireAdmin, (req, res) => {
    if (revokeInvite(String(req.params.id))) res.status(204).end();
    else res.status(404).json({ error: 'invite_not_found' });
  });

  r.post('/api/admin/users/:id/disabled', requireUser, requireAdmin, wrap((req, res) => {
    const { disabled } = Disable.parse(req.body ?? {});
    const id = String(req.params.id);
    if (!getUser(id)) { res.status(404).json({ error: 'user_not_found' }); return; }
    setDisabled(id, disabled);
    if (disabled) hooks?.disabled?.(id);
    res.status(204).end();
  }));

  return r;
}
