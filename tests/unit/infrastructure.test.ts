import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { ServiceSchema } from '../../src/shared/contracts.js';
import { selectPanelBusinessItems } from '../../src/renderer/status-helpers.js';
import { StatusManager } from '../../src/main/status/manager.js';
import { StatusRecordSchema } from '../../src/shared/status.js';
import { InfrastructureStatusAdapter, infrastructureRecords } from '../../src/main/status/infrastructure.js';
import { INFRASTRUCTURE_PYTHON, InfrastructureSourceSchema, AcmeSourceSchema, OpenrestySourceSchema, type RegisteredInfrastructureSource } from '../../src/main/transport/infrastructure.js';
import { TransportError, type DockerTransport } from '../../src/main/transport/types.js';

const target = { containerId: 'a'.repeat(64), imageId: `sha256:${'b'.repeat(64)}` };
const peer = { nodeId: 'node-demo', ip: '100.64.0.1', alias: 'Mac mini' };
const tailscale: RegisteredInfrastructureSource = { kind: 'tailscale_status', profileId: 'nas', sourceRef: 'network', target, peer };
const raw = { kind: 'tailscale_status' as const, complete: true, data: { backendState: 'Running', selfOnline: true, peerFound: true, peerOnline: true, healthCount: 0, probe: { outcome: 'success', latencyMs: 312 } } };
const probe = { siteId: 2, alias: '登记代理入口', serverName: 'observer.example.test', port: 443 };
const certificate = { id: 'primary', alias: '主服务证书', databaseId: 2, managedRelative: 'observer.example.test_ecc/fullchain.cer', deployedRelative: '2.crt' };
const acme = AcmeSourceSchema.parse({ kind: 'acme_certificates', profileId: 'nas', sourceRef: 'cert', target, manager: target, certificates: [certificate], probe });
const proxy = OpenrestySourceSchema.parse({ kind: 'openresty_status', profileId: 'nas', sourceRef: 'proxy', target, siteIds: [2, 3], probe });
// Synthetic public certificate only; no private key or user infrastructure.
const pem = readFileSync(new URL('./fixtures/observer-public-cert.pem', import.meta.url));
const cert = new X509Certificate(pem);
const now = new Date(Date.parse(cert.validFrom) + 86400000);
const b64 = pem.toString('base64');
const served = { reachable: true, der: cert.raw.toString('base64'), trustVerified: false };
const acmeRead = () => ({ kind: 'acme_certificates' as const, complete: true, data: { certificates: [{ id: 'primary', managed: { pem: b64 }, deployed: { pem: b64 }, database: { error: 'missing' } }], served, renewal: { outcome: 'observed', latest: { outcome: 'not_due', checkedAt: '2026-10-21T04:24:04.540249104Z', nextEligibleAt: '2026-11-18T08:51:38Z' }, issuance: null } } });

it('keeps peer online separate from a real TSMP result and never exposes the private target', () => {
  const rows = infrastructureRecords(tailscale, { ...raw, data: { ...raw.data, probe: { outcome: 'not_probed' } } }, now);
  expect(rows[0]!.outcome).toBe('unknown');
  expect(rows[0]!.summary).toContain('本轮未探测');
  const success = infrastructureRecords(tailscale, raw, now);
  expect(success[0]!.summary).toContain('312ms');
  expect(success[0]!.facts.applicationVerified).toBe(false);
  for (const value of [peer.ip, peer.nodeId, target.containerId]) expect(JSON.stringify(success)).not.toContain(value);
  for (const row of success) expect(StatusRecordSchema.safeParse({ ...row, serviceId: 'demo' }).success).toBe(true);
});

it('shows in-use expiry, file agreement and unknown renewal separately', () => {
  const rows = infrastructureRecords(acme, acmeRead(), now);
  expect(rows[0]!.outcome).toBe('succeeded');
  expect(rows[0]!.facts.trustVerified).toBe(false);
  expect(rows[1]!.summary).toContain('管理库证书未读到');
  expect(rows[2]!.summary).toContain('已跳过');
  expect(rows[2]!.occurredAt).toBe('2026-10-21T04:24:04.540Z');
  expect(rows[2]!.evidenceKind).toBe('stage_receipt');
  expect(rows[3]!.outcome).toBe('unknown');
  expect(rows[3]!.facts.renewalSucceeded).toBe(null);
  expect(JSON.stringify(rows)).not.toContain(probe.serverName);
  expect(JSON.stringify(rows)).not.toContain('BEGIN CERTIFICATE');
  for (const row of rows) expect(StatusRecordSchema.safeParse({ ...row, serviceId: 'demo' }).success).toBe(true);
});

