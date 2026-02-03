#!/usr/bin/env node
/**
 * Create a new Google My Map and output the map ID (mid).
 * Usage: node scripts/create-mymap.mjs [mapName]
 * Output: JSON line with { mid: "...", title: "..." }
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const userDataDir = process.env.BROWSER_USER_DATA_DIR || path.join(projectRoot, 'playwright-my-maps-profile');
const headless = !process.env.DISPLAY;
const isVps = !!process.env.DISPLAY;

const mapName = process.argv[2] || 'Untitled map';

// Longer timeouts for VPS (headless Chromium can be slower)
const navTimeout = isVps ? 60000 : 30000;
const clickTimeout = isVps ? 15000 : 10000;

async function main() {
  const launchOpts = {
    headless,
    acceptDownloads: true,
    locale: 'en-US',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  };

  const context = await chromium.launchPersistentContext(userDataDir, {
    ...launchOpts,
    channel: 'chrome',
  }).catch(() => chromium.launchPersistentContext(userDataDir, launchOpts));

  let page = context.pages()[0];
  if (!page) page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });

  // Go to My Maps home (where "Create a new map" button is)
  await page.goto('https://www.google.com/maps/d/u/0/', { waitUntil: 'load', timeout: navTimeout });
  await page.waitForTimeout(1500);

  // Check if we hit a Google sign-in/verification page
  const currentUrl = page.url();
  const pageContent = await page.content();
  if (
    currentUrl.includes('accounts.google.com') ||
    currentUrl.includes('/signin') ||
    pageContent.includes('Verify it') ||
    pageContent.includes('Sign in') ||
    pageContent.includes('sign in again')
  ) {
    await context.close();
    throw new Error('Google session expired - sign in required. The app will help you re-authenticate.');
  }

  // Click "Create a new map" button
  const createBtn = page.getByRole('button', { name: /create a new map/i }).first();
  await createBtn.click({ timeout: clickTimeout }).catch(async () => {
    // Fallback: look for link/button with that text
    const altBtn = page.locator('text=/create a new map/i').first();
    await altBtn.click({ timeout: clickTimeout });
  });

  await page.waitForTimeout(500);

  // Handle the "Creating a MyMaps map always uploads..." confirmation dialog
  try {
    const confirmCreate = page.getByRole('button', { name: /^create$/i }).first();
    await confirmCreate.click({ timeout: 5000 });
    await page.waitForTimeout(500);
  } catch (_) {
    // Dialog might not appear if already dismissed before
  }

  // Wait for the editor to load (URL will have mid=...)
  await page.waitForURL(/\/maps\/d\/.*mid=/, { timeout: navTimeout });
  await page.waitForTimeout(500);

  // Extract map ID from URL
  const url = page.url();
  const midMatch = url.match(/[?&]mid=([^&]+)/);
  if (!midMatch) {
    throw new Error('Could not find map ID in URL: ' + url);
  }
  const mid = midMatch[1];

  // Rename the map if a name was provided (default is "Untitled map")
  if (mapName && mapName !== 'Untitled map') {
    try {
      // Click on "Untitled map" title to edit it
      const titleEl = page.getByText('Untitled map', { exact: true }).first();
      await titleEl.click({ timeout: clickTimeout });
      await page.waitForTimeout(200);

      // Select all and type new name
      await page.keyboard.press('Control+a');
      await page.keyboard.type(mapName, { delay: 30 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
    } catch (e) {
      // If renaming fails, the map is still created - just with default name
      process.stderr.write('[create-mymap] Could not rename map: ' + e.message + '\n');
    }
  }

  // Auto-share: make map viewable by anyone with the link (so embed preview works)
  try {
    process.stderr.write('[create-mymap] Opening share dialog...\n');
    
    // Click the Share button in the toolbar
    const shareBtn = page.locator('text=Share').first();
    await shareBtn.click({ timeout: 5000 });
    await page.waitForTimeout(1500);

    process.stderr.write('[create-mymap] Share dialog opened, looking for toggle...\n');

    // The share dialog has a toggle switch for "Anyone with this link can view"
    // The toggle is typically a Material Design switch - look for it by various means
    
    let toggled = false;

    // Method 1: Find the toggle by looking for elements near "Anyone with this link"
    try {
      // The toggle is usually in a row/div containing the text
      const row = page.locator('div:has-text("Anyone with this link can view")').first();
      // Click on the toggle track/thumb (usually has specific classes)
      const toggle = row.locator('[class*="track"], [class*="thumb"], [class*="switch"], [class*="toggle"], [role="switch"]').first();
      await toggle.click({ timeout: 2000 });
      toggled = true;
      process.stderr.write('[create-mymap] Clicked toggle in row\n');
    } catch (_) {}

    // Method 2: Click any toggle/switch role elements
    if (!toggled) {
      try {
        const switches = page.locator('[role="switch"]');
        const count = await switches.count();
        if (count > 0) {
          await switches.first().click({ timeout: 2000 });
          toggled = true;
          process.stderr.write('[create-mymap] Clicked role=switch element\n');
        }
      } catch (_) {}
    }

    // Method 3: Find Material toggle by aria attributes
    if (!toggled) {
      try {
        const ariaToggle = page.locator('[aria-checked="false"]').first();
        await ariaToggle.click({ timeout: 2000 });
        toggled = true;
        process.stderr.write('[create-mymap] Clicked aria-checked=false element\n');
      } catch (_) {}
    }

    // Method 4: Find by class patterns common in Google Material UI
    if (!toggled) {
      try {
        const materialToggle = page.locator('.mdc-switch, .mat-slide-toggle, [class*="MuiSwitch"], [class*="toggle-track"]').first();
        await materialToggle.click({ timeout: 2000 });
        toggled = true;
        process.stderr.write('[create-mymap] Clicked material toggle element\n');
      } catch (_) {}
    }

    // Method 5: Click the label text itself (sometimes this triggers the toggle)
    if (!toggled) {
      try {
        const label = page.getByText('Anyone with this link can view').first();
        await label.click({ timeout: 2000 });
        toggled = true;
        process.stderr.write('[create-mymap] Clicked label text\n');
      } catch (_) {}
    }

    await page.waitForTimeout(500);

    // Close the share dialog
    try {
      const closeBtn = page.getByRole('button', { name: /^close$/i }).first();
      await closeBtn.click({ timeout: 3000 });
      process.stderr.write('[create-mymap] Clicked Close button\n');
    } catch (_) {
      // Try X button or Escape
      try {
        const xBtn = page.locator('[aria-label="Close"], button:has-text("×"), .close-button').first();
        await xBtn.click({ timeout: 2000 });
      } catch (_) {
        await page.keyboard.press('Escape');
      }
    }
    await page.waitForTimeout(200);
    
    process.stderr.write('[create-mymap] Share dialog closed, toggled=' + toggled + '\n');
  } catch (e) {
    process.stderr.write('[create-mymap] Could not auto-share map: ' + e.message + '\n');
  }

  await page.waitForTimeout(200);
  await context.close();

  // Output result as JSON (server parses this)
  const result = { mid, title: mapName };
  process.stdout.write(JSON.stringify(result) + '\n');
}

main().catch((err) => {
  process.stderr.write('[create-mymap] ' + String(err) + '\n');
  process.exit(1);
});
