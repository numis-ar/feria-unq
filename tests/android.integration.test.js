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
import { _android } from 'playwright';

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

suite(`Android device integration (${BASE_URL})`, () => {
  let device;
  let browser;
  let page;
  let context;

  before(async () => {
    if (!androidDevice) return; // nothing to set up when skipping
    device = androidDevice;
    // Chrome on the device; generous timeouts (LTE + real device are slow).
    browser = await device.launchBrowser({ timeout: 30000 });
    context = browser.contexts()[0];
    page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(30000);
  });

  after(async () => {
    try {
      if (browser) await browser.close();
    } catch { /* device may already be gone */ }
  });

  it('merchant flow: login → dashboard → account → withdraw QR (aborted)', async (t) => {
    if (!androidDevice) {
      t.skip(`skipping: ${skipReason}`);
      return;
    }
    // a. Open the merchant app
    await page.goto(`${BASE_URL}/merchant.html`, { timeout: 30000 });
    await page.waitForLoadState('domcontentloaded');
    await page.screenshot({ path: `${SHOTS}auto_01_login.jpg`, quality: 80, type: 'jpeg' });

    // b. Log in (skip if a previous manual run left a valid session)
    const authModal = page.locator('#auth-modal');
    await authModal.waitFor({ state: 'visible', timeout: 30000 }).catch(() => null);
    const loggedInAlready = await page.locator('#dashboard').isVisible().catch(() => false);
    if (!loggedInAlready) {
      await page.fill('#auth-user', process.env.TEST_MERCHANT_USER);
      await page.fill('#auth-pass', process.env.TEST_MERCHANT_PASS);
      await page.tap('#btn-login');
    }

    // Dashboard ("Panel de Control" heading)
    await page.locator('#dashboard h1', { hasText: 'Panel de Control' }).waitFor({ state: 'visible', timeout: 30000 });
    await page.screenshot({ path: `${SHOTS}auto_02_dashboard.jpg`, quality: 80, type: 'jpeg' });

    // c. The three stat cards render
    const main = page.locator('#main-content');
    for (const label of ['VENDIDO', 'EN TRÁNSITO', 'LIQUIDADO']) {
      assert.ok(
        await main.locator('div', { hasText: label }).first().isVisible(),
        `stat card ${label} should be visible`,
      );
    }

    // d. Bottom dock → Cuenta
    await page.tap('#bottom-dock .sidebar-nav-btn[data-target="account"]');
    await page.locator('#account h2', { hasText: 'Cuenta Bancaria' }).waitFor({ state: 'visible', timeout: 30000 });
    assert.ok(await main.locator('div', { hasText: 'DISPONIBLE' }).first().isVisible(), 'DISPONIBLE card visible');
    // Dock active state moved to Cuenta
    const activeDockBtn = page.locator('#bottom-dock .sidebar-nav-btn.dock-active');
    assert.strictEqual(await activeDockBtn.getAttribute('data-target'), 'account');
    await page.screenshot({ path: `${SHOTS}auto_03_account.jpg`, quality: 80, type: 'jpeg' });

    // e. Withdraw flow: dialog → amount 1 → QR modal → abort
    await page.tap('#btn-withdraw');
    const withdrawModal = page.locator('#withdraw-modal');
    await withdrawModal.waitFor({ state: 'visible', timeout: 30000 });
    const amountInput = page.locator('#withdraw-dialog-amount');
    await amountInput.waitFor({ state: 'visible', timeout: 30000 });
    assert.strictEqual(await amountInput.evaluate((el) => document.activeElement === el), true,
      'amount input should be focused when the dialog opens');
    await amountInput.fill('1');
    await page.tap('#btn-withdraw-confirm');

    const qrModal = page.locator('#qr-modal');
    await qrModal.waitFor({ state: 'visible', timeout: 30000 });
    await page.locator('#qr-modal-title', { hasText: 'Retirando $ 1' }).waitFor({ state: 'visible', timeout: 30000 });
    await page.screenshot({ path: `${SHOTS}auto_04_withdraw_qr.jpg`, quality: 80, type: 'jpeg' });

    // Abort so no pending withdrawal is left on production
    await page.tap('#btn-qr-cancel');
    await qrModal.waitFor({ state: 'hidden', timeout: 30000 });
  });
});
