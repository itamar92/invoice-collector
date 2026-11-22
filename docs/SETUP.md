# Setup guide

Self-hosting invoice-collector end to end: run the container, connect Gmail and your cloud storage (Dropbox or Google Drive), optionally connect
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

### On an Oracle Cloud (OCI) VM

`deploy/deploy-oci.sh` does the whole thing from your Mac over SSH: installs Docker on the VM, copies the repo,
creates `.env` with generated secrets, builds the image on the VM and starts the app together with a Cloudflare
Tunnel (`deploy/docker-compose.oci.yml`). No inbound ports have to be opened in the OCI security list.

1. Create the instance: shape **VM.Standard.A1.Flex** (Ampere, free tier; 1 OCPU / 6 GB is plenty), image
   Ubuntu 24.04 or Oracle Linux 9, and add your SSH public key. The 1 GB E2.1.Micro shape is too small to build
   the native modules.
2. In Cloudflare Zero Trust, Networks, Tunnels: create a tunnel (connector type Docker), copy its token, and add a
   Public Hostname (e.g. `invoices.example.com`) with service `http://invoice-collector:3100`.
3. First run creates `.env` on the VM and stops:

   ```sh
   ./deploy/deploy-oci.sh ubuntu@<vm-public-ip>
   ```

4. Fill in `PUBLIC_URL` (the tunnel hostname), `TUNNEL_TOKEN`, and the Google and Dropbox values
   (`ssh -t ubuntu@<vm-public-ip> 'nano ~/invoice-collector/.env'`), then run the script again. It builds, starts and
   waits for `/healthz`.
5. Register the OAuth redirect URIs for `PUBLIC_URL` (sections 2 and 3) and add Cloudflare Access (section 7).

Re-run the script to ship new code; `.env` and the data volume are kept. Back up `SECRET_KEY` and the
`invoice-data` volume (`docker run --rm -v invoice-collector_invoice-data:/d -v $PWD:/b alpine tar czf /b/data.tgz -C /d .`).

### Automatic deploys from GitHub

`.github/workflows/deploy.yml` deploys every push to `main` (so every merged PR): it runs lint, tests and the
build, then runs `deploy/deploy-oci.sh` from GitHub's runner against the VM. If the checks fail, nothing is
deployed. You can also start it by hand: Actions, Deploy, Run workflow. Do the first deploy from your Mac (above)
so the VM already has its `.env`.

One-time setup, from your Mac:

1. Make a key used only for deploys, and let it into the VM:

   ```sh
   ssh-keygen -t ed25519 -N '' -C invoice-collector-deploy -f ~/.ssh/ic_deploy
   ssh-copy-id -i ~/.ssh/ic_deploy.pub ubuntu@<vm-public-ip>
   ```

2. Store three repository secrets (or Settings, Secrets and variables, Actions, in the browser):

   ```sh
   gh secret set DEPLOY_HOST --body 'ubuntu@<vm-public-ip>'
   gh secret set DEPLOY_SSH_KEY < ~/.ssh/ic_deploy
   ssh-keyscan -t ed25519 <vm-public-ip> | gh secret set DEPLOY_KNOWN_HOSTS
   ```

   `DEPLOY_KNOWN_HOSTS` pins the VM's host key, so the workflow refuses to talk to any other machine. Run the
   `ssh-keyscan` from a network you trust, and if the VM is ever rebuilt, set it again.

3. Optional: Settings, Environments, `production`, add yourself as a required reviewer to approve each deploy.

To stop automatic deploys, disable the workflow (Actions, Deploy, ...) or remove the deploy key from the VM's
`~/.ssh/authorized_keys`.

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

