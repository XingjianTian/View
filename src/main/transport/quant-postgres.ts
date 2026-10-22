import { Duplex, type DuplexOptions } from 'node:stream';
import type { ClientChannel } from 'ssh2';

export type QuantPostgresTarget = {
  containerId: string;
  ip: string;
  port: number;
  network: string;
  composeProject: string;
  composeService: string;
};

export type QuantPostgresTargetMetadata = {
  containerId: string;
  state: 'running';
  network: string;
  ip: string;
  port: number;
  composeProject: string;
  composeService: string;
  observedAt: string;
};

export type QuantPostgresChannelLease = {
  stream: Duplex;
  close: () => void;
};

/**
 * ssh2's direct-tcpip channel is a Duplex but does not implement the small
 * socket surface node-postgres calls during connection setup. Keep this
 * adapter local to the main-process transport; it never crosses IPC.
 */
export class ConnectableForwardDuplex extends Duplex {
  private readonly channel: ClientChannel;
  private timeout: NodeJS.Timeout | undefined;

  constructor(channel: ClientChannel, options?: DuplexOptions) {
    super({ ...options, allowHalfOpen: false });
    this.channel = channel;
    channel.on('data', (chunk: Buffer | string) => this.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    channel.once('end', () => this.push(null));
    channel.once('close', () => this.push(null));
    channel.once('error', (error: Error) => this.destroy(error));
  }

  connect(_port?: number, _host?: string, callback?: () => void): this {
    queueMicrotask(() => {
      if (this.destroyed) return;
      this.emit('connect');
      callback?.();
    });
    return this;
  }

  setNoDelay(_noDelay = true): this {
    return this;
  }

  setKeepAlive(_enable = true, _initialDelay?: number): this {
    return this;
  }

  setTimeout(timeoutMs: number, callback?: () => void): this {
    if (this.timeout) clearTimeout(this.timeout);
    if (timeoutMs > 0) this.timeout = setTimeout(() => {
      this.emit('timeout');
      callback?.();
    }, timeoutMs);
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  address(): { address: string; family: string; port: number } | null {
    return null;
  }

  _read(): void {
    // ssh2 pushes data through the channel listener above.
  }

  _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.channel.destroyed) {
      callback(new Error('转发通道已关闭。'));
      return;
    }
    this.channel.write(chunk, encoding, callback);
  }

  _final(callback: (error?: Error | null) => void): void {
    this.channel.end(callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.timeout) clearTimeout(this.timeout);
    if (!this.channel.destroyed) this.channel.destroy();
    callback(error);
  }
}
