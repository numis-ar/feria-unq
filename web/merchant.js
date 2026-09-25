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
  // 1. Merchant API password change
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
  
  // 2. Bank API password change
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
}

