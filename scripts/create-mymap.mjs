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
  await page.waitForTimeout(1000);

  // Click "Create a new map" button
  const createBtn = page.getByRole('button', { name: /create a new map/i }).first();
  await createBtn.click({ timeout: clickTimeout }).catch(async () => {
    // Fallback: look for link/button with that text
    const altBtn = page.locator('text=/create a new map/i').first();
    await altBtn.click({ timeout: clickTimeout });
  });

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
