#!/usr/bin/env bash
# Checks deploy/ic-agent.sh with a stub `claude` (Linux: GNU realpath/stat). Not part of `npm test`.
#   bash test/ic-agent-wrapper.sh            (on the agent host, or any Linux box)
set -uo pipefail
WRAPPER="$(cd "$(dirname "$0")/.." && pwd)/deploy/ic-agent.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home/.local/bin" "$T/home/.config/ic-agent" "$T/inbox" "$T/outside"
cat > "$T/home/.local/bin/claude" <<'EOF'
#!/usr/bin/env bash
echo "cwd=$PWD"
printf 'arg=%s\n' "$@"
echo "stdin=$(cat)"
EOF
chmod +x "$T/home/.local/bin/claude"
: > "$T/home/.config/ic-agent/env"
ID=0123456789abcdef-0123
mkdir "$T/inbox/$ID" && echo '%PDF-1.4 x' > "$T/inbox/$ID/document.pdf"
mkdir "$T/inbox/linkedfile0000000" && ln -s "$T/outside/secret.pdf" "$T/inbox/linkedfile0000000/document.pdf"
echo '%PDF-1.4 secret' > "$T/outside/secret.pdf"
ln -s "$T/outside" "$T/inbox/linkeddir00000000"
cp "$T/outside/secret.pdf" "$T/outside/document.pdf"
mkdir "$T/inbox/emptyemptyempty00"

fail=0
run() { HOME="$T/home" IC_AGENT_INBOX="$T/inbox" SSH_ORIGINAL_COMMAND="$1" bash "$WRAPPER" <<< "${2:-PROMPT}" 2>&1; }
expect() { # name, command, regex that must match the output, expected exit (0 or 1)
  local out code
  out="$(run "$2")"; code=$?
  if [ "$code" -ne "$4" ] || ! grep -qE -- "$3" <<< "$out"; then
    echo "FAIL $1 (exit $code)"; echo "$out" | sed 's/^/   /'; fail=1
  else echo "ok   $1"; fi
}

expect "version" "claude --version" "arg=--version" 0
expect "text run has no tools" "claude -p" 'arg=--tools' 0
expect "text run passes stdin" "claude -p" 'stdin=PROMPT' 0
expect "document run" "claude -p --document $ID" "cwd=$T/inbox/$ID" 0
expect "document run is restricted" "claude -p --document $ID" 'arg=--restricted' 0
expect "document run allows only the file" "claude -p --document $ID" 'arg=Read\(\./document\.pdf\)' 0
expect "document run dontAsk" "claude -p --document $ID" 'arg=dontAsk' 0
expect "unknown id" "claude -p --document ffffffffffffffffff" "unknown document" 1
expect "symlinked file" "claude -p --document linkedfile0000000" "unknown document" 1
expect "symlinked dir" "claude -p --document linkeddir00000000" "unknown document" 1
expect "dir without file" "claude -p --document emptyemptyempty00" "unknown document" 1
expect "dots" "claude -p --document ../outside" "unsupported request" 1
expect "short id" "claude -p --document abc" "unsupported request" 1
expect "extra args" "claude -p --document $ID --tools Bash" "unsupported request" 1
expect "injection" "claude -p --document $ID; id" "unsupported request" 1
expect "other command" "bash -c id" "unsupported request" 1
exit "$fail"
