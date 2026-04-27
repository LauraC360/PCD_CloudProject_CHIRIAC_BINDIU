#!/usr/bin/env bash
# =============================================================================
# create-ssm-params.sh
# Creates SSM Parameter Store SecureString entries required by the Realtime
# Analytics Dashboard.
#
# Run BEFORE `cdk deploy`:
#   bash infrastructure/ssm/create-ssm-params.sh
#
# Run BEFORE Task 4 (App Runner setup):
#   bash infrastructure/ssm/create-ssm-params.sh --mongo
#
# Parameters:
#   /analytics/INTERNAL_SECRET  — auto-generated 32-char hex secret
#   /analytics/MONGO_URL        — MongoDB Atlas connection string (--mongo flag)
#
# Prerequisites:
#   - AWS CLI configured with profile `pers` and region `us-east-1`
#   - openssl available on PATH
#
# Idempotent: --overwrite means re-running updates the value safely.
# NEVER commit secrets to source control.
# =============================================================================

set -euo pipefail

PROFILE="pers"
REGION="us-east-1"
WITH_MONGO=false

for arg in "$@"; do
  case $arg in
    --mongo) WITH_MONGO=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

echo "============================================================"
echo "  SSM Parameter Store — Analytics Dashboard Setup"
echo "  Profile : ${PROFILE}"
echo "  Region  : ${REGION}"
echo "============================================================"
echo ""

# ---------------------------------------------------------------------------
# Parameter 1: /analytics/INTERNAL_SECRET (always created)
# openssl rand -hex 16 produces 32 lowercase hex characters.
# ---------------------------------------------------------------------------
echo "==> Generating /analytics/INTERNAL_SECRET ..."
INTERNAL_SECRET=$(openssl rand -hex 16)

aws ssm put-parameter \
  --profile "${PROFILE}" \
  --region "${REGION}" \
  --name "/analytics/INTERNAL_SECRET" \
  --value "${INTERNAL_SECRET}" \
  --type "SecureString" \
  --overwrite \
  --description "Shared secret for Lambda → WSG internal /notify authentication" \
  > /dev/null

echo "    ✓ /analytics/INTERNAL_SECRET created (value not shown)"
echo ""

# ---------------------------------------------------------------------------
# Parameter 2: /analytics/MONGO_URL (only with --mongo flag)
# Run this when setting up App Runner in Task 4.
# ---------------------------------------------------------------------------
if [ "${WITH_MONGO}" = true ]; then
  echo "==> Enter your MongoDB Atlas connection string for /analytics/MONGO_URL"
  echo "    (input is hidden — paste and press Enter)"
  read -r -s -p "    MONGO_URL: " MONGO_URL
  echo ""

  if [ -z "${MONGO_URL}" ]; then
    echo "ERROR: MONGO_URL cannot be empty. Aborting." >&2
    exit 1
  fi

  aws ssm put-parameter \
    --profile "${PROFILE}" \
    --region "${REGION}" \
    --name "/analytics/MONGO_URL" \
    --value "${MONGO_URL}" \
    --type "SecureString" \
    --overwrite \
    --description "MongoDB Atlas connection string for Service A (App Runner)" \
    > /dev/null

  echo "    ✓ /analytics/MONGO_URL created (value not shown)"
  echo ""
else
  echo "    ℹ  Skipping /analytics/MONGO_URL — run with --mongo flag when ready (Task 4)"
  echo ""
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "============================================================"
echo "  Done"
echo "============================================================"
if [ "${WITH_MONGO}" = true ]; then
  echo "  /analytics/INTERNAL_SECRET  ✓"
  echo "  /analytics/MONGO_URL        ✓"
  echo ""
  echo "  You can now run: cdk deploy --profile ${PROFILE}"
else
  echo "  /analytics/INTERNAL_SECRET  ✓"
  echo "  /analytics/MONGO_URL        skipped (run with --mongo when ready)"
  echo ""
  echo "  You can now run: cdk deploy --profile ${PROFILE}"
fi
echo "============================================================"
