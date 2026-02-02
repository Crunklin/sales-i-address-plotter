#!/usr/bin/env node
/**
 * Opens a browser on the VPS (via Xvfb) for Google login.
 * Run this on the VPS while connected via VNC or X11 forwarding.
 * Usage: DISPLAY=:99 node scripts/vps-google-login.mjs
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const userDataDir = process.env.BROWSER_USER_DATA_DIR || path.join(projectRoot, 'browser-profile');

async function main() {
  console.log('\n=== VPS Google Login ===\n');
  console.log('Browser profile:', userDataDir);
  console.log('Display:', process.env.DISPLAY || '(not set - will be headless)');
  console.log('\nOpening browser to Google sign-in...');
  console.log('Log in with your shared Google account, then close the browser.\n');

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,  // Must be visible
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  let page = context.pages()[0];
  if (!page) page = await context.newPage();
  
  await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded' });

  console.log('Browser opened. Sign in to Google, then close the browser window.');
  console.log('(If you cannot see the browser, you need VNC - see instructions below)\n');
  
  await context.waitForEvent('close');

  console.log('\nBrowser closed. Profile saved to:', userDataDir);
  console.log('Now restart the app: sudo systemctl restart address-plotter\n');
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
