import type { ApiClient } from './client';
import type { HealthResponse, LoginResponse, MeResponse } from './types';

export function health(client: ApiClient): Promise<HealthResponse> {
  return client.get<HealthResponse>('/health', undefined, { allowUnauthorized: true });
}

export function login(client: ApiClient, username: string, password: string): Promise<LoginResponse> {
  return client.post<LoginResponse>('/auth/login', { username, password }, { allowUnauthorized: true });
}

export function me(client: ApiClient): Promise<MeResponse> {
  return client.get<MeResponse>('/auth/me');
}

export function logout(client: ApiClient): Promise<{ ok: boolean }> {
  return client.post<{ ok: boolean }>('/auth/logout');
}
