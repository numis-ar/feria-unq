import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { chromium } from 'playwright';

describe('Merchant UI E2E Behavior Tests (Playwright)', () => {
  let browser;
  let page;

  before(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });

  after(async () => {
    await browser.close();
  });

  it('should load the page and show login modal when unauthenticated', async () => {
    await page.goto(`file://${process.cwd()}/web/merchant.html`);
    
    const modal = page.locator('#auth-modal');
    await modal.waitFor({ state: 'visible' });

    const title = await page.locator('#auth-modal h2').textContent();
    assert.strictEqual(title, 'Merchant Login');
  });

  it('should show change password button on top bar', async () => {
    const btn = page.locator('#btn-open-change-pass');
    await btn.waitFor({ state: 'attached' });
    const isVisible = await btn.isVisible();
    assert.strictEqual(isVisible, true);
  });
});
