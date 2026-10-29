import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUxMetrics } from './ux-metrics-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const metrics = createUxMetrics({
  dbPath: process.env.UX_METRICS_DB_PATH || path.join(__dirname, '..', '.ux-metrics.sqlite'),
  syncMs: parseInt(process.env.UX_METRICS_SYNC_MS || '300000', 10),
  maxRows: parseInt(process.env.UX_METRICS_MAX_ROWS || '100000', 10),
  authToken: process.env.UX_METRICS_AUTH_TOKEN || '',
});

export const initUxMetrics = metrics.init;
export const backupUxMetrics = metrics.backup;
export const handleUxMetricsPost = metrics.handlePost;
export const handleUxMetricsGet = metrics.handleGet;
