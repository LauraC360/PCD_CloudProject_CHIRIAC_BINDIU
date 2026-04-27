'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// ── Result file helper ──

const RESULTS_DIR = path.join(__dirname, 'results');

function writeResult(name, data) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), ...data }, null, 2));
  console.log(`\n📄 Results written to ${file}`);
}

// ── JWT helper ──

let cachedToken = config.JWT_TOKEN || '';

function getJwt() {
  if (cachedToken) return cachedToken;
  console.log('[helpers] Fetching JWT from Cognito…');
  const cmd = [
    'aws cognito-idp initiate-auth',
    '--auth-flow USER_PASSWORD_AUTH',
    `--auth-parameters USERNAME=${config.COGNITO_USERNAME},PASSWORD='${config.COGNITO_PASSWORD}'`,
    `--client-id ${config.COGNITO_CLIENT_ID}`,
    `--profile ${config.AWS_PROFILE}`,
    `--region ${config.AWS_REGION}`,
    '--query "AuthenticationResult.IdToken"',
    '--output text',
  ].join(' ');
  cachedToken = execSync(cmd, { encoding: 'utf-8' }).trim();
  return cachedToken;
}

// ── HTTP helpers (native fetch, Node 18+) ──

async function getMovie(movieId) {
  const url = `${config.SERVICE_A_URL}${config.API_PREFIX}/movies/${movieId}`;
  const start = Date.now();
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${getJwt()}`,
      'X-Requested-At': String(Date.now()),
    },
  });
  const latencyMs = Date.now() - start;
  const body = res.ok ? await res.json() : null;
  return { status: res.status, latencyMs, body };
}

async function getHealth(baseUrl) {
  const url = baseUrl || config.WS_GATEWAY_HEALTH_URL;
  const res = await fetch(`${url}/health`);
  return res.ok ? res.json() : null;
}

async function getMetrics() {
  const url = `${config.SERVICE_A_URL}${config.API_PREFIX}/metrics`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${getJwt()}` },
  });
  return res.ok ? res.json() : null;
}

// ── Stats helpers ──

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computeStats(latencies) {
  if (latencies.length === 0) return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round(sum / sorted.length),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { getJwt, getMovie, getHealth, getMetrics, computeStats, sleep, writeResult };
