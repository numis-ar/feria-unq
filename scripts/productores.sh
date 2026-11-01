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
import { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const publicPath = process.env.PRODUCTORES_JSON;
const personalDir = process.env.PRODUCTORES_DIR;
const args = process.argv.slice(2);

if (args.length > 1 || (args.length === 1 && args[0] !== '--update')) {
  console.error('Uso: scripts/productores.sh [--update]');
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

    const infoPath = path.join(personalDir, entry.name, 'info.json');
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
    personalData.set(entry.name, info);
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
  console.log(`${label}: ${values.length}`);
  for (const value of values) console.log(`  - ${value}`);
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

  if (args[0] === '--update') {
    for (const producer of producers) {
      const info = personalData.get(producer.id);
      if (info !== undefined) Object.assign(producer, info, { id: producer.id });
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
