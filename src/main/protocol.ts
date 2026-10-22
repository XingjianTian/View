import { app, net, protocol } from 'electron';
import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

export function registerAppScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
    },
  ]);
}

export function registerAppProtocol() {
  const root = path.join(app.getAppPath(), 'dist', 'renderer');
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'observatory' || (request.method !== 'GET' && request.method !== 'HEAD')) {
        return new Response('Not found', { status: 404 });
      }
      const decoded = decodeURIComponent(url.pathname);
      const relative = decoded.replace(/^\/+/, '');
      if (!relative || relative.includes('\\') || relative.split('/').includes('..')) {
        return new Response('Not found', { status: 404 });
      }
      const file = path.resolve(root, relative);
      if (file !== root && !file.startsWith(`${root}${path.sep}`)) return new Response('Not found', { status: 404 });
      await access(file);
      const fileStat = await stat(file);
      if (!fileStat.isFile()) return new Response('Not found', { status: 404 });
      const contentType = MIME_TYPES[path.extname(file)] ?? 'application/octet-stream';
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-type': contentType } });
      return new Response(createReadStream(file) as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': contentType, 'cache-control': 'no-store' },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

export async function assertRendererAssets() {
  const index = path.join(app.getAppPath(), 'dist', 'renderer', 'index.html');
  await access(index);
  return index;
}
