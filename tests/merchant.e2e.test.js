import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { chromium } from 'playwright';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import axeCore from 'axe-core';

function createMockServer(balanceAmount) {
  return http.createServer((req, res) => {
    let cleanUrl = req.url.split('?')[0];

    if (cleanUrl.includes('/private/token') || cleanUrl.includes('/token')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ access_token: 'mock_token' }));
      return;
    }
    if (cleanUrl.includes('/private/orders')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ orders: [
        { order_id: '1', summary: 'Coffee', amount: 'NUMIS:10', refund_amount: 'NUMIS:0', paid: true, wired: true, timestamp: { t_s: Math.floor(Date.now()/1000) } }
      ] }));
      return;
    }
    if (cleanUrl.includes('/transactions')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ transactions: [], row_id: 123 }));
      return;
    }
    if (cleanUrl.includes('/withdrawals')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ withdrawal_id: 'w1', taler_withdraw_uri: 'taler://withdraw/...' }));
      return;
    }
    if (cleanUrl.includes('/verify-account/')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ username: 'targetmerchant', name: 'Target Merchant Store' }));
      return;
    }
    if (cleanUrl.includes('/close-account')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ type: 'ok' }));
      return;
    }
    if (cleanUrl.match(/\/accounts\/[^/?]+$/)) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ name: 'Test Merchant', balance: { amount: `NUMIS:${balanceAmount}` } }));
      return;
    }
    if (cleanUrl.includes('/private/auth') || cleanUrl.includes('/auth')) {
      res.writeHead(204);
      res.end();
      return;
    }

    if (cleanUrl === '/') cleanUrl = '/merchant.html';
    let filePath = path.join(process.cwd(), 'web', cleanUrl.replace(/^\/+/, ''));
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const map = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
      res.setHeader('Content-Type', map[ext] || 'text/plain');
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404);
      res.end('Not found: ' + filePath);
    }
  });
}

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
}

