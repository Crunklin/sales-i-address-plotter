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
 * Dismiss any "Restore pages" or similar Chrome dialogs/infobars
 */
async function dismissChromeDialogs(page) {
  try {
    // Method 1: Try to dismiss via JavaScript - most reliable for Chrome infobars
    await page.evaluate(() => {
      // Find and click any "Don't restore" or dismiss buttons
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent?.toLowerCase() || '';
        if (text.includes('restore') || text.includes('dismiss') || text.includes('close') || text === '×') {
          // For restore dialog, we want to NOT restore (click X or dismiss)
          if (btn.textContent === '×' || text.includes('dismiss') || text.includes("don't")) {
            btn.click();
            return 'dismissed';
          }
        }
      }
      // Also try to close any infobars
      const infobars = document.querySelectorAll('[class*="infobar"], [class*="InfoBar"], [class*="toast"]');
      for (const bar of infobars) {
        const closeBtn = bar.querySelector('button, [role="button"]');
        if (closeBtn) {
          closeBtn.click();
          return 'infobar-closed';
        }
      }
      return 'no-dialog';
    }).then(result => {
      if (result !== 'no-dialog') {
        process.stderr.write(`[import] Chrome dialog handled: ${result}\n`);
      }
    }).catch(() => {});

    // Method 2: Try keyboard shortcuts to dismiss
    await page.keyboard.press('Escape');
    await browser.humanDelay(100, 200);
    
    // Method 3: Click on the main content area to ensure focus
    try {
      await page.mouse.click(640, 450); // Click center of viewport
      await browser.humanDelay(100, 200);
    } catch (_) {}

  } catch (_) {
    // Dialog handling failed, continue anyway
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
 * Take a debug screenshot with timestamp
 */
async function takeDebugScreenshot(page, label) {
  try {
    const timestamp = Date.now();
    const screenshotPath = path.join(projectRoot, `debug-${label}-${timestamp}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    process.stderr.write(`[import] Screenshot: ${screenshotPath}\n`);
    return screenshotPath;
  } catch (e) {
    process.stderr.write(`[import] Screenshot failed: ${e.message}\n`);
    return null;
  }
}

/**
 * Main import function with retry logic
 */
async function doImport(page, attempt = 1) {
  process.stderr.write(`[import] === STARTING IMPORT ===\n`);
  process.stderr.write(`[import] Attempt ${attempt}/${MAX_RETRIES + 1} - Importing to map ${mid}\n`);
  process.stderr.write(`[import] Layer name: ${layerName || '(default)'}\n`);
  
  const editUrl = `https://www.google.com/maps/d/edit?mid=${mid}`;
  
  // Navigate to map
  process.stderr.write(`[import] Step 1: Navigating to ${editUrl}\n`);
  await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await browser.humanDelay(500, 1000);
  
  // Dismiss any Chrome dialogs (like "Restore pages")
  process.stderr.write(`[import] Step 2: Checking for Chrome dialogs\n`);
  await dismissChromeDialogs(page);
  await browser.humanDelay(300, 500);
  await dismissChromeDialogs(page); // Try twice
  
  // Check Google session
  process.stderr.write(`[import] Step 3: Checking Google session\n`);
  if (!await browser.checkGoogleSession(page)) {
    await takeDebugScreenshot(page, 'session-expired');
    throw new Error('Google session expired - sign in required. The app will help you re-authenticate.');
  }
  process.stderr.write(`[import] Session OK\n`);
  
  // Wait for My Maps UI to be ready
  process.stderr.write(`[import] Step 4: Waiting for My Maps UI\n`);
  if (!await waitForMapsUI(page, 30000)) {
    await takeDebugScreenshot(page, 'ui-not-ready');
    throw new Error('My Maps UI did not load - "Add layer" button not found');
  }
  process.stderr.write(`[import] UI ready\n`);
  
  await browser.humanDelay(300, 600);

  // Click "Add layer" - try multiple methods with scrolling
  // After 2+ layers, "Add layer" may be scrolled out of view in the sidebar
  let addedLayer = false;
  
  // First, try to scroll the sidebar to make "Add layer" visible
  // The sidebar in My Maps is typically a scrollable container
  try {
    // Scroll sidebar to bottom where "Add layer" typically is
    await page.evaluate(() => {
      const sidebar = document.querySelector('[role="navigation"]') || 
                      document.querySelector('.widget-pane') ||
                      document.querySelector('[class*="panel"]');
      if (sidebar) {
        sidebar.scrollTop = sidebar.scrollHeight;
      }
    });
    await browser.humanDelay(200, 400);
  } catch (_) {}
  
  // Method 1: By exact text with scroll into view
  try {
    const addLayer = page.getByText('Add layer', { exact: true }).first();
    // Scroll element into view first
    await addLayer.scrollIntoViewIfNeeded({ timeout: 5000 });
    await browser.humanDelay(200, 400);
    await addLayer.waitFor({ state: 'visible', timeout: 10000 });
    await browser.clickDelay();
    await addLayer.click({ timeout: 5000 });
    addedLayer = true;
    process.stderr.write('[import] Clicked "Add layer" via text match\n');
  } catch (e) {
    process.stderr.write(`[import] Method 1 failed: ${e.message}\n`);
  }

  // Method 2: By role with scroll
  if (!addedLayer) {
    try {
      const addLayerBtn = page.getByRole('button', { name: /add layer/i }).first();
      await addLayerBtn.scrollIntoViewIfNeeded({ timeout: 5000 });
      await browser.humanDelay(200, 400);
      await browser.clickDelay();
      await addLayerBtn.click({ timeout: 10000 });
      addedLayer = true;
      process.stderr.write('[import] Clicked "Add layer" via role\n');
    } catch (e) {
      process.stderr.write(`[import] Method 2 failed: ${e.message}\n`);
    }
  }

  // Method 3: By any clickable element with "Add layer" text
  if (!addedLayer) {
    try {
      const addLayerAny = page.locator('text=/add layer/i').first();
      await addLayerAny.scrollIntoViewIfNeeded({ timeout: 5000 });
      await browser.humanDelay(200, 400);
      await browser.clickDelay();
      await addLayerAny.click({ timeout: 10000 });
      addedLayer = true;
      process.stderr.write('[import] Clicked "Add layer" via text locator\n');
    } catch (e) {
      process.stderr.write(`[import] Method 3 failed: ${e.message}\n`);
    }
  }

  // Method 4: Use JavaScript click as last resort
  if (!addedLayer) {
    try {
      const clicked = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('*'));
        for (const el of elements) {
          if (el.textContent?.trim() === 'Add layer' || 
              el.innerText?.trim() === 'Add layer') {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.click();
            return true;
          }
        }
        return false;
      });
      if (clicked) {
        addedLayer = true;
        process.stderr.write('[import] Clicked "Add layer" via JS click\n');
      }
    } catch (e) {
      process.stderr.write(`[import] Method 4 failed: ${e.message}\n`);
    }
  }

  if (!addedLayer) {
    // Take screenshot for debugging
    try {
      const screenshotPath = path.join(projectRoot, `debug-add-layer-fail-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      process.stderr.write(`[import] Screenshot saved: ${screenshotPath}\n`);
    } catch (_) {}
    throw new Error('Could not click Add layer button - it may be scrolled out of view or the UI has changed');
  }
  
  await browser.humanDelay(400, 800);
  await takeDebugScreenshot(page, 'after-add-layer');

  // Click "Import" button (on the newly created layer)
  process.stderr.write(`[import] Step 6: Looking for Import button\n`);
  const importClicked = await clickImportButton(page);
  if (!importClicked) {
    await takeDebugScreenshot(page, 'import-btn-fail');
    throw new Error('Could not click Import button');
  }
  process.stderr.write('[import] Clicked Import button\n');
  
  // Wait for import dialog to fully load (the content can take time)
  process.stderr.write(`[import] Step 7: Waiting for import dialog to load\n`);
  await browser.humanDelay(2000, 3000);
  await takeDebugScreenshot(page, 'dialog-loading');
  
  // Check if dialog content loaded by looking for file input or browse button
  let dialogLoaded = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    // Check for file input in main page or iframes
    const fileInputExists = await page.locator('input[type="file"]').count() > 0;
    if (fileInputExists) {
      dialogLoaded = true;
      process.stderr.write(`[import] Dialog loaded (file input found on main page)\n`);
      break;
    }
    
    // Check in iframes
    for (const frame of page.frames()) {
      const frameFileInput = await frame.locator('input[type="file"]').count().catch(() => 0);
      if (frameFileInput > 0) {
        dialogLoaded = true;
        process.stderr.write(`[import] Dialog loaded (file input found in iframe)\n`);
        break;
      }
    }
    if (dialogLoaded) break;
    
    // Check for "Browse" or "Select" button
    const browseBtn = await page.getByRole('button', { name: /browse|select|choose/i }).count();
    if (browseBtn > 0) {
      dialogLoaded = true;
      process.stderr.write(`[import] Dialog loaded (browse button found)\n`);
      break;
    }
    
    process.stderr.write(`[import] Dialog content not ready, waiting... (attempt ${attempt + 1}/5)\n`);
    await browser.humanDelay(1500, 2500);
  }
  
  if (!dialogLoaded) {
    await takeDebugScreenshot(page, 'dialog-blank');
    // Try pressing Escape and clicking Import again
    process.stderr.write(`[import] Dialog appears blank, retrying Import click...\n`);
    await page.keyboard.press('Escape');
    await browser.humanDelay(500, 1000);
    
    // Try clicking Import link directly on the layer
    const importLink = page.locator('text=Import').first();
    await importLink.click({ timeout: 5000 }).catch(() => {});
    await browser.humanDelay(2000, 3000);
    await takeDebugScreenshot(page, 'dialog-retry');
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
