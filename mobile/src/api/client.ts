export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  allowUnauthorized?: boolean;
  signal?: AbortSignal;
}

export interface ApiClientConfig {
  baseUrl: string;
  getToken: () => string | null;
  onUnauthorized: () => void;
  fetchImpl?: typeof fetch;
}

export interface ApiClient {
  readonly baseUrl: string;
  get<T>(path: string, query?: Record<string, QueryValue>, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  del<T>(path: string, options?: RequestOptions): Promise<T>;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function buildQuery(query?: Record<string, QueryValue>): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    if (data && typeof data.error === 'string') return data.error;
  } catch {
    /* body was not JSON */
  }
  return `HTTP ${res.status}`;
}

export function createApiClient(config: ApiClientConfig): ApiClient {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const doFetch = config.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function request<T>(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions,
  ): Promise<T> {
    const token = config.getToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const controller = new AbortController();
    const signal = options.signal ?? controller.signal;

    const res = await doFetch(`${baseUrl}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });

    if (res.status === 401 && !options.allowUnauthorized) {
      config.onUnauthorized();
      throw new ApiError('Session expired. Please sign in again.', 401);
    }
    if (!res.ok) {
      throw new ApiError(await errorMessage(res), res.status);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return {
    baseUrl,
    get: <T>(path: string, query?: Record<string, QueryValue>, options: RequestOptions = {}) =>
      request<T>('GET', `${path}${buildQuery(query)}`, undefined, options),
    post: <T>(path: string, body?: unknown, options: RequestOptions = {}) =>
      request<T>('POST', path, body ?? {}, options),
    put: <T>(path: string, body?: unknown, options: RequestOptions = {}) =>
      request<T>('PUT', path, body ?? {}, options),
    patch: <T>(path: string, body?: unknown, options: RequestOptions = {}) =>
      request<T>('PATCH', path, body ?? {}, options),
    del: <T>(path: string, options: RequestOptions = {}) =>
      request<T>('DELETE', path, undefined, options),
  };
}
