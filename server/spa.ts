import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

/**
 * Production UI: static files from `dir` (the Vite build) plus an index.html fallback for client routes.
 * Mount after createApp(): /api/* never reaches here (the /api routers answer 401/404 JSON themselves),
 * and the fallback also refuses /api paths explicitly so it can never mask an API miss.
 */
export function serveSpa(app: express.Express, dir: string): void {
  const index = path.join(dir, 'index.html');
  app.use(express.static(dir, { index: false }));
  app.get('*', (req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/') || req.path.startsWith('/assets/')) return next();
    if (!fs.existsSync(index)) return next();
    res.sendFile(index);
  });
  app.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
}
