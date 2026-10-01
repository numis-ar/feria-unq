import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as crypto from 'crypto';
import request from 'supertest';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { server, CLOSING_ACCOUNT } from '../server/backend.ts';
import { parseAmount } from '../server/backend.ts';
import {
  getVapidKeys,
  resetVapidKeysForTests,
  buildVapidJwt,
  verifyVapidJwt,
  addSubscription,
  removeSubscription,
  getSubscriptions,
  encryptAes128Gcm,
} from '../server/backend.ts';

describe('Backend tests', () => {
  let mockBankServer: http.Server;
  let mockBankPort: number;
  let mockBankHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  let mockMerchantServer: http.Server;
  let mockMerchantPort: number;
  let mockMerchantHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  beforeEach(async () => {
    await new Promise<void>((resolve) => {
      mockBankHandler = (req, res) => {
        res.writeHead(500);
        res.end();
      };
      mockBankServer = http.createServer((req, res) => {
        mockBankHandler(req, res);
      });
      mockBankServer.listen(0, () => {
        const addr = mockBankServer.address() as import('net').AddressInfo;
        mockBankPort = addr.port;
        process.env.BANK_URL = `http://localhost:${mockBankPort}`;
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      mockMerchantHandler = (req, res) => {
        res.writeHead(500);
        res.end();
      };
      mockMerchantServer = http.createServer((req, res) => {
        mockMerchantHandler(req, res);
      });
      mockMerchantServer.listen(0, () => {
        const addr = mockMerchantServer.address() as import('net').AddressInfo;
        mockMerchantPort = addr.port;
        process.env.MERCHANT_BASE_URL = `http://localhost:${mockMerchantPort}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      mockBankServer.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      mockMerchantServer.close(() => resolve());
    });
  });

  describe('parseAmount()', () => {
    it('should parse valid amount', () => {
      const res = parseAmount({ amount: 'NUMIS:50' });
      assert.deepStrictEqual(res, { ok: true, value: 50 });
    });
    
    it('should return error for invalid strings', () => {
      const res = parseAmount({ amount: 'USD:50' });
      assert.strictEqual(res.ok, false);
      
      const res2 = parseAmount({ amount: 'NUMIS:abc' });
      assert.strictEqual(res2.ok, false);
    });

    it('should return error for out of bounds amounts', () => {
      const res = parseAmount({ amount: 'NUMIS:0' });
      assert.strictEqual(res.ok, false);

      const res2 = parseAmount({ amount: 'NUMIS:1000000' });
      assert.strictEqual(res2.ok, false);
    });
  });

  describe('POST /get-money/:id/close-account', () => {
    it('should return 401 if no auth header', async () => {
      await request(server)
        .post('/get-money/test/close-account')
        .expect(401);
    });

    it('should correctly close account when balance is greater than zero', async () => {
      mockBankHandler = (req, res) => {
        if (req.method === 'GET' && req.url === '/accounts/test') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ balance: { amount: 'NUMIS:10' } }));
        } else if (req.method === 'POST' && req.url === '/accounts/test/transactions') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'ok' }));
        } else {
          res.writeHead(404);
          res.end();
        }
      };

      const res = await request(server)
        .post('/get-money/test/close-account')
        .set('Authorization', 'Bearer dummy-token')
        .expect(200);

      assert.strictEqual(res.body.type, 'ok');
    });

    it('should handle zero balance correctly', async () => {
      mockBankHandler = (req, res) => {
        if (req.method === 'GET' && req.url === '/accounts/test') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ balance: { amount: 'NUMIS:0' } }));
        } else {
          res.writeHead(404);
          res.end();
        }
      };

      const res = await request(server)
        .post('/get-money/test/close-account')
        .set('Authorization', 'Bearer dummy-token')
        .expect(200);

      assert.strictEqual(res.body.message, 'Account balance is zero');
    });

    it('should propagate bank errors', async () => {
      mockBankHandler = (req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Bank Error' }));
      };

      const res = await request(server)
        .post('/get-money/test/close-account')
        .set('Authorization', 'Bearer dummy-token')
        .expect(500);

      assert.strictEqual(res.body.type, 'error');
    });
  });

  describe('Reverse proxy /api/*', () => {
    it('GET /api/config returns bank host', async () => {
      const res = await request(server).get('/api/config').expect(200);
      assert.strictEqual(res.body.bankHost, `localhost:${mockBankPort}`);
    });

    it('GET /api/bank forwards path, query and Authorization header', async () => {
      mockBankHandler = (req, res) => {
        assert.strictEqual(req.url, '/accounts/test?limit=2&timeout_ms=10000');
        assert.strictEqual(req.headers.authorization, 'Bearer tok123');
        assert.strictEqual(req.headers.accept, 'application/json');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      };

      const res = await request(server)
        .get('/api/bank/accounts/test?limit=2&timeout_ms=10000')
        .set('Authorization', 'Bearer tok123')
        .set('Accept', 'application/json')
        .expect(200);

      assert.deepStrictEqual(res.body, { ok: true });
    });

    it('POST /api/bank passes through request body', async () => {
      mockBankHandler = (req, res) => {
        assert.strictEqual(req.method, 'POST');
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          assert.strictEqual(req.headers['content-type'], 'application/json');
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: JSON.parse(raw) }));
        });
      };

      const res = await request(server)
        .post('/api/bank/accounts/test/withdrawals')
        .set('Content-Type', 'application/json')
        .send({ amount: 'NUMIS:10' })
        .expect(201);

      assert.deepStrictEqual(res.body.received, { amount: 'NUMIS:10' });
    });

    it('returns 502 when upstream connection fails', async () => {
      await new Promise<void>((resolve) => mockBankServer.close(() => resolve()));
      const res = await request(server).get('/api/bank/accounts/test');
      assert.strictEqual(res.status, 502);
      await new Promise<void>((resolve) => {
        mockBankServer = http.createServer((req, res) => mockBankHandler(req, res));
        mockBankServer.listen(0, () => resolve());
      });
    });
  });

  describe('GET /api/state/:instance', () => {
    function setupHappyMocks() {
      mockMerchantHandler = (req, res) => {
        const url = req.url || '';
        if (!req.headers.authorization?.includes('mtok')) {
          res.writeHead(401);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (url.includes('paid=yes')) {
          res.end(JSON.stringify({
            orders: [
              { order_id: 'a', amount: 'NUMIS:10', refund_amount: 'NUMIS:0', wired: true, wire_transfer_status: 'wired' },
              { order_id: 'b', amount: 'NUMIS:5', refund_amount: 'NUMIS:2', wire_transfer_status: 'pending' },
            ],
          }));
        } else {
          res.end(JSON.stringify({
            orders: [
              { order_id: 'a', summary: 'Coffee', amount: 'NUMIS:10', refund_amount: 'NUMIS:0', paid: true, wired: true, timestamp: { t_s: 1700000000 } },
            ],
          }));
        }
      };
      mockBankHandler = (req, res) => {
        if (!req.headers.authorization?.includes('btok')) {
          res.writeHead(401);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if ((req.url || '').includes('/transactions')) {
          res.end(JSON.stringify({ transactions: [{ row_id: 7, amount: 'NUMIS:10', subject: 'sales' }] }));
        } else {
          res.end(JSON.stringify({ name: 'Test Store', balance: { amount: 'NUMIS:42' } }));
        }
      };
    }

    it('returns aggregated totals, orders and transactions', async () => {
      setupHappyMocks();
      const res = await request(server)
        .get('/api/state/shop1')
        .set('Authorization', 'Bearer mtok')
        .set('X-Bank-Authorization', 'Bearer btok')
        .expect(200);

      assert.strictEqual(res.body.accountName, 'Test Store');
      assert.deepStrictEqual(res.body.totals, { sold: 13, inTransit: 3, settled: 10, bankAvailable: 42 });
      assert.strictEqual(res.body.orders.length, 1);
      assert.strictEqual(res.body.orders[0].order_id, 'a');
      assert.strictEqual(res.body.transactions.length, 1);
      assert.strictEqual(res.body.transactions[0].row_id, 7);
    });

    it('returns 401 when tokens are missing', async () => {
      setupHappyMocks();
      await request(server).get('/api/state/shop1').set('Authorization', 'Bearer mtok').expect(401);
      await request(server).get('/api/state/shop1').expect(401);
    });

    it('propagates upstream 401 as 401', async () => {
      setupHappyMocks();
      await request(server)
        .get('/api/state/shop1')
        .set('Authorization', 'Bearer mtok')
        .set('X-Bank-Authorization', 'Bearer WRONG')
        .expect(401);
    });

    it('returns 502 on upstream error', async () => {
      await request(server)
        .get('/api/state/shop1')
        .set('Authorization', 'Bearer mtok')
        .set('X-Bank-Authorization', 'Bearer btok')
        .expect(502);
    });
  });

  describe('Pagination endpoints', () => {
    it('GET /api/orders/:instance forwards query and merchant auth', async () => {
      mockMerchantHandler = (req, res) => {
        assert.strictEqual(req.url, '/instances/shop1/private/orders?limit=-5&offset=3');
        assert.strictEqual(req.headers.authorization, 'Bearer mtok');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ orders: [] }));
      };
      const res = await request(server)
        .get('/api/orders/shop1?limit=-5&offset=3')
        .set('Authorization', 'Bearer mtok')
        .expect(200);
      assert.deepStrictEqual(res.body, { orders: [] });
    });

    it('GET /api/transactions/:instance forwards query and bank auth from X-Bank-Authorization', async () => {
      mockBankHandler = (req, res) => {
        assert.strictEqual(req.url, '/accounts/shop1/transactions?limit=-10&offset=7');
        assert.strictEqual(req.headers.authorization, 'Bearer btok');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ transactions: [] }));
      };
      const res = await request(server)
        .get('/api/transactions/shop1?limit=-10&offset=7')
        .set('X-Bank-Authorization', 'Bearer btok')
        .expect(200);
      assert.deepStrictEqual(res.body, { transactions: [] });
    });
  });

  describe('WebSocket /ws', () => {
    async function listenBackend(): Promise<number> {
      if (!(server as any).listening) {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          (server as any).listen(0, resolve);
        });
      }
      return (server.address() as import('net').AddressInfo).port;
    }

    // Queue-backed message buffer: messages arriving before/while we await
    // are kept, so no frame can be missed due to listener registration races.
    function makeWsClient(url: string) {
      const ws = new WebSocket(url);
      const queue: any[] = [];
      let waiters: Array<(msg: any) => void> = [];
      let closeCode: number | null = null;
      let closeWaiters: Array<(code: number) => void> = [];
      ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(String(ev.data));
        const waiter = waiters.shift();
        if (waiter) waiter(msg);
        else queue.push(msg);
      });
      ws.addEventListener('close', (ev) => {
        closeCode = ev.code;
        for (const w of closeWaiters.splice(0)) w(ev.code);
      });
      return {
        ws,
        open(): Promise<void> {
          return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('timeout waiting for open')), 6000);
            ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
            ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('ws error')); }, { once: true });
          });
        },
        sendRaw(data: string) { ws.send(data); },
        nextMessage(timeoutMs = 8000): Promise<any> {
          const queued = queue.shift();
          if (queued !== undefined) return Promise.resolve(queued);
          return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
            waiters.push((msg) => { clearTimeout(t); resolve(msg); });
          });
        },
        nextClose(timeoutMs = 8000): Promise<number> {
          if (closeCode !== null) return Promise.resolve(closeCode);
          return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('timeout waiting for close')), timeoutMs);
            closeWaiters.push((code) => { clearTimeout(t); resolve(code); });
          });
        },
        close() { ws.close(); },
      };
    }

    it('handshake + auth → ready, broadcasts orders-changed on upstream change', async () => {
      let orders: any[] = [
        { order_id: 'a', amount: 'NUMIS:10', refund_amount: 'NUMIS:0', wire_transfer_status: 'wired' },
      ];
      let txs: any[] = [{ row_id: 1, amount: 'NUMIS:10', subject: 'sales' }];
      let holdRequests = 0;

      mockMerchantHandler = (req, res) => {
        const url = req.url || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (url.includes('paid=yes')) {
          res.end(JSON.stringify({ orders }));
        } else if (url.includes('timeout_ms')) {
          holdRequests++;
          res.end(JSON.stringify({ orders: [] }));
        } else {
          res.end(JSON.stringify({ orders }));
        }
      };
      mockBankHandler = (req, res) => {
        const url = req.url || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (url.includes('/transactions')) {
          if (url.includes('timeout_ms')) {
            holdRequests++;
            res.end(JSON.stringify({ transactions: [] }));
          } else {
            res.end(JSON.stringify({ transactions: txs }));
          }
        } else {
          res.end(JSON.stringify({ name: 'WS Store', balance: { amount: 'NUMIS:1' } }));
        }
      };

      const port = await listenBackend();
      const client = makeWsClient(`ws://localhost:${port}/ws`);
      await client.open();
      client.sendRaw(JSON.stringify({ type: 'auth', instance: 'wsinst', merchantToken: 'mtok', bankToken: 'btok' }));
      const ready = await client.nextMessage();
      assert.deepStrictEqual(ready, { type: 'ready' });

      // wait until the watcher completed its first full iteration (both holds hit)
      const deadline = Date.now() + 5000;
      while (holdRequests < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(holdRequests >= 2, 'watcher should have done its first iteration');

      // change the upstream data
      orders = orders.concat([{ order_id: 'b', amount: 'NUMIS:3', refund_amount: 'NUMIS:0', wire_transfer_status: 'pending' }]);
      txs = txs.concat([{ row_id: 2, amount: 'NUMIS:4', subject: 'transfer' }]);

      const seen = new Set<string>();
      const msgDeadline = Date.now() + 8000;
      while (Date.now() < msgDeadline && (!seen.has('orders-changed') || !seen.has('tx-changed'))) {
        const remaining = msgDeadline - Date.now();
        if (remaining <= 0) break;
        const msg = await Promise.race([
          client.nextMessage(remaining),
          new Promise<null>((r) => setTimeout(() => r(null), remaining)),
        ]);
        if (msg) seen.add(msg.type);
      }
      assert.ok(seen.has('orders-changed'), 'expected orders-changed');
      assert.ok(seen.has('tx-changed'), 'expected tx-changed');
      client.close();
    });

    it('closes with 4401 on bad auth', async () => {
      mockBankHandler = (req, res) => {
        res.writeHead(401);
        res.end();
      };
      const port = await listenBackend();
      const client = makeWsClient(`ws://localhost:${port}/ws`);
      await client.open();
      client.sendRaw(JSON.stringify({ type: 'auth', instance: 'wsinst', merchantToken: 'm', bankToken: 'bad' }));
      const code = await client.nextClose();
      assert.strictEqual(code, 4401);
    });

    afterEach(async () => {
      if ((server as any).listening) {
        await new Promise<void>((resolve) => (server as any).close(() => resolve()));
      }
    });
  });

  describe('Web Push', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feria-push-'));
      process.env.VAPID_FILE = path.join(tmpDir, '.vapid.json');
      process.env.PUSH_SUBSCRIPTIONS_FILE = path.join(tmpDir, '.push-subscriptions.json');
      resetVapidKeysForTests();
    });

    afterEach(() => {
      delete process.env.VAPID_FILE;
      delete process.env.PUSH_SUBSCRIPTIONS_FILE;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('GET /api/push/vapid-key returns a 65-byte SEC1 base64url key', async () => {
      const res = await request(server).get('/api/push/vapid-key').expect(200);
      assert.strictEqual(typeof res.body.publicKey, 'string');
      const pub = Buffer.from(res.body.publicKey, 'base64url');
      assert.strictEqual(pub.length, 65);
      assert.strictEqual(pub[0], 0x04);
    });

    it('VAPID JWT is valid ES256 and has correct claims', () => {
      const keys = getVapidKeys();
      const now = 1700000000;
      const jwt = buildVapidJwt('https://push.example.com/send/x', keys, 'mailto:test@example.com', now);
      const [header, payload, sig] = jwt.split('.');
      assert.deepStrictEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
      assert.strictEqual(claims.aud, 'https://push.example.com');
      assert.strictEqual(claims.exp, now + 12 * 3600);
      assert.strictEqual(claims.sub, 'mailto:test@example.com');
      assert.strictEqual(Buffer.from(sig, 'base64url').length, 64);
      assert.strictEqual(verifyVapidJwt(jwt, keys), true);
      const tampered = `${header}.${payload.replace(/./, (c) => (c === 'a' ? 'b' : 'a'))}.${sig}`;
      assert.strictEqual(verifyVapidJwt(tampered, keys), false);
    });

    it('VAPID keys are persisted to the file and reused', () => {
      const keys = getVapidKeys();
      assert.ok(fs.existsSync(process.env.VAPID_FILE!));
      resetVapidKeysForTests();
      const again = getVapidKeys();
      assert.deepStrictEqual(again, keys);
    });

    it('subscription store add is idempotent and remove works', () => {
      const sub = { endpoint: 'https://push.example.com/e1', keys: { p256dh: 'p', auth: 'a' } };
      addSubscription('shop1', sub);
      addSubscription('shop1', sub);
      assert.strictEqual(getSubscriptions('shop1').length, 1);
      removeSubscription('shop1', 'https://push.example.com/e1');
      assert.strictEqual(getSubscriptions('shop1').length, 0);
    });

    it('POST /api/push/subscribe and /api/push/unsubscribe work end to end', async () => {
      await request(server)
        .post('/api/push/subscribe')
        .send({ instance: 'shop1', subscription: { endpoint: 'https://push.example.com/e2', keys: { p256dh: 'p', auth: 'a' } } })
        .expect(200);
      assert.strictEqual(getSubscriptions('shop1').length, 1);
      await request(server)
        .post('/api/push/unsubscribe')
        .send({ instance: 'shop1', endpoint: 'https://push.example.com/e2' })
        .expect(200);
      assert.strictEqual(getSubscriptions('shop1').length, 0);
    });
  });

  describe('RFC 8291 aes128gcm payload encryption', () => {
    it('header parses and plaintext round-trips through AES-128-GCM', () => {
      const hmac = (key: Buffer, data: Buffer) => crypto.createHmac('sha256', key).update(data).digest();

      // The "user agent" subscription keypair
      const uaEcdh = crypto.createECDH('prime256v1');
      uaEcdh.generateKeys();
      const subscription = {
        endpoint: 'https://push.example.com/send/xyz',
        keys: {
          p256dh: uaEcdh.getPublicKey().toString('base64url'),
          auth: crypto.randomBytes(16).toString('base64url'),
        },
      };

      // Fixed ephemeral key and salt so the test is fully deterministic
      const eph = crypto.createECDH('prime256v1');
      eph.generateKeys();
      const salt = crypto.randomBytes(16);
      const plaintext = 'Maintenance window tonight at 23:00';

      const enc = encryptAes128Gcm(subscription, plaintext, eph.getPrivateKey(), salt);

      // RFC 8188 aes128gcm header: salt(16) || rs(4) || idlen(1) || keyid
      assert.deepStrictEqual(enc.salt, salt);
      assert.strictEqual(enc.rs, 4096);
      assert.strictEqual(enc.body.subarray(0, 16).compare(salt), 0);
      assert.strictEqual(enc.body.readUInt32BE(16), 4096);
      assert.strictEqual(enc.body[20], 65);
      const keyid = enc.body.subarray(21, 21 + 65);
      assert.deepStrictEqual(Buffer.from(keyid), eph.getPublicKey());

      // Independent re-derivation of CEK/nonce per RFC 8291 §4 and decrypt
      const uaPublic = Buffer.from(subscription.keys.p256dh, 'base64url');
      const auth = Buffer.from(subscription.keys.auth, 'base64url');
      const ikmInfo = Buffer.concat([
        Buffer.from('Content-Encoding: aes128gcm'), Buffer.from([0]),
        Buffer.from('P-256'), Buffer.from([0]),
        Buffer.from('WebPush: info'), Buffer.from([0]),
        uaPublic, eph.getPublicKey(), Buffer.from([1]),
      ]);
      const ikm = hmac(hmac(auth, eph.computeSecret(uaPublic)), ikmInfo);
      const prk = hmac(salt, ikm);
      const cekInfo = Buffer.concat([
        Buffer.from('Content-Encoding: aes128gcm'), Buffer.from([0]),
        Buffer.from('P-256'), Buffer.from([0]),
        Buffer.from('CEK'), Buffer.from([0]),
        Buffer.from('Content-Encoding: aes128gcm'), Buffer.from([1]),
      ]);
      const nonceInfo = Buffer.concat([
        Buffer.from('Content-Encoding: aes128gcm'), Buffer.from([0]),
        Buffer.from('P-256'), Buffer.from([0]),
        Buffer.from('Nonce'), Buffer.from([0]),
        Buffer.from('Content-Encoding: aes128gcm'), Buffer.from([1]),
      ]);
      const cek = hmac(prk, cekInfo).subarray(0, 16);
      const nonce = hmac(prk, nonceInfo).subarray(0, 12);

      const record = enc.body.subarray(21 + 65);
      const ciphertext = record.subarray(0, record.length - 16);
      const tag = record.subarray(record.length - 16);
      const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

      // padding delimiter 0x02, no padding
      assert.strictEqual(decrypted[decrypted.length - 1], 0x02);
      assert.strictEqual(decrypted.subarray(0, -1).toString('utf8'), plaintext);
    });
  });

  describe('POST /api/admin/notify', () => {
    let tmpDir: string;
    const pushHits: Record<string, number> = {};

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feria-admin-'));
      process.env.VAPID_FILE = path.join(tmpDir, '.vapid.json');
      process.env.PUSH_SUBSCRIPTIONS_FILE = path.join(tmpDir, '.push-subscriptions.json');
      process.env.ADMIN_TOKEN = 'secret-token';
      resetVapidKeysForTests();
      for (const k of Object.keys(pushHits)) delete pushHits[k];
      mockBankHandler = (req, res) => {
        const url = req.url || '';
        if (url.startsWith('/push/')) {
          pushHits[url] = (pushHits[url] || 0) + 1;
          // every pushed body must be an encrypted binary record, never plaintext
          let raw = '';
          req.on('data', (c) => { raw += c; });
          req.on('end', () => {
            assert.ok(raw.length > 0);
            assert.ok(!raw.includes('Maintenance'));
            res.writeHead(url.includes('fail') ? 500 : 201);
            res.end();
          });
          return;
        }
        res.writeHead(404);
        res.end();
      };
    });

    afterEach(() => {
      delete process.env.ADMIN_TOKEN;
      delete process.env.VAPID_FILE;
      delete process.env.PUSH_SUBSCRIPTIONS_FILE;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // The admin path encrypts per subscription, so seed valid key material
    async function seedValidSubscriptions() {
      const makeKeys = () => {
        const e = crypto.createECDH('prime256v1');
        e.generateKeys();
        return { p256dh: e.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
      };
      addSubscription('shop1', { endpoint: `http://localhost:${mockBankPort}/push/shop1-a`, keys: makeKeys() });
      addSubscription('shop1', { endpoint: `http://localhost:${mockBankPort}/push/shop1-b`, keys: makeKeys() });
      addSubscription('shop2', { endpoint: `http://localhost:${mockBankPort}/push/shop2-a`, keys: makeKeys() });
    }

    it('returns 403 when ADMIN_TOKEN is unset (fail closed)', async () => {
      delete process.env.ADMIN_TOKEN;
      await request(server)
        .post('/api/admin/notify')
        .set('X-Admin-Token', 'anything')
        .send({ message: 'hi' })
        .expect(403);
    });

    it('returns 403 on missing or wrong token', async () => {
      await request(server).post('/api/admin/notify').send({ message: 'hi' }).expect(403);
      await request(server)
        .post('/api/admin/notify')
        .set('X-Admin-Token', 'wrong')
        .send({ message: 'hi' })
        .expect(403);
    });

    it('returns 400 when message is missing', async () => {
      await request(server)
        .post('/api/admin/notify')
        .set('X-Admin-Token', 'secret-token')
        .send({})
        .expect(400);
    });

    it('sends only to the given instance and reports the count', async () => {
      await seedValidSubscriptions();
      const res = await request(server)
        .post('/api/admin/notify')
        .set('X-Admin-Token', 'secret-token')
        .send({ message: 'Maintenance tonight', instance: 'shop1' })
        .expect(200);
      assert.strictEqual(res.body.sent, 2);
      assert.strictEqual(pushHits['/push/shop1-a'], 1);
      assert.strictEqual(pushHits['/push/shop1-b'], 1);
      assert.strictEqual(pushHits['/push/shop2-a'], undefined);
    });

    it('broadcasts to all instances when instance is omitted or "all"', async () => {
      await seedValidSubscriptions();
      const res = await request(server)
        .post('/api/admin/notify')
        .set('X-Admin-Token', 'secret-token')
        .send({ message: 'Broadcast', title: 'FairPay Admin' })
        .expect(200);
      assert.strictEqual(res.body.sent, 3);
      assert.strictEqual(pushHits['/push/shop1-a'], 1);
      assert.strictEqual(pushHits['/push/shop1-b'], 1);
      assert.strictEqual(pushHits['/push/shop2-a'], 1);

      const res2 = await request(server)
        .post('/api/admin/notify')
        .set('X-Admin-Token', 'secret-token')
        .send({ message: 'Broadcast', instance: 'all' })
        .expect(200);
      assert.strictEqual(res2.body.sent, 3);
    });

    it('does not count non-2xx responses as sent', async () => {
      const e = crypto.createECDH('prime256v1');
      e.generateKeys();
      addSubscription('shop1', {
        endpoint: `http://localhost:${mockBankPort}/push/fail-1`,
        keys: { p256dh: e.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
      });
      const res = await request(server)
        .post('/api/admin/notify')
        .set('X-Admin-Token', 'secret-token')
        .send({ message: 'hi', instance: 'shop1' })
        .expect(200);
      assert.strictEqual(res.body.sent, 0);
    });
  });
});
