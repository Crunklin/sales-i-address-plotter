#!/usr/bin/env node
/**
 * Address Plotter — setup wizard for DigitalOcean (or any VPS).
 * Prompts for: DO token (optional), droplet or IP, SHARED_SECRET, SSH auth.
 * Then SSHs into the server, uploads the app, writes .env, and runs setup-vps.sh.
 */

import readline from 'readline';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { Client } from 'ssh2';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const APP_DIR = '/opt/address-plotter';

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'playwright-my-maps-profile', 'browser-profile']);
const EXCLUDE_FILES = new Set(['.env', 'env.production', 'address-plotter-export.kml']);
const EXCLUDE_EXT = new Set(['.zip']);

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

function* walkDir(dir, base = dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    const segs = rel.split(path.sep);
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      yield { full, rel, dir: true };
      yield* walkDir(full, base);
    } else {
      if (EXCLUDE_FILES.has(e.name)) continue;
      if (EXCLUDE_EXT.has(path.extname(e.name))) continue;
      yield { full, rel, dir: false };
    }
  }
}

function sshConnect(options) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => resolve(conn)).on('error', reject).connect(options);
  });
}

function waitForSsh(host, port, username, connectOptions, maxWaitMs = 120000, intervalMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function tryConnect() {
      sshConnect({ ...connectOptions, host, port, username })
        .then((conn) => {
          conn.end();
          resolve();
        })
        .catch((err) => {
          if (Date.now() - start >= maxWaitMs) reject(new Error(`SSH not ready after ${maxWaitMs / 1000}s: ${err.message}`));
          else setTimeout(tryConnect, intervalMs);
        });
    }
    tryConnect();
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

async function uploadProject(sftp, localRoot, remoteRoot) {
  const entries = [...walkDir(localRoot)];
  const dirs = entries.filter((e) => e.dir).sort((a, b) => a.rel.localeCompare(b.rel));
  const files = entries.filter((e) => !e.dir);

  const mkdir = (p) =>
    new Promise((res) => {
      sftp.mkdir(p, { mode: 0o755 }, () => res()); // ignore EEXIST
    });

  // Create all remote dirs (including parents for nested paths)
  const allDirs = new Set();
  for (const { rel } of dirs) allDirs.add(rel);
  for (const { rel } of files) {
    const d = path.dirname(rel);
    let cur = '';
    for (const part of d.split(path.sep)) {
      cur = cur ? path.join(cur, part) : part;
      allDirs.add(cur.replace(/\\/g, '/'));
    }
  }
  for (const rel of [...allDirs].sort((a, b) => a.localeCompare(b))) {
    const remotePath = path.posix.join(remoteRoot, rel.replace(/\\/g, '/'));
    await mkdir(remotePath);
  }

  for (const { full, rel } of files) {
    const remotePath = path.posix.join(remoteRoot, rel.replace(/\\/g, '/'));
    await new Promise((resolve, reject) => {
      sftp.fastPut(full, remotePath, (err) => (err ? reject(err) : resolve()));
    });
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n=== Address Plotter — Deployment Setup Wizard ===\n');

  // 1) DigitalOcean
  const hasDoToken = (await ask(rl, 'Do you have a DigitalOcean API token? (y/n)', 'n')).toLowerCase().startsWith('y');
  let dropletIp = '';
  let doToken = '';
  let justCreatedDroplet = false;
  let wizardPrivateKey = null; // when we generate a key and add to DO, use this for SSH (no password)

  if (hasDoToken) {
    doToken = await ask(rl, 'Paste your DigitalOcean API token (https://cloud.digitalocean.com/account/api/tokens)');
    if (doToken) {
      const createDroplet = (await ask(rl, 'Create a new droplet from this app? (y/n)', 'y')).toLowerCase().startsWith('y');
      if (createDroplet) {
        const useNewKey = (await ask(rl, 'Generate a new SSH key and add it to DigitalOcean? (recommended, no password needed) (y/n)', 'y')).toLowerCase().startsWith('y');
        const name = await ask(rl, 'Droplet name', 'address-plotter');
        const region = await ask(rl, 'Region (e.g. nyc1, sfo3)', 'nyc1');
        const size = await ask(rl, 'Size (s-1vcpu-2gb recommended for Chromium)', 's-1vcpu-2gb');
        let sshKeyId = null;
        if (useNewKey) {
          console.log('\nGenerating SSH key (using ssh-keygen)...');
          const deployDir = path.join(projectRoot, 'deploy');
          if (!fs.existsSync(deployDir)) fs.mkdirSync(deployDir, { recursive: true });
          const keyPath = path.join(deployDir, 'wizard-ssh-key');
          try {
            // On Windows, spawn without shell often doesn't find ssh-keygen; use full path if available
            const sysRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
            const winSshKeygen = path.join(sysRoot, 'System32', 'OpenSSH', 'ssh-keygen.exe');
            const useWinPath = process.platform === 'win32' && fs.existsSync(winSshKeygen);
            const sshKeygenCmd = useWinPath ? winSshKeygen : 'ssh-keygen';
            let out = spawnSync(sshKeygenCmd, ['-t', 'rsa', '-b', '2048', '-f', keyPath, '-N', '', '-q', '-C', 'address-plotter-wizard'], {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            if ((out.status !== 0 || !fs.existsSync(keyPath)) && process.platform === 'win32' && !useWinPath) {
              out = spawnSync('ssh-keygen', ['-t', 'rsa', '-b', '2048', '-f', keyPath, '-N', '', '-q', '-C', 'address-plotter-wizard'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: true,
              });
            }
            if (out.status !== 0 || !fs.existsSync(keyPath) || !fs.existsSync(keyPath + '.pub')) {
              const err = out.stderr?.trim() || out.error?.message || 'ssh-keygen failed';
              throw new Error(err);
            }
            const publicKey = fs.readFileSync(keyPath + '.pub', 'utf8').trim();
            if (!publicKey.startsWith('ssh-rsa ') && !publicKey.startsWith('ssh-ed25519 ')) {
              throw new Error('Unexpected public key format');
            }
            const keyRes = await fetch('https://api.digitalocean.com/v2/account/keys', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${doToken}` },
              body: JSON.stringify({ name: 'address-plotter-wizard', public_key: publicKey }),
            });
            if (!keyRes.ok) throw new Error(`Add SSH key: ${keyRes.status} ${await keyRes.text()}`);
            const keyData = await keyRes.json();
            sshKeyId = keyData.ssh_key?.id;
            if (!sshKeyId) throw new Error('No SSH key id in response');
            wizardPrivateKey = fs.readFileSync(keyPath, 'utf8');
            try { fs.chmodSync(keyPath, 0o600); } catch (_) {}
            console.log('SSH key added to your DigitalOcean account and saved to deploy/wizard-ssh-key');
          } catch (e) {
            console.error('SSH key setup failed:', e.message);
            console.log('Continuing without SSH key. When asked for SSH auth, choose (p)assword and use the root password from your DigitalOcean droplet email.');
            if (process.platform === 'win32') {
              console.log('To use a key next time: Install OpenSSH Client (Settings > Apps > Optional features > Add a feature > OpenSSH Client).');
            }
            wizardPrivateKey = null;
            if (fs.existsSync(keyPath)) try { fs.unlinkSync(keyPath); fs.unlinkSync(keyPath + '.pub'); } catch (_) {}
          }
        }
        console.log('\nCreating droplet...');
        try {
          const body = { name, region, size, image: 'ubuntu-22-04-x64' };
          if (sshKeyId) body.ssh_keys = [sshKeyId];
          const res = await fetch('https://api.digitalocean.com/v2/droplets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${doToken}` },
            body: JSON.stringify(body),
          });
          if (!res.ok) throw new Error(`DO API: ${res.status} ${await res.text()}`);
          const data = await res.json();
          const dropletId = data.droplet?.id;
          if (!dropletId) throw new Error('No droplet id in response');
          console.log(`Droplet created (id: ${dropletId}). Waiting for IP (up to ~90s)...`);
          for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 3000));
            const getRes = await fetch(`https://api.digitalocean.com/v2/droplets/${dropletId}`, {
              headers: { Authorization: `Bearer ${doToken}` },
            });
            if (!getRes.ok) continue;
            const getData = await getRes.json();
            const ip = getData.droplet?.networks?.v4?.find((n) => n.type === 'public')?.ip_address;
            if (ip) {
              dropletIp = ip;
              justCreatedDroplet = true;
              console.log(`Droplet IP: ${dropletIp}\n`);
              break;
            }
          }
          if (!dropletIp) console.log('IP not ready yet. Check DigitalOcean dashboard for the droplet IP.');
        } catch (e) {
          console.error('Droplet creation failed:', e.message);
        }
      }
    }
  }

  if (!dropletIp) dropletIp = await ask(rl, 'Enter your server IP or hostname');
  if (!dropletIp) {
    console.log('No IP provided. Exiting.');
    rl.close();
    process.exit(1);
  }

  // 2) App config (only after we have a server)
  console.log('');
  const sharedSecret = await ask(rl, 'Shared secret for app login (users enter this to access the app)', '');
  if (!sharedSecret) console.log('WARNING: No SHARED_SECRET. Set it in .env on the server or anyone can access the app.');
  const googleKey = await ask(rl, 'Google Geocoding API key (optional, press Enter to skip)', '');
  const port = await ask(rl, 'Port for the app on the server', '3000');

  // 3) SSH (skip if we already have wizard key; otherwise ask for key path or password)
  let connectOptions = { host: dropletIp, port: 22, username: 'root' };
  // Check for saved wizard key from a previous run
  const savedWizardKey = path.join(projectRoot, 'deploy', 'wizard-ssh-key');
  if (!wizardPrivateKey && fs.existsSync(savedWizardKey)) {
    wizardPrivateKey = fs.readFileSync(savedWizardKey, 'utf8');
    console.log('\nFound saved SSH key from previous run (deploy/wizard-ssh-key).');
  }
  if (wizardPrivateKey) {
    console.log('Using the SSH key we added to DigitalOcean.');
    connectOptions.privateKey = wizardPrivateKey;
  } else {
    if (justCreatedDroplet) {
      console.log('\nUse the root password from your DigitalOcean account email (or your SSH key if you added one to DO).');
    }
    const sshUser = await ask(rl, 'SSH user', 'root');
    connectOptions.username = sshUser;
    const defaultKey = path.join(os.homedir(), '.ssh', 'id_rsa');
    const hasDefaultKey = fs.existsSync(defaultKey);
    const authDefault = (justCreatedDroplet || !hasDefaultKey) ? 'p' : 'k';
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
        console.error('Password required for SSH.');
        rl.close();
        process.exit(1);
      }
      connectOptions.password = password;
    }
  }
  const sshUser = connectOptions.username;

  rl.close();

  // 4) Wait for SSH if we just created the droplet (new droplets need a minute to boot)
  if (justCreatedDroplet) {
    console.log('\nWaiting for SSH to be ready (up to 2 min)...');
    try {
      await waitForSsh(dropletIp, 22, sshUser, connectOptions);
      console.log('SSH ready.\n');
    } catch (e) {
      console.error('SSH wait failed:', e.message);
      console.log('You can run the wizard again and enter the IP once the droplet is up.');
      process.exit(1);
    }
  }

  // 5) Connect and deploy
  console.log('Connecting to server...');
  let conn;
  try {
    conn = await sshConnect(connectOptions);
  } catch (e) {
    console.error('SSH connection failed:', e.message);
    process.exit(1);
  }

  try {
    // Create app dir
    await runScript(conn, `sudo mkdir -p ${APP_DIR} && sudo chown \$(whoami) ${APP_DIR}`);
    console.log('Uploading app files...');
    const sftp = await new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
    });
    await uploadProject(sftp, projectRoot, APP_DIR);
    console.log('Upload done.');

    // Fix Windows CRLF → LF on shell scripts (uploaded from Windows can have \r\n)
    await runScript(conn, `sed -i 's/\\r$//' ${APP_DIR}/deploy/setup-vps.sh`);

    // Write .env
    const envLines = [
      `PORT=${port}`,
      sharedSecret ? `SHARED_SECRET=${sharedSecret}` : '# SHARED_SECRET=set-this-on-server',
      googleKey ? `GOOGLE_GEOCODING_API_KEY=${googleKey}` : '# GOOGLE_GEOCODING_API_KEY=optional',
      '# BROWSER_USER_DATA_DIR is set by systemd',
    ].filter(Boolean);
    const envContent = envLines.join('\n') + '\n';
    await new Promise((resolve, reject) => {
      sftp.writeFile(`${APP_DIR}/.env`, envContent, (err) => (err ? reject(err) : resolve()));
    });

    // Run setup script (needs root for apt/systemd)
    console.log('Running server setup (install Node, Xvfb, Chromium, systemd)...');
    const { code } = await runScript(
      conn,
      `cd ${APP_DIR} && chmod +x deploy/setup-vps.sh && sudo bash deploy/setup-vps.sh`
    );
    if (code !== 0) {
      console.error('Setup script exited with code', code);
      conn.end();
      process.exit(1);
    }
  } finally {
    conn.end();
  }

  console.log('\n--- Deployment complete ---\n');
  console.log(`App URL: http://${dropletIp}:${port}`);
  console.log('Users enter the shared secret to sign in.');
  if (wizardPrivateKey) {
    console.log('SSH key saved to deploy/wizard-ssh-key — use it to connect later: ssh -i deploy/wizard-ssh-key root@' + dropletIp);
  }
  console.log('\nOne-time: Add the shared Google account for My Maps:');
  console.log('  1. On your PC run:  npm run export-google-profile');
  console.log('  2. Log in to Google in the browser that opens, then close it.');
  console.log('  3. Zip the folder playwright-my-maps-profile and upload to the server:');
  console.log(`     scp playwright-my-maps-profile.zip ${sshUser}@${dropletIp}:/tmp/`);
  console.log(`  4. On server: ssh ${sshUser}@${dropletIp}`);
  console.log(`     cd ${APP_DIR} && unzip -o /tmp/playwright-my-maps-profile.zip`);
  console.log('     mv playwright-my-maps-profile/* browser-profile/  # if zip has top-level folder');
  console.log('     sudo systemctl restart address-plotter\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
