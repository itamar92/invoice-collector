#!/usr/bin/env bash
# Deploy (or update) invoice-collector on an Oracle Cloud VM over SSH, from your Mac.
#
#   ./deploy/deploy-oci.sh ubuntu@<vm-ip>            # Ubuntu image (user "ubuntu")
#   ./deploy/deploy-oci.sh opc@<vm-ip>               # Oracle Linux image (user "opc")
#
# What it does:
#   1. Installs Docker on the VM if it is missing (Ubuntu or Oracle Linux).
#   2. Copies the git-tracked files of this repo to ~/invoice-collector on the VM (no .env, no data).
#   3. On first run, creates .env on the VM with freshly generated SECRET_KEY / API_TOKEN / APP_PASSWORD
#      and stops so you can fill in PUBLIC_URL, TUNNEL_TOKEN, Google and Dropbox values.
#   4. Builds the image on the VM and starts the app + Cloudflare Tunnel (deploy/docker-compose.oci.yml).
#
# Re-run it any time to ship new code; .env and the SQLite volume are kept.
set -euo pipefail

TARGET="${1:?usage: $0 user@host [ssh options...]}"
shift || true
SSH_OPTS=("$@")
REMOTE_DIR="invoice-collector"
cd "$(git rev-parse --show-toplevel)"

ssh_run() { ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$TARGET" "$@"; }

echo "==> Checking Docker on $TARGET"
ssh_run 'bash -s' <<'EOF'
set -e
if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi
if ! command -v rsync >/dev/null 2>&1; then
  (sudo apt-get install -y rsync || sudo dnf install -y rsync) >/dev/null
fi
sudo systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || sudo docker compose version
EOF

echo "==> Copying tracked files"
ssh_run "mkdir -p ~/$REMOTE_DIR"
git ls-files -z | rsync -az --from0 --files-from=- -e "ssh ${SSH_OPTS[*]:-}" ./ "$TARGET:$REMOTE_DIR/"
# Sent from the local copy so it works before this file is committed.
ssh_run "cat > ~/$REMOTE_DIR/docker-compose.yml" < deploy/docker-compose.oci.yml

echo "==> Checking .env"
FRESH=$(ssh_run "bash -s" <<EOF
set -e
cd ~/$REMOTE_DIR
if [ -f .env ]; then echo no; exit 0; fi
umask 077
sed -e "s|^SECRET_KEY=.*|SECRET_KEY=\$(openssl rand -hex 32)|" \
    -e "s|^API_TOKEN=.*|API_TOKEN=\$(openssl rand -hex 32)|" \
    -e "s|^APP_PASSWORD=.*|APP_PASSWORD=\$(openssl rand -base64 18 | tr -d '/+=')|" \
    -e "s|^DATA_DIR=.*|DATA_DIR=/data|" \
    -e "s|^# TRUST_PROXY=.*|TRUST_PROXY=1|" \
    .env.example > .env
printf '\n# Cloudflare Tunnel token (Zero Trust -> Networks -> Tunnels)\nTUNNEL_TOKEN=\n' >> .env
echo yes
EOF
)
if [ "$FRESH" = "yes" ]; then
  cat <<MSG

Created ~/$REMOTE_DIR/.env on the VM with generated SECRET_KEY, API_TOKEN and APP_PASSWORD.
Now edit it and fill in PUBLIC_URL, TUNNEL_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, DROPBOX_APP_KEY:

  ssh -t $TARGET 'nano ~/$REMOTE_DIR/.env'

See your login password with:  ssh $TARGET 'grep APP_PASSWORD ~/$REMOTE_DIR/.env'
Back up SECRET_KEY somewhere safe. Then run this script again.
MSG
  # In CI (GitHub Actions) nothing was deployed, so the run must not look green.
  if [ -n "${CI:-}" ]; then echo "::error::No .env on the VM yet: run deploy/deploy-oci.sh once from your Mac first."; exit 1; fi
  exit 0
fi

echo "==> Building and starting (first build on the VM takes a few minutes)"
ssh_run "cd ~/$REMOTE_DIR && (docker compose up -d --build || sudo docker compose up -d --build)"

echo "==> Waiting for /healthz"
for _ in $(seq 1 30); do
  if ssh_run "curl -fsS http://127.0.0.1:3100/healthz >/dev/null 2>&1"; then
    echo "App is healthy."
    ssh_run "cd ~/$REMOTE_DIR && (docker compose ps || sudo docker compose ps)"
    exit 0
  fi
  sleep 3
done
echo "App did not become healthy. Logs:"
ssh_run "cd ~/$REMOTE_DIR && (docker compose logs --tail=60 invoice-collector || sudo docker compose logs --tail=60 invoice-collector)"
exit 1
