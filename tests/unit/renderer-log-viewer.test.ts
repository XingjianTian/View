import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LogSourceState } from '../../src/shared/logs.js';
import { compactLogState, LogViewer } from '../../src/renderer/components/LogViewer.js';

describe('renderer log state', () => {
  it('keeps a recovered historical error out of the current compact state', () => {
    const recovered = { errorCode: null, lastErrorCode: 'timeout' } as LogSourceState;
    expect(compactLogState('已停止 · 有日志', recovered)).toBe('快照');
    expect(compactLogState('读取超时', { ...recovered, errorCode: 'timeout' })).toBe('异常');
  });

  it('keeps an unbound log in the same toolbar and body structure as a populated log', () => {
    const markup = renderToStaticMarkup(createElement(LogViewer, { epoch: 0, container: undefined }));
    expect(markup).toContain('<section class="log-viewer log-empty" aria-label="容器日志">');
    expect(markup).toContain('class="log-toolbar"');
    expect(markup).toContain('class="log-source log-source-empty"');
    expect(markup).toContain('>日志</span>');
    expect(markup).toContain('class="log-lines"');
    expect(markup).toContain('尚未绑定日志来源');
    expect(markup).not.toContain('log-tools-button');
    expect(markup).not.toContain('stdout 容器');
  });
});
