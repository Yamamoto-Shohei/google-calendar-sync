#!/usr/bin/env bash
#
# Run the sync on Cloud Run Jobs, triggered by Cloud Scheduler.
#
# Why not GitHub Actions: its `schedule` trigger is best effort. Ticks are
# delayed under load and silently dropped, and the schedule runs as whoever
# last edited the cron line -- if that account cannot reach the repository,
# nothing fires and nothing says so. Cloud Scheduler just runs.
#
# This script is idempotent: re-run it after any configuration change or
# re-authorisation to push the new credentials and redeploy.
#
# Usage:
#   scripts/setup-cloud-run.sh [--project ID] [--region REGION] [--schedule CRON] [--yes]
#
set -euE -o pipefail
trap 'status=$?; echo "error: aborted at line $LINENO (exit $status)" >&2; exit $status' ERR

HOME_DIR="${GCAL_SYNC_HOME:-$HOME/.google-calendar-sync}"
PROJECT=""
REGION="asia-northeast1"
SCHEDULE="*/15 * * * *"
ASSUME_YES=0

JOB="gcal-sync"
JOB_SA="gcal-sync-job"
SCHED_SA="gcal-sync-scheduler"
SCHED_JOB="gcal-sync-tick"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)  PROJECT="$2"; shift 2 ;;
    --region)   REGION="$2"; shift 2 ;;
    --schedule) SCHEDULE="$2"; shift 2 ;;
    -y|--yes)   ASSUME_YES=1; shift ;;
    -h|--help)  awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

die()  { trap - ERR; echo "error: $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

command -v gcloud >/dev/null 2>&1 || die \
  "gcloud not found. Install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install"

ACCOUNT="$(gcloud config get-value account 2>/dev/null)"
[[ -n "$ACCOUNT" && "$ACCOUNT" != "(unset)" ]] || die "Not logged in. Run: gcloud auth login"

[[ -f "$HOME_DIR/config.json" ]] || die \
  "No config at $HOME_DIR/config.json. Run \`gcal-sync setup\` first."

if [[ -z "$PROJECT" ]]; then
  PROJECT="$(gcloud config get-value project 2>/dev/null)"
  [[ -n "$PROJECT" && "$PROJECT" != "(unset)" ]] || die "Pass --project ID."
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"

# Cloud Run, Build, Scheduler and Secret Manager all need billing. Without this
# check the failure surfaces as an opaque permission error three steps later.
BILLING="$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null || echo False)"
[[ "$BILLING" == "True" ]] || die \
  "Billing is not enabled on $PROJECT. Link a billing account first:
    gcloud billing accounts list
    gcloud billing projects link $PROJECT --billing-account ACCOUNT_ID
  Usage here sits inside the free tiers; expect cents per month for image
  storage and secret versions, not dollars."

AUTH_MODE="$(node -e '
  const fs = require("fs");
  const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(c.auth?.mode ?? "oauth");
' "$HOME_DIR/config.json")"

# Only the credentials the configured mode needs.
FILES=(config.json)
case "$AUTH_MODE" in
  service-account) FILES+=(service-account.json) ;;
  oauth)           FILES+=(tokens.json client.json) ;;
  *) die "Unexpected auth.mode \"$AUTH_MODE\" in config.json." ;;
esac

secret_name() {
  case "$1" in
    config.json)          echo gcal-config ;;
    tokens.json)          echo gcal-tokens ;;
    client.json)          echo gcal-client ;;
    service-account.json) echo gcal-service-account ;;
  esac
}

