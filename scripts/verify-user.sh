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
  const result = {
    id: userId,
    nameMatch: false,
    merchantName: null,
    bankName: null,
    producerName: null,
    singleAccount: false,
    creditFacadeOk: false,
    templateOk: false,
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
        result.merchantName = inst.name || null;
      } catch {}

      try {
        const tpl = await merchantRequest(`${merchantBaseUrl}/instances/${encodeURIComponent(userId)}/private/templates/UNQ`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const contract = tpl.template_contract || {};
        result.templateOk = (
          tpl.template_description === 'UNQ' &&
          contract.template_type === 'fixed-order' &&
          contract.pay_duration?.d_us === 300000_000 &&
          contract.summary === 'Pago con QR'
        );
      } catch {}

      try {
        const accs = await merchantRequest(`${merchantBaseUrl}/instances/${encodeURIComponent(userId)}/private/accounts`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const accounts = accs.accounts || [];
        result.singleAccount = accounts.length === 1;
        if (accounts.length > 0) {
          const acc = accounts[0];
          const cf = acc.credit_facade_credentials;
          result.creditFacadeOk = cf && cf.type === 'basic' && cf.username === userId;
        }
      } catch {}
    }

    try {
      const bAuth = Buffer.from(`${userId}:.numis123.`).toString('base64');
      const bRes = await fetch(`${bankBaseUrl}/accounts/${encodeURIComponent(userId)}/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${bAuth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'readwrite' })
      });
      result.defaultPassword = bRes.ok;
    } catch {}

    try {
      const bInfo = await merchantRequest(`${bankBaseUrl}/accounts/${encodeURIComponent(userId)}`);
      result.bankName = bInfo.full_name || bInfo.name || null;
    } catch {}

    try {
      const prodRaw = await fs.readFile(path.join('web', 'productores.json'), 'utf8');
      const producers = JSON.parse(prodRaw);
      const prod = producers.find(p => p.id === userId);
      if (prod) result.producerName = prod.nombreEmprendimiento || null;
    } catch {}

    try {
      await fs.access(path.join('web', 'pdfs', `${userId}_frente.pdf`));
      await fs.access(path.join('web', 'pdfs', `${userId}_reverso.pdf`));
      result.pdfExists = true;
    } catch {}

    result.nameMatch = !!(
      result.merchantName &&
      result.producerName &&
      result.merchantName === result.producerName &&
      result.bankName &&
      result.bankName === result.merchantName
    );

    console.log(JSON.stringify(result));
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }));
    process.exit(1);
  }
}

main();
NODE
