#!/usr/bin/env node
/**
 * One-time: Open a browser so you can log in to the shared Google account.
 * After you close the browser, uploads the profile to the VPS automatically.
 * Usage: npm run export-google-profile
 */

import { chromium } from 'playwright';
import readline from 'readline';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { Client } from 'ssh2';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const userDataDir = path.join(projectRoot, 'playwright-my-maps-profile');
const savedWizardKey = path.join(projectRoot, 'deploy', 'wizard-ssh-key');
const APP_DIR = '/opt/address-plotter';

function ask(rl, question, defaultVal = '') {
  const prompt = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve((answer || defaultVal || '').trim());
    });
  });
}

function askSecret(rl, question) {
  return new Promise((resolve) => {
    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl2.question(question, (answer) => {
      rl2.close();
      resolve((answer || '').trim());
    });
  });
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
      stream.on('data', (data) => { const s = data.toString(); stdout += s; process.stdout.write(s); });
      if (stream.stderr) stream.stderr.on('data', (data) => { const s = data.toString(); stderr += s; process.stderr.write(s); });
    });
  });
}

function* walkDir(dir, base = dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    if (e.isDirectory()) {
      yield { full, rel, dir: true };
      yield* walkDir(full, base);
    } else {
      yield { full, rel, dir: false };
    }
  }
}

async function uploadDir(sftp, localDir, remoteDir) {
  const entries = [...walkDir(localDir)];
  const dirs = entries.filter((e) => e.dir).sort((a, b) => a.rel.localeCompare(b.rel));
  const files = entries.filter((e) => !e.dir);

  const mkdir = (p) =>
    new Promise((res) => {
      sftp.mkdir(p, { mode: 0o755 }, () => res());
    });

  const allDirs = new Set();
  for (const { rel } of dirs) allDirs.add(rel.replace(/\\/g, '/'));
  for (const { rel } of files) {
    const d = path.dirname(rel);
    let cur = '';
    for (const part of d.split(path.sep)) {
      cur = cur ? path.posix.join(cur, part) : part;
      allDirs.add(cur);
    }
  }
  for (const rel of [...allDirs].sort((a, b) => a.localeCompare(b))) {
    const remotePath = path.posix.join(remoteDir, rel);
    await mkdir(remotePath);
  }

  for (const { full, rel } of files) {
    const remotePath = path.posix.join(remoteDir, rel.replace(/\\/g, '/'));
    await new Promise((resolve, reject) => {
      sftp.fastPut(full, remotePath, (err) => (err ? reject(err) : resolve()));
    });
  }
}

async function main() {
  console.log('\n=== Address Plotter — Google Profile Export & Upload ===\n');
  console.log('Opening browser. Log in to the SHARED Google account (the one you will use for My Maps on the server).');
  console.log('When you are done, close the browser window.\n');

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    locale: 'en-US',
    args: ['--disable-blink-features=AutomationControlled'],
  }).catch(() => chromium.launchPersistentContext(userDataDir, {
    headless: false,
    locale: 'en-US',
    args: ['--disable-blink-features=AutomationControlled'],
  }));

  let page = context.pages()[0];
  if (!page) page = await context.newPage();
  await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded' });

  console.log('Browser opened. Sign in to Google, then close the browser when done.\n');
  await context.waitForEvent('close');

  if (!fs.existsSync(userDataDir)) {
    console.error('Profile directory not found after close.');
    process.exit(1);
  }

  console.log('Profile saved locally to:', userDataDir);
  console.log('\n--- Uploading to server ---\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Get server IP
  const serverIp = await ask(rl, 'Server IP (from deployment)', '');
  if (!serverIp) {
    console.error('Server IP required.');
    rl.close();
    process.exit(1);
  }

  // SSH auth: check for saved wizard key first
  let connectOptions = { host: serverIp, port: 22, username: 'root' };
  if (fs.existsSync(savedWizardKey)) {
    console.log('Found saved SSH key from deployment (deploy/wizard-ssh-key).');
    connectOptions.privateKey = fs.readFileSync(savedWizardKey, 'utf8');
  } else {
    const defaultKey = path.join(os.homedir(), '.ssh', 'id_rsa');
    const hasDefaultKey = fs.existsSync(defaultKey);
    const authDefault = hasDefaultKey ? 'k' : 'p';
    const useKey = (await ask(rl, 'SSH auth: (k)ey or (p)assword?', authDefault)).toLowerCase().startsWith('k');
    if (useKey) {
      const keyPath = await ask(rl, 'Path to private key', defaultKey);
      if (!fs.existsSync(keyPath)) {
        console.error('Key file not found:', keyPath);
        rl.close();
        process.exit(1);
      }
      connectOptions.privateKey = fs.readFileSync(keyPath, 'utf8');
    } else {
      const password = await askSecret(rl, 'SSH password: ');
      if (!password) {
        console.error('Password required.');
        rl.close();
        process.exit(1);
      }
      connectOptions.password = password;
    }
  }

  rl.close();

  console.log('\nConnecting to server...');
  let conn;
  try {
    conn = await sshConnect(connectOptions);
  } catch (e) {
    console.error('SSH connection failed:', e.message);
    process.exit(1);
  }

  try {
    // Ensure browser-profile dir exists and is empty
    console.log('Preparing browser-profile directory...');
    await runScript(conn, `rm -rf ${APP_DIR}/browser-profile && mkdir -p ${APP_DIR}/browser-profile`);

    // Upload profile
    console.log('Uploading profile (this may take a minute)...');
    const sftp = await new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
    });
    await uploadDir(sftp, userDataDir, `${APP_DIR}/browser-profile`);
    console.log('Upload done.');

    // Restart service
    console.log('Restarting address-plotter service...');
    const { code } = await runScript(conn, `sudo systemctl restart address-plotter`);
    if (code !== 0) {
      console.error('Failed to restart service (exit code', code + ')');
    } else {
      console.log('Service restarted.');
    }
  } finally {
    conn.end();
  }

  console.log('\n--- Done! ---\n');
  console.log('The shared Google account is now set up on the server.');
  console.log('Users can use "Add to Google My Maps" in the app and it will import to that account\'s maps.\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
