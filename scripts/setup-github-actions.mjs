#!/usr/bin/env node
/**
 * Setup GitHub Actions secrets for auto-deploy.
 * Requires: GitHub CLI (gh) installed and authenticated.
 *
 * Sets these secrets in your repo:
 *   DEPLOY_HOST      - VPS IP address
 *   DEPLOY_USER      - SSH user (usually root)
 *   DEPLOY_SSH_KEY   - Private SSH key content
 */

import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function ask(rl, question, defaultVal = '') {
  const prompt = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve((answer || defaultVal || '').trim()));
  });
}

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: opts.silent ? 'pipe' : 'inherit', ...opts });
  } catch (e) {
    if (opts.ignoreError) return '';
    throw e;
  }
}

function checkGhCli() {
  try {
    execSync('gh --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function checkGhAuth() {
  try {
    execSync('gh auth status', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function getRepoInfo() {
  try {
    const remote = execSync('git remote get-url origin', { encoding: 'utf8', stdio: 'pipe' }).trim();
    // Parse GitHub URL: https://github.com/user/repo.git or git@github.com:user/repo.git
    let match = remote.match(/github\.com[/:]([\w-]+)\/([\w-]+?)(\.git)?$/);
    if (match) return { owner: match[1], repo: match[2] };
  } catch {}
  return null;
}

async function main() {
  console.log('=== GitHub Actions Deploy Setup ===\n');

  // 1. Check gh CLI
  if (!checkGhCli()) {
    console.log('GitHub CLI (gh) is not installed.\n');
    console.log('Install it from: https://cli.github.com/');
    console.log('  Windows: winget install GitHub.cli');
    console.log('  Mac:     brew install gh');
    console.log('  Linux:   See https://github.com/cli/cli/blob/trunk/docs/install_linux.md');
    console.log('\nAfter installing, run: gh auth login');
    process.exit(1);
  }

  // 2. Check gh auth
  if (!checkGhAuth()) {
    console.log('GitHub CLI is not authenticated.\n');
    console.log('Run: gh auth login');
    console.log('Then re-run this script.');
    process.exit(1);
  }
  console.log('✓ GitHub CLI authenticated\n');

  // 3. Get repo info
  const repoInfo = getRepoInfo();
  if (!repoInfo) {
    console.log('Could not detect GitHub repo from git remote.');
    console.log('Make sure you are in a git repo with a GitHub remote.');
    process.exit(1);
  }
  const repoSlug = `${repoInfo.owner}/${repoInfo.repo}`;
  console.log(`✓ Repo: ${repoSlug}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // 4. Get deploy info
  console.log('Enter your VPS details:\n');

  const deployHost = await ask(rl, 'VPS IP address or hostname');
  if (!deployHost) {
    console.log('Host is required.');
    rl.close();
    process.exit(1);
  }

  const deployUser = await ask(rl, 'SSH user', 'root');

  // Look for existing keys
  const wizardKey = path.join(projectRoot, 'deploy', 'wizard-ssh-key');
  const defaultSshKey = path.join(process.env.USERPROFILE || process.env.HOME || '', '.ssh', 'id_rsa');
  
  let defaultKeyPath = '';
  if (fs.existsSync(wizardKey)) {
    defaultKeyPath = wizardKey;
    console.log(`\nFound wizard SSH key: ${wizardKey}`);
  } else if (fs.existsSync(defaultSshKey)) {
    defaultKeyPath = defaultSshKey;
  }

  const keyPath = await ask(rl, 'Path to private SSH key', defaultKeyPath);
  if (!keyPath || !fs.existsSync(keyPath)) {
    console.log('SSH key file not found:', keyPath || '(none)');
    rl.close();
    process.exit(1);
  }

  const sshKey = fs.readFileSync(keyPath, 'utf8');
  if (!sshKey.includes('PRIVATE KEY')) {
    console.log('Warning: File does not appear to be a private key.');
  }

  rl.close();

  // 5. Set secrets
  console.log('\nSetting GitHub secrets...\n');

  const secrets = [
    { name: 'DEPLOY_HOST', value: deployHost },
    { name: 'DEPLOY_USER', value: deployUser },
    { name: 'DEPLOY_SSH_KEY', value: sshKey },
  ];

  for (const { name, value } of secrets) {
    console.log(`  Setting ${name}...`);
    try {
      // Use stdin to pass secret value (avoids command line exposure)
      const result = spawnSync('gh', ['secret', 'set', name, '-R', repoSlug], {
        input: value,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (result.status !== 0) {
        console.log(`  ✗ Failed to set ${name}: ${result.stderr || result.stdout}`);
        process.exit(1);
      }
      console.log(`  ✓ ${name} set`);
    } catch (e) {
      console.log(`  ✗ Failed to set ${name}: ${e.message}`);
      process.exit(1);
    }
  }

  console.log('\n=== Setup Complete ===\n');
  console.log('GitHub Actions secrets configured:');
  console.log(`  DEPLOY_HOST     = ${deployHost}`);
  console.log(`  DEPLOY_USER     = ${deployUser}`);
  console.log(`  DEPLOY_SSH_KEY  = (private key from ${keyPath})`);
  console.log('\nNext steps:');
  console.log('  1. Push to main branch to trigger a deploy');
  console.log('  2. Check workflow runs: https://github.com/' + repoSlug + '/actions');
  console.log('\nIf Actions are still queued/failing, use local deploy:');
  console.log('  npm run deploy-from-local');
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
