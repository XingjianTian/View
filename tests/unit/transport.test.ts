import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type Client } from 'ssh2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalDockerTransport, type SpawnFunction, runChildProcess } from '../../src/main/transport/local-docker.js';
import { SshDockerTransport, readKnownHosts, fingerprintForBase64Key } from '../../src/main/transport/ssh-docker.js';
import { DEADLINES_MS } from '../../src/main/transport/deadlines.js';
import { inspectCommand, logsCommand } from '../../src/main/transport/readonly-commands.js';
import { TransportError } from '../../src/main/transport/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    killed: boolean;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

class FakeSshChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly stdin = { write: () => true, end: () => undefined };
  destroyed = false;

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => this.emit('close', null));
  }
}

class FakeSshClient extends EventEmitter {
  endCalls = 0;
  deadlineChecks = 0;
  hangDuplicateDeadline = false;
  deferDeadline = false;
  deferReady = false;
  emitErrorOnEnd = false;
  connectCalls = 0;
  connectStarted: (() => void) | undefined;
  pendingDeadline: FakeSshChannel | undefined;
  deferExecCallback = false;
  pendingExec: { callback: (error: Error | null, stream: FakeSshChannel) => void; stream: FakeSshChannel } | undefined;

  connect() {
    this.connectCalls += 1;
    this.connectStarted?.();
    if (this.deferReady) return;
    this.emit('connect');
    this.emit('handshake');
    this.emit('banner', 'redacted', 'en');
    queueMicrotask(() => this.emit('ready'));
  }

  end() {
    this.endCalls += 1;
    this.emit('end');
    this.emit('close');
    if (this.emitErrorOnEnd) this.emit('error', new Error('Connection lost before handshake'));
  }

  exec(command: string, _options: unknown, callback: (error: Error | null, stream: FakeSshChannel) => void) {
    const stream = new FakeSshChannel();
    const deliver = () => {
      callback(null, stream);
      queueMicrotask(() => {
        if (command.includes('command -v timeout')) {
          this.deadlineChecks += 1;
          if (this.hangDuplicateDeadline && this.deadlineChecks > 1) return;
          if (this.deferDeadline) {
            this.pendingDeadline = stream;
            return;
          }
          stream.emit('data', Buffer.from('timeout\n'));
          stream.emit('close', 0);
        } else if (command.includes("'logs'")) {
          stream.emit('data', Buffer.alloc(256 * 1024 + 1, 65));
        } else {
          stream.emit('data', Buffer.from('24.0\n'));
          stream.emit('close', 0);
        }
      });
    };
    if (this.deferExecCallback) this.pendingExec = { callback, stream };
    else queueMicrotask(deliver);
  }

  releasePendingExec() {
    const pending = this.pendingExec;
    this.pendingExec = undefined;
    pending?.callback(null, pending.stream);
    return pending?.stream;
  }
}

describe('readonly Docker transport', () => {
  it('rejects injection-shaped identifiers before spawn', () => {
    expect(() => inspectCommand(['abc; touch /tmp/pwned'])).toThrow();
    expect(() => logsCommand('aaaaaaaaaaaa', '2026-10-20T00:00:00Z; echo bad')).toThrow();
  });

  it('uses an absolute CLI, fixed context, shell=false and bounded output', async () => {
    const child = fakeChild();
    let seen: { command: string; args: readonly string[]; options: { shell?: boolean } } | undefined;
    const spawn = ((command: string, args: readonly string[] = [], options: { shell?: boolean } = {}) => {
      seen = { command, args, options };
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('{"ID":"abc"}\n'));
        child.emit('close', 0);
      });
      return child as never;
    }) as unknown as SpawnFunction;
    const transport = new LocalDockerTransport({ cliPath: '/absolute/docker', context: 'desktop-linux', spawn });
    const result = await transport.list();
    expect(result.stdout).toContain('abc');
    expect(seen?.command).toBe('/absolute/docker');
    expect(seen?.args.slice(0, 2)).toEqual(['--context', 'desktop-linux']);
    expect(seen?.options.shell).toBe(false);
    await transport.close();
  });

  it('terminates an over-limit child without accepting its output', async () => {
    const child = fakeChild();
    const spawn = (() => {
      setTimeout(() => child.stdout.emit('data', Buffer.alloc(20, 65)), 5);
      return child;
    }) as unknown as SpawnFunction;
    await expect(runChildProcess('/absolute/docker', ['ps'], {
      timeoutMs: 100,
      maxOutputBytes: 8,
      operation: 'list',
      spawn,
      env: {},
      children: new Set(),
      signal: undefined,
    })).rejects.toMatchObject({ code: 'incomplete' });
    expect(child.killed).toBe(true);
  });
});

