import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import request from 'supertest';
import nock from 'nock';
import { server, BANK_URL, MERCHANT_BASE_URL, CLOSING_ACCOUNT } from '../server/backend.ts';
import { parseAmount } from '../server/backend.ts';

describe('Backend tests', () => {

  afterEach(() => {
    nock.cleanAll();
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
      // Mock get balance
      nock(BANK_URL)
        .get('/accounts/test')
        .reply(200, { balance: { amount: 'NUMIS:10' } });

      // Mock transaction creation
      nock(BANK_URL)
        .post('/accounts/test/transactions')
        .reply(200, { type: 'ok' });

      const res = await request(server)
        .post('/get-money/test/close-account')
        .set('Authorization', 'Bearer dummy-token')
        .expect(200);

      assert.strictEqual(res.body.type, 'ok');
    });

    it('should handle zero balance correctly', async () => {
      nock(BANK_URL)
        .get('/accounts/test')
        .reply(200, { balance: { amount: 'NUMIS:0' } });

      const res = await request(server)
        .post('/get-money/test/close-account')
        .set('Authorization', 'Bearer dummy-token')
        .expect(200);

      assert.strictEqual(res.body.message, 'Account balance is zero');
    });

    it('should propagate bank errors', async () => {
      nock(BANK_URL)
        .get('/accounts/test')
        .reply(500, { error: 'Internal Bank Error' });

      const res = await request(server)
        .post('/get-money/test/close-account')
        .set('Authorization', 'Bearer dummy-token')
        .expect(500);

      assert.strictEqual(res.body.type, 'error');
    });
  });
});