env_name() {
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

cat <<EOF

Project:   $PROJECT ($PROJECT_NUMBER)
Region:    $REGION
Account:   $ACCOUNT
Auth mode: $AUTH_MODE
Schedule:  $SCHEDULE (Asia/Tokyo)

Will create or update:
  Secret Manager   $(for f in "${FILES[@]}"; do printf '%s ' "$(secret_name "$f")"; done)
  Service accounts $JOB_SA, $SCHED_SA
  Cloud Run job    $JOB
  Scheduler job    $SCHED_JOB

These secrets can read and write every calendar in your mesh.
EOF

if [[ "$ASSUME_YES" -eq 0 ]]; then
  [[ -t 0 ]] || die "Not running interactively. Re-run with --yes to proceed."
  read -r -p $'\nContinue? [y/N] ' reply || die "No answer received. Re-run with --yes."
  [[ "$reply" =~ ^[Yy]$ ]] || die "Cancelled."
fi

step "Enabling APIs"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com \
  --project "$PROJECT"

step "Storing credentials in Secret Manager"
for f in "${FILES[@]}"; do
  name="$(secret_name "$f")"
  if ! gcloud secrets describe "$name" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud secrets create "$name" --replication-policy automatic --project "$PROJECT"
  fi
  # Via a file, not --data-file=- with a heredoc: no credential reaches argv.
  gcloud secrets versions add "$name" --data-file "$HOME_DIR/$f" --project "$PROJECT" >/dev/null
  echo "  $name <- $HOME_DIR/$f"
done

step "Service accounts"
for sa in "$JOB_SA" "$SCHED_SA"; do
  if ! gcloud iam service-accounts describe "$sa@$PROJECT.iam.gserviceaccount.com" \
       --project "$PROJECT" >/dev/null 2>&1; then
    gcloud iam service-accounts create "$sa" --project "$PROJECT" \
      --display-name "gcal-sync ${sa##gcal-sync-}"
  fi
  echo "  $sa@$PROJECT.iam.gserviceaccount.com"
done

# Read access per secret rather than project-wide: the job should not be able to
# read a secret that someone adds to this project later.
for f in "${FILES[@]}"; do
  gcloud secrets add-iam-policy-binding "$(secret_name "$f")" \
    --member "serviceAccount:$JOB_SA@$PROJECT.iam.gserviceaccount.com" \
    --role roles/secretmanager.secretAccessor \
    --project "$PROJECT" >/dev/null
done

step "Deploying the Cloud Run job (builds the image; first run takes a few minutes)"
SET_SECRETS=""
for f in "${FILES[@]}"; do
  SET_SECRETS+="$(env_name "$f")=$(secret_name "$f"):latest,"
done
SET_SECRETS="${SET_SECRETS%,}"

gcloud run jobs deploy "$JOB" \
  --source . \
  --region "$REGION" \
  --project "$PROJECT" \
  --service-account "$JOB_SA@$PROJECT.iam.gserviceaccount.com" \
  --set-secrets "$SET_SECRETS" \
  --max-retries 1 \
  --task-timeout 10m \
  --memory 512Mi \
  --cpu 1

# Only this job, not every service in the project.
gcloud run jobs add-iam-policy-binding "$JOB" \
  --member "serviceAccount:$SCHED_SA@$PROJECT.iam.gserviceaccount.com" \
  --role roles/run.invoker \
  --region "$REGION" \
  --project "$PROJECT" >/dev/null

step "Scheduling it"
URI="https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/$JOB:run"
if gcloud scheduler jobs describe "$SCHED_JOB" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  VERB=update
else
  VERB=create
fi
gcloud scheduler jobs "$VERB" http "$SCHED_JOB" \
  --location "$REGION" \
  --project "$PROJECT" \
  --schedule "$SCHEDULE" \
  --time-zone "Asia/Tokyo" \
  --uri "$URI" \
  --http-method POST \
  --oauth-service-account-email "$SCHED_SA@$PROJECT.iam.gserviceaccount.com" \
  --attempt-deadline 600s

cat <<EOF

────────────────────────────────────────────────────────────────────
Done. Verify with one run before trusting the schedule:

  gcloud scheduler jobs run $SCHED_JOB --location $REGION --project $PROJECT
  gcloud run jobs executions list --job $JOB --region $REGION --project $PROJECT
  gcloud run jobs executions logs read EXECUTION_NAME --region $REGION --project $PROJECT

If a local schedule is still installed, remove it so two schedulers do not
write to the same calendars:

  gcal-sync uninstall-cron

Re-run this script after any configuration change or re-authorisation.
────────────────────────────────────────────────────────────────────
EOF
