import type { Service } from '../../shared/contracts.js';
import type { ContainerEntity, ContainerKey, ServiceMember } from '../../shared/entities.js';

export function resolveServiceMembers(service: Service, devices: ReadonlySet<string>, containers: readonly ContainerEntity[]): ServiceMember[] {
  return service.bindings.map((binding) => {
    if (!devices.has(binding.deviceId)) {
      return { bindingId: binding.id, deviceId: binding.deviceId, containerKey: null, status: 'missing-device', reason: '设备未配置或已停用。' };
    }
    const candidates = containers.filter((container) => container.deviceId === binding.deviceId && matchesSelector(binding.selector, container));
    if (candidates.length === 1) {
      const container = candidates[0];
      if (!container) return unresolved(binding.id, binding.deviceId, '容器未找到。');
      return { bindingId: binding.id, deviceId: binding.deviceId, containerKey: container.key, status: 'bound', reason: null } satisfies ServiceMember;
    }
    if (candidates.length > 1) return { bindingId: binding.id, deviceId: binding.deviceId, containerKey: null, status: 'ambiguous', reason: '精确选择器匹配多个容器。' };
    return unresolved(binding.id, binding.deviceId, '容器未找到。');
  });
}

function matchesSelector(selector: Service['bindings'][number]['selector'], container: ContainerEntity): boolean {
  switch (selector.kind) {
    case 'container_id': return selector.value === container.id;
    case 'name': return selector.value === container.name;
    case 'compose':
      return selector.project === container.compose.project
        && selector.service === container.compose.service
        && (selector.ordinal === undefined || selector.ordinal === container.compose.ordinal);
  }
}

function unresolved(bindingId: string, deviceId: string, reason: string): ServiceMember {
  return { bindingId, deviceId, containerKey: null, status: 'unresolved', reason };
}

export function dedupeMemberKeys(members: readonly ServiceMember[]): ContainerKey[] {
  return [...new Set(members.flatMap((member) => member.containerKey ? [member.containerKey] : []))];
}
