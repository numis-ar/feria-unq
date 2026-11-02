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
  {
    id: 'broken',
    nombreEmprendimiento: 'Rotas',
    rubro: 'Artesanías',
    descripcion: 'Imágenes rotas',
    imagen: './productores/broken/perfil.png',
    imagen1: './productores/broken/1.png',
    imagen2: './productores/broken/2.png',
    imagen3: './productores/broken/3.png',
    imagen4: './productores/broken/4.png',
  },
  {
    id: 'unnamed',
    rubro: 'Artesanías',
    descripcion: 'Sin nombre de emprendimiento',
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
      if (/^\/productores\/(four|two)\/.+\.png$/.test(cleanUrl)) {
        res.setHeader('Content-Type', 'image/png');
        fs.createReadStream(path.join(process.cwd(), 'web', 'mapa-unq.png')).pipe(res);
        return;
      }
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

  it('usa el placeholder en perfiles rotos y omite las fotos de galería que fallan', async () => {
    await page.goto(`${baseUrl}/donde.html?p=broken`);
    await page.locator('#modal-overlay[aria-hidden="false"]').waitFor();
    await page.locator('.producer-card[data-id="broken"] .producer-card__image').scrollIntoViewIfNeeded();

    await page.waitForFunction(() => {
      const images = document.querySelectorAll('.producer-card[data-id="broken"] .producer-card__image, .modal__image');
      return images.length === 2 && Array.from(images).every((image) =>
        image.src.endsWith('/screenshots/productor-placeholder.svg') && image.complete && image.naturalWidth > 0
      );
    });
    await page.locator('.producer-gallery').waitFor({ state: 'detached' });

    assert.equal(await page.locator('.producer-gallery__button').count(), 0);
  });

  it('omite emprendimientos sin nombre y ordena perfiles sin rubro', async () => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(`${baseUrl}/donde.html`);
    await page.locator('.producer-card[data-id="four"]').waitFor();
    assert.equal(await page.locator('.producer-card[data-id="unnamed"]').count(), 0);

    await page.selectOption('#orden', 'rubro-asc');
    assert.equal(await page.locator('.producer-card').count(), 4);
    assert.deepEqual(errors, []);
  });
});
