import { describe, it, expect } from 'vitest';
import { routeRedirect } from './auth';

const user = (role) => ({ role });

describe('routeRedirect', () => {
  it('sends anonymous users to login', () => {
    expect(routeRedirect(null, 'task:read')).toBe('/login');
  });

  it('allows ADMIN (wildcard) through every guarded route', () => {
    expect(routeRedirect(user('ADMIN'), 'crew:read')).toBeNull();
    expect(routeRedirect(user('ADMIN'), 'report:read', { blockExecutive: false })).toBeNull();
  });

  it('allows a role that holds the required read permission', () => {
    expect(routeRedirect(user('CREW_MEMBER'), 'task:read')).toBeNull();
    expect(routeRedirect(user('VIEWER'), 'report:read')).toBeNull();
  });

  it('redirects a role lacking the permission to home', () => {
    expect(routeRedirect(user('CREW_MEMBER'), 'crew:read')).toBe('/home');
    expect(routeRedirect(user('CREW_MEMBER'), 'report:write')).toBe('/home');
    expect(routeRedirect(user('VIEWER'), 'report:write')).toBe('/home');
  });

  it('keeps the briefing-only surface for executives when blockExecutive is set', () => {
    expect(routeRedirect(user('EXECUTIVE'), 'asset:read', { blockExecutive: true })).toBe('/executive');
    expect(routeRedirect(user('EXECUTIVE'), 'asset:read')).toBeNull();
  });

  it('supports any-of permission lists', () => {
    expect(routeRedirect(user('CREW_LEAD'), null, { any: ['user:manage', 'task:execute'] })).toBeNull();
    expect(routeRedirect(user('CREW_MEMBER'), null, { any: ['user:manage', 'settings:write'] })).toBe('/home');
  });

  it('denies unknown roles and never loops executives to an unguarded page', () => {
    expect(routeRedirect(user('NOPE'), 'task:read')).toBe('/home');
    expect(routeRedirect(user('EXECUTIVE'), 'user:manage')).toBe('/executive');
  });
});
