import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { configureApiClient, getApiClient } from '../api';
import * as endpoints from '../api/endpoints';
import type { ApiClient } from '../api/client';
import type { SessionUser } from '../api/types';
import { clearSession, readSession, writeServerUrl, writeSession, writeUser } from './session';

interface AuthContextValue {
  ready: boolean;
  serverUrl: string | null;
  user: SessionUser | null;
  client: ApiClient;
  signIn: (serverUrl: string, username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  updateServerUrl: (url: string) => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

let currentToken: string | null = null;

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);

  const applyClient = useCallback((url: string) => {
    configureApiClient({
      baseUrl: url,
      getToken: () => currentToken,
      onUnauthorized: () => {
        currentToken = null;
        setUser(null);
        void clearSession();
      },
    });
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      const stored = await readSession();
      if (active && stored) {
        currentToken = stored.token;
        setServerUrl(stored.serverUrl);
        setUser(stored.user);
        applyClient(stored.serverUrl);
      }
      if (active) setReady(true);
    })();
    return () => {
      active = false;
    };
  }, [applyClient]);

  const signIn = useCallback(
    async (rawUrl: string, username: string, password: string) => {
      const url = normalizeUrl(rawUrl);
      if (!url) throw new Error('Enter the server address');
      applyClient(url);
      const client = getApiClient();
      const info = await endpoints.health(client);
      if (!info || info.service !== 'tmms-backend') {
        throw new Error('That address does not look like a TMMS server');
      }
      const result = await endpoints.login(client, username, password);
      currentToken = result.token;
      await writeServerUrl(url);
      await writeSession(result.token, result.user);
      setServerUrl(url);
      setUser(result.user);
    },
    [applyClient],
  );

  const signOut = useCallback(async () => {
    try {
      await endpoints.logout(getApiClient());
    } catch {
      /* sign-out proceeds locally even if the call fails */
    }
    currentToken = null;
    await clearSession();
    setUser(null);
  }, []);

  const updateServerUrl = useCallback(
    async (rawUrl: string) => {
      const url = normalizeUrl(rawUrl);
      currentToken = null;
      await writeServerUrl(url);
      setServerUrl(url);
      setUser(null);
      applyClient(url);
    },
    [applyClient],
  );

  const refreshUser = useCallback(async () => {
    const data = await endpoints.me(getApiClient());
    setUser(data.user);
    await writeUser(data.user);
  }, []);

  const value: AuthContextValue = {
    ready,
    serverUrl,
    user,
    client: getApiClient(),
    signIn,
    signOut,
    updateServerUrl,
    refreshUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
