#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fields = [
  'nombreEmprendimiento',
  'nombreApellido',
  'descripcion',
  'rubro',
  'organizacion',
  'email',
  'telefono',
  'whatsapp',
  'instagram',
  'twitter',
  'facebook',
  'ubicacion',
  'imagen',
  'imagen1',
  'imagen2',
  'imagen3',
  'imagen4',
  'id',
];

function parseCsv(input) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < input.length; i++) {
    const character = input[i];
    if (quoted) {
      if (character === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"' && field === '') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (character === '\r' && input[i + 1] === '\n') i++;
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error('El CSV contiene un campo entre comillas sin cerrar');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((columns) => columns.some((column) => column !== ''));
}

function readRows(csv) {
  const [headers, ...lines] = parseCsv(csv.replace(/^\uFEFF/, ''));
  if (!headers) throw new Error('El CSV está vacío');
  const names = headers.map((header) => header.trim());
  return lines.map((columns) => Object.fromEntries(names.map((name, index) => [name, columns[index] ?? ''])));
}

function calculateId(name) {
  const result = spawnSync('iconv', ['-f', 'UTF-8', '-t', 'ASCII//TRANSLIT'], {
    input: name,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`iconv falló: ${result.stderr.trim()}`);
  return result.stdout.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function readJson(file, fallback) {
  let contents;
  try {
    contents = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
  return JSON.parse(contents);
}

function column(row, name) {
  return (row[name] ?? '').trim();
}

function socialValue(social, field) {
  const value = social?.[field];
  return typeof value === 'string' ? value.trim() : '';
}

function hasValue(value) {
  return value !== '';
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 3) {
    throw new Error('Uso: node scripts/generar-productores.js [CSV] [JSON_DE_SALIDA] [REDES_SOCIALES]');
  }
  const csvPath = path.resolve(args[0] ?? path.join(rootDir, 'Feria EPSS UNQ 2026-Nov-segundo.csv'));
  const outputPath = path.resolve(args[1] ?? path.join(rootDir, 'web/productores.json.gen'));
  const socialPath = path.resolve(args[2] ?? path.join(rootDir, 'redes-sociales.json'));

  const [csv, currentProducers, socialNetworks] = await Promise.all([
    readFile(csvPath, 'utf8'),
    readJson(outputPath, []),
    readJson(socialPath),
  ]);
  if (!Array.isArray(currentProducers)) throw new Error(`${outputPath} debe contener un array`);
  if (socialNetworks === null || Array.isArray(socialNetworks) || typeof socialNetworks !== 'object') {
    throw new Error(`${socialPath} debe contener un objeto`);
  }

  const producers = currentProducers.map((producer) => ({ ...producer }));
  const currentIndexById = new Map();
  for (const [index, producer] of currentProducers.entries()) {
    if (producer !== null && !Array.isArray(producer) && typeof producer === 'object' && typeof producer.id === 'string') {
      currentIndexById.set(producer.id, index);
    }
  }

  const generatedIds = new Map();
  let generated = 0;
  for (const row of readRows(csv)) {
    const name = column(row, 'Nombre del Emprendimiento');
    if (!name) continue;
    const id = calculateId(name);
    if (!id) continue;
    const surname = column(row, 'Apellido');
    const givenName = column(row, 'Nombre');
    const social = socialNetworks[column(row, 'id')];
    const authoritative = {
      nombreEmprendimiento: name,
      nombreApellido: surname || givenName ? `${surname},${givenName}` : '',
      descripcion: column(row, 'Enumerar 3 productos destacados que vas a traer'),
      rubro: column(row, 'Rubro del emprendimiento'),
      organizacion: column(row, 'Organización'),
      email: column(row, 'Dirección de correo electrónico'),
      telefono: column(row, 'Celular de la/el emprendedor'),
      whatsapp: column(row, 'Celular de la/el emprendedor'),
      instagram: socialValue(social, 'instagram'),
      twitter: socialValue(social, 'twitter'),
      facebook: socialValue(social, 'facebook'),
      ubicacion: column(row, 'Ubicación'),
      imagen: `./productores/${id}/prefil.png`,
      imagen1: `./productores/${id}/1.png`,
      imagen2: `./productores/${id}/2.png`,
      imagen3: `./productores/${id}/3.png`,
      imagen4: `./productores/${id}/4.png`,
      id,
    };
    const currentIndex = currentIndexById.get(id);
    const current = currentIndex === undefined
      ? Object.fromEntries(fields.map((field) => [field, '']))
      : producers[currentIndex];
    const producer = { ...current };
    for (const field of fields) {
      if (hasValue(authoritative[field])) producer[field] = authoritative[field];
    }
    if (currentIndex === undefined) producers.push(producer);
    else producers[currentIndex] = producer;
    generated++;
    generatedIds.set(id, (generatedIds.get(id) ?? 0) + 1);
  }

  const duplicates = [...generatedIds].filter(([, count]) => count > 1).map(([id]) => id);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(producers, null, 2)}\n`, { flag: 'wx' });
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }

  console.log(`Se generaron ${generated} productores y se conservaron ${currentProducers.length} registros existentes.`);
  if (duplicates.length > 0) console.warn(`Advertencia: hay id repetidos: ${duplicates.join(', ')}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
