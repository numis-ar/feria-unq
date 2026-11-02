import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { chromium } from 'playwright';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

describe('URLs de pago del puesto', () => {
  let browser;
  let page;
  let server;
  let baseUrl;

  before(async () => {
    server = http.createServer((req, res) => {
      let cleanUrl = new URL(req.url, 'http://localhost').pathname;
      if (cleanUrl === '/puesto-test') cleanUrl = '/puesto.html';
      const filePath = path.join(process.cwd(), 'web', cleanUrl.replace(/^\/+/, ''));
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
        res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
        fs.createReadStream(filePath).pipe(res);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  });

  after(async () => {
    await browser?.close();
    await new Promise((resolve) => server?.close(resolve));
  });

  beforeEach(async () => {
    page = await browser.newPage();
  });

  afterEach(async () => {
    await page?.close();
  });

  it('mantiene las URLs Taler del mapa de puestos', async () => {
    await page.goto(`${baseUrl}/puesto-test`);
    assert.strictEqual(
      await page.locator('#btn-pay').getAttribute('href'),
      'taler://pay-template/merchant.taler.ar/instances/test/UNQ'
    );
    assert.strictEqual(await page.locator('#qr-frame svg').count(), 1);
    assert.strictEqual(await page.locator('#missing-qr').isVisible(), false);
  });

  it('acepta URLs HTTPS explícitas', async () => {
    const paymentUrl = 'https://pay.example.test/order/123';
    const params = new URLSearchParams({ qr: paymentUrl });
    await page.goto(`${baseUrl}/puesto.html?${params}`);
    assert.strictEqual(await page.locator('#btn-pay').getAttribute('href'), paymentUrl);
    assert.strictEqual(await page.locator('#qr-frame svg').count(), 1);
  });

  it('rechaza esquemas ejecutables y oculta el botón de pago', async () => {
    const unsafeUrls = [
      'javascript:window.__puestoXss=1',
      'data:text/html,<script>window.__puestoXss=1</script>',
    ];
    for (const value of unsafeUrls) {
      const params = new URLSearchParams({ qr: value });
      await page.goto(`${baseUrl}/puesto.html?${params}`);
      await page.locator('#missing-qr').waitFor({ state: 'visible' });
      assert.strictEqual(await page.locator('#btn-pay').isVisible(), false);
      assert.strictEqual(await page.locator('#qr-frame svg').count(), 0);
      assert.strictEqual(await page.evaluate(() => window.__puestoXss), undefined);
    }
  });
});
