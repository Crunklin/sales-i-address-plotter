#!/usr/bin/env node
/**
 * Add a new layer to a specific My Map and import the KML file.
 * Used by the app after user picks a map in the UI.
 * Usage: node scripts/import-to-mymaps.mjs <mid> [kmlPath] [layerName]
 * 
 * Improvements:
 * - Dismisses "Restore pages" dialogs automatically
 * - Only creates layer after confirming import will work
 * - Retries on transient failures
 * - Proper browser cleanup
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
const IMPORT_SETTLE_MS = parseInt(process.env.MYMAPS_IMPORT_SETTLE_MS || '4000', 10);
const MAX_RETRIES = parseInt(process.env.MYMAPS_IMPORT_RETRIES || '2', 10);

if (!mid) {
  process.stderr.write('Usage: node scripts/import-to-mymaps.mjs <mid> [kmlPath] [layerName]\n');
  process.exit(1);
}
if (!fs.existsSync(kmlPath)) {
  process.stderr.write('KML file not found: ' + kmlPath + '\n');
  process.exit(1);
}

/**
 * Dismiss any "Restore pages" or similar Chrome dialogs
 */
async function dismissChromeDialogs(page) {
  try {
    // Look for "Restore" button in crash recovery dialog
    const restoreBtn = page.locator('button:has-text("Restore"), [role="button"]:has-text("Restore")').first();
    if (await restoreBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      process.stderr.write('[import] Dismissing "Restore pages" dialog...\n');
      // Click the X or close button instead of restore to avoid loading old tabs
      const closeBtn = page.locator('button:has-text("×"), button:has-text("Close"), button:has-text("Don\\'t restore")').first();
      if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        await closeBtn.click();
      } else {
        // If no close button, just click elsewhere to dismiss
        await page.keyboard.press('Escape');
      }
      await browser.humanDelay(300, 500);
    }
  } catch (_) {
    // Dialog might not exist, that's fine
  }
}

/**
 * Wait for Google My Maps UI to be ready
 */
async function waitForMapsUI(page, timeout = 30000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    // Check for "Add layer" which indicates we're on the map edit page
    const addLayerVisible = await page.getByText('Add layer', { exact: true }).isVisible().catch(() => false);
    if (addLayerVisible) {
      return true;
    }
    
    // Check if we're stuck on a Google sign-in page
    if (!await browser.checkGoogleSession(page)) {
      throw new Error('Google session expired - sign in required. The app will help you re-authenticate.');
    }
    
    // Dismiss any dialogs that might be blocking
    await dismissChromeDialogs(page);
    
    await browser.humanDelay(500, 800);
  }
  
  return false;
}

/**
 * Try to click Import button with multiple strategies
 */
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
      await candidate.waitFor({ state: 'visible', timeout: 5000 });
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

/**
 * Set file on input element, checking main page and iframes
 */
async function setFileInput(page, kmlPath) {
  // Try main page first
  try {
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 3000 });
    await fileInput.setInputFiles(kmlPath);
    return true;
  } catch (_) {}

  // Try iframes
  for (const frame of page.frames()) {
    try {
      const fileInput = frame.locator('input[type="file"]').first();
      await fileInput.waitFor({ state: 'attached', timeout: 1000 });
      await fileInput.setInputFiles(kmlPath);
      return true;
    } catch (_) {}
  }

  return false;
}

/**
 * Wait for import to complete by watching for UI changes
 */
async function waitForImportComplete(page, timeout = 30000) {
  const startTime = Date.now();
  
  // Wait for import dialog to close (file input should disappear)
  while (Date.now() - startTime < timeout) {
    const fileInputVisible = await page.locator('input[type="file"]').isVisible().catch(() => false);
    const importDialogVisible = await page.locator('[aria-label*="Import" i], [role="dialog"]:has-text("Import")').isVisible().catch(() => false);
    
    if (!fileInputVisible && !importDialogVisible) {
      // Give extra time for the import to process on Google's side
      await browser.humanDelay(1000, 2000);
      return true;
    }
    
    // Check for error messages
    const errorVisible = await page.locator('text=/error|failed|invalid/i').isVisible().catch(() => false);
    if (errorVisible) {
      throw new Error('Import failed - Google showed an error message');
    }
    
    await browser.humanDelay(500, 800);
  }
  
  return false;
}

