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
  closeAccount,
  escapeHtml,
  extractAccountFromPayto,
  getTimestampMs,
  formatDate,
  formatTime,
  getOrderState,
  isOrderPayable,
  filterOrders,
  generateRequestUid,
  buildOrderRowHtml,
  buildTransactionRowHtml,
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
      nock('https://bank.local')
        .patch('/accounts/testuser/auth')
        .reply(204);

      nock('https://merchant.local')
        .get('/instances/testuser/private/accounts')
        .reply(200, { accounts: [{ h_wire: 'wire-1' }] });

      nock('https://merchant.local')
        .patch('/instances/testuser/private/accounts/wire-1')
        .reply(204);

      nock('https://merchant.local')
        .post('/instances/testuser/private/auth')
        .reply(204);

      await changePassword('https://merchant.local', 'https://bank.local', 'testuser', 'mTok', 'bTok', 'oldP', 'newP');
      // No throw means success
    });

    it('should throw if merchant api fails', async () => {
      nock('https://bank.local')
        .patch('/accounts/testuser/auth')
        .reply(204);

      nock('https://merchant.local')
        .get('/instances/testuser/private/accounts')
        .reply(200, { accounts: [{ h_wire: 'wire-1' }] });

      nock('https://merchant.local')
        .patch('/instances/testuser/private/accounts/wire-1')
        .reply(204);

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

  describe('escapeHtml', () => {
    it('should escape HTML special characters', () => {
      assert.strictEqual(escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
      assert.strictEqual(escapeHtml("it's"), 'it&#039;s');
    });
  });

  describe('extractAccountFromPayto', () => {
    it('should extract account from payto uri', () => {
      assert.strictEqual(extractAccountFromPayto('payto://x-taler-bank/bank.taler.ar/alice'), 'alice');
      assert.strictEqual(extractAccountFromPayto('payto://x-taler-bank/bank.taler.ar/closing_account'), 'closing_account');
    });

    it('should return empty string on invalid uri', () => {
      assert.strictEqual(extractAccountFromPayto(''), '');
      assert.strictEqual(extractAccountFromPayto('not-a-uri'), '');
    });
  });

  describe('getTimestampMs', () => {
    it('should convert t_s to ms', () => {
      assert.strictEqual(getTimestampMs({ t_s: 1 }), 1000);
    });

    it('should return t_ms as-is', () => {
      assert.strictEqual(getTimestampMs({ t_ms: 1234567890123 }), 1234567890123);
    });

    it('should convert numeric seconds to ms', () => {
      assert.strictEqual(getTimestampMs(1), 1000);
    });

    it('should keep numeric ms as-is', () => {
      assert.strictEqual(getTimestampMs(1234567890123), 1234567890123);
    });

    it('should parse ISO strings', () => {
      assert.strictEqual(getTimestampMs('2024-01-01T00:00:00.000Z'), new Date('2024-01-01T00:00:00.000Z').getTime());
    });
  });

  describe('formatDate / formatTime', () => {
    it('should format date in requested locale', () => {
      const ms = new Date('2024-12-25T15:30:00.000Z').getTime();
      assert.match(formatDate(ms, 'es'), /25/);
      assert.match(formatTime(ms, 'es'), /15|3/);
    });

    it('should return empty string for missing timestamp', () => {
      assert.strictEqual(formatDate(null), '');
      assert.strictEqual(formatTime(null), '');
    });
  });

  describe('getOrderState', () => {
    it('should return settled for paid wired order', () => {
      const result = getOrderState({ paid: true, wired: true, amount: 'NUMIS:10' });
      assert.strictEqual(result.state, 'settled');
      assert.strictEqual(result.amountNum, 10);
    });

    it('should return refunded when refund amount > 0', () => {
      const result = getOrderState({ paid: true, wired: true, amount: 'NUMIS:10', refund_amount: 'NUMIS:5' });
      assert.strictEqual(result.state, 'refunded');
    });

    it('should return in-transit for paid unwired order', () => {
      const result = getOrderState({ paid: true, wired: false, amount: 'NUMIS:10' });
      assert.strictEqual(result.state, 'in-transit');
    });

    it('should return unpaid for unpaid order', () => {
      const result = getOrderState({ paid: false, amount: 'NUMIS:10' });
      assert.strictEqual(result.state, 'unpaid');
    });
  });

  describe('isOrderPayable / filterOrders', () => {
    it('should reject orders with zero amount', () => {
      assert.strictEqual(isOrderPayable({ amount: 'NUMIS:0' }), false);
      assert.strictEqual(isOrderPayable({ amount: 'NUMIS:0.00' }), false);
    });

    it('should reject orders with expired pay_deadline', () => {
      const now = 1000000;
      assert.strictEqual(isOrderPayable({ amount: 'NUMIS:10', pay_deadline: { t_ms: now - 1 } }, parseAmountStr, now), false);
    });

    it('should accept payable orders', () => {
      const now = 1000000;
      assert.strictEqual(isOrderPayable({ amount: 'NUMIS:10', pay_deadline: { t_ms: now + 1 } }, parseAmountStr, now), true);
      assert.strictEqual(isOrderPayable({ amount: 'NUMIS:10' }, parseAmountStr, now), true);
    });

    it('should filter a list of orders', () => {
      const now = 1000000;
      const orders = [
        { amount: 'NUMIS:10', pay_deadline: { t_ms: now + 1 } },
        { amount: 'NUMIS:0' },
        { amount: 'NUMIS:5', pay_deadline: { t_ms: now - 1 } },
      ];
      const filtered = filterOrders(orders, parseAmountStr, now);
      assert.strictEqual(filtered.length, 1);
      assert.strictEqual(filtered[0].amount, 'NUMIS:10');
    });
  });

  describe('generateRequestUid', () => {
    it('should generate a 52-char uppercase uid using Crockford Base32 alphabet', () => {
      const uid = generateRequestUid();
      assert.match(uid, /^[0-9A-Z]{52}$/);
      assert.ok(!/[ILOU]/i.test(uid), 'uid should not contain ambiguous Crockford chars');
    });
  });

  describe('buildOrderRowHtml', () => {
    it('should include escaped summary and amount', () => {
      const html = buildOrderRowHtml(
        { summary: '<b>Order</b>', amount: 'NUMIS:12.50', paid: true, wired: true },
        { t: (k) => k, tf: (k, v) => k, formatMoney: (n) => n.toFixed(2), timeStr: '10:00', rowClass: 'hover:bg-slate-50' }
      );
      assert.match(html, /&lt;b&gt;Order&lt;\/b&gt;/);
      assert.match(html, /12\.50/);
      assert.match(html, /settled/);
    });

    it('should include countdown for unpaid orders with a pay deadline', () => {
      const now = 1000000;
      const html = buildOrderRowHtml(
        { summary: 'Pending', amount: 'NUMIS:12.50', paid: false, pay_deadline: { t_ms: now + 5000 } },
        { t: (k) => k, tf: (k, v) => `${k}:${v.seconds}`, formatMoney: (n) => n.toFixed(2), timeStr: '10:00', rowClass: 'hover:bg-slate-50', now }
      );
      assert.match(html, /order-countdown/);
      assert.match(html, /role="timer"/);
      assert.match(html, /aria-label="order_countdown_label"/);
      assert.match(html, /data-deadline="1005000"/);
      assert.match(html, /order_expires_in:5/);
    });

    it('should not include countdown for paid orders', () => {
      const now = 1000000;
      const html = buildOrderRowHtml(
        { summary: 'Paid', amount: 'NUMIS:12.50', paid: true, wired: false, pay_deadline: { t_ms: now + 5000 } },
        { t: (k) => k, tf: (k, v) => k, formatMoney: (n) => n.toFixed(2), timeStr: '10:00', rowClass: 'hover:bg-slate-50', now }
      );
      assert.doesNotMatch(html, /order-countdown/);
    });
  });

  describe('buildTransactionRowHtml', () => {
    const t = (k) => ({ val_sales: 'sales', val_withdraw: 'withdraw', val_closing: 'closing', tx_fallback: 'Transfer', unknown_account: 'unknown' }[k] || k);

    it('should identify sales credit', () => {
      const result = buildTransactionRowHtml(
        { direction: 'credit', amount: 'NUMIS:20', debtor_payto_uri: 'payto://x-taler-bank/bank.taler.ar/exchange' },
        { t, tf: (k, v) => k, formatMoney: (n) => n.toFixed(2), timeStr: '10:00' }
      );
      assert.match(result.html, /text-green-600/);
      assert.strictEqual(result.isCredit, true);
      assert.strictEqual(result.subject, 'sales');
    });

    it('should identify withdraw debit', () => {
      const result = buildTransactionRowHtml(
        { direction: 'debit', amount: 'NUMIS:15', creditor_payto_uri: 'payto://x-taler-bank/bank.taler.ar/exchange' },
        { t, tf: (k, v) => k, formatMoney: (n) => n.toFixed(2), timeStr: '10:00' }
      );
      assert.match(result.html, /text-red-600/);
      assert.strictEqual(result.isCredit, false);
      assert.strictEqual(result.subject, 'withdraw');
    });
  });
});
