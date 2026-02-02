# Auto-deploy from GitHub (one-time setup)

After this one-time setup, every push to `main` will deploy to the VPS automatically.

---

## 1. One-time: Make the VPS use Git

SSH into the VPS (use your wizard key or password):

```bash
ssh -i deploy/wizard-ssh-key root@YOUR_VPS_IP
```

Then run (replace `YOUR_GITHUB_USER` and `YOUR_REPO` with your repo, e.g. `myorg/sales-i-address-plotter`):

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

If your repo is **private**, use SSH URL and add the VPS deploy key to GitHub (see step 2), or use a Personal Access Token in the URL: `https://TOKEN@github.com/USER/REPO.git`.

---

## 2. Add GitHub secrets

In your GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**.

Add these:

| Secret           | Value |
|------------------|--------|
| `DEPLOY_HOST`    | Your VPS IP (e.g. `167.172.146.216`) |
| `DEPLOY_USER`    | `root` |
| `DEPLOY_SSH_KEY` | Contents of `deploy/wizard-ssh-key` (the private key file) |

After that, every **push to `main`** will trigger a deploy: the workflow SSHs to the VPS, runs `git pull`, `npm install`, and restarts the app.
