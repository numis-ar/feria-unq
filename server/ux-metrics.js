import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.UX_METRICS_DB_PATH || path.join(__dirname, '..', '.ux-metrics.sqlite');
const SYNC_MS = parseInt(process.env.UX_METRICS_SYNC_MS || '300000', 10); // 5 min default
const MAX_ROWS = parseInt(process.env.UX_METRICS_MAX_ROWS || '100000', 10);

let db = null;
let lastBackupAt = 0;

function now() {
  return Date.now();
}

export function initUxMetrics() {
  if (db) return;
  db = new DatabaseSync(':memory:');

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      action TEXT,
      root_code TEXT,
      url TEXT,
      payload_json TEXT,
      received_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      status INTEGER,
      duration_ms INTEGER,
      error_code TEXT,
      payload_json TEXT,
      received_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS loads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      url TEXT,
      load_ms INTEGER,
      ttfb_ms INTEGER,
      fcp_ms INTEGER,
      lcp_ms INTEGER,
      payload_json TEXT,
      received_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);
    CREATE INDEX IF NOT EXISTS idx_loads_ts ON loads(ts);
  `);

  // Restore from disk if a previous backup exists so restarts do not lose history.
  if (fs.existsSync(DB_PATH)) {
    try {
      db.exec(`ATTACH '${DB_PATH.replace(/'/g, "''")}' AS backup_db`);
      db.exec(`
        INSERT OR IGNORE INTO events SELECT * FROM backup_db.events;
        INSERT OR IGNORE INTO requests SELECT * FROM backup_db.requests;
        INSERT OR IGNORE INTO loads SELECT * FROM backup_db.loads;
      `);
      db.exec('DETACH backup_db');
    } catch (e) {
      console.error('[ux-metrics] failed to restore previous db:', e.message);
    }
  }

  // Periodic persistence.
  const timer = setInterval(() => backupUxMetrics(), SYNC_MS);
  timer.unref?.();

  process.on('SIGINT', () => { backupUxMetrics(); });
  process.on('SIGTERM', () => { backupUxMetrics(); });
}

export function backupUxMetrics() {
  if (!db) return;
  const t = now();
  if (t - lastBackupAt < 1000) return; // avoid rapid rewrites
  try {
    const tmpPath = path.join(path.dirname(DB_PATH), '.ux-metrics-tmp.sqlite');
    const safeTmp = tmpPath.replace(/'/g, "''");
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    db.exec(`VACUUM INTO '${safeTmp}'`);
    fs.renameSync(tmpPath, DB_PATH);
    lastBackupAt = t;
    pruneOldRows();
  } catch (e) {
    console.error('[ux-metrics] backup failed:', e.message);
  }
}

function pruneOldRows() {
  if (!db) return;
  const tables = ['events', 'requests', 'loads'];
  for (const table of tables) {
    try {
      const countStmt = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`);
      const count = countStmt.get().c;
      if (count > MAX_ROWS) {
        const toDelete = count - MAX_ROWS;
        const del = db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} ORDER BY ts ASC LIMIT ?)`);
        del.run(toDelete);
      }
    } catch (e) {
      console.error('[ux-metrics] prune failed:', e.message);
    }
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

export async function handleUxMetricsPost(req, res) {
  if (!db) initUxMetrics();
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid-json' });
    return;
  }

  const receivedAt = now();
  const sessionId = String(body.session_id || 'unknown').slice(0, 64);

  const insertEvent = db.prepare(`
    INSERT INTO events (ts, session_id, type, action, root_code, url, payload_json, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRequest = db.prepare(`
    INSERT INTO requests (ts, session_id, method, url, status, duration_ms, error_code, payload_json, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertLoad = db.prepare(`
    INSERT INTO loads (ts, session_id, url, load_ms, ttfb_ms, fcp_ms, lcp_ms, payload_json, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec('BEGIN TRANSACTION');
  try {
    if (Array.isArray(body.events)) {
      for (const ev of body.events) {
        insertEvent.run(
          Number(ev.ts) || receivedAt,
          sessionId,
          String(ev.type || 'event').slice(0, 64),
          ev.action ? String(ev.action).slice(0, 128) : null,
          ev.root_code ? String(ev.root_code).slice(0, 128) : null,
          ev.url ? String(ev.url).slice(0, 2048) : null,
          ev.payload ? JSON.stringify(ev.payload) : null,
          receivedAt
        );
      }
    }

    if (Array.isArray(body.requests)) {
      for (const r of body.requests) {
        insertRequest.run(
          Number(r.ts) || receivedAt,
          sessionId,
          String(r.method || 'GET').slice(0, 16),
          String(r.url || '').slice(0, 2048),
          r.status != null ? Number(r.status) : null,
          r.duration_ms != null ? Number(r.duration_ms) : null,
          r.error_code ? String(r.error_code).slice(0, 128) : null,
          r.payload ? JSON.stringify(r.payload) : null,
          receivedAt
        );
      }
    }

    if (Array.isArray(body.loads)) {
      for (const l of body.loads) {
        insertLoad.run(
          Number(l.ts) || receivedAt,
          sessionId,
          l.url ? String(l.url).slice(0, 2048) : null,
          l.load_ms != null ? Number(l.load_ms) : null,
          l.ttfb_ms != null ? Number(l.ttfb_ms) : null,
          l.fcp_ms != null ? Number(l.fcp_ms) : null,
          l.lcp_ms != null ? Number(l.lcp_ms) : null,
          l.payload ? JSON.stringify(l.payload) : null,
          receivedAt
        );
      }
    }

    db.exec('COMMIT');
    sendJson(res, 204, { ok: true });
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[ux-metrics] ingest failed:', e.message);
    sendJson(res, 500, { error: 'ingest-failed' });
  }
}

export function handleUxMetricsGet(req, res) {
  if (!db) initUxMetrics();
  const url = new URL(req.url, 'http://localhost');
  const since = parseInt(url.searchParams.get('since') || '0', 10);
  const limit = Math.min(10000, parseInt(url.searchParams.get('limit') || '1000', 10));
  const type = url.searchParams.get('type');

  try {
    const params = [];
    const where = since ? 'WHERE ts >= ?' : '';
    if (since) params.push(since);

    let events = [];
    let requests = [];
    let loads = [];

    if (!type || type === 'events') {
      const stmt = db.prepare(`SELECT * FROM events ${where} ORDER BY ts DESC LIMIT ?`);
      events = stmt.all(...params, limit).map(row => ({ ...row, payload_json: undefined, payload: parsePayload(row.payload_json) }));
    }
    if (!type || type === 'requests') {
      const stmt = db.prepare(`SELECT * FROM requests ${where} ORDER BY ts DESC LIMIT ?`);
      requests = stmt.all(...params, limit).map(row => ({ ...row, payload_json: undefined, payload: parsePayload(row.payload_json) }));
    }
    if (!type || type === 'loads') {
      const stmt = db.prepare(`SELECT * FROM loads ${where} ORDER BY ts DESC LIMIT ?`);
      loads = stmt.all(...params, limit).map(row => ({ ...row, payload_json: undefined, payload: parsePayload(row.payload_json) }));
    }

    sendJson(res, 200, { events, requests, loads });
  } catch (e) {
    console.error('[ux-metrics] query failed:', e.message);
    sendJson(res, 500, { error: 'query-failed' });
  }
}

function parsePayload(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}
