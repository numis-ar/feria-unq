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

    const idsToUpdate = selectedId === undefined ? personalData.keys() : [selectedId];
    const producersById = new Map(producers.map((producer) => [producer.id, producer]));

    for (const id of idsToUpdate) {
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
  }

  printStatus(getStatus(producers, personalData));
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
NODE

flock -u 9
