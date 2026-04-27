#!/usr/bin/env bash
set -euo pipefail

# ── Load Test Runner ──
# Runs all load tests sequentially and reports results.
# Usage: ./load-tests/run-all.sh
#
# Environment variables (override in shell or .env):
#   SERVICE_A_URL        — Service A base URL
#   WS_GATEWAY_URL       — WebSocket Gateway URL (wss://…)
#   JWT_TOKEN            — Pre-fetched JWT (optional; auto-fetched if empty)
#   AWS_PROFILE          — AWS CLI profile for Cognito auth

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Install ws dependency if needed
if [ ! -d "node_modules/ws" ]; then
  echo "Installing ws dependency…"
  npm install --no-save ws 2>/dev/null
fi

echo ""
echo "╔═══════════════════════════════════════════════════╗"
echo "║       PCD Cloud Project — Load Test Suite         ║"
echo "╚═══════════════════════════════════════════════════╝"
echo ""
echo "Service A:  ${SERVICE_A_URL:-<not set — using default>}"
echo "WS Gateway: ${WS_GATEWAY_URL:-<not set — using default>}"
echo ""

TESTS=(
  "test-consistency-window.js"
  "test-burst.js"
  "test-throughput-latency.js"
  "test-lambda-throughput.js"
  "test-ws-reconnection.js"
  "test-resilience.js"
)

PASSED=0
FAILED=0

for test in "${TESTS[@]}"; do
  echo ""
  echo "▶ Running $test …"
  echo ""
  if node "$test"; then
    PASSED=$((PASSED + 1))
    echo ""
    echo "✓ $test completed"
  else
    FAILED=$((FAILED + 1))
    echo ""
    echo "✗ $test failed"
  fi
  echo ""
  echo "───────────────────────────────────────────────────"
done

echo ""
echo "╔═══════════════════════════════════════════════════╗"
echo "║  Results: $PASSED passed, $FAILED failed (${#TESTS[@]} total)  "
echo "╚═══════════════════════════════════════════════════╝"

# Generate RESULTS.md report
echo ""
echo "▶ Generating RESULTS.md report…"
node generate-report.js
