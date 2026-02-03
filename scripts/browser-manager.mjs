/**
 * Shared browser manager for persistent sessions and stealth mode.
 * Keeps browser open between operations to avoid repeated logins.
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import { fileURLToPath } from 'url';

// Add stealth plugin to avoid detection
chromium.use(StealthPlugin());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const defaultUserDataDir = process.env.BROWSER_USER_DATA_DIR || path.join(projectRoot, 'playwright-my-maps-profile');
const LAUNCH_RETRIES = parseInt(process.env.BROWSER_LAUNCH_RETRIES || '5', 10);
const LAUNCH_RETRY_DELAY_MS = parseInt(process.env.BROWSER_LAUNCH_RETRY_DELAY_MS || '1500', 10);

let browserContext = null;
let lastActivity = Date.now();
const SESSION_TIMEOUT = 10 * 60 * 1000; // 10 minutes of inactivity before closing

// Human-like random delay
export function humanDelay(min = 500, max = 1500) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, delay));
}

function isProcessSingletonError(err) {
  const msg = String(err?.message || err || '');
  return (
    msg.includes('ProcessSingleton') ||
    msg.includes('profile directory is already in use') ||
    msg.includes('user data directory is already in use')
  );
}

async function launchPersistentContextWithFallback(userDataDir, launchOpts) {
  try {
    return await chromium.launchPersistentContext(userDataDir, {
      ...launchOpts,
      channel: 'chrome',
    });
  } catch (_) {
    return await chromium.launchPersistentContext(userDataDir, launchOpts);
  }
}

// Longer delay for significant actions
export function thinkDelay() {
  return humanDelay(1000, 3000);
}

// Short delay between rapid clicks
export function clickDelay() {
  return humanDelay(200, 600);
}

/**
 * Get or create a persistent browser context.
 * Reuses existing session if available.
 */
export async function getBrowser(userDataDir = defaultUserDataDir) {
  lastActivity = Date.now();
  
  // If we have an existing context, try to reuse it
  if (browserContext) {
    try {
      // Test if context is still valid
      const pages = browserContext.pages();
      return browserContext;
    } catch (e) {
      // Context is dead, create new one
      browserContext = null;
    }
  }

  const headless = !process.env.DISPLAY;
  
  const launchOpts = {
    headless,
    acceptDownloads: true,
    locale: 'en-US',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,900',
    ],
    viewport: { width: 1280, height: 900 },
  };

  // Try with Chrome channel first, fall back to bundled Chromium (with retry on profile lock)
  const maxAttempts = Number.isFinite(LAUNCH_RETRIES) ? Math.max(0, LAUNCH_RETRIES) + 1 : 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      browserContext = await launchPersistentContextWithFallback(userDataDir, launchOpts);
      return browserContext;
    } catch (e) {
      if (isProcessSingletonError(e) && attempt < maxAttempts) {
        process.stderr.write(`[browser] Profile locked, retrying (${attempt}/${maxAttempts - 1})...\n`);
        await new Promise((r) => setTimeout(r, LAUNCH_RETRY_DELAY_MS));
        continue;
      }
      throw e;
    }
  }

  return browserContext;
}

/**
 * Get a page from the browser context.
 * Reuses existing page if available.
 */
export async function getPage(userDataDir = defaultUserDataDir) {
  const context = await getBrowser(userDataDir);
  let page = context.pages()[0];
  if (!page) {
    page = await context.newPage();
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  return page;
}

/**
 * Update last activity timestamp.
 * Call this during long operations to prevent timeout.
 */
export function keepAlive() {
  lastActivity = Date.now();
}

/**
 * Close the browser context.
 * Only call this when completely done or on error.
 */
export async function closeBrowser() {
  if (browserContext) {
    try {
      await browserContext.close();
    } catch (e) {
      // Ignore errors on close
    }
    browserContext = null;
  }
}

/**
 * Check if Google session is valid (not on sign-in page).
 */
export async function checkGoogleSession(page) {
  const currentUrl = page.url();

  // Strong signal: Google auth URLs
  if (/(accounts\.google\.com|\/signin|\/ServiceLogin|\/challenge|\/CheckCookie|\/accountchooser)/i.test(currentUrl)) {
    return false;
  }

  // Strong signal: login form fields
  const loginFields = page.locator(
    'input[type="email"], input[type="password"], #identifierId, input[name="identifier"], input[name="Passwd"]'
  );
  if (await loginFields.count() > 0) {
    return false;
  }

  // Weaker signal: sign-in links, only if we can't see My Maps UI
  const signInLink = page.locator('a[href*="accounts.google.com"], a[href*="ServiceLogin"], a[href*="/signin"]');
  const hasSignInLink = (await signInLink.count()) > 0;

  const hasCreateMap = (await page.getByText(/create a new map/i).count()) > 0;
  const hasAddLayer = (await page.getByText(/add layer/i).count()) > 0;
  const hasMapTitle = (await page.locator('[aria-label*="map title" i], [aria-label*="map name" i]').count()) > 0;
  const hasMyMapsUi = hasCreateMap || hasAddLayer || hasMapTitle;

  if (hasSignInLink && !hasMyMapsUi) {
    return false;
  }

  return true;
}

/**
 * Human-like mouse movement before clicking.
 */
export async function humanClick(page, selector, options = {}) {
  const element = typeof selector === 'string' 
    ? page.locator(selector).first()
    : selector;
  
  await clickDelay();
  
  try {
    await element.click({ timeout: options.timeout || 5000 });
  } catch (e) {
    throw e;
  }
}

/**
 * Human-like typing with variable speed.
 */
export async function humanType(page, text) {
  for (const char of text) {
    await page.keyboard.type(char, { delay: Math.random() * 100 + 30 });
  }
}

export default {
  getBrowser,
  getPage,
  closeBrowser,
  checkGoogleSession,
  humanDelay,
  thinkDelay,
  clickDelay,
  humanClick,
  humanType,
  keepAlive,
};
