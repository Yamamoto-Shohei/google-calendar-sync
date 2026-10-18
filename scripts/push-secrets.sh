#!/usr/bin/env bash
#
# Upload the local gcal-sync configuration to GitHub Actions secrets, so the
# scheduled workflow can run the same sync without a machine of your own.
#
# Reads from ~/.google-calendar-sync (or $GCAL_SYNC_HOME) and sets only the
# secrets that apply to the configured auth mode. Values go in over stdin, so
# no credential appears in the process list.
#
# Re-run this whenever you change the configuration or re-authorise an account.
#
# Usage:
#   scripts/push-secrets.sh [--repo OWNER/NAME] [--yes]
#
set -euE -o pipefail
trap 'status=$?; echo "error: aborted at line $LINENO (exit $status)" >&2; exit $status' ERR

HOME_DIR="${GCAL_SYNC_HOME:-$HOME/.google-calendar-sync}"
REPO=""
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)   REPO="$2"; shift 2 ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { trap - ERR; echo "error: $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

command -v gh >/dev/null 2>&1 || die \
  "gh not found. Install the GitHub CLI: https://cli.github.com"
gh auth status >/dev/null 2>&1 || die "Not logged in to gh. Run: gh auth login"

[[ -f "$HOME_DIR/config.json" ]] || die \
  "No config at $HOME_DIR/config.json. Run \`gcal-sync setup\` first."

if [[ -z "$REPO" ]]; then
  REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
  [[ -n "$REPO" ]] || die "Could not determine the repository. Pass --repo OWNER/NAME."
fi

AUTH_MODE="$(node -e '
  const fs = require("fs");
  const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(c.auth?.mode ?? "oauth");
' "$HOME_DIR/config.json")"

# Only the files the configured mode actually needs: pushing an unused
# credential would widen the blast radius for no benefit.
FILES=(config.json)
case "$AUTH_MODE" in
  service-account) FILES+=(service-account.json) ;;
  oauth)           FILES+=(tokens.json client.json) ;;
  *) die "Unexpected auth.mode \"$AUTH_MODE\" in config.json." ;;
esac

secret_name() {
  case "$1" in
    config.json)          echo GCAL_CONFIG ;;
    tokens.json)          echo GCAL_TOKENS ;;
    client.json)          echo GCAL_CLIENT ;;
    service-account.json) echo GCAL_SERVICE_ACCOUNT ;;
  esac
}

for f in "${FILES[@]}"; do
  [[ -f "$HOME_DIR/$f" ]] || die "$HOME_DIR/$f is missing but auth.mode is \"$AUTH_MODE\"."
done

# An absolute keyFile would point at a path that does not exist on the runner.
if [[ "$AUTH_MODE" == "service-account" ]]; then
  KEY_FILE="$(node -e '
    const fs = require("fs");
    const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(c.auth?.keyFile ?? "");
  ' "$HOME_DIR/config.json")"
  if [[ -n "$KEY_FILE" ]]; then
    echo "warning: config.json pins auth.keyFile to \"$KEY_FILE\"." >&2
    echo "         That path will not exist on the runner. The workflow sets" >&2
    echo "         GCAL_SERVICE_ACCOUNT_KEY_FILE, but removing keyFile from" >&2
    echo "         config.json keeps it portable." >&2
  fi
fi

cat <<EOF

Repository: $REPO
Auth mode:  $AUTH_MODE
Secrets to set:
EOF
for f in "${FILES[@]}"; do printf '  %-22s <- %s\n' "$(secret_name "$f")" "$HOME_DIR/$f"; done
cat <<'EOF'

These values can read and write every calendar in your mesh. Only do this on a
repository you control.
EOF

if [[ "$ASSUME_YES" -eq 0 ]]; then
  [[ -t 0 ]] || die "Not running interactively. Re-run with --yes to proceed."
  read -r -p $'\nContinue? [y/N] ' reply || die "No answer received. Re-run with --yes."
  [[ "$reply" =~ ^[Yy]$ ]] || die "Cancelled."
fi

for f in "${FILES[@]}"; do
  name="$(secret_name "$f")"
  step "$name"
  # Via stdin: --body would place the credential in this process's argv.
  gh secret set "$name" --repo "$REPO" < "$HOME_DIR/$f"
done

cat <<EOF

────────────────────────────────────────────────────────────────────
Done. Verify with a manual run before trusting the schedule:

  gh workflow run sync.yml --repo $REPO -f dry_run=true
  gh run watch --repo $REPO

The schedule runs twice an hour (1,440 runs/month), which fits the 2,000
free Actions minutes a private repo gets. Actions bills per run rounded up
to a minute, so raising the frequency is what costs, not the runtime.

Re-run this script after any configuration change or re-authorisation.
────────────────────────────────────────────────────────────────────
EOF
