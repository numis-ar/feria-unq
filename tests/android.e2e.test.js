/**
 * Android end-to-end test — customer wallet flow + merchant flow on ONE
 * USB-connected Android device, against TEST_BASE_URL (default production
 * https://unq.numis.ar; for local runs use the fullstack harness on
 * http://localhost:3999 plus `adb reverse tcp:3999 tcp:3999`).
 *
 * Prerequisites:
 *   - Android device with USB debugging enabled, unlocked, Chrome installed.
 *   - GNU Taler wallet (net.taler.wallet / net.taler.wallet.fdroid). WALLET_APK
 *     env may point at a downloaded APK to install; otherwise the Play Store
 *     flow is driven via the accessibility tree.
 *   - Env vars (NO credentials may be hardcoded):
 *       TEST_MERCHANT_USER, TEST_MERCHANT_PASS
 *       TEST_BASE_URL        (optional, default https://unq.numis.ar)
 *       WALLET_APK           (optional, path to wallet APK to install)
 *       RUN_CLOSE_ACCOUNT=1  (optional, runs the destructive B4 last)
 *
 * Run just this file:
 *   TEST_MERCHANT_USER=... TEST_MERCHANT_PASS=... WALLET_APK=/tmp/w1002.apk \
 *     TEST_BASE_URL=http://localhost:3999 npx tsx --test tests/android.e2e.test.js
 *
 * Without a device or without env credentials every test SKIPS — `npm test`
 * stays green on machines without hardware.
 *
 * Hard rules honored here:
 *   - User simulation only: the native wallet UI is driven exclusively through
 *     the accessibility tree (uiautomator dump; taps only at a11y-derived
 *     bounds). Web UI via getByRole/getByLabel/getByText + JS-dispatched
 *     clicks. If a control is unreachable via a11y the test FAILS with
 *     evidence (screenshot + a11y dump), never falls back to ids/coordinates.
 *   - No direct backend API calls to shortcut flows.
 *   - Read-only against production except: wallet top-up (demo money), two
 *     small wallet payments, one 5-unit withdrawal, and (only with
 *     RUN_CLOSE_ACCOUNT=1) closing the test merchant account.
 */
import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { _android, chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import jsQR from 'jsqr';
import pngjs from 'pngjs';

const { PNG } = pngjs;

const BASE_URL = (process.env.TEST_BASE_URL || 'https://unq.numis.ar').replace(/\/$/, '');
const SHOTS = new URL('../screenshots/', import.meta.url).pathname;
const DEFAULT_TIMEOUT = 5000;
const CONFIRM_TIMEOUT = 30000;
const WALLET_PKGS = ['net.taler.wallet.fdroid', 'net.taler.wallet']; // real wallet only — never net.taler.anden.* (transit app)

const hasCredentials = Boolean(process.env.TEST_MERCHANT_USER && process.env.TEST_MERCHANT_PASS);

// ---------------------------------------------------------------------------
// Small utils
// ---------------------------------------------------------------------------
const t0 = Date.now();
function step(msg) {
  console.log(`[android-e2e] +${((Date.now() - t0) / 1000).toFixed(1)}s ${msg}`);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function findAndroidDevice() {
  try {
    const devices = await _android.devices();
    return devices[0] || null;
  } catch {
    return null;
  }
}

const androidDevice = hasCredentials ? await findAndroidDevice() : null;
const skipReason = !hasCredentials
  ? 'TEST_MERCHANT_USER/TEST_MERCHANT_PASS not set'
  : 'no USB Android device with debugging enabled';

// ---------------------------------------------------------------------------
// Wallet native driver: a11y tree only (uiautomator dump; taps at a11y bounds)
// ---------------------------------------------------------------------------
let walletPkg = null; // resolved wallet package in use

function parseDump(xml) {
  const nodes = [];
  const nodeRe = /<node\s+([^>]*?)(?:\/>|>)/g;
  let m;
  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = {};
    const attrRe = /([\w-]+)="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(m[1])) !== null) attrs[a[1]] = a[2];
    if (attrs.bounds) {
      const b = attrs.bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      if (b) attrs.center = [Math.round((+b[1] + +b[3]) / 2), Math.round((+b[2] + +b[4]) / 2)];
    }
    nodes.push(attrs);
  }
  return nodes;
}

function nodeMatches(node, pattern) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
  return re.test(node.text || '') || re.test(node['content-desc'] || '');
}

// State shared across tests (sequential within the describe)
const S = {
  device: null,
  serial: null,
  browser: null,
  context: null,
  page: null,
  usedCDP: false,
  startedChrome: false,
  startedWallet: false,
  currentWithdrawalOpen: false,
  shotIdx: 0,
  lastPayAmount: 0,
};

