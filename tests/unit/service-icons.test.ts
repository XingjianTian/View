import { describe, expect, it } from 'vitest';
import { serviceIconKind } from '../../src/renderer/components/ServiceIcon.js';

describe('service identity icons', () => {
  it.each([
    ['基础设施', '基础设施', 'infrastructure'],
    ['论文下载', '论文', 'paper'],
    ['量化服务面板', '后台任务', 'chart'],
    ['定时任务', '后台任务', 'schedule'],
    ['论文下载隧道', '基础设施', 'tunnel'],
    ['后台任务', '后台任务', 'tasks'],
    ['RAG知识库', '知识库', 'knowledge'],
  ])('gives %s its own service identity', (name, category, kind) => {
    expect(serviceIconKind({ name: name!, category: category! })).toBe(kind);
  });
  it('uses category and adapter for newly named services and a neutral icon for unknown services', () => {
    expect(serviceIconKind({ name: '新服务', category: '知识库' })).toBe('knowledge');
    expect(serviceIconKind({ name: '新服务', category: '自定义', statusAdapter: { kind: 'ragflow_documents', profileId: 'fixture', sourceRef: 'fixture' } })).toBe('knowledge');
    expect(serviceIconKind({ name: '新服务', category: '自定义' })).toBe('service');
  });
});
