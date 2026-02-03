/**
 * Shared browser manager for persistent sessions and stealth mode.
 * Keeps browser open between operations to avoid repeated logins.
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

// Add stealth plugin to avoid detection
chromium.use(StealthPlugin());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const defaultUserDataDir = process.env.BROWSER_USER_DATA_DIR || path.join(projectRoot, 'playwright-my-maps-profile');
const LAUNCH_RETRIES = parseInt(process.env.BROWSER_LAUNCH_RETRIES || '3', 10);
const LAUNCH_RETRY_DELAY_MS = parseInt(process.env.BROWSER_LAUNCH_RETRY_DELAY_MS || '1000', 10);

/**
 * Kill any zombie chromium/chrome processes and remove profile lock files.
 * This ensures a clean slate before launching.
 */
function cleanupBrowserProcesses(userDataDir) {
  // Remove singleton lock files
  const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  for (const lockFile of lockFiles) {
    const lockPath = path.join(userDataDir, lockFile);
    try {
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
        process.stderr.write(`[browser] Removed stale lock: ${lockFile}\n`);
      }
    } catch (e) {
      // Ignore - file might be in use
    }
  }

  // On Linux/VPS, kill any orphaned chromium processes
  if (process.platform !== 'win32') {
    try {
      // Kill chromium processes that might be holding the profile
      execSync('pkill -9 -f "chromium.*playwright-my-maps-profile" 2>/dev/null || true', { stdio: 'ignore' });
      execSync('pkill -9 -f "chrome.*playwright-my-maps-profile" 2>/dev/null || true', { stdio: 'ignore' });
    } catch (_) {
      // Ignore errors - processes might not exist
    }
  }
}

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
      // Prevent session restore prompts
      '--disable-session-crashed-bubble',
      '--disable-infobars',
      '--hide-crash-restore-bubble',
      // Don't restore previous session
      '--no-first-run',
      '--no-default-browser-check',
    ],
    viewport: { width: 1280, height: 900 },
    // Ignore HTTPS errors that might cause issues
    ignoreHTTPSErrors: true,
  };

  // Clean up any zombie processes before first attempt
  cleanupBrowserProcesses(userDataDir);

  // Try with Chrome channel first, fall back to bundled Chromium (with retry on profile lock)
  const maxAttempts = Math.max(1, LAUNCH_RETRIES + 1);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      browserContext = await launchPersistentContextWithFallback(userDataDir, launchOpts);
      return browserContext;
    } catch (e) {
      if (isProcessSingletonError(e) && attempt < maxAttempts) {
        process.stderr.write(`[browser] Profile locked, cleaning up and retrying (${attempt}/${maxAttempts})...\n`);
        // More aggressive cleanup on retry
        cleanupBrowserProcesses(userDataDir);
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
 * Close the browser context gracefully.
 * This ensures all pages are closed before closing the context.
 */
export async function closeBrowser() {
  if (browserContext) {
    try {
      // Close all pages first to ensure clean shutdown
      const pages = browserContext.pages();
      for (const page of pages) {
        try {
          await page.close();
        } catch (_) {}
      }
      // Small delay to let pages close
      await new Promise(r => setTimeout(r, 500));
      // Now close the context
      await browserContext.close();
    } catch (e) {
      process.stderr.write(`[browser] Error closing browser: ${e.message}\n`);
    }
    browserContext = null;
  }
  // Also cleanup any orphaned processes
  cleanupBrowserProcesses(defaultUserDataDir);
}

/**
 * Force cleanup - kill processes and remove locks.
 * Call this when things go wrong.
 */
export function forceCleanup(userDataDir = defaultUserDataDir) {
  browserContext = null;
  cleanupBrowserProcesses(userDataDir);
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
  forceCleanup,
  checkGoogleSession,
  humanDelay,
  thinkDelay,
  clickDelay,
  humanClick,
  humanType,
  keepAlive,
};
