import { describe, expect, it } from 'vitest';
import { ServiceSchema } from '../../src/shared/contracts.js';
import type { ContainerEntity, ContainerObservation } from '../../src/shared/entities.js';
import { aggregateServiceObservation } from '../../src/main/services/aggregate.js';
import { resolveServiceMembers } from '../../src/main/services/resolver.js';

const idA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const idB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function container(id: string, name: string, state: ContainerEntity['state'] = 'running', startedAt = '2026-10-20T09:00:00.000Z'): ContainerEntity {
  return {
    key: `local:${id}`,
    deviceId: 'local',
    id,
    name,
    image: 'image@sha256:abc',
    compose: { project: 'project', service: name, ordinal: id === idA ? 1 : 2 },
    state,
    health: 'none',
    startedAt,
    finishedAt: state === 'running' ? null : '2026-10-20T09:30:00.000Z',
    exitCode: state === 'running' ? null : 1,
    restartCount: 0,
    tty: false,
    networkMode: 'default',
    logsAvailable: true,
    sourceAt: '2026-10-20T10:00:00.000Z',
    generation: `local:${id}:${startedAt}`,
  };
}

function observation(item: ContainerEntity, cpu: number): ContainerObservation {
  return {
    key: item.key,
    deviceId: item.deviceId,
    containerId: item.id,
    startedAt: item.startedAt,
    current: { cpuPercent: cpu, memoryBytes: 10, memoryLimitBytes: 100, networkRxBytes: 4, networkTxBytes: 5, pids: 1, observedAt: '2026-10-20T10:00:01.000Z', sourceAt: '2026-10-20T10:00:00.000Z', freshness: 'fresh' },
    history: [],
    coverage: { requested: 1, returned: 1, complete: true },
    errorCode: null,
    generation: item.generation,
  };
}

describe('service bindings and aggregation', () => {
  it('requires an ordinal to resolve a replicated Compose service', () => {
    const services = ServiceSchema.parse({
      id: 'replicas', name: 'Replicas', category: '基础设施', bindings: [{ id: 'b1', deviceId: 'local', selector: { kind: 'compose', project: 'project', service: 'worker' }, required: true, expectedPolicy: 'continuous' }], businessAdapter: { kind: 'none' },
    });
    const members = resolveServiceMembers(services, new Set(['local']), [container(idA, 'worker'), container(idB, 'worker')]);
    expect(members[0]).toMatchObject({ status: 'ambiguous', containerKey: null });
  });

  it('matches a Compose binding by exact project, service, and ordinal', () => {
    const exact = container(idA, 'frontend');
    const otherProject = { ...container(idB, 'frontend'), compose: { project: 'other-project', service: 'frontend', ordinal: 1 } };
    const service = ServiceSchema.parse({
      id: 'compose-exact', name: 'Compose exact', category: '应用服务', bindings: [{ id: 'b1', deviceId: 'local', selector: { kind: 'compose', project: 'project', service: 'frontend', ordinal: 1 }, required: true, expectedPolicy: 'continuous' }], businessAdapter: { kind: 'none' },
    });
    const members = resolveServiceMembers(service, new Set(['local']), [exact, otherProject]);
    expect(members).toEqual([{ bindingId: 'b1', deviceId: 'local', containerKey: exact.key, status: 'bound', reason: null }]);
  });

  it('deduplicates shared members when summing service metrics and preserves coverage', () => {
    const first = container(idA, 'worker');
    const second = container(idB, 'api');
    const service = ServiceSchema.parse({
      id: 'shared', name: 'Shared', category: '基础设施', bindings: [
        { id: 'b1', deviceId: 'local', selector: { kind: 'container_id', value: idA }, required: true, expectedPolicy: 'continuous' },
        { id: 'b2', deviceId: 'local', selector: { kind: 'container_id', value: idA }, required: true, expectedPolicy: 'continuous' },
        { id: 'b3', deviceId: 'local', selector: { kind: 'container_id', value: idB }, required: true, expectedPolicy: 'continuous' },
      ], businessAdapter: { kind: 'none' },
    });
    const members = resolveServiceMembers(service, new Set(['local']), [first, second]);
    const value = aggregateServiceObservation(service, members, new Map([[first.key, first], [second.key, second]]), new Map([[first.key, observation(first, 140)], [second.key, observation(second, 60)]]));
    expect(value.metrics.cpuPercent).toBe(200);
    expect(value.coverage).toEqual({ required: 3, observed: 3, missing: 0 });
    expect(value.status).toBe('ok');
  });

  it('keeps stopped manual members neutral while continuous members need attention', () => {
    const stopped = container(idA, 'worker', 'exited');
    const service = ServiceSchema.parse({
      id: 'stopped', name: 'Stopped', category: '基础设施', bindings: [{ id: 'b1', deviceId: 'local', selector: { kind: 'container_id', value: idA }, required: true, expectedPolicy: 'manual' }], businessAdapter: { kind: 'none' },
    });
    const members = resolveServiceMembers(service, new Set(['local']), [stopped]);
    const neutral = aggregateServiceObservation(service, members, new Map([[stopped.key, stopped]]), new Map());
    expect(neutral.status).toBe('neutral');

    const continuous = ServiceSchema.parse({ ...service, id: 'continuous', bindings: [{ ...service.bindings[0], expectedPolicy: 'continuous' }] });
    const secondMembers = resolveServiceMembers(continuous, new Set(['local']), [stopped]);
    const attention = aggregateServiceObservation(continuous, secondMembers, new Map([[stopped.key, stopped]]), new Map());
    expect(attention.status).toBe('attention');
  });

  it('keeps unresolved bindings unknown until discovery is complete', () => {
    const service = ServiceSchema.parse({
      id: 'pending', name: 'Pending', category: '基础设施', bindings: [{ id: 'b1', deviceId: 'local', selector: { kind: 'container_id', value: idA }, required: true, expectedPolicy: 'continuous' }], businessAdapter: { kind: 'none' },
    });
    const members = resolveServiceMembers(service, new Set(['local']), []);
    const pending = aggregateServiceObservation(service, members, new Map(), new Map(), undefined, undefined, false);
    expect(pending.status).toBe('unknown');
    expect(pending.errorCode).toBeNull();
    const complete = aggregateServiceObservation(service, members, new Map(), new Map(), undefined, undefined, true);
    expect(complete.status).toBe('attention');
    expect(complete.errorCode).toBe('binding_unresolved');
  });
});