describe('trusted SSH host keys', () => {
  it('matches only an existing known_hosts record for the exact host and port', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-known-hosts-'));
    roots.push(root);
    const publicKey = Buffer.from('known-test-key').toString('base64');
    await writeFile(path.join(root, 'known_hosts'), `example.test ssh-ed25519 ${publicKey}\n[example.test]:2222 ssh-ed25519 ${publicKey}\n`, 'utf8');
    const records = await readKnownHosts(path.join(root, 'known_hosts'), 'example.test', 2222);
    expect(records).toHaveLength(1);
    expect(records[0]?.fingerprint).toBe(fingerprintForBase64Key(publicKey));
    expect(await readKnownHosts(path.join(root, 'known_hosts'), 'other.test', 2222)).toEqual([]);
  });

  it('maps connection failures to non-secret error codes', () => {
    const error = new TransportError('auth_failed', 'SSH 认证失败。');
    expect(error.code).toBe('auth_failed');
    expect(error.message).not.toContain('password');
  });

  it('isolates an over-limit channel from concurrent SSH requests', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-ssh-transport-'));
    roots.push(root);
    const publicKey = Buffer.from('known-test-key').toString('base64');
    const knownHostsPath = path.join(root, 'known_hosts');
    await writeFile(knownHostsPath, `example.test ssh-ed25519 ${publicKey}\n`, 'utf8');
    const client = new FakeSshClient();
    const transport = new SshDockerTransport({
      profile: { id: 'test', kind: 'ssh', host: 'example.test', port: 22, username: 'tester', knownHostsPath, dockerPath: 'docker', businessEndpoints: {} },
      clientFactory: () => client as unknown as Client,
    });

    await transport.version();
    const oversized = transport.logs('a'.repeat(12));
    const healthy = transport.version();
    await expect(oversized).rejects.toMatchObject({ code: 'incomplete' });
    await expect(healthy).resolves.toMatchObject({ operation: 'version' });
    expect(client.endCalls).toBe(0);
    expect(transport.diagnostics?.()).toEqual({ connections: 1, channels: 0 });
    await transport.close();
  });

  it('keeps one persistent error listener through handshake and repeated post-ready errors', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-ssh-error-lifecycle-'));
    roots.push(root);
    const publicKey = Buffer.from('known-test-key').toString('base64');
    const knownHostsPath = path.join(root, 'known_hosts');
    await writeFile(knownHostsPath, `example.test ssh-ed25519 ${publicKey}\n`, 'utf8');
    const first = new FakeSshClient();
    const second = new FakeSshClient();
    let factoryCalls = 0;
    const transport = new SshDockerTransport({
      profile: { id: 'test', kind: 'ssh', host: 'example.test', port: 22, username: 'tester', knownHostsPath, dockerPath: 'docker', businessEndpoints: {} },
      clientFactory: () => (factoryCalls++ === 0 ? first : second) as unknown as Client,
    });

    await transport.version();
    expect(first.listenerCount('error')).toBe(1);
    expect(() => first.emit('error', new Error('Connection lost after handshake'))).not.toThrow();
    expect(() => first.emit('error', new Error('Connection lost again'))).not.toThrow();
    expect(first.listenerCount('error')).toBe(1);
    expect(transport.diagnostics?.()).toEqual({ connections: 0, channels: 0 });
    await expect(transport.version()).resolves.toMatchObject({ operation: 'version' });
    expect(second.listenerCount('error')).toBe(1);
    expect(transport.diagnostics?.()).toEqual({ connections: 1, channels: 0 });
    await transport.close();
  });

  it('settles a pre-ready repeated error once and ignores late ready/error events', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-ssh-pre-ready-error-'));
    roots.push(root);
    const publicKey = Buffer.from('known-test-key').toString('base64');
    const knownHostsPath = path.join(root, 'known_hosts');
    await writeFile(knownHostsPath, `example.test ssh-ed25519 ${publicKey}\n`, 'utf8');
    const client = new FakeSshClient();
    client.deferReady = true;
    const events: Array<Record<string, unknown>> = [];
    let started!: () => void;
    const connectStarted = new Promise<void>((resolve) => { started = resolve; });
    client.connectStarted = started;
    const transport = new SshDockerTransport({
      profile: { id: 'test', kind: 'ssh', host: 'example.test', port: 22, username: 'tester', knownHostsPath, dockerPath: 'docker', businessEndpoints: {} },
      clientFactory: () => client as unknown as Client,
      trace: (event) => events.push(event),
    });

    const pending = transport.version();
    await connectStarted;
    expect(client.listenerCount('error')).toBe(1);
    expect(() => client.emit('error', new Error('Connection lost before handshake'))).not.toThrow();
    expect(() => client.emit('error', new Error('Connection lost before handshake again'))).not.toThrow();
    await expect(pending).rejects.toMatchObject({ code: 'engine_unavailable' });
    expect(events.some((event) => event.phase === 'client_error' && event.outcome === 'connect_error' && event.timeoutSource === 'ssh2_error')).toBe(true);
    client.emit('ready');
    expect(() => client.emit('error', new Error('late handshake error'))).not.toThrow();
    expect(transport.diagnostics?.()).toEqual({ connections: 0, channels: 0 });
    expect(client.endCalls).toBe(1);
    await transport.close();
  });

  it('does not register a client invalidated between ready and getClient assignment', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-ssh-ready-error-race-'));
    roots.push(root);
    const publicKey = Buffer.from('known-test-key').toString('base64');
    const knownHostsPath = path.join(root, 'known_hosts');
    await writeFile(knownHostsPath, `example.test ssh-ed25519 ${publicKey}\n`, 'utf8');
    const client = new FakeSshClient();
    client.deferReady = true;
    let started!: () => void;
    const connectStarted = new Promise<void>((resolve) => { started = resolve; });
    client.connectStarted = started;
    const transport = new SshDockerTransport({
      profile: { id: 'test', kind: 'ssh', host: 'example.test', port: 22, username: 'tester', knownHostsPath, dockerPath: 'docker', businessEndpoints: {} },
      clientFactory: () => client as unknown as Client,
    });

    const pending = transport.version();
    await connectStarted;
    const pendingRejection = expect(pending).rejects.toMatchObject({ code: 'engine_unavailable' });
    client.emit('ready');
    client.emit('error', new Error('Connection lost after handshake'));
    await pendingRejection;
    expect(client.endCalls).toBe(1);
    expect(transport.diagnostics?.()).toEqual({ connections: 0, channels: 0 });
    await transport.close();
  });

  it('does not revive a client that becomes ready after close while connecting', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-ssh-close-race-'));
    roots.push(root);
    const publicKey = Buffer.from('known-test-key').toString('base64');
    const knownHostsPath = path.join(root, 'known_hosts');
    await writeFile(knownHostsPath, `example.test ssh-ed25519 ${publicKey}\n`, 'utf8');
    const client = new FakeSshClient();
    client.deferReady = true;
    let started!: () => void;
    const connectStarted = new Promise<void>((resolve) => { started = resolve; });
    client.connectStarted = started;
    const transport = new SshDockerTransport({
      profile: { id: 'test', kind: 'ssh', host: 'example.test', port: 22, username: 'tester', knownHostsPath, dockerPath: 'docker', businessEndpoints: {} },
      clientFactory: () => client as unknown as Client,
    });

    const pending = transport.version();
    await connectStarted;
    const pendingRejection = expect(pending).rejects.toMatchObject({ code: 'engine_unavailable' });
    await transport.close();
    client.emit('ready');
    await pendingRejection;
    expect(client.endCalls).toBe(1);
    expect(transport.diagnostics?.()).toEqual({ connections: 0, channels: 0 });
  });

  it('settles timeout before synchronous end/error and late ready', async () => {
    vi.useFakeTimers();
    try {
      const root = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-ssh-timeout-error-'));
      roots.push(root);
      const publicKey = Buffer.from('known-test-key').toString('base64');
      const knownHostsPath = path.join(root, 'known_hosts');
      await writeFile(knownHostsPath, `example.test ssh-ed25519 ${publicKey}\n`, 'utf8');
      const client = new FakeSshClient();
      client.deferReady = true;
      client.emitErrorOnEnd = true;
      const events: Array<Record<string, unknown>> = [];
      let started!: () => void;
      const connectStarted = new Promise<void>((resolve) => { started = resolve; });
      client.connectStarted = started;
      const transport = new SshDockerTransport({
        profile: { id: 'test', kind: 'ssh', host: 'example.test', port: 22, username: 'tester', knownHostsPath, dockerPath: 'docker', businessEndpoints: {} },
        clientFactory: () => client as unknown as Client,
        trace: (event) => events.push(event),
      });

      const pending = transport.version();
      const pendingRejection = expect(pending).rejects.toMatchObject({ code: 'timeout' });
      await connectStarted;
      await vi.advanceTimersByTimeAsync(DEADLINES_MS.connection);
      await pendingRejection;
      expect(client.endCalls).toBe(1);
      expect(events.some((event) => event.phase === 'client_error' && event.outcome === 'connect_timeout' && event.timeoutSource === 'local_timer')).toBe(true);
      expect(events.filter((event) => event.operation === 'ssh_connect').every((event) => typeof event.elapsedMs === 'number' && (event.elapsedMs as number) >= 0 && (event.elapsedMs as number) <= DEADLINES_MS.connection + 100)).toBe(true);
      client.emit('ready');
      expect(() => client.emit('error', new Error('late timeout error'))).not.toThrow();
      expect(transport.diagnostics?.()).toEqual({ connections: 0, channels: 0 });
      await transport.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares the initial remote deadline probe across concurrent requests', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-ssh-deadline-'));
    roots.push(root);
    const publicKey = Buffer.from('known-test-key').toString('base64');
    const knownHostsPath = path.join(root, 'known_hosts');
    await writeFile(knownHostsPath, `example.test ssh-ed25519 ${publicKey}\n`, 'utf8');
    const client = new FakeSshClient();
    client.hangDuplicateDeadline = true;
    const transport = new SshDockerTransport({
      profile: { id: 'test', kind: 'ssh', host: 'example.test', port: 22, username: 'tester', knownHostsPath, dockerPath: 'docker', businessEndpoints: {} },
      clientFactory: () => client as unknown as Client,
    });

    const results = await Promise.all([transport.version(), transport.list()]);
    expect(results).toHaveLength(2);
    expect(client.deadlineChecks).toBe(1);
    await transport.close();
  });

  it('emits bounded SSH stage traces without commands, credentials, or output text', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-ssh-trace-'));
    roots.push(root);
    const publicKey = Buffer.from('known-test-key').toString('base64');
    const knownHostsPath = path.join(root, 'known_hosts');
    await writeFile(knownHostsPath, `example.test ssh-ed25519 ${publicKey}\n`, 'utf8');
    const client = new FakeSshClient();
    const events: Array<Record<string, unknown>> = [];
    const transport = new SshDockerTransport({
      profile: { id: 'test', kind: 'ssh', host: 'example.test', port: 22, username: 'tester', knownHostsPath, dockerPath: 'docker', businessEndpoints: {} },
      clientFactory: () => client as unknown as Client,
      trace: (event) => events.push(event),
    });

    await transport.version();
    await expect(transport.logs('a'.repeat(12), undefined, undefined, { readAttemptId: 42 })).rejects.toMatchObject({ code: 'incomplete' });

    const phases = new Set(events.map((event) => event.phase));
    expect(phases.size).toBeGreaterThan(0);
    for (const phase of ['known_hosts_start', 'known_hosts_end', 'credentials_start', 'credentials_end', 'connect_start', 'tcp_connected', 'ssh_handshake', 'ssh_banner', 'ssh_ready', 'deadline_start', 'deadline_end', 'exec_start', 'channel_open', 'first_byte', 'output_end']) {
      expect(phases.has(phase)).toBe(true);
    }
    expect(events.some((event) => event.operation === 'logs' && event.phase === 'output_end' && event.outcome === 'incomplete')).toBe(true);
    expect(events.filter((event) => event.phase === 'first_byte').every((event) => typeof event.bytes === 'number' && (event.bytes as number) > 0)).toBe(true);
    expect(events.every((event) => typeof event.elapsedMs === 'number' && (event.elapsedMs as number) >= 0)).toBe(true);
    expect(events.every((event) => typeof event.connectionGeneration === 'number' && typeof event.channels === 'number')).toBe(true);
    expect(events.filter((event) => event.operation === 'logs').every((event) => event.readAttemptId === 42)).toBe(true);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('example.test');
    expect(serialized).not.toContain('tester');
    expect(serialized).not.toContain('private');
    expect(serialized).not.toContain('24.0');
    await transport.close();
  });

  it('does not let a late old-client close clear a newer SSH connection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-ssh-identity-'));
    roots.push(root);
    const publicKey = Buffer.from('known-test-key').toString('base64');
    const knownHostsPath = path.join(root, 'known_hosts');
    await writeFile(knownHostsPath, `example.test ssh-ed25519 ${publicKey}\n`, 'utf8');
    const first = new FakeSshClient();
    const second = new FakeSshClient();
    let factoryCalls = 0;
    const transport = new SshDockerTransport({
      profile: { id: 'test', kind: 'ssh', host: 'example.test', port: 22, username: 'tester', knownHostsPath, dockerPath: 'docker', businessEndpoints: {} },
      clientFactory: () => (factoryCalls++ === 0 ? first : second) as unknown as Client,
    });

    await transport.version();
    first.emit('close');
    await transport.version();
    expect(() => first.emit('error', new Error('late old client error'))).not.toThrow();
    first.emit('end');
    first.emit('ready');
    expect(transport.diagnostics?.()).toEqual({ connections: 1, channels: 0 });
    await transport.close();
  });

  it('re-probes a replacement client without accepting an old deadline result', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-ssh-deadline-identity-'));
    roots.push(root);
    const publicKey = Buffer.from('known-test-key').toString('base64');
    const knownHostsPath = path.join(root, 'known_hosts');
    await writeFile(knownHostsPath, `example.test ssh-ed25519 ${publicKey}\n`, 'utf8');
    const first = new FakeSshClient();
    first.deferDeadline = true;
    const second = new FakeSshClient();
    let factoryCalls = 0;
    const transport = new SshDockerTransport({
      profile: { id: 'test', kind: 'ssh', host: 'example.test', port: 22, username: 'tester', knownHostsPath, dockerPath: 'docker', businessEndpoints: {} },
      clientFactory: () => (factoryCalls++ === 0 ? first : second) as unknown as Client,
    });

    const oldRequest = transport.version();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(first.pendingDeadline).toBeDefined();
    first.emit('close');
    await expect(transport.version()).resolves.toMatchObject({ operation: 'version' });
    first.pendingDeadline?.emit('data', Buffer.from('timeout\n'));
    first.pendingDeadline?.emit('close', 0);
    await expect(oldRequest).rejects.toMatchObject({ code: 'engine_unavailable' });
    expect(transport.diagnostics?.()).toEqual({ connections: 1, channels: 0 });
    await transport.close();
  });

  it('destroys a channel whose exec callback arrives after the request deadline', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-observatory-ssh-late-callback-'));
    roots.push(root);
    const publicKey = Buffer.from('known-test-key').toString('base64');
    const knownHostsPath = path.join(root, 'known_hosts');
    await writeFile(knownHostsPath, `example.test ssh-ed25519 ${publicKey}\n`, 'utf8');
    const client = new FakeSshClient();
    const transport = new SshDockerTransport({
      profile: { id: 'test', kind: 'ssh', host: 'example.test', port: 22, username: 'tester', knownHostsPath, dockerPath: 'docker', businessEndpoints: {} },
      clientFactory: () => client as unknown as Client,
    });
    await transport.version();
    client.deferExecCallback = true;
    const rawExec = (transport as unknown as {
      execRaw: (client: Client, command: string, timeoutMs: number, maxOutputBytes: number) => Promise<unknown>;
    }).execRaw.bind(transport);

    await expect(rawExec(client as unknown as Client, 'delayed-read-only-command', 10, 1024)).rejects.toMatchObject({ code: 'timeout' });
    const lateChannel = client.releasePendingExec();
    expect(lateChannel?.destroyed).toBe(true);
    expect(transport.diagnostics?.()).toEqual({ connections: 1, channels: 0 });
    await transport.close();
  });
});

