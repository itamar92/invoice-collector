# invoice-collector

Self-hosted invoice collector. It reads invoices and receipts from Gmail, extracts the fields with per-vendor
recipes (JSON rules) and an AI fallback, files the PDF in Dropbox, and hands expenses to your accounting system
(Morning). Single user per instance. Hebrew right-to-left UI; Israeli defaults (VAT 18%, ILS, category names,
folder and filename conventions) are isolated in `server/defaults/il.ts` and `recipes/il/` and are all
overridable in Settings.

## Features

- Gmail ingest, optionally limited to one label; an email is marked handled only after all its items are done.
- Paper receipts: upload a photo or PDF from the app, or send it to a Telegram bot (your own, or one shared bot
  serving many instances); same pipeline as email.
- Recipes validated by a schema, regex run through RE2 only; AI fallback (Anthropic, OpenAI, Gemini or SSH agent).
- Dropbox filing with configurable folder and filename templates; never overwrites existing files.
- Morning expense hand-off with duplicate and personal-vendor safeguards.
- Secrets encrypted at rest (AES-256-GCM); never returned by any HTTP response.
- One container, SQLite in a volume, `GET /healthz` for health checks.

## Quick start (Docker)

```sh
cp .env.example .env     # set APP_PASSWORD, SECRET_KEY (openssl rand -hex 32), PUBLIC_URL, ...
cp deploy/docker-compose.example.yml docker-compose.yml
docker compose up -d --build
```

Note: the app must be reached over HTTPS (set `PUBLIC_URL` to an `https://` URL, e.g. via a Cloudflare Tunnel). The container runs in production mode, so the login cookie is Secure and login silently fails over plain http; `http://localhost` works in most browsers except Safari.

Then open `PUBLIC_URL`, log in with `APP_PASSWORD`, and connect Gmail and Dropbox in Settings.
Full instructions (Google OAuth client, Dropbox app, Morning, AI agent, Cloudflare Access):
[docs/SETUP.md](docs/SETUP.md).

## Development

```sh
npm install
npm test && npm run lint && npm run build
npm run dev          # API on :3100
npm run dev:ui       # Vite on :5173, proxies /api
```

## License

MIT (see [LICENSE](LICENSE)).

## Web UI

Hebrew RTL React app (`src/`, Vite + Tailwind). `npm run build` writes `dist/`; with `NODE_ENV=production`
(`npm start`) the server serves it, with an `index.html` fallback for client routes (`/api/*` always stays JSON).
For UI work: run the API (`npm run dev`) and `npm run dev:ui` (Vite on :5173, proxies `/api`).

### Demo with synthetic data

```sh
SECRET_KEY=any-demo-key APP_PASSWORD=demo PORT=3180 npm run demo   # build, seed ./data-demo, serve on :3180
```

Log in with the `APP_PASSWORD` you set. `scripts/seed-demo.ts` recreates `./data-demo/app.db` (it refuses any folder
whose name lacks "demo") with invented vendors, items in every state, a missed-by-label row and an ingest failure.
The Gmail/Dropbox tokens it stores are fake, so filing fails with a storage error; that is expected.
