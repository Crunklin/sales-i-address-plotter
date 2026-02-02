# Address Plotter

Upload a CSV, clean address fields (remove names, PO Box, Attn/department, phone bits), geocode to lat/lng, view on a map, and export **KML** (for Google My Maps) or **CSV** (with lat/lng).

Built for CSVs like your customer/account sheets: columns **Address1**, **Address2**, **Address3**, **Address4**, **Town**, **County**, **Postcode**. Other column names can be configured.

## Quick start

```bash
npm install
npm start
```

Open **http://localhost:3000**, choose a CSV, click **Process CSV (clean & geocode)**.

**Geocoding:** By default the app uses **OpenStreetMap Nominatim** (~1 request/second; 90–140 rows ≈ 2–3 minutes). For faster runs, set **Google Geocoding API**: copy `.env.example` to `.env` and add `GOOGLE_GEOCODING_API_KEY=your_key`. Google allows higher throughput and the first 10,000 requests/month are free; see [Google Maps Platform pricing](https://developers.google.com/maps/documentation/geocoding/usage-and-billing).

## What gets cleaned

- **PO Box** – `P.O. Box 123`, `PO BOX 640`, `P O BOX 389`, `Post Office Box` (removed from the line; Town + Postcode still used for geocoding)
- **Attn / department** – `Attn: Purchasing Dept`, `ATTN. ACCOUNTS PAYABLE`, `Att: Shawn Hoover`
- **c/o** – `c/o John Smith`
- **Phone-like** – trailing patterns like `522-6004`, `(517) 555-1234`
- **Ref numbers** – `V# 784355`-style tokens
- **Leading “Attn” line** – e.g. `ATTN. ACCOUNTS PAYABLE 18620 16 MILE RD` → keeps `18620 16 MILE RD`

Address is built by joining **Address1, Address2, Address3, Address4, Town, County, Postcode** (empty parts skipped), then cleaned. State defaults to **MI**; you can change it in the API if needed.

## Google My Maps

**Manual:** Export **KML** from the app, then in [Google My Maps](https://www.google.com/maps/d/) create a map → **Add layer** → **Import** → upload the KML file.

**Automated (pick map, add layer, import):**

1. In the app, after geocoding, click **Add to Google My Maps (automated)**. The KML is saved in the project folder.
2. In the project folder run: `npm run add-to-mymaps` (or `node scripts/add-to-mymaps.mjs [path/to/file.kml]`).
3. A browser opens using a **saved profile** (`playwright-my-maps-profile/`). **Sign in to Google only on the first run**; later runs reuse your session.
4. The script lists your My Maps; enter the number of the map you want. It adds a new layer and imports the KML. When it’s done, press Enter in the terminal to close the browser.

Requires **Playwright** and **Chrome** (install with `npm install`; first run may install browsers). The script prefers your installed **Google Chrome** (`channel: 'chrome'`); if Chrome isn’t found, it falls back to Playwright’s Chromium. Google does not provide an API for My Maps, so this uses browser automation; if the My Maps UI changes, the script may need small selector updates.

**If Google shows “Couldn’t sign you in” / “This browser or app may not be secure”:**  
1. Install [Google Chrome](https://www.google.com/chrome/) if you haven’t, so the script uses Chrome instead of Chromium.  
2. Try “Try again” once or twice.  
3. If it still blocks: export the KML from the app, then in your normal browser go to [Google My Maps](https://www.google.com/maps/d/), create or open a map → **Add layer** → **Import** and upload the KML file manually.

## Deploy to DigitalOcean (or any Ubuntu VPS)

To let coworkers use the app in the browser **with one-click "Add to Google My Maps"**, deploy to a VPS (e.g. DigitalOcean) and use a **shared Google account** for My Maps. The server runs Chromium (Playwright + Xvfb) with that account’s profile; imports go to that account’s maps, which you share with the team.

**Setup wizard (recommended):**

```bash
npm run setup-wizard
```

The wizard prompts for: DigitalOcean API token (optional, to create a droplet) or server IP, **SHARED_SECRET**, optional Google Geocoding key, and SSH auth (key or password). It then **SSHs into the server**, uploads the app, writes `.env`, and runs the VPS setup script. When it finishes, the only remaining step is the one-time Google profile upload (see `npm run export-google-profile` and the printed instructions).

Full steps and troubleshooting: **[deploy/README.md](deploy/README.md)**.

## Tech

- **Backend:** Node (Express), CSV parse. Geocoding: Nominatim (1 req/sec) or Google Geocoding API when `GOOGLE_GEOCODING_API_KEY` is set in `.env`.
- **Frontend:** Vanilla JS, Leaflet map.
- **Export:** KML (placemarks with name + description) and CSV (all columns + lat/lng).
- **My Maps automation:** Playwright script (`scripts/add-to-mymaps.mjs`) to open My Maps, list maps, and import KML into a new layer.
