import { ConnectionProbeSchema, type ConnectionProbe, type Device, type ProfileReference } from '../../shared/contracts.js';
import { createDockerTransport } from './factory.js';
import { TransportError, type DockerTransport } from './types.js';

export async function probeDevice(device: Device, reference: ProfileReference): Promise<ConnectionProbe> {
  const observedAt = new Date().toISOString();
  let transport: DockerTransport | undefined;
  try {
    const activeTransport = await createDockerTransport(reference);
    transport = activeTransport;
    const version = await activeTransport.version();
    const list = await retryNetworkRead(() => activeTransport.list());
    const lines = list.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const count = lines.length <= 512 && lines.every((line) => isContainerListLine(line)) ? lines.length : null;
    const incomplete = list.truncated || count === null;
    return ConnectionProbeSchema.parse({
      deviceId: device.id,
      transport: device.transport,
      status: incomplete ? 'stale' : 'connected',
      dockerVersion: version.stdout.trim().slice(0, 128) || null,
      containerCount: count,
      observedAt,
      truncated: incomplete,
      errorCode: incomplete ? 'incomplete' : null,
    });
  } catch (error) {
    const code = error instanceof TransportError ? mapErrorCode(error.code) : 'internal';
    return ConnectionProbeSchema.parse({
      deviceId: device.id,
      transport: device.transport,
      status: 'unknown',
      dockerVersion: null,
      containerCount: null,
      observedAt,
      truncated: false,
      errorCode: code,
    });
  } finally {
    await transport?.close().catch(() => undefined);
  }
}

async function retryNetworkRead<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof TransportError) || (error.code !== 'timeout' && error.code !== 'engine_unavailable')) throw error;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return operation();
  }
}

function isContainerListLine(value: string) {
  const firstField = value.split('\t', 1)[0]?.trim() ?? '';
  return isJsonString(firstField);
}

function isJsonString(value: string) {
  try {
    return typeof JSON.parse(value) === 'string';
  } catch {
    return false;
  }
}

function mapErrorCode(code: TransportError['code']) {
  switch (code) {
    case 'cli_missing': return 'cli_missing' as const;
    case 'engine_unavailable': return 'engine_unavailable' as const;
    case 'host_key_untrusted': return 'host_key_untrusted' as const;
    case 'auth_failed': return 'auth_failed' as const;
    case 'sudo_denied': return 'sudo_denied' as const;
    case 'timeout': return 'timeout' as const;
    case 'deadline_unavailable': return 'deadline_unavailable' as const;
    case 'incomplete': return 'incomplete' as const;
    case 'profile_missing': return 'profile_missing' as const;
    case 'profile_invalid': return 'profile_invalid' as const;
    default: return 'internal' as const;
  }
}
