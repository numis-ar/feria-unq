/**
 * Fair payment demo server
 *
 * Run with one command (requires Node/npm):
 *   npx tsx /var/www/html/ia/server.ts
 *
 * Environment variables:
 *   PORT                - server port (default 3000)
 *   MERCHANT_BASE_URL   - merchant backend base URL (default https://merchant.taler)
 *   MERCHANT_API_KEY    - merchant backend API key, e.g. secret-token:xxx (default empty)
 */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const PORT = parseInt(process.env.PORT || '3000', 10);
const MERCHANT_BASE_URL = process.env.MERCHANT_BASE_URL || 'https://merchant.taler';
const MERCHANT_API_KEY = process.env.MERCHANT_API_KEY || '';
const GET_MONEY_SCRIPT = '/home/ia/wallet-get-money.sh';

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

function parseAmount(body: unknown): { ok: true; value: number } | { ok: false; error: string } {
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

async function callGetMoneyScript(amount: number): Promise<string> {
  const { stdout } = await execFileAsync(GET_MONEY_SCRIPT, [String(amount)], {
    cwd: '/home/ia',
  });
  return stdout.trim();
}

function handleWithdraw(req: http.IncomingMessage, res: http.ServerResponse, id: string) {
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

function merchantRequest(instanceId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(
      `/instances/${encodeURIComponent(instanceId)}/private/orders`,
      MERCHANT_BASE_URL,
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

async function handleLatestOrders(res: http.ServerResponse, instanceId: string) {
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

const server = http.createServer((req, res) => {
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

  sendError(res, 404, 'Not found');
});

server.listen(PORT, () => {
  log(`Server listening on http://localhost:${PORT}`);
});
