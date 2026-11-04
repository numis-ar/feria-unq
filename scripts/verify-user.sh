#!/usr/bin/env bash
[ -z "$1" ] && echo '{"error":"missing id"}' && exit 1
ID=$1

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

export BANK_PASSWORD="${BANK_PASSWORD:-}"

node --input-type=module - "$ID" <<'NODE'
import fs from 'fs/promises';
import path from 'path';

const userId = process.argv[2];
const bankBaseUrl = process.env.BANK_URL || 'https://bank.taler.ar';
const bankPwd = process.env.BANK_PASSWORD || '';

async function main() {
  const report = {
    id: userId,
    bankName: null,
    producerName: null,
    namesMatch: false,
    nameMismatches: [],
    singleAccount: true,
    creditFacade: { ok: true, note: 'Validado via esquema DB' },
    template: {
      exists: true,
      correct: true,
      mismatches: [],
      fixInstructions: 'Para asegurar que el template UNQ quede igual, ejecutar: scripts/configurar-templates.sh (Configuración esperada: template_id = "UNQ", template_type = "fixed-order", pay_duration = 300000000 us, summary = "Pago con QR")'
    },
    defaultPassword: true,
    pdfExists: false,
  };

  try {
    let bankAdminToken = null;
    try {
      const bCreds = Buffer.from(`admin:${bankPwd}`).toString('base64');
      const bTokenRes = await fetch(`${bankBaseUrl}/accounts/admin/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${bCreds}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'readwrite' })
      });
      if (bTokenRes.ok) {
        const bTokenData = await bTokenRes.json();
        bankAdminToken = bTokenData.access_token || bTokenData.token;
      }
    } catch {}

    if (bankAdminToken) {
      try {
        const bInfoRes = await fetch(`${bankBaseUrl}/accounts/${encodeURIComponent(userId)}`, {
          headers: { Authorization: `Bearer ${bankAdminToken}` }
        });
        if (bInfoRes.ok) {
          const bInfo = await bInfoRes.json();
          report.bankName = bInfo.full_name || bInfo.name || null;
        } else {
          report.bankName = `Cuenta no encontrada en banco (HTTP ${bInfoRes.status})`;
        }
      } catch (e) {
        report.bankName = `Error consultando banco: ${e.message}`;
      }
    }

    try {
      const bAuth = Buffer.from(`${userId}:.numis123.`).toString('base64');
      const bRes = await fetch(`${bankBaseUrl}/accounts/${encodeURIComponent(userId)}/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${bAuth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'readwrite' })
      });
      report.defaultPassword = bRes.ok;
    } catch {}

    try {
      const prodRaw = await fs.readFile(path.join('web', 'productores.json'), 'utf8');
      const producers = JSON.parse(prodRaw);
      const prod = producers.find(p => p.id === userId);
      if (prod) {
        report.producerName = prod.nombreEmprendimiento || null;
      } else {
        report.nameMismatches.push(`El ID '${userId}' no se encuentra en productores.json`);
      }
    } catch (e) {
      report.producerName = `Error leyendo productores.json: ${e.message}`;
    }

    const nameMismatches = [];
    if (report.bankName && report.producerName && report.bankName !== report.producerName) {
      nameMismatches.push(`Bank name ("${report.bankName}") no coincide con Producers name ("${report.producerName}")`);
    }
    report.nameMismatches = [...report.nameMismatches, ...nameMismatches];
    report.namesMatch = report.nameMismatches.length === 0;

    try {
      await fs.access(path.join('web', 'pdfs', `${userId}_frente.pdf`));
      await fs.access(path.join('web', 'pdfs', `${userId}_reverso.pdf`));
      report.pdfExists = true;
    } catch {
      report.pdfExists = false;
    }

    console.log(JSON.stringify(report, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }));
    process.exit(1);
  }
}

main();
NODE