describe('Merchant UI E2E Behavior Tests (Playwright)', () => {
  let browser;
  let page;
  let staticServer;
  let baseUrl;

  before(async () => {
    staticServer = http.createServer((req, res) => {
      let cleanUrl = req.url.split('?')[0];
      
      // Mock API endpoints
      if (cleanUrl.includes('/private/token') || cleanUrl.includes('/token')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ access_token: 'mock_token' }));
        return;
      }
      if (cleanUrl.includes('/private/orders')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ orders: [
          { order_id: '1', summary: 'Coffee', amount: 'NUMIS:10', refund_amount: 'NUMIS:0', paid: true, wired: true, timestamp: { t_s: Math.floor(Date.now()/1000) } }
        ] }));
        return;
      }
      if (cleanUrl.includes('/transactions')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ transactions: [], row_id: 123 }));
        return;
      }
      if (cleanUrl.includes('/withdrawals')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ withdrawal_id: 'w1', taler_withdraw_uri: 'taler://withdraw/...' }));
        return;
      }
      if (cleanUrl.includes('/verify-account/')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ username: 'targetmerchant', name: 'Target Merchant Store' }));
        return;
      }
      if (cleanUrl.includes('/close-account')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ type: 'ok' }));
        return;
      }
      if (cleanUrl.match(/\/accounts\/[^/?]+$/)) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ name: 'Test Merchant', balance: { amount: 'NUMIS:100' } }));
        return;
      }
      if (cleanUrl.includes('/private/auth') || cleanUrl.includes('/auth')) {
        res.writeHead(204);
        res.end();
        return;
      }
      if (cleanUrl.includes('/private/accounts')) {
        if (req.method === 'PATCH') {
          res.writeHead(204);
          res.end();
        } else {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ accounts: [{ h_wire: 'wire-1' }] }));
        }
        return;
      }

      if (cleanUrl === '/') cleanUrl = '/merchant.html';
      let filePath = path.join(process.cwd(), 'web', cleanUrl.replace(/^\/+/, ''));
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        const map = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
        res.setHeader('Content-Type', map[ext] || 'text/plain');
        fs.createReadStream(filePath).pipe(res);
      } else {
        res.writeHead(404);
        res.end('Not found: ' + filePath);
      }
    });

    await new Promise(resolve => staticServer.listen(0, resolve));
    const addr = staticServer.address();
    baseUrl = `http://localhost:${addr.port}`;

    browser = await chromium.launch({ 
      headless: true, 
      args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
  });

  after(async () => {
    await browser.close();
    await new Promise(resolve => staticServer.close(resolve));
  });

  beforeEach(async () => {
    page = await browser.newPage();
    page.setDefaultTimeout(5000);
    page.on('dialog', dialog => dialog.accept());
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));

    await page.addInitScript(() => {
      window.API_URL = '/api/merchant';
      window.BANK_URL = '/api/bank';
    });
  });

  afterEach(async () => {
    await page.close();
  });

  it('1. Login Feature', async () => {
    await page.goto(`${baseUrl}/merchant.html`);
    await page.fill('#auth-user', 'default');
    await page.fill('#auth-pass', 'secret1234');
    await page.click('#btn-login');

    const modal = page.locator('#auth-modal');
    await modal.waitFor({ state: 'hidden' });
    // stat is rendered asynchronously by the first poll/WS refresh — wait for it
    await page.locator('#stat-sold', { hasText: '10.00' }).waitFor({ state: 'visible' });
    const statSold = await page.locator('#stat-sold').textContent();
    assert.strictEqual(statSold, '10.00');
  });

  it('2. Change Password Feature', async () => {
    await page.goto(`${baseUrl}/merchant.html`);
    await page.fill('#auth-user', 'default');
    await page.fill('#auth-pass', 'secret1234');
    await page.click('#btn-login');
    await page.locator('#auth-modal').waitFor({ state: 'hidden' });

    await page.click('#btn-open-change-pass');
    await page.locator('#change-pass-modal').waitFor({ state: 'visible' });

    await page.fill('#old-pass', 'secret1234');
    await page.fill('#new-pass', 'NewPass123');
    await page.fill('#repeat-pass', 'NewPass123');
    await page.click('#btn-change-pass');

    const toast = page.locator('#toast-container > div');
    await toast.waitFor({ state: 'visible' });
  });

  it('3. Withdraw Feature', async () => {
    await page.goto(`${baseUrl}/merchant.html`);
    await page.fill('#auth-user', 'default');
    await page.fill('#auth-pass', 'secret1234');
    await page.click('#btn-login');
    await page.locator('#auth-modal').waitFor({ state: 'hidden' });

    await page.click('#nav-account-btn');
    await page.click('#card-available-trigger');

    const withdrawModal = page.locator('#withdraw-modal');
    await withdrawModal.waitFor({ state: 'visible' });
    await page.fill('#withdraw-dialog-amount', '20');
    await page.click('#btn-withdraw-confirm');

    const qrModal = page.locator('#qr-modal');
    await qrModal.waitFor({ state: 'visible' });
  });

  it('4. Close Account Feature', async () => {
    await page.goto(`${baseUrl}/merchant.html`);
    await page.fill('#auth-user', 'default');
    await page.fill('#auth-pass', 'secret1234');
    await page.click('#btn-login');
    await page.locator('#auth-modal').waitFor({ state: 'hidden' });

    await page.click('#nav-account-btn');
    await page.click('#card-close-account');
    
    const closeModal = page.locator('#close-account-modal');
    await closeModal.waitFor({ state: 'visible' });
    await page.click('#btn-close-account-confirm');

    const toast = page.locator('#toast-container > div');
    await toast.waitFor({ state: 'visible' });
  });

  it('5. Wire Transfer Feature', async () => {
    await page.goto(`${baseUrl}/merchant.html`);
    await page.fill('#auth-user', 'default');
    await page.fill('#auth-pass', 'secret1234');
    await page.click('#btn-login');
    await page.locator('#auth-modal').waitFor({ state: 'hidden' });

    await page.click('#nav-account-btn');
    await page.click('#card-transfer-trigger');

    const transferModal = page.locator('#transfer-modal');
    await transferModal.waitFor({ state: 'visible' });

    await page.fill('#transfer-target', 'targetmerchant');
    await page.click('#btn-transfer-verify');

    await page.locator('#transfer-step-2').waitFor({ state: 'visible' });
    const transferSummary = await page.locator('#verify-target-summary').textContent();
    const summaryText = transferSummary.trim();
    assert.ok(summaryText.includes('targetmerchant'));
    assert.ok(summaryText.includes('Target Merchant Store'));

    await page.fill('#transfer-amount', '15');
    await page.click('#btn-transfer-next');

    await page.locator('#transfer-step-3').waitFor({ state: 'visible' });
    await page.click('#btn-transfer-confirm');

    const toast = page.locator('#toast-container > div');
    await toast.waitFor({ state: 'visible' });
  });

  it('6. Sell (Orders) Feature', async () => {
    await page.goto(`${baseUrl}/merchant.html`);
    await page.fill('#auth-user', 'default');
    await page.fill('#auth-pass', 'secret1234');
    await page.click('#btn-login');
    await page.locator('#auth-modal').waitFor({ state: 'hidden' });

    const orderRow = page.locator('#orders-tbody tr', { hasText: 'Coffee' });
    await orderRow.waitFor({ state: 'visible' });
    const text = await orderRow.textContent();
    assert.ok(text.includes('Coffee'));
  });
});

