#!/usr/bin/env node
/**
 * Creates a local browser profile for Google login.
 * Log into Google, then close the browser when done.
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import { fileURLToPath } from 'url';

// Apply stealth plugin
chromium.use(StealthPlugin());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const profileDir = path.join(__dirname, '..', 'new-google-profile');

console.log('Opening browser...');
console.log(`Profile will be saved to: ${profileDir}`);
console.log('');
console.log('1. Log into your Google account');
console.log('2. Close the browser when done');
console.log('');

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  channel: 'chrome',
  args: [
    '--start-maximized',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
  ],
  viewport: null,
  ignoreDefaultArgs: ['--enable-automation'],
});

const page = context.pages()[0] || await context.newPage();

// Remove webdriver property
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});

await page.goto('https://accounts.google.com');

// Wait for the browser to be closed by the user
await new Promise((resolve) => {
  context.on('close', resolve);
});

console.log('');
console.log('Profile saved! You can now upload it to the VPS.');
