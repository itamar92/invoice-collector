import crypto from 'node:crypto';
import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getDb } from './db.js';

export const SESSION_COOKIE = 'ic_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest();

/** Constant-time string compare; an unset/empty expected value never matches. */
function safeEqual(given: string, expected: string | undefined): boolean {
  if (!expected) return false;
  return crypto.timingSafeEqual(sha256(given), sha256(expected));
}

function readCookie(req: Request, name: string): string | null {
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

function cookieOptions(): express.CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' };
}

function validSession(req: Request): boolean {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return false;
  const row = getDb().prepare('SELECT expires_at FROM sessions WHERE token_hash = ?')
    .get(sha256(token).toString('hex')) as { expires_at: number } | undefined;
  return !!row && row.expires_at > Date.now();
}

export const requireUser: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  if (validSession(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
};

export const requireApiToken: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  if (m && safeEqual(m[1], process.env.API_TOKEN)) return next();
  res.status(401).json({ error: 'unauthorized' });
};

export function authRouter(): express.Router {
  const r = express.Router();

  r.post('/api/login', (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (recent(ip).length >= MAX_FAILURES) { res.status(429).json({ error: 'too_many_attempts' }); return; }
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!safeEqual(password, process.env.APP_PASSWORD)) {
      failures.set(ip, [...recent(ip), Date.now()]);
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }
    failures.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const db = getDb();
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    db.prepare('INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)')
      .run(sha256(token).toString('hex'), now, now + SESSION_MS);
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: SESSION_MS });
    res.status(204).end();
  });

  r.post('/api/logout', (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token).toString('hex'));
    res.clearCookie(SESSION_COOKIE, cookieOptions());
    res.status(204).end();
  });

  r.get('/api/me', requireUser, (_req, res) => { res.json({ ok: true }); });

  return r;
}
