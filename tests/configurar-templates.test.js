import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve('scripts/configurar-templates.sh');

async function createProducersFile(t, producers) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'configurar-templates-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'productores.json');
  await writeFile(filePath, JSON.stringify(producers));
  return filePath;
}

async function createMerchant(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

test('crea o actualiza UNQ para cada productor sin importe inicial', async (t) => {
  const producersPath = await createProducersFile(t, [{ id: 'nuevo' }, { id: 'existente' }]);
  const requests = [];
  const merchantBaseUrl = await createMerchant(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body: body ? JSON.parse(body) : undefined,
    });

    if (req.url === '/instances/admin/private/token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'test-token' }));
    } else if (req.method === 'GET' && req.url === '/instances/nuevo/private/templates/UNQ') {
      res.writeHead(404).end();
    } else if (req.method === 'GET' && req.url === '/instances/existente/private/templates/UNQ') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({}));
    } else if (['POST', 'PATCH'].includes(req.method)) {
      res.writeHead(204).end();
    } else {
      res.writeHead(500).end();
    }
  });

  const { stdout } = await execFileAsync(scriptPath, [], {
    env: {
      ...process.env,
      MERCHANT_BASE_URL: merchantBaseUrl,
      MERCHANT_PASSWORD: 'test-password',
      PRODUCTORES_JSON: producersPath,
    },
  });

  assert.match(stdout, /nuevo: creado/);
  assert.match(stdout, /existente: actualizado/);
  assert.match(stdout, /1 creados, 1 actualizados, 0 fallidos/);
  assert.equal(requests[0].authorization, `Basic ${Buffer.from('admin:test-password').toString('base64')}`);
  assert.ok(requests.slice(1).every((request) => request.authorization === 'Bearer test-token'));

  const create = requests.find((request) => request.method === 'POST' && request.url === '/instances/nuevo/private/templates');
  assert.deepEqual(create.body, {
    template_id: 'UNQ',
    template_description: 'UNQ',
    template_contract: {
      summary: 'Pago por QR',
      pay_duration: { d_us: 300000000 },
      template_type: 'fixed-order',
    },
    editable_defaults: {},
  });
  const update = requests.find((request) => request.method === 'PATCH');
  assert.equal(update.url, '/instances/existente/private/templates/UNQ');
  assert.deepEqual(update.body, {
    template_description: 'UNQ',
    template_contract: create.body.template_contract,
    editable_defaults: {},
  });
  assert.equal('amount' in create.body.template_contract, false);
});

test('continúa con los demás productores y devuelve error si alguno falla', async (t) => {
  const producersPath = await createProducersFile(t, [{ id: 'falla' }, { id: 'funciona' }]);
  const merchantBaseUrl = await createMerchant(t, async (req, res) => {
    for await (const chunk of req) void chunk;
    if (req.url === '/instances/admin/private/token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'test-token' }));
    } else if (req.url.includes('/falla/')) {
      res.writeHead(500, 'Error simulado').end();
    } else if (req.method === 'GET') {
      res.writeHead(404).end();
    } else {
      res.writeHead(204).end();
    }
  });

  const result = await execFileAsync(scriptPath, [], {
    env: {
      ...process.env,
      MERCHANT_BASE_URL: merchantBaseUrl,
      MERCHANT_PASSWORD: 'test-password',
      PRODUCTORES_JSON: producersPath,
    },
  }).catch((error) => error);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /funciona: creado/);
  assert.match(result.stderr, /falla: Merchant respondió HTTP 500/);
  assert.match(result.stderr, /No se configuraron: falla/);
});

test('dry-run no requiere contraseña ni conexión', async (t) => {
  const producersPath = await createProducersFile(t, [{ id: 'uno' }, { id: 'dos' }]);
  const env = { ...process.env, PRODUCTORES_JSON: producersPath };
  delete env.MERCHANT_PASSWORD;

  const { stdout } = await execFileAsync(scriptPath, ['--dry-run'], { env });
  assert.match(stdout, /template UNQ en 2 productores/);
  assert.match(stdout, /"d_us": 300000000/);
});
