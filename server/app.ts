import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { authRouter } from './auth.js';
import { oauthRouter } from './oauth.js';
import { apiV1Router } from './apiV1.js';
import { apiRouter } from './routes.js';
import type { ApiContext } from './routes.js';

/** TRUST_PROXY: "true", a hop count (e.g. "1"), or an express trust-proxy string. Unset = don't trust. */
function trustProxySetting(v: string | undefined): boolean | number | string {
  if (!v) return false;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return /^\d+$/.test(v) ? parseInt(v, 10) : v;
}

export function createApp(api?: ApiContext): express.Express {
  const app = express();
  app.set('trust proxy', trustProxySetting(process.env.TRUST_PROXY));
  // Clickjacking: only our own pages may frame us (the item page frames its PDF route).
  app.use((_req, res, next) => {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    next();
  });
  app.use(express.json());
  // Container health probe: before auth and the SPA fallback; deliberately exposes nothing but liveness.
  app.get('/healthz', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
  app.use(authRouter());
  app.use(oauthRouter());
  // Before /api: token-authenticated, so the cookie-guarded /api router must not see it.
  app.use('/api/v1', apiV1Router(api?.now));
  if (api) app.use('/api', apiRouter(api));
  // Last: JSON errors only, never Express's HTML page or a stack trace.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.parse.failed' || err instanceof SyntaxError) res.status(400).json({ error: 'invalid_json' });
    else if (e?.type === 'entity.too.large') res.status(413).json({ error: 'too_large' });
    else {
      console.error('unhandled error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'internal_error' });
    }
  });
  return app;
}
