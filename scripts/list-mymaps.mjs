#!/usr/bin/env node
/**
 * Output your Google My Maps list as JSON to stdout (one line).
 * Used by the app so you can pick a map in the UI. Uses same profile as add-to-mymaps.
 * Usage: node scripts/list-mymaps.mjs
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const userDataDir = process.env.BROWSER_USER_DATA_DIR || path.join(projectRoot, 'playwright-my-maps-profile');
// On VPS with Xvfb we set DISPLAY=:99 and run non-headless; otherwise headless for automation-only envs
const headless = !process.env.DISPLAY;
const isVps = !!process.env.DISPLAY; // VPS runs with Xvfb

async function main() {
  const launchOpts = {
    headless,
    locale: 'en-US',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-extensions',
      '--no-first-run',
    ],
    timeout: isVps ? 60000 : 30000,
  };
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...launchOpts,
    channel: 'chrome',
  }).catch(() => chromium.launchPersistentContext(userDataDir, launchOpts));

  let page = context.pages()[0];
  if (!page) page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });

  // Intercept network: My Maps page fetches the list via XHR/fetch; capture it
  const mapsFromNetwork = [];
  const seenMid = new Set();
  function addMap(mid, title) {
    if (!mid) return;
    const s = String(mid).trim();
    if (s.length > 80 && s.includes(',')) {
      parseMaplistCsvRow(s);
      return;
    }
    if (seenMid.has(s)) return;
    seenMid.add(s);
    mapsFromNetwork.push({
      mid: s,
      title: (title && String(title).trim()) || s,
      href: `https://www.google.com/maps/d/edit?mid=${encodeURIComponent(s)}`,
    });
  }
  function parseMaplistCsvRow(str) {
    if (!str || typeof str !== 'string' || str.length < 40 || !str.includes(',')) return;
    const parts = str.split(',');
    for (let i = 0; i < parts.length - 1; i++) {
      const id = parts[i].trim();
      const title = parts[i + 1].trim();
      if (/^[a-zA-Z0-9_-]{20,45}$/.test(id) && title && !/^\d+$/.test(title) && !/^https?:\/\//.test(title) && title.length < 200) {
        if (seenMid.has(id)) continue;
        seenMid.add(id);
        mapsFromNetwork.push({
          mid: id,
          title,
          href: `https://www.google.com/maps/d/edit?mid=${encodeURIComponent(id)}`,
        });
      }
    }
  }
  function extractMapsFromJson(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach((item) => {
        if (item && typeof item === 'object') {
          const mid = item.mid ?? item.mapId ?? item.id ?? item.metadata?.id ?? item.docId ?? item.responseContext?.mid;
          const title = item.title ?? item.name ?? item.label ?? item.metadata?.title ?? item.snippet ?? item.header?.title;
          if (mid) addMap(mid, title);
          extractMapsFromJson(item);
        }
      });
      return;
    }
    const mid = obj.mid ?? obj.mapId ?? obj.id ?? obj.metadata?.id ?? obj.docId;
    const title = obj.title ?? obj.name ?? obj.label ?? obj.metadata?.title ?? obj.snippet;
    if (mid) addMap(mid, title);
    // Common wrapper keys for list responses
    ['maps', 'items', 'entries', 'list', 'data', 'result', 'response', 'payload'].forEach((key) => {
      if (obj[key]) extractMapsFromJson(obj[key]);
    });
    Object.values(obj).forEach(extractMapsFromJson);
  }

  // Dedicated parser for https://www.google.com/maps/d/maplist response (actual map list API)
  function extractFromMaplistBody(body) {
    const before = mapsFromNetwork.length;
    try {
      let json = body.trim();
      if (json.startsWith(")]}'\n")) json = json.slice(5);
      if (json.startsWith(")]}'\r\n")) json = json.slice(6);
      const data = JSON.parse(json);
      const walk = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
          obj.forEach((item) => {
            if (Array.isArray(item) && item.length >= 1) {
              const first = item[0];
              if (typeof first === 'string' && first.length > 80 && first.includes(',')) {
                parseMaplistCsvRow(first);
                return;
              }
              addMap(String(item[0]).trim(), item[1] != null ? String(item[1]).trim() : null);
              return;
            }
            if (item && typeof item === 'object') {
              const mid = item.mid ?? item.id ?? item[0] ?? item.mapId ?? item.docId ?? item.map_id;
              const title = item.title ?? item.name ?? item[1] ?? item[2] ?? item.label ?? item.snippet;
              if (mid != null) {
                if (typeof mid === 'string' && mid.length > 80 && mid.includes(',')) parseMaplistCsvRow(mid);
                else addMap(String(mid).trim(), title != null ? String(title).trim() : null);
              }
              walk(item);
            }
          });
          return;
        }
        Object.values(obj).forEach(walk);
      };
      walk(data);
      // Regex: any "mid":"XXX" or "id":"XXX" in raw body
      const idRe = /(?:mid|id|map_id|docId)["\s]*[:=]["\s]*["']([a-zA-Z0-9_.-]{15,50})["']/g;
      let m;
      while ((m = idRe.exec(body)) !== null) addMap(m[1], null);
      if (mapsFromNetwork.length > before) return;
      const quotedIdRe = /["']([a-zA-Z0-9_-]{18,25})["']/g;
      const candidates = new Set();
      while ((m = quotedIdRe.exec(body)) !== null) {
        const s = m[1];
        if (/^[a-zA-Z0-9_-]+$/.test(s) && !/^\d+$/.test(s)) candidates.add(s);
      }
      candidates.forEach((id) => addMap(id, null));
    } catch (_) {}
  }

  const urlsTried = [];
  page.on('response', async (response) => {
    try {
      const url = response.url();
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const body = await response.text();
      if (!body || body.length > 5_000_000) return;
      urlsTried.push(url.slice(0, 120));
      if (url.includes('maplist')) extractFromMaplistBody(body);
      try {
        const data = JSON.parse(body);
        extractMapsFromJson(data);
      } catch (_) {}
      const midRe = /["']?mid["']?\s*[:=]\s*["']([a-zA-Z0-9_.-]{10,80})["']/g;
      let m;
      while ((m = midRe.exec(body)) !== null) addMap(m[1], null);
    } catch (_) {}
  });

  // Capture from inside page: hook fetch and XHR so we see responses the page consumes
  await page.addInitScript(() => {
    window.__listMymapsCaptured = [];
    function tryCollect(text) {
      try {
        if (!text || text.length > 5000000) return;
        const data = JSON.parse(text);
        const collect = (obj) => {
          if (!obj || typeof obj !== 'object') return;
          if (Array.isArray(obj)) {
            obj.forEach((item) => {
              if (item && typeof item === 'object') {
                const mid = item.mid ?? item.mapId ?? item.id ?? item.docId;
                const title = item.title ?? item.name ?? item.label ?? item.snippet;
                if (mid && typeof mid === 'string') window.__listMymapsCaptured.push({ mid, title: title || mid });
                collect(item);
              }
            });
            return;
          }
          const mid = obj.mid ?? obj.mapId ?? obj.id ?? obj.docId;
          const title = obj.title ?? obj.name ?? obj.label;
          if (mid && typeof mid === 'string') window.__listMymapsCaptured.push({ mid, title: title || mid });
          ['maps', 'items', 'list', 'data', 'result', 'response', 'payload'].forEach((k) => obj[k] && collect(obj[k]));
          Object.values(obj).forEach(collect);
        };
        collect(data);
        const re = /["']?mid["']?\s*[:=]\s*["']([a-zA-Z0-9_.-]{10,80})["']/g;
        let match;
        while ((match = re.exec(text)) !== null) window.__listMymapsCaptured.push({ mid: match[1], title: match[1] });
      } catch (_) {}
    }
    const origFetch = window.fetch;
    window.fetch = function (...args) {
      return origFetch.apply(this, args).then((res) => {
        if (res.headers.get('content-type')?.includes('json')) res.clone().text().then(tryCollect).catch(() => {});
        return res;
      });
    };
    const OrigXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function () {
      const xhr = new OrigXHR();
      const origOpen = xhr.open;
      xhr.open = function (method, url) {
        xhr._url = url;
        return origOpen.apply(this, arguments);
      };
      xhr.addEventListener('load', function () {
        if (xhr.responseType === '' || xhr.responseType === 'text') {
          const ct = xhr.getResponseHeader('content-type') || '';
          if (ct.includes('json') && xhr.responseText) tryCollect(xhr.responseText);
        }
      });
      return xhr;
    };
  });

  await page.goto('https://www.google.com/maps/d/', { waitUntil: 'load', timeout: 30000 });
  // Maplist comes from XHR; poll briefly and exit as soon as we have maps
  const pollMs = 400;
  const pollMax = 8000;
  for (let elapsed = 0; elapsed < pollMax; elapsed += pollMs) {
    await page.waitForTimeout(pollMs);
    if (mapsFromNetwork.length > 0) break;
  }

  function exitWithMaps(mapsToSend) {
    const out = JSON.stringify(Array.isArray(mapsToSend) ? mapsToSend : []);
    process.stdout.write(out + '\n');
    context.close().catch(() => {}).finally(() => process.exit(0));
  }

  let maps = mapsFromNetwork.length > 0 ? [...mapsFromNetwork] : [];
  if (maps.length > 0) {
    exitWithMaps(maps);
    return;
  }

  let fromPage = [];
  try {
    fromPage = await page.evaluate(() => (window.__listMymapsCaptured || []).filter((x, i, a) => x.mid && a.findIndex((y) => y.mid === x.mid) === i));
  } catch (_) {}
  fromPage.forEach((x) => addMap(x.mid, x.title));
  if (mapsFromNetwork.length > 0) {
    exitWithMaps(mapsFromNetwork);
    return;
  }
  await page.goto('https://mymaps.google.com/', { waitUntil: 'domcontentloaded', timeout: navTimeout }).catch(() => null);
  await page.waitForTimeout(isVps ? 5000 : 3000);
  let fromPage2 = [];
  try {
    fromPage2 = await page.evaluate(() => (window.__listMymapsCaptured || []).filter((x, i, a) => x.mid && a.findIndex((y) => y.mid === x.mid) === i));
  } catch (_) {}
  fromPage2.forEach((x) => addMap(x.mid, x.title));
  if (mapsFromNetwork.length > 0) {
    exitWithMaps(mapsFromNetwork);
    return;
  }

  const frameExtract = async (frame) => {
    try {
      return await frame.evaluate(() => {
        function collectLinks(root) {
          const links = root.querySelectorAll ? root.querySelectorAll('a[href*="/maps/d/"]') : [];
          const out = Array.from(links);
          const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
          all.forEach((el) => {
            if (el.shadowRoot) out.push(...collectLinks(el.shadowRoot));
          });
          return out;
        }
        const links = collectLinks(document.body);
        const seen = new Set();
        return links
          .map((a) => {
            const href = (a.getAttribute('href') || '').trim();
            let mid = (href.match(/[?&]mid=([^&]+)/) || [])[1] || null;
            if (!mid && href.includes('/maps/d/')) {
              const pathMid = href.match(/\/maps\/d\/(?:edit|viewer)\/([^/?]+)/);
              if (pathMid) mid = pathMid[1];
            }
            if (!mid || seen.has(mid)) return null;
            seen.add(mid);
            const title = (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
            return { mid, title, href };
          })
          .filter(Boolean);
      });
    } catch (_) {
      return [];
    }
  };

  // Prefer maps captured from network (XHR/fetch); then fall back to DOM/iframe/HTML scrape
  maps = mapsFromNetwork.length > 0 ? mapsFromNetwork : await frameExtract(page);
  const frames = page.frames().filter((f) => f !== page.mainFrame());
  for (const frame of frames) {
    if (maps.length > 0) break;
    const inFrame = await frameExtract(frame);
    if (inFrame.length > 0) maps = inFrame;
  }
  // Also try frameLocator (can reach into iframe when frame.evaluate fails)
  if (maps.length === 0) {
    try {
      const iframeLinks = await page
        .frameLocator('iframe')
        .first()
        .locator('a[href*="/maps/d/"]')
        .evaluateAll((anchors) => {
          const seen = new Set();
          return anchors
            .map((a) => {
              const href = (a.getAttribute('href') || '').trim();
              const midMatch = href.match(/[?&]mid=([^&]+)/);
              const mid = midMatch ? midMatch[1] : null;
              if (!mid || seen.has(mid)) return null;
              seen.add(mid);
              const title = (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
              return { mid, title, href };
            })
            .filter(Boolean);
        });
      if (iframeLinks.length > 0) maps = iframeLinks;
    } catch (_) {}
  }
  if (maps.length === 0) {
    // Last resort: scan page HTML for mid= in URLs or embedded data (SPA often embeds IDs)
    const fromHtml = await page.evaluate(() => {
      const html = document.documentElement.innerHTML;
      const seen = new Set();
      const ids = [];
      const re = /[?&]mid=([a-zA-Z0-9_-]+)/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        const id = m[1];
        if (!seen.has(id)) {
          seen.add(id);
          ids.push({ mid: id, title: id, href: `https://www.google.com/maps/d/edit?mid=${id}` });
        }
      }
      return ids;
    });
    if (fromHtml.length > 0) maps = fromHtml;
    if (maps.length === 0) {
      process.stderr.write('[list-mymaps] No maps found. Frames: ' + (frames.length + 1) + '\n');
      if (urlsTried.length > 0) {
        process.stderr.write('[list-mymaps] JSON responses checked (' + urlsTried.length + '): ' + urlsTried.slice(0, 15).join(' | ') + '\n');
      }
    }
  }

  process.stdout.write(JSON.stringify(maps) + '\n');
  context.close().catch(() => {}).finally(() => process.exit(0));
}

main().catch((err) => {
  process.stderr.write(String(err) + '\n');
  process.stdout.write('[]\n');
  process.exit(1);
});
