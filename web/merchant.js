export function playNotificationSound() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(523.25, audioCtx.currentTime); // C5
    oscillator.frequency.exponentialRampToValueAtTime(1046.50, audioCtx.currentTime + 0.1); // C6
    gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    oscillator.start();
    oscillator.stop(audioCtx.currentTime + 0.3);
  } catch (e) {}
}

export function parseAmountStr(amtStr) {
  if (!amtStr) return 0;
  if (typeof amtStr === "string" && amtStr.includes(":")) {
    return parseFloat(amtStr.split(":")[1]) || 0;
  }
  return parseFloat(amtStr) || 0;
}

export function getCurrency(amtStr) {
  if (!amtStr) return "";
  if (typeof amtStr === "string" && amtStr.includes(":")) {
    return amtStr.split(":")[0];
  }
  return "";
}

export function formatMoney(num, currency = "") {
  return (Math.floor(num * 100) / 100).toFixed(2);
}

export function validatePassword(pass) {
  if (pass.length < 8) return false;
  if (!/^[a-zA-Z0-9_\-]+$/.test(pass)) return false;
  const letters = pass.match(/[a-zA-Z]/g);
  if (!letters || letters.length < 2) return false;
  const numbers = pass.match(/[0-9]/g);
  if (!numbers || numbers.length < 2) return false;
  return true;
}

export async function loginToTaler(API_URL, BANK_URL, user, pass) {
  // 1. Get Access Token
  const tokenRes = await fetch(`${API_URL}/instances/${encodeURIComponent(user)}/private/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${user}:${pass}`),
    },
    body: JSON.stringify({ scope: "all" }),
  });

  if (!tokenRes.ok) {
    throw new Error("Failed to authenticate with Merchant");
  }

  const tokenData = await tokenRes.json();
  const ACCESS_TOKEN = tokenData.access_token || tokenData.token;

  // 2. Get Bank Access Token
  const bankTokenRes = await fetch(`${BANK_URL}/accounts/${encodeURIComponent(user)}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${user}:${pass}`),
    },
    body: JSON.stringify({ scope: "readwrite" }),
  });

  if (!bankTokenRes.ok) {
    throw new Error("Failed to authenticate with Bank");
  }

  const bankTokenData = await bankTokenRes.json();
  const BANK_ACCESS_TOKEN = bankTokenData.access_token || bankTokenData.token;

  return { ACCESS_TOKEN, BANK_ACCESS_TOKEN };
}

export async function getAccountName(BANK_URL, user, BANK_ACCESS_TOKEN) {
  try {
      const infoRes = await fetch(`${BANK_URL}/accounts/${encodeURIComponent(user)}`, {
          headers: {
              Accept: "application/json",
              Authorization: `Bearer ${BANK_ACCESS_TOKEN}`
          }
      });
      if (infoRes.ok) {
          const info = await infoRes.json();
          return info.name || user;
      }
      return user;
  } catch (e) {
      return user;
  }
}

export async function closeAccount(INSTANCE_ID, BANK_ACCESS_TOKEN) {
  const res = await fetch(`/get-money/${encodeURIComponent(INSTANCE_ID)}/close-account`, {
    method: "POST",
    headers: { Authorization: `Bearer ${BANK_ACCESS_TOKEN}` }
  });
  
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || "Failed to close account");
  }

  return res.json();
}