describe('infrastructure fixed SSH reader', () => {
  const source = {
    kind: 'tailscale_status' as const, sourceRef: 'network', profileId: 'fixture',
    target: { containerId: 'a'.repeat(64), imageId: `sha256:${'b'.repeat(64)}` },
    peer: { nodeId: 'fixture-peer', ip: '100.64.0.2', alias: '固定对端' },
  };
  class InfrastructureClient extends FakeSshClient {
    infrastructureCommands: string[] = [];
    options: unknown[] = [];
    output = JSON.stringify({ kind: 'tailscale_status', complete: true, data: { backendState: 'Running' } });
    hold = false;
    stdinValues: string[] = [];
    infrastructureChannel: FakeSshChannel | undefined;
    override exec(command: string, options: unknown, callback: (error: Error | null, stream: FakeSshChannel) => void) {
      if (command.includes('command -v timeout')) return super.exec(command, options, callback);
      this.infrastructureCommands.push(command);
      this.options.push(options);
      const stream = new FakeSshChannel();
      this.infrastructureChannel = stream;
      stream.stdin.write = (value?: string) => { this.stdinValues.push(value ?? ''); return true; };
      queueMicrotask(() => {
        callback(null, stream);
        if (this.hold) return;
        queueMicrotask(() => { stream.emit('data', Buffer.from(this.output)); stream.emit('close', 0); });
      });
    }
  }
  async function setup(client = new InfrastructureClient(), sudoPassword?: string) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'observatory-infrastructure-ssh-'));
    roots.push(root);
    const knownHostsPath = path.join(root, 'known_hosts');
    await writeFile(knownHostsPath, `example.test ssh-ed25519 ${Buffer.from('fixture-public-key').toString('base64')}\n`);
    const transport = new SshDockerTransport({ profile: { id: 'fixture', kind: 'ssh', host: 'example.test', port: 22, username: 'tester', knownHostsPath, dockerPath: '/opt/docker', businessEndpoints: {}, ...(sudoPassword === undefined ? {} : { sudoPassword }) }, clientFactory: () => client as unknown as Client });
    return { client, transport };
  }

  it('uses fixed Python, the profile Docker path and remaining fractional deadline without PTY', async () => {
    const { transport, client } = await setup();
    await expect(transport.readInfrastructure(source)).resolves.toMatchObject({ kind: 'tailscale_status', complete: true });
    expect(client.infrastructureCommands).toHaveLength(1);
    expect(client.infrastructureCommands[0]).toContain('--signal=TERM --kill-after=1');
    expect(client.infrastructureCommands[0]).toMatch(/\d\.\d{3}s 'python3' -c /);
    expect(client.infrastructureCommands[0]).toContain("'/opt/docker'");
    expect(client.options).toEqual([{ pty: false }]);
    expect(client.endCalls).toBe(0);
    expect(transport.diagnostics().channels).toBe(0);
    await transport.close();
  });

  it('rejects unregistered fields before connecting and rejects wrong-kind or extra-field replies', async () => {
    const { transport, client } = await setup();
    await expect(transport.readInfrastructure({ ...source, command: 'renew' } as never)).rejects.toMatchObject({ code: 'profile_invalid' });
    expect(client.connectCalls).toBe(0);
    for (const output of [
      { kind: 'openresty_status', complete: true, data: {} },
      { kind: 'tailscale_status', complete: true, data: {}, token: 'private-response' },
      { error: 'permission' },
    ]) {
      client.output = JSON.stringify(output);
      await expect(transport.readInfrastructure(source)).rejects.toBeInstanceOf(TransportError);
    }
    expect(client.endCalls).toBe(0);
    await transport.close();
  });

  it('cancels only its owned channel and rejects oversized output', async () => {
    const { transport, client } = await setup();
    client.hold = true;
    const controller = new AbortController();
    const pending = transport.readInfrastructure(source, controller.signal);
    await vi.waitFor(() => expect(client.infrastructureChannel).toBeDefined());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(client.infrastructureChannel?.destroyed).toBe(true);
    expect(client.endCalls).toBe(0);
    client.hold = false;
    client.output = 'x'.repeat(256 * 1024 + 1);
    await expect(transport.readInfrastructure(source)).rejects.toMatchObject({ code: 'incomplete' });
    expect(transport.diagnostics().channels).toBe(0);
    await transport.close();
  });

  it('does not open a late infrastructure channel after cancellation during deadline detection', async () => {
    const { transport, client } = await setup();
    client.deferDeadline = true;
    const controller = new AbortController();
    const pending = transport.readInfrastructure(source, controller.signal);
    await vi.waitFor(() => expect(client.pendingDeadline).toBeDefined());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    client.pendingDeadline!.emit('data', Buffer.from('timeout\n'));
    client.pendingDeadline!.emit('close', 0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.infrastructureCommands).toEqual([]);
    expect(client.endCalls).toBe(0);
    await transport.close();
  });
  it('keeps sudo input out of the command and sends it only over stdin without a PTY', async () => {
    const { transport, client } = await setup(undefined, 'fixture-sudo-secret');
    await transport.readInfrastructure(source);
    expect(client.infrastructureCommands[0]).toMatch(/^sudo -S -p '' -- /);
    expect(client.infrastructureCommands[0]).not.toContain('fixture-sudo-secret');
    expect(client.stdinValues).toEqual(['fixture-sudo-secret\n']);
    expect(client.options).toEqual([{ pty: false }]);
    await transport.close();
  });

  it('includes connection wait in the five-second budget and ignores late readiness', async () => {
    const { transport, client } = await setup();
    client.deferReady = true;
    const connected = new Promise<void>((resolve) => { client.connectStarted = resolve; });
    const pending = transport.readInfrastructure(source);
    const outcome = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await connected;
    await outcome;
    client.emit('ready');
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.infrastructureCommands).toEqual([]);
    expect(client.deadlineChecks).toBe(0);
    expect(client.endCalls).toBe(0);
    await transport.close();
  }, 7_000);

});
