import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import request from 'supertest';
import * as http from 'http';
import { server, CLOSING_ACCOUNT } from '../server/backend.ts';
import { parseAmount } from '../server/backend.ts';

describe('Backend tests', () => {
  let mockBankServer: http.Server;
  let mockBankPort: number;
  let mockBankHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

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
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      mockBankServer.close(() => resolve());
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
});
