#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const isolated = args.includes('--no-gitleaks');
const failures = new Set();
const git = (...argv) => {
  const result = spawnSync('git', argv, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('git_read_failed');
  return result.stdout;
};
const reject = (file, rule) => failures.add(`${file}: ${rule}`);
const sha = (value) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value ?? '');
const zero = (value) => /^0{40}$|^0{64}$/.test(value ?? '');
const forbiddenPath = (file) => {
  const parts = file.split('/');
  return parts.some((part) => part === '.ai-bridge' || part === '.privacy.local.json' || part.startsWith('._') || /^(?:backup|backups)$/i.test(part))
    || parts.some((part) => /^\.env(?:\.|$)/.test(part) && part !== '.env.example')
    || /\.private\./i.test(file) || /\.(?:db|sqlite|sqlite3|sqlitedb|p12|pfx|key|bak|backup|dump|log)$/i.test(file)
    || /(?:^|\/)(?:id_rsa|id_ed25519|id_ecdsa|known_hosts|HANDOFF\.md|Records\.md|PLAN\.md|REQUIREMENTS\.md)$/.test(file);
};
const personalEmail = (email) => !/(?:@(?:users\.)?noreply\.github\.com|@example\.(?:com|org|net|test|invalid)|@[^@]+\.invalid|@localhost)$/i.test(email);
const knownValues = new Set();
const sensitiveKey = /^(?:host|ip|password|sudoPassword|token|bearerToken|username|account|serverName|containerId|database|datasetId|domain|email)$/i;
const secretKey = /password|token/i;
function collect(value, key = '') {
  if (typeof value === 'string' && sensitiveKey.test(key) && value.length >= (secretKey.test(key) ? 4 : 8)) knownValues.add(value);
  else if (Array.isArray(value)) for (const item of value) collect(item, key);
  else if (value && typeof value === 'object') for (const [childKey, item] of Object.entries(value)) collect(item, childKey);
}
let localConfigPresent = false;
try {
  const localText = readFileSync('.privacy.local.json', 'utf8');
  localConfigPresent = true;
  const local = JSON.parse(localText);
  if (!local || !Array.isArray(local.privateFiles) || local.privateFiles.some((file) => typeof file !== 'string')) throw new Error();
  for (const file of local.privateFiles) {
    const text = readFileSync(file, 'utf8');
    try { collect(JSON.parse(text)); } catch {
      for (const match of text.matchAll(/^\s*[-*]?\s*([A-Za-z]+)\s*:\s*[`"']?([^\n`"']+)[`"']?\s*$/gm)) collect(match[2].trim(), match[1]);
    }
  }
} catch (error) {
  if (localConfigPresent || error?.code !== 'ENOENT') reject('privacy-config', 'private_values_unreadable');
}
function inspect(file, text) {
  if (forbiddenPath(file)) reject(file, 'forbidden_path');
  if (new RegExp('-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?' + 'PRIVATE KEY-----').test(text)) reject(file, 'private_key');
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/.test(text)) reject(file, 'github_token');
  if (/\/Users\/(?!fixture(?:\/|\b)|example(?:\/|\b))[^\s/"'`<>]+(?:\/|(?=[\s"'`<>]|$))/.test(text) || /\/home\/(?!fixture(?:\/|\b)|example(?:\/|\b))[^\s/"'`<>]+(?:\/|(?=[\s"'`<>]|$))/.test(text)) reject(file, 'personal_home');
  if (/https?:\/\/(?:chatgpt\.com|chat\.openai\.com)\/c\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i.test(text)) reject(file, 'private_chat_session');
  if (!file.startsWith('tests/')) {
    if (/\b(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):[0-9a-f:]+/i.test(text)) reject(file, 'private_address');
    for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
      const octets = match[0].split('.').map(Number);
      if (octets.some((n) => n > 255)) continue;
      if (octets[0] === 10 || octets[0] === 192 && octets[1] === 168 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) reject(file, 'private_address');
    }
  }
  for (const value of knownValues) if (text.includes(value)) reject(file, 'known_private_value');
}
const entries = [];
function blob(file, object) {
  const size = Number(git('cat-file', '-s', object));
  if (!Number.isFinite(size) || size > 16 * 1024 * 1024) { reject(file, 'blob_limit'); return; }
  const text = git('cat-file', 'blob', object);
  inspect(file, text);
  entries.push({ file, text });
}
try {
  if (args.includes('--push')) {
    const index = args.indexOf('--push');
    const local = args[index + 1]; const remote = args[index + 2];
    if (!sha(local) || !sha(remote) || zero(local)) throw new Error('invalid_push_range');
    const commits = git('rev-list', local, ...(zero(remote) ? [] : [`^${remote}`])).trim().split('\n').filter(Boolean);
    for (const commit of commits) {
      const metadata = git('show', '-s', '--format=%ae%n%ce%n%B', commit);
      const [author, committer, ...message] = metadata.split('\n');
      if (personalEmail(author) || personalEmail(committer)) reject('commit-metadata', 'personal_email');
      inspect('commit-message', message.join('\n'));
      entries.push({ file: 'commit-message', text: message.join('\n') });
      for (const email of message.join('\n').matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) if (personalEmail(email[0])) reject('commit-message', 'personal_email');
      for (const row of git('ls-tree', '-r', '-z', commit).split('\0').filter(Boolean)) {
        const split = row.indexOf('\t'); const [mode, type, object] = row.slice(0, split).split(' '); const file = row.slice(split + 1);
        if (type !== 'blob' || mode === '120000') reject(file, 'unsupported_tree_entry');
        else blob(file, object);
      }
    }
  } else if (args.includes('--commit-message')) {
    const file = args[args.indexOf('--commit-message') + 1];
    const text = readFileSync(file, 'utf8'); inspect('commit-message', text);
    for (const email of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) if (personalEmail(email[0])) reject('commit-message', 'personal_email');
    entries.push({ file: 'commit-message', text });
  } else if (args.includes('--tracked') || args.includes('--staged')) {
    const selected = args.includes('--staged') ? new Set(git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0')) : null;
    for (const row of git('ls-files', '--stage', '-z').split('\0').filter(Boolean)) {
      const split = row.indexOf('\t'); const [mode, object, stage] = row.slice(0, split).split(' '); const file = row.slice(split + 1);
      if (selected && !selected.has(file)) continue;
      if (stage !== '0' || mode === '120000') reject(file, 'unsupported_index_entry');
      else blob(file, object);
    }
  } else throw new Error('mode_required');
  if (!isolated) {
    const configured = spawnSync('git', ['config', '--get', 'view.gitleaksPath'], { encoding: 'utf8' });
    const executable = configured.status === 0 ? configured.stdout.trim() : 'gitleaks';
    const root = mkdtempSync(path.join(os.tmpdir(), 'view-privacy-'));
    try {
      entries.forEach(({ file, text }, index) => {
        const destination = path.join(root, String(index), path.basename(file)); mkdirSync(path.dirname(destination), { recursive: true }); writeFileSync(destination, text, { mode: 0o600 });
      });
      const result = spawnSync(executable, ['dir', '--no-banner', '--redact', '--exit-code', '1', root], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
      if (result.error || result.status === null || result.status > 1) reject('gitleaks', 'scanner_unavailable');
      else if (result.status !== 0) reject('gitleaks', 'secret_detected');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
} catch { reject('privacy-check', 'inspection_failed'); }
if (failures.size) { process.stderr.write(`Privacy check blocked:\n${[...failures].join('\n')}\n`); process.exitCode = 1; }
else process.stdout.write('Privacy check passed.\n');
