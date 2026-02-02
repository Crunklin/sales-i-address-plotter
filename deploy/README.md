# Deploy Address Plotter to DigitalOcean (or any Ubuntu VPS)

This deploys the app so coworkers can use it in the browser with **one-click "Add to Google My Maps"**. The server runs a shared Google account’s browser (via Playwright + Xvfb); all imports go to that account’s maps, which you then share with the team.

## Quick start: setup wizard (automated)

From your project root:

```bash
npm run setup-wizard
```

The wizard prompts only for what it needs, then **SSHs into the server and finishes setup automatically**:

1. **Optional:** Create a DigitalOcean droplet (paste API token, choose region/size) or enter an existing server IP.
2. **App config:** Shared secret (login password for the app), optional Google Geocoding API key, port.
3. **SSH:** SSH user (default `root`), then either path to private key or SSH password (e.g. root password from DigitalOcean email if you just created the droplet).
4. **Automated:** Waits for SSH if the droplet was just created, uploads the app via SFTP, writes `.env`, and runs `deploy/setup-vps.sh` on the server (installs Node, Xvfb, Chromium, systemd).

When it finishes, the only remaining step is the **one-time Google profile**: run `npm run export-google-profile` on your PC, log in with the shared Google account, then upload that profile to the server (instructions printed at the end).

---

## Manual steps (if you skip the wizard)

### 1. Create a droplet (DigitalOcean)

- **Image:** Ubuntu 22.04 LTS  
- **Size:** 2 GB RAM recommended (s-1vcpu-2gb) for Chromium  
- **Region:** Any  

Or use the wizard with a DO API token to create it automatically.

### 2. Copy the app to the server

From your machine (PowerShell, from project root):

```powershell
scp -r . root@YOUR_SERVER_IP:/opt/address-plotter
```

Or with rsync (if available):

```bash
rsync -avz --exclude node_modules --exclude .git . root@YOUR_SERVER_IP:/opt/address-plotter/
```

### 3. Configure environment on the server

SSH in and create `.env`:

```bash
ssh root@YOUR_SERVER_IP
cd /opt/address-plotter
cp deploy/env.production .env
# Edit .env and set at least:
#   SHARED_SECRET=your-secret
#   (optional) GOOGLE_GEOCODING_API_KEY=...
```

### 4. Run the VPS setup script

On the server:

```bash
cd /opt/address-plotter
chmod +x deploy/setup-vps.sh
./deploy/setup-vps.sh
```

This installs Node 20, Xvfb, Playwright Chromium, system deps, and creates two systemd services:

- `address-plotter-xvfb` — virtual display (`:99`)
- `address-plotter` — the app (runs with `DISPLAY=:99` and `BROWSER_USER_DATA_DIR=browser-profile/`)

### 5. One-time: add the shared Google account (My Maps)

The server needs a browser profile where the **shared** Google account is already logged in.

**On your PC:**

```bash
npm run export-google-profile
```

A browser opens. Log in with the **shared** Google account (the one you’ll use for My Maps on the server). Close the browser when done.

**Upload the profile to the server:**

1. Zip the folder `playwright-my-maps-profile` (e.g. right-click → Compress, or `zip -r playwright-my-maps-profile.zip playwright-my-maps-profile`).
2. Upload and extract on the server so `browser-profile/` contains the profile files (e.g. `Default`, etc.):

```bash
scp playwright-my-maps-profile.zip root@YOUR_SERVER_IP:/tmp/
ssh root@YOUR_SERVER_IP
cd /opt/address-plotter
mkdir -p browser-profile
unzip -o /tmp/playwright-my-maps-profile.zip
# If the zip has a top-level folder, move contents:
mv playwright-my-maps-profile/* browser-profile/
systemctl restart address-plotter
```

### 6. Open the app

- **URL:** `http://YOUR_SERVER_IP:3000`  
- Users enter the **SHARED_SECRET** to sign in, then use the app and “Add to Google My Maps” as usual.  
- Imports go to the **shared** account’s maps; share those maps (or the account) with coworkers.

---

## Optional: domain and HTTPS

- Point a domain A record to the droplet IP.  
- Install nginx and Certbot, proxy `https://yourdomain.com` to `http://127.0.0.1:3000`, and use Let’s Encrypt for SSL.

---

## Troubleshooting

- **“Failed to list maps” / “Import failed”**  
  - Ensure the Google profile is in `browser-profile/` and the shared account is logged in.  
  - Check logs: `journalctl -u address-plotter -f`.

- **Browser / Chromium errors on server**  
  - Ensure Xvfb is running: `systemctl status address-plotter-xvfb`.  
  - The setup script installs Playwright’s Chromium and required libs; if something is missing, install the [Playwright Ubuntu deps](https://playwright.dev/docs/intro#installing-system-dependencies) for your image.

- **App not listening**  
  - Check `systemctl status address-plotter` and `journalctl -u address-plotter -n 50`.

---

## When GitHub Actions is unavailable

If Actions are queued, failing to get a runner, or hitting internal errors, deploy from your PC instead. From the project root:

```bash
npm run deploy-from-local
```

This runs the same steps as the workflow: SSH to the VPS → `git fetch` / `git reset` → `npm install` → restart the app.

**Setup once:** Create a `.env.deploy` in the project root (or set env vars) with:

- `DEPLOY_HOST` — VPS IP or hostname  
- `DEPLOY_USER` — SSH user (e.g. `root`)  
- `DEPLOY_SSH_KEY_PATH` — path to your private key (e.g. `deploy/wizard-ssh-key`), **or**  
- `DEPLOY_SSH_KEY` — the private key content (multiline OK in `.env.deploy`)

Example `.env.deploy`:

```
DEPLOY_HOST=your.vps.ip
DEPLOY_USER=root
DEPLOY_SSH_KEY_PATH=deploy/wizard-ssh-key
```

Keep `.env.deploy` out of the repo (add it to `.gitignore` if you like).
