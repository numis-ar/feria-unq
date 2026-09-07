import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 3001;
const LISTEN_PID = process.env.LISTEN_PID;
const LISTEN_FDS = process.env.LISTEN_FDS;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'web'); 

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif'
};

const server = http.createServer((req, res) => {
  let safeSuffix = path.normalize(req.url).replace(/^(\.\.(\/|\\|$))+/, '');
  
  if (safeSuffix === '/' || safeSuffix === '') {
    safeSuffix = '/index.html';
  }

  const filePath = path.join(PUBLIC_DIR, safeSuffix);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    res.writeHead(200, { 'Content-Type': contentType });
    const stream = fs.createReadStream(filePath);
    stream.on('error', (streamErr) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('500 Internal Server Error');
    });
    stream.pipe(res);
  });
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

