import { app } from 'electron';
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  AppConfigSchema,
  type AppConfig,
  createDefaultConfig,
  DisplayPrefsSchema,
  DeviceSchema,
  ServiceSchema,
  WindowBoundsSchema,
  type Device,
  type DisplayPrefs,
  type Service,
  type WindowBounds,
} from '../../shared/contracts.js';

const CONFIG_FILE = 'config.json';
const BACKUP_FILE = 'config.json.bak';

export class ConfigStore {
  readonly root: string;
  readonly configPath: string;
  readonly backupPath: string;
  private config: AppConfig = createDefaultConfig();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(root = process.env.SERVICE_OBSERVATORY_DATA_DIR ?? app.getPath('userData')) {
    this.root = root;
    this.configPath = path.join(root, CONFIG_FILE);
    this.backupPath = path.join(root, BACKUP_FILE);
  }

  async load() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.config = await this.readValidConfig(this.configPath) ?? await this.readValidConfig(this.backupPath) ?? createDefaultConfig();
    return this.snapshot();
  }

  snapshot(): AppConfig {
    return structuredClone(this.config);
  }

  getWindowBounds(): WindowBounds | null {
    return this.config.window ? structuredClone(this.config.window) : null;
  }

  async saveDevice(input: unknown) {
    const device = DeviceSchema.parse(input);
    const devices = this.config.devices.filter((item) => item.id !== device.id);
    devices.push(device);
    return this.commit(AppConfigSchema.parse({ ...this.config, devices }));
  }

  async removeDevice(id: string) {
    const devices = this.config.devices.filter((item) => item.id !== id);
    const services = this.config.services.map((service) => ({
      ...service,
      bindings: service.bindings.filter((binding) => binding.deviceId !== id),
    }));
    return this.commit(AppConfigSchema.parse({ ...this.config, devices, services }));
  }

  async saveService(input: unknown) {
    const service = ServiceSchema.parse(input);
    const services = this.config.services.filter((item) => item.id !== service.id);
    services.push(service);
    return this.commit(AppConfigSchema.parse({ ...this.config, services }));
  }

  async removeService(id: string) {
    const services = this.config.services.filter((item) => item.id !== id);
    const slots = this.config.slots.map((slot) => slot.serviceId === id ? { serviceId: null, logBindingId: null } : slot) as AppConfig['slots'];
    return this.commit(AppConfigSchema.parse({ ...this.config, services, slots }));
  }

  async saveDisplay(input: unknown) {
    const display = DisplayPrefsSchema.parse(input);
    return this.commit(AppConfigSchema.parse({ ...this.config, display }));
  }

  async saveWindowBounds(input: unknown) {
    const window = WindowBoundsSchema.parse(input);
    return this.commit(AppConfigSchema.parse({ ...this.config, window }));
  }

  async setSlots(input: unknown) {
    const slots = AppConfigSchema.shape.slots.parse(input);
    return this.commit(AppConfigSchema.parse({ ...this.config, slots }));
  }

  private async readValidConfig(file: string): Promise<AppConfig | null> {
    try {
      const text = await readFile(file, 'utf8');
      const parsed = AppConfigSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async commit(next: AppConfig) {
    this.config = next;
    const text = `${JSON.stringify(next, null, 2)}\n`;
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const tempPath = `${this.configPath}.${process.pid}.${Date.now()}.tmp`;
      const handle = await open(tempPath, 'w', 0o600);
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await stat(this.configPath);
        await rename(this.configPath, this.backupPath);
      } catch {
        // There is no previous valid file on first save.
      }
      await rename(tempPath, this.configPath);
    });
    await this.writeChain;
    return this.snapshot();
  }
}

export function isDevice(value: unknown): value is Device {
  return DeviceSchema.safeParse(value).success;
}

export function isService(value: unknown): value is Service {
  return ServiceSchema.safeParse(value).success;
}
