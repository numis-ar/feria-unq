/**
 * Android device integration test — runs the merchant flow on the REAL
 * production site https://unq.numis.ar from a USB-connected Android device,
 * mirroring the manual runs in screenshots/merchant_*.jpg.
 *
 * Prerequisites:
 *   - Android device with USB debugging enabled, unlocked, Chrome installed,
 *     connected over USB (authorized on this host).
 *   - Env vars (NO credentials may be hardcoded):
 *       TEST_MERCHANT_USER, TEST_MERCHANT_PASS  (production merchant login)
 *       TEST_BASE_URL   (optional, defaults to https://unq.numis.ar)
 *
 * Run just this file (with a device attached and env set):
 *   TEST_MERCHANT_USER=... TEST_MERCHANT_PASS=... \
 *     npx tsx --test tests/android.integration.test.js
 *
 * Without a device or without the env vars the whole suite SKIPS — it never
 * fails `npm test` on machines without an attached device.
 *
 * SAFETY: this talks to PRODUCTION. The test is read-only except for a single
 * 1-unit withdrawal, which is aborted in-step (#btn-qr-cancel). No payments,
 * transfers, password changes or close-account actions are performed.
 */
import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { _android, chromium } from 'playwright';
import { execFileSync } from 'node:child_process';

const BASE_URL = (process.env.TEST_BASE_URL || 'https://unq.numis.ar').replace(/\/$/, '');
const SHOTS = new URL('../screenshots/', import.meta.url).pathname;

const hasCredentials = Boolean(process.env.TEST_MERCHANT_USER && process.env.TEST_MERCHANT_PASS);

// Detect a USB-connected Android device up front so we can skip cleanly.
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

const suite = describe;

const t0 = Date.now();
function step(msg) {
  console.log(`[android-it] +${((Date.now() - t0) / 1000).toFixed(1)}s ${msg}`);
}

