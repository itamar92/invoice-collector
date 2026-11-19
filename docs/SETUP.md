# Setup guide

Self-hosting invoice-collector end to end: run the container, connect Gmail and Dropbox, optionally connect
Morning (accounting), choose an AI provider, and put the whole thing behind Cloudflare Access.

Throughout, `PUBLIC_URL` is the public base URL of your instance, with no trailing slash (for example
`https://invoices.example.com`). It must be set in `.env` before you start the OAuth flows.

## 1. Run it

```sh
cp .env.example .env          # then edit: APP_PASSWORD, SECRET_KEY, API_TOKEN, PUBLIC_URL, ...
cp deploy/docker-compose.example.yml docker-compose.yml
docker compose up -d --build
```

- `SECRET_KEY` must be long and random (`openssl rand -hex 32`). It encrypts every stored secret (OAuth tokens,
  Morning credentials, AI keys, SSH key). Back it up with your database: if you lose it, the stored secrets are
  unreadable and every service must be reconnected.
- All state lives in the `/data` volume (SQLite database). Back that volume up.
- **HTTPS is required.** The container runs with `NODE_ENV=production`, so the session cookie is Secure and browsers only keep it over HTTPS (login silently fails over plain http, notably in Safari). Reach the app through an HTTPS URL and make `PUBLIC_URL` start with `https://` (a Cloudflare Tunnel terminates TLS for you). The one exception is a local trial: most browsers (not Safari) accept Secure cookies on `http://localhost`, so there you can set `PUBLIC_URL=http://localhost:<port>`.
- Health check: `GET /healthz` returns `{"ok":true}` without authentication and nothing else.

Multi-architecture image (for example an Oracle Ampere arm64 VM and an amd64 laptop):

```sh
docker buildx build --platform linux/arm64,linux/amd64 -f deploy/Dockerfile -t invoice-collector .
```

Add `--push` with a registry tag to publish the image, or `--load` with a single `--platform` to load it locally.

## 2. Google (Gmail API)

