#!/usr/bin/env node
/**
 * Add a new layer to a specific My Map and import the KML file.
 * Used by the app after user picks a map in the UI.
 * Usage: node scripts/import-to-mymaps.mjs <mid> [kmlPath] [layerName] [colorIndex]
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
const colorIndex = parseInt(process.argv[5] || '0', 10);

// Google My Maps color names (in order they appear in the palette)
const GOOGLE_COLORS = [
  'Blue',      // 0
  'Red',       // 1
  'Green',     // 2
  'Yellow',    // 3
  'Purple',    // 4
  'Pink',      // 5
  'Cyan',      // 6
  'Orange',    // 7
  'Light Green', // 8
  'Brown',     // 9
];

const LAYER_WAIT_MS = parseInt(process.env.MYMAPS_LAYER_WAIT_MS || '90000', 10);

if (!mid) {
  process.stderr.write('Usage: node scripts/import-to-mymaps.mjs <mid> [kmlPath] [layerName]\n');
  process.exit(1);
}
if (!fs.existsSync(kmlPath)) {
  process.stderr.write('KML file not found: ' + kmlPath + '\n');
  process.exit(1);
}

async function waitForLayerVisible(page, label, timeoutMs) {
  if (!label) return false;
  try {
    const exact = page.getByText(label, { exact: true }).first();
    await exact.waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch (_) {}
  try {
    const partial = page.getByText(label, { exact: false }).first();
    await partial.waitFor({ state: 'visible', timeout: Math.min(5000, timeoutMs) });
    return true;
  } catch (_) {}
  return false;
}

async function findLayerRow(page, label) {
  if (!label) return null;
  const selectors = [
    'div[role="treeitem"]',
    'div[role="listitem"]',
    '[class*="layer"]',
  ];
  for (const sel of selectors) {
    try {
      const row = page.locator(sel).filter({ hasText: label });
      if (await row.count() > 0) return row.first();
    } catch (_) {}
  }
  return null;
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

    // Click "Import" with human delay
    await browser.clickDelay();
    const importBtn = page.getByText('Import', { exact: true }).first();
    await importBtn.click({ timeout: 5000 }).catch(async () => {
      await browser.clickDelay();
      await page.getByRole('button', { name: /import/i }).first().click({ timeout: 3000 });
    });

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

    const kmlBaseName = path.basename(kmlPath, '.kml');
    const layerVisible = await waitForLayerVisible(page, kmlBaseName, LAYER_WAIT_MS);
    if (!layerVisible) {
      process.stderr.write(`[import] Layer not visible after ${LAYER_WAIT_MS}ms. Continuing without rename/color.\n`);
    }

    // Rename layer if specified
    if (layerName && layerVisible) {
      try {
        // Wait for the import to complete
        await browser.thinkDelay();

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

    // Change layer color if colorIndex is provided
    if (colorIndex >= 0 && layerVisible) {
      try {
        await browser.humanDelay(500, 1000);
        process.stderr.write(`[import] Setting layer color (index ${colorIndex})...\n`);

        await page.keyboard.press('Escape');
        await browser.clickDelay();

        let styleOpened = false;

        // Prefer the style control within the target layer row
        let layerLabel = layerName || kmlBaseName;
        let layerRow = await findLayerRow(page, layerLabel);
        if (!layerRow && layerLabel !== kmlBaseName) {
          layerLabel = kmlBaseName;
          layerRow = await findLayerRow(page, layerLabel);
        }

        if (layerRow) {
          try {
            const rowStyleBtn = layerRow.locator('[aria-label*="style" i], [aria-label*="color" i], [title*="style" i]').first();
            await browser.clickDelay();
            await rowStyleBtn.click({ timeout: 3000 });
            styleOpened = true;
            process.stderr.write(`[import] Opened style from layer row (${layerLabel})\n`);
          } catch (_) {}
        }

        // Try to find and click the style icon
        if (!styleOpened) {
          try {
            const paintIcon = page.locator('[aria-label*="style" i], [aria-label*="color" i], [title*="style" i]').last();
            await browser.clickDelay();
            await paintIcon.click({ timeout: 3000 });
            styleOpened = true;
          } catch (_) {}
        }

        if (!styleOpened) {
          try {
            const styleText = page.getByText(/individual styles|uniform style/i).first();
            await browser.clickDelay();
            await styleText.click({ timeout: 3000 });
            styleOpened = true;
          } catch (_) {}
        }

        if (styleOpened) {
          await browser.humanDelay(500, 800);
          const targetColorIndex = colorIndex % GOOGLE_COLORS.length;
          
          try {
            const swatches = page.locator('[class*="swatch"], [class*="color-picker"] *, [class*="palette"] *');
            const count = await swatches.count();
            
            if (count > targetColorIndex) {
              await browser.clickDelay();
              await swatches.nth(targetColorIndex).click({ timeout: 2000 });
              process.stderr.write(`[import] Clicked color swatch ${targetColorIndex}\n`);
            }
          } catch (e) {
            process.stderr.write('[import] Could not click color: ' + e.message + '\n');
          }

          await page.keyboard.press('Escape');
        }

      } catch (e) {
        process.stderr.write('[import] Could not set layer color: ' + e.message + '\n');
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
