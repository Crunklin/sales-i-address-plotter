#!/usr/bin/env node
/**
 * Add the exported KML to a Google My Maps map of your choice.
 * Run after saving KML from the app (click "Add to Google My Maps" in the app first).
 *
 * Usage: npm run add-to-mymaps
 *    or: node scripts/add-to-mymaps.mjs [path/to/file.kml]
 *
 * Uses a saved browser profile so you only sign in to Google once; later runs
 * reuse your session. Profile is stored in playwright-my-maps-profile/ (gitignored).
 */

import { chromium } from 'playwright';
import readline from 'readline';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const defaultKmlPath = path.join(projectRoot, 'address-plotter-export.kml');
const userDataDir = process.env.BROWSER_USER_DATA_DIR || path.join(projectRoot, 'playwright-my-maps-profile');
const headless = !process.env.DISPLAY;

const kmlPath = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : defaultKmlPath;

if (!fs.existsSync(kmlPath)) {
  console.error('KML file not found:', kmlPath);
  console.error('Export from the app first (click "Add to Google My Maps"), or pass a path:');
  console.error('  node scripts/add-to-mymaps.mjs path/to/addresses.kml');
  process.exit(1);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log('Opening browser (using saved profile — sign in only on first run).\n');
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

  // Go to My Maps list
  await page.goto('https://www.google.com/maps/d/', { waitUntil: 'networkidle', timeout: 60000 });

  console.log('Waiting for your maps list to load…');
  // Wait for map list: links that contain map IDs
  await page.waitForSelector('a[href*="/maps/d/"]', { timeout: 60000 }).catch(() => null);

  // Give the list time to render (e.g. after login)
  await page.waitForTimeout(3000);

  const maps = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/maps/d/"]'));
    const seen = new Set();
    return links
      .map((a) => {
        const href = a.getAttribute('href') || '';
        const midMatch = href.match(/[?&]mid=([^&]+)/);
        const mid = midMatch ? midMatch[1] : null;
        if (!mid || seen.has(mid)) return null;
        seen.add(mid);
        const title = (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
        return { mid, title, href };
      })
      .filter(Boolean);
  });

  if (!maps.length) {
    console.log('No maps found. Sign in to Google in the browser (first run only), or create a map at https://www.google.com/maps/d/');
    await ask('Press Enter to close the browser…');
    await context.close();
    process.exit(1);
  }

  console.log('\nYour maps:\n');
  maps.forEach((m, i) => console.log(`  ${i + 1}. ${m.title || '(no title)'} [mid=${m.mid}]`));
  const choice = await ask('\nWhich map number do you want to add this layer to? ');
  const idx = parseInt(choice, 10);
  if (Number.isNaN(idx) || idx < 1 || idx > maps.length) {
    console.error('Invalid number.');
    await context.close();
    process.exit(1);
  }

  const chosen = maps[idx - 1];
  const editUrl = `https://www.google.com/maps/d/edit?mid=${chosen.mid}`;
  console.log('\nOpening map and adding a new layer…');
  await page.goto(editUrl, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(400);

  // "Add layer" in the legend (left panel)
  const addLayer = page.getByText('Add layer', { exact: true }).first();
  await addLayer.click({ timeout: 15000 }).catch(async () => {
    await page.getByRole('button', { name: /add layer/i }).first().click({ timeout: 5000 });
  });
  await page.waitForTimeout(400);

  // "Import" under the new layer — opens "Choose a file to import" modal
  const importBtn = page.getByText('Import', { exact: true }).first();
  await importBtn.click({ timeout: 10000 }).catch(() => page.getByRole('button', { name: /import/i }).first().click({ timeout: 5000 }));
  await page.waitForTimeout(400);
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

  // Confirm in the import dialog: "Select" or "Import"
  const selectBtn = page.getByRole('button', { name: /select|import/i }).first();
  await selectBtn.click({ timeout: 10000 }).catch(() => null);
  await page.waitForTimeout(500);

  // If KML triggers a column-mapping step, click "Finish" or "Select"
  const finishBtn = page.getByRole('button', { name: /finish|select|done/i }).first();
  await finishBtn.click({ timeout: 5000 }).catch(() => null);

  await page.waitForTimeout(400);
  console.log('\nDone. The KML should be imported as a new layer. Check the browser.');
  await ask('Press Enter to close the browser…');
  await context.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