1. In the [Google Cloud Console](https://console.cloud.google.com/) create a project and enable the **Gmail API**.
2. Configure the OAuth consent screen. **Testing mode with yourself as a test user is fine** for a personal
   instance. Note that in testing mode Google expires refresh tokens after 7 days; to avoid reconnecting weekly,
   publish the consent screen (for a single-user app you can stay "unverified" and accept the warning).
3. Create credentials: **OAuth client ID**, type **Web application**.
   Authorized redirect URI (exact):

   ```
   PUBLIC_URL/api/oauth/google/callback
   ```

4. Put the client ID and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, restart, log in,
   and press connect in Settings.

Scopes requested:

| Scope | When |
|---|---|
| `https://www.googleapis.com/auth/gmail.modify` | Always: read mail and attachments, apply the "handled" label. |
| `https://www.googleapis.com/auth/gmail.send` | Only if you enable the e-mail mode of the accounting hand-off (sending the document to Morning's expenses inbox by mail). Skip it if you do not use that mode. |

### First-run tip: use a Gmail label

Create a Gmail label (for example `Invoices`) and let a Gmail filter apply it to likely invoice senders, then set
that label in Settings. The collector then reads only labelled mail, which keeps the AI fallback (and its token
cost) small. Without a label it scans the whole inbox. Mail that is not matched by a recipe is sent to the AI
provider, so fewer candidate messages means fewer tokens.

## 3. Dropbox

1. Create an app at the [Dropbox App Console](https://www.dropbox.com/developers/apps): **Scoped access**,
   **App folder** (recommended) or **Full Dropbox** access.
2. Permissions tab, enable exactly:
   - `files.content.write`
   - `files.metadata.read`

   Press Submit.
3. Settings tab, add the redirect URI (exact):

   ```
   PUBLIC_URL/api/oauth/dropbox/callback
   ```

4. Copy the **App key** into `.env` as `DROPBOX_APP_KEY`. The flow uses PKCE, so no app secret is needed.
   Restart, then press connect in Settings.

Files are never overwritten: if a file with the same name exists and differs, a numbered name is used.

## 4. Morning (accounting), optional

Morning (formerly Green Invoice) receives expenses so your accountant sees them. It is optional; without it
documents are still filed in Dropbox.

1. In Morning go to the settings area for developer tools / API keys and create an API key. You get a key **id**
   and a **secret**. Exact menu names change; follow Morning's own API documentation
   (<https://www.greeninvoice.co.il/api-docs>).
2. Enter the id and secret in the app's Settings. They are stored encrypted and never shown again.

Documents flagged as already approved, backfill items, personal vendors, and categories you mark as not sent to
accounting are never sent. See `docs/morning-api.md` for the API modes the app supports.

## 5. AI provider, optional

Recipes (JSON rules per sender) handle known vendors without any AI. For everything else choose a provider in
Settings: Anthropic, OpenAI or Gemini API key (stored encrypted), or an SSH agent.

### SSH agent (use a Claude Code login instead of an API key)

The app can run a CLI agent on a separate host over SSH. The pattern:

- A dedicated, unprivileged user on the agent host holds the AI login. No model credential ever exists in the
  app's container.
- The app has its own SSH key (stored encrypted). On the agent host, `authorized_keys` pins that key to a
  **forced command** (a small wrapper script) with `no-port-forwarding,no-agent-forwarding,no-X11-forwarding`.
- The wrapper never executes the caller's request; it only matches it against the two things the app asks for
  (a `--version` probe and the analysis run) and runs a fixed command. The prompt arrives on **stdin**, never on a
  command line.
- The host key is **pinned**: the app stores the SHA-256 fingerprint of the host key and refuses any other.

A reference implementation of the forced-command wrapper and its installer is the
`deploy/claude-agent.sh` pattern in the author's separate `account-manager` project; reproduce the same
structure on your agent host. In Settings choose mode `ssh`, and enter host, port, user, and host-key
fingerprint (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256`).

## 6. Paper receipts: upload and the Telegram bot, optional

Paper receipts (fuel, supermarket) and loose PDFs can be handed in directly; they go through the same steps as an
emailed document. A photo is stored as a one-page PDF, and reading it needs an AI provider that accepts PDFs
(Anthropic, OpenAI or Gemini; not the SSH agent).

- **In the app**: the camera button (top bar on a phone, side rail on a desktop) takes a photo, a picture from the
  library or a PDF. Several files can be picked at once. Up to 15 MB each.
- **Shared Telegram bot** (no bot of your own needed):
  1. Settings → Telegram bot: enter the address of the shared bot service (from whoever operates it) and save.
  2. Press "connect Telegram", then "open in Telegram", and press Start in the chat that opens. The chat is now
     connected. The link works once and for 15 minutes. If the operator gave you an invite code, enter it first.
  3. Send a photo of a receipt (or a PDF as a file). The bot answers with what it read and a link to the item.

  Send `/stop` in the chat, or remove the chat in Settings, to disconnect it.
- **Your own bot** (alternative, nothing passes through anyone else):
  1. In Telegram, talk to `@BotFather`, send `/newbot` and copy the token it gives you.
  2. Settings → Telegram bot → your own bot: paste the token, then press "check the bot" to see its name.
  3. Send the bot any message. It answers with the chat id; add that id under "allowed chats".

  Use one bot token per running instance (two instances polling the same bot take each other's messages).

Both use long polling, so an instance needs no public address for Telegram.

### Operating the shared bot (hub)

One instance can run a bot that serves many instances. Create the bot with `@BotFather`, then on that instance set
`RELAY_BOT_TOKEN` (and optionally `RELAY_INVITE_KEY`, which instances must present to register) and restart. The hub
answers at `PUBLIC_URL/relay/v1`; the address other instances enter in Settings is `PUBLIC_URL`. Your own instance
connects to it the same way, with its own `PUBLIC_URL`. Do not also save this bot's token under "your own bot".

What the hub holds: for each instance an id and the hash of its credential, the chats linked to it (chat id and
display name), and, only while a document waits for its instance, Telegram's file id. It never stores a document:
the bytes are fetched from Telegram when the owning instance asks, and pass through the hub on the way. Waiting
documents are dropped after 7 days. If the hub sits behind Cloudflare Access (section 7), `/relay/v1/*` must be
reachable without the Access login; it has its own per-instance credential.

## 7. Protect it: Cloudflare Tunnel and Cloudflare Access

Do not expose the container port to the internet. Recommended:

1. Run `cloudflared` (Cloudflare Tunnel) on the host pointing at `http://127.0.0.1:3100`, and give the tunnel a
   hostname that matches `PUBLIC_URL`.
2. Add a **Cloudflare Access** application for that hostname with a policy allowing only your own identity.
   This puts a login in front of the app in addition to `APP_PASSWORD`.
3. The OAuth callbacks are browser redirects made while you are logged in, so they pass through Access normally.
   If you use the machine API (`/api/v1`, bearer `API_TOKEN`) from outside, add a Cloudflare Access service-token
   policy or a bypass rule limited to that path prefix.
4. Set `TRUST_PROXY=1` so the app sees the real client IP (used by the login rate limiter).

This is also what provides the HTTPS the app needs (see section 1): `PUBLIC_URL` must be the `https://` hostname of the tunnel.

Keep `APP_PASSWORD` and `API_TOKEN` long and unique, even behind Access.

## 8. Troubleshooting

- `SECRET_KEY is not set`: the app refuses to start without it.
- `redirect_uri_mismatch`: the URI registered at Google or Dropbox must match `PUBLIC_URL` plus the path above,
  character for character (scheme, host, no trailing slash).
- Container unhealthy: `docker compose logs invoice-collector`; the health probe is `GET /healthz` on `PORT`.
