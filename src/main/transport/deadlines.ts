export const DEADLINES_MS = Object.freeze({
  connection: 5_000,
  request: 8_000,
  stats: 10_000,
  logs: 5_000,
  statusSource: 5_000,
});

export const OUTPUT_LIMITS = Object.freeze({
  discovery: 1 * 1024 * 1024,
  inspect: 1 * 1024 * 1024,
  stats: 512 * 1024,
  logs: 256 * 1024,
});

export class DeadlineError extends Error {
  constructor(message = '观察请求超过期限') {
    super(message);
    this.name = 'DeadlineError';
  }
}

export class OutputLimitError extends Error {
  constructor(message = '观察输出超过上限') {
    super(message);
    this.name = 'OutputLimitError';
  }
}

export function withDeadline<T>(operation: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new DeadlineError());
    }, timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
