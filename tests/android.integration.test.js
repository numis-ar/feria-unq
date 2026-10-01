/**
 * Android device integration test — runs the merchant flow on the REAL
 * production site https://unq.numis.ar from a USB-connected Android device,
 * mirroring the manual runs in screenshots/merchant_*.jpg.
 *
 * The whole flow is driven purely by accessibility locators (getByRole /
 * getByLabel / getByText) — the names come from the ARIA added in
 * web/merchant.html (Spanish UI). No id/class selectors are used for
 * interaction, so the test verifies the accessible surface end to end.
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
 * 1-unit withdrawal, which is aborted in-step (Cancelar in the QR dialog). No
 * payments, transfers, password changes or close-account actions are performed.
 */
import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { _android, chromium } from 'playwright';
import { execFileSync } from 'node:child_process';

const BASE_URL = (process.env.TEST_BASE_URL || 'https://unq.numis.ar').replace(/\/$/, '');
const SHOTS = new URL('../screenshots/', import.meta.url).pathname;
const TIMEOUT = 5000;

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

    // Preferred path: Playwright's own Android browser launcher — but only on
    // Chrome < 135. Newer Chrome ignores the --remote-debugging-socket-name flag
    // that Playwright passes via `am start` (Android Chrome only reads flags from
    // /data/local/tmp/chrome-command-line, which adb can't pre-seed with
    // Playwright's per-launch random socket name), so launchBrowser() polls a
    // socket that never appears and hangs. Detect the version and skip the wait.
    let chromeMajor = 0;
    try {
      const out = execFileSync('adb', ['shell', 'dumpsys', 'package', 'com.android.chrome'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
      const m = out.match(/versionName=(\d+)\./);
      if (m) chromeMajor = parseInt(m[1], 10);
    } catch { /* unknown — try launchBrowser anyway */ }
    step(`device Chrome major version: ${chromeMajor || 'unknown'}`);

    let launched = null;
    if (chromeMajor >= 135) {
      step('Chrome >= 135: skipping launchBrowser (flag ignored by Chrome, would hang); using CDP path directly');
    } else {
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
    page.setDefaultTimeout(TIMEOUT);
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
    // coordinates. 'attached' (not 'visible') because some buttons live inside
    // dialogs whose containers start hidden — el.click() works regardless.
    const jsClick = async (locator) => {
      await locator.waitFor({ state: 'attached', timeout: TIMEOUT });
      await locator.evaluate((el) => el.click());
    };
    page.on('load', () => step('NAV: page load event fired'));
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) step('NAV: navigated → ' + f.url()); });
    page.on('crash', () => step('NAV: PAGE CRASHED'));

    try {
      // a. Open the merchant app
      step(`goto ${BASE_URL}/merchant.html`);
      await page.goto(`${BASE_URL}/merchant.html`, { timeout: TIMEOUT });
      await page.waitForLoadState('domcontentloaded');
      step('page loaded: ' + page.url());
      await evidence('01_loaded');

      // b. Log in (skip if a previous manual run left a valid session)
      const authDialog = page.getByRole('dialog', { name: 'Acceso de Comerciante' });
      await authDialog.waitFor({ state: 'visible', timeout: TIMEOUT }).catch(() => null);
      step('auth dialog check done');
      const dashboardHeading = page.getByRole('heading', { name: 'Panel de Control' });
      const loggedInAlready = await dashboardHeading.isVisible().catch(() => false);
      step('already logged in: ' + loggedInAlready);
      if (!loggedInAlready) {
        await page.getByLabel('Usuario').fill(process.env.TEST_MERCHANT_USER);
        await page.getByLabel('Contraseña').fill(process.env.TEST_MERCHANT_PASS);
        await evidence('02_filled');
        await dumpState('before_login_click');
        await jsClick(page.getByRole('button', { name: 'Entrar' }));
        step('login clicked, waiting for dashboard...');
      }

      // Dashboard ("Panel de Control" heading)
      await dashboardHeading.waitFor({ state: 'visible', timeout: TIMEOUT });
      step('dashboard visible');
      await evidence('03_dashboard');

      // c. The three stat cards render (role=group with their translated titles)
      for (const name of [/vendido/i, /en tránsito/i, /liquidado/i]) {
        assert.ok(
          await page.getByRole('group', { name }).first().isVisible(),
          `stat card ${name} should be visible`,
        );
      }

      // d. Bottom dock → Cuenta
      const dock = page.getByRole('navigation', { name: /secciones/i });
      const cuentaBtn = dock.getByRole('button', { name: 'Cuenta' });
      step('clicking Cuenta in dock...');
      await jsClick(cuentaBtn);
      await page.getByRole('heading', { name: 'Cuenta Bancaria' }).waitFor({ state: 'visible', timeout: TIMEOUT });
      step('account screen visible');
      assert.ok(await page.getByRole('group', { name: /disponible/i }).first().isVisible(), 'DISPONIBLE card visible');
      // Dock active state (aria-current) moved to Cuenta
      assert.strictEqual(await cuentaBtn.getAttribute('aria-current'), 'page');
      await evidence('04_account');

      // e. Withdraw flow: dialog → amount 1 → QR dialog → abort
      step('opening withdraw dialog...');
      await jsClick(page.getByRole('button', { name: 'Retirar', exact: true }));
      const withdrawDialog = page.getByRole('dialog', { name: 'Retirar fondos' });
      await withdrawDialog.waitFor({ state: 'visible', timeout: TIMEOUT });
      step('withdraw dialog visible');
      const amountInput = withdrawDialog.getByLabel('Cantidad');
      await amountInput.waitFor({ state: 'visible', timeout: TIMEOUT });
      assert.strictEqual(await amountInput.evaluate((el) => document.activeElement === el), true,
        'amount input should be focused when the dialog opens');
      await amountInput.fill('1');
      await evidence('05_withdraw_dialog');
      await jsClick(withdrawDialog.getByRole('button', { name: 'Retirar', exact: true }));
      step('withdraw confirm clicked, waiting for QR dialog...');

      const qrDialog = page.getByRole('dialog', { name: /Retirando/ });
      await qrDialog.waitFor({ state: 'visible', timeout: TIMEOUT });
      step('QR dialog visible (title: Retirando $ 1)');
      await evidence('06_withdraw_qr');

      // Abort so no pending withdrawal is left on production.
      // The Cancelar button lives in #qr-confirm-actions, which stays display:none
      // until a wallet connects — includeHidden reaches it in the a11y locator.
      await jsClick(qrDialog.getByRole('button', { name: 'Cancelar', includeHidden: true }));
      await qrDialog.waitFor({ state: 'hidden', timeout: TIMEOUT });
      step('QR dialog closed (withdrawal aborted), flow complete');
      await evidence('07_done');
    } catch (e) {
      step('TEST FAILED: ' + e.message.split('\n')[0]);
      await dumpState('error');
      throw e;
    }
  });
});
