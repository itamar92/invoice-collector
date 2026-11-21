#!/usr/bin/env bash
# Forced command for invoice-collector's SSH key on the agent host (docs/SETUP.md, section 5).
#
# Pinned in the agent user's authorized_keys:
#   command="/home/aiagent/bin/ic-agent",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA… invoice-collector
#
# SSH_ORIGINAL_COMMAND is only matched, never executed. The app asks for one of:
#   claude --version              Settings connection check
#   claude -p                     prompt on stdin, no tools at all
#   claude -p --document <id>     prompt on stdin; Claude may Read <inbox>/<id>/document.pdf and nothing else
# (server/ai/sshAgent.ts). The reply must be plain text holding one JSON object: `--output-format text`.
# The inbox (default /srv/ic-inbox) is written by the app container and readable by this user through the
# ic-inbox group; the app deletes <id>/ as soon as this returns.
# Installed as a root-owned copy, so what the key can run changes only when someone re-installs it.
set -euo pipefail

die() { echo "ic-agent: $*" >&2; exit 1; }

HOME_DIR="${HOME:-/home/aiagent}"
PATH="${HOME_DIR}/.local/bin:/usr/local/bin:/usr/bin:/bin"
export PATH

# Optional: CLAUDE_CODE_OAUTH_TOKEN, IC_AGENT_MODEL, IC_AGENT_TIMEOUT.
: "${IC_AGENT_ENV_FILE:=${HOME_DIR}/.config/ic-agent/env}"
if [ -r "$IC_AGENT_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$IC_AGENT_ENV_FILE"
  set +a
fi

# Under the app's own limits (120 s, 180 s for a document), so an overrun ends here with a message the app can show.
: "${IC_AGENT_TIMEOUT:=110}"
: "${IC_AGENT_DOC_TIMEOUT:=170}"
: "${IC_AGENT_MAX_PROMPT_BYTES:=1048576}"
: "${IC_AGENT_MAX_DOC_BYTES:=20971520}"
: "${IC_AGENT_INBOX:=/srv/ic-inbox}"

request="${SSH_ORIGINAL_COMMAND-}"
doc_id=""
if [[ "$request" =~ ^claude\ -p\ --document\ ([A-Za-z0-9-]{16,64})$ ]]; then
  doc_id="${BASH_REMATCH[1]}"
else
  case "$request" in
    *--version) exec claude --version ;;
    "claude -p") ;;
    *) die "unsupported request" ;;
  esac
fi

tool_args=(--tools "")
limit="$IC_AGENT_TIMEOUT"
if [ -n "$doc_id" ]; then
  inbox="$(realpath -e -- "$IC_AGENT_INBOX" 2>/dev/null)" || die "inbox folder missing"
  doc_dir="$inbox/$doc_id"
  doc="$doc_dir/document.pdf"
  [ -d "$doc_dir" ] && [ ! -L "$doc_dir" ] || die "unknown document"
  [ -f "$doc" ] && [ ! -L "$doc" ] || die "unknown document"
  [ "$(realpath -e -- "$doc")" = "$doc" ] || die "unknown document"
  doc_size="$(stat -c %s -- "$doc")"
  [ "$doc_size" -gt 0 ] && [ "$doc_size" -le "$IC_AGENT_MAX_DOC_BYTES" ] || die "document size ${doc_size} out of range"
  cd -- "$doc_dir"
  # --restricted confines the file tools to the working directory (this one document's folder) and ignores
  # user/project settings; dontAsk refuses anything not allowed here.
  tool_args=(--restricted --tools Read --allowedTools "Read(./document.pdf)" --permission-mode dontAsk)
  limit="$IC_AGENT_DOC_TIMEOUT"
fi

prompt_file="$(mktemp)"
trap 'rm -f "$prompt_file"' EXIT
cat > "$prompt_file"

size="$(wc -c < "$prompt_file")"
[ "$size" -gt 0 ] || die "empty prompt on stdin"
[ "$size" -le "$IC_AGENT_MAX_PROMPT_BYTES" ] || die "prompt is ${size} bytes, over the limit"

model_args=()
[ -n "${IC_AGENT_MODEL:-}" ] && model_args=(--model "$IC_AGENT_MODEL")

# The prompt holds invoice text from arbitrary senders: no tools beyond reading the one document, no MCP servers,
# no transcript.
set +e
timeout -k 5 "$limit" \
  claude -p \
    --output-format text \
    "${tool_args[@]}" \
    --strict-mcp-config \
    --no-session-persistence \
    "${model_args[@]}" \
  < "$prompt_file"
status=$?
set -e
[ "$status" -eq 124 ] && echo "ic-agent: claude did not answer within ${limit}s" >&2
exit "$status"
