# Auto-deploy from GitHub (one-time setup)

**Repo:** https://github.com/Crunklin/sales-i-address-plotter (private)

---

## 0. Quick setup: run the wizard

From your project root, run:

```bash
npm run setup-github-actions
```

This prompts for your VPS IP, SSH user, and key path, then sets the GitHub secrets automatically using the GitHub CLI (`gh`). Skip to step 1 below after it completes.

---

**GitHub secrets** (`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`) are already set. After the one-time VPS step below, every push to `main` will deploy automatically.

---

## 1. One-time: Make the VPS use Git

SSH into the VPS (use your wizard key or password):

```bash
ssh -i deploy/wizard-ssh-key root@YOUR_VPS_IP
```

Then run (repo is **Crunklin/sales-i-address-plotter**; private — use a [Personal Access Token](https://github.com/settings/tokens) in the URL, or set up a deploy key):

```bash
cd /opt/address-plotter

# Backup .env and browser profile (they are not in the repo)
cp .env /tmp/address-plotter-env.bak
cp -r browser-profile /tmp/address-plotter-browser-profile.bak 2>/dev/null || true

# Leave the directory before removing it (otherwise the shell breaks)
cd /

# Remove old app and clone from GitHub (use YOUR_TOKEN if repo is private)
sudo rm -rf /opt/address-plotter
sudo git clone https://github.com/Crunklin/sales-i-address-plotter.git /opt/address-plotter
# If private, use: sudo git clone https://YOUR_TOKEN@github.com/Crunklin/sales-i-address-plotter.git /opt/address-plotter

sudo chown -R root:root /opt/address-plotter

# Restore .env and browser profile
sudo cp /tmp/address-plotter-env.bak /opt/address-plotter/.env
sudo cp -r /tmp/address-plotter-browser-profile.bak /opt/address-plotter/browser-profile 2>/dev/null || true

# Install deps and restart
cd /opt/address-plotter
sudo npm install
sudo npx playwright install chromium
sudo systemctl restart address-plotter
```

---

## 2. GitHub secrets (already set)

`DEPLOY_HOST`, `DEPLOY_USER`, and `DEPLOY_SSH_KEY` are already configured in the repo. Every **push to `main`** will trigger a deploy: the workflow SSHs to the VPS, runs `git fetch` / `git reset`, `npm install`, and restarts the app.

---

## 3. If Actions are down: deploy from your PC

When GitHub Actions is queued or failing, run from the project root:

```bash
npm run deploy-from-local
```

Uses the same deploy steps as the workflow. Set `DEPLOY_HOST`, `DEPLOY_USER`, and `DEPLOY_SSH_KEY_PATH` (or `DEPLOY_SSH_KEY`) in `.env.deploy` or your environment. See **deploy/README.md** → “When GitHub Actions is unavailable”.
