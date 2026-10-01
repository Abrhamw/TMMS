import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function clientWith(fetchImpl: typeof fetch, token: string | null = 'tok', onUnauthorized = vi.fn()) {
  const client = createApiClient({
    baseUrl: 'https://tmms.example.com/',
    getToken: () => token,
    onUnauthorized,
    fetchImpl,
  });
  return { client, onUnauthorized };
}

describe('api client', () => {
  it('trims a trailing slash from the base url', () => {
    const { client } = clientWith(vi.fn());
    expect(client.baseUrl).toBe('https://tmms.example.com');
  });

  it('sends the bearer token and hits /api', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const { client } = clientWith(fetchImpl as unknown as typeof fetch);

    await client.get('/auth/me');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://tmms.example.com/api/auth/me');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('omits the authorization header without a token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const { client } = clientWith(fetchImpl as unknown as typeof fetch, null);

    await client.get('/health');

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('serializes query parameters, skipping null and undefined', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const { client } = clientWith(fetchImpl as unknown as typeof fetch);

    await client.get('/tasks', { status: 'ASSIGNED', region_id: 3, empty: null, missing: undefined });

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://tmms.example.com/api/tasks?status=ASSIGNED&region_id=3');
  });

  it('throws the server error message from a JSON body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'Invalid credentials' }, 401));
    const { client } = clientWith(fetchImpl as unknown as typeof fetch);

    await expect(client.post('/auth/login', {}, { allowUnauthorized: true })).rejects.toThrow(
      'Invalid credentials',
    );
  });

  it('falls back to the HTTP status when the body is not JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    const { client } = clientWith(fetchImpl as unknown as typeof fetch);

    await expect(client.get('/tasks')).rejects.toThrow('HTTP 500');
  });

  it('calls onUnauthorized and throws ApiError on 401', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'Unauthorized' }, 401));
    const { client, onUnauthorized } = clientWith(fetchImpl as unknown as typeof fetch);

    const err = await client.get('/tasks').catch((e: unknown) => e);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
  });

  it('does not treat a rejected login as an expired session', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'Invalid credentials' }, 401));
    const { client, onUnauthorized } = clientWith(fetchImpl as unknown as typeof fetch, null);

    await expect(
      client.post('/auth/login', { username: 'x', password: 'y' }, { allowUnauthorized: true }),
    ).rejects.toThrow('Invalid credentials');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
