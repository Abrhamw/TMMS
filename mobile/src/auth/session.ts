import * as SecureStore from 'expo-secure-store';
import type { SessionUser } from '../api/types';

const SERVER_URL_KEY = 'tmms_server_url';
const TOKEN_KEY = 'tmms_token';
const USER_KEY = 'tmms_user';

export interface StoredSession {
  serverUrl: string;
  token: string;
  user: SessionUser | null;
}

export async function readServerUrl(): Promise<string | null> {
  return SecureStore.getItemAsync(SERVER_URL_KEY);
}

export async function writeServerUrl(url: string): Promise<void> {
  await SecureStore.setItemAsync(SERVER_URL_KEY, url);
}

export async function readSession(): Promise<StoredSession | null> {
  const [serverUrl, token, userRaw] = await Promise.all([
    SecureStore.getItemAsync(SERVER_URL_KEY),
    SecureStore.getItemAsync(TOKEN_KEY),
    SecureStore.getItemAsync(USER_KEY),
  ]);
  if (!serverUrl || !token) return null;
  let user: SessionUser | null = null;
  if (userRaw) {
    try {
      user = JSON.parse(userRaw) as SessionUser;
    } catch {
      user = null;
    }
  }
  return { serverUrl, token, user };
}

export async function writeSession(token: string, user: SessionUser): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(TOKEN_KEY, token),
    SecureStore.setItemAsync(USER_KEY, JSON.stringify(user)),
  ]);
}

export async function writeUser(user: SessionUser): Promise<void> {
  await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
}

export async function clearSession(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(TOKEN_KEY),
    SecureStore.deleteItemAsync(USER_KEY),
  ]);
}
