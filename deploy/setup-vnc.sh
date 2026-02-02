#!/bin/bash
# Install lightweight VNC server for Google login on VPS
# Run as root: bash deploy/setup-vnc.sh

set -e

echo "Installing x11vnc and basic window manager..."
apt-get update
apt-get install -y x11vnc openbox

echo ""
echo "=== VNC Setup Complete ==="
echo ""
echo "To start VNC (temporary, for Google login):"
echo "  x11vnc -display :99 -nopw -forever -shared &"
echo ""
echo "Then connect from your PC using a VNC client:"
echo "  Host: YOUR_VPS_IP:5900"
echo "  (No password by default - only use temporarily!)"
echo ""
echo "Once connected, run in the VPS terminal:"
echo "  cd /opt/address-plotter"
echo "  DISPLAY=:99 BROWSER_USER_DATA_DIR=/opt/address-plotter/browser-profile node scripts/vps-google-login.mjs"
echo ""
echo "Log in to Google in the browser, close it, then stop VNC:"
echo "  pkill x11vnc"
echo ""
