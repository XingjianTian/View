import { readPrivateProfile, type PrivateProfile } from '../credentials/profile-reader.js';
import type { ProfileReference } from '../../shared/contracts.js';
import { LocalDockerTransport } from './local-docker.js';
import { SshDockerTransport, type SshDockerTraceEvent } from './ssh-docker.js';
import { TransportError, type DockerTransport } from './types.js';

export type DockerTransportOptions = {
  trace?: (event: SshDockerTraceEvent) => void;
};

export async function createDockerTransport(reference: ProfileReference, options: DockerTransportOptions = {}): Promise<DockerTransport> {
  const profile = await readPrivateProfile(reference.sourcePath);
  if (profile.id !== reference.id || profile.kind !== reference.kind) {
    throw new TransportError('profile_invalid', 'profile 身份与登记引用不一致。');
  }
  return transportForProfile(profile, options);
}

export function transportForProfile(profile: PrivateProfile, options: DockerTransportOptions = {}): DockerTransport {
  if (profile.kind === 'local') return new LocalDockerTransport({ ...(profile.dockerPath ? { cliPath: profile.dockerPath } : {}), context: profile.context });
  return new SshDockerTransport({ profile, ...(options.trace ? { trace: options.trace } : {}) });
}
