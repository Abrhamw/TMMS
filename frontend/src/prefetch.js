import { api } from './api';

const ROUTE_ENDPOINTS = {
  '/dashboard': ['/dashboard/summary'],
  '/executive': ['/executive/summary'],
  '/mailbox': ['/mailbox/summary'],
};

export function prefetchRoute(to) {
  const path = String(to || '').split('?')[0];
  const endpoints = ROUTE_ENDPOINTS[path];
  if (!endpoints) return;
  for (const endpoint of endpoints) api.prefetch(endpoint);
}

export function warmData({ executive = false } = {}) {
  const run = () => {
    api.prefetch('/dashboard/summary');
    if (executive) {
      api.prefetch('/executive/summary');
      api.prefetch('/mailbox/summary');
    } else {
      api.prefetch('/mailbox/summary');
    }
  };
  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    window.requestIdleCallback(run, { timeout: 2500 });
  } else {
    setTimeout(run, 800);
  }
}
