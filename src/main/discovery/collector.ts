import type { Device } from '../../shared/contracts.js';
import type { ContainerEntity, DiscoveryResult } from '../../shared/entities.js';
import { containerKey } from '../../shared/entities.js';
import { parseContainerList, mergeInspectedContainers, type ContainerCandidate } from './parser.js';
import { TransportError, type DockerTransport } from '../transport/types.js';

const MAX_CONTAINERS = 512;
const MAX_BATCH = 16;

export async function discoverDevice(device: Device, transport: DockerTransport): Promise<DiscoveryResult> {
  const observedAt = new Date().toISOString();
  try {
    const listed = await transport.list();
    const parsed = parseContainerList(listed, device.id, MAX_CONTAINERS);
    if (!parsed.containers.length) {
      return {
        deviceId: device.id,
        containers: [],
        observedAt,
        complete: parsed.complete,
        errorCode: parsed.complete ? null : 'incomplete',
        sourceAt: listed.observedAt,
      };
    }
    const containers: ContainerEntity[] = [];
    let complete = parsed.complete;
    let errorCode: string | null = parsed.complete ? null : 'incomplete';
    for (let offset = 0; offset < parsed.containers.length; offset += MAX_BATCH) {
      const batch = parsed.containers.slice(offset, offset + MAX_BATCH);
      try {
        const inspected = await transport.inspect(batch.map((candidate) => candidate.id));
        const merged = mergeInspectedContainers(batch, inspected);
        containers.push(...merged.containers);
        if (!merged.complete) {
          complete = false;
          errorCode = errorCode ?? 'incomplete';
        }
      } catch (error) {
        complete = false;
        errorCode = errorCode ?? mapTransportError(error);
        containers.push(...fallbackEntities(batch));
      }
    }
    return {
      deviceId: device.id,
      containers,
      observedAt,
      complete,
      errorCode,
      sourceAt: listed.observedAt,
    };
  } catch (error) {
    return {
      deviceId: device.id,
      containers: [],
      observedAt,
      complete: false,
      errorCode: mapTransportError(error),
      sourceAt: null,
    };
  }
}

function fallbackEntities(candidates: readonly ContainerCandidate[]): ContainerEntity[] {
  return candidates.map((candidate) => ({
    key: containerKey(candidate.deviceId, candidate.id),
    deviceId: candidate.deviceId,
    id: candidate.id,
    name: candidate.name,
    image: candidate.image,
    compose: candidate.compose,
    state: candidate.state,
    health: 'none',
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    restartCount: null,
    tty: null,
    networkMode: null,
    logsAvailable: true,
    sourceAt: candidate.sourceAt,
    generation: `${candidate.deviceId}:${candidate.id}:unknown`,
  }));
}

function mapTransportError(error: unknown): string {
  return error instanceof TransportError ? error.code : 'internal';
}