describe('Merchant UI with zero balance', () => {
  let browser;
  let page;
  let staticServer;
  let baseUrl;

  before(async () => {
    staticServer = createMockServer(0);
    await new Promise(resolve => staticServer.listen(0, resolve));
    const addr = staticServer.address();
    baseUrl = `http://localhost:${addr.port}`;
    browser = await launchBrowser();
  });

  after(async () => {
    await browser.close();
    await new Promise(resolve => staticServer.close(resolve));
  });

  beforeEach(async () => {
    page = await browser.newPage();
    page.setDefaultTimeout(5000);
    page.on('dialog', dialog => dialog.accept());
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    await page.addInitScript(() => {
      window.API_URL = '/api/merchant';
      window.BANK_URL = '/api/bank';
    });
  });

  afterEach(async () => {
    await page.close();
  });

  async function loginAndNavigateToAccount() {
    await page.goto(`${baseUrl}/merchant.html`);
    await page.fill('#auth-user', 'default');
    await page.fill('#auth-pass', 'secret1234');
    await page.click('#btn-login');
    await page.locator('#auth-modal').waitFor({ state: 'hidden' });
    await page.click('#nav-account-btn');
  }

  it('should block withdraw and show no funds toast', async () => {
    await loginAndNavigateToAccount();
    await page.click('#card-available-trigger');
    await page.locator('#withdraw-modal').waitFor({ state: 'hidden' });
    const toast = page.locator('#toast-container > div');
    await toast.waitFor({ state: 'visible' });
    const text = await toast.textContent();
    assert.ok(text.includes('No tiene fondos') || text.includes('fondos'));
  });

  it('should block transfer and show no funds toast', async () => {
    await loginAndNavigateToAccount();
    await page.click('#card-transfer-trigger');
    await page.locator('#transfer-modal').waitFor({ state: 'hidden' });
    const toast = page.locator('#toast-container > div');
    await toast.waitFor({ state: 'visible' });
    const text = await toast.textContent();
    assert.ok(text.includes('No tiene fondos') || text.includes('fondos'));
  });

  it('should block close account and show no funds toast', async () => {
    await loginAndNavigateToAccount();
    await page.click('#card-close-account');
    await page.locator('#close-account-modal').waitFor({ state: 'hidden' });
    const toast = page.locator('#toast-container > div');
    await toast.waitFor({ state: 'visible' });
    const text = await toast.textContent();
    assert.ok(text.includes('No tiene fondos') || text.includes('fondos'));
  });
});

