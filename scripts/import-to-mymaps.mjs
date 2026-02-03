#!/usr/bin/env node
/**
 * Add a new layer to a specific My Map and import the KML file.
 * Used by the app after user picks a map in the UI.
 * Usage: node scripts/import-to-mymaps.mjs <mid> [kmlPath] [layerName] [colorIndex]
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
  await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  
  // Wait for page to fully load
  await page.waitForTimeout(2000);

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
    throw new Error('Google session expired. Please re-authenticate via VNC on the VPS and try again.');
  }

  // Click "Add layer" - try multiple methods with longer timeouts
  let addedLayer = false;
  
  // Method 1: By exact text
  try {
    const addLayer = page.getByText('Add layer', { exact: true }).first();
    await addLayer.waitFor({ state: 'visible', timeout: 15000 });
    await addLayer.click({ timeout: 5000 });
    addedLayer = true;
  } catch (_) {}

  // Method 2: By role
  if (!addedLayer) {
    try {
      const addLayerBtn = page.getByRole('button', { name: /add layer/i }).first();
      await addLayerBtn.click({ timeout: 10000 });
      addedLayer = true;
    } catch (_) {}
  }

  // Method 3: By any clickable element with "Add layer" text
  if (!addedLayer) {
    try {
      const addLayerAny = page.locator('text=/add layer/i').first();
      await addLayerAny.click({ timeout: 10000 });
      addedLayer = true;
    } catch (_) {}
  }

  if (!addedLayer) {
    throw new Error('Could not click Add layer button');
  }
  
  await page.waitForTimeout(500);

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
      // Wait for the import to complete
      await page.waitForTimeout(2000);

      // The imported layer will have the KML's <Document><name> as its title
      // We need to find that layer title and click on it to rename it
      const kmlBaseName = path.basename(kmlPath, '.kml');
      process.stderr.write(`[import] Looking for layer to rename (from ${kmlBaseName} to ${layerName})...\n`);

      let clicked = false;

      // Method 1: Find by the KML document name (Google uses this as layer title)
      if (!clicked) {
        try {
          const layerTitle = page.getByText(kmlBaseName, { exact: true }).first();
          await layerTitle.click({ timeout: 3000 });
          clicked = true;
          process.stderr.write('[import] Clicked layer by KML name\n');
        } catch (_) {}
      }

      // Method 2: Try partial match on KML name
      if (!clicked) {
        try {
          const layerTitle = page.locator(`text="${kmlBaseName}"`).first();
          await layerTitle.click({ timeout: 3000 });
          clicked = true;
          process.stderr.write('[import] Clicked layer by partial KML name\n');
        } catch (_) {}
      }

      // Method 3: Look for contenteditable elements (layer titles are editable)
      if (!clicked) {
        try {
          const editables = page.locator('[contenteditable="true"]');
          const count = await editables.count();
          if (count > 0) {
            // Click the last editable (most recent layer)
            await editables.last().click({ timeout: 3000 });
            clicked = true;
            process.stderr.write('[import] Clicked last contenteditable element\n');
          }
        } catch (_) {}
      }

      // Method 4: Find "Untitled layer" if that's what it got named
      if (!clicked) {
        try {
          const untitled = page.getByText('Untitled layer', { exact: false }).first();
          await untitled.click({ timeout: 3000 });
          clicked = true;
          process.stderr.write('[import] Clicked Untitled layer\n');
        } catch (_) {}
      }

      if (clicked) {
        // Type the new name (select all first to replace)
        await page.waitForTimeout(200);
        await page.keyboard.press('Control+a');
        await page.keyboard.type(layerName, { delay: 20 });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        process.stderr.write(`[import] Renamed layer to: ${layerName}\n`);
      } else {
        process.stderr.write('[import] Could not find layer title element to click\n');
      }

    } catch (e) {
      process.stderr.write('[import] Could not rename layer: ' + e.message + '\n');
    }
  }

  // Change layer color if colorIndex is provided
  if (colorIndex >= 0) {
    try {
      await page.waitForTimeout(500);
      process.stderr.write(`[import] Setting layer color (index ${colorIndex})...\n`);

      // Click somewhere neutral first to deselect any text
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);

      // Find the paint bucket / style icon for the most recently added layer
      // It's usually in the layer header area - look for it by various means
      let styleOpened = false;

      // Method 1: Look for paint bucket icon by aria-label or title
      try {
        const paintIcon = page.locator('[aria-label*="style" i], [aria-label*="color" i], [title*="style" i], [title*="color" i], [data-tooltip*="style" i]').last();
        await paintIcon.click({ timeout: 3000 });
        styleOpened = true;
        process.stderr.write('[import] Clicked style icon by aria-label\n');
      } catch (_) {}

      // Method 2: Look for the paint bucket SVG icon in layer headers
      if (!styleOpened) {
        try {
          // The style button is often a small icon button in the layer header
          const layerHeaders = page.locator('[class*="layer"]');
          const lastHeader = layerHeaders.last();
          const styleBtn = lastHeader.locator('button, [role="button"]').last();
          await styleBtn.click({ timeout: 3000 });
          styleOpened = true;
          process.stderr.write('[import] Clicked button in layer header\n');
        } catch (_) {}
      }

      // Method 3: Click "Individual styles" or "Uniform style" text if visible
      if (!styleOpened) {
        try {
          const styleText = page.getByText(/individual styles|uniform style|set labels/i).first();
          await styleText.click({ timeout: 3000 });
          styleOpened = true;
          process.stderr.write('[import] Clicked style text\n');
        } catch (_) {}
      }

      if (styleOpened) {
        await page.waitForTimeout(500);

        // Now click on a color in the palette
        // Google's color palette shows colored circles/squares
        const targetColorIndex = colorIndex % GOOGLE_COLORS.length;
        
        // Try to find color elements in the style panel
        try {
          // Look for color swatches (usually small colored elements)
          const colorSwatches = page.locator('[class*="color"], [style*="background"], [data-color]').filter({ 
            has: page.locator(':scope:not(:has(*))') // Leaf elements (no children)
          });
          
          // Try clicking by position in the color palette
          const swatches = page.locator('[class*="swatch"], [class*="color-picker"] *, [class*="palette"] *');
          const count = await swatches.count();
          
          if (count > targetColorIndex) {
            await swatches.nth(targetColorIndex).click({ timeout: 2000 });
            process.stderr.write(`[import] Clicked color swatch ${targetColorIndex}\n`);
          } else {
            // Fallback: click any visible colored element
            const anyColor = page.locator('[style*="background-color"]').nth(targetColorIndex % Math.max(1, count));
            await anyColor.click({ timeout: 2000 });
            process.stderr.write('[import] Clicked fallback color element\n');
          }
        } catch (e) {
          process.stderr.write('[import] Could not click color: ' + e.message + '\n');
        }

        // Close the style panel
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
      } else {
        process.stderr.write('[import] Could not open style panel\n');
      }

    } catch (e) {
      process.stderr.write('[import] Could not set layer color: ' + e.message + '\n');
    }
  }

  await page.waitForTimeout(100);
  await context.close();
}

main().catch((err) => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});
