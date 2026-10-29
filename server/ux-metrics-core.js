import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function createUxMetrics(options) {
  const {
    dbPath,
    syncMs = 300000,
    maxRows = 100000,
    authToken = '',
  } = options;

  let db = null;
  let lastBackupAt = 0;
  let syncTimer = null;

  function now() {
    return Date.now();
  }

  function ensureInit() {
    if (db) return db;
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
        affects_experience INTEGER,
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
        affects_experience INTEGER,
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

    if (dbPath && fs.existsSync(dbPath)) {
      try {
        db.exec(`ATTACH '${dbPath.replace(/'/g, "''")}' AS backup_db`);
        migrateBackupColumn('events', 'affects_experience', 'INTEGER');
        migrateBackupColumn('requests', 'affects_experience', 'INTEGER');
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

    if (syncMs > 0 && dbPath) {
      syncTimer = setInterval(() => backup(), syncMs);
      syncTimer.unref?.();
    }

    process.on('SIGINT', backup);
    process.on('SIGTERM', backup);

    return db;
  }

  function migrateBackupColumn(table, column, type) {
    if (!db) return;
    const info = db.prepare(`PRAGMA backup_db.table_info(${table})`).all();
    const hasColumn = info.some((col) => col.name === column);
    if (!hasColumn) {
      db.exec(`ALTER TABLE backup_db.${table} ADD COLUMN ${column} ${type}`);
    }
  }

  function backup() {
    if (!db || !dbPath) return;
    const t = now();
    if (t - lastBackupAt < 1000) return;
    try {
      const tmpPath = path.join(path.dirname(dbPath), '.ux-metrics-tmp.sqlite');
      const safeTmp = tmpPath.replace(/'/g, "''");
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      db.exec(`VACUUM INTO '${safeTmp}'`);
      fs.renameSync(tmpPath, dbPath);
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
        if (count > maxRows) {
          const toDelete = count - maxRows;
          const del = db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} ORDER BY ts ASC LIMIT ?)`);
          del.run(toDelete);
        }
      } catch (e) {
        console.error('[ux-metrics] prune failed:', e.message);
      }
    }
  }

  function close() {
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
    backup();
    if (db) {
      try { db.close(); } catch {}
      db = null;
    }
  }

  function normalizeSessionId(sessionId) {
    return String(sessionId || 'unknown').slice(0, 64);
  }

  function trackEvent(sessionId, ev) {
    ensureInit();
    const stmt = db.prepare(`
      INSERT INTO events (ts, session_id, type, action, root_code, url, affects_experience, payload_json, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      Number(ev.ts) || now(),
      normalizeSessionId(sessionId),
      String(ev.type || 'event').slice(0, 64),
      ev.action ? String(ev.action).slice(0, 128) : null,
      ev.root_code ? String(ev.root_code).slice(0, 128) : null,
      ev.url ? String(ev.url).slice(0, 2048) : null,
      ev.affects_experience != null ? (ev.affects_experience ? 1 : 0) : null,
      ev.payload ? JSON.stringify(ev.payload) : null,
      now()
    );
  }

  function trackRequest(sessionId, req) {
    ensureInit();
    const stmt = db.prepare(`
      INSERT INTO requests (ts, session_id, method, url, status, duration_ms, error_code, affects_experience, payload_json, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      Number(req.ts) || now(),
      normalizeSessionId(sessionId),
      String(req.method || 'GET').slice(0, 16),
      String(req.url || '').slice(0, 2048),
      req.status != null ? Number(req.status) : null,
      req.duration_ms != null ? Number(req.duration_ms) : null,
      req.error_code ? String(req.error_code).slice(0, 128) : null,
      req.affects_experience != null ? (req.affects_experience ? 1 : 0) : null,
      req.payload ? JSON.stringify(req.payload) : null,
      now()
    );
  }

  function trackLoad(sessionId, load) {
    ensureInit();
    const stmt = db.prepare(`
      INSERT INTO loads (ts, session_id, url, load_ms, ttfb_ms, fcp_ms, lcp_ms, payload_json, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      Number(load.ts) || now(),
      normalizeSessionId(sessionId),
      load.url ? String(load.url).slice(0, 2048) : null,
      load.load_ms != null ? Number(load.load_ms) : null,
      load.ttfb_ms != null ? Number(load.ttfb_ms) : null,
      load.fcp_ms != null ? Number(load.fcp_ms) : null,
      load.lcp_ms != null ? Number(load.lcp_ms) : null,
      load.payload ? JSON.stringify(load.payload) : null,
      now()
    );
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

  async function handlePost(req, res) {
    ensureInit();
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid-json' });
      return;
    }

    const receivedAt = now();
    const sessionId = normalizeSessionId(body.session_id);

    db.exec('BEGIN TRANSACTION');
    try {
      if (Array.isArray(body.events)) {
        for (const ev of body.events) {
          trackEvent(sessionId, {
            ts: Number(ev.ts) || receivedAt,
            type: ev.type,
            action: ev.action,
            root_code: ev.root_code,
            url: ev.url,
            affects_experience: ev.affects_experience,
            payload: ev.payload,
          });
        }
      }

      if (Array.isArray(body.requests)) {
        for (const r of body.requests) {
          trackRequest(sessionId, {
            ts: Number(r.ts) || receivedAt,
            method: r.method,
            url: r.url,
            status: r.status,
            duration_ms: r.duration_ms,
            error_code: r.error_code,
            affects_experience: r.affects_experience,
            payload: r.payload,
          });
        }
      }

      if (Array.isArray(body.loads)) {
        for (const l of body.loads) {
          trackLoad(sessionId, {
            ts: Number(l.ts) || receivedAt,
            url: l.url,
            load_ms: l.load_ms,
            ttfb_ms: l.ttfb_ms,
            fcp_ms: l.fcp_ms,
            lcp_ms: l.lcp_ms,
            payload: l.payload,
          });
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

  function handleGet(req, res) {
    ensureInit();
    if (authToken) {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer ') || auth.substring(7) !== authToken) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
    }
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

  return {
    init: ensureInit,
    close,
    backup,
    trackEvent,
    trackRequest,
    trackLoad,
    handlePost,
    handleGet,
    get db() { return db; },
  };
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