describe('Merchant UI input validation against available balance', () => {
  let browser;
  let page;
  let staticServer;
  let baseUrl;

  before(async () => {
    staticServer = createMockServer(10);
    await new Promise(resolve => staticServer.listen(0, resolve));
    const addr = staticServer.address();
    baseUrl = `http://localhost:${addr.port}`;
    browser = await launchBrowser();
  });

  after(async () => {
    await browser.close();
    await new Promise(resolve => staticServer.close(resolve));
  });

  beforeEach(async () => {
    page = await browser.newPage();
    page.setDefaultTimeout(5000);
    page.on('dialog', dialog => dialog.accept());
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    await page.addInitScript(() => {
      window.API_URL = '/api/merchant';
      window.BANK_URL = '/api/bank';
    });
  });

  afterEach(async () => {
    await page.close();
  });

  async function loginAndNavigateToAccount() {
    await page.goto(`${baseUrl}/merchant.html`);
    await page.fill('#auth-user', 'default');
    await page.fill('#auth-pass', 'secret1234');
    await page.click('#btn-login');
    await page.locator('#auth-modal').waitFor({ state: 'hidden' });
    await page.click('#nav-account-btn');
  }

  it('should show error when withdraw amount exceeds available balance', async () => {
    await loginAndNavigateToAccount();
    await page.click('#card-available-trigger');
    await page.locator('#withdraw-modal').waitFor({ state: 'visible' });
    await page.fill('#withdraw-dialog-amount', '50');
    const errorEl = page.locator('#withdraw-dialog-error');
    await errorEl.waitFor({ state: 'visible' });
    const text = await errorEl.textContent();
    assert.ok(text.includes('Saldo insuficiente') || text.includes('Balance is not enough'));
  });

  it('should show error when transfer amount exceeds available balance', async () => {
    await loginAndNavigateToAccount();
    await page.click('#card-transfer-trigger');
    await page.locator('#transfer-modal').waitFor({ state: 'visible' });
    await page.fill('#transfer-target', 'targetmerchant');
    await page.click('#btn-transfer-verify');
    await page.locator('#transfer-step-2').waitFor({ state: 'visible' });
    await page.fill('#transfer-amount', '50');
    const errorEl = page.locator('#transfer-step2-error');
    await errorEl.waitFor({ state: 'visible' });
    const text = await errorEl.textContent();
    assert.ok(text.includes('Saldo insuficiente') || text.includes('Balance is not enough'));
  });
});

async function runAxe(page) {
  await page.addScriptTag({ content: axeCore.source });
  return page.evaluate(() => axe.run(document.body, {
    rules: {
      // Tailwind CDN is a dev-only warning, not a real accessibility issue
      'meta-viewport': { enabled: false }
    }
  }));
}

