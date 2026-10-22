import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { StatusSourceSummarySchema, type StatusSourceSummary } from '../../shared/status.js';
import { TailscaleSourceSchema, AcmeSourceSchema, OpenrestySourceSchema, type InfrastructureKind, type RegisteredInfrastructureSource } from '../transport/infrastructure.js';
import type { RagflowDocumentsSource } from '../transport/ragflow-documents.js';

const SourceRef = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const ProfileId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const PrivatePath = z.string().min(1).max(1024).refine((value) => path.isAbsolute(value)).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const PrivateBearerSchema = z.object({
  schemaVersion: z.literal(1),
  bearerToken: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/),
}).strict();
const RagflowTargetSchema = z.object({
  containerId: z.string().regex(/^[a-f0-9]{64}$/),
  ip: z.string().min(1).max(64).regex(/^[0-9a-fA-F:.]+$/),
  port: z.number().int().min(1).max(65535),
  network: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
  hostHeader: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/).optional(),
}).strict();
const RagflowDatasetSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  name: z.string().trim().min(1).max(160),
  displayAlias: z.string().trim().min(1).max(64).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)).optional(),
  scope: z.enum(['work_knowledge_base', 'personal_clips', 'excluded']),
}).strict();
const QuantPgTargetSchema = z.object({
  containerId: z.string().regex(/^[a-f0-9]{64}$/),
  ip: z.string().min(1).max(64).regex(/^[0-9a-fA-F:.]+$/),
  port: z.number().int().min(1).max(65535),
  network: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
  composeProject: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
  composeService: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
}).strict();
const QuantPgCredentialSchema = z.object({
  schemaVersion: z.literal(1),
  database: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
  username: z.string().regex(/^[\x21-\x7e]{1,128}$/),
  password: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/),
}).strict();
const QuantPgSourceSchema = z.object({
  sourceRef: SourceRef,
  profileId: ProfileId,
  kind: z.literal('quant_pg_receipts'),
  displayName: z.string().trim().min(1).max(160).optional(),
  target: QuantPgTargetSchema,
  credentialRef: PrivatePath,
  scanIds: z.array(SourceRef).max(40).default([]),
  taskNames: z.array(z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9_.:-]+$/)).max(40).default([]),
  allowRecent: z.boolean().default(false),
  // This explicit marker is required before an empty task allowlist can use
  // the bounded recent-record branch. It records the WP-014 deployment proof
  // that this private database is the single Quant business scope.
  scope: z.literal('single_quant_database').optional(),
}).strict();
const ArticleSourceSchema = z.object({
  sourceRef: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  profileId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  kind: z.literal('article_receipt_json'),
  displayName: z.string().trim().min(1).max(160).optional(),
  rootPath: PrivatePath,
}).strict();
const RagflowSourceSchema = z.object({
  sourceRef: SourceRef,
  profileId: ProfileId,
  kind: z.literal('ragflow_documents'),
  displayName: z.string().trim().min(1).max(160).optional(),
  target: RagflowTargetSchema,
  privateBearerRef: PrivatePath,
  datasetScope: z.array(RagflowDatasetSchema).min(1).max(8),
}).strict();
const PrivateSourceSchema = z.discriminatedUnion('kind', [ArticleSourceSchema, RagflowSourceSchema, QuantPgSourceSchema, TailscaleSourceSchema, AcmeSourceSchema, OpenrestySourceSchema]);

const PrivateSourceFileSchema = z.object({
  schemaVersion: z.literal(1),
  sources: z.array(PrivateSourceSchema).max(8),
}).strict();

export type RegisteredArticleReceiptSource = {
  sourceRef: string;
  profileId: string;
  rootPath: string;
};

export type RegisteredRagflowDocumentsSource = {
  sourceRef: string;
  profileId: string;
  displayName: string;
  source: RagflowDocumentsSource;
  datasetAliases: ReadonlyMap<string, string>;
};

export type RegisteredQuantPgSource = {
  sourceRef: string;
  profileId: string;
  displayName: string;
  target: z.infer<typeof QuantPgTargetSchema>;
  credential: z.infer<typeof QuantPgCredentialSchema>;
  scanIds: readonly string[];
  taskNames: readonly string[];
  allowRecent: boolean;
  scopeVerified: boolean;
};

/**
 * Main-process-only source registry. The file contains the remote root, so it
 * never crosses the IPC boundary and is intentionally not part of AppConfig.
 */
export class StatusSourceRegistry {
  private readonly filePath: string;
  private sources: z.infer<typeof PrivateSourceSchema>[] = [];
  private loaded = false;

