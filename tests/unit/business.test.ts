import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { HttpJsonBusinessAdapter } from '../../src/main/business/http-json.js';
import { BusinessAdapterSchema } from '../../src/shared/contracts.js';

async function serverFor(handler: (path: string, response: (status: number, body: string, headers?: Record<string, string>) => void) => void): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const finish = (status: number, body: string, headers: Record<string, string> = { 'content-type': 'application/json' }) => {
      response.writeHead(status, headers);
      response.end(body);
    };
    handler(request.url ?? '/', finish);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return { url: `http://127.0.0.1:${address.port}`, server, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

const now = new Date('2026-10-20T10:00:00.000Z');

function adapter(endpointRef = 'profile://business') {
  return BusinessAdapterSchema.parse({ kind: 'http_json', profileId: 'profile', endpointRef, mapping: {
    scopeType: '/meta/type', scopeId: '/meta/id', sourceAt: '/meta/source_at', total: '/counts/total', succeeded: '/counts/succeeded', failed: '/counts/failed', active: '/counts/active', waiting: '/counts/waiting', cancelled: '/counts/cancelled',
  }});
}

describe('optional business adapters', () => {
  it('returns an explicit not-configured observation for none', async () => {
    const result = await new HttpJsonBusinessAdapter({ resolveEndpoint: async () => undefined }).read({ kind: 'none' }, now);
    expect(result.status).toBe('not_configured');
    expect(result.progress).toBeNull();
  });

  it('maps an isolated JSON endpoint and computes separate completion and success rates', async () => {
    const sourceAt = '2026-10-20T09:59:30.000Z';
    const server = await serverFor((_path, response) => response(200, JSON.stringify({ meta: { type: 'batch', id: 'batch-1', source_at: sourceAt }, counts: { total: 10, succeeded: 6, failed: 1, active: 1, waiting: 1, cancelled: 1 } })));
    try {
      const result = await new HttpJsonBusinessAdapter({ resolveEndpoint: async () => `${server.url}/metrics` }).read(adapter(), now);
      expect(result.status).toBe('fresh');
      expect(result.progress).toEqual({ completedPercent: 80, successPercent: 60 });
      expect(result.scopeId).toBe('batch-1');
    } finally { await server.close(); }
  });

  it('keeps unknown denominator and mixed counters uncomputable', async () => {
    const server = await serverFor((_path, response) => response(200, JSON.stringify({ meta: { type: 'queue', id: 'queue-1', source_at: now.toISOString() }, counts: { total: null, succeeded: 2, failed: 1, active: 0, waiting: 0, cancelled: 0 } })));
    try {
      const result = await new HttpJsonBusinessAdapter({ resolveEndpoint: async () => server.url }).read(adapter(), now);
      expect(result.status).toBe('uncomputable');
      expect(result.errorCode).toBe('business_uncomputable');
      expect(result.progress).toBeNull();
    } finally { await server.close(); }

    const invalidServer = await serverFor((_path, response) => response(200, JSON.stringify({ meta: { type: 'batch', id: 'batch-2', source_at: now.toISOString() }, counts: { total: 3, succeeded: 2, failed: 2, active: 0, waiting: 0, cancelled: 0 } })));
    try {
      const result = await new HttpJsonBusinessAdapter({ resolveEndpoint: async () => invalidServer.url }).read(adapter(), now);
      expect(result.status).toBe('uncomputable');
    } finally { await invalidServer.close(); }
  });

  it('marks expired source data stale and refuses redirects or unsafe endpoints', async () => {
    const expired = await serverFor((_path, response) => response(200, JSON.stringify({ meta: { type: 'archive', id: 'archive-1', source_at: '2026-10-20T09:00:00.000Z' }, counts: { total: 2, succeeded: 2, failed: 0, active: 0, waiting: 0, cancelled: 0 } })));
    try {
      const result = await new HttpJsonBusinessAdapter({ resolveEndpoint: async () => expired.url }).read(adapter(), now);
      expect(result.status).toBe('stale');
      expect(result.errorCode).toBe('business_expired');
    } finally { await expired.close(); }

    const redirect = await serverFor((_path, response) => response(302, '', { location: 'https://example.invalid' }));
    try {
      const result = await new HttpJsonBusinessAdapter({ resolveEndpoint: async () => redirect.url }).read(adapter(), now);
      expect(result.errorCode).toBe('business_redirect');
    } finally { await redirect.close(); }

    const unsafe = await new HttpJsonBusinessAdapter({ resolveEndpoint: async () => 'file:///private/secret' }).read(adapter(), now);
    expect(unsafe.errorCode).toBe('business_invalid');
  });

  it('maps timeout and oversized responses without returning raw endpoint data', async () => {
    const timedOut = new HttpJsonBusinessAdapter({ resolveEndpoint: async () => 'https://example.invalid', fetcher: async () => { throw new DOMException('timeout', 'AbortError'); } });
    expect((await timedOut.read(adapter(), now)).errorCode).toBe('business_timeout');
    const oversized = new HttpJsonBusinessAdapter({ resolveEndpoint: async () => 'https://example.invalid', fetcher: async () => new Response('x'.repeat(256 * 1024 + 1), { status: 200, headers: { 'content-type': 'application/json' } }) });
    expect((await oversized.read(adapter(), now)).errorCode).toBe('business_invalid');
  });
});
