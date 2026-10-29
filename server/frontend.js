import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import {
  initUxMetrics,
  handleUxMetricsPost,
  handleUxMetricsGet,
} from './ux-metrics.js';

const PORT = process.env.PORT || 3001;
const LISTEN_PID = process.env.LISTEN_PID;
const LISTEN_FDS = process.env.LISTEN_FDS;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'web');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip'
};

let PUBLIC_DIR_REAL;
try {
  PUBLIC_DIR_REAL = await fs.promises.realpath(PUBLIC_DIR);
} catch {
  PUBLIC_DIR_REAL = PUBLIC_DIR;
}

const BASE_URL = process.env.BASE_URL || 'https://unq.numis.ar';

let productores = [];
let dondeHtml = '';
try {
  productores = JSON.parse(
    await fs.promises.readFile(path.join(PUBLIC_DIR, 'productores.json'), 'utf8')
  );
  dondeHtml = await fs.promises.readFile(path.join(PUBLIC_DIR, 'donde.html'), 'utf8');
} catch (err) {
  console.error('Failed to preload productores.json or donde.html:', err.message);
}

initUxMetrics();

function findProducer(slug) {
  return productores.find((p) => p.slug === slug);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function absoluteImageUrl(imagen) {
  if (!imagen) return `${BASE_URL}/mapa-unq.png`;
  if (imagen.startsWith('http://') || imagen.startsWith('https://')) return imagen;
  const lower = imagen.toLowerCase();
  if (lower.includes('placeholder') || lower.endsWith('.svg')) {
    return `${BASE_URL}/mapa-unq.png`;
  }
  if (imagen.startsWith('/')) return `${BASE_URL}${imagen}`;
  return `${BASE_URL}/${imagen.replace(/^\.\//, '')}`;
}

function injectProducerMeta(html, producer, requestUrl) {
  const pageUrl = new URL(requestUrl, BASE_URL).href;
  const title = `${producer.nombreEmprendimiento} · Feria UNQ`;
  const description = producer.descripcion || 'Productorx de la Feria UNQ.';
  const image = absoluteImageUrl(producer.imagen);

  const block = [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${escapeHtml(pageUrl)}" />`,
    `<meta property="og:image" content="${escapeHtml(image)}" />`,
    `<meta property="og:locale" content="es_AR" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
    `<link rel="canonical" href="${escapeHtml(pageUrl)}" />`
  ].join('\n    ');

  // Reemplazamos el bloque OG original de donde.html por el del productor.
  return html.replace(
    /<title>[\s\S]*?<meta property="og:locale" content="es_AR" \/>/,
    block
  );
}

async function loadProducers() {
  try {
    return JSON.parse(
      await fs.promises.readFile(path.join(PUBLIC_DIR, 'productores.json'), 'utf8')
    );
  } catch {
    return productores;
  }
}

async function serveDondeHtml(res, reqUrl) {
  const url = new URL(reqUrl, 'http://localhost');
  const slug = url.searchParams.get('p');
  const producers = await loadProducers();
  const producer = slug ? producers.find((p) => p.slug === slug) : null;

  let html = dondeHtml || '';
  if (!html) {
    sendError(res, 500, 'Internal Server Error');
    return;
  }

  if (producer) {
    html = injectProducerMeta(html, producer, reqUrl);
  }

  const body = Buffer.from(html, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(body.length),
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function sendError(res, status, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = Buffer.from(message);
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(body.length)
  });
  res.end(body);
}

function isWithinPublic(realFilePath) {
  const pubWithSep = PUBLIC_DIR_REAL.endsWith(path.sep)
    ? PUBLIC_DIR_REAL
    : PUBLIC_DIR_REAL + path.sep;
  return realFilePath === PUBLIC_DIR_REAL || realFilePath.startsWith(pubWithSep);
}

function safePathname(reqUrl) {
  try {
    return new URL(reqUrl, 'http://localhost').pathname;
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/ux-metrics') {
    if (req.method === 'POST') {
      await handleUxMetricsPost(req, res);
      return;
    }
    if (req.method === 'GET') {
      handleUxMetricsGet(req, res);
      return;
    }
    sendError(res, 405, 'Method Not Allowed');
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, 'Method Not Allowed');
    return;
  }

  if (url.pathname === '/donde.html') {
    await serveDondeHtml(res, req.url);
    return;
  }

  const pathname = safePathname(req.url);
  if (pathname === null) {
    sendError(res, 400, 'Bad Request');
    return;
  }

  let safeSuffix = path.normalize(pathname);
  if (safeSuffix === path.sep || safeSuffix === '') {
    safeSuffix = path.sep + 'index.html';
  }

  // Friendly puesto IDs: /puesto-<id> serves puesto.html so the JS can read
  // the ID from the pathname and look it up in its internal map.
  if (/^\/puesto-[^/]+$/.test(safeSuffix)) {
    safeSuffix = path.sep + 'puesto.html';
  }

  const filePath = path.join(PUBLIC_DIR, safeSuffix);

  let stats;
  try {
    stats = await fs.promises.stat(filePath);
  } catch (err) {
    sendError(res, 404, 'Not Found');
    return;
  }

  if (!stats.isFile()) {
    sendError(res, 404, 'Not Found');
    return;
  }

  let realFilePath;
  try {
    realFilePath = await fs.promises.realpath(filePath);
  } catch {
    sendError(res, 404, 'Not Found');
    return;
  }

  if (!isWithinPublic(realFilePath)) {
    sendError(res, 404, 'Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'text/html; charset=utf-8';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': String(stats.size),
    'X-Content-Type-Options': 'nosniff'
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = fs.createReadStream(filePath);

  try {
    await pipeline(stream, res);
  } catch (err) {
    console.error(`Error streaming ${filePath}:`, err);
    if (!res.headersSent) {
      sendError(res, 500, 'Internal Server Error');
    } else {
      res.destroy();
    }
  }
});

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});

if (LISTEN_PID && parseInt(LISTEN_PID, 10) === process.pid && parseInt(LISTEN_FDS, 10) > 0) {
  server.listen({ fd: 3 }, () => {
    console.log('Server executing via systemd socket activation (FD 3)');
  });
} else {
  server.listen(PORT, () => {
    console.log(`Server executing at http://localhost:${PORT}/`);
  });
}
