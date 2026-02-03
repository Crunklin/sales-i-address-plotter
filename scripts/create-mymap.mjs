#!/usr/bin/env node
/**
 * Create a new Google My Map and output the map ID (mid).
 * Usage: node scripts/create-mymap.mjs [mapName]
 * Output: JSON line with { mid: "...", title: "..." }
 */

import path from 'path';
import { fileURLToPath } from 'url';
import browser from './browser-manager.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mapName = process.argv[2] || 'Untitled map';

async function main() {
  const page = await browser.getPage();

  try {
    // Go to My Maps home
    await page.goto('https://www.google.com/maps/d/u/0/', { waitUntil: 'load', timeout: 60000 });
    await browser.thinkDelay();

    // Check if we hit a Google sign-in page
    if (!await browser.checkGoogleSession(page)) {
      throw new Error('Google session expired - sign in required. The app will help you re-authenticate.');
    }

    // Click "Create a new map" button with human delay
    await browser.clickDelay();
    const createBtn = page.getByRole('button', { name: /create a new map/i }).first();
    await createBtn.click({ timeout: 10000 }).catch(async () => {
      await browser.clickDelay();
      const altBtn = page.locator('text=/create a new map/i').first();
      await altBtn.click({ timeout: 10000 });
    });

    await browser.humanDelay(500, 1000);

    // Handle the "Creating a MyMaps map always uploads..." confirmation dialog
    try {
      await browser.clickDelay();
      const confirmCreate = page.getByRole('button', { name: /^create$/i }).first();
      await confirmCreate.click({ timeout: 5000 });
      await browser.humanDelay(500, 800);
    } catch (_) {
      // Dialog might not appear
    }

    // Wait for the editor to load
    await page.waitForURL(/\/maps\/d\/.*mid=/, { timeout: 60000 });
    await browser.humanDelay(500, 1000);

    // Extract map ID from URL
    const url = page.url();
    const midMatch = url.match(/[?&]mid=([^&]+)/);
    if (!midMatch) {
      throw new Error('Could not find map ID in URL: ' + url);
    }
    const mid = midMatch[1];

    // Rename the map if a name was provided
    if (mapName && mapName !== 'Untitled map') {
      try {
        await browser.clickDelay();
        const titleEl = page.getByText('Untitled map', { exact: true }).first();
        await titleEl.click({ timeout: 10000 });
        await browser.humanDelay(200, 400);

        await page.keyboard.press('Control+a');
        await browser.humanType(page, mapName);
        await page.keyboard.press('Enter');
        await browser.humanDelay(300, 500);
      } catch (e) {
        process.stderr.write('[create-mymap] Could not rename map: ' + e.message + '\n');
      }
    }

    // Auto-share: make map viewable by anyone with the link
    try {
      process.stderr.write('[create-mymap] Opening share dialog...\n');
      
      await browser.clickDelay();
      const shareBtn = page.locator('text=Share').first();
      await shareBtn.click({ timeout: 5000 });
      await browser.thinkDelay();

      process.stderr.write('[create-mymap] Share dialog opened, looking for toggle...\n');

      let toggled = false;

      // Method 1: Find toggle near "Anyone with this link can view"
      try {
        const row = page.locator('div:has-text("Anyone with this link can view")').first();
        const toggle = row.locator('[class*="track"], [class*="thumb"], [class*="switch"], [class*="toggle"], [role="switch"]').first();
        await browser.clickDelay();
        await toggle.click({ timeout: 2000 });
        toggled = true;
        process.stderr.write('[create-mymap] Clicked toggle in row\n');
      } catch (_) {}

      // Method 2: Click role=switch elements
      if (!toggled) {
        try {
          const switches = page.locator('[role="switch"]');
          const count = await switches.count();
          if (count > 0) {
            await browser.clickDelay();
            await switches.first().click({ timeout: 2000 });
            toggled = true;
            process.stderr.write('[create-mymap] Clicked role=switch element\n');
          }
        } catch (_) {}
      }

      // Method 3: Find by aria-checked
      if (!toggled) {
        try {
          const ariaToggle = page.locator('[aria-checked="false"]').first();
          await browser.clickDelay();
          await ariaToggle.click({ timeout: 2000 });
          toggled = true;
          process.stderr.write('[create-mymap] Clicked aria-checked=false element\n');
        } catch (_) {}
      }

      // Method 4: Click the label text
      if (!toggled) {
        try {
          const label = page.getByText('Anyone with this link can view').first();
          await browser.clickDelay();
          await label.click({ timeout: 2000 });
          toggled = true;
          process.stderr.write('[create-mymap] Clicked label text\n');
        } catch (_) {}
      }

      await browser.humanDelay(500, 800);

      // Close the share dialog
      try {
        await browser.clickDelay();
        const closeBtn = page.getByRole('button', { name: /^close$/i }).first();
        await closeBtn.click({ timeout: 3000 });
        process.stderr.write('[create-mymap] Clicked Close button\n');
      } catch (_) {
        try {
          const xBtn = page.locator('[aria-label="Close"], button:has-text("×"), .close-button').first();
          await browser.clickDelay();
          await xBtn.click({ timeout: 2000 });
        } catch (_) {
          await page.keyboard.press('Escape');
        }
      }
      await browser.humanDelay(200, 400);
      
      process.stderr.write('[create-mymap] Share dialog closed, toggled=' + toggled + '\n');
    } catch (e) {
      process.stderr.write('[create-mymap] Could not auto-share map: ' + e.message + '\n');
    }

    await browser.humanDelay(200, 400);
    // Don't close browser - keep session alive

    // Output result as JSON
    const result = { mid, title: mapName };
    process.stdout.write(JSON.stringify(result) + '\n');
    
  } catch (err) {
    throw err;
  }
}

main().catch((err) => {
  process.stderr.write('[create-mymap] ' + String(err) + '\n');
  process.exit(1);
});
