import { dialog } from 'electron';
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  ProfileReferenceSchema,
  ProfilesReferenceFileSchema,
  ProfileSummarySchema,
  type ProfileReference,
  type ProfileSummary,
} from '../../shared/contracts.js';
import { readPrivateProfile } from './profile-reader.js';
import { StatusSourceSummarySchema, type StatusSourceSummary } from '../../shared/status.js';

type ProfileRegistryFile = {
  schemaVersion: 1;
  profiles: ProfileReference[];
};

const BACKUP_FILE = 'profiles.private.json.bak';

export class ProfileRegistry {
  private readonly filePath: string;
  private readonly backupPath: string;
  private file: ProfileRegistryFile = { schemaVersion: 1, profiles: [] };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly root: string) {
    this.filePath = path.join(root, 'profiles.private.json');
    this.backupPath = path.join(root, BACKUP_FILE);
  }

  get dataRoot(): string {
    return this.root;
  }

  async load() {
    this.file = await this.readValid(this.filePath) ?? await this.readValid(this.backupPath) ?? { schemaVersion: 1, profiles: [] };
  }

  summaries(): ProfileSummary[] {
    return this.file.profiles.map((profile) => ProfileSummarySchema.parse({
      id: profile.id,
      displayName: profile.displayName,
      kind: profile.kind,
      status: 'available',
    }));
  }

  getReference(id: string) {
    return this.file.profiles.find((profile) => profile.id === id) ?? null;
  }

  async statusEndpointSummaries(): Promise<StatusSourceSummary[]> {
    const summaries: StatusSourceSummary[] = [];
    for (const reference of this.file.profiles) {
      try {
        const profile = await readPrivateProfile(reference.sourcePath);
        const refs = new Set([...Object.keys(profile.businessEndpoints), ...Object.keys(profile.statusEndpoints ?? {})]);
        for (const endpointRef of refs) {
          if (!endpointRef.trim() || endpointRef.length > 128 || /[\u0000-\u001f\u007f]/.test(endpointRef)) continue;
          summaries.push(StatusSourceSummarySchema.parse({
            profileId: reference.id,
            kind: 'http_json',
            endpointRef,
            displayName: `${reference.displayName} · ${endpointRef}`,
          }));
        }
      } catch {
        // An unavailable private profile remains absent from the selectable list.
      }
    }
    return summaries;
  }

  async chooseAndRegister() {
    const result = await dialog.showOpenDialog({
      title: '登记私有连接资料',
      properties: ['openFile'],
      filters: [{ name: 'Profile JSON或文本', extensions: ['json', 'txt'] }],
    });
    if (result.canceled || result.filePaths.length !== 1) return null;
    const selectedPath = result.filePaths[0];
    if (!selectedPath) return null;
    const sourcePath = path.resolve(selectedPath);
    const text = await readFile(sourcePath, 'utf8');
    const metadata = this.readMetadata(text, sourcePath);
    const reference = ProfileReferenceSchema.parse({
      ...metadata,
      sourcePath,
      importedAt: new Date().toISOString(),
    });
    this.file.profiles = [...this.file.profiles.filter((profile) => profile.id !== reference.id), reference];
    await this.save();
    return ProfileSummarySchema.parse({ ...reference, status: 'available' });
  }

  private readMetadata(text: string, sourcePath: string): Pick<ProfileReference, 'id' | 'displayName' | 'kind'> {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch {
      const isNasText = /^##\s*NAS\s*$/im.test(text);
      if (!isNasText) throw new Error('profile 格式无效');
      const id = path.basename(sourcePath, path.extname(sourcePath)).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64) || 'nas-profile';
      return ProfileReferenceSchema.pick({ id: true, displayName: true, kind: true }).parse({ id, displayName: 'NAS 只读设备', kind: 'ssh' });
    }
    const id = typeof raw.id === 'string' ? raw.id : typeof raw.profileId === 'string' ? raw.profileId : '';
    const displayName = typeof raw.displayName === 'string' ? raw.displayName : typeof raw.name === 'string' ? raw.name : '';
    const kind = raw.kind === 'ssh' || raw.transport === 'ssh' ? 'ssh' : 'local';
    return ProfileReferenceSchema.pick({ id: true, displayName: true, kind: true }).parse({ id, displayName, kind });
  }

  private async save() {
    const text = `${JSON.stringify(this.file, null, 2)}\n`;
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      const handle = await open(tempPath, 'w', 0o600);
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await stat(this.filePath);
        await rename(this.filePath, this.backupPath);
      } catch {
        // There is no previous valid file on first save.
      }
      await rename(tempPath, this.filePath);
    });
    await this.writeChain;
  }

  private async readValid(filePath: string): Promise<ProfileRegistryFile | null> {
    try {
      const parsed = ProfilesReferenceFileSchema.safeParse(JSON.parse(await readFile(filePath, 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
