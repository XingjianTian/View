import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { TransportError } from '../transport/types.js';

const AbsolutePath = z.string().min(1).max(1024).refine((value) => path.isAbsolute(value));

const LocalProfileSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.literal('local'),
  context: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/).default('desktop-linux'),
  dockerPath: AbsolutePath.optional(),
  businessEndpoints: z.record(z.string().min(1).max(128), z.string().max(2048)).default({}),
  statusEndpoints: z.record(z.string().min(1).max(128), z.string().max(2048)).default({}),
}).strict();

const SshProfileSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.literal('ssh'),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(128),
  knownHostsPath: AbsolutePath,
  identityFile: AbsolutePath.optional(),
  passwordRef: AbsolutePath.optional(),
  sudoPasswordRef: AbsolutePath.optional(),
  password: z.string().max(4096).optional(),
  sudoPassword: z.string().max(4096).optional(),
  dockerPath: z.string().regex(/^[a-zA-Z0-9_./-]{1,256}$/).default('docker'),
  deadlineCommand: z.string().regex(/^(timeout|gtimeout)$/).optional(),
  businessEndpoints: z.record(z.string().min(1).max(128), z.string().max(2048)).default({}),
  statusEndpoints: z.record(z.string().min(1).max(128), z.string().max(2048)).default({}),
}).strict();

export const PrivateProfileSchema = z.discriminatedUnion('kind', [LocalProfileSchema, SshProfileSchema]);
type PrivateProfileSchemaOutput = z.infer<typeof PrivateProfileSchema>;
type PrivateLocalProfileSchemaOutput = z.infer<typeof LocalProfileSchema>;
type PrivateSshProfileSchemaOutput = z.infer<typeof SshProfileSchema>;
type PrivateLocalProfile = Omit<PrivateLocalProfileSchemaOutput, 'statusEndpoints'> & { statusEndpoints?: Record<string, string> };
export type PrivateSshProfile = Omit<PrivateSshProfileSchemaOutput, 'statusEndpoints'> & { statusEndpoints?: Record<string, string> };
export type PrivateProfile = PrivateLocalProfile | PrivateSshProfile;

export async function readPrivateProfile(sourcePath: string): Promise<PrivateProfile> {
  let text: string;
  try {
    text = await readFile(sourcePath, 'utf8');
  } catch {
    throw new TransportError('profile_missing', '连接 profile 不可读取。');
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    return PrivateProfileSchema.parse(normalizeJson(raw));
  } catch {
    const parsed = parseNasAccessText(text, sourcePath);
    if (!parsed) throw new TransportError('profile_invalid', '连接 profile 格式无效。');
    return parsed;
  }
}

export async function resolveSecret(profile: PrivateSshProfile, kind: 'password' | 'sudoPassword'): Promise<string | undefined> {
  const direct = profile[kind];
  const ref = kind === 'password' ? profile.passwordRef : profile.sudoPasswordRef;
  if (direct !== undefined) return direct;
  if (!ref) return undefined;
  try {
    const secret = (await readFile(ref, 'utf8')).trim();
    if (!secret || secret.length > 4096) throw new Error('secret invalid');
    return secret;
  } catch {
    throw new TransportError('profile_invalid', 'profile 的秘密引用不可读取。');
  }
}

function normalizeJson(raw: Record<string, unknown>): Record<string, unknown> {
  const kind = raw.kind === 'ssh' || raw.transport === 'ssh' ? 'ssh' : 'local';
  if (kind === 'local') {
    return { id: raw.id ?? raw.profileId, kind: 'local', context: raw.context ?? 'desktop-linux', dockerPath: raw.dockerPath, businessEndpoints: raw.businessEndpoints, statusEndpoints: raw.statusEndpoints };
  }
  return {
    id: raw.id ?? raw.profileId,
    kind: 'ssh',
    host: raw.host ?? raw.ip ?? raw.address,
    port: Number(raw.port ?? 22),
    username: raw.username ?? raw.account,
    knownHostsPath: raw.knownHostsPath ?? path.join(os.homedir(), '.ssh', 'known_hosts'),
    identityFile: raw.identityFile ?? raw.privateKeyPath,
    passwordRef: raw.passwordRef,
    sudoPasswordRef: raw.sudoPasswordRef,
    password: raw.password,
    sudoPassword: raw.sudoPassword,
    dockerPath: raw.dockerPath ?? 'docker',
    deadlineCommand: raw.deadlineCommand,
    businessEndpoints: raw.businessEndpoints,
    statusEndpoints: raw.statusEndpoints,
  };
}

function parseNasAccessText(text: string, sourcePath: string): PrivateProfile | null {
  const lines = text.split(/\r?\n/);
  let inNas = false;
  const values = new Map<string, string>();
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('#')) {
      inNas = /^##\s*NAS\s*$/i.test(line);
      continue;
    }
    if (!inNas) continue;
    const match = line.match(/^[-*]?\s*([^:：=]+)\s*[:：=]\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1]?.trim().toLowerCase();
    const value = match[2]?.trim();
    if (key && value) values.set(key, value);
  }
  const host = values.get('ip') ?? values.get('host') ?? values.get('address');
  const username = values.get('account') ?? values.get('username');
  const portText = values.get('port');
  const port = portText ? Number(portText) : 22;
  if (!host || !username || !Number.isInteger(port)) return null;
  const privateKeyPath = values.get('private key path');
  const password = values.get('password');
  return PrivateProfileSchema.parse({
    id: path.basename(sourcePath, path.extname(sourcePath)).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64) || 'nas-profile',
    kind: 'ssh',
    host,
    port,
    username,
    knownHostsPath: path.join(os.homedir(), '.ssh', 'known_hosts'),
    identityFile: privateKeyPath && path.isAbsolute(privateKeyPath) ? privateKeyPath : undefined,
    password,
    sudoPassword: password,
    dockerPath: 'docker',
    businessEndpoints: {},
    statusEndpoints: {},
  });
}
