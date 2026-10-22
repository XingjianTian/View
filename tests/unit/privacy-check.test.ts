import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('../../scripts/privacy-check.mjs', import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function repo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'view-privacy-test-')); roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'View Test'); git('config', 'user.email', '123+view@users.noreply.github.com');
  const put = (file: string, content: string) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), content); };
  const check = (...args: string[]) => spawnSync(process.execPath, [checker, ...args], { cwd: root, encoding: 'utf8' });
  return { root, git, put, check };
}
const zero = '0'.repeat(40);

describe('privacy index and complete push-range checks', () => {
  it.each(['.env', '.env.production', 'tokens.private.json', '.privacy.local.json', '.ai-bridge/state.json', 'data/backups/copy.txt', 'data/snapshot.db', 'runtime.log', 'known_hosts', 'id_ed25519', '._README.md', 'HANDOFF.md', 'Records.md', 'PLAN.md', 'REQUIREMENTS.md'])('blocks forbidden staged path %s', (file) => {
    const { git, put, check } = repo(); put(file, 'fixture'); git('add', '--', file);
    const result = check('--staged', '--no-gitleaks'); expect(result.status).toBe(1); expect(result.stderr).toContain('forbidden_path');
  });

  it('reads staged blobs rather than cleaned working-tree content and follows renamed destinations', () => {
    const { git, put, check } = repo();
    put('safe.txt', '/Users/' + 'private-person/documents/item'); git('add', 'safe.txt'); put('safe.txt', 'clean');
    expect(check('--staged', '--no-gitleaks').status).toBe(1);
    git('add', 'safe.txt'); expect(check('--staged', '--no-gitleaks').status).toBe(0);
    git('commit', '-qm', 'Initial'); git('mv', 'safe.txt', 'config.private.json');
    expect(check('--staged', '--no-gitleaks').stderr).toContain('forbidden_path');
  });

  it('checks every new-ref commit tree even when a later commit deletes the offending file', () => {
    const { git, put, check } = repo();
    put('config.private.json', 'fixture-only'); git('add', '.'); git('commit', '-qm', 'Old private path');
    const first = git('rev-parse', 'HEAD'); git('rm', 'config.private.json'); put('README.md', 'Public'); git('add', '.'); git('commit', '-qm', 'Remove private path');
    const head = git('rev-parse', 'HEAD');
    expect(check('--push', head, zero, '--no-gitleaks').status).toBe(1);
    expect(check('--push', head, first, '--no-gitleaks').status).toBe(0);
  });

  it('rejects a personal author email and unsafe message but permits GitHub noreply metadata', () => {
    const { git, put, check, root } = repo(); put('README.md', 'Public'); git('add', '.'); git('commit', '-qm', 'Public snapshot');
    expect(check('--push', git('rev-parse', 'HEAD'), zero, '--no-gitleaks').status).toBe(0);
    git('config', 'user.email', 'person@personal.test'); put('README.md', 'Next'); git('add', '.'); git('commit', '-qm', 'Another');
    expect(check('--push', git('rev-parse', 'HEAD'), zero, '--no-gitleaks').stderr).toContain('personal_email');
    put('message.txt', 'See https://chatgpt.com/c/' + '12345678-1234-1234-1234-123456789abc');
    expect(check('--commit-message', path.join(root, 'message.txt'), '--no-gitleaks').stderr).toContain('private_chat_session');
  });

  it('allows public-certificate and reserved-address fixtures, but detects actual private addresses outside tests', () => {
    const { git, put, check } = repo();
    put('.env.example', 'HOST=192.0.2.1\n'); put('public.pem', '-----BEGIN CERTIFICATE-----\nsynthetic-public\n-----END CERTIFICATE-----');
    put('docs/example.md', '198.51.100.1 and 203.0.113.2 /Users/fixture/example'); put('tests/example.ts', 'const host = "10.0.0.7";');
    git('add', '.'); expect(check('--tracked', '--no-gitleaks').status).toBe(0);
    put('docs/private.md', 'host ' + [192, 168, 77, 9].join('.')); git('add', '.'); expect(check('--tracked', '--no-gitleaks').stderr).toContain('private_address');
  });

  it('matches known private JSON and Markdown values without echoing them', () => {
    const { git, put, check, root } = repo();
    const secret = ['synthetic', 'sensitive', 'value'].join('-');
    const identity = ['fixture', 'account', 'private'].join('-');
    put('outside.json', JSON.stringify({ credentials: { token: secret, username: 'ab' } })); put('outside.md', `account: ${identity}\n`);
    put('.privacy.local.json', JSON.stringify({ privateFiles: [path.join(root, 'outside.json'), path.join(root, 'outside.md')] }));
    put('README.md', `${secret} ${identity}`); git('add', 'README.md');
    const result = check('--staged', '--no-gitleaks'); expect(result.status).toBe(1); expect(result.stderr).toContain('known_private_value'); expect(result.stderr).not.toContain(secret); expect(result.stderr).not.toContain(identity);
    put('README.md', 'ab'); git('add', 'README.md'); expect(check('--staged', '--no-gitleaks').status).toBe(0);
  });

  it('blocks key material and GitHub tokens with redacted rule-only output', () => {
    const { git, put, check } = repo();
    const marker = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
    const token = 'ghp_' + 'A'.repeat(36);
    put('notes.txt', `${marker}\n${token}`); git('add', '.');
    const result = check('--staged', '--no-gitleaks');
    expect(result.status).toBe(1); expect(result.stderr).toContain('private_key'); expect(result.stderr).toContain('github_token');
    expect(result.stderr).not.toContain(marker); expect(result.stderr).not.toContain(token);
  });

  it('fails closed for an unreadable registered private-values file', () => {
    const { root, git, put, check } = repo();
    put('.privacy.local.json', JSON.stringify({ privateFiles: [path.join(root, 'missing-private-file')] }));
    put('README.md', 'Public'); git('add', 'README.md');
    expect(check('--staged', '--no-gitleaks').stderr).toContain('private_values_unreadable');
  });

  it('fails closed when gitleaks is unavailable and rejects invalid push object names', () => {
    const { git, put, check } = repo(); put('README.md', 'Public'); git('add', '.');
    git('config', 'view.gitleaksPath', '/missing/view-test-gitleaks');
    expect(check('--staged').stderr).toContain('scanner_unavailable');
    expect(check('--push', 'HEAD; echo unsafe', zero, '--no-gitleaks').stderr).toContain('inspection_failed');
  });
});
