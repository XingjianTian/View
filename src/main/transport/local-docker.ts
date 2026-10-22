import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { DEADLINES_MS } from './deadlines.js';
import { inspectCommand, listCommand, logsCommand, statsCommand, versionCommand, isReadonlyCommand, type CommandSpec } from './readonly-commands.js';
import { TransportError, type CommandResult, type DockerTransport, type LogReadContext } from './types.js';

const CANDIDATE_PATHS = [
  '/Applications/Docker.app/Contents/Resources/bin/docker',
  path.join(os.homedir(), '.docker', 'bin', 'docker'),
  '/opt/homebrew/bin/docker',
  '/usr/local/bin/docker',
];

export type SpawnFunction = typeof nodeSpawn;

export async function resolveDockerCli(candidates = CANDIDATE_PATHS): Promise<string> {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the fixed, non-user-controlled candidate list.
    }
  }
  throw new TransportError('cli_missing', '找不到可执行的 Docker CLI。');
}

export type LocalDockerOptions = {
  cliPath?: string;
  context?: string;
  spawn?: SpawnFunction;
};

export class LocalDockerTransport implements DockerTransport {
  readonly kind = 'local' as const;
  private readonly spawn: SpawnFunction;
  private readonly context: string;
  private readonly cliPath: string | undefined;
  private childProcesses = new Set<ChildProcess>();

  constructor(options: LocalDockerOptions = {}) {
    this.cliPath = options.cliPath;
    this.context = options.context ?? 'desktop-linux';
    this.spawn = options.spawn ?? nodeSpawn;
  }

  version(signal?: AbortSignal) { const spec = versionCommand(); return this.run(spec, signal); }
  list(signal?: AbortSignal) { const spec = listCommand(); return this.run(spec, signal); }
  inspect(ids: readonly string[], signal?: AbortSignal) { const spec = inspectCommand(ids); return this.run(spec, signal); }
  stats(ids: readonly string[], signal?: AbortSignal) { const spec = statsCommand(ids); return this.run(spec, signal); }
  logs(id: string, since?: string, signal?: AbortSignal, _context?: LogReadContext) { const spec = logsCommand(id, since); return this.run(spec, signal); }

  async close() {
    for (const child of this.childProcesses) child.kill('SIGTERM');
    this.childProcesses.clear();
  }

  diagnostics() {
    return { connections: 0, channels: this.childProcesses.size };
  }

  private async run(spec: CommandSpec, signal?: AbortSignal): Promise<CommandResult> {
    if (!isReadonlyCommand(spec.argv)) throw new TransportError('internal', '不允许的 Docker 操作。');
    const cliPath = this.cliPath ?? await resolveDockerCli();
    const argv = ['--context', this.context, ...spec.argv];
    const env = sanitizedEnvironment();
    return runChildProcess(cliPath, argv, {
      timeoutMs: spec.timeoutMs,
      maxOutputBytes: spec.maxOutputBytes,
      operation: spec.operation,
      spawn: this.spawn,
      env,
      children: this.childProcesses,
      signal,
    });
  }
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME ?? os.homedir(),
    USER: process.env.USER,
    LANG: 'C.UTF-8',
    PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin',
  };
  if (process.env.DOCKER_CONFIG) env.DOCKER_CONFIG = process.env.DOCKER_CONFIG;
  return env;
}

export type ChildRunOptions = {
  timeoutMs: number;
  maxOutputBytes: number;
  operation: CommandSpec['operation'];
  spawn: SpawnFunction;
  env: NodeJS.ProcessEnv;
  children: Set<ChildProcess>;
  signal: AbortSignal | undefined;
};

export function runChildProcess(cliPath: string, argv: readonly string[], options: ChildRunOptions): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = options.spawn(cliPath, [...argv], {
        cwd: os.homedir(),
        env: options.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      reject(new TransportError('engine_unavailable', 'Docker 引擎无法启动。'));
      return;
    }
    if (!child.stdout || !child.stderr) {
      child.kill('SIGTERM');
      reject(new TransportError('engine_unavailable', 'Docker 输出通道不可用。'));
      return;
    }
    options.children.add(child);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let total = 0;
    let truncated = false;
    let settled = false;
    const started = Date.now();
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      options.children.delete(child);
      fn();
    };
    const terminate = () => {
      if (!child.killed) child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled && !child.killed) child.kill('SIGKILL');
      }, 250);
    };
    const onAbort = () => {
      terminate();
      finish(() => reject(new TransportError('cancelled', '观察请求已取消。')));
    };
    const timer = setTimeout(() => {
      terminate();
      finish(() => reject(new TransportError('timeout', 'Docker 观察请求超时。')));
    }, options.timeoutMs);
    const collect = (chunk: Buffer, target: Buffer[]) => {
      if (settled) return;
      const remaining = options.maxOutputBytes - total;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) target.push(chunk.subarray(0, remaining));
        total = options.maxOutputBytes;
        truncated = true;
        terminate();
        finish(() => reject(new TransportError('incomplete', 'Docker 输出超过上限。')));
        return;
      }
      target.push(chunk);
      total += chunk.byteLength;
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, stdout));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, stderr));
    child.once('error', () => {
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      finish(() => reject(new TransportError('engine_unavailable', 'Docker 引擎无法访问。')));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      finish(() => {
        const result: CommandResult = {
          operation: options.operation,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          code,
          truncated,
          observedAt: new Date().toISOString(),
        };
        if (truncated) reject(new TransportError('incomplete', 'Docker 输出超过上限。'));
        else if (code !== 0) reject(new TransportError('engine_unavailable', 'Docker 只读请求未完成。'));
        else resolve(result);
      });
    });
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    void started;
  });
}
