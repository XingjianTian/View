import { createHash, X509Certificate } from 'node:crypto';
import { z } from 'zod';
import { statusSourceRef, type StatusOutcome, type StatusRecord } from '../../shared/status.js';
import { INFRASTRUCTURE_LIMITS, InfrastructureSourceSchema, type InfrastructureKind, type InfrastructureRead, type RegisteredInfrastructureSource } from '../transport/infrastructure.js';
import { TransportError, type DockerTransport } from '../transport/types.js';
import type { QuantPgReadResult } from './quant-pg.js';

type RecordValue = Omit<StatusRecord, 'serviceId'>;
type Lease = { transport: DockerTransport; release: () => void | Promise<void> };
const PublicCertificate = z.object({ pem: z.string().max(48_000).optional(), error: z.string().max(32).optional(), reportedExpires: z.unknown().optional() });
const Served = z.object({ reachable: z.boolean(), der: z.string().max(48_000).optional(), error: z.enum(['timeout', 'tls_or_connection']).optional(), trustVerified: z.literal(false).optional(), protocol: z.string().max(32).nullable().optional() });
const DateValue = z.string().max(64).transform((value) => /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null);
const Renewal = z.object({ outcome: z.string().max(32), latest: z.object({ outcome: z.literal('not_due'), checkedAt: DateValue, nextEligibleAt: DateValue }).nullable().optional(), issuance: z.object({ outcome: z.literal('issuance_success'), occurredAt: DateValue }).nullable().optional(), error: z.string().max(32).optional() });
const TailscaleData = z.object({ backendState: z.string().max(64), selfOnline: z.boolean(), peerFound: z.boolean(), peerOnline: z.boolean().nullable(), healthCount: z.number().int().min(0).max(1000), probe: z.object({ outcome: z.enum(['success', 'failed', 'not_probed']), latencyMs: z.number().finite().min(0).max(60_000).nullable().optional() }) });
const AcmeData = z.object({ certificates: z.array(z.object({ id: z.string(), managed: PublicCertificate, deployed: PublicCertificate, database: PublicCertificate })).length(1), served: Served, renewal: Renewal });
const ErrorKind = z.enum(['upstream_timeout', 'connection_refused', 'tls', 'file_not_found', 'other_request_error']);
const ProxyData = z.object({ siteCount: z.number().int().min(0).max(16), upstreamCount: z.number().int().min(0).max(100_000), served: Served, errors: z.object({ available: z.boolean(), samples: z.array(z.object({ at: z.string().max(32), kind: ErrorKind })).max(80), timezoneOffset: z.string().nullable().optional() }) });

export class InfrastructureStatusAdapter {
  private readonly inFlight = new Map<string, Promise<QuantPgReadResult>>();
  private readonly cache = new Map<string, { at: number; result: QuantPgReadResult }>();
  constructor(
    private readonly resolveSource: (profileId: string, sourceRef: string, kind: InfrastructureKind) => Promise<RegisteredInfrastructureSource | null>,
    private readonly acquireTransport: (profileId: string) => Promise<Lease | null>,
  ) {}