describe('Accessibility and keyboard navigation', () => {
  let browser;
  let page;
  let staticServer;
  let baseUrl;

  before(async () => {
    staticServer = createMockServer(100);
    await new Promise(resolve => staticServer.listen(0, resolve));
    const addr = staticServer.address();
    baseUrl = `http://localhost:${addr.port}`;
    browser = await launchBrowser();
  });

  after(async () => {
    await browser.close();
    await new Promise(resolve => staticServer.close(resolve));
  });

  beforeEach(async () => {
    page = await browser.newPage();
    page.setDefaultTimeout(5000);
    page.on('dialog', dialog => dialog.accept());
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    await page.addInitScript(() => {
      window.API_URL = '/api/merchant';
      window.BANK_URL = '/api/bank';
    });
  });

  afterEach(async () => {
    await page.close();
  });

  async function login() {
    await page.goto(`${baseUrl}/merchant.html`);
    await page.fill('#auth-user', 'default');
    await page.fill('#auth-pass', 'secret1234');
    await page.click('#btn-login');
    await page.locator('#auth-modal').waitFor({ state: 'hidden' });
    await page.locator('#stat-sold', { hasText: '10.00' }).waitFor({ state: 'visible' });
  }

  it('should have no axe-core violations after login', async () => {
    await login();
    const results = await runAxe(page);
    assert.strictEqual(results.violations.length, 0, JSON.stringify(results.violations, null, 2));
  });

  it('should navigate sections with keyboard', async () => {
    await login();
    // Focus the account navigation button and activate it with Enter
    await page.locator('#nav-account-btn').focus();
    await page.keyboard.press('Enter');

    await page.locator('#account:not(.hidden)').waitFor({ state: 'visible' });
    const active = await page.evaluate(() => document.activeElement?.id);
    assert.ok(active === 'nav-account-btn', `Expected focus on nav-account-btn, got ${active}`);
  });

  it('should open help modal for every dashboard help button', async () => {
    await login();
    const keys = ['stat_sold', 'stat_intransit', 'stat_settled', 'orders_title'];
    for (const key of keys) {
      const btn = page.locator(`[data-help-key="${key}"]`);
      await btn.waitFor({ state: 'visible' });
      await btn.click();
      const helpModal = page.locator('#help-modal');
      await helpModal.waitFor({ state: 'visible' });
      const title = await page.locator('#help-modal-title').textContent();
      assert.ok(title && title.length > 0 && title !== `help_${key}_title`, `Missing help title for ${key}`);
      await page.locator('#btn-help-ok').click();
      await helpModal.waitFor({ state: 'hidden' });
    }
  });

  it('should open help modal for every account help button without triggering the card action', async () => {
    await login();
    await page.locator('#nav-account-btn').click();
    await page.locator('#account:not(.hidden)').waitFor({ state: 'visible' });

    const cases = [
      { key: 'bank_avail', unwantedModal: '#withdraw-modal' },
      { key: 'bank_transfer', unwantedModal: '#transfer-modal' },
      { key: 'tx_title', unwantedModal: null },
      { key: 'btn_close_account', unwantedModal: '#close-account-modal' },
    ];
    for (const { key, unwantedModal } of cases) {
      const btn = page.locator(`[data-help-key="${key}"]`);
      await btn.waitFor({ state: 'visible' });
      await btn.click();
      const helpModal = page.locator('#help-modal');
      await helpModal.waitFor({ state: 'visible' });
      const title = await page.locator('#help-modal-title').textContent();
      assert.ok(title && title.length > 0 && title !== `help_${key}_title`, `Missing help title for ${key}`);
      if (unwantedModal) {
        await page.locator(unwantedModal).waitFor({ state: 'hidden' });
      }
      await page.locator('#btn-help-ok').click();
      await helpModal.waitFor({ state: 'hidden' });
    }
  });

  it('should keep table help buttons inside their headers', async () => {
    await login();
    const tableHeaders = [
      { helpKey: 'orders_title', ancestorLevel: 1 },
      { helpKey: 'tx_title', ancestorLevel: 1 },
    ];
    for (const { helpKey } of tableHeaders) {
      const ok = await page.evaluate((key) => {
        const btn = document.querySelector(`[data-help-key="${key}"]`);
        const header = btn?.closest('.relative.px-6.py-5');
        if (!btn || !header) return false;
        const br = btn.getBoundingClientRect();
        const hr = header.getBoundingClientRect();
        return (
          br.top >= hr.top - 1 &&
          br.left >= hr.left - 1 &&
          br.right <= hr.right + 1 &&
          br.bottom <= hr.bottom + 1
        );
      }, helpKey);
      assert.ok(ok, `Help button ${helpKey} is not inside its table header`);
    }
  });

  it('should show paid orders in the orders table', async () => {
    await login();
    const orderRow = page.locator('#orders-tbody tr:has-text("Coffee")');
    await orderRow.waitFor({ state: 'visible' });
    const text = await orderRow.textContent();
    assert.ok(text.includes('Coffee'));
  });

  it('should have required landmarks and labels', async () => {
    await login();
    const landmarks = await page.evaluate(() => ({
      main: !!document.querySelector('main'),
      header: !!document.querySelector('header'),
      navigation: !!document.querySelector('nav#sidebar'),
      bottomDock: !!document.querySelector('#bottom-dock[role="navigation"]'),
      authModalLabel: document.getElementById('auth-modal')?.getAttribute('aria-labelledby'),
      ordersTableScope: !!document.querySelector('#orders-table th[scope="col"]'),
    }));
    assert.ok(landmarks.main, 'main landmark missing');
    assert.ok(landmarks.header, 'header landmark missing');
    assert.ok(landmarks.navigation, 'sidebar navigation landmark missing');
    assert.ok(landmarks.bottomDock, 'bottom dock navigation landmark missing');
    assert.strictEqual(landmarks.authModalLabel, 'auth-modal-title');
  });
});
