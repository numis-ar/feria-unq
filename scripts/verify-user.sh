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

async function merchantRequest(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

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
    const creds = Buffer.from(`admin:${merchantPwd}`).toString('base64');
    const tokenRes = await fetch(`${merchantBaseUrl}/instances/admin/private/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'all' })
    });
    const tokenData = await tokenRes.json();
    const token = tokenData.access_token || tokenData.token;

    if (token) {
      try {
        const inst = await merchantRequest(`${merchantBaseUrl}/management/instances/${encodeURIComponent(userId)}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        report.merchantName = inst.name || null;
      } catch (e) {
        report.merchantName = `Error: ${e.message}`;
      }

      try {
        const tpl = await merchantRequest(`${merchantBaseUrl}/instances/${encodeURIComponent(userId)}/private/templates/UNQ`, {
          headers: { Authorization: `Bearer ${token}` }
        });
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
      } catch (e) {
        report.template.exists = false;
        report.template.mismatches.push(`Template UNQ no encontrado en merchant: ${e.message}`);
      }

      try {
        const accs = await merchantRequest(`${merchantBaseUrl}/instances/${encodeURIComponent(userId)}/private/accounts`, {
          headers: { Authorization: `Bearer ${token}` }
        });
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
      } catch (e) {
        report.creditFacade.error = `No se pudieron obtener cuentas del merchant: ${e.message}`;
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
      const bInfo = await merchantRequest(`${bankBaseUrl}/accounts/${encodeURIComponent(userId)}`);
      report.bankName = bInfo.full_name || bInfo.name || null;
    } catch (e) {
      report.bankName = `Error: ${e.message}`;
    }

    try {
      const prodRaw = await fs.readFile(path.join('web', 'productores.json'), 'utf8');
      const producers = JSON.parse(prodRaw);
      const prod = producers.find(p => p.id === userId);
      if (prod) report.producerName = prod.nombreEmprendimiento || null;
    } catch (e) {
      report.producerName = `Error leyendo productores.json: ${e.message}`;
    }

    const nameMismatches = [];
    if (report.merchantName !== report.producerName) {
      nameMismatches.nameMismatch = true;
      nameMismatches.push(`Merchant name ("${report.merchantName}") no coincide con Producers ("${report.producerName}")`);
    }
    if (report.bankName !== report.merchantName) {
      nameMismatches.push(`Bank name ("${report.bankName}") no coincide con Merchant name ("${report.merchantName}")`);
    }
    report.nameMismatches = nameMismatches;
    report.namesMatch = nameMismatches.length === 0;

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
