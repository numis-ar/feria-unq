import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import nock from 'nock';
import { 
  parseAmountStr, 
  getCurrency, 
  formatMoney, 
  validatePassword,
  loginToTaler,
  getAccountName,
  changePassword,
  closeAccount
} from '../web/merchant.js';

describe('Frontend tests', () => {

  describe('parseAmountStr', () => {
    it('should parse NUMIS:10.50 properly', () => {
      assert.strictEqual(parseAmountStr("NUMIS:10.50"), 10.5);
    });

    it('should parse simple numbers', () => {
      assert.strictEqual(parseAmountStr("5"), 5);
      assert.strictEqual(parseAmountStr(15.2), 15.2);
    });

    it('should handle undefined/null', () => {
      assert.strictEqual(parseAmountStr(null), 0);
      assert.strictEqual(parseAmountStr(undefined), 0);
    });
  });

  describe('getCurrency', () => {
    it('should extract currency from format', () => {
      assert.strictEqual(getCurrency("NUMIS:10.50"), "NUMIS");
      assert.strictEqual(getCurrency("EUR:50"), "EUR");
    });
    
    it('should return empty string if no colon', () => {
      assert.strictEqual(getCurrency("10"), "");
    });
  });

  describe('formatMoney', () => {
    it('should format money to 2 decimals', () => {
      assert.strictEqual(formatMoney(10), "10.00");
      assert.strictEqual(formatMoney(10.555), "10.55");
    });
  });

  describe('validatePassword', () => {
    it('should reject passwords shorter than 8', () => {
      assert.strictEqual(validatePassword("A1b2"), false);
    });
    
    it('should reject passwords without 2 letters', () => {
      assert.strictEqual(validatePassword("12345678a"), false);
    });

    it('should reject passwords without 2 numbers', () => {
      assert.strictEqual(validatePassword("abcdefgh1"), false);
    });

    it('should accept valid passwords', () => {
      assert.strictEqual(validatePassword("abc12345"), true);
      assert.strictEqual(validatePassword("AB-12_cd"), true);
    });
  });

  describe('API Calls (loginToTaler)', () => {
    it('should authenticate successfully with mocked endpoints', async () => {
      nock('https://merchant.local')
        .post('/instances/testuser/private/token')
        .reply(200, { access_token: 'merch_tok' });

      nock('https://bank.local')
        .post('/accounts/testuser/token')
        .reply(200, { access_token: 'bank_tok' });

      const res = await loginToTaler('https://merchant.local', 'https://bank.local', 'testuser', 'pass');
      
      assert.strictEqual(res.ACCESS_TOKEN, 'merch_tok');
      assert.strictEqual(res.BANK_ACCESS_TOKEN, 'bank_tok');
    });

    it('should throw an error when merchant auth fails', async () => {
      nock('https://merchant.local')
        .post('/instances/testuser/private/token')
        .reply(401);

      try {
        await loginToTaler('https://merchant.local', 'https://bank.local', 'testuser', 'pass');
        assert.fail('Should have thrown error');
      } catch(e) {
        assert.strictEqual(e.message, 'Failed to authenticate with Merchant');
      }
    });

    it('should throw an error when bank auth fails', async () => {
      nock('https://merchant.local')
        .post('/instances/testuser/private/token')
        .reply(200, { access_token: 'merch_tok' });

      nock('https://bank.local')
        .post('/accounts/testuser/token')
        .reply(401);

      try {
        await loginToTaler('https://merchant.local', 'https://bank.local', 'testuser', 'pass');
        assert.fail('Should have thrown error');
      } catch(e) {
        assert.strictEqual(e.message, 'Failed to authenticate with Bank');
      }
    });
  });

  describe('API Calls (getAccountName)', () => {
    it('should return name from api if success', async () => {
      nock('https://bank.local')
        .get('/accounts/testuser')
        .reply(200, { name: 'Super Store' });

      const res = await getAccountName('https://bank.local', 'testuser', 'tok');
      assert.strictEqual(res, 'Super Store');
    });

    it('should fallback to user if error', async () => {
      nock('https://bank.local')
        .get('/accounts/testuser')
        .reply(404);

      const res = await getAccountName('https://bank.local', 'testuser', 'tok');
      assert.strictEqual(res, 'testuser');
    });
  });

  describe('API Calls (closeAccount)', () => {
    it('should correctly call close account endpoint', async () => {
      nock('http://localhost')
        .post('/get-money/testuser/close-account')
        .reply(200, { type: 'ok' });

      // Patch fetch for relative URL
      const origFetch = global.fetch;
      global.fetch = async (url, options) => {
        return origFetch(`http://localhost${url}`, options);
      };

      try {
        const res = await closeAccount('testuser', 'tok');
        assert.strictEqual(res.type, 'ok');
      } finally {
        global.fetch = origFetch;
      }
    });

    it('should throw error when api fails', async () => {
      nock('http://localhost')
        .post('/get-money/testuser/close-account')
        .reply(500, { message: 'Internal Fail' });

      const origFetch = global.fetch;
      global.fetch = async (url, options) => {
        return origFetch(`http://localhost${url}`, options);
      };

      try {
        await closeAccount('testuser', 'tok');
        assert.fail('Should have thrown error');
      } catch(e) {
        assert.strictEqual(e.message, 'Internal Fail');
      } finally {
        global.fetch = origFetch;
      }
    });
  });

  describe('API Calls (changePassword)', () => {
    it('should handle successful password change', async () => {
      nock('https://merchant.local')
        .post('/instances/testuser/private/auth')
        .reply(204);

      nock('https://bank.local')
        .patch('/accounts/testuser/auth')
        .reply(204);

      await changePassword('https://merchant.local', 'https://bank.local', 'testuser', 'mTok', 'bTok', 'oldP', 'newP');
      // No throw means success
    });

    it('should throw if merchant api fails', async () => {
      nock('https://merchant.local')
        .post('/instances/testuser/private/auth')
        .reply(401, 'Unauthorized');

      try {
        await changePassword('https://merchant.local', 'https://bank.local', 'testuser', 'mTok', 'bTok', 'oldP', 'newP');
        assert.fail('Should have thrown error');
      } catch(e) {
        assert.strictEqual(e.message, 'Merchant API failed: 401 Unauthorized');
      }
    });

    it('should throw if bank api fails', async () => {
      nock('https://merchant.local')
        .post('/instances/testuser/private/auth')
        .reply(204);

      nock('https://bank.local')
        .patch('/accounts/testuser/auth')
        .reply(403, 'Forbidden');

      try {
        await changePassword('https://merchant.local', 'https://bank.local', 'testuser', 'mTok', 'bTok', 'oldP', 'newP');
        assert.fail('Should have thrown error');
      } catch(e) {
        assert.strictEqual(e.message, 'Bank API failed: 403 Forbidden');
      }
    });
  });
});
