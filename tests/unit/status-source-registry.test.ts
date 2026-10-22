import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StatusSourceRegistry } from '../../src/main/status/source-registry.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('private status source registry', () => {
  it('exposes only safe summaries while resolving a registered private root in main', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-status-sources-'));
    roots.push(root);
    const privateRoot = path.join(root, 'remote-receipts');
    await writeFile(path.join(root, 'status-sources.private.json'), JSON.stringify({
      schemaVersion: 1,
      sources: [{ sourceRef: 'article-receipts', profileId: 'nas-profile', kind: 'article_receipt_json', displayName: '论文回执', rootPath: privateRoot }],
    }), { mode: 0o600 });

    const registry = new StatusSourceRegistry(root, (profileId) => profileId === 'nas-profile');
    await expect(registry.resolveArticle('nas-profile', 'article-receipts')).resolves.toEqual({
      sourceRef: 'article-receipts',
      profileId: 'nas-profile',
      rootPath: privateRoot,
    });
    const summaries = await registry.summaries();
    expect(summaries).toEqual([{ sourceRef: 'article-receipts', profileId: 'nas-profile', kind: 'article_receipt_json', displayName: '论文回执' }]);
    expect(JSON.stringify(summaries)).not.toContain(privateRoot);
  });

  it('does not resolve an unknown profile or malformed private registry', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-status-sources-'));
    roots.push(root);
    await writeFile(path.join(root, 'status-sources.private.json'), JSON.stringify({
      schemaVersion: 1,
      sources: [{ sourceRef: 'article-receipts', profileId: 'missing', kind: 'article_receipt_json', rootPath: '/private/remote' }],
    }), { mode: 0o600 });
    const registry = new StatusSourceRegistry(root, () => false);
    await expect(registry.resolveArticle('missing', 'article-receipts')).resolves.toBeNull();
    await expect(registry.summaries()).resolves.toEqual([]);

    await writeFile(path.join(root, 'status-sources.private.json'), '{"schemaVersion":2}');
    const freshRegistry = new StatusSourceRegistry(root, () => true);
    await expect(freshRegistry.summaries()).resolves.toEqual([]);
  });

  it('resolves only the registered RAGFlow target, bearer file, and named user scopes in main', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-status-ragflow-'));
    roots.push(root);
    const bearerPath = path.join(root, 'ragflow-bearer.private.json');
    await writeFile(bearerPath, JSON.stringify({ schemaVersion: 1, bearerToken: 'private-bearer' }), { mode: 0o600 });
    await chmod(bearerPath, 0o600);
    await writeFile(path.join(root, 'status-sources.private.json'), JSON.stringify({
      schemaVersion: 1,
      sources: [{
        sourceRef: 'ragflow-knowledge',
        profileId: 'nas-profile',
        kind: 'ragflow_documents',
        displayName: 'RAGFlow知识库',
        target: { containerId: 'a'.repeat(64), ip: '10.0.0.7', port: 80, network: 'ragflow_default', hostHeader: '10.0.0.1' },
        privateBearerRef: bearerPath,
        datasetScope: [
          { id: 'dataset-test', name: 'PerClip test', displayAlias: '测试集', scope: 'excluded' },
          { id: 'dataset-personal', name: 'PersonalClips', displayAlias: '个人剪藏', scope: 'personal_clips' },
          { id: 'dataset-work', name: 'WorkKnowledgeBase', displayAlias: '工作知识库', scope: 'work_knowledge_base' },
        ],
      }],
    }), { mode: 0o600 });
    const registry = new StatusSourceRegistry(root, (profileId) => profileId === 'nas-profile');
    const resolved = await registry.resolveRagflow('nas-profile', 'ragflow-knowledge');
    expect(resolved).toMatchObject({
      sourceRef: 'ragflow-knowledge',
      profileId: 'nas-profile',
      source: {
        sourceRef: 'ragflow-knowledge',
        target: { containerId: 'a'.repeat(64), ip: '10.0.0.7', port: 80, network: 'ragflow_default', hostHeader: '10.0.0.1' },
        bearerToken: 'private-bearer',
        datasetIds: ['dataset-personal', 'dataset-work'],
      },
    });
    expect([...resolved!.datasetAliases.entries()]).toEqual([
      ['dataset-test', '测试集'],
      ['dataset-personal', '个人剪藏'],
      ['dataset-work', '工作知识库'],
    ]);
    const summaries = await registry.summaries();
    expect(summaries).toEqual([{ sourceRef: 'ragflow-knowledge', profileId: 'nas-profile', kind: 'ragflow_documents', displayName: 'RAGFlow知识库' }]);
    expect(JSON.stringify(summaries)).not.toContain('private-bearer');
  });
});

describe('infrastructure registered source boundaries', () => {
  it('resolves only a matching kind/profile/reference and exposes no private target fields', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-infrastructure-'));
    roots.push(root);
    const target = { containerId: 'a'.repeat(64), imageId: `sha256:${'b'.repeat(64)}` };
    const probe = { siteId: 1, alias: '公开入口', serverName: 'example.invalid', port: 443 };
    const sources = [
      { sourceRef: 'network', profileId: 'nas', kind: 'tailscale_status', displayName: '组网', target, peer: { nodeId: 'peer-fixture', ip: '100.64.0.2', alias: '固定对端' } },
      { sourceRef: 'certificates', profileId: 'nas', kind: 'acme_certificates', target, manager: target, certificates: [{ id: 'cert-1', alias: '入口证书', managedRelative: 'example/fullchain.cer', deployedRelative: 'example/fullchain.pem', databaseId: 1 }], probe },
      { sourceRef: 'proxy', profileId: 'nas', kind: 'openresty_status', target, siteIds: [1], probe },
    ];
    await writeFile(path.join(root, 'status-sources.private.json'), JSON.stringify({ schemaVersion: 1, sources }), { mode: 0o600 });
    const registry = new StatusSourceRegistry(root, (profileId) => profileId === 'nas');
    for (const source of sources) {
      await expect(registry.resolveInfrastructure('nas', source.sourceRef, source.kind as 'tailscale_status' | 'acme_certificates' | 'openresty_status')).resolves.toEqual(source);
    }
    await expect(registry.resolveInfrastructure('nas', 'network', 'openresty_status')).resolves.toBeNull();
    await expect(registry.resolveInfrastructure('other', 'network', 'tailscale_status')).resolves.toBeNull();
    const summaries = await registry.summaries();
    expect(summaries).toHaveLength(3);
    expect(Object.keys(summaries[0]!).sort()).toEqual(['displayName', 'kind', 'profileId', 'sourceRef']);
    const serialized = JSON.stringify(summaries);
    for (const hidden of ['containerId', 'imageId', 'peer-fixture', '100.64.0.2', 'example.invalid', 'fullchain']) expect(serialized).not.toContain(hidden);
  });
});