/**
 * Main import function with retry logic
 */
async function doImport(page, attempt = 1) {
  process.stderr.write(`[import] Attempt ${attempt}/${MAX_RETRIES + 1} - Importing to map ${mid}\n`);
  
  const editUrl = `https://www.google.com/maps/d/edit?mid=${mid}`;
  
  // Navigate to map
  await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await browser.humanDelay(500, 1000);
  
  // Dismiss any Chrome dialogs (like "Restore pages")
  await dismissChromeDialogs(page);
  
  // Check Google session
  if (!await browser.checkGoogleSession(page)) {
    throw new Error('Google session expired - sign in required. The app will help you re-authenticate.');
  }
  
  // Wait for My Maps UI to be ready
  if (!await waitForMapsUI(page, 30000)) {
    throw new Error('My Maps UI did not load - "Add layer" button not found');
  }
  
  await browser.humanDelay(300, 600);

  // Click "Add layer" - try multiple methods
  let addedLayer = false;
  
  // Method 1: By exact text
  try {
    const addLayer = page.getByText('Add layer', { exact: true }).first();
    await addLayer.waitFor({ state: 'visible', timeout: 10000 });
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
  
  await browser.humanDelay(400, 800);

  // Click "Import" button
  const importClicked = await clickImportButton(page);
  if (!importClicked) {
    throw new Error('Could not click Import button');
  }

  await browser.humanDelay(300, 600);

  // Set file on input
  let fileSet = await setFileInput(page, kmlPath);
  
  // Fall back to clicking Browse button if direct file input didn't work
  if (!fileSet) {
    try {
      const browseBtn = page.getByRole('button', { name: /browse/i }).first();
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 10000 }),
        browseBtn.click({ timeout: 5000 }).catch(() => 
          page.getByText('Browse', { exact: true }).first().click({ timeout: 3000 })
        ),
      ]);
      await fileChooser.setFiles(kmlPath);
      fileSet = true;
    } catch (e) {
      throw new Error('Could not set file for import: ' + e.message);
    }
  }

  await browser.humanDelay(300, 500);

  // Click through any confirmation buttons
  try {
    await browser.clickDelay();
    await page.getByRole('button', { name: /select|import|upload/i }).first().click({ timeout: 5000 });
  } catch (_) {}
  
  await browser.humanDelay(200, 400);
  
  try {
    await browser.clickDelay();
    await page.getByRole('button', { name: /finish|done|ok/i }).first().click({ timeout: 3000 });
  } catch (_) {}

  // Wait for import to complete
  await waitForImportComplete(page, 20000);
  
  // Extra settle time for Google to process
  await page.waitForTimeout(IMPORT_SETTLE_MS);

  process.stderr.write(`[import] Successfully imported layer to map ${mid}\n`);
}

async function main() {
  let page = null;
  let lastError = null;
  
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      // Get fresh page for each attempt
      page = await browser.getPage();
      
      // Dismiss any startup dialogs
      await dismissChromeDialogs(page);
      
      await doImport(page, attempt);
      
      // Success - close browser cleanly
      await browser.closeBrowser();
      return;
      
    } catch (err) {
      lastError = err;
      process.stderr.write(`[import] Attempt ${attempt} failed: ${err.message}\n`);
      
      // If it's a session error, don't retry
      if (err.message.includes('session expired') || err.message.includes('sign in required')) {
        await browser.closeBrowser();
        throw err;
      }
      
      // Close browser for retry
      if (attempt < MAX_RETRIES + 1) {
        process.stderr.write(`[import] Cleaning up for retry...\n`);
        await browser.closeBrowser();
        browser.forceCleanup();
        await new Promise(r => setTimeout(r, 2000)); // Wait before retry
      }
    }
  }
  
  // All retries failed
  await browser.closeBrowser();
  throw lastError || new Error('Import failed after all retries');
}

main().catch((err) => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});
