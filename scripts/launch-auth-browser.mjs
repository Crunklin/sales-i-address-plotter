#!/usr/bin/env node
/**
 * Launch a visible browser window for Google re-authentication.
 * This browser stays open until the user closes it or the session is restored.
 * Usage: node scripts/launch-auth-browser.mjs
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import { fileURLToPath } from 'url';

chromium.use(StealthPlugin());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const userDataDir = process.env.BROWSER_USER_DATA_DIR || path.join(projectRoot, 'playwright-my-maps-profile');

async function main() {
  console.log('[auth-browser] Launching authentication browser...');
  
  // Always launch visible (headless: false) for auth
  const launchOpts = {
    headless: false,
    locale: 'en-US',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--start-maximized',
    ],
    viewport: { width: 1200, height: 800 },
  };

  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      ...launchOpts,
      channel: 'chrome',
    });
  } catch (e) {
    context = await chromium.launchPersistentContext(userDataDir, launchOpts);
  }

  let page = context.pages()[0];
  if (!page) page = await context.newPage();
  
  await page.setViewportSize({ width: 1200, height: 800 });
  
  // Navigate to Google My Maps (will redirect to login if needed)
  await page.goto('https://www.google.com/maps/d/', { waitUntil: 'load', timeout: 60000 });
  
  console.log('[auth-browser] Browser launched. Waiting for user to complete authentication...');
  console.log('[auth-browser] The browser will stay open. Close it manually when done.');
  
  // Check periodically if user has authenticated
  const checkInterval = 5000; // 5 seconds
  const maxWait = 10 * 60 * 1000; // 10 minutes
  let elapsed = 0;
  
  while (elapsed < maxWait) {
    await page.waitForTimeout(checkInterval);
    elapsed += checkInterval;
    
    const url = page.url();
    const content = await page.content();
    
    // Check if we're now on the My Maps page (authenticated)
    if (
      url.includes('/maps/d/') &&
      !url.includes('accounts.google.com') &&
      !url.includes('/signin') &&
      !content.includes('Verify it') &&
      !content.includes('Sign in') &&
      (content.includes('Create a new map') || content.includes('My Maps'))
    ) {
      console.log('[auth-browser] Authentication successful! You can now close this browser.');
      console.log('[auth-browser] Return to the app and try your operation again.');
      
      // Wait a bit more so user sees the message, then exit
      await page.waitForTimeout(3000);
      await context.close();
      process.exit(0);
    }
    
    // Log progress every 30 seconds
    if (elapsed % 30000 === 0) {
      console.log(`[auth-browser] Still waiting for authentication... (${elapsed / 1000}s)`);
    }
  }
  
  console.log('[auth-browser] Timeout waiting for authentication. Closing browser.');
  await context.close();
  process.exit(1);
}

main().catch((err) => {
  console.error('[auth-browser] Error:', err.message);
  process.exit(1);
});
