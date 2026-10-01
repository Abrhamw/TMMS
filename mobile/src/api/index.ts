import { createApiClient, type ApiClientConfig } from './client';

let client = createApiClient({
  baseUrl: '',
  getToken: () => null,
  onUnauthorized: () => {},
});

export function getApiClient() {
  return client;
}

export function configureApiClient(config: ApiClientConfig) {
  client = createApiClient(config);
  return client;
}

export { ApiError, createApiClient } from './client';
export type { ApiClient, ApiClientConfig, QueryValue, RequestOptions } from './client';
