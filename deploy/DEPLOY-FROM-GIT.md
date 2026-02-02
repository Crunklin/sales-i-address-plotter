# Auto-deploy from GitHub (one-time setup)

**Repo:** https://github.com/Crunklin/sales-i-address-plotter (private)

**GitHub secrets** (`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`) are already set. After the one-time VPS step below, every push to `main` will deploy automatically.

---

## 1. One-time: Make the VPS use Git

SSH into the VPS (use your wizard key or password):

```bash
ssh -i deploy/wizard-ssh-key root@167.172.146.216
```

Then run (repo is **Crunklin/sales-i-address-plotter**; use your GitHub token if the repo is private):

```bash
cd /opt/address-plotter

# Backup .env and browser profile (they are not in the repo)
cp .env /tmp/address-plotter-env.bak
cp -r browser-profile /tmp/address-plotter-browser-profile.bak 2>/dev/null || true

# Replace app with a clone of your repo (use your actual repo URL)
sudo rm -rf /opt/address-plotter
sudo git clone https://github.com/YOUR_GITHUB_USER/YOUR_REPO.git /opt/address-plotter
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