  async readSnapshots(profileId: string, sourceRef: string, kind: InfrastructureKind, signal?: AbortSignal, now = new Date()): Promise<QuantPgReadResult> {
    const key = `${kind}:${profileId}:${sourceRef}`;
    const ref = statusSourceRef(kind, `${profileId}:${sourceRef}`);
    if (signal?.aborted) return failure(ref, now, 'status_timeout');
    const cached = this.cache.get(key);
    if (cached && now.getTime() - cached.at >= 0 && now.getTime() - cached.at < INFRASTRUCTURE_LIMITS.refreshMs) return cached.result;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const work = this.read(profileId, sourceRef, kind, signal, now);
    this.inFlight.set(key, work);
    try {
      const result = await work;
      if (!signal?.aborted) {
        if (this.cache.size >= 8 && !this.cache.has(key)) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { at: now.getTime(), result });
      }
      return result;
    } finally { if (this.inFlight.get(key) === work) this.inFlight.delete(key); }
  }

  private async read(profileId: string, sourceRef: string, kind: InfrastructureKind, external: AbortSignal | undefined, now: Date): Promise<QuantPgReadResult> {
    const ref = statusSourceRef(kind, `${profileId}:${sourceRef}`);
    const controller = new AbortController();
    const abort = () => controller.abort();
    external?.addEventListener('abort', abort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const holder: { lease: Lease | null } = { lease: null };
    const check = () => { if (controller.signal.aborted) throw new TransportError('timeout', '读取超时'); };
    const operation = async () => {
      const registered = await this.resolveSource(profileId, sourceRef, kind); check();
      if (!registered) throw new TransportError('profile_missing', '来源未登记');
      const source = InfrastructureSourceSchema.parse(registered);
      if (source.profileId !== profileId || source.sourceRef !== sourceRef || source.kind !== kind) throw new TransportError('profile_invalid', '来源不匹配');
      const acquired = await this.acquireTransport(profileId);
      if (controller.signal.aborted) { await acquired?.release(); check(); }
      holder.lease = acquired;
      const lease = acquired;
      if (!lease?.transport.readInfrastructure) throw new TransportError('profile_missing', '来源不支持');
      const raw = await lease.transport.readInfrastructure(source, controller.signal); check();
      const records = infrastructureRecords(source, raw, now);
      const at = now.toISOString();
      return { sourceRef: ref, observedAt: at, health: 'fresh' as const, lastSuccessAt: at, records, hasMore: false, gap: !raw.complete, errorCode: null };
    };
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new TransportError('timeout', '读取超时')); }, INFRASTRUCTURE_LIMITS.timeoutMs); }), new Promise<never>((_, reject) => { controller.signal.addEventListener('abort', () => reject(new TransportError('timeout', '读取超时')), { once: true }); })]);
    } catch (error) {
      const code = error instanceof TransportError ? error.code : '';
      return failure(ref, now, controller.signal.aborted || code === 'timeout' || code === 'cancelled' ? 'status_timeout' : code === 'sudo_denied' ? 'status_permission' : code === 'auth_failed' ? 'status_auth' : code === 'engine_unavailable' ? 'status_connection' : error instanceof z.ZodError || code === 'invalid_response' || code === 'profile_invalid' ? 'status_schema' : 'status_source');
    } finally {
      if (timer) clearTimeout(timer);
      external?.removeEventListener('abort', abort);
      await holder.lease?.release();
    }
  }
}

function failure(ref: string, now: Date, errorCode: NonNullable<QuantPgReadResult['errorCode']>): QuantPgReadResult {
  return { sourceRef: ref, observedAt: now.toISOString(), health: 'error', lastSuccessAt: null, records: [], hasMore: false, gap: true, errorCode };
}

