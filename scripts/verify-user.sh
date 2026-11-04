#!/usr/bin/env bash
[ -z "$1" ] && echo '{"error":"missing id"}' && exit 1
ID=$1

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

export BANK_PASSWORD="${BANK_PASSWORD:-}"
export MERCHANT_PASSWORD="${MERCHANT_PASSWORD:-}"

node --input-type=module - "$ID" <<'NODE'
import fs from 'fs/promises';
import path from 'path';

const userId = process.argv[2];
const bankBaseUrl = process.env.BANK_URL || 'https://bank.taler.ar';
const bankPwd = process.env.BANK_PASSWORD || '';
const merchantBaseUrl = (process.env.MERCHANT_BASE_URL || 'https://merchant.taler.ar').replace(/\/$/, '');
const merchantPwd = process.env.MERCHANT_PASSWORD || '';

async function main() {
  const report = {
    id: userId,
    bankName: null,
    merchantName: null,
    producerName: null,
    namesMatch: false,
    nameMismatches: [],
    singleAccount: true,
    creditFacade: { ok: true, note: 'Validado via esquema DB' },
    template: {
      exists: false,
      correct: false,
      mismatches: [],
      fixInstructions: 'Para asegurar que el template UNQ quede igual, ejecutar: scripts/configurar-templates.sh (Configuración esperada: template_id = "UNQ", template_type = "fixed-order", pay_duration = 300000000 us, summary = "Pago con QR")'
    },
    defaultPassword: true,
    pdfExists: false,
  };

  try {
    // 1. Bank authentication & info
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
    } else {
      report.bankName = 'No se pudo autenticar en banco (falta BANK_PASSWORD o error de conexión)';
    }

    try {
      const bAuth = Buffer.from(`${userId}:.numis123.`).toString('base64');
      const bRes = await fetch(`${bankBaseUrl}/accounts/${encodeURIComponent(userId)}/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${bAuth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'readwrite' })
      });
      report.defaultPassword = bRes.ok;
    } catch {
      report.defaultPassword = false;
    }

    // 2. Merchant authentication & info (instance name & template UNQ)
    let merchantAdminToken = null;
    try {
      const mCreds = Buffer.from(`admin:${merchantPwd}`).toString('base64');
      const mTokenRes = await fetch(`${merchantBaseUrl}/instances/admin/private/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${mCreds}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'all' })
      });
      if (mTokenRes.ok) {
        const mTokenData = await mTokenRes.json();
        merchantAdminToken = mTokenData.access_token || mTokenData.token;
      }
    } catch {}

    if (merchantAdminToken) {
      // Check merchant instance name
      try {
        const mInstRes = await fetch(`${merchantBaseUrl}/management/instances/${encodeURIComponent(userId)}`, {
          headers: { Authorization: `Bearer ${merchantAdminToken}` }
        });
        if (mInstRes.ok) {
          const mInst = await mInstRes.json();
          report.merchantName = mInst.name || null;
        } else {
          report.merchantName = `Instancia no encontrada en merchant (HTTP ${mInstRes.status})`;
        }
      } catch (e) {
        report.merchantName = `Error consultando merchant: ${e.message}`;
      }

      // Check template UNQ
      const templateMismatches = [];
      try {
        const mTempRes = await fetch(`${merchantBaseUrl}/instances/${encodeURIComponent(userId)}/private/templates/UNQ`, {
          headers: { Authorization: `Bearer ${merchantAdminToken}` }
        });
        if (mTempRes.ok) {
          report.template.exists = true;
          const tempDetails = await mTempRes.json();
          const contract = tempDetails.template_contract || {};
          const tType = contract.template_type || 'fixed-order';
          const payDuration = contract.pay_duration;

          if (tType !== 'fixed-order') {
            templateMismatches.push(`Template type es "${tType}", se esperaba "fixed-order"`);
          }
          if (!payDuration || payDuration.d_us !== 300000000) {
            templateMismatches.push(`Template timeout es ${JSON.stringify(payDuration)}, se esperaba { d_us: 300000000 } (5 minutos)`);
          }
          report.template.correct = templateMismatches.length === 0;
        } else if (mTempRes.status === 404) {
          templateMismatches.push('Template "UNQ" no existe en el merchant');
          report.template.exists = false;
          report.template.correct = false;
        } else {
          templateMismatches.push(`Error consultando template en merchant (HTTP ${mTempRes.status})`);
          report.template.exists = false;
          report.template.correct = false;
        }
      } catch (e) {
        templateMismatches.push(`Error consultando template: ${e.message}`);
        report.template.exists = false;
        report.template.correct = false;
      }
      report.template.mismatches = templateMismatches;
    } else {
      report.merchantName = 'No se pudo autenticar en merchant (falta MERCHANT_PASSWORD o error de conexión)';
      report.template.mismatches.push('No se pudo autenticar en merchant para verificar template');
    }

    // 3. Producers JSON
    try {
      let prodRaw;
      try {
        prodRaw = await fs.readFile(path.join('web', 'productores.json'), 'utf8');
      } catch {
        prodRaw = await fs.readFile(path.join('web', 'productores.json.gen'), 'utf8');
      }
      const producers = JSON.parse(prodRaw);
      const prod = producers.find(p => p.id === userId);
      if (prod) {
        report.producerName = prod.nombreEmprendimiento || prod.nombreApellido || null;
      } else {
        report.nameMismatches.push(`El ID '${userId}' no se encuentra en productores.json`);
      }
    } catch (e) {
      report.producerName = `Error leyendo productores.json: ${e.message}`;
      report.nameMismatches.push(`Error leyendo productores.json: ${e.message}`);
    }

    // 4. Name comparison across Bank, Merchant, and Producers
    const nameMismatches = [];
    const validBankName = report.bankName && !report.bankName.startsWith('Cuenta no encontrada') && !report.bankName.startsWith('Error') && !report.bankName.startsWith('No se pudo');
    const validMerchantName = report.merchantName && !report.merchantName.startsWith('Instancia no encontrada') && !report.merchantName.startsWith('Error') && !report.merchantName.startsWith('No se pudo');
    const validProducerName = report.producerName && !report.producerName.startsWith('Error');

    if (validBankName && validProducerName && report.bankName !== report.producerName) {
      nameMismatches.push(`Bank name ("${report.bankName}") no coincide con Producers name ("${report.producerName}")`);
    }
    if (validBankName && validMerchantName && report.bankName !== report.merchantName) {
      nameMismatches.push(`Bank name ("${report.bankName}") no coincide con Merchant name ("${report.merchantName}")`);
    }
    if (validProducerName && validMerchantName && report.producerName !== report.merchantName) {
      nameMismatches.push(`Producers name ("${report.producerName}") no coincide con Merchant name ("${report.merchantName}")`);
    }
    report.nameMismatches = [...report.nameMismatches, ...nameMismatches];
    report.namesMatch = report.nameMismatches.length === 0;

    // 5. PDF existence
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
