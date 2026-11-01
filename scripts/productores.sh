#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
export PRODUCTORES_JSON="$ROOT_DIR/web/productores.json"
export PRODUCTORES_DIR="$ROOT_DIR/web/productores"

if [[ ! -f "$PRODUCTORES_JSON" ]]; then
  echo "Error: no existe $PRODUCTORES_JSON" >&2
  exit 1
fi

exec 9>"$PRODUCTORES_JSON.lock"
flock -x 9

node --input-type=module - "$@" <<'NODE'
import { spawn } from 'node:child_process';
import { readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const publicPath = process.env.PRODUCTORES_JSON;
const personalDir = process.env.PRODUCTORES_DIR;
const args = process.argv.slice(2);
const update = args[0] === '--update';
const selectedId = update ? args[1] : undefined;
const profileFields = ['descripcion', 'instagram', 'facebook', 'twitter', 'telefono', 'whatsapp', 'ubicacion'];
const imageFiles = ['perfil.png', '1.png', '2.png', '3.png', '4.png'];
const merchantBaseUrl = 'https://merchant.taler.ar';
const placeholderUrl = 'https://unq.numis.ar/screenshots/productor-placeholder.svg';
const instanceConfigFields = [
  'name',
  'email',
  'phone_number',
  'website',
  'logo',
  'address',
  'jurisdiction',
  'use_stefan',
  'default_pay_delay',
  'default_refund_delay',
  'default_wire_transfer_delay',
  'default_wire_transfer_rounding_interval',
];
let defaultLogoPromise;

if (args.length > 2 || (args.length > 0 && !update) || (update && args.length === 2 && !selectedId)) {
  console.error('Uso: scripts/productores.sh [--update [ID]]');
  process.exit(1);
}

async function readPersonalData() {
  let entries;
  try {
    entries = await readdir(personalDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }

  const personalData = new Map();
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const producerDir = path.join(personalDir, entry.name);
    const infoPath = path.join(producerDir, 'info.json');
    let contents;
    try {
      contents = await readFile(infoPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }

    let info;
    try {
      info = JSON.parse(contents);
    } catch (error) {
      throw new Error(`JSON inválido en ${infoPath}: ${error.message}`);
    }
    if (info === null || Array.isArray(info) || typeof info !== 'object') {
      throw new Error(`${infoPath} debe contener un objeto JSON`);
    }
    if (typeof info.telefono === 'string' && info.telefono && !info.telefono.startsWith('+54')) {
      info.telefono = `+54 ${info.telefono}`;
    }
    if (info.whatsapp === true) info.whatsapp = info.telefono || null;
    else if (info.whatsapp === false) info.whatsapp = null;

    const data = {};
    for (const field of profileFields) {
      if (Object.hasOwn(info, field)) data[field] = info[field];
    }
    for (let i = 0; i < imageFiles.length; i++) {
      let imageExists;
      try {
        imageExists = (await stat(path.join(producerDir, imageFiles[i]))).isFile();
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (imageExists) {
        const field = i === 0 ? 'imagen' : `imagen${i + 1}`;
        data[field] = `./productores/${encodeURIComponent(entry.name)}/${imageFiles[i]}`;
      }
    }
    personalData.set(entry.name, data);
  }

  return personalData;
}

async function merchantRequest(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  } catch (error) {
    throw new Error(`No se pudo conectar con Merchant: ${error.message}`);
  }
  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(`Merchant respondió HTTP ${response.status}${details ? `: ${details.slice(0, 200)}` : ''}`);
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

function convertSvgToPng(svg) {
  return new Promise((resolve, reject) => {
    const child = spawn('magick', ['-', '-resize', '140x140!', 'png:-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    const output = [];
    const errors = [];
    let failure;
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.on('error', (error) => { failure = error; });
    child.stdin.on('error', (error) => { failure = error; });
    child.on('close', (code) => {
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0) {
        reject(new Error(`ImageMagick falló: ${Buffer.concat(errors).toString().trim()}`));
        return;
      }
      resolve(Buffer.concat(output));
    });
    child.stdin.end(svg);
  });
}

async function getDefaultLogo() {
  defaultLogoPromise ??= (async () => {
    const response = await fetch(placeholderUrl, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`No se pudo descargar el placeholder: HTTP ${response.status}`);
    const png = await convertSvgToPng(Buffer.from(await response.arrayBuffer()));
    return `data:image/png;base64,${png.toString('base64')}`;
  })();
  return defaultLogoPromise;
}

async function getProducerLogo(id) {
  try {
    const png = await readFile(path.join(personalDir, id, 'perfil.png'));
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return getDefaultLogo();
  }
}

async function updateMerchantLogo(id, token) {
  const logo = await getProducerLogo(id);
  const authorization = `Bearer ${token}`;
  const instanceUrl = `${merchantBaseUrl}/management/instances/${encodeURIComponent(id)}`;
  const response = await merchantRequest(instanceUrl, { headers: { Authorization: authorization } });
  const current = await response.json();
  const configuration = {};
  for (const field of instanceConfigFields) {
    if (current[field] !== undefined) configuration[field] = current[field];
  }
  configuration.logo = logo;
  await merchantRequest(instanceUrl, {
    method: 'PATCH',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(configuration),
  });
}

function getStatus(producers, personalData) {
  const publicIds = new Set(producers.map((producer) => producer.id));
  const outdated = [];
  const missing = [];
  const matching = [];
  const notPublic = [];

  for (const id of personalData.keys()) {
    if (!publicIds.has(id)) notPublic.push(id);
  }

  for (const producer of producers) {
    const info = personalData.get(producer.id);
    if (info === undefined) {
      missing.push(producer.id);
      continue;
    }

    const fields = Object.entries(info)
      .filter(([field, value]) => !isDeepStrictEqual(producer[field], value))
      .map(([field]) => field);
    if (fields.length > 0) outdated.push({ id: producer.id, fields });
    else matching.push(producer.id);
  }

  return { outdated, missing, matching, notPublic };
}

function printList(label, values) {
  console.log(`${label} (${values.length})${values.length > 0 ? `: ${values.join(', ')}` : ''}`);
}

function printStatus(status) {
  printList('Faltan actualizar', status.outdated.map(({ id, fields }) => `${id} (${fields.join(', ')})`));
  printList('No son públicos', status.notPublic);
  printList('Sin datos personales', status.missing);
  console.log(`Coinciden los campos: ${status.matching.length}`);
}

async function main() {
  const producers = JSON.parse(await readFile(publicPath, 'utf8'));
  if (!Array.isArray(producers)) {
    throw new Error(`${publicPath} debe contener un arreglo JSON`);
  }

  const publicIds = new Set();
  for (const producer of producers) {
    if (producer === null || Array.isArray(producer) || typeof producer !== 'object' || typeof producer.id !== 'string') {
      throw new Error(`${publicPath} contiene un productor sin un id válido`);
    }
    if (publicIds.has(producer.id)) {
      throw new Error(`${publicPath} contiene el id duplicado ${producer.id}`);
    }
    publicIds.add(producer.id);
  }

  const personalData = await readPersonalData();

  if (update) {
    if (selectedId !== undefined && !personalData.has(selectedId)) {
      throw new Error(`No existe ${path.join(personalDir, selectedId, 'info.json')}`);
    }
    if (!process.env.MERCHANT_PASSWORD) {
      throw new Error('MERCHANT_PASSWORD es obligatorio para --update');
    }

    const idsToUpdate = selectedId === undefined ? [...personalData.keys()] : [selectedId];
    const token = idsToUpdate.length > 0 ? await getMerchantToken() : null;
    const producersById = new Map(producers.map((producer) => [producer.id, producer]));
    const failedIds = [];

    for (const id of idsToUpdate) {
      try {
        await updateMerchantLogo(id, token);
      } catch (error) {
        failedIds.push(id);
        console.error(`${id}: ${error.message}`);
        continue;
      }

      const info = personalData.get(id);
      const producer = producersById.get(id);
      if (producer === undefined) producers.push({ ...info, id });
      else Object.assign(producer, info, { id });
    }

    const temporaryPath = `${publicPath}.${process.pid}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(producers, null, 2)}\n`, { flag: 'wx' });
      await rename(temporaryPath, publicPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }

    if (failedIds.length > 0) {
      console.error(`No se actualizaron: ${failedIds.join(', ')}`);
      process.exitCode = 1;
    }
  }

  printStatus(getStatus(producers, personalData));
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
NODE

flock -u 9
