import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const PORT = parseInt(process.env.PORT || '3000', 10);
const LISTEN_PID = process.env.LISTEN_PID;
const LISTEN_FDS = process.env.LISTEN_FDS;
export const MERCHANT_BASE_URL = process.env.MERCHANT_BASE_URL || 'https://merchant.taler';
const MERCHANT_API_KEY = process.env.MERCHANT_API_KEY || '';
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
      const url = new URL(`/accounts/${encodeURIComponent(targetAccount)}`, BANK_URL);
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

  sendError(res, 404, 'Not found');
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