function adb(args) {
  return execFileSync('adb', ['-s', S.serial, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

async function walletDump(reason) {
  const xml = adb(['exec-out', 'uiautomator', 'dump', '/dev/tty']).toString();
  const clean = xml.slice(xml.indexOf('<?xml'));
  S.shotIdx += 1;
  fs.writeFileSync(`${SHOTS}evidence_wallet_${String(S.shotIdx).padStart(2, '0')}_${reason}.xml`, clean);
  return parseDump(clean);
}

async function walletScreenshot(name) {
  S.shotIdx += 1;
  const file = `${SHOTS}evidence_wallet_${String(S.shotIdx).padStart(2, '0')}_${name}.png`;
  try {
    const png = adb(['exec-out', 'screencap', '-p']);
    fs.writeFileSync(file, png);
    step(`wallet evidence → ${file}`);
  } catch (e) {
    step(`wallet screenshot FAILED (${String(e.message).split('\n')[0]})`);
  }
}

// Chrome sometimes pops a system dialog over everything (e.g. the Google
// Password Manager "found in a data breach" prompt after B1's password
// changes). Dismiss it through the a11y tree when seen.
async function dismissBlockingDialogs(nodes) {
  const allText = nodes.map((n) => `${n.text} ${n['content-desc'] || ''}`).join(' | ');
  if (/found in a data breach|recommends changing your password/i.test(allText)) {
    const ok = nodes.find((n) => /^(ok|got it|dismiss)$/i.test(n.text || '') && n.center);
    if (ok) {
      adb(['shell', 'input', 'tap', String(ok.center[0]), String(ok.center[1])]);
      step('dismissed Chrome password-breach dialog via a11y');
      await sleep(500);
      return true;
    }
  }
  return false;
}

async function waitA11y(pattern, { timeout = DEFAULT_TIMEOUT, label, preferClickable = false } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const nodes = await walletDump(`wait_${label || String(pattern).slice(0, 20)}`);
    const hits = nodes.filter((n) => nodeMatches(n, pattern));
    // Action buttons live in the bottom action bar; titles/labels at the top.
    // This wallet build reports clickable=false for everything, so prefer the
    // bottom-most match when asked to.
    const hit = (preferClickable && hits.length > 1 && hits.reduce((a, b) => ((b.center?.[1] || 0) > (a.center?.[1] || 0) ? b : a))) || hits[0];
    if (hit) return hit;
    await dismissBlockingDialogs(nodes);
    if (Date.now() > deadline) {
      await walletScreenshot(`TIMEOUT_${label || 'a11y'}`);
      throw new Error(`wallet a11y: timed out (${timeout}ms) waiting for ${label || pattern}`);
    }
    await sleep(400);
  }
}

async function tapA11y(pattern, { timeout = DEFAULT_TIMEOUT, label } = {}) {
  const hit = await waitA11y(pattern, { timeout, label, preferClickable: true });
  adb(['shell', 'input', 'tap', String(hit.center[0]), String(hit.center[1])]);
  step(`wallet tap: ${label || pattern} @ [${hit.center}]`);
  await sleep(300);
}

// Swipe within the bounds of a scrollable a11y node (never blind coordinates).
async function scrollWalletA11y(pattern, { maxSwipes = 10, label } = {}) {
  for (let i = 0; i < maxSwipes; i += 1) {
    const nodes = await walletDump(`scroll_${label || 'wallet'}`);
    const hit = nodes.find((n) => nodeMatches(n, pattern));
    if (hit) return hit;
    const scrollable = nodes.find((n) => n.scrollable === 'true' && n.center);
    if (!scrollable) break;
    const [cx, cy] = scrollable.center;
    const b = scrollable.bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    const x1 = +b[1] + 10, y1 = +b[2] + Math.round((+b[4] - +b[2]) * 0.75);
    const x2 = x1, y2 = +b[2] + Math.round((+b[4] - +b[2]) * 0.25);
    adb(['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), '400']);
    await sleep(400);
  }
  const nodes = await walletDump(`scroll_miss_${label || 'wallet'}`);
  const hit = nodes.find((n) => nodeMatches(n, pattern));
  if (!hit) throw new Error(`wallet a11y: ${label || pattern} not found after ${maxSwipes} swipes`);
  return hit;
}

async function findAmountEditText() {
  const nodes = await walletDump('edit_text');
  const edits = nodes.filter((n) => /EditText/.test(n.class || '') && n.center);
  return edits.find((n) => /^N?\d/.test((n.text || '').trim())) || null;
}

async function typeIntoFocusedA11yEditText(value, { timeout = DEFAULT_TIMEOUT } = {}) {
  // The wallet's amount field is a currency input: digits enter as cents,
  // right to left (typing "700" shows N7.00). It starts with a default that
  // must be cleared first — and adb keyevents can drop, so verify each stage
  // through the a11y tree and retry once.
  const deadline = Date.now() + 8000;
  let edit = null;
  for (;;) {
    edit = await findAmountEditText();
    if (edit) break;
    if (Date.now() > deadline) throw new Error('wallet a11y: no amount EditText on screen to type into');
    await sleep(400);
  }
  const target = Number(value);
  const cents = String(Math.round(target * 100));
  for (let round = 0; round < 4; round += 1) {
    // Re-locate the field each round: Compose recreates it on some transitions.
    edit = (await findAmountEditText()) || edit;
    adb(['shell', 'input', 'tap', String(edit.center[0]), String(edit.center[1])]);
    await sleep(500);
    adb(['shell', 'input', 'keyevent', '122']); // KEYCODE_MOVE_HOME
    for (let i = 0; i < 10; i += 1) adb(['shell', 'input', 'keyevent', '67']); // KEYCODE_DEL
    await sleep(400);
    // `input text` bursts drop keystrokes in this Compose field — send each
    // digit as an individual keyevent (KEYCODE 0..9 = 7..16).
    for (const digit of cents) {
      adb(['shell', 'input', 'keyevent', String(7 + Number(digit))]);
      await sleep(150);
    }
    await sleep(600);
    const after = await findAmountEditText();
    const now = after ? parseFloat((after.text || '').trim().replace(/^N\s?/, '')) : NaN;
    step(`wallet typed "${value}" into a11y EditText @ [${edit.center}] → "${after?.text}"`);
    if (Math.abs(now - target) < 0.005) return;
    edit = after || edit;
  }
  throw new Error(`wallet a11y: amount entry failed (wanted ${value})`);
}

function launchWallet() {
  adb(['shell', 'monkey', '-p', walletPkg, '-c', 'android.intent.category.LAUNCHER', '1']);
  S.startedWallet = true;
  step(`wallet launched (${walletPkg})`);
  return sleep(2500);
}

function intentView(uri) {
  adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `"${uri}"`, walletPkg]);
  step(`intent: ${uri.slice(0, 60)}… → ${walletPkg}`);
  // the activity switch takes a moment; a11y dumps must see the wallet, not Chrome
  return sleep(2500);
}

function installedWalletPkg() {
  const list = adb(['shell', 'pm', 'list', 'packages']).toString();
  return WALLET_PKGS.find((p) => list.includes(`package:${p}`)) || null;
}

function uninstallWallets() {
  for (const p of WALLET_PKGS) {
    try { adb(['uninstall', p]); step(`uninstalled ${p} (or was not installed)`); }
    catch { step(`uninstall ${p}: nothing to do`); }
  }
}

function installWalletApk(apkPath) {
  step(`installing wallet APK ${apkPath}`);
  const out = execFileSync('adb', ['-s', S.serial, 'install', '-r', apkPath], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  step(`adb install: ${out.trim().split('\n').pop()}`);
}

// Play Store install driven via the a11y tree. Fails with evidence if the
// store UI cannot be completed through the a11y tree.
async function installViaPlayStore() {
  step('Play Store path: opening store page for net.taler.wallet');
  adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW',
    '-d', 'https://play.google.com/store/apps/details?id=net.taler.wallet']);
  await sleep(6000);
  const deadline = Date.now() + 180000;
  for (;;) {
    const nodes = await walletDump('play_store');
    const texts = nodes.map((n) => `${n.text} ${n['content-desc'] || ''}`).join(' | ');
    if (/uninstall/i.test(texts)) { step('app already installed per Store'); return; }
    const install = nodes.find((n) => nodeMatches(n, /^install( app)?$/));
    if (install) {
      adb(['shell', 'input', 'tap', String(install.center[0]), String(install.center[1])]);
      step('tapped Store "Install"');
    }
    const open = nodes.find((n) => nodeMatches(n, /^open$/));
    if (open && !install) { step('Store shows "Open" — install complete'); return; }
    for (const dismiss of [/^(skip|not now)$/i, /^no thanks$/i, /^dismiss$/i]) {
      const d = nodes.find((n) => nodeMatches(n, dismiss) && n.clickable === 'true');
      if (d) {
        adb(['shell', 'input', 'tap', String(d.center[0]), String(d.center[1])]);
        step(`dismissed Store dialog (${dismiss})`);
      }
    }
    if (Date.now() > deadline) {
      await walletScreenshot('PLAY_STORE_FAIL');
      throw new Error('Play Store install could not be completed via the a11y tree (see evidence)');
    }
    await sleep(3000);
  }
}

async function installWallet() {
  if (process.env.WALLET_APK) {
    installWalletApk(process.env.WALLET_APK);
  } else {
    await installViaPlayStore();
  }
  walletPkg = installedWalletPkg();
  if (!walletPkg) throw new Error('wallet package not found after install');
  step(`wallet package resolved: ${walletPkg}`);
}

// Accept the wallet ToS if it appears: scroll (a11y) and tap the accept
// button at the bottom.
async function acceptWalletToSIfShown() {
  try {
    const btn = await scrollWalletA11y(/accept terms of service/i, { maxSwipes: 12, label: 'wallet ToS' });
    adb(['shell', 'input', 'tap', String(btn.center[0]), String(btn.center[1])]);
    step('accepted wallet Terms of Service');
    await sleep(500);
    return true;
  } catch {
    return false; // ToS was not shown (already accepted previously)
  }
}

// Wallet screens gate the main action behind a ToS review step
// ("Review terms of service" / "Terms of Service" button at the bottom).
// Pass it when present; harmless when already accepted.
async function passWalletToSGate({ maxRounds = 3 } = {}) {
  // The gate button can render a moment after the screen's title — poll and
  // repeat until no Terms-of-Service action remains.
  for (let i = 0; i < maxRounds; i += 1) {
    const nodes = await walletDump('tos_gate');
    const btn = nodes.find((n) => /^(review )?terms of service$/i.test((n.text || '').trim()));
    if (!btn) return i > 0;
    adb(['shell', 'input', 'tap', String(btn.center[0]), String(btn.center[1])]);
    step('wallet: opened Terms of Service review');
    await sleep(1000);
    await acceptWalletToSIfShown();
    await sleep(800);
  }
  return true;
}

async function assertWalletSuccess({ timeout = CONFIRM_TIMEOUT } = {}) {
  await waitA11y(/completed successfully/i, { timeout, label: 'wallet success' });
  await walletScreenshot('wallet_success');
  step('wallet: transaction completed successfully');
}

// Read a balance-like value from the wallet "Balances" screen via the a11y tree.
async function readWalletBalance() {
  try {
    await tapA11y(/^balances$/i, { timeout: 3000, label: 'Balances tab' });
  } catch {
    // Detail screens (e.g. after a transaction) have no tabs — go back first.
    try { await tapA11y(/go back/i, { timeout: 2000, label: 'Go back' }); } catch { /* no-op */ }
    try { await tapA11y(/^balances$/i, { timeout: 3000, label: 'Balances tab' }); } catch { /* no-op */ }
  }
  await sleep(800);
  const nodes = await walletDump('balances');
  const num = nodes.find((n) => /^N?\d+(\.\d{1,2})?$/.test((n.text || '').trim()));
  if (!num) {
    // Fresh wallets show an empty Balances list — unambiguous zero.
    await walletScreenshot('wallet_balance_zero');
    step('wallet balance read: 0 (empty Balances screen)');
    return 0;
  }
  const value = parseFloat(num.text.trim().replace(/^N\s?/, ''));
  step(`wallet balance read: ${value} (raw "${num.text.trim()}")`);
  await walletScreenshot('wallet_balance');
  return value;
}

// ---------------------------------------------------------------------------
// Web side helpers
// ---------------------------------------------------------------------------
// Chrome in the background never answers CDP captureScreenshot — bring it
// back to the foreground (resumes the existing tab) before any screenshot.
function bringChromeToFront() {
  try {
    adb(['shell', 'am', 'start', '--activity-single-top', '-n', 'com.android.chrome/com.google.android.apps.chrome.Main']);
  } catch { /* Chrome may not be the current browser; screenshot best-effort */ }
}

function webEvidence(name) {
  S.shotIdx += 1;
  const file = `${SHOTS}evidence_web_${String(S.shotIdx).padStart(2, '0')}_${name}.jpg`;
  bringChromeToFront();
  return S.page.screenshot({ path: file, quality: 70, type: 'jpeg', timeout: 30000 })
    .then(() => step(`web evidence → ${file}`))
    .catch((e) => step(`web screenshot FAILED (${e.message.split('\n')[0]})`));
}

// scroll-behavior:smooth on these pages breaks Playwright's "element is
// stable" actionability checks, so all scrolling is JS-dispatched.
async function scrollToLocator(locator) {
  await locator.waitFor({ state: 'attached', timeout: DEFAULT_TIMEOUT });
  await locator.evaluate((el) => el.scrollIntoView({ behavior: 'instant', block: 'center' }));
  await sleep(400);
}

async function dumpWebState(why) {
  try {
    const info = await S.page.evaluate(() => ({
      url: location.href,
      readyState: document.readyState,
      vw: window.innerWidth,
      vh: window.innerHeight,
      authModalHidden: document.getElementById('auth-modal')?.classList.contains('hidden'),
      loadingHidden: document.getElementById('loading-overlay')?.classList.contains('hidden'),
    }));
    S.vw = info.vw || S.vw;
    S.vh = info.vh || S.vh;
    step(`WEB-STATE[${why}]: ${JSON.stringify(info)}`);
  } catch (e) {
    step(`WEB-STATE[${why}] unreadable: ${e.message.split('\n')[0]}`);
  }
  await webEvidence(`FAIL_${why}`);
}

async function dumpAllEvidence(why) {
  await dumpWebState(why);
  try { await walletDump(`FAIL_${why}`); await walletScreenshot(`FAIL_${why}`); } catch { /* wallet may be closed */ }
}

async function jsClick(locator) {
  await locator.waitFor({ state: 'attached', timeout: DEFAULT_TIMEOUT });
  await locator.evaluate((el) => el.click());
}

// Device Chrome occasionally fails a navigation (background tab, radio hiccup)
// — retry a few times like a user hitting reload. If the CDP page itself is
// poisoned ("Maximum call stack size exceeded" / dead session), heal it by
// opening a fresh page in the same browser context.
async function healPage() {
  step('healing: replacing the CDP page');
  try { await S.page.close(); } catch { /* already dead */ }
  S.page = await S.context.newPage();
  bringChromeToFront();
  // new pages get Playwright's default desktop viewport — restore the device's
  try { await S.page.setViewportSize({ width: S.vw || 384, height: S.vh || 691 }); } catch { /* best effort */ }
  S.page.setDefaultTimeout(DEFAULT_TIMEOUT);
  S.page.on('crash', () => step('NAV: PAGE CRASHED'));
}

async function gotoPage(url) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      // Android Chrome freezes background tabs — page-level CDP calls then
      // hang forever. Bring the tab to the foreground before navigating.
      bringChromeToFront();
      // a wedged CDP session can hang the goto forever — race a hard timer
      await Promise.race([
        (async () => {
          await S.page.goto(url, { timeout: DEFAULT_TIMEOUT });
          await S.page.waitForLoadState('domcontentloaded');
        })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('goto hung (wedged CDP session)')), 20000)),
      ]);
      return;
    } catch (e) {
      lastErr = e;
      step(`goto attempt ${attempt} failed (${e.message.split('\n')[0]}); retrying...`);
      await healPage();
      await sleep(2000);
    }
  }
  throw lastErr;
}

