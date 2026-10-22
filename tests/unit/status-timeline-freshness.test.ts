import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { StatusTimeline } from '../../src/renderer/components/StatusTimeline.js';
import type { StatusPage } from '../../src/shared/status.js';

function page(): StatusPage {
  return { serviceId: 'demo', records: [0, 1].map((index) => ({ id: `event-${index}`, serviceId: 'demo', sourceRef: 'http_json:demo', taskKey: `task-${index}`, stage: '完成', outcome: 'succeeded', summary: `历史任务${index}已完成`, occurredAt: `2026-10-${19 - index}T03:00:00.000Z`, sourceAt: null, observedAt: '2026-10-22T03:01:00.000Z', evidenceKind: 'business_event', facts: {}, evidenceRef: null })), nextCursor: null, hasMore: false, feeds: [{ sourceRef: 'http_json:demo', health: 'fresh', lastSuccessAt: '2026-10-22T03:01:00.000Z', observedAt: '2026-10-22T03:01:00.000Z', cursor: null, hasMore: false, gap: false, errorCode: null }] };
}

it('shows collection time independently of an old successful event', () => {
  const html = renderToStaticMarkup(createElement(StatusTimeline, { page: page(), mode: 'panel', statusAdapterKind: 'http_json' }));
  expect(html).toContain('最近采集：');
  expect(html).toContain('dateTime="2026-10-22T03:01:00.000Z"');
  expect(html).toContain('dateTime="2026-10-19T03:00:00.000Z"');
  expect(html).toContain('历史 ·');
  expect(html).not.toContain('以下为上次结果');
});

it('puts a timeout warning before retained results and keeps last successful collection time', () => {
  const data = page();
  data.feeds[0] = { ...data.feeds[0]!, health: 'error', errorCode: 'status_timeout', observedAt: '2026-10-22T03:02:00.000Z' };
  const html = renderToStaticMarkup(createElement(StatusTimeline, { page: data, mode: 'panel', statusAdapterKind: 'http_json' }));
  expect(html).toContain('读取超时，以下为上次结果');
  expect(html.indexOf('读取超时')).toBeLessThan(html.indexOf('历史任务0'));
  expect(html).toContain('dateTime="2026-10-22T03:01:00.000Z"');
  expect(html).not.toContain('dateTime="2026-10-22T03:02:00.000Z"');
});

it('limits only the home preview while details retain history and no-success remains explicit', () => {
  const data = page();
  const preview = renderToStaticMarkup(createElement(StatusTimeline, { page: data, mode: 'panel', previewLimit: 1 }));
  expect(preview).toContain('历史任务0');
  expect(preview).not.toContain('历史任务1');
  const details = renderToStaticMarkup(createElement(StatusTimeline, { page: data, mode: 'detail' }));
  expect(details).toContain('历史任务1');
  data.records = [];
  data.feeds[0] = { ...data.feeds[0]!, health: 'error', errorCode: 'status_timeout', lastSuccessAt: null };
  const empty = renderToStaticMarkup(createElement(StatusTimeline, { page: data, mode: 'panel' }));
  expect(empty).toContain('尚未成功');
  expect(empty).toContain('读取超时，暂无可用结果');
});

it('does not call fresh aggregate statistics stale when only details time out', () => {
  const data = page();
  data.feeds[0] = { ...data.feeds[0]!, health: 'fresh', errorCode: 'status_timeout' };
  const html = renderToStaticMarkup(createElement(StatusTimeline, { page: data, mode: 'panel' }));
  expect(html).toContain('统计已更新；详情读取超时，历史明细为上次结果');
  expect(html).not.toContain('采集结果已过期');
});
