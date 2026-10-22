const CONTAINER_ID = /^[a-f0-9]{12,64}$/;
const MAX_BATCH = 32;

export type ReadonlyOperation = 'version' | 'list' | 'inspect' | 'inspect_ragflow_target' | 'inspect_quant_postgres_target' | 'stats' | 'logs';

export type CommandSpec = {
  operation: ReadonlyOperation;
  argv: readonly string[];
  maxOutputBytes: number;
  timeoutMs: number;
};

export function assertContainerId(id: string): string {
  if (!CONTAINER_ID.test(id)) throw new Error('容器标识无效');
  return id;
}

export function assertContainerIds(ids: readonly string[]): string[] {
  if (ids.length > MAX_BATCH) throw new Error('容器批次超过上限');
  return [...new Set(ids)].map(assertContainerId);
}

export function versionCommand(): CommandSpec {
  return { operation: 'version', argv: ['version', '--format', '{{.Server.Version}}'], maxOutputBytes: 64 * 1024, timeoutMs: 5_000 };
}

export function listCommand(): CommandSpec {
  const format = '{{json .ID}}\t{{json .Names}}\t{{json .Image}}\t{{json .State}}\t{{json .Status}}\t{{json .CreatedAt}}\t{{json .RunningFor}}\t{{json .Ports}}\t{{json .Networks}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.Label "com.docker.compose.container-number"}}';
  return { operation: 'list', argv: ['ps', '-a', '--no-trunc', '--format', format], maxOutputBytes: 1 * 1024 * 1024, timeoutMs: 8_000 };
}

export function inspectCommand(ids: readonly string[]): CommandSpec {
  const safeIds = assertContainerIds(ids);
  const format = '{{json .Id}}\t{{json .Name}}\t{{json .Image}}\t{{json .State.Status}}\t{{if (index .State "Health")}}{{json (index (index .State "Health") "Status")}}{{else}}{{json "none"}}{{end}}\t{{json .State.StartedAt}}\t{{json .State.FinishedAt}}\t{{json .State.ExitCode}}\t{{json .RestartCount}}\t{{json .Config.Tty}}\t{{json .HostConfig.NetworkMode}}';
  return { operation: 'inspect', argv: ['inspect', '--format', format, ...safeIds], maxOutputBytes: 1 * 1024 * 1024, timeoutMs: 8_000 };
}

export function ragflowTargetInspectCommand(id: string): CommandSpec {
  const safeId = assertContainerId(id);
  const format = '{{json .Id}}\t{{json .State.Status}}\t{{range $name, $value := .NetworkSettings.Networks}}{{json $name}}\t{{json $value.IPAddress}}{{end}}\t{{json .Config.ExposedPorts}}\t{{json .NetworkSettings.Ports}}';
  return { operation: 'inspect_ragflow_target', argv: ['inspect', '--format', format, safeId], maxOutputBytes: 128 * 1024, timeoutMs: 5_000 };
}

export function quantPostgresTargetInspectCommand(id: string): CommandSpec {
  const safeId = assertContainerId(id);
  const format = '{{json .Id}}\t{{json .State.Status}}\t{{json .Config.Labels}}\t{{json .NetworkSettings.Networks}}\t{{json .Config.ExposedPorts}}\t{{json .NetworkSettings.Ports}}';
  return { operation: 'inspect_quant_postgres_target', argv: ['inspect', '--format', format, safeId], maxOutputBytes: 128 * 1024, timeoutMs: 5_000 };
}

export function statsCommand(ids: readonly string[]): CommandSpec {
  const safeIds = assertContainerIds(ids);
  return { operation: 'stats', argv: ['stats', '--no-stream', '--format', '{{json .}}', ...safeIds], maxOutputBytes: 512 * 1024, timeoutMs: 10_000 };
}

export function logsCommand(id: string, since?: string): CommandSpec {
  const safeId = assertContainerId(id);
  const args = ['logs', '--timestamps', '--tail', '200'];
  if (since) {
    if (!/^\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z$/.test(since)) throw new Error('日志时间游标无效');
    args.push('--since', since);
  }
  args.push(safeId);
  return { operation: 'logs', argv: args, maxOutputBytes: 256 * 1024, timeoutMs: 5_000 };
}

export function isReadonlyCommand(argv: readonly string[]): boolean {
  const operation = argv[0];
  return operation === 'version' || operation === 'ps' || operation === 'inspect' || operation === 'stats' || operation === 'logs';
}
