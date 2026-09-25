import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { chromium } from 'playwright';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

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

    await page.addInitScript((url) => {
      window.API_URL = url;
      window.BANK_URL = url;
    }, baseUrl);
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
    await page.fill('#withdraw-amount', '20');
    await page.click('#btn-withdraw');

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
    await page.click('#btn-open-close-account');
    
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
    await page.fill('#transfer-amount', '15');
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

    const orderRow = page.locator('#orders-tbody tr');
    await orderRow.waitFor({ state: 'visible' });
    const text = await orderRow.textContent();
    assert.ok(text.includes('Coffee'));
  });
});
