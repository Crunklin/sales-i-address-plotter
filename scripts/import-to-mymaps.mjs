#!/usr/bin/env node
/**
 * Add a new layer to a specific My Map and import the KML file.
 * Used by the app after user picks a map in the UI.
 * Usage: node scripts/import-to-mymaps.mjs <mid> [kmlPath] [layerName]
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const userDataDir = process.env.BROWSER_USER_DATA_DIR || path.join(projectRoot, 'playwright-my-maps-profile');
const headless = !process.env.DISPLAY;
const defaultKmlPath = path.join(projectRoot, 'address-plotter-export.kml');

const mid = process.argv[2];
const kmlPath = process.argv[3] ? path.resolve(process.cwd(), process.argv[3]) : defaultKmlPath;
const layerName = process.argv[4] || '';

if (!mid) {
  process.stderr.write('Usage: node scripts/import-to-mymaps.mjs <mid> [kmlPath] [layerName]\n');
  process.exit(1);
}
if (!fs.existsSync(kmlPath)) {
  process.stderr.write('KML file not found: ' + kmlPath + '\n');
  process.exit(1);
}

async function main() {
  const launchOpts = {
    headless,
    acceptDownloads: true,
    locale: 'en-US',
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  };
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...launchOpts,
    channel: 'chrome',
  }).catch(() => chromium.launchPersistentContext(userDataDir, launchOpts));

  let page = context.pages()[0];
  if (!page) page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });

  const editUrl = `https://www.google.com/maps/d/edit?mid=${mid}`;
  await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Click "Add layer" as soon as it's visible
  const addLayer = page.getByText('Add layer', { exact: true }).first();
  await addLayer.click({ timeout: 10000 }).catch(() =>
    page.getByRole('button', { name: /add layer/i }).first().click({ timeout: 3000 })
  );

  // Click "Import" immediately
  const importBtn = page.getByText('Import', { exact: true }).first();
  await importBtn.click({ timeout: 5000 }).catch(() =>
    page.getByRole('button', { name: /import/i }).first().click({ timeout: 3000 })
  );

  // Try to set file directly on hidden input first (fastest method)
  let fileSet = false;
  try {
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 2000 });
    await fileInput.setInputFiles(kmlPath);
    fileSet = true;
  } catch (_) {}

  // Check iframes if main page didn't work
  if (!fileSet) {
    for (const frame of page.frames()) {
      if (fileSet) break;
      try {
        const fileInput = frame.locator('input[type="file"]').first();
        await fileInput.waitFor({ state: 'attached', timeout: 1000 });
        await fileInput.setInputFiles(kmlPath);
        fileSet = true;
      } catch (_) {}
    }
  }

  // Fall back to clicking Browse button
  if (!fileSet) {
    const browseBtn = page.getByRole('button', { name: /browse/i }).first();
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 10000 }),
      browseBtn.click({ timeout: 5000 }).catch(() => page.getByText('Browse', { exact: true }).first().click({ timeout: 3000 })),
    ]);
    await fileChooser.setFiles(kmlPath);
  }

  // Click through any confirmation buttons quickly
  await page.getByRole('button', { name: /select|import|upload/i }).first().click({ timeout: 5000 }).catch(() => null);
  await page.getByRole('button', { name: /finish|done|ok/i }).first().click({ timeout: 3000 }).catch(() => null);

  // Rename layer if specified
  if (layerName) {
    try {
      // Wait for the import to complete and layer to appear
      await page.waitForTimeout(1000);

      // The layer title is in a container with class containing "layer" 
      // Find all layer title elements and click the last one (most recently added)
      // Try multiple selectors since Google's UI varies
      let clicked = false;

      // Method 1: Look for layer header elements with contenteditable or click-to-edit
      const layerHeaders = page.locator('[data-layer-id], .layer-header, [class*="layer"] [class*="title"], [class*="layer"] [class*="name"]');
      const count = await layerHeaders.count();
      if (count > 0) {
        const lastLayer = layerHeaders.last();
        await lastLayer.click({ timeout: 3000 });
        clicked = true;
      }

      if (!clicked) {
        // Method 2: Find by the KML filename (without extension) - this is what Google names it
        const kmlBaseName = path.basename(kmlPath, '.kml');
        const layerByName = page.getByText(kmlBaseName, { exact: false }).first();
        await layerByName.click({ timeout: 3000 });
        clicked = true;
      }

      if (!clicked) {
        // Method 3: Find any layer container and click the title area
        const layerContainer = page.locator('[class*="layer"]').first();
        await layerContainer.locator('[class*="title"], [class*="name"]').first().click({ timeout: 3000 });
      }

      // Now type the new name
      await page.waitForTimeout(100);
      await page.keyboard.press('Control+a');
      await page.keyboard.type(layerName, { delay: 15 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);

    } catch (e) {
      process.stderr.write('[import] Could not rename layer: ' + e.message + '\n');
    }
  }

  await page.waitForTimeout(100);
  await context.close();
}

main().catch((err) => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});