suite(`Android device integration (${BASE_URL})`, () => {
  let device;
  let browser;
  let page;
  let context;
  let cleanupBrowser;
  let usedCDP = false;

  before(async () => {
    if (!androidDevice) return; // nothing to set up when skipping
    device = androidDevice;

    // Preferred path: Playwright's own Android browser launcher.
    // Some Chrome/device combos make it hang forever, so cap it and fall back
    // to driving Chrome over CDP via `adb forward` (raw DevTools protocol).
    let launched = null;
    step('trying device.launchBrowser() (20s cap)...');
    try {
      launched = await Promise.race([
        device.launchBrowser({ timeout: 20000 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('launchBrowser timed out (20s)')), 21000)),
      ]);
      step('device.launchBrowser() OK');
    } catch (e) {
      step(`launchBrowser failed (${e.message}); falling back to CDP over adb forward`);
    }

    if (launched) {
      browser = launched;
      context = browser.contexts()[0];
      page = await context.newPage();
      cleanupBrowser = async () => { try { await browser.close(); } catch {} };
    } else {
      usedCDP = true;
      const adb = (args) => execFileSync('adb', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
      const CDP_PORT = 9223;
      step('starting Chrome on device with devtools socket...');
      adb(['shell', 'am', 'force-stop', 'com.android.chrome']);
      adb(['shell', 'am', 'start', '-n', 'com.android.chrome/com.google.android.apps.chrome.Main', '-d', 'about:blank']);
      await new Promise((r) => setTimeout(r, 5000));
      adb(['forward', `tcp:${CDP_PORT}`, 'localabstract:chrome_devtools_remote']);
      step(`adb forward tcp:${CDP_PORT} done; connecting over CDP...`);
      let lastErr = null;
      for (let attempt = 1; attempt <= 4 && !browser; attempt++) {
        try {
          browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
        } catch (e) {
          lastErr = e;
          step(`connectOverCDP attempt ${attempt} failed (${e.message.split('\n')[0]}); retrying...`);
          await new Promise((r) => setTimeout(r, 4000));
        }
      }
      if (!browser) throw lastErr;
      context = browser.contexts()[0];
      page = await context.newPage();
      step('connected over CDP');
      cleanupBrowser = async () => {
        const race = (p, ms) => Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
        await race(page.close(), 8000);
        await race(Promise.resolve(browser.close()), 8000);
        try { adb(['forward', '--remove', `tcp:${CDP_PORT}`]); } catch {}
        try { adb(['shell', 'am', 'force-stop', 'com.android.chrome']); } catch {}
      };
    }
    page.setDefaultTimeout(30000);
  });

  after(async () => {
    try {
      if (cleanupBrowser) await cleanupBrowser();
    } catch { /* device may already be gone */ }
    if (usedCDP) {
      // The CDP websocket can keep the event loop alive after tests finish.
      // Give reporting a moment, then exit with whatever code was set.
      setTimeout(() => process.exit(process.exitCode ?? 0), 2000);
    }
  });

  it('merchant flow: login → dashboard → account → withdraw QR (aborted)', async (t) => {
    if (!androidDevice) {
      t.skip(`skipping: ${skipReason}`);
      return;
    }

    // Evidence helpers: screenshots + state dump on failure, navigation logging.
    let shotIdx = 0;
    const evidence = async (name) => {
      shotIdx += 1;
      const file = `${SHOTS}auto_evidence_${String(shotIdx).padStart(2, '0')}_${name}.jpg`;
      try {
        await page.screenshot({ path: file, quality: 70, type: 'jpeg' });
        step(`evidence → ${file}`);
      } catch (e) {
        step(`evidence screenshot FAILED (${e.message.split('\n')[0]})`);
      }
    };
    const dumpState = async (why) => {
      try {
        const info = await page.evaluate(() => ({
          url: location.href,
          readyState: document.readyState,
          vw: window.innerWidth,
          vh: window.innerHeight,
          zoomScale: window.visualViewport ? window.visualViewport.scale : null,
          scrollY: window.scrollY,
          authModalHidden: document.getElementById('auth-modal')?.classList.contains('hidden'),
          loadingHidden: document.getElementById('loading-overlay')?.classList.contains('hidden'),
        }));
        step(`STATE[${why}]: ${JSON.stringify(info)}`);
      } catch (e) {
        step(`STATE[${why}] unreadable: ${e.message.split('\n')[0]}`);
      }
      await evidence(`FAIL_${why}`);
    };
    // JS-dispatched click: immune to Chrome's input-focus auto-zoom shifting hit-test
    // coordinates. 'attached' (not 'visible') because some buttons (e.g. #btn-qr-cancel)
    // live inside modals whose containers start hidden — el.click() works regardless.
    const jsClick = async (sel) => {
      await page.waitForSelector(sel, { state: 'attached', timeout: 30000 });
      await page.$eval(sel, (el) => el.click());
    };
    page.on('load', () => step('NAV: page load event fired'));
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) step('NAV: navigated → ' + f.url()); });
    page.on('crash', () => step('NAV: PAGE CRASHED'));

    try {
      // a. Open the merchant app
      step(`goto ${BASE_URL}/merchant.html`);
      await page.goto(`${BASE_URL}/merchant.html`, { timeout: 30000 });
      await page.waitForLoadState('domcontentloaded');
      step('page loaded: ' + page.url());
      await evidence('01_loaded');

      // b. Log in (skip if a previous manual run left a valid session)
      const authModal = page.locator('#auth-modal');
      await authModal.waitFor({ state: 'visible', timeout: 30000 }).catch(() => null);
      step('auth modal check done');
      const loggedInAlready = await page.locator('#dashboard').isVisible().catch(() => false);
      step('already logged in: ' + loggedInAlready);
      if (!loggedInAlready) {
        await page.fill('#auth-user', process.env.TEST_MERCHANT_USER);
        await page.fill('#auth-pass', process.env.TEST_MERCHANT_PASS);
        await evidence('02_filled');
        await dumpState('before_login_click');
        await jsClick('#btn-login');
        step('login clicked, waiting for dashboard...');
      }

      // Dashboard ("Panel de Control" heading)
      await page.locator('#dashboard h1', { hasText: 'Panel de Control' }).waitFor({ state: 'visible', timeout: 30000 });
      step('dashboard visible');
      await evidence('03_dashboard');

      // c. The three stat cards render
      const main = page.locator('#main-content');
      for (const label of ['VENDIDO', 'EN TRÁNSITO', 'LIQUIDADO']) {
        assert.ok(
          await main.locator('div', { hasText: label }).first().isVisible(),
          `stat card ${label} should be visible`,
        );
      }

      // d. Bottom dock → Cuenta
      step('clicking Cuenta in dock...');
      await jsClick('#bottom-dock .sidebar-nav-btn[data-target="account"]');
      await page.locator('#account h2', { hasText: 'Cuenta Bancaria' }).waitFor({ state: 'visible', timeout: 30000 });
      step('account screen visible');
      assert.ok(await main.locator('div', { hasText: 'DISPONIBLE' }).first().isVisible(), 'DISPONIBLE card visible');
      // Dock active state moved to Cuenta
      const activeDockBtn = page.locator('#bottom-dock .sidebar-nav-btn.dock-active');
      assert.strictEqual(await activeDockBtn.getAttribute('data-target'), 'account');
      await evidence('04_account');

      // e. Withdraw flow: dialog → amount 1 → QR modal → abort
      step('opening withdraw dialog...');
      await jsClick('#btn-withdraw');
      const withdrawModal = page.locator('#withdraw-modal');
      await withdrawModal.waitFor({ state: 'visible', timeout: 30000 });
      step('withdraw dialog visible');
      const amountInput = page.locator('#withdraw-dialog-amount');
      await amountInput.waitFor({ state: 'visible', timeout: 30000 });
      assert.strictEqual(await amountInput.evaluate((el) => document.activeElement === el), true,
        'amount input should be focused when the dialog opens');
      await amountInput.fill('1');
      await evidence('05_withdraw_dialog');
      await jsClick('#btn-withdraw-confirm');
      step('withdraw confirm clicked, waiting for QR modal...');

      const qrModal = page.locator('#qr-modal');
      await qrModal.waitFor({ state: 'visible', timeout: 30000 });
      step('QR modal visible');
      await page.locator('#qr-modal-title', { hasText: 'Retirando $ 1' }).waitFor({ state: 'visible', timeout: 30000 });
      await evidence('06_withdraw_qr');

      // Abort so no pending withdrawal is left on production
      await jsClick('#btn-qr-cancel');
      await qrModal.waitFor({ state: 'hidden', timeout: 30000 });
      step('QR modal closed (withdrawal aborted), flow complete');
      await evidence('07_done');
    } catch (e) {
      step('TEST FAILED: ' + e.message.split('\n')[0]);
      await dumpState('error');
      throw e;
    }
  });
});
