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
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox'],
  };
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...launchOpts,
    channel: 'chrome',
  }).catch(() => chromium.launchPersistentContext(userDataDir, launchOpts));

  let page = context.pages()[0];
  if (!page) page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });

  const editUrl = `https://www.google.com/maps/d/edit?mid=${mid}`;
  await page.goto(editUrl, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(400);

  const addLayer = page.getByText('Add layer', { exact: true }).first();
  await addLayer.click({ timeout: 15000 }).catch(() =>
    page.getByRole('button', { name: /add layer/i }).first().click({ timeout: 5000 })
  );
  await page.waitForTimeout(400);

  const importBtn = page.getByText('Import', { exact: true }).first();
  await importBtn.click({ timeout: 10000 }).catch(() =>
    page.getByRole('button', { name: /import/i }).first().click({ timeout: 5000 })
  );
  await page.waitForTimeout(400);
  // My Maps shows "Choose a file to import" modal. Try setInputFiles on file input first (no filechooser needed).
  let fileSet = false;
  try {
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 5000 });
    await fileInput.setInputFiles(kmlPath);
    fileSet = true;
  } catch (_) {}
  if (!fileSet) {
    for (const frame of page.frames()) {
      if (fileSet) break;
      try {
        const fileInput = frame.locator('input[type="file"]').first();
        await fileInput.waitFor({ state: 'attached', timeout: 3000 });
        await fileInput.setInputFiles(kmlPath);
        fileSet = true;
      } catch (_) {}
    }
  }
  if (!fileSet) {
    const browseBtn = page.getByRole('button', { name: /browse/i }).first();
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 25000 }),
      browseBtn.click({ timeout: 10000 }).catch(() => page.getByText('Browse', { exact: true }).first().click({ timeout: 5000 })),
    ]);
    await fileChooser.setFiles(kmlPath);
  }
  await page.waitForTimeout(500);

  const selectBtn = page.getByRole('button', { name: /select|import/i }).first();
  await selectBtn.click({ timeout: 10000 }).catch(() => null);
  await page.waitForTimeout(500);

  const finishBtn = page.getByRole('button', { name: /finish|select|done/i }).first();
  await finishBtn.click({ timeout: 5000 }).catch(() => null);

  await page.waitForTimeout(400);

  if (layerName) {
    await page.waitForTimeout(300);
    try {
      const untitled = page.getByText('Untitled layer', { exact: true }).first();
      await untitled.click({ timeout: 5000 });
      await page.waitForTimeout(150);
      await page.keyboard.press('Control+a');
      await page.keyboard.type(layerName, { delay: 30 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
    } catch (_) {
      try {
        const layerInput = page.locator('input[placeholder*="layer"], input[placeholder*="Layer"], [contenteditable="true"]').first();
        await layerInput.waitFor({ state: 'visible', timeout: 3000 });
        await layerInput.click();
        await layerInput.fill(layerName);
        await page.keyboard.press('Enter');
      } catch (_) {}
    }
  }

  await page.waitForTimeout(200);
  await context.close();
}

main().catch((err) => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});
