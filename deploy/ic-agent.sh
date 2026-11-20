#!/usr/bin/env bash
# Forced command for invoice-collector's SSH key on the agent host (docs/SETUP.md, section 5).
#
# Pinned in the agent user's authorized_keys:
#   command="/home/aiagent/bin/ic-agent",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA… invoice-collector
#
# SSH_ORIGINAL_COMMAND is only matched, never executed. The app asks for `claude --version` (Settings,
# connection check) or `claude -p` with the prompt on stdin (server/ai/sshAgent.ts). The reply must be
# plain text holding one JSON object, so this runs `--output-format text`.
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

# Under the app's own 120 s limit, so an overrun ends here with a message the app can show.
: "${IC_AGENT_TIMEOUT:=110}"
: "${IC_AGENT_MAX_PROMPT_BYTES:=1048576}"

case "${SSH_ORIGINAL_COMMAND-}" in
  *--version) exec claude --version ;;
  "claude -p") ;;
  *) die "unsupported request" ;;
esac

prompt_file="$(mktemp)"
trap 'rm -f "$prompt_file"' EXIT
cat > "$prompt_file"

size="$(wc -c < "$prompt_file")"
[ "$size" -gt 0 ] || die "empty prompt on stdin"
[ "$size" -le "$IC_AGENT_MAX_PROMPT_BYTES" ] || die "prompt is ${size} bytes, over the limit"

model_args=()
[ -n "${IC_AGENT_MODEL:-}" ] && model_args=(--model "$IC_AGENT_MODEL")

# The prompt holds invoice text from arbitrary senders: no built-in tools, no MCP servers, no transcript.
set +e
timeout -k 5 "$IC_AGENT_TIMEOUT" \
  claude -p \
    --output-format text \
    --tools "" \
    --strict-mcp-config \
    --no-session-persistence \
    "${model_args[@]}" \
  < "$prompt_file"
status=$?
set -e
[ "$status" -eq 124 ] && echo "ic-agent: claude did not answer within ${IC_AGENT_TIMEOUT}s" >&2
exit "$status"
