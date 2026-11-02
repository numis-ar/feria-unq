#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
export PRODUCTORES_JSON=${PRODUCTORES_JSON:-"$ROOT_DIR/web/productores.json.gen"}
export MERCHANT_BASE_URL=${MERCHANT_BASE_URL:-https://merchant.taler.ar}

node --input-type=module - "$@" <<'NODE'
import { readFile } from 'node:fs/promises';

const producersPath = process.env.PRODUCTORES_JSON;
const merchantBaseUrl = process.env.MERCHANT_BASE_URL.replace(/\/$/, '');
const args = process.argv.slice(2);
const dryRun = args.length === 1 && args[0] === '--dry-run';
const templateId = 'UNQ';
const template = {
  template_description: templateId,
  template_contract: {
    summary: 'Pago por QR',
    pay_duration: { d_us: 5 * 60 * 1_000_000 },
    template_type: 'fixed-order',
  },
  editable_defaults: {},
};

if (args.length > 1 || (args.length === 1 && !dryRun)) {
  console.error('Uso: scripts/configurar-templates.sh [--dry-run]');
  process.exit(1);
}

async function merchantRequest(url, options = {}, allowedStatuses = []) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  } catch (error) {
    throw new Error(`No se pudo conectar con Merchant: ${error.message}`);
  }
  if (!response.ok && !allowedStatuses.includes(response.status)) {
    const details = await response.text().catch(() => '');
    throw new Error(`Merchant respondió HTTP ${response.status}${details ? `: ${details.slice(0, 300)}` : ''}`);
  }
  return response;
}

async function getMerchantToken() {
  const credentials = Buffer.from(`admin:${process.env.MERCHANT_PASSWORD}`).toString('base64');
  const response = await merchantRequest(`${merchantBaseUrl}/instances/admin/private/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ scope: 'all' }),
  });
  const data = await response.json();
  const token = data.access_token || data.token;
  if (!token) throw new Error('Merchant no devolvió un access token');
  return token;
}

async function configureTemplate(id, token) {
  const authorization = `Bearer ${token}`;
  const instanceUrl = `${merchantBaseUrl}/instances/${encodeURIComponent(id)}`;
  const templateUrl = `${instanceUrl}/private/templates/${templateId}`;
  const headers = { Authorization: authorization };
  const current = await merchantRequest(templateUrl, { headers }, [404]);

  if (current.status === 404) {
    await merchantRequest(`${instanceUrl}/private/templates`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ template_id: templateId, ...template }),
    });
    return 'creado';
  }

  await merchantRequest(templateUrl, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(template),
  });
  return 'actualizado';
}

async function main() {
  const producers = JSON.parse(await readFile(producersPath, 'utf8'));
  if (!Array.isArray(producers)) {
    throw new Error(`${producersPath} debe contener un arreglo JSON`);
  }

  const ids = new Set();
  for (const producer of producers) {
    if (producer === null || Array.isArray(producer) || typeof producer !== 'object' ||
        typeof producer.id !== 'string' || producer.id.length === 0) {
      throw new Error(`${producersPath} contiene un productor sin un id válido`);
    }
    if (ids.has(producer.id)) throw new Error(`${producersPath} contiene el id duplicado ${producer.id}`);
    ids.add(producer.id);
  }

  if (dryRun) {
    console.log(`Se configuraría el template ${templateId} en ${ids.size} productores.`);
    console.log(JSON.stringify({ template_id: templateId, ...template }, null, 2));
    return;
  }
  if (!process.env.MERCHANT_PASSWORD) {
    throw new Error('MERCHANT_PASSWORD es obligatorio (o use --dry-run)');
  }

  const token = ids.size > 0 ? await getMerchantToken() : null;
  const failedIds = [];
  let created = 0;
  let updated = 0;

  for (const id of ids) {
    try {
      const action = await configureTemplate(id, token);
      if (action === 'creado') created++;
      else updated++;
      console.log(`${id}: ${action}`);
    } catch (error) {
      failedIds.push(id);
      console.error(`${id}: ${error.message}`);
    }
  }

  console.log(`Resultado: ${created} creados, ${updated} actualizados, ${failedIds.length} fallidos.`);
  if (failedIds.length > 0) {
    console.error(`No se configuraron: ${failedIds.join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
NODE