The same client also powers **Sign in with Google** on the login and invite pages (scopes `openid email profile`,
same redirect URI, nothing extra to register). A Google account signs in only if it matches an existing account
(by Google id, or by the account's email) or it arrives through an invite link.

**Sharing the instance with friends.** Gmail's `gmail.modify` is a *restricted* scope. Until the app passes
Google's verification, at most 100 people can connect Gmail, and each one must be listed as a **test user** on
the consent screen while it is in testing mode (or will see the "unverified app" warning once published).
Add each friend's Google address there before you send them an invite.

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

## 3. Cloud storage: Dropbox or Google Drive

Filed PDFs go to **one** cloud: Dropbox or Google Drive. Pick it in Settings (Connections, "Cloud storage") and
connect it. The two are never used together: connecting one disconnects the other (its stored token is
deleted). Documents already filed stay where they are; only new filings go to the newly chosen cloud. You only
need to set up the one you use.

### 3a. Dropbox

1. Create an app at the [Dropbox App Console](https://www.dropbox.com/developers/apps): **Scoped access**,
   **App folder** access. The app name you choose is the folder name in the Dropbox; see
   [Where documents are saved in Dropbox](#where-documents-are-saved-in-dropbox) below.
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

#### Where documents are saved in Dropbox

The app can read and write only its own folder in the Dropbox, and nothing else. Dropbox creates that folder as
`Dropbox/Apps/<app name>` the first time the app writes to it, and every path in the app (the storage root, the
folder template, the folder browser in Settings) starts from there. A storage root of `/חשבוניות` files into
`Dropbox/Apps/<app name>/חשבוניות`.

- Inside the app folder anything goes: create subfolders (also from the Settings folder browser), rename them,
  share the app folder with an accountant.
- **Do not move or rename the app folder itself** (or the `Apps` folder). Dropbox ties the app to that exact
  location: a moved copy is no longer visible to the app, and the next filing creates a new, empty
  `Apps/<app name>`.
- PDFs moved out of the app folder are out of the app's sight. Filed documents are never filed again, so
  nothing breaks, but the first-import "likely duplicate" hint cannot see them.

### 3b. Google Drive

Google Drive uses the same Google OAuth client as Gmail (section 2) and the same redirect URI, so there is
nothing new to put in `.env`.

1. In the same Google Cloud project, enable the **Google Drive API**.
2. On the OAuth consent screen, add the scope `https://www.googleapis.com/auth/drive` (in testing mode you can
   skip this; Google asks for it when you connect).
3. In Settings choose **Google Drive** under "Cloud storage" and press connect.

Drive gets its own token, separate from Gmail's, so either can be reconnected on its own.

Scope requested:

| Scope | Why |
|---|---|
| `https://www.googleapis.com/auth/drive` | Browse your existing folders in the Settings folder picker and file PDFs into them. (The narrower `drive.file` scope cannot see folders the app did not create.) |

#### Where documents are saved in Google Drive

Paths start at the top of **My Drive**: a storage root of `/חשבוניות` files into the `חשבוניות` folder at the top
of your Drive, and missing folders are created on the first filing. Drive allows two folders with the same name;
the app always uses the oldest one, so keep one folder per name to avoid confusion. Files are never overwritten:
a same-named file with different content gets a numbered name.

## 4. Morning (accounting), optional

Morning (formerly Green Invoice) receives expenses so your accountant sees them. It is optional; without it
documents are still filed in your cloud storage.

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
- The wrapper never executes the caller's request; it only matches it against the three things the app asks for
  (a `--version` probe, a text analysis, and a document analysis) and runs a fixed command. The prompt arrives on
  **stdin**, never on a command line.
- The host key is **pinned**: the app stores the SHA-256 fingerprint of the host key and refuses any other.

`deploy/ic-agent.sh` is that wrapper for Claude Code. Install it root-owned (so the key cannot change what it
runs) and pin the app's public key to it in the agent user's `authorized_keys`:

```
command="/home/aiagent/bin/ic-agent",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA… invoice-collector
```

The agent's Claude login goes in `~/.config/ic-agent/env` as `CLAUDE_CODE_OAUTH_TOKEN=…` (from
`claude setup-token`); optional `IC_AGENT_MODEL`, `IC_AGENT_TIMEOUT`, `IC_AGENT_DOC_TIMEOUT`, `IC_AGENT_INBOX`.
In Settings choose mode `ssh`, and enter host, port, user, and host-key fingerprint
(`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256`). On the OCI VM the host is `host.docker.internal`
(the compose file maps it to the VM).

#### Scans and photos through the agent (shared folder)

Text PDFs go to the agent as text. A document with no text layer (a scan, a photographed receipt, a JPG/PNG
from Gmail) has to be *read*, so the app hands the agent the file through a folder both can reach:

1. The app writes the PDF to `<inbox>/<random id>/document.pdf` and asks for `claude -p --document <id>`.
2. The wrapper checks the id (`[A-Za-z0-9-]{16,64}`), that the folder and file are real (no symlinks) and inside
   the inbox, and runs Claude Code from that one folder with
   `--restricted --tools Read --allowedTools "Read(./document.pdf)" --permission-mode dontAsk --strict-mcp-config --no-session-persistence`:
   it can read that document and nothing else (no shell, no web, no other files, no MCP servers, no transcript).
3. When the answer is back (or on any error or timeout) the app deletes `<id>/`. A sweep at startup and every
   10 minutes removes anything older than 15 minutes that a crash left behind. The document itself stays in the
   app's database as always.

| Path | Owner | Group | Mode | Who can do what |
| --- | --- | --- | --- | --- |
| `/srv/ic-inbox` (host) = `/inbox` (app) | uid 1000 (the container's `node`) | `ic-inbox` (only `aiagent`) | `2750` | app writes and deletes; agent lists and reads; nobody else |
| `<id>/` | node | ic-inbox (setgid) | `0750` | same |
| `<id>/document.pdf` | node | ic-inbox | `0640` | app writes; agent reads |

One-time setup on the VM (as a sudoer), then redeploy (the compose file mounts the folder and sets
`AI_INBOX_DIR=/inbox`):

```sh
sudo groupadd --system ic-inbox
sudo usermod -aG ic-inbox aiagent
sudo install -d -o 1000 -g ic-inbox -m 2750 /srv/ic-inbox
sudo install -o root -g root -m 755 ~/invoice-collector/deploy/ic-agent.sh /home/aiagent/bin/ic-agent
sudo apt-get install -y poppler-utils   # Claude Code's Read tool needs pdftoppm to open PDFs
```

Install the wrapper after the deploy that brings the new version to the VM. If the agent cannot open a document
(folder permissions, `pdftoppm` missing) it says so instead of answering: the item waits as "AI unavailable"
with that error, and goes to Needs attention after a few tries while other documents get through.

Without `AI_INBOX_DIR` the SSH agent stays text-only and scans wait in Needs attention
(`scan_needs_api_ai`); after setting it up, retry those items. The Settings connection check also verifies that
the app can write to the folder. `bash test/ic-agent-wrapper.sh` (on Linux) checks the wrapper with a stub `claude`.

Gmail: image attachments (JPEG/PNG, at least 15 KB, up to 5 per email) are collected only from emails with no
PDF attachment, and become one-page PDFs. The Gmail search is unchanged, so an image-only email is found when it
says invoice/receipt/חשבונית/קבלה or carries your Gmail label.

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
   This puts a login in front of the app in addition to its own accounts. With friends using the instance,
   include their identities in the policy too (or rely on the app's own login and skip Access).
3. The OAuth callbacks are browser redirects made while you are logged in, so they pass through Access normally.
   If you use the machine API (`/api/v1`, a bearer token) from outside, add a Cloudflare Access service-token
   policy or a bypass rule limited to that path prefix.
4. Set `TRUST_PROXY=1` so the app sees the real client IP (used by the login rate limiter).

This is also what provides the HTTPS the app needs (see section 1): `PUBLIC_URL` must be the `https://` hostname of the tunnel.

Keep passwords and API tokens long and unique, even behind Access.

## Users

The first start creates the **owner** account (login `ADMIN_EMAIL`, or `admin`, with `APP_PASSWORD`) on the
existing `app.db`, so upgrading a single-user install keeps all its documents, settings and connections.
In **Settings → Users** the owner creates invite links (valid 7 days, single use, optionally locked to one email)
and can disable an account (sessions end, data is kept). Each user has their own database file
(`DATA_DIR/tenants/<id>.db`), their own Gmail, storage, Morning, AI key and Telegram bot, and their own
background worker; no user can see another's documents. The SSH AI agent (section 5) runs on the server's host,
so it is available to the owner only. Every user manages their email, password and API token in
**Settings → My account**.

**Shared recipes.** When one user's AI writes a recipe for a vendor (or a user fixes one by hand), it goes into a
library every user shares (`shared_recipes` in `accounts.db`). Another user's first document from that vendor is
then read by that recipe instead of the AI; it is copied into their own recipes (shown as "shared") and works like
any other: if it fails on a document, their AI rewrites it. What is shared is the matching rule (the vendor's
sender address or name markers) and the field patterns; never the category, and never a recipe that matches on
a free-mail address or a generic word, or one set to "always use AI". A user who already has a recipe for that
vendor keeps their own. The AI is told never to put the recipient's name, address or account number in a recipe.

## 8. Troubleshooting

- `SECRET_KEY is not set`: the app refuses to start without it.
- `redirect_uri_mismatch`: the URI registered at Google or Dropbox must match `PUBLIC_URL` plus the path above,
  character for character (scheme, host, no trailing slash).
- Container unhealthy: `docker compose logs invoice-collector`; the health probe is `GET /healthz` on `PORT`.
