import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { URL } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const PORT = parseInt(process.env.PORT || '3000', 10);
const LISTEN_PID = process.env.LISTEN_PID;
const LISTEN_FDS = process.env.LISTEN_FDS;
export function getMerchantUrl() {
  return process.env.MERCHANT_BASE_URL || 'https://merchant.taler';
}
export const MERCHANT_API_KEY = process.env.MERCHANT_API_KEY || '';
const GET_MONEY_SCRIPT = 'wallet-get-money.sh';
export function getBankUrl() {
  return process.env.BANK_URL || 'https://bank.taler.ar';
}
export const RESTRICTED_ACCOUNTS = ['exchange', 'admin', 'closing_account'];
export const CLOSING_ACCOUNT = 'closing_account';

export async function handleVerifyAccount(req: http.IncomingMessage, res: http.ServerResponse, instanceId: string, targetAccount: string) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendError(res, 401, 'Unauthorized');
    return;
  }
  const token = authHeader.substring(7);

  if (RESTRICTED_ACCOUNTS.includes(targetAccount)) {
    sendError(res, 400, 'Transfer to this account is restricted');
    return;
  }

  try {
    const accountInfo = await new Promise<any>((resolve, reject) => {
      const url = new URL(`/accounts/${encodeURIComponent(targetAccount)}`, getBankUrl());
      const options: https.RequestOptions = {
        hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search, method: 'GET',
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
        rejectUnauthorized: false
      };
      const client = url.protocol === 'https:' ? https : http;
      const request = client.request(options, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          if (response.statusCode && response.statusCode >= 400) {
            reject(new Error(`Account not found or error: ${response.statusCode}`));
          } else {
            resolve(JSON.parse(data));
          }
        });
      });
      request.on('error', reject);
      request.end();
    });

    sendJson(res, 200, {
      username: targetAccount,
      name: accountInfo.name || targetAccount
    });
  } catch (e: any) {
    log('Account not found error:', e.message || e);
    sendError(res, 404, 'Account not found');
  }
}

export function proxyRequest(req: http.IncomingMessage, res: http.ServerResponse, targetBase: string, rest: string, authOverride?: string) {
  const target = new URL(rest.replace(/^\/+/, ''), targetBase.endsWith('/') ? targetBase : targetBase + '/');
  const options: https.RequestOptions = {
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: target.pathname + target.search,
    method: req.method,
    headers: {
      'Accept': req.headers.accept || 'application/json',
      'Authorization': authOverride !== undefined ? authOverride : (req.headers.authorization || ''),
    },
    rejectUnauthorized: false,
  };
  if (req.headers['content-type']) options.headers!['Content-Type'] = req.headers['content-type'];
  if (req.headers['content-length']) options.headers!['Content-Length'] = req.headers['content-length'];

  const client = target.protocol === 'https:' ? https : http;
  const upstream = client.request(options, (upRes) => {
    const headers: Record<string, string> = {};
    if (upRes.headers['content-type']) headers['Content-Type'] = upRes.headers['content-type'];
    res.writeHead(upRes.statusCode || 502, headers);
    upRes.pipe(res);
  });
  upstream.on('error', (e) => {
    log('Proxy error:', e.message || e);
    if (!res.headersSent) sendError(res, 502, 'Upstream request failed');
    else res.end();
  });
  req.pipe(upstream);
}

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function sendError(res: http.ServerResponse, status: number, message: string) {
  sendJson(res, status, { type: 'error', message });
}

export function parseAmount(body: unknown): { ok: true; value: number } | { ok: false; error: string } {
  if (!body || typeof (body as any).amount !== 'string') {
    return { ok: false, error: 'Missing amount' };
  }
  const match = (body as any).amount.match(/^NUMIS:(\d+)$/);
  if (!match) {
    return { ok: false, error: 'Invalid amount format, expected NUMIS:$NUMBER' };
  }
  const value = parseInt(match[1], 10);
  if (value <= 0 || value >= 99999) {
    return { ok: false, error: 'Amount must be greater than 0 and less than 99999' };
  }
  return { ok: true, value };
}

export async function callGetMoneyScript(amount: number): Promise<string> {
  const { stdout } = await execFileAsync(GET_MONEY_SCRIPT, [String(amount)]);
  return stdout.trim();
}

