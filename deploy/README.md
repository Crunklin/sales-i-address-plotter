# Deploy Address Plotter to DigitalOcean (or any Ubuntu VPS)

This deploys the app so coworkers can use it in the browser with **one-click "Add to Google My Maps"**. 

## Multi-User Mode (Recommended)

Each user gets their own isolated Google account profile. This prevents Google from flagging the account for suspicious activity.

### Configuration

Set the `APP_USERS` environment variable as a JSON array in `.env`:

```bash
APP_USERS='[{"id":"alice","name":"Alice Smith","pin":"1234"},{"id":"bob","name":"Bob Jones","pin":"5678"},{"id":"carol","name":"Carol Davis","pin":"9012"},{"id":"dave","name":"Dave Wilson","pin":"3456"}]'
```

Each user:
- Selects their name from a dropdown on the login page
- Enters their PIN to sign in
- Gets an isolated browser profile at `profiles/{userId}/`
- Uses their own Google account for My Maps

### First-time Setup Per User

1. User signs in with their PIN
2. First time they try to create/list maps, they'll see "Google Login Required"
3. They click OK to open noVNC and log into their Google account
4. From then on, their session is saved in their profile

### Create Profile Locally (Alternative)

You can also create a profile locally and upload it:

```bash
# On your PC - creates profile with stealth mode
node scripts/create-local-profile.mjs

# Upload to VPS
scp -r ./new-google-profile root@YOUR_SERVER_IP:/opt/address-plotter/profiles/USERNAME/
ssh root@YOUR_SERVER_IP "systemctl restart address-plotter"
```

---

## Legacy Single-User Mode

For backward compatibility, you can use a shared account with `SHARED_SECRET` instead of `APP_USERS`. The server runs a shared Google account's browser; all imports go to that account's maps.

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
# Edit .env and set:
#   For multi-user: APP_USERS='[{"id":"user1","name":"User One","pin":"1234"}]'
#   For legacy: SHARED_SECRET=your-secret
#   (optional) GOOGLE_GEOCODING_API_KEY=...
```

### 4. Run the VPS setup script

On the server:

```bash
cd /opt/address-plotter
chmod +x deploy/setup-vps.sh
./deploy/setup-vps.sh
```

This installs Node 20, Xvfb, Playwright Chromium, system deps, and creates systemd services:

- `address-plotter-xvfb` — virtual display (`:99`)
- `address-plotter` — the app (runs with `DISPLAY=:99`)
- `address-plotter-vnc` — x11vnc server for re-authentication
- `address-plotter-novnc` — noVNC web client (port 6080)

### 5. One-time: add Google accounts

**For multi-user mode:** Each user logs in via noVNC on first use. Their profile is created automatically.

**For legacy mode:** Run `npm run export-google-profile` on your PC, log in with the shared Google account, then upload that profile to the server.

### 6. Open the app

- **URL:** `http://YOUR_SERVER_IP:3000`  
- **noVNC:** `http://YOUR_SERVER_IP:6080/vnc.html` (for Google re-authentication)

---

## Optional: domain and HTTPS

- Point a domain A record to the droplet IP.  
- Install nginx and Certbot, proxy `https://yourdomain.com` to `http://127.0.0.1:3000`, and use Let's Encrypt for SSL.

---

## Troubleshooting

- **"Failed to list maps" / "Import failed"**  
  - For multi-user: user needs to log in via noVNC  
  - For legacy: ensure the Google profile is in place and the account is logged in  
  - Check logs: `journalctl -u address-plotter -f`

- **Browser / Chromium errors on server**  
  - Ensure Xvfb is running: `systemctl status address-plotter-xvfb`  
  - Ensure VNC is running: `systemctl status address-plotter-vnc address-plotter-novnc`

- **App not listening**  
  - Check `systemctl status address-plotter` and `journalctl -u address-plotter -n 50`

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
