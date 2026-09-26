import { test, expect } from '@playwright/test';
import { xray } from './xray';

// Replace PROJ-101 with an existing Generic Xray Test in your Test Plan.
// xray() generates tag: ['@PROJ-101'] plus the matching JUnit test_key annotation.
test('Verify login', xray('PROJ-101'), async ({ page }) => {
  // Self-contained reference page; replace with your application's login flow.
  await page.setContent(`
    <label>Email <input type="email" /></label>
    <button onclick="document.querySelector('h1').textContent='Welcome'">Log in</button>
    <h1>Sign in</h1>
  `);
  await page.getByLabel('Email').fill('qa@example.com');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading')).toHaveText('Welcome');
});