export async function changePassword(API_URL, BANK_URL, INSTANCE_ID, ACCESS_TOKEN, BANK_ACCESS_TOKEN, oldP, newP) {
  // 1. Bank API password change
  const bankRes = await fetch(`${BANK_URL}/accounts/${encodeURIComponent(INSTANCE_ID)}/auth`, {
      method: 'PATCH',
      headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${BANK_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
          old_password: oldP,
          new_password: newP
      })
  });
  
  if (!bankRes.ok) {
      const errText = await bankRes.text();
      throw new Error(`Bank API failed: ${bankRes.status} ${errText}`);
  }

  // 2. Revenue API password change
  const accRes = await fetch(`${API_URL}/instances/${encodeURIComponent(INSTANCE_ID)}/private/accounts`, {
      method: 'GET',
      headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${ACCESS_TOKEN}`
      },
  });

  if (!accRes.ok) {
      const errText = await accRes.text();
      throw new Error(`Getting revenue info failed: ${accRes.status} ${errText}`);
  }
  
  const revJson = await accRes.json();
  if (!revJson.accounts || !revJson.accounts.length) {
      throw new Error(`This merchant doesn't have bank accounts`);
  }
  const accountId = revJson.accounts[0].h_wire;
  const revRes = await fetch(`${API_URL}/instances/${encodeURIComponent(INSTANCE_ID)}/private/accounts/${accountId}`, {
      method: 'PATCH',
      headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${ACCESS_TOKEN}`
      },
      body: JSON.stringify({
          credit_facade_credentials: {
              type: "basic",
              username: encodeURIComponent(INSTANCE_ID),
              password: newP
	  }
      })
  });
  
  if (!revRes.ok) {
      const errText = await merchRes.text();
      throw new Error(`Revenue API failed: ${revRes.status} ${errText}`);
  }
  
  // 3. Merchant API password change
  const merchRes = await fetch(`${API_URL}/instances/${encodeURIComponent(INSTANCE_ID)}/private/auth`, {
      method: 'POST',
      headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${ACCESS_TOKEN}`
      },
      body: JSON.stringify({
          method: "token",
          old_password: oldP,
          password: newP
      })
  });
  
  if (!merchRes.ok) {
      const errText = await merchRes.text();
      throw new Error(`Merchant API failed: ${merchRes.status} ${errText}`);
  }
}

// ---------------------------------------------------------------------------
// Pure / testable helpers extracted from merchant.html
// ---------------------------------------------------------------------------

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function extractAccountFromPayto(paytoUri) {
  if (!paytoUri) return "";
  try {
    const url = new URL(paytoUri.replace("payto://", "http://"));
    const parts = url.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || "";
  } catch (e) {
    return "";
  }
}

export function getTimestampMs(ts) {
  if (!ts) return null;
  if (typeof ts === "object") {
    if (ts.t_ms) return ts.t_ms;
    if (ts.t_s) return ts.t_s * 1000;
    return null;
  }
  if (typeof ts === "number") {
    return ts > 1e10 ? ts : ts * 1000;
  }
  if (typeof ts === "string") {
    const n = Number(ts);
    if (Number.isNaN(n)) return Date.parse(ts) || null;
    return n > 1e10 ? n : n * 1000;
  }
  return null;
}

export function formatDate(tsMs, locale = "es") {
  if (!tsMs) return "";
  return new Date(tsMs).toLocaleDateString(locale);
}

export function formatTime(tsMs, locale = "es") {
  if (!tsMs) return "";
  return new Date(tsMs).toLocaleTimeString(locale);
}

export function getOrderState(order, parseAmountFn = parseAmountStr) {
  const amountNum = parseAmountFn(order.amount);
  const refundNum = parseAmountFn(order.refund_amount);
  let state = "claimed";
  let stateClass = "bg-slate-100 text-slate-600";

  if (order.paid) {
    if (refundNum > 0) {
      state = "refunded";
      stateClass = "bg-red-100 text-red-700";
    } else if (!order.wired) {
      state = "in-transit";
      stateClass = "bg-blue-100 text-blue-700";
    } else {
      state = "settled";
      stateClass = "bg-green-100 text-green-700";
    }
  } else {
    state = order.payment_status || order.order_status || "unpaid";
  }

  return { state, stateClass, amountNum, refundNum };
}

export function getDeadlineMs(deadline) {
  return getTimestampMs(deadline);
}

export function isOrderPayable(order, parseAmountFn = parseAmountStr, now = Date.now()) {
  const amountNum = parseAmountFn(order.amount);
  if (amountNum <= 0) return false;
  const deadlineMs = getDeadlineMs(order.pay_deadline);
  if (deadlineMs && deadlineMs < now) return false;
  return true;
}

export function filterOrders(orders, parseAmountFn = parseAmountStr, now = Date.now()) {
  return orders.filter((o) => {
    const amountNum = parseAmountFn(o.amount);
    if (amountNum <= 0) return false;
    // Only hide unpaid orders that can no longer be paid (expired deadline).
    // Paid/settled/refunded orders must remain visible for the merchant.
    if (!o.paid) {
      const deadlineMs = getDeadlineMs(o.pay_deadline);
      if (deadlineMs && deadlineMs < now) return false;
    }
    return true;
  });
}

export function generateRequestUid() {
  // Crockford's Base32 alphabet (no I, L, O, U).
  const charset = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const len = 52;
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const rnd = new Uint8Array(len);
    crypto.getRandomValues(rnd);
    let uid = "";
    for (let i = 0; i < len; i++) {
      uid += charset[rnd[i] % charset.length];
    }
    return uid;
  }
  let uid = "";
  for (let i = 0; i < len; i++) {
    uid += charset[Math.floor(Math.random() * charset.length)];
  }
  return uid;
}

