#!/usr/bin/env bash
# Address Plotter — VPS setup for Ubuntu 22.04 (DigitalOcean, etc.)
# Run from project root: ./deploy/setup-vps.sh
# Or from deploy/: ../deploy/setup-vps.sh (script detects project root)

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$APP_ROOT"

echo "=== Address Plotter VPS setup (Ubuntu 22.04) ==="
echo "App root: $APP_ROOT"

# 1) System packages: Node 20, Chromium, Xvfb, Playwright deps
echo ""
echo "--- Installing system packages ---"
export DEBIAN_FRONTEND=noninteractive

# Wait for apt lock (fresh droplets often have unattended-upgrades running)
echo "Waiting for apt lock..."
for i in {1..60}; do
  if ! fuser /var/lib/apt/lists/lock /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend &>/dev/null; then
    break
  fi
  echo "  apt is locked, waiting... ($i/60)"
  sleep 5
done

apt-get update -qq
apt-get install -y -qq curl ca-certificates

# Node 20 (NodeSource)
if ! command -v node &>/dev/null || [[ "$(node -v 2>/dev/null)" != v20* ]]; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
echo "Node: $(node -v)  npm: $(npm -v)"

# Xvfb (virtual display) + Playwright Chromium system deps
apt-get install -y -qq xvfb
# Playwright system deps for its bundled Chromium
apt-get install -y -qq libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2
apt-get clean

# 2) App deps and Playwright Chromium
echo ""
echo "--- Installing app dependencies ---"
cd "$APP_ROOT"
npm ci 2>/dev/null || npm install
npx playwright install chromium

# 3) Browser profile dir (shared Google account session)
BROWSER_PROFILE="$APP_ROOT/browser-profile"
mkdir -p "$BROWSER_PROFILE"
chmod 755 "$BROWSER_PROFILE"
echo "Browser profile dir: $BROWSER_PROFILE"

# 4) .env check
if [[ ! -f "$APP_ROOT/.env" ]]; then
  echo ""
  echo "WARNING: $APP_ROOT/.env not found. Create it with at least:"
  echo "  SHARED_SECRET=your-secret-for-login"
  echo "  PORT=3000"
  echo "  # Optional: GOOGLE_GEOCODING_API_KEY=..."
  echo "  # Optional: BROWSER_USER_DATA_DIR=$BROWSER_PROFILE (script will set this in systemd)"
  cp "$APP_ROOT/.env.example" "$APP_ROOT/.env" 2>/dev/null || true
fi

# 5) Xvfb systemd service (virtual display for Chromium)
echo ""
echo "--- Creating systemd: xvfb address-plotter ---"
XVFB_SVC="/etc/systemd/system/address-plotter-xvfb.service"
cat > "$XVFB_SVC" << 'XVFBUNIT'
[Unit]
Description=Xvfb virtual display for Address Plotter
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1280x1024x24 -ac
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
XVFBUNIT

PLOTTER_SVC="/etc/systemd/system/address-plotter.service"
cat > "$PLOTTER_SVC" << PLOTTERUNIT
[Unit]
Description=Address Plotter (Node + My Maps automation)
After=network.target address-plotter-xvfb.service
Requires=address-plotter-xvfb.service

[Service]
Type=simple
User=root
WorkingDirectory=$APP_ROOT
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=DISPLAY=:99
Environment=BROWSER_USER_DATA_DIR=$BROWSER_PROFILE
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
PLOTTERUNIT

systemctl daemon-reload
systemctl enable address-plotter-xvfb address-plotter
systemctl restart address-plotter-xvfb
systemctl restart address-plotter

echo ""
echo "=== Setup complete ==="
echo "  App:     $APP_ROOT"
echo "  Profile: $BROWSER_PROFILE (upload Google login profile here for My Maps)"
echo "  Service: systemctl status address-plotter"
echo "  Logs:    journalctl -u address-plotter -f"
echo ""
echo "Next: Upload the shared Google account browser profile to $BROWSER_PROFILE"
echo "  (Run 'npm run export-google-profile' on your PC, then scp the zip to this server and extract into browser-profile/)"
echo ""