/** All raw peer, domain, PEM, paths and exceptions stop at this projection. */
export function infrastructureRecords(source: RegisteredInfrastructureSource, read: InfrastructureRead, now: Date): RecordValue[] {
  if (read.kind !== source.kind) throw new TransportError('invalid_response', '来源类型不匹配');
  const ref = statusSourceRef(source.kind, `${source.profileId}:${source.sourceRef}`);
  const rows: RecordValue[] = [];
  const add = (id: string, stage: string, summary: string, outcome: StatusOutcome, facts: StatusRecord['facts'] = {}, occurredAt: string | null = null) => {
    const fingerprint = createHash('sha256').update(JSON.stringify({ stage, summary, outcome, facts, occurredAt })).digest('hex').slice(0, 16);
    rows.push({ id: `${source.kind}:${id}:${fingerprint}`, sourceRef: ref, taskKey: `${source.kind}:${id}`, stage, summary, outcome, facts: { ...facts, infrastructureSnapshot: true, displayOrder: rows.length }, occurredAt, sourceAt: null, observedAt: now.toISOString(), evidenceKind: occurredAt ? 'stage_receipt' : 'snapshot_diff', evidenceRef: null });
  };
  if (source.kind === 'tailscale_status') {
    const data = TailscaleData.parse(read.data);
    const daemon = data.backendState === 'Running' && data.selfOnline;
    const connected = data.probe.outcome === 'success';
    add('connectivity', '组网连通', connected ? `NAS → ${source.peer.alias}：TSMP 连通${data.probe.latencyMs == null ? '' : `，${Math.round(data.probe.latencyMs)}ms`}；应用端口未验证` : data.probe.outcome === 'failed' ? `NAS → ${source.peer.alias}：TSMP 探测失败；不能仅凭在线标志判定连通` : `NAS → ${source.peer.alias}：本轮未探测，实际连通尚未确认`, connected ? 'succeeded' : data.probe.outcome === 'failed' ? 'failed' : 'unknown', { probeLayer: 'TSMP', latencyMs: data.probe.latencyMs ?? null, applicationVerified: false });
    add('daemon', '组网状态', daemon ? `组网客户端在线；${data.healthCount ? `${data.healthCount} 项健康提示待检查` : '无客户端健康提示'}；登记对端${data.peerFound ? data.peerOnline ? '报告在线' : '报告离线' : '未找到'}` : '组网客户端未就绪或未报告在线，实际连通需核对', daemon && !data.healthCount ? 'succeeded' : 'partial', { selfOnline: data.selfOnline, peerOnline: data.peerOnline, healthCount: data.healthCount });
  } else if (source.kind === 'acme_certificates') {
    const data = AcmeData.parse(read.data); const cert = data.certificates[0]!;
    if (cert.id !== source.certificates[0]!.id) throw new TransportError('invalid_response', '证书身份不匹配');
    const managed = parseCertificate(cert.managed.pem); const deployed = parseCertificate(cert.deployed.pem); const database = parseCertificate(cert.database.pem);
    const served = parseCertificate(data.served.der, true);
    const current = certificateState(served, now, source.probe.serverName);
    add('certificate', '在用证书', data.served.reachable && served ? `${source.certificates[0]!.alias}：代理在用证书${current.label}；CA 信任链未验证` : '代理在用证书读取失败，不能以本地文件代替在用证书', data.served.reachable ? current.outcome : 'unknown', { expiresAt: served?.validTo ? new Date(served.validTo).toISOString() : null, daysRemaining: served ? Math.floor((Date.parse(served.validTo) - now.getTime()) / 86400000) : null, trustVerified: false });
    const same = !!managed && !!deployed && !!served && managed.fingerprint256 === deployed.fingerprint256 && deployed.fingerprint256 === served.fingerprint256;
    const databaseSame = !!database && !!served && database.fingerprint256 === served.fingerprint256;
    add('deployment', '部署核对', same ? `签发文件、部署文件与代理在用证书一致；${databaseSame ? '管理库记录一致' : database ? '管理库记录与在用证书不一致，需核对' : '管理库证书未读到'}` : '签发／部署／在用证书尚未全部一致或存在读取缺口，需核对', same && databaseSame ? 'succeeded' : 'partial', { fileDeploymentMatches: same, databaseMatches: databaseSame });
    const renewalReadFailed = !!data.renewal.error;
    const latest = renewalReadFailed ? null : data.renewal.latest;
    add('renewal-check', '续期检查', renewalReadFailed ? '续期日志读取失败，无法判断最近检查结果' : latest ? `最近检查：尚未到续期时间，已跳过；下次可续期：${displayDate(latest.nextEligibleAt)}（并非执行时间）` : '有限日志中没有可确认的最近续期检查记录', latest ? 'succeeded' : 'unknown', { nextEligibleAt: latest?.nextEligibleAt ?? null, renewalSucceeded: null, scope: 'single_registered_certificate' }, latest?.checkedAt ?? null);
    // Issuance is not proof that a scheduled renewal ran, deployed or reloaded.
    add('renewal-result', '续期结果', renewalReadFailed ? '续期日志读取失败，无法判断续期是否成功' : data.renewal.issuance ? '有限日志中发现签发成功记录；不能据此确认定时续期及部署成功' : '有限日志中没有明确续期成功记录；软件升级成功不计作证书续期', 'unknown', { renewalSucceeded: null }, renewalReadFailed ? null : data.renewal.issuance?.occurredAt ?? null);
  } else {
    const data = ProxyData.parse(read.data);
    const served = parseCertificate(data.served.der, true); const current = certificateState(served, now, source.probe.serverName);
    add('tls', '代理连通', data.served.reachable && served ? `${source.probe.alias}：TLS 握手成功，证书${current.label}；应用响应及 CA 信任链未验证` : `${source.probe.alias}：TLS 握手${data.served.error === 'timeout' ? '超时' : '失败'}；应用代理健康尚未确认`, data.served.reachable ? current.outcome : 'failed', { tlsReachable: data.served.reachable, applicationVerified: false, trustVerified: false });
    add('scope', '监测范围', `已读取 ${data.siteCount}/${source.siteIds.length} 个登记站点配置、${data.upstreamCount} 个上游配置；配置数量不代表上游正常`, data.siteCount === source.siteIds.length ? 'partial' : 'unknown', { configuredSites: data.siteCount, registeredSites: source.siteIds.length, upstreamCount: data.upstreamCount, allUpstreamsVerified: false });
    const counts = new Map<string, number>(); for (const item of data.errors.samples) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
    const names: Record<string, string> = { file_not_found: '文件不存在', upstream_timeout: '上游超时', connection_refused: '连接被拒绝', tls: 'TLS 错误', other_request_error: '其他请求错误' };
    const summary = [...counts].map(([kind, count]) => `${names[kind]} ${count} 条`).join('、');
    const last = data.errors.samples.at(-1); const occurredAt = proxyDate(last?.at, data.errors.timezoneOffset);
    add('request-errors', '请求错误样本', !data.errors.available ? '错误日志不可读；不能判断代理无异常' : summary ? `有限日志样本：${summary}；不代表全部站点故障` : '有限日志窗口未发现错误样本；不代表全部代理健康', data.errors.available ? summary ? 'partial' : 'unknown' : 'unknown', { sampleCount: data.errors.samples.length, window: 'last_16KiB_max80_lines', exhaustive: false }, occurredAt);
  }
  return rows;
}
function parseCertificate(encoded: string | undefined, der = false): X509Certificate | null {
  if (!encoded) return null;
  try { const data = Buffer.from(encoded, 'base64'); if (data.includes(Buffer.from('PRIVATE KEY'))) return null; return new X509Certificate(der ? data : data.toString('utf8')); } catch { return null; }
}
function certificateState(cert: X509Certificate | null, now: Date, host: string): { label: string; outcome: StatusOutcome } {
  if (!cert) return { label: '无法解析', outcome: 'unknown' };
  if (Date.parse(cert.validFrom) > now.getTime()) return { label: '尚未生效', outcome: 'failed' };
  if (Date.parse(cert.validTo) <= now.getTime()) return { label: `已过期（${displayDate(new Date(cert.validTo).toISOString())}）`, outcome: 'failed' };
  if (!cert.checkHost(host)) return { label: '域名不匹配', outcome: 'failed' };
  return { label: `有效，到期 ${displayDate(new Date(cert.validTo).toISOString())}`, outcome: Date.parse(cert.validTo) - now.getTime() < 30 * 86400000 ? 'partial' : 'succeeded' };
}
function displayDate(value: string | null): string { return value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '时间未确认'; }
function proxyDate(value: string | undefined, offset: string | null | undefined): string | null {
  if (!value || !offset || !/^[+-]\d{4}$/.test(offset) || !/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d$/.test(value)) return null;
  const parsed = Date.parse(value.replace(/\//g, '-').replace(' ', 'T') + offset); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
