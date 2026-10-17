#!/usr/bin/env bash
#
# Create everything on the Google Cloud side that gcal-sync needs in
# service-account mode: a project, the Calendar API, a service account, and a
# JSON key.
#
# Idempotent -- safe to re-run. Only the key is created fresh each time, and
# only if one is not already present at the output path.
#
# The one thing this cannot do is share your calendars with the service
# account: that needs owner access to each calendar, which only you have. The
# script prints the address and the exact steps at the end.
#
# Usage:
#   scripts/setup-gcp.sh [--project-id ID] [--key-out PATH] [--sa-name NAME]
#
set -euo pipefail

PROJECT_ID=""
SA_NAME="gcal-sync"
KEY_OUT="${GCAL_SYNC_HOME:-$HOME/.google-calendar-sync}/service-account.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-id) PROJECT_ID="$2"; shift 2 ;;
    --sa-name)    SA_NAME="$2";    shift 2 ;;
    --key-out)    KEY_OUT="$2";    shift 2 ;;
    # Print the header comment block, stopping at the first line of code.
    -h|--help)    awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

command -v gcloud >/dev/null 2>&1 || die \
  "gcloud not found. Install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install"

if ! gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q .; then
  die "Not logged in to gcloud. Run: gcloud auth login"
fi

# A project id must be globally unique, so derive a default with a random tail.
if [[ -z "$PROJECT_ID" ]]; then
  PROJECT_ID="gcal-sync-$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 8)"
fi

SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

step "Project: $PROJECT_ID"
if gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  echo "    already exists, reusing"
else
  gcloud projects create "$PROJECT_ID" --name="gcal-sync"
  echo "    created"
fi

step "Enabling the Google Calendar API"
# Needs no billing account: the Calendar API has no usage charges.
gcloud services enable calendar-json.googleapis.com --project="$PROJECT_ID"
echo "    enabled"

step "Service account: $SA_EMAIL"
if gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "    already exists, reusing"
else
  gcloud iam service-accounts create "$SA_NAME" \
    --project="$PROJECT_ID" \
    --display-name="gcal-sync" \
    --description="Mirrors busy time blocks between calendars"
  echo "    created"
fi

step "Key: $KEY_OUT"
if [[ -f "$KEY_OUT" ]]; then
  echo "    a key already exists at that path, keeping it"
  echo "    (delete it first if you want to rotate)"
else
  mkdir -p "$(dirname "$KEY_OUT")"
  chmod 700 "$(dirname "$KEY_OUT")" 2>/dev/null || true
  gcloud iam service-accounts keys create "$KEY_OUT" \
    --iam-account="$SA_EMAIL" \
    --project="$PROJECT_ID"
  chmod 600 "$KEY_OUT"
  echo "    created"
fi

cat <<EOF

────────────────────────────────────────────────────────────────────
Google Cloud side is done. No consent screen, no publishing step.

  project:  $PROJECT_ID
  address:  $SA_EMAIL
  key:      $KEY_OUT

Remaining manual step -- share each calendar with the service account.
This cannot be scripted: it needs owner access to the calendar, which
only you have.

For every calendar you want to sync:

  1. calendar.google.com, hover the calendar in the left sidebar
  2. ⋮ -> "Settings and sharing"
  3. "Share with specific people or groups" -> "Add people and groups"
  4. Paste: $SA_EMAIL
  5. Permission: "Make changes to events"   <- must be this, not "See all details"
  6. Send

Do the same for each mirror calendar. Creating a dedicated calendar per
account for mirrors is recommended -- it can be hidden with one checkbox
and deleted to reset everything.

Then:

  gcal-sync setup     # pick "service account", register the key, add calendars
  gcal-sync doctor     # verify every calendar is reachable and writable
  gcal-sync sync --dry-run
────────────────────────────────────────────────────────────────────
EOF