it('cannot substitute a valid file for failed served-certificate inspection, expired or wrong-host certificates', () => {
  const read = acmeRead(); read.data.served = { ...served, reachable: false, der: '' };
  expect(infrastructureRecords(acme, read, now)[0]!.outcome).toBe('unknown');
  expect(infrastructureRecords(acme, acmeRead(), new Date(Date.parse(cert.validTo) + 1))[0]!.summary).toContain('已过期');
  expect(infrastructureRecords({ ...acme, probe: { ...probe, serverName: 'wrong.example.test' } }, acmeRead(), now)[0]!.summary).toContain('域名不匹配');
});

it('does not turn limited proxy file errors or configuration counts into an upstream outage', () => {
  const rows = infrastructureRecords(proxy, { kind: 'openresty_status', complete: true, data: { siteCount: 2, upstreamCount: 7, served, errors: { available: true, timezoneOffset: '+0000', samples: [{ at: '2026/10/22 01:41:31', kind: 'file_not_found' }] } } }, now);
  expect(rows[1]!.facts.allUpstreamsVerified).toBe(false);
  expect(rows[2]!.summary).toContain('文件不存在 1 条');
  expect(rows[2]!.summary).toContain('不代表全部站点故障');
  expect(rows[2]!.occurredAt).toBe('2026-10-22T01:41:31.000Z');
});

it('rejects traversal, undeclared targets, multiple certificate scopes and unsafe peers', () => {
  expect(InfrastructureSourceSchema.safeParse({ ...acme, certificates: [{ ...certificate, managedRelative: '../secret.pem' }] }).success).toBe(false);
  expect(InfrastructureSourceSchema.safeParse({ ...acme, certificates: [certificate, certificate] }).success).toBe(false);
  expect(InfrastructureSourceSchema.safeParse({ ...tailscale, peer: { ...peer, ip: '127.0.0.1' } }).success).toBe(false);
  expect(() => infrastructureRecords(proxy, raw, now)).toThrow();
});

it('shares one in-flight read, caches actual observation time for 60 seconds and releases its lease', async () => {
  const readInfrastructure = vi.fn(async () => raw); const release = vi.fn();
  const adapter = new InfrastructureStatusAdapter(async () => tailscale, async () => ({ transport: { readInfrastructure } as unknown as DockerTransport, release }));
  const [a, b] = await Promise.all([adapter.readSnapshots('nas', 'network', 'tailscale_status', undefined, now), adapter.readSnapshots('nas', 'network', 'tailscale_status', undefined, now)]);
  expect(a).toEqual(b); expect(readInfrastructure).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
  const cached = await adapter.readSnapshots('nas', 'network', 'tailscale_status', undefined, new Date(now.getTime() + 30_000));
  expect(cached.lastSuccessAt).toBe(now.toISOString()); expect(readInfrastructure).toHaveBeenCalledTimes(1);
  await adapter.readSnapshots('nas', 'network', 'tailscale_status', undefined, new Date(now.getTime() + 60_000));
  expect(readInfrastructure).toHaveBeenCalledTimes(2);
});

it('keeps timeout, missing source and malformed response distinct without returning raw exceptions', async () => {
  const readInfrastructure = vi.fn(async () => { throw new TransportError('timeout', 'private-address-and-secret'); });
  const release = vi.fn(); const acquire = async () => ({ transport: { readInfrastructure } as unknown as DockerTransport, release });
  const adapter = new InfrastructureStatusAdapter(async () => tailscale, acquire);
  expect((await adapter.readSnapshots('nas', 'network', 'tailscale_status', undefined, now)).errorCode).toBe('status_timeout');
  expect(release).toHaveBeenCalledTimes(1);
  const missing = new InfrastructureStatusAdapter(async () => null, acquire);
  expect((await missing.readSnapshots('nas', 'network', 'tailscale_status', undefined, now)).errorCode).toBe('status_source');
  const malformed = new InfrastructureStatusAdapter(async () => tailscale, async () => ({ transport: { readInfrastructure: async () => ({ ...raw, data: {} }) } as unknown as DockerTransport, release }));
  expect((await malformed.readSnapshots('nas', 'network', 'tailscale_status', undefined, now)).errorCode).toBe('status_schema');
});

it('compiles the fixed remote Python and uses bounded output, public certificate projections and readonly SQLite', () => {
  expect(() => execFileSync('python3', ['-c', 'import sys;compile(sys.stdin.read(),"infra","exec")'], { input: INFRASTRUCTURE_PYTHON })).not.toThrow();
  expect(INFRASTRUCTURE_PYTHON).toContain('query_only=ON');
  expect(INFRASTRUCTURE_PYTHON).toContain('selectors.DefaultSelector');
  expect(INFRASTRUCTURE_PYTHON).not.toMatch(/SELECT\s+(?:\*|key|dns_credential)/i);
});