async function decodeQrLocator(locator, label) {
  bringChromeToFront();
  // NOTE: CDP clip screenshots on Android Chrome come out anisotropically
  // scaled, and element box ↔ pixel mapping can drift when Chrome resumes —
  // so decode the FULL uniformly-scaled viewport frame; jsQR locates the QR
  // without any coordinates. Fall back to an element-box crop if needed.
  const buf = await S.page.screenshot({ type: 'png', timeout: 30000 });
  const full = PNG.sync.read(buf);
  const attempts = [{ data: full.data, width: full.width, height: full.height }];
  const box = await locator.boundingBox();
  if (box) {
    const cssWidth = await S.page.evaluate(() => window.innerWidth);
    const dpr = full.width / cssWidth;
    const margin = Math.round(box.width * 0.15);
    const x0 = Math.max(0, Math.round((box.x - margin) * dpr));
    const y0 = Math.max(0, Math.round((box.y - margin) * dpr));
    const w = Math.min(full.width - x0, Math.round((box.width + 2 * margin) * dpr));
    const h = Math.min(full.height - y0, Math.round((box.height + 2 * margin) * dpr));
    const out = new PNG({ width: w, height: h });
    PNG.bitblt(full, out, x0, y0, w, h, 0, 0);
    attempts.push({ data: out.data, width: out.width, height: out.height });
  }
  let decoded = null;
  for (const attempt of attempts) {
    const code = jsQR(new Uint8ClampedArray(attempt.data), attempt.width, attempt.height, { inversionAttempts: 'attemptBoth' });
    if (code && code.data) { decoded = code.data; break; }
  }
  fs.writeFileSync(`${SHOTS}evidence_qr_${label}.png`, buf);
  if (!decoded) throw new Error(`QR decode failed for ${label} (viewport capture saved)`);
  step(`QR decoded (${label}): ${decoded.slice(0, 64)}…`);
  return decoded;
}

