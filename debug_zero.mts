import { chromium } from 'playwright';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

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
      res.end(JSON.stringify({ orders: [] }));
      return;
    }
    if (cleanUrl.includes('/transactions')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ transactions: [], row_id: 123 }));
      return;
    }
    if (cleanUrl.match(/\/accounts\/[^/?]+$/)) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ name: 'Test Merchant', balance: { amount: `NUMIS:${balanceAmount}` } }));
      return;
    }
    if (cleanUrl.includes('/private/auth') || cleanUrl.includes('/auth')) {
      res.writeHead(204); res.end(); return;
    }
    if (cleanUrl === '/') cleanUrl = '/merchant.html';
    let filePath = path.join(process.cwd(), 'web', cleanUrl.replace(/^\/+/, ''));
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const map = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
      res.setHeader('Content-Type', map[ext] || 'text/plain');
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404); res.end('Not found');
    }
  });
}

const staticServer = createMockServer(0);
await new Promise(resolve => staticServer.listen(0, resolve));
const addr = staticServer.address();
const baseUrl = `http://localhost:${addr.port}`;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('console', msg => console.log('PAGE LOG:', msg.text()));
page.on('pageerror', err => console.log('PAGE ERR:', err.message));
await page.addInitScript(() => { window.API_URL = '/api/merchant'; window.BANK_URL = '/api/bank'; });
await page.goto(`${baseUrl}/merchant.html`);
await page.fill('#auth-user', 'default');
await page.fill('#auth-pass', 'secret1234');
await page.click('#btn-login');
await page.locator('#auth-modal').waitFor({ state: 'hidden' });
await page.click('#nav-account-btn');
await page.locator('#account:not(.hidden)').waitFor({ state: 'visible' });
console.log('balance text:', await page.locator('#stat-bank-available').textContent());
await page.click('#card-available-trigger');
await new Promise(r => setTimeout(r, 500));
console.log('withdraw modal hidden?', await page.locator('#withdraw-modal').isHidden());
console.log('toast container children:', await page.locator('#toast-container').evaluate(el => el.innerHTML));
await browser.close();
staticServer.close();
