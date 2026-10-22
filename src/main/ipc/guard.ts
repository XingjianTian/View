import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { RequestEnvelopeSchema, fail, type ErrorCode, type RequestEnvelope, type Result } from '../../shared/contracts.js';

const MAX_PAYLOAD_BYTES = 64 * 1024;
const WINDOW_MS = 1_000;
const MAX_CALLS_PER_WINDOW = 60;
const DEV_DOCUMENT_ORIGIN = 'http://127.0.0.1:5173';

type GuardContext = {
  getWindow: () => BrowserWindow | null;
  getEpoch: () => number;
};

type CallWindow = {
  startedAt: number;
  count: number;
};

export class IpcGuardError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = 'IpcGuardError';
  }
}

export class IpcGuard {
  private readonly calls = new Map<string, CallWindow>();

  constructor(private readonly context: GuardContext) {}

  envelope(event: IpcMainInvokeEvent, channel: string, value: unknown): RequestEnvelope {
    this.assertSender(event);
    const parsed = RequestEnvelopeSchema.safeParse(value);
    if (!parsed.success || parsed.data.epoch !== this.context.getEpoch()) {
      throw new IpcGuardError('invalid_request', '请求代次无效');
    }
    let payloadSize = 0;
    try {
      payloadSize = Buffer.byteLength(JSON.stringify(parsed.data.payload ?? null), 'utf8');
    } catch {
      throw new IpcGuardError('invalid_request', '请求内容无效');
    }
    if (payloadSize > MAX_PAYLOAD_BYTES) {
      throw new IpcGuardError('invalid_request', '请求内容过大');
    }
    this.rateLimit(event.sender.id, channel);
    return parsed.data;
  }

  bootstrap(event: IpcMainInvokeEvent, channel: string, value: unknown) {
    this.assertSender(event);
    if (value !== undefined) throw new IpcGuardError('invalid_request', '启动请求参数无效');
    this.rateLimit(event.sender.id, channel);
  }

  private assertSender(event: IpcMainInvokeEvent) {
    const window = this.context.getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents) {
      throw new IpcGuardError('forbidden_sender', '请求窗口无效');
    }
    if (event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== event.sender.getURL() || !isTrustedDocument(event.senderFrame.url)) {
      throw new IpcGuardError('forbidden_sender', '请求 frame 无效');
    }
  }

  private rateLimit(senderId: number, channel: string) {
    const key = `${senderId}:${channel}`;
    const now = Date.now();
    const current = this.calls.get(key);
    if (!current || now - current.startedAt >= WINDOW_MS) {
      this.calls.set(key, { startedAt: now, count: 1 });
      return;
    }
    current.count += 1;
    if (current.count > MAX_CALLS_PER_WINDOW) {
      throw new IpcGuardError('invalid_request', '请求频率过高');
    }
  }
}

export function isTrustedDocument(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol === 'app:' && url.hostname === 'observatory' && !url.port) {
      return url.pathname === '/' || url.pathname === '/index.html';
    }
    return url.origin === DEV_DOCUMENT_ORIGIN && (url.pathname === '/' || url.pathname === '/index.html');
  } catch {
    return false;
  }
}

export function safeError(error: unknown): Result<never> {
  if (error instanceof IpcGuardError) return fail(error.code, error.message);
  return fail('internal', '操作未完成，请查看本机匿名诊断状态。');
}
