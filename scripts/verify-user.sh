#!/usr/bin/env bash
[ -z "$1" ] && echo '{"error":"missing id"}' && exit 1
ID=$1

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

export MERCHANT_PASSWORD="${MERCHANT_PASSWORD:-}"
export BANK_PASSWORD="${BANK_PASSWORD:-}"

node --input-type=module - "$ID" <<'NODE'
import fs from 'fs/promises';
import path from 'path';

const userId = process.argv[2];
const merchantBaseUrl = process.env.MERCHANT_BASE_URL || 'https://merchant.taler.ar';
const bankBaseUrl = process.env.BANK_URL || 'https://bank.taler.ar';
const merchantPwd = process.env.MERCHANT_PASSWORD || '';
const bankPwd = process.env.BANK_PASSWORD || '';

async function main() {
  const report = {
    id: userId,
    merchantName: null,
    bankName: null,
    producerName: null,
    namesMatch: false,
    nameMismatches: [],
    accountsCount: 0,
    singleAccount: false,
    creditFacade: { ok: false, username: null, type: null, error: null },
    template: {
      exists: false,
      correct: false,
      actual: null,
      expected: { description: 'UNQ', type: 'fixed-order', duration_us: 300000000, summary: 'Pago con QR' },
      mismatches: []
    },
    defaultPassword: true,
    pdfExists: false,
  };

  try {
    // 1. Get Merchant Admin Token
    let merchantToken = null;
    try {
      const creds = Buffer.from(`admin:${merchantPwd}`).toString('base64');
      const tokenRes = await fetch(`${merchantBaseUrl}/instances/admin/private/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'all' })
      });
      if (tokenRes.ok) {
        const tokenData = await tokenRes.json();
        merchantToken = tokenData.access_token || tokenData.token;
      }
    } catch (e) {
      report.nameMismatches.push(`No se pudo autenticar en Merchant: ${e.message}`);
    }

    if (merchantToken) {
      try {
        const instRes = await fetch(`${merchantBaseUrl}/management/instances/${encodeURIComponent(userId)}`, {
          headers: { Authorization: `Bearer ${merchantToken}` }
        });
        if (instRes.ok) {
          const inst = await instRes.json();
          report.merchantName = inst.name || null;
        }
      } catch {}

      try {
        const tplRes = await fetch(`${merchantBaseUrl}/instances/${encodeURIComponent(userId)}/private/templates/UNQ`, {
          headers: { Authorization: `Bearer ${merchantToken}` }
        });
        if (tplRes.ok) {
          const tpl = await tplRes.json();
          report.template.exists = true;
          report.template.actual = tpl;
          const contract = tpl.template_contract || {};
          const mismatches = [];
          if (tpl.template_description !== 'UNQ') mismatches.push(`Descripción esperada 'UNQ', obtenido '${tpl.template_description}'`);
          if (contract.template_type !== 'fixed-order') mismatches.push(`Tipo esperado 'fixed-order', obtenido '${contract.template_type}'`);
          if (contract.pay_duration?.d_us !== 300000000) mismatches.push(`Duración esperada 300000000 us (5 min), obtenido ${contract.pay_duration?.d_us}`);
          if (contract.summary !== 'Pago con QR') mismatches.push(`Resumen esperado 'Pago con QR', obtenido '${contract.summary}'`);
          
          report.template.mismatches = mismatches;
          report.template.correct = mismatches.length === 0;
        } else {
          report.template.exists = false;
          report.template.mismatches.push(`Template UNQ no encontrado (HTTP ${tplRes.status})`);
        }
      } catch (e) {
        report.template.exists = false;
        report.template.mismatches.push(`Error obteniendo template UNQ: ${e.message}`);
      }

      try {
        const accsRes = await fetch(`${merchantBaseUrl}/instances/${encodeURIComponent(userId)}/private/accounts`, {
          headers: { Authorization: `Bearer ${merchantToken}` }
        });
        if (accsRes.ok) {
          const accs = await accsRes.json();
          const accounts = accs.accounts || [];
          report.accountsCount = accounts.length;
          report.singleAccount = accounts.length === 1;
          if (accounts.length > 0) {
            const acc = accounts[0];
            const cf = acc.credit_facade_credentials;
            report.creditFacade.username = cf?.username || null;
            report.creditFacade.type = cf?.type || null;
            const cfOk = cf && cf.type === 'basic' && cf.username === userId;
            report.creditFacade.ok = cfOk;
            if (!cfOk) report.creditFacade.error = `Credit facade inválida o credenciales incorrectas (usuario: ${cf?.username})`;
          } else {
            report.creditFacade.error = 'No hay cuentas bancarias asociadas en merchant';
          }
        } else {
          report.creditFacade.error = `No se pudieron obtener cuentas de merchant (HTTP ${accsRes.status})`;
        }
      } catch (e) {
        report.creditFacade.error = `Error obteniendo cuentas de merchant: ${e.message}`;
      }
    }

    // 2. Get Bank Admin Token & Bank Info
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

    // Password check with default .numis123.
    try {
      const bAuth = Buffer.from(`${userId}:.numis123.`).toString('base64');
      const bRes = await fetch(`${bankBaseUrl}/accounts/${encodeURIComponent(userId)}/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${bAuth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'readwrite' })
      });
      report.defaultPassword = bRes.ok;
    } catch {}

    // Producers json
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
    if (report.merchantName !== report.producerName) {
      nameMismatches.push(`Merchant name ("${report.merchantName}") no coincide con Producers ("${report.producerName}")`);
    }
    if (report.bankName && report.merchantName && report.bankName !== report.merchantName) {
      nameMismatches.push(`Bank name ("${report.bankName}") no coincide con Merchant name ("${report.merchantName}")`);
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