  constructor(private readonly root: string, private readonly profileExists: (profileId: string) => boolean) {
    this.filePath = path.join(root, 'status-sources.private.json');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = PrivateSourceFileSchema.safeParse(JSON.parse(await readFile(this.filePath, 'utf8')));
      if (!parsed.success) return;
      this.sources = parsed.data.sources;
    } catch {
      this.sources = [];
    }
  }

  async resolveArticle(profileId: string, sourceRef: string): Promise<RegisteredArticleReceiptSource | null> {
    await this.load();
    const source = this.sources.find((item): item is z.infer<typeof ArticleSourceSchema> => item.kind === 'article_receipt_json' && item.sourceRef === sourceRef && item.profileId === profileId && this.profileExists(profileId));
    if (!source) return null;
    return { sourceRef: source.sourceRef, profileId: source.profileId, rootPath: source.rootPath };
  }

  async resolveRagflow(profileId: string, sourceRef: string): Promise<RegisteredRagflowDocumentsSource | null> {
    await this.load();
    const source = this.sources.find((item): item is z.infer<typeof RagflowSourceSchema> => item.kind === 'ragflow_documents' && item.sourceRef === sourceRef && item.profileId === profileId && this.profileExists(profileId));
    if (!source) return null;
    const bearerToken = await this.readBearer(source.privateBearerRef);
    if (!bearerToken) return null;
    const scoped = source.datasetScope.filter((dataset) => dataset.scope !== 'excluded');
    if (scoped.length === 0) return null;
    return {
      sourceRef: source.sourceRef,
      profileId: source.profileId,
      displayName: source.displayName ?? source.sourceRef,
      source: {
        sourceRef: source.sourceRef,
        target: {
          containerId: source.target.containerId,
          ip: source.target.ip,
          port: source.target.port,
          network: source.target.network,
          ...(source.target.hostHeader ? { hostHeader: source.target.hostHeader } : {}),
        },
        bearerToken,
        datasetIds: scoped.map((dataset) => dataset.id),
      },
      datasetAliases: new Map(source.datasetScope.map((dataset) => [dataset.id, dataset.displayAlias ?? dataset.name])),
    };
  }

  async resolveQuant(profileId: string, sourceRef: string): Promise<RegisteredQuantPgSource | null> {
    await this.load();
    const source = this.sources.find((item): item is z.infer<typeof QuantPgSourceSchema> => item.kind === 'quant_pg_receipts' && item.sourceRef === sourceRef && item.profileId === profileId && this.profileExists(profileId));
    if (!source) return null;
    const credential = await this.readQuantCredential(source.credentialRef);
    if (!credential) return null;
    return {
      sourceRef: source.sourceRef,
      profileId: source.profileId,
      displayName: source.displayName ?? source.sourceRef,
      target: source.target,
      credential,
      scanIds: source.scanIds,
      taskNames: source.taskNames,
      allowRecent: source.allowRecent,
      scopeVerified: source.scope === 'single_quant_database',
    };
  }

  async resolveInfrastructure(profileId: string, sourceRef: string, kind: InfrastructureKind): Promise<RegisteredInfrastructureSource | null> {
    await this.load();
    if (!this.profileExists(profileId)) return null;
    return this.sources.find((item): item is RegisteredInfrastructureSource => item.kind === kind && item.sourceRef === sourceRef && item.profileId === profileId) ?? null;
  }

  async summaries(): Promise<StatusSourceSummary[]> {
    await this.load();
    return this.sources
      .filter((source) => this.profileExists(source.profileId))
      .map((source) => StatusSourceSummarySchema.parse({
        sourceRef: source.sourceRef,
        profileId: source.profileId,
        kind: source.kind,
        displayName: source.displayName ?? source.sourceRef,
      }));
  }

  private async readBearer(filePath: string): Promise<string | null> {
    try {
      const metadata = await stat(filePath);
      if ((metadata.mode & 0o077) !== 0) return null;
      const parsed = PrivateBearerSchema.safeParse(JSON.parse(await readFile(filePath, 'utf8')));
      return parsed.success ? parsed.data.bearerToken : null;
    } catch {
      return null;
    }
  }

  private async readQuantCredential(filePath: string): Promise<z.infer<typeof QuantPgCredentialSchema> | null> {
    try {
      const metadata = await stat(filePath);
      if ((metadata.mode & 0o077) !== 0) return null;
      const parsed = QuantPgCredentialSchema.safeParse(JSON.parse(await readFile(filePath, 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
