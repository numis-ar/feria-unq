#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
export ROOT_DIR

node --input-type=module - "$@" <<'NODE'
import { spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.env.ROOT_DIR;
const inputPath = path.join(rootDir, 'web/productores.json.gen');
const outputDir = path.join(rootDir, 'PDFs');
const cartelGenerator = path.join(rootDir, 'web/cartel/generar-cartel.py');
const credencialGenerator = path.join(rootDir, 'web/credencial/generar-credencial.py');
const usage = `Uso:
  scripts/generar-pdfs.sh
  scripts/generar-pdfs.sh --select-by-pair-id N
  scripts/generar-pdfs.sh --select-by-prod-id ID
  scripts/generar-pdfs.sh --gen-by-ids ID_IZQ ID_DER`;

function generate(generator, args) {
  const result = spawnSync('python3', [generator, ...args], {
    cwd: rootDir,
    stdio: 'inherit',
  });
  if (result.error) console.error(`Error al ejecutar ${generator}: ${result.error.message}`);
  return result.status === 0;
}

function parseSelection(args) {
  if (args.length === 0) return { mode: 'all' };
  if (args.length === 1 && args[0] === '--help') return { mode: 'help' };
  if (args.length === 2 && args[0] === '--select-by-pair-id') {
    if (!/^\d+$/.test(args[1]) || Number(args[1]) < 1) throw new Error(`El id de par debe ser un número positivo\n${usage}`);
    return { mode: 'pair', value: Number(args[1]) };
  }
  if (args.length === 2 && args[0] === '--select-by-prod-id') return { mode: 'producer', value: args[1] };
  if (args.length === 3 && args[0] === '--gen-by-ids') return { mode: 'custom', value: [args[1], args[2]] };
  throw new Error(usage);
}

async function main() {
  const selection = parseSelection(process.argv.slice(2));
  if (selection.mode === 'help') {
    console.log(usage);
    return;
  }

  const producers = JSON.parse(await readFile(inputPath, 'utf8'));
  if (!Array.isArray(producers)) throw new Error(`${inputPath} debe contener un array`);

  const producersById = new Map();
  for (const [index, producer] of producers.entries()) {
    if (producer === null || Array.isArray(producer) || typeof producer !== 'object') {
      throw new Error(`El productor ${index + 1} no es un objeto`);
    }
    if (typeof producer.id !== 'string' || producer.id.length === 0) {
      throw new Error(`El productor ${index + 1} no tiene un id válido`);
    }
    if (typeof producer.nombreEmprendimiento !== 'string' || producer.nombreEmprendimiento.length === 0) {
      throw new Error(`El productor ${producer.id} no tiene un nombreEmprendimiento válido`);
    }
    if (producersById.has(producer.id)) throw new Error(`El id ${producer.id} está duplicado`);
    producersById.set(producer.id, producer);
  }

  const pairs = [];
  for (let i = 0; i < producers.length; i += 2) {
    pairs.push({
      left: producers[i],
      right: producers[i + 1] ?? producers[i],
      number: i / 2 + 1,
    });
  }

  let selectedPairs;
  if (selection.mode === 'all') selectedPairs = pairs;
  if (selection.mode === 'pair') selectedPairs = pairs.filter((pair) => pair.number === selection.value);
  if (selection.mode === 'producer') {
    selectedPairs = pairs.filter((pair) => pair.left.id === selection.value || pair.right.id === selection.value);
  }
  if (selection.mode === 'custom') {
    const [leftId, rightId] = selection.value;
    const left = producersById.get(leftId);
    const right = producersById.get(rightId);
    if (!left) throw new Error(`No existe el productor ${leftId}`);
    if (!right) throw new Error(`No existe el productor ${rightId}`);
    selectedPairs = [{ left, right, number: null }];
  }
  if (selectedPairs.length === 0) {
    const label = selection.mode === 'pair' ? `el par ${selection.value}` : `el productor ${selection.value}`;
    throw new Error(`No existe ${label}`);
  }

  await mkdir(outputDir, { recursive: true });
  const failures = [];
  let generated = 0;

  for (const { left, right, number } of selectedPairs) {
    const prefixName = number === null
      ? `${left.id}_${right.id}`
      : `${String(number).padStart(3, '0')}_${left.id}_${right.id}`;
    const prefix = path.join(outputDir, prefixName);
    const leftTalerUri = `taler://pay-template/merchant.taler.ar/instances/${left.id}/UNQ`;
    const rightTalerUri = `taler://pay-template/merchant.taler.ar/instances/${right.id}/UNQ`;
    const leftUrl = `https://unq.numis.ar/productorxs?usr=${left.id}`;
    const rightUrl = `https://unq.numis.ar/productorxs?usr=${right.id}`;

    console.log(`\n${number === null ? 'Par sin id' : `Par ${String(number).padStart(3, '0')}`}: ${left.id} / ${right.id}`);
    for (const [generator, args, output] of [
      [cartelGenerator, [
        '--izquierda', leftTalerUri, left.nombreEmprendimiento,
        '--derecha', rightTalerUri, right.nombreEmprendimiento,
        '-o', `${prefix}_cartel.pdf`,
      ], `${prefix}_cartel.pdf`],
      [credencialGenerator, [
        '--izquierda', leftUrl, left.id,
        '--derecha', rightUrl, right.id,
        '-o', `${prefix}_credencial.pdf`,
      ], `${prefix}_credencial.pdf`],
    ]) {
      if (generate(generator, args)) generated++;
      else failures.push(output);
    }
  }

  console.log(`\nSe generaron ${generated} PDF en ${outputDir}.`);
  if (failures.length > 0) {
    console.error(`No se pudieron generar ${failures.length} PDF:\n${failures.join('\n')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
NODE