// Log in on the merchant page via a11y locators (idempotent).
async function merchantLogin(user, pass) {
  const authDialog = S.page.getByRole('dialog', { name: /acceso de comerciante|merchant login/i });
  await authDialog.waitFor({ state: 'visible', timeout: 10000 }).catch(() => null);
  const dashboard = S.page.getByRole('heading', { name: /panel de control|dashboard/i });
  if (await dashboard.isVisible().catch(() => false)) {
    step('merchant already logged in');
    return;
  }
  await authDialog.getByLabel(/usuario|username/i).fill(user);
  await authDialog.getByLabel(/^contraseña$|^password$/i).fill(pass);
  await jsClick(authDialog.getByRole('button', { name: /entrar|^login$/i }));
  await dashboard.waitFor({ state: 'visible', timeout: 10000 });
  step('merchant logged in');
}

async function merchantLogout() {
  await jsClick(S.page.getByRole('button', { name: /cerrar sesión|logout/i }));
  await S.page.getByRole('dialog', { name: /acceso de comerciante|merchant login/i }).waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
  step('merchant logged out');
}

async function readStatValue(nameRe) {
  const group = S.page.getByRole('group', { name: nameRe }).first();
  await group.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
  const text = (await group.innerText()).replace(/\s+/g, ' ');
  const m = text.match(/(\d+(?:\.\d+)?)/);
  if (!m) throw new Error(`could not read numeric value from stat ${nameRe}: "${text}"`);
  return parseFloat(m[1]);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe(`Android e2e (${BASE_URL})`, () => {
  before(async () => {
    if (!androidDevice) return;
    S.device = androidDevice;
    S.serial = S.device.serial();

    // adb reverse so the device can reach a localhost TEST_BASE_URL.
    if (/localhost|127\.0\.0\.1/.test(BASE_URL)) {
      adb(['reverse', 'tcp:3999', 'tcp:3999']);
      step('adb reverse tcp:3999 tcp:3999 set');
    }

    // Chrome >= 135: skip launchBrowser, drive Chrome over CDP.
    let launched = null;
    step('trying device.launchBrowser() (20s cap)...');
    try {
      launched = await Promise.race([
        S.device.launchBrowser({ timeout: 20000 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('launchBrowser timed out (20s)')), 21000)),
      ]);
      step('device.launchBrowser() OK');
    } catch (e) {
      step(`launchBrowser failed (${e.message}); falling back to CDP over adb forward`);
    }

    if (launched) {
      S.browser = launched;
      S.context = S.browser.contexts()[0];
      S.page = await S.context.newPage();
    } else {
      S.usedCDP = true;
      S.startedChrome = true;
      const CDP_PORT = 9223;
      adb(['shell', 'am', 'force-stop', 'com.android.chrome']);
      adb(['shell', 'am', 'start', '-n', 'com.android.chrome/com.google.android.apps.chrome.Main', '-d', 'about:blank']);
      await sleep(5000);
      adb(['forward', `tcp:${CDP_PORT}`, 'localabstract:chrome_devtools_remote']);
      step(`adb forward tcp:${CDP_PORT} done; connecting over CDP...`);
      let lastErr = null;
      for (let attempt = 1; attempt <= 4 && !S.browser; attempt += 1) {
        try {
          S.browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
        } catch (e) {
          lastErr = e;
          step(`connectOverCDP attempt ${attempt} failed (${e.message.split('\n')[0]}); retrying...`);
          await sleep(4000);
        }
      }
      if (!S.browser) throw lastErr;
      S.context = S.browser.contexts()[0];
      S.page = await S.context.newPage();
      step('connected over CDP');
    }
    S.page.setDefaultTimeout(DEFAULT_TIMEOUT);
    S.page.on('crash', () => step('NAV: PAGE CRASHED'));
  });

  after(async () => {
    if (!androidDevice) return;
    // Abort a pending withdrawal if one is still open.
    if (S.currentWithdrawalOpen && S.page) {
      try {
        await jsClick(S.page.getByRole('dialog', { name: /retirando|withdrawing/i }).getByRole('button', { name: /cancelar|cancel/i }));
        step('cleanup: aborted pending withdrawal');
      } catch { /* no dialog open */ }
      S.currentWithdrawalOpen = false;
    }
    try {
      if (S.browser) await S.browser.close();
    } catch { /* device may be gone */ }
    try { adb(['forward', '--remove', 'tcp:9223']); } catch {}
    try { adb(['reverse', '--remove', 'tcp:3999']); } catch {}
    if (S.startedWallet) { try { adb(['shell', 'am', 'force-stop', walletPkg || 'net.taler.wallet.fdroid']); } catch {} }
    if (S.startedChrome) { try { adb(['shell', 'am', 'force-stop', 'com.android.chrome']); } catch {} }
    if (S.usedCDP) {
      // The CDP websocket can keep the event loop alive after tests finish.
      setTimeout(() => process.exit(process.exitCode ?? 0), 2000);
    }
  });

  it('A1: install the wallet', { timeout: 240000 }, async (t) => {
    if (!androidDevice) { t.skip(`skipping: ${skipReason}`); return; }
    try {
      uninstallWallets();
      await installWallet();
      await launchWallet();
      await walletScreenshot('A1_wallet_installed');
      // Welcome/ready state visible in the a11y tree
      await waitA11y(/get demo cash|withdraw chf|balances|configuraci/i, { timeout: 15000, label: 'wallet welcome' });
      step('A1 OK: wallet installed and launched');
    } catch (e) {
      await dumpAllEvidence('A1');
      throw e;
    }
  });

  it('A2: reset wallet (uninstall + reinstall) shows empty state', { timeout: 240000 }, async (t) => {
    if (!androidDevice) { t.skip(`skipping: ${skipReason}`); return; }
    try {
      uninstallWallets();
      await installWallet();
      await launchWallet();
      await waitA11y(/get demo cash|withdraw chf|balances|configuraci/i, { timeout: 15000, label: 'wallet welcome' });
      const nodes = await walletDump('A2_empty');
      const balance = nodes.find((n) => /^\d+\.\d{2}$/.test((n.text || '').trim()));
      assert.ok(!balance || parseFloat(balance.text.trim()) === 0, 'wallet should start empty');
      await walletScreenshot('A2_empty_state');
      step('A2 OK: wallet reset to empty state');
    } catch (e) {
      await dumpAllEvidence('A2');
      throw e;
    }
  });

  it('A3: top up 50 NUMIS via the page QR and the wallet', { timeout: 180000 }, async (t) => {
    if (!androidDevice) { t.skip(`skipping: ${skipReason}`); return; }
    try {
      await gotoPage(`${BASE_URL}/description.html`);
      await scrollToLocator(S.page.getByRole('heading', { name: /top up your wallet/i }));
      await webEvidence('A3_topup_form');
      await S.page.getByPlaceholder('Amount').fill('50');
      await jsClick(S.page.getByRole('button', { name: /get money/i }));

      // spinner → QR transition
      const qrImg = S.page.getByRole('img', { name: /qr code to top up wallet/i });
      await qrImg.waitFor({ state: 'visible', timeout: CONFIRM_TIMEOUT });
      await scrollToLocator(qrImg);
      const uri = await decodeQrLocator(qrImg, 'top-up');
      assert.ok(uri.startsWith('taler://'), `unexpected top-up URI: ${uri}`);
      step('A3: page spinner→QR transition OK');
      await webEvidence('A3_qr');

      intentView(uri);
      await waitA11y(/do you want to receive this payment/i, { timeout: CONFIRM_TIMEOUT, label: 'wallet receive screen' });
      await walletScreenshot('A3_wallet_receive');
      if (await passWalletToSGate()) {
        await waitA11y(/do you want to receive this payment|total:/i, { timeout: DEFAULT_TIMEOUT, label: 'receive screen after ToS' }).catch(() => null);
      }
      await tapA11y(/^receive payment$/i, { timeout: DEFAULT_TIMEOUT, label: 'Receive payment' });
      await assertWalletSuccess();
      const balance = await readWalletBalance();
      assert.strictEqual(balance, 50, `wallet balance should be 50.00, got ${balance}`);
      step('A3 OK: wallet topped up to 50 NUMIS');
    } catch (e) {
      await dumpAllEvidence('A3');
      throw e;
    }
  });

  it('A4: pay the merchant from the page QR (template amount)', { timeout: 180000 }, async (t) => {
    if (!androidDevice) { t.skip(`skipping: ${skipReason}`); return; }
    try {
      const amount = 1 + Math.floor(Math.random() * 20);
      S.lastPayAmount = amount;
      step(`A4: random payment amount = ${amount}`);
      await gotoPage(`${BASE_URL}/description.html`);
      const qrSvg = S.page.getByRole('img', { name: /qr code to pay a merchant/i });
      await qrSvg.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
      await scrollToLocator(qrSvg);
      const uri = await decodeQrLocator(qrSvg, 'pay-template');
      assert.ok(uri.startsWith('taler://pay-template/'), `unexpected pay URI: ${uri}`);
      await webEvidence('A4_pay_qr');

      intentView(uri);
      // Template order: the wallet asks the user for the amount.
      await typeIntoFocusedA11yEditText(amount);
      await walletScreenshot('A4_wallet_amount');
      await tapA11y(/create order/i, { timeout: DEFAULT_TIMEOUT, label: 'wallet create order' });
      await passWalletToSGate();
      await tapA11y(/confirm|pay|send|order/i, { timeout: DEFAULT_TIMEOUT, label: 'wallet confirm payment' });
      await assertWalletSuccess();
      step(`A4 OK: paid ${amount} NUMIS to the merchant`);
    } catch (e) {
      await dumpAllEvidence('A4');
      throw e;
    }
  });

  it('B1: password round-trip and back', { timeout: 120000 }, async (t) => {
    if (!androidDevice) { t.skip(`skipping: ${skipReason}`); return; }
    const user = process.env.TEST_MERCHANT_USER;
    const original = process.env.TEST_MERCHANT_PASS;
    const changed = `NewTest${Math.floor(1000 + Math.random() * 9000)}`;
    step(`B1: will change password to "${changed}" (logged for recovery)`);
    try {
      await gotoPage(`${BASE_URL}/merchant.html`);
      await merchantLogin(user, original);

      await jsClick(S.page.getByRole('button', { name: /cambiar contraseña|change password/i }));
      const dialog = S.page.getByRole('dialog', { name: /cambiar contraseña|change password/i });
      await dialog.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
      await dialog.getByLabel(/contraseña antigua|old password/i).fill(original);
      await dialog.getByLabel(/nueva contraseña|new password/i).fill(changed);
      await dialog.getByLabel(/repetir contraseña|repeat password/i).fill(changed);
      await jsClick(dialog.getByRole('button', { name: /actualizar contraseña|update password/i }));
      // App re-logs-in automatically (fire-and-forget) with the new password.
      await S.page.getByRole('heading', { name: /panel de control|dashboard/i }).waitFor({ state: 'visible', timeout: 10000 });
      // Let that stray re-login fully settle, then reload so no in-flight
      // promise can un-hide the auth modal after we log out below.
      await sleep(3000);
      await S.page.reload({ timeout: DEFAULT_TIMEOUT });
      await S.page.getByRole('heading', { name: /panel de control|dashboard/i }).waitFor({ state: 'visible', timeout: 10000 });
      step('B1: password changed, app re-logged-in');

      await merchantLogout();
      await merchantLogin(user, changed);
      step('B1: login with NEW password OK');

      // Change back in a finally-style guard so the original password is
      // always restored, even if an assertion below fails.
      try {
        await jsClick(S.page.getByRole('button', { name: /cambiar contraseña|change password/i }));
        const dlg = S.page.getByRole('dialog', { name: /cambiar contraseña|change password/i });
        await dlg.getByLabel(/contraseña antigua|old password/i).fill(changed);
        await dlg.getByLabel(/nueva contraseña|new password/i).fill(original);
        await dlg.getByLabel(/repetir contraseña|repeat password/i).fill(original);
        await jsClick(dlg.getByRole('button', { name: /actualizar contraseña|update password/i }));
        await S.page.getByRole('heading', { name: /panel de control|dashboard/i }).waitFor({ state: 'visible', timeout: 10000 });
        await sleep(3000);
        await S.page.reload({ timeout: DEFAULT_TIMEOUT });
        await S.page.getByRole('heading', { name: /panel de control|dashboard/i }).waitFor({ state: 'visible', timeout: 10000 });
        step('B1: password changed back');

        await merchantLogout();
        await merchantLogin(user, original);
        await S.page.getByRole('heading', { name: /panel de control|dashboard/i }).waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
        step('B1 OK: original password restored and working');
      } catch (e) {
        step('B1: change-back FAILED — attempting recovery login with original password');
        await S.page.goto(`${BASE_URL}/merchant.html`, { timeout: DEFAULT_TIMEOUT }).catch(() => null);
        await merchantLogin(user, original).catch(() => null);
        throw e;
      }
    } catch (e) {
      await dumpAllEvidence('B1');
      throw e;
    }
  });

  it('B2: payment notification + VENDIDO total increases', { timeout: 180000 }, async (t) => {
    if (!androidDevice) { t.skip(`skipping: ${skipReason}`); return; }
    try {
      const user = process.env.TEST_MERCHANT_USER;
      const pass = process.env.TEST_MERCHANT_PASS;
      await gotoPage(`${BASE_URL}/merchant.html`);
      await merchantLogin(user, pass);
      const soldBefore = await readStatValue(/vendido|sold/i);
      step(`B2: VENDIDO before = ${soldBefore}`);

      // Drive a fresh wallet payment (same flow as A4) while the dashboard is up.
      const amount = 1 + Math.floor(Math.random() * 20);
      S.lastPayAmount = amount;
      step(`B2: paying ${amount} NUMIS from the wallet`);
      await gotoPage(`${BASE_URL}/description.html`);
      const qrSvg = S.page.getByRole('img', { name: /qr code to pay a merchant/i });
      await qrSvg.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
      await scrollToLocator(qrSvg);
      const uri = await decodeQrLocator(qrSvg, 'pay-template');
      intentView(uri);
      await typeIntoFocusedA11yEditText(amount);
      await tapA11y(/create order/i, { timeout: DEFAULT_TIMEOUT, label: 'wallet create order' });
      await passWalletToSGate();
      await tapA11y(/confirm|pay|send|order/i, { timeout: DEFAULT_TIMEOUT, label: 'wallet confirm payment' });
      await assertWalletSuccess();

      // Back to the dashboard.
      await gotoPage(`${BASE_URL}/merchant.html`);
      await S.page.getByRole('heading', { name: /panel de control|dashboard/i }).waitFor({ state: 'visible', timeout: 10000 });

      // The payment toast is transient (5s) and usually expires while we are still
      // in the wallet app — catch it opportunistically, don't require it.
      const statusRegion = S.page.getByRole('status');
      const toastSeen = await statusRegion.filter({ hasText: /pagado|paid/i })
        .waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
      step(`B2: payment toast visible: ${toastSeen}`);
      await webEvidence('B2_toast');

      // Persistent user-visible evidence: a paid order row for the amount appears
      // in the live orders table.
      const amountStr = amount.toFixed(2);
      await S.page.getByRole('row', { name: new RegExp(amountStr) })
        .filter({ hasText: /pagado|paid|acreditado|settled|transit/i })
        .waitFor({ state: 'visible', timeout: CONFIRM_TIMEOUT });
      step(`B2: paid order row for ${amountStr} visible in orders table`);

      const soldAfter = await readStatValue(/vendido|sold/i);
      step(`B2: VENDIDO after = ${soldAfter}`);
      assert.ok(Math.abs((soldAfter - soldBefore) - amount) < 0.005,
        `VENDIDO should increase by exactly ${amount} (${soldBefore} → ${soldAfter})`);
      step('B2 OK');
    } catch (e) {
      await dumpAllEvidence('B2');
      throw e;
    }
  });

  it('B3: withdraw 5 NUMIS into the same-device wallet', { timeout: 180000 }, async (t) => {
    if (!androidDevice) { t.skip(`skipping: ${skipReason}`); return; }
    try {
      const user = process.env.TEST_MERCHANT_USER;
      const pass = process.env.TEST_MERCHANT_PASS;
      await gotoPage(`${BASE_URL}/merchant.html`);
      await merchantLogin(user, pass);
      await jsClick(S.page.getByRole('navigation', { name: /secciones/i }).getByRole('button', { name: 'Cuenta' }));
      await S.page.getByRole('heading', { name: /cuenta bancaria|bank account/i }).waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
      const availableBefore = await readStatValue(/disponible|available/i);
      const walletBefore = await readWalletBalance();
      step(`B3: DISponible=${availableBefore}, wallet=${walletBefore}`);

      await jsClick(S.page.getByRole('button', { name: 'Retirar' }));
      const dialog = S.page.getByRole('dialog', { name: /retirar fondos|withdraw funds/i });
      await dialog.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
      await dialog.getByLabel(/cantidad|amount/i).fill('5');
      await jsClick(dialog.getByRole('button', { name: 'Retirar', exact: true }));

      const qrDialog = S.page.getByRole('dialog', { name: /retirando|withdrawing/i });
      await qrDialog.waitFor({ state: 'visible', timeout: CONFIRM_TIMEOUT });
      S.currentWithdrawalOpen = true;
      const uri = await S.page.getByRole('link', { name: /abrir en billetera|open in taler wallet/i }).getAttribute('href');
      assert.ok(uri && /^taler:\/\/(pay-push|withdraw)\//.test(uri), `unexpected withdraw URI: ${uri}`);
      await webEvidence('B3_withdraw_qr');

      intentView(uri);
      // Wallet shows the withdrawal review screen (Total amount + ToS gate).
      await waitA11y(/total amount|withdraw/i, { timeout: CONFIRM_TIMEOUT, label: 'wallet withdraw review' });
      await walletScreenshot('B3_wallet_review');
      await passWalletToSGate();
      await tapA11y(/withdraw|confirm/i, { timeout: CONFIRM_TIMEOUT, label: 'wallet confirm withdrawal' });
      step('B3: wallet confirmed — waiting for the web "Billetera conectada" state');
      bringChromeToFront(); // background tabs throttle the app's withdrawal poll
      await qrDialog.getByText(/billetera conectada|wallet connected/i).waitFor({ state: 'visible', timeout: CONFIRM_TIMEOUT });
      await webEvidence('B3_wallet_connected');

      await jsClick(qrDialog.getByRole('button', { name: /confirmar transferencia|confirm transfer/i }));
      await launchWallet(); // bring the wallet to front: its success screen shows there
      await assertWalletSuccess();
      S.currentWithdrawalOpen = false;

      // Merchant side: a "retiro" debit row for 5.00 appears in the live transactions
      // table. We deliberately do NOT assert an exact available-balance delta: the
      // exchange wires customer payments asynchronously, so the bank balance is a
      // moving target around the same time (observed 24 → 29 while withdrawing).
      const statusRegion = S.page.getByRole('status');
      await statusRegion.filter({ hasText: /retiro|withdraw/i }).waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
      await S.page.getByRole('row', { name: /retiro|withdraw/i })
        .filter({ hasText: /5\.00/ })
        .waitFor({ state: 'visible', timeout: CONFIRM_TIMEOUT });
      step('B3: retiro transaction row for 5.00 visible');
      await webEvidence('B3_tx_row');
      const availableAfter = await readStatValue(/disponible|available/i);
      step(`B3: DISponible ${availableBefore} → ${availableAfter} (informational only)`);

      // Wallet side: balance increased by exactly 5.
      await launchWallet();
      const walletAfter = await readWalletBalance();
      assert.ok(Math.abs((walletAfter - walletBefore) - 5) < 0.005,
        `wallet balance should increase by exactly 5 (${walletBefore} → ${walletAfter})`);
      step('B3 OK');
    } catch (e) {
      await dumpAllEvidence('B3');
      throw e;
    }
  });

  it('B4: close account (only with RUN_CLOSE_ACCOUNT=1)', { timeout: 120000 }, async (t) => {
    if (!androidDevice) { t.skip(`skipping: ${skipReason}`); return; }
    if (process.env.RUN_CLOSE_ACCOUNT !== '1') {
      t.skip('RUN_CLOSE_ACCOUNT is not 1 — skipping destructive close-account test');
      return;
    }
    try {
      console.log('\n\n⚠️  WARNING: RUN_CLOSE_ACCOUNT=1 — the test merchant account WILL BE CLOSED\n');
      const user = process.env.TEST_MERCHANT_USER;
      const pass = process.env.TEST_MERCHANT_PASS;
      await gotoPage(`${BASE_URL}/merchant.html`);
      await merchantLogin(user, pass);
      await jsClick(S.page.getByRole('navigation', { name: /secciones/i }).getByRole('button', { name: 'Cuenta' }));
      await jsClick(S.page.getByRole('button', { name: /cerrar cuenta|close account/i }));
      const dialog = S.page.getByRole('dialog', { name: /cerrar cuenta|close account/i });
      await dialog.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
      await jsClick(dialog.getByRole('button', { name: /confirmar|confirm/i }));
      const statusRegion = S.page.getByRole('status');
      await statusRegion.filter({ hasText: /éxito|success|cerrada|closed/i }).waitFor({ state: 'visible', timeout: CONFIRM_TIMEOUT });
      await S.page.getByRole('dialog', { name: /acceso de comerciante|merchant login/i }).waitFor({ state: 'visible', timeout: CONFIRM_TIMEOUT });
      await webEvidence('B4_closed');
      console.log('\n\n🔴 THE TEST MERCHANT ACCOUNT IS NOW CLOSED 🔴\n');
      step('B4 OK: account closed, redirected to login');
    } catch (e) {
      await dumpAllEvidence('B4');
      throw e;
    }
  });
});