export async function handleCloseAccount(req: http.IncomingMessage, res: http.ServerResponse, instanceId: string) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendError(res, 401, 'Unauthorized');
    return;
  }
  const token = authHeader.substring(7);

  try {
    const bankHost = new URL(getBankUrl()).host;
    
    // 1. Fetch balance
    const balRes = await new Promise<any>((resolve, reject) => {
      const url = new URL(`/accounts/${encodeURIComponent(instanceId)}`, getBankUrl());
      const options: https.RequestOptions = {
        hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search, method: 'GET',
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
        rejectUnauthorized: false
      };
      const client = url.protocol === 'https:' ? https : http;
      const request = client.request(options, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          if (response.statusCode && response.statusCode >= 400) {
            reject(new Error(`Bank balance error: ${response.statusCode} ${data}`));
          } else {
            resolve(JSON.parse(data));
          }
        });
      });
      request.on('error', reject);
      request.end();
    });

    const amountStr = balRes.balance?.amount;
    if (!amountStr) {
      sendError(res, 400, 'No balance found');
      return;
    }

    // Parse amount to check if > 0
    let numericAmount = 0;
    if (typeof amountStr === 'string' && amountStr.includes(':')) {
      numericAmount = parseFloat(amountStr.split(':')[1]);
    } else {
      numericAmount = parseFloat(amountStr);
    }
    
    if (isNaN(numericAmount) || numericAmount <= 0) {
      sendJson(res, 200, { type: 'ok', message: 'Account balance is zero' });
      return;
    }

    // 2. Transfer all to closing_account
    const charset = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let request_uid = '';
    for(let i = 0; i < 52; i++) {
      request_uid += charset[Math.floor(Math.random() * charset.length)];
    }
    const randomId = Array.from({length: 6}, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
    const payto_uri = `payto://x-taler-bank/${bankHost}/${CLOSING_ACCOUNT}?message=Close-${randomId}`;
    const payload = JSON.stringify({
      payto_uri,
      amount: amountStr,
      request_uid
    });

    await new Promise<any>((resolve, reject) => {
      const url = new URL(`/accounts/${encodeURIComponent(instanceId)}/transactions`, getBankUrl());
      const options: https.RequestOptions = {
        hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search, method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        rejectUnauthorized: false
      };
      const client = url.protocol === 'https:' ? https : http;
      const request = client.request(options, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          if (response.statusCode && response.statusCode >= 400) {
            reject(new Error(`Bank transfer error: ${response.statusCode} ${data}`));
          } else {
            resolve(JSON.parse(data));
          }
        });
      });
      request.on('error', reject);
      request.write(payload);
      request.end();
    });

    sendJson(res, 200, { type: 'ok' });
  } catch (e: any) {
    log('Close account error:', e.message || e);
    sendError(res, 500, e.message || 'Internal error');
  }
}

export function handleWithdraw(req: http.IncomingMessage, res: http.ServerResponse, id: string) {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', async () => {
    try {
      const body = JSON.parse(raw);
      const parsed = parseAmount(body);
      if (!parsed.ok) {
        sendError(res, 400, parsed.error);
        return;
      }
      const amount = parsed.value;
      log(`Withdrawal request for "${id}": NUMIS:${amount}`);

      const output = await callGetMoneyScript(amount);
      log(`Script output: ${output}`);

      if (!output.startsWith('taler://pay-push/')) {
        sendJson(res, 200, { type: 'not-enough-funds' });
        return;
      }

      sendJson(res, 200, { type: 'ok', uri: output });
    } catch (e: any) {
      log('Script error:', e.message || e);
      sendJson(res, 200, { type: 'not-enough-funds' });
    }
  });
}

