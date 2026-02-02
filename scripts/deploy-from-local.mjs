#!/usr/bin/env node
/**
 * Deploy to VPS from your PC when GitHub Actions is unavailable.
 * Runs the same steps as .github/workflows/deploy.yml: SSH → git pull → npm install → restart.
 *
 * Requires: DEPLOY_HOST, DEPLOY_USER, and either DEPLOY_SSH_KEY (private key content)
 *           or DEPLOY_SSH_KEY_PATH (path to private key file).
 * Set in .env or environment. Example .env.deploy:
 *   DEPLOY_HOST=your.vps.ip
 *   DEPLOY_USER=root
 *   DEPLOY_SSH_KEY_PATH=deploy/wizard-ssh-key
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from 'ssh2';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Load .env.deploy from project root if present (so deploy secrets stay out of main .env)
const envDeployPath = path.join(projectRoot, '.env.deploy');
if (fs.existsSync(envDeployPath)) {
  const content = fs.readFileSync(envDeployPath, 'utf8');
  // Handle both Windows (\r\n) and Unix (\n) line endings
  for (const line of content.replace(/\r/g, '').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  }
}

const DEPLOY_HOST = process.env.DEPLOY_HOST;
const DEPLOY_USER = process.env.DEPLOY_USER || 'root';
const DEPLOY_SSH_KEY = process.env.DEPLOY_SSH_KEY;
const DEPLOY_SSH_KEY_PATH = process.env.DEPLOY_SSH_KEY_PATH;

function usage() {
  console.log(`
Deploy to VPS from your PC (same steps as GitHub Actions).

Usage:
  npm run deploy-from-local

Required (in .env or environment):
  DEPLOY_HOST       VPS IP or hostname
  DEPLOY_USER       SSH user (default: root)
  DEPLOY_SSH_KEY    Private key content (multiline OK in .env)
  OR
  DEPLOY_SSH_KEY_PATH   Path to private key file (e.g. deploy/wizard-ssh-key)

Example .env entries:
  DEPLOY_HOST=1.2.3.4
  DEPLOY_USER=root
  DEPLOY_SSH_KEY_PATH=deploy/wizard-ssh-key
`);
}

function sshConnect(options) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => resolve(conn)).on('error', reject).connect(options);
  });
}

function runScript(conn, script) {
  return new Promise((resolve, reject) => {
    conn.exec(script, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('close', (code) => resolve({ code, stdout, stderr }));
      stream.on('data', (data) => {
        const s = data.toString();
        stdout += s;
        process.stdout.write(s);
      });
      if (stream.stderr) stream.stderr.on('data', (data) => {
        const s = data.toString();
        stderr += s;
        process.stderr.write(s);
      });
    });
  });
}

async function main() {
  let privateKey = DEPLOY_SSH_KEY;
  if (!privateKey && DEPLOY_SSH_KEY_PATH) {
    const keyPath = path.isAbsolute(DEPLOY_SSH_KEY_PATH)
      ? DEPLOY_SSH_KEY_PATH
      : path.join(projectRoot, DEPLOY_SSH_KEY_PATH);
    if (!fs.existsSync(keyPath)) {
      console.error('Key file not found:', keyPath);
      usage();
      process.exit(1);
    }
    privateKey = fs.readFileSync(keyPath, 'utf8');
  }

  if (!DEPLOY_HOST || !privateKey) {
    console.error('Missing DEPLOY_HOST or SSH key (DEPLOY_SSH_KEY or DEPLOY_SSH_KEY_PATH).');
    usage();
    process.exit(1);
  }

  const connectOptions = {
    host: DEPLOY_HOST,
    port: 22,
    username: DEPLOY_USER,
    privateKey,
  };

  const script = `
set -e
cd /opt/address-plotter
git fetch origin main
git reset --hard origin/main
npm install
npx playwright install chromium --with-deps 2>/dev/null || true
sudo sed -i 's/\\r$//' deploy/setup-vps.sh 2>/dev/null || true
sudo systemctl restart address-plotter
echo 'Deploy done.'
`;

  console.log('Connecting to', DEPLOY_USER + '@' + DEPLOY_HOST, '...');
  let conn;
  try {
    conn = await sshConnect(connectOptions);
  } catch (e) {
    console.error('SSH connection failed:', e.message);
    process.exit(1);
  }

  try {
    const { code } = await runScript(conn, script.trim());
    if (code !== 0) {
      console.error('Deploy script exited with code', code);
      process.exit(1);
    }
    console.log('\nDeploy complete. App restarted on VPS.');
  } finally {
    conn.end();
  }
}

main();
