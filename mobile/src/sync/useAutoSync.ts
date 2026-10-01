import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { getDb } from '../db';
import { useAuth } from '../auth/context';
import { flush } from './engine';

const SYNC_INTERVAL_MS = 60_000;

export function useAutoSync(): void {
  const { client, user, ready } = useAuth();
  const running = useRef(false);

  useEffect(() => {
    if (!ready || !user) return;

    let cancelled = false;

    const run = async () => {
      if (running.current || cancelled) return;
      running.current = true;
      try {
        const db = await getDb();
        await flush({ driver: db, client });
      } catch {
        /* connectivity or auth trouble: the next trigger retries */
      } finally {
        running.current = false;
      }
    };

    void run();

    const netSubscription = NetInfo.addEventListener((state) => {
      if (state.isConnected) void run();
    });
    const appSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void run();
    });
    const timer = setInterval(() => void run(), SYNC_INTERVAL_MS);

    return () => {
      cancelled = true;
      netSubscription();
      appSubscription.remove();
      clearInterval(timer);
    };
  }, [client, user, ready]);
}