export function merchantRequest(instanceId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(
      `/instances/${encodeURIComponent(instanceId)}/private/orders`,
      getMerchantUrl(),
    );
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (MERCHANT_API_KEY) {
      headers['Authorization'] = `Bearer ${MERCHANT_API_KEY}`;
    }

    const client = url.protocol === 'https:' ? https : http;
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers,
      rejectUnauthorized: false,
    };

    const request = client.request(options, (response) => {
      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse merchant response: ${data}`));
        }
      });
    });
    request.on('error', reject);
    request.end();
  });
}

export async function handleLatestOrders(res: http.ServerResponse, instanceId: string) {
  try {
    const data = await merchantRequest(instanceId);
    const orders = Array.isArray(data) ? data : (data as any).orders || [];

    const paid = orders.filter((o: any) => o.payment_status === 'paid');
    const inTransit = paid.filter((o: any) => o.wire_transfer_status !== 'wired');
    const ready = orders.filter((o: any) => o.wire_transfer_status === 'wired');
    const latestPaid = paid
      .sort(
        (a: any, b: any) =>
          new Date(b.pay_timestamp || b.creation_timestamp).getTime() -
          new Date(a.pay_timestamp || a.creation_timestamp).getTime(),
      )
      .slice(0, 10);

    sendJson(res, 200, {
      paid: latestPaid,
      inTransit,
      ready,
    });
  } catch (e: any) {
    log('Failed to fetch merchant orders:', e.message);
    sendJson(res, 502, { type: 'error', message: 'Failed to fetch merchant orders' });
  }
}

// ---------------------------------------------------------------------------
// Shared upstream helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as any).unref?.();
  });
}

function upstreamJson(baseUrl: string, pathAndQuery: string, token?: string): Promise<{ status: number; json: any; networkError: boolean }> {
  return new Promise((resolve) => {
    const url = new URL(pathAndQuery, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      },
      rejectUnauthorized: false,
    };
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(options, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        let json: any = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* keep null */ }
        resolve({ status: response.statusCode || 0, json, networkError: false });
      });
    });
    request.on('error', () => resolve({ status: 0, json: null, networkError: true }));
    request.end();
  });
}

function amountToNumber(amt: unknown): number {
  if (!amt) return 0;
  if (typeof amt === 'string' && amt.includes(':')) return parseFloat(amt.split(':')[1]) || 0;
  return parseFloat(String(amt)) || 0;
}

function bearerToken(req: http.IncomingMessage, headerName: string): string | null {
  const h = req.headers[headerName];
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.substring(7);
  return null;
}

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Phase 1: REST aggregation endpoints
// ---------------------------------------------------------------------------

export async function handleApiState(req: http.IncomingMessage, res: http.ServerResponse, instance: string) {
  const merchantToken = bearerToken(req, 'authorization');
  const bankToken = bearerToken(req, 'x-bank-authorization');
  if (!merchantToken || !bankToken) {
    sendError(res, 401, 'Unauthorized');
    return;
  }
  const enc = encodeURIComponent(instance);
  try {
    const [ordersRes, paidRes, accountRes, txRes] = await Promise.all([
      upstreamJson(getMerchantUrl(), `/instances/${enc}/private/orders?limit=-10`, merchantToken),
      upstreamJson(getMerchantUrl(), `/instances/${enc}/private/orders?paid=yes&limit=-500`, merchantToken),
      upstreamJson(getBankUrl(), `/accounts/${enc}`, bankToken),
      upstreamJson(getBankUrl(), `/accounts/${enc}/transactions?limit=-10`, bankToken),
    ]);
    const results = [ordersRes, paidRes, accountRes, txRes];
    if (results.some((r) => r.status === 401 || r.status === 403)) {
      sendError(res, 401, 'Unauthorized');
      return;
    }
    if (results.some((r) => r.networkError || r.status < 200 || r.status >= 300)) {
      sendError(res, 502, 'Upstream request failed');
      return;
    }

    const orders = ordersRes.json?.orders ?? (Array.isArray(ordersRes.json) ? ordersRes.json : []);
    const paidList = paidRes.json?.orders ?? (Array.isArray(paidRes.json) ? paidRes.json : []);
    const transactions = txRes.json?.transactions ?? (Array.isArray(txRes.json) ? txRes.json : []);

    let sold = 0, settled = 0, inTransit = 0;
    for (const o of paidList) {
      const net = amountToNumber(o.amount) - amountToNumber(o.refund_amount);
      sold += net;
      if (o.wired || o.wire_transfer_status === 'wired') settled += net;
      else inTransit += net;
    }
    const bankAvailable = amountToNumber(accountRes.json?.balance?.amount);

    sendJson(res, 200, {
      accountName: accountRes.json?.name || instance,
      totals: { sold, inTransit, settled, bankAvailable },
      orders,
      transactions,
    });
  } catch (e: any) {
    log('API state error:', e.message || e);
    if (!res.headersSent) sendError(res, 502, 'Upstream request failed');
  }
}

// ---------------------------------------------------------------------------
// Phase 2: WebSocket (hand-rolled RFC 6455 server side)
// ---------------------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

class WsConnection {
  socket: net.Socket;
  buffer: Buffer = Buffer.alloc(0);
  alive = true;
  closing = false;
  authed = false;
  instance: string | null = null;
  merchantToken = '';
  bankToken = '';
  private fragOpcode = 0;
  private frags: Buffer[] = [];
  private pingTimer: NodeJS.Timeout | null = null;
  private authTimer: NodeJS.Timeout | null = null;

  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.feed(chunk));
    socket.on('error', () => this.terminate());
    socket.on('close', () => this.onSocketClosed());

    this.pingTimer = setInterval(() => {
      if (!this.alive) {
        this.terminate();
        return;
      }
      this.alive = false;
      this.sendFrame(0x9, Buffer.alloc(0));
    }, 30000);
    (this.pingTimer as any).unref?.();

    this.authTimer = setTimeout(() => {
      if (!this.authed) this.closeWith(4401, 'auth timeout');
    }, 10000);
    (this.authTimer as any).unref?.();
  }

  feed(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const buf = this.buffer;
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < off + 2) return;
        len = buf.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (buf.length < off + 8) return;
        const big = buf.readBigUInt64BE(off);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) { this.closeWith(1009, 'too big'); return; }
        len = Number(big);
        off += 8;
      }
      if (!masked) { this.closeWith(1002, 'unmasked frame'); return; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      off += 4;
      const payload = Buffer.from(buf.subarray(off, off + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buffer = buf.subarray(off + len);
      this.handleFrame(fin, opcode, payload);
      if (this.closing) return;
    }
  }

  private handleFrame(fin: number | boolean, opcode: number, payload: Buffer) {
    switch (opcode) {
      case 0x0: // continuation
        if (this.fragOpcode === 0) { this.closeWith(1002, 'unexpected continuation'); return; }
        this.frags.push(payload);
        if (fin) {
          const message = Buffer.concat(this.frags);
          const op = this.fragOpcode;
          this.fragOpcode = 0;
          this.frags = [];
          this.handleMessage(op, message);
        }
        return;
      case 0x1: // text
      case 0x2: // binary
        if (this.fragOpcode !== 0) { this.closeWith(1002, 'interleaved fragment'); return; }
        if (fin) { this.handleMessage(opcode, payload); return; }
        this.fragOpcode = opcode;
        this.frags = [payload];
        return;
      case 0x8: // close
        if (!this.closing) this.sendFrame(0x8, payload);
        this.terminate();
        return;
      case 0x9: // ping
        this.sendFrame(0xA, payload);
        return;
      case 0xA: // pong
        this.alive = true;
        return;
      default:
        this.closeWith(1002, 'unknown opcode');
    }
  }

  private handleMessage(opcode: number, payload: Buffer) {
    if (opcode !== 0x1) return; // only text messages are part of the protocol
    if (this.authed) return;
    let msg: any;
    try { msg = JSON.parse(payload.toString('utf8')); } catch { this.closeWith(4400, 'bad json'); return; }
    if (msg.type !== 'auth' || typeof msg.instance !== 'string' || !msg.instance) {
      this.closeWith(4400, 'expected auth frame');
      return;
    }
    const merchantToken = typeof msg.merchantToken === 'string' ? msg.merchantToken : '';
    const bankToken = typeof msg.bankToken === 'string' ? msg.bankToken : '';
    if (!merchantToken || !bankToken) { this.closeWith(4401, 'missing tokens'); return; }
    const instance = msg.instance;
    upstreamJson(getBankUrl(), `/accounts/${encodeURIComponent(instance)}`, bankToken).then((r) => {
      if (this.closing) return;
      if (r.status !== 200) { this.closeWith(4401, 'auth failed'); return; }
      this.authed = true;
      this.instance = instance;
      this.merchantToken = merchantToken;
      this.bankToken = bankToken;
      if (this.authTimer) { clearTimeout(this.authTimer); this.authTimer = null; }
      addClientToWatcher(this);
      this.sendText(JSON.stringify({ type: 'ready' }));
    });
  }

  sendFrame(opcode: number, payload: Buffer) {
    if (this.socket.destroyed) return;
    try { this.socket.write(encodeWsFrame(opcode, payload)); } catch { /* socket gone */ }
  }

  sendText(text: string) {
    this.sendFrame(0x1, Buffer.from(text, 'utf8'));
  }

  closeWith(code: number, reason: string) {
    if (this.closing) return;
    this.closing = true;
    const reasonBuf = Buffer.from(reason, 'utf8').subarray(0, 120);
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this.sendFrame(0x8, payload);
    setTimeout(() => this.terminate(), 250).unref?.();
  }

  terminate() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.authTimer) { clearTimeout(this.authTimer); this.authTimer = null; }
    try { this.socket.destroy(); } catch { /* already gone */ }
  }

  private onSocketClosed() {
    this.terminate();
    if (this.authed && this.instance) removeClientFromWatcher(this);
  }
}

// --- watcher registry ------------------------------------------------------

interface Watcher {
  instance: string;
  clients: Set<WsConnection>;
  merchantToken: string;
  bankToken: string;
  ordersSig?: string;
  txSig?: string;
  running: boolean;
  graceTimer?: NodeJS.Timeout;
}

const watchers = new Map<string, Watcher>();

function addClientToWatcher(conn: WsConnection) {
  const instance = conn.instance!;
  let w = watchers.get(instance);
  if (w) {
    if (w.graceTimer) { clearTimeout(w.graceTimer); w.graceTimer = undefined; }
    w.clients.add(conn);
    w.merchantToken = conn.merchantToken;
    w.bankToken = conn.bankToken;
    if (!w.running) { w.running = true; void runWatcher(w); }
  } else {
    w = {
      instance,
      clients: new Set([conn]),
      merchantToken: conn.merchantToken,
      bankToken: conn.bankToken,
      running: true,
    };
    watchers.set(instance, w);
    void runWatcher(w);
  }
}

function removeClientFromWatcher(conn: WsConnection) {
  const w = watchers.get(conn.instance!);
  if (!w) return;
  w.clients.delete(conn);
  if (w.clients.size > 0) return;
  w.graceTimer = setTimeout(() => {
    if (w.clients.size === 0) {
      w.running = false;
      watchers.delete(w.instance);
    }
  }, 30000);
  (w.graceTimer as any).unref?.();
}

function broadcast(w: Watcher, text: string) {
  for (const client of w.clients) {
    if (!client.socket.destroyed) client.sendText(text);
  }
}

async function runWatcher(w: Watcher) {
  await Promise.all([watchOrdersLoop(w), watchTransactionsLoop(w)]);
}

function ordersSignature(orders: any[]): string {
  return JSON.stringify(orders.map((o) => [
    o.order_id, o.payment_status ?? o.order_status, o.wire_transfer_status, !!o.wired, o.amount, o.refund_amount,
  ]));
}

async function watchOrdersLoop(w: Watcher) {
  const enc = encodeURIComponent(w.instance);
  while (w.running) {
    try {
      const [recentRes, paidRes] = await Promise.all([
        upstreamJson(getMerchantUrl(), `/instances/${enc}/private/orders?limit=-10`, w.merchantToken),
        upstreamJson(getMerchantUrl(), `/instances/${enc}/private/orders?paid=yes&limit=-500`, w.merchantToken),
      ]);
      if (recentRes.status === 200 && paidRes.status === 200) {
        const recent = recentRes.json?.orders ?? (Array.isArray(recentRes.json) ? recentRes.json : []);
        const paid = paidRes.json?.orders ?? (Array.isArray(paidRes.json) ? paidRes.json : []);
        const sig = ordersSignature(recent) + '|' + ordersSignature(paid);
        if (w.ordersSig !== undefined && sig !== w.ordersSig) {
          broadcast(w, JSON.stringify({ type: 'orders-changed' }));
          void sendPushTick(w.instance);
        }
        w.ordersSig = sig;
        let maxRowId = 0;
        if (recent.length > 0 && recent[0].row_id) maxRowId = recent[0].row_id;
        await upstreamJson(getMerchantUrl(), `/instances/${enc}/private/orders?limit=2&offset=${maxRowId}&timeout_ms=10000`, w.merchantToken);
      } else {
        await sleep(3000);
      }
    } catch {
      await sleep(3000);
    }
  }
}

async function watchTransactionsLoop(w: Watcher) {
  const enc = encodeURIComponent(w.instance);
  while (w.running) {
    try {
      const res = await upstreamJson(getBankUrl(), `/accounts/${enc}/transactions?limit=-10`, w.bankToken);
      if (res.status === 200) {
        const txs = res.json?.transactions ?? (Array.isArray(res.json) ? res.json : []);
        const sig = JSON.stringify(txs.map((tx: any) => [tx.row_id, tx.amount, tx.subject]));
        if (w.txSig !== undefined && sig !== w.txSig) {
          broadcast(w, JSON.stringify({ type: 'tx-changed' }));
          void sendPushTick(w.instance);
        }
        w.txSig = sig;
        let maxRowId = 0;
        if (txs.length > 0 && txs[0].row_id) maxRowId = txs[0].row_id;
        await upstreamJson(getBankUrl(), `/accounts/${enc}/transactions?limit=2&offset=${maxRowId}&timeout_ms=10000`, w.bankToken);
      } else {
        await sleep(3000);
      }
    } catch {
      await sleep(3000);
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Web Push (VAPID + hand-rolled sender)
// ---------------------------------------------------------------------------

export interface VapidKeys {
  publicKey: string;   // base64url(x || y), 64 bytes
  privateKey: string;  // base64url(d)
  x: string;           // base64url JWK components (for signing)
  y: string;
  d: string;
}

let vapidCache: VapidKeys | null = null;

function vapidFile(): string {
  return process.env.VAPID_FILE || path.join(process.cwd(), '.vapid.json');
}

function generateVapidKeys(): VapidKeys {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privJwk = privateKey.export({ format: 'jwk' }) as { d: string };
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x = Buffer.from(pubJwk.x, 'base64url');
  const y = Buffer.from(pubJwk.y, 'base64url');
  return {
    publicKey: Buffer.concat([x, y]).toString('base64url'),
    privateKey: privJwk.d,
    x: pubJwk.x,
    y: pubJwk.y,
    d: privJwk.d,
  };
}

function deriveVapidKeys(publicKey: string, privateKey: string): VapidKeys {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'));
  const pub = ecdh.getPublicKey(); // 65-byte uncompressed point
  const x = pub.subarray(1, 33).toString('base64url');
  const y = pub.subarray(33, 65).toString('base64url');
  const derived = Buffer.concat([pub.subarray(1, 33), pub.subarray(33, 65)]).toString('base64url');
  if (derived !== publicKey) {
    log('WARNING: VAPID_PUBLIC_KEY does not match VAPID_PRIVATE_KEY; using the derived public key');
  }
  return {
    publicKey: derived,
    privateKey,
    x,
    y,
    d: privateKey,
  };
}

export function getVapidKeys(): VapidKeys {
  if (vapidCache) return vapidCache;
  const envPub = process.env.VAPID_PUBLIC_KEY;
  const envPriv = process.env.VAPID_PRIVATE_KEY;
  if (envPub && envPriv) {
    vapidCache = deriveVapidKeys(envPub, envPriv);
    return vapidCache;
  }
  try {
    const raw = fs.readFileSync(vapidFile(), 'utf8');
    const parsed = JSON.parse(raw) as VapidKeys;
    // sanity: the public key must be a valid P-256 point (64 bytes)
    if (Buffer.from(parsed.publicKey, 'base64url').length === 64) {
      vapidCache = parsed;
      return vapidCache;
    }
    log('WARNING: stored VAPID keys are invalid; regenerating');
  } catch { /* not persisted yet */ }
  vapidCache = generateVapidKeys();
  try {
    fs.writeFileSync(vapidFile(), JSON.stringify(vapidCache, null, 2));
  } catch (e) {
    log('Could not persist VAPID keys:', e);
  }
  return vapidCache;
}

export function resetVapidKeysForTests() {
  vapidCache = null;
}

function derToRawSignature(der: Buffer): Buffer {
  let off = 0;
  if (der[off] !== 0x30) throw new Error('Invalid DER signature');
  off += 2;
  const readInt = (): Buffer => {
    if (der[off] !== 0x02) throw new Error('Invalid DER integer');
    let len = der[off + 1];
    off += 2;
    let val = der.subarray(off, off + len);
    off += len;
    while (val.length > 1 && val[0] === 0) val = val.subarray(1);
    return val;
  };
  const pad32 = (b: Buffer): Buffer => {
    if (b.length === 32) return b;
    if (b.length > 32) return b.subarray(b.length - 32);
    const out = Buffer.alloc(32);
    b.copy(out, 32 - b.length);
    return out;
  };
  return Buffer.concat([pad32(readInt()), pad32(readInt())]);
}

export function buildVapidJwt(endpointUrl: string, keys: VapidKeys, subject?: string, now?: number): string {
  const aud = new URL(endpointUrl).origin;
  const sub = subject || process.env.VAPID_SUBJECT || 'mailto:admin@unq.numis.ar';
  const exp = (now ?? Math.floor(Date.now() / 1000)) + 12 * 3600;
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ aud, exp, sub })).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const priv = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: keys.x, y: keys.y, d: keys.d },
    format: 'jwk',
  });
  const der = crypto.sign('sha256', Buffer.from(signingInput), priv);
  return `${signingInput}.${derToRawSignature(der).toString('base64url')}`;
}

export function verifyVapidJwt(jwt: string, keys: VapidKeys): boolean {
  const [header, payload, signature] = jwt.split('.');
  const pub = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: keys.x, y: keys.y },
    format: 'jwk',
  });
  const sig = Buffer.from(signature, 'base64url');
  if (sig.length !== 64) return false;
  const r = sig.subarray(0, 32);
  const s = sig.subarray(32, 64);
  const encInt = (b: Buffer) => {
    const needsPad = b[0] & 0x80;
    const body = needsPad ? Buffer.concat([Buffer.from([0]), b]) : b;
    return Buffer.concat([Buffer.from([0x02, body.length]), body]);
  };
  const seqBody = Buffer.concat([encInt(r), encInt(s)]);
  const der = Buffer.concat([Buffer.from([0x30, seqBody.length]), seqBody]);
  return crypto.verify('sha256', Buffer.from(`${header}.${payload}`), pub, der);
}

// --- subscription store ----------------------------------------------------

export interface PushSubscriptionData {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const subscriptionStores = new Map<string, Record<string, PushSubscriptionData[]>>();

function subscriptionsFile(): string {
  return process.env.PUSH_SUBSCRIPTIONS_FILE || path.join(process.cwd(), '.push-subscriptions.json');
}

function loadSubscriptions(): Record<string, PushSubscriptionData[]> {
  const file = subscriptionsFile();
  const cached = subscriptionStores.get(file);
  let store: Record<string, PushSubscriptionData[]>;
  if (cached) {
    store = cached;
  } else {
    try {
      store = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      store = {};
    }
  }
  subscriptionStores.set(file, store);
  return store;
}

function saveSubscriptions(store: Record<string, PushSubscriptionData[]>) {
  subscriptionStores.set(subscriptionsFile(), store);
  try {
    fs.writeFileSync(subscriptionsFile(), JSON.stringify(store, null, 2));
  } catch (e) {
    log('Could not persist push subscriptions:', e);
  }
}

export function addSubscription(instance: string, subscription: PushSubscriptionData): void {
  const store = loadSubscriptions();
  const list = store[instance] || (store[instance] = []);
  if (!list.some((s) => s.endpoint === subscription.endpoint)) {
    list.push(subscription);
  }
  saveSubscriptions(store);
}

export function removeSubscription(instance: string, endpoint: string): void {
  const store = loadSubscriptions();
  if (!store[instance]) return;
  store[instance] = store[instance].filter((s) => s.endpoint !== endpoint);
  saveSubscriptions(store);
}

export function getSubscriptions(instance: string): PushSubscriptionData[] {
  const store = loadSubscriptions();
  return store[instance] || [];
}

// --- RFC 8291 aes128gcm payload encryption (hand-rolled, zero deps) ---------

const CEK_INFO = Buffer.concat([
  Buffer.from('Content-Encoding: aes128gcm', 'utf8'), Buffer.from([0x00]),
  Buffer.from('P-256', 'utf8'), Buffer.from([0x00]),
  Buffer.from('CEK', 'utf8'), Buffer.from([0x00]),
  Buffer.from('Content-Encoding: aes128gcm', 'utf8'),
]);

const NONCE_INFO = Buffer.concat([
  Buffer.from('Content-Encoding: aes128gcm', 'utf8'), Buffer.from([0x00]),
  Buffer.from('P-256', 'utf8'), Buffer.from([0x00]),
  Buffer.from('Nonce', 'utf8'), Buffer.from([0x00]),
  Buffer.from('Content-Encoding: aes128gcm', 'utf8'),
]);

const IKM_INFO_PREFIX = Buffer.concat([
  Buffer.from('Content-Encoding: aes128gcm', 'utf8'), Buffer.from([0x00]),
  Buffer.from('P-256', 'utf8'), Buffer.from([0x00]),
  Buffer.from('WebPush: info', 'utf8'), Buffer.from([0x00]),
]);

export interface Aes128GcmEncrypted {
  body: Buffer;                  // RFC 8188 aes128gcm header + encrypted record + tag
  salt: Buffer;                  // 16 bytes
  rs: number;                    // record size (4096)
  keyid: Buffer;                 // ephemeral public key (65 bytes, uncompressed point)
  ephemeralPrivateKey: Buffer;   // 32 bytes (returned so callers/tests can recompute the shared secret)
}

export function encryptAes128Gcm(
  subscription: PushSubscriptionData,
  plaintext: string | Buffer,
  ephemeralPrivateKey?: Buffer,
  salt?: Buffer,
): Aes128GcmEncrypted {
  const uaPublic = Buffer.from(subscription.keys.p256dh, 'base64url'); // 65-byte uncompressed point
  const auth = Buffer.from(subscription.keys.auth, 'base64url');       // 16 bytes

  const ecdh = crypto.createECDH('prime256v1');
  if (ephemeralPrivateKey) {
    ecdh.setPrivateKey(ephemeralPrivateKey);
  } else {
    ecdh.generateKeys();
  }
  const asPublic = ecdh.getPublicKey(); // 65 bytes
  const ecdhSecret = ecdh.computeSecret(uaPublic); // 32-byte X coordinate

  const actualSalt = salt || crypto.randomBytes(16);

  // RFC 8291 §4: first HKDF stage binds the auth secret to the ECDH shared secret
  const prkKey = crypto.createHmac('sha256', auth).update(ecdhSecret).digest();
  const ikmInfo = Buffer.concat([IKM_INFO_PREFIX, uaPublic, asPublic]);
  const ikm = crypto.createHmac('sha256', prkKey).update(Buffer.concat([ikmInfo, Buffer.from([0x01])])).digest();
  // Second stage: HKDF-Extract with the record salt, then expand CEK and nonce
  const prk = crypto.createHmac('sha256', actualSalt).update(ikm).digest();
  const cekKey = crypto.createHmac('sha256', prk).update(Buffer.concat([CEK_INFO, Buffer.from([0x01])])).digest().subarray(0, 16);
  const nonce = crypto.createHmac('sha256', prk).update(Buffer.concat([NONCE_INFO, Buffer.from([0x01])])).digest().subarray(0, 12);

  // RFC 8188 §2 aes128gcm record: plaintext || padding delimiter 0x02, single record
  const content = Buffer.concat([Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8'), Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cekKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(content), cipher.final()]);
  const record = Buffer.concat([ciphertext, cipher.getAuthTag()]);

  // RFC 8188 aes128gcm header: salt(16) || rs(4, BE) || idlen(1) || keyid
  const rs = 4096;
  const header = Buffer.alloc(16 + 4 + 1);
  actualSalt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header[20] = asPublic.length;
  const body = Buffer.concat([header, asPublic, record]);

  return { body, salt: actualSalt, rs, keyid: asPublic, ephemeralPrivateKey: ecdh.getPrivateKey() };
}

// --- push sender ------------------------------------------------------------

const lastPushAt = new Map<string, number>();

function postPush(endpoint: string, keys: VapidKeys, subject: string, payloadBody?: Buffer): Promise<number> {
  const url = new URL(endpoint);
  const jwt = buildVapidJwt(endpoint, keys, subject);
  const headers: Record<string, string> = {
    'TTL': '60',
    'Authorization': `vapid t=${jwt}, k=${keys.publicKey}`,
  };
  if (payloadBody) {
    headers['Content-Encoding'] = 'aes128gcm';
    headers['Content-Type'] = 'application/octet-stream';
    headers['Content-Length'] = String(payloadBody.length);
  } else {
    headers['Content-Length'] = '0';
  }
  return new Promise((resolve) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers,
      rejectUnauthorized: false,
    }, (response) => {
      response.resume();
      resolve(response.statusCode || 0);
    });
    request.on('error', () => resolve(0));
    if (payloadBody) request.write(payloadBody);
    request.end();
  });
}

export async function sendPushTick(instance: string): Promise<void> {
  const now = Date.now();
  const last = lastPushAt.get(instance) || 0;
  if (now - last < 30000) return;
  lastPushAt.set(instance, now);
  const keys = getVapidKeys();
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@unq.numis.ar';
  for (const sub of getSubscriptions(instance)) {
    try {
      const status = await postPush(sub.endpoint, keys, subject);
      if (status === 404 || status === 410) removeSubscription(instance, sub.endpoint);
    } catch { /* ignore individual push errors */ }
  }
}

// --- admin notifications ----------------------------------------------------

function allInstances(): string[] {
  return Object.keys(loadSubscriptions());
}

export async function sendAdminNotification(opts: { message: string; title?: string; instance?: string }): Promise<number> {
  const keys = getVapidKeys();
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@unq.numis.ar';
  const targets = (!opts.instance || opts.instance === 'all')
    ? allInstances()
    : [opts.instance];
  const body = JSON.stringify({ title: opts.title || 'FairPay', message: opts.message });
  let sent = 0;
  for (const instance of targets) {
    for (const sub of getSubscriptions(instance)) {
      try {
        const encrypted = encryptAes128Gcm(sub, body);
        const status = await postPush(sub.endpoint, keys, subject, encrypted.body);
        if (status >= 200 && status < 300) sent++;
        if (status === 404 || status === 410) removeSubscription(instance, sub.endpoint);
      } catch { /* ignore individual push errors */ }
    }
  }
  return sent;
}

export async function handleAdminNotify(req: http.IncomingMessage, res: http.ServerResponse) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken || req.headers['x-admin-token'] !== adminToken) {
    sendError(res, 403, 'Forbidden');
    return;
  }
  try {
    const body = await readJsonBody(req);
    if (typeof body?.message !== 'string' || !body.message) {
      sendError(res, 400, 'Missing message');
      return;
    }
    const sent = await sendAdminNotification({
      message: body.message,
      title: typeof body.title === 'string' ? body.title : undefined,
      instance: typeof body.instance === 'string' ? body.instance : undefined,
    });
    sendJson(res, 200, { sent });
  } catch {
    sendError(res, 400, 'Invalid JSON body');
  }
}

export async function handlePushSubscribe(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = await readJsonBody(req);
    const instance = body?.instance;
    const subscription = body?.subscription;
    if (typeof instance !== 'string' || !instance || !subscription || typeof subscription.endpoint !== 'string') {
      sendError(res, 400, 'Invalid subscription');
      return;
    }
    addSubscription(instance, {
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.keys?.p256dh || '',
        auth: subscription.keys?.auth || '',
      },
    });
    sendJson(res, 200, { type: 'ok' });
  } catch {
    sendError(res, 400, 'Invalid JSON body');
  }
}

export async function handlePushUnsubscribe(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = await readJsonBody(req);
    const instance = body?.instance;
    const endpoint = body?.endpoint;
    if (typeof instance !== 'string' || typeof endpoint !== 'string') {
      sendError(res, 400, 'Invalid request');
      return;
    }
    removeSubscription(instance, endpoint);
    sendJson(res, 200, { type: 'ok' });
  } catch {
    sendError(res, 400, 'Invalid JSON body');
  }
}

export const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const baseUrl = `http://${req.headers.host || 'localhost'}`;
  const parsedUrl = new URL(req.url || '/', baseUrl);
  const path = parsedUrl.pathname;

  if (req.method === 'POST' && path === '/get-money') {
    handleWithdraw(req, res, 'default');
    return;
  }

  const verifyMatch = path.match(/^\/get-money\/([^/]+)\/verify-account\/([^/]+)$/);
  if (req.method === 'GET' && verifyMatch) {
    handleVerifyAccount(req, res, verifyMatch[1], verifyMatch[2]).catch((e) => {
      log(e);
      sendError(res, 500, 'Internal server error');
    });
    return;
  }

  const closeMatch = path.match(/^\/get-money\/([^/]+)\/close-account$/);
  if (req.method === 'POST' && closeMatch) {
    handleCloseAccount(req, res, closeMatch[1]).catch((e) => {
      log(e);
      sendError(res, 500, 'Internal server error');
    });
    return;
  }

  const withdrawMatch = path.match(/^\/([^/]+)\/withdraw$/);
  if (req.method === 'POST' && withdrawMatch) {
    handleWithdraw(req, res, withdrawMatch[1]);
    return;
  }

  const ordersMatch = path.match(/^\/([^/]+)\/latest-orders$/);
  if (req.method === 'GET' && ordersMatch) {
    handleLatestOrders(res, ordersMatch[1]).catch((e) => {
      log(e);
      sendError(res, 500, 'Internal server error');
    });
    return;
  }

  if (path === '/api/config' && req.method === 'GET') {
    sendJson(res, 200, { bankHost: new URL(getBankUrl()).host });
    return;
  }

  const apiStateMatch = path.match(/^\/api\/state\/([^/]+)$/);
  if (req.method === 'GET' && apiStateMatch) {
    handleApiState(req, res, apiStateMatch[1]).catch((e) => {
      log(e);
      if (!res.headersSent) sendError(res, 500, 'Internal server error');
    });
    return;
  }

  const apiOrdersMatch = path.match(/^\/api\/orders\/([^/]+)$/);
  if (req.method === 'GET' && apiOrdersMatch) {
    const enc = encodeURIComponent(apiOrdersMatch[1]);
    proxyRequest(req, res, getMerchantUrl(), `instances/${enc}/private/orders${parsedUrl.search}`);
    return;
  }

  const apiTransactionsMatch = path.match(/^\/api\/transactions\/([^/]+)$/);
  if (req.method === 'GET' && apiTransactionsMatch) {
    const enc = encodeURIComponent(apiTransactionsMatch[1]);
    const bankAuth = req.headers['x-bank-authorization'];
    proxyRequest(req, res, getBankUrl(), `accounts/${enc}/transactions${parsedUrl.search}`, typeof bankAuth === 'string' ? bankAuth : undefined);
    return;
  }

  if (path === '/api/push/vapid-key' && req.method === 'GET') {
    sendJson(res, 200, { publicKey: getVapidKeys().publicKey });
    return;
  }

  if (path === '/api/push/subscribe' && req.method === 'POST') {
    handlePushSubscribe(req, res);
    return;
  }

  if (path === '/api/push/unsubscribe' && req.method === 'POST') {
    handlePushUnsubscribe(req, res);
    return;
  }

  if (path === '/api/admin/notify' && req.method === 'POST') {
    handleAdminNotify(req, res);
    return;
  }

  const apiMerchantMatch = path.match(/^\/api\/merchant\/(.*)$/);
  if (apiMerchantMatch) {
    proxyRequest(req, res, getMerchantUrl(), apiMerchantMatch[1] + parsedUrl.search);
    return;
  }

  const apiBankMatch = path.match(/^\/api\/bank\/(.*)$/);
  if (apiBankMatch) {
    proxyRequest(req, res, getBankUrl(), apiBankMatch[1] + parsedUrl.search);
    return;
  }

  sendError(res, 404, 'Not found');
});

server.on('upgrade', (req, socket: net.Socket, head) => {
  let pathname = '/';
  try {
    pathname = new URL(req.url || '/', 'http://localhost').pathname;
  } catch { /* keep default */ }
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  const conn = new WsConnection(socket);
  if (head && head.length > 0) conn.feed(head);
});

import { pathToFileURL } from 'url';

// Avoid listening when required as a module (e.g. in tests)
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (LISTEN_PID && parseInt(LISTEN_PID, 10) === process.pid && parseInt(LISTEN_FDS, 10) > 0) {
    server.listen({ fd: 3 }, () => {
      console.log('Server executing via systemd socket activation (FD 3)');
    });
  } else {
    server.listen(PORT, () => {
      console.log(`Server executing at http://localhost:${PORT}/`);
    });
  }
}
