import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { chromium } from 'playwright';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

const producers = [
  {
    id: 'four',
    nombreEmprendimiento: 'Cuatro',
    rubro: 'Artesanías',
    descripcion: 'Cuatro fotos',
    imagen: './screenshots/productor-placeholder.svg',
    imagen1: './productores/four/1.png',
    imagen2: './productores/four/2.png',
    imagen3: './productores/four/3.png',
    imagen4: './productores/four/4.png',
  },
  {
    id: 'two',
    nombreEmprendimiento: 'Dos',
    rubro: 'Artesanías',
    descripcion: 'Dos fotos',
    imagen: './screenshots/productor-placeholder.svg',
    imagen1: './productores/two/1.png',
    imagen3: './productores/two/3.png',
    imagen4: '',
  },
  {
    id: 'none',
    nombreEmprendimiento: 'Ninguna',
    descripcion: 'Sin fotos ni rubro',
    imagen: './screenshots/productor-placeholder.svg',
  },
];

describe('Galería del detalle de productor', () => {
  let browser;
  let page;
  let server;
  let baseUrl;

  before(async () => {
    server = http.createServer((req, res) => {
      let cleanUrl = req.url.split('?')[0];
      if (cleanUrl === '/productores.json') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(producers));
        return;
      }
      if (cleanUrl === '/') cleanUrl = '/donde.html';
      const filePath = path.join(process.cwd(), 'web', cleanUrl.replace(/^\/+/, ''));
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
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

  it('muestra cuatro imágenes en una fila y abre el visor a pantalla completa', async () => {
    await page.goto(`${baseUrl}/donde.html?p=four`);
    await page.locator('#modal-overlay[aria-hidden="false"]').waitFor();

    const buttons = page.locator('.producer-gallery__button');
    assert.equal(await buttons.count(), 4);
    const tops = await buttons.evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().top)));
    assert.equal(new Set(tops).size, 1);

    await buttons.nth(2).click();
    assert.equal(await page.locator('#image-viewer').getAttribute('aria-hidden'), 'false');
    assert.match(await page.locator('#image-viewer-image').getAttribute('src'), /3\.png$/);
    assert.equal(await page.locator('#modal-overlay').getAttribute('inert'), '');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'image-viewer-close');

    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'image-viewer-close');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#image-viewer').getAttribute('aria-hidden'), 'true');
    assert.equal(await page.locator('#modal-overlay').getAttribute('aria-hidden'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.src), './productores/four/3.png');

    await buttons.nth(0).click();
    await page.locator('#image-viewer-close').click();
    assert.equal(await page.evaluate(() => document.activeElement.dataset.src), './productores/four/1.png');

    await buttons.nth(1).click();
    await page.locator('#image-viewer').click({ position: { x: 5, y: 5 } });
    assert.equal(await page.locator('#image-viewer').getAttribute('aria-hidden'), 'true');
  });

  it('muestra solo las imágenes disponibles y conserva una sola fila en pantalla angosta', async () => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(`${baseUrl}/donde.html?p=two`);
    await page.locator('#modal-overlay[aria-hidden="false"]').waitFor();

    const buttons = page.locator('.producer-gallery__button');
    assert.equal(await buttons.count(), 2);
    const sources = await buttons.evaluateAll((elements) => elements.map((element) => element.dataset.src));
    assert.deepEqual(sources, ['./productores/two/1.png', './productores/two/3.png']);
    const tops = await buttons.evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().top)));
    assert.equal(new Set(tops).size, 1);

    await page.goto(`${baseUrl}/donde.html?p=none`);
    await page.locator('#modal-overlay[aria-hidden="false"]').waitFor();
    assert.equal(await page.locator('.producer-gallery').count(), 0);
    assert.equal(await page.locator('#image-viewer').getAttribute('aria-hidden'), 'true');
    assert.equal(await page.locator('.producer-card[data-id="none"] .producer-card__tag').count(), 0);
    assert.equal(await page.locator('.producer-card[data-id="four"] .producer-card__tag').count(), 1);
  });
});