export function buildOrderRowHtml(order, options) {
  const {
    state,
    stateClass,
    amountNum,
  } = getOrderState(order, options.parseAmountFn || parseAmountStr);
  const t = options.t || ((k) => k);
  const tf = options.tf || ((k, v) => t(k));
  const formatMoney = options.formatMoney || ((n) => n.toFixed(2));
  const timeStr = options.timeStr || "";
  const rowClass = options.rowClass || "";
  const orderId = order.order_id || order.summary;

  const deadlineMs = getDeadlineMs(order.pay_deadline);
  const remainingSeconds = deadlineMs
    ? Math.max(0, Math.ceil((deadlineMs - (options.now || Date.now())) / 1000))
    : null;
  const showCountdown = state === "unpaid" && remainingSeconds !== null && remainingSeconds > 0;
  const countdownHtml = showCountdown
    ? `<div class="order-countdown text-xs text-slate-600 mt-1" role="timer" aria-label="${escapeHtml(t("order_countdown_label"))}" data-deadline="${deadlineMs}">${tf("order_expires_in", { seconds: remainingSeconds })}</div>`
    : "";

  return `
    <tr class="${rowClass}" data-order-id="${escapeHtml(orderId)}">
      <td class="px-6 py-4">
        <div class="font-medium text-slate-800">${escapeHtml(order.summary || order.order_id || t("order_fallback"))}</div>
        <div class="text-xs text-slate-400">${escapeHtml(timeStr)}</div>
      </td>
      <td class="px-6 py-4">
        <span class="px-2 py-1 text-xs font-semibold rounded-full ${stateClass}">${t("order_state_" + state.replace(/-/g, "_"))}</span>
        ${countdownHtml}
      </td>
      <td class="px-6 py-4 text-right font-semibold text-slate-800">${formatMoney(amountNum)}</td>
    </tr>
  `;
}

export function buildTransactionRowHtml(tx, options) {
  const t = options.t || ((k) => k);
  const tf = options.tf || ((k, v) => t(k));
  const formatMoney = options.formatMoney || ((n) => n.toFixed(2));
  const timeStr = options.timeStr || "";
  const rowClass = options.rowClass || "";
  const amountNum = (options.parseAmountFn || parseAmountStr)(tx.amount);

  let colorClass = "text-slate-800";
  let subject = tx.subject || t("tx_fallback");
  let isCredit = false;
  let iconSvg = "";
  let label = subject;
  let isSpecial = false;

  if (tx.direction === "credit") {
    colorClass = "text-green-600";
    isCredit = true;
    const account = extractAccountFromPayto(tx.debtor_payto_uri);
    if (account === "exchange") {
      isSpecial = true;
      subject = t("val_sales");
      iconSvg = `<svg class="w-5 h-5 text-green-600 inline mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 10l7-7m0 0l7 7m-7-7v18"></path></svg>`;
    } else {
      label = tf("transfer_from", { account: account || t("unknown_account") });
      iconSvg = `<svg class="w-5 h-5 text-slate-500 inline mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"></path></svg>`;
    }
  } else if (tx.direction === "debit") {
    colorClass = "text-red-600";
    isCredit = false;
    const account = extractAccountFromPayto(tx.creditor_payto_uri);
    if (account === "exchange") {
      isSpecial = true;
      subject = t("val_withdraw");
      iconSvg = `<svg class="w-5 h-5 text-red-600 inline mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"></path></svg>`;
    } else if (account === "closing_account") {
      isSpecial = true;
      subject = t("val_closing");
      iconSvg = `<svg class="w-5 h-5 text-red-600 inline mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>`;
    } else {
      label = tf("transfer_to", { account: account || t("unknown_account") });
      iconSvg = `<svg class="w-5 h-5 text-slate-500 inline mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"></path></svg>`;
    }
  }

  return {
    html: `
      <tr class="${rowClass}">
        <td class="px-6 py-4">
          <div class="font-medium text-slate-800">${iconSvg} ${escapeHtml(isSpecial ? subject : label)}</div>
          <div class="text-xs text-slate-400">${escapeHtml(timeStr)}</div>
        </td>
        <td class="px-6 py-4 text-right font-semibold ${colorClass}">${formatMoney(amountNum)}</td>
      </tr>
    `,
    isCredit,
    subject: isSpecial ? subject : label,
    amount: amountNum,
  };
}
