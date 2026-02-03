#!/usr/bin/env node
/**
 * Add a new layer to a specific My Map and import the KML file.
 * Used by the app after user picks a map in the UI.
 * Usage: node scripts/import-to-mymaps.mjs <mid> [kmlPath] [layerName]
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import browser from './browser-manager.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
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

async function tryClickImport(scope) {
  const candidates = [
    scope.getByRole('button', { name: /^import$/i }).first(),
    scope.getByText('Import', { exact: true }).first(),
    scope.locator('[role="button"]:has-text("Import")').first(),
    scope.locator('button:has-text("Import")').first(),
    scope.locator('[data-tooltip*="Import" i]').first(),
    scope.locator('[aria-label*="Import" i]').first(),
    scope.locator('text=/^import$/i').first(),
  ];

  for (const candidate of candidates) {
    try {
      await candidate.waitFor({ state: 'visible', timeout: 15000 });
      await candidate.scrollIntoViewIfNeeded().catch(() => {});
      await browser.clickDelay();
      await candidate.click({ timeout: 5000 });
      return true;
    } catch (_) {}
  }

  return false;
}

async function clickImportButton(page) {
  if (await tryClickImport(page)) return true;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    if (await tryClickImport(frame)) return true;
  }
  return false;
}

async function main() {
  const page = await browser.getPage();
  
  try {
    const editUrl = `https://www.google.com/maps/d/edit?mid=${mid}`;
    await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Human-like wait for page load
    await browser.thinkDelay();

    // Check if we hit a Google sign-in/verification page
    if (!await browser.checkGoogleSession(page)) {
      throw new Error('Google session expired - sign in required. The app will help you re-authenticate.');
    }

    // Wait for page to fully load
    await browser.humanDelay(1500, 2500);

    // Click "Add layer" - try multiple methods with human delays
    let addedLayer = false;
    
    // Method 1: By exact text
    try {
      const addLayer = page.getByText('Add layer', { exact: true }).first();
      await addLayer.waitFor({ state: 'visible', timeout: 15000 });
      await browser.clickDelay();
      await addLayer.click({ timeout: 5000 });
      addedLayer = true;
    } catch (_) {}

    // Method 2: By role
    if (!addedLayer) {
      try {
        await browser.clickDelay();
        const addLayerBtn = page.getByRole('button', { name: /add layer/i }).first();
        await addLayerBtn.click({ timeout: 10000 });
        addedLayer = true;
      } catch (_) {}
    }

    // Method 3: By any clickable element with "Add layer" text
    if (!addedLayer) {
      try {
        await browser.clickDelay();
        const addLayerAny = page.locator('text=/add layer/i').first();
        await addLayerAny.click({ timeout: 10000 });
        addedLayer = true;
      } catch (_) {}
    }

    if (!addedLayer) {
      throw new Error('Could not click Add layer button');
    }
    
    await browser.humanDelay(800, 1500);

    // Click "Import" with robust selectors and human delay
    const importClicked = await clickImportButton(page);
    if (!importClicked) {
      throw new Error('Could not click Import button');
    }

    await browser.humanDelay(500, 1000);

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

    await browser.humanDelay(500, 1000);

    // Click through any confirmation buttons with human delays
    try {
      await browser.clickDelay();
      await page.getByRole('button', { name: /select|import|upload/i }).first().click({ timeout: 5000 });
    } catch (_) {}
    
    await browser.humanDelay(300, 600);
    
    try {
      await browser.clickDelay();
      await page.getByRole('button', { name: /finish|done|ok/i }).first().click({ timeout: 3000 });
    } catch (_) {}

    // Rename layer if specified
    if (layerName) {
      try {
        // Wait for the import to complete
        await browser.thinkDelay();

        const kmlBaseName = path.basename(kmlPath, '.kml');
        process.stderr.write(`[import] Looking for layer to rename (from ${kmlBaseName} to ${layerName})...\n`);

        let clicked = false;

        // Method 1: Find by the KML document name
        if (!clicked) {
          try {
            const layerTitle = page.getByText(kmlBaseName, { exact: true }).first();
            await browser.clickDelay();
            await layerTitle.click({ timeout: 3000 });
            clicked = true;
            process.stderr.write('[import] Clicked layer by KML name\n');
          } catch (_) {}
        }

        // Method 2: Try partial match on KML name
        if (!clicked) {
          try {
            const layerTitle = page.locator(`text="${kmlBaseName}"`).first();
            await browser.clickDelay();
            await layerTitle.click({ timeout: 3000 });
            clicked = true;
            process.stderr.write('[import] Clicked layer by partial KML name\n');
          } catch (_) {}
        }

        // Method 3: Look for contenteditable elements
        if (!clicked) {
          try {
            const editables = page.locator('[contenteditable="true"]');
            const count = await editables.count();
            if (count > 0) {
              await browser.clickDelay();
              await editables.last().click({ timeout: 3000 });
              clicked = true;
              process.stderr.write('[import] Clicked last contenteditable element\n');
            }
          } catch (_) {}
        }

        // Method 4: Find "Untitled layer"
        if (!clicked) {
          try {
            const untitled = page.getByText('Untitled layer', { exact: false }).first();
            await browser.clickDelay();
            await untitled.click({ timeout: 3000 });
            clicked = true;
            process.stderr.write('[import] Clicked Untitled layer\n');
          } catch (_) {}
        }

        if (clicked) {
          await browser.humanDelay(200, 400);
          await page.keyboard.press('Control+a');
          await browser.humanType(page, layerName);
          await page.keyboard.press('Enter');
          await browser.humanDelay(300, 500);
          process.stderr.write(`[import] Renamed layer to: ${layerName}\n`);
        } else {
          process.stderr.write('[import] Could not find layer title element to click\n');
        }

      } catch (e) {
        process.stderr.write('[import] Could not rename layer: ' + e.message + '\n');
      }
    }

    await browser.humanDelay(100, 300);
    // Close browser to release profile lock for next operation
    await browser.closeBrowser();
    
  } catch (err) {
    await browser.closeBrowser();
    throw err;
  }
}

main().catch((err) => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});
