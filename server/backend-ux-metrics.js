import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUxMetrics } from './ux-metrics-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let initialized = false;

const metrics = createUxMetrics({
  dbPath: process.env.BACKEND_UX_METRICS_DB_PATH || path.join(__dirname, '..', '.backend-ux-metrics.sqlite'),
  syncMs: parseInt(process.env.UX_METRICS_SYNC_MS || '300000', 10),
  maxRows: parseInt(process.env.UX_METRICS_MAX_ROWS || '100000', 10),
  authToken: process.env.UX_METRICS_AUTH_TOKEN || '',
});

export function initBackendUxMetrics() {
  if (initialized) return;
  metrics.init();
  initialized = true;
}

export function closeBackendUxMetrics() {
  metrics.close();
}

function ensureInit() {
  if (!initialized) return null;
  metrics.init();
  return metrics.db;
}

export function getSessionId(req) {
  const h = req.headers['x-session-id'];
  return typeof h === 'string' ? h.slice(0, 64) : 'unknown';
}

export function trackEvent(sessionId, data) {
  if (!ensureInit()) return;
  metrics.trackEvent(sessionId, data);
}

export function trackRequest(sessionId, data) {
  if (!ensureInit()) return;
  metrics.trackRequest(sessionId, data);
}

export function trackLoad(sessionId, data) {
  if (!ensureInit()) return;
  metrics.trackLoad(sessionId, data);
}

export async function handleUxMetricsPost(req, res) {
  metrics.init();
  await metrics.handlePost(req, res);
}

export function handleUxMetricsGet(req, res) {
  metrics.init();
  metrics.handleGet(req, res);
}