it('distinguishes a failed renewal-log read from a successfully read empty window', () => {
  const empty = acmeRead();
  empty.data.renewal = { outcome: 'no_record', latest: null, issuance: null } as unknown as typeof empty.data.renewal;
  const missing = infrastructureRecords(acme, empty, now);
  expect(missing[2]!.summary).toContain('没有可确认');
  expect(missing[3]!.summary).toContain('没有明确续期成功记录');
  const failed = { ...empty, data: { ...empty.data, renewal: { outcome: 'unknown', error: 'source' } } };
  const rows = infrastructureRecords(acme, failed, now);
  expect(rows[2]!.summary).toBe('续期日志读取失败，无法判断最近检查结果');
  expect(rows[3]!.summary).toBe('续期日志读取失败，无法判断续期是否成功');
  expect(rows.slice(2).every((row) => row.outcome === 'unknown' && row.occurredAt === null)).toBe(true);
});

it('keeps identical facts stable across polling but changes identity when connectivity or certificate validity changes', () => {
  const original = infrastructureRecords(tailscale, raw, now);
  const repeat = infrastructureRecords(tailscale, raw, new Date(now.getTime() + 60_000));
  expect(repeat.map((row) => row.id)).toEqual(original.map((row) => row.id));
  const changed = infrastructureRecords(tailscale, { ...raw, data: { ...raw.data, probe: { outcome: 'failed' } } }, new Date(now.getTime() + 60_000));
  expect(changed[0]!.id).not.toBe(original[0]!.id);
  expect(changed[1]!.id).toBe(original[1]!.id);
  const valid = infrastructureRecords(acme, acmeRead(), now);
  const expired = infrastructureRecords(acme, acmeRead(), new Date(Date.parse(cert.validTo) + 1));
  expect(expired[0]!.id).not.toBe(valid[0]!.id);
  expect(expired[0]!.outcome).toBe('failed');
});

it('raises the Python alarm through finally and reaps the reader-owned hanging child', () => {
  const prefix = INFRASTRUCTURE_PYTHON.split('\ntry:\n t=target')[0]!;
  const fixture = `${prefix}
owned=[]
original_popen=subprocess.Popen
def recording_popen(*args,**kwargs):
 p=original_popen(*args,**kwargs);owned.append(p);return p
subprocess.Popen=recording_popen
signal.setitimer(signal.ITIMER_REAL,.12)
try:
 run([sys.executable,'-c','import time;time.sleep(2)'],seconds=2)
 raise AssertionError('expected_timeout')
except TimeoutError:
 signal.setitimer(signal.ITIMER_REAL,0)
 assert len(owned)==1 and owned[0].poll() is not None
 print('owned_child_reaped')
`;
  expect(execFileSync('python3', ['-c', fixture, '{}', '2', 'docker'], { timeout: 3_000, encoding: 'utf8' }).trim()).toBe('owned_child_reaped');
});

it('retains a changed connectivity result through manager deduplication without appending identical polls', async () => {
  let result = raw;
  const adapter = new InfrastructureStatusAdapter(async () => tailscale, async () => ({ transport: { readInfrastructure: async () => result } as unknown as DockerTransport, release: () => undefined }));
  const manager = new StatusManager({ resolveEndpoint: async () => undefined, createInfrastructureReader: () => adapter });
  const service = ServiceSchema.parse({ id: 'network-service', name: '组网', category: '组网', bindings: [], businessAdapter: { kind: 'none' }, statusAdapter: { kind: 'tailscale_status', profileId: 'nas', sourceRef: 'network' } });
  await manager.readConfigured([service], now);
  await manager.readConfigured([service], new Date(now.getTime() + 60_000));
  expect(manager.page(service.id, undefined).records).toHaveLength(2);
  result = { ...raw, data: { ...raw.data, probe: { outcome: 'failed', latencyMs: 0 } } };
  await manager.readConfigured([service], new Date(now.getTime() + 120_000));
  const page = manager.page(service.id, undefined);
  expect(page.records).toHaveLength(3);
  expect(selectPanelBusinessItems(page.records, 3).find((item) => item.record.stage === '组网连通')?.record.outcome).toBe('failed');
  expect(page.feeds[0]!.lastSuccessAt).toBe(new Date(now.getTime() + 120_000).toISOString());
  result = raw;
  const restoredAt = new Date(now.getTime() + 180_000);
  await manager.readConfigured([service], restoredAt);
  const restored = manager.page(service.id, undefined);
  expect(restored.records).toHaveLength(3);
  const current = selectPanelBusinessItems(restored.records, 3).filter((item) => item.record.stage === '组网连通');
  expect(current).toHaveLength(1);
  expect(current[0]!.record.outcome).toBe('succeeded');
  expect(current[0]!.record.observedAt).toBe(restoredAt.toISOString());
  expect(current[0]!.summary).toContain('TSMP 连通');
});
