// Session storage strategy.
//
// The sign-in is kept in two places:
//   * sessionStorage — this tab's own session, so two tabs can hold two
//     different users at the same time.
//   * localStorage   — the most recent sign-in, inherited by a newly opened
//     tab that has no session of its own.
//
// A tab always prefers its own session. Signing in writes both, so an existing
// tab is never switched by a login elsewhere (its own session wins) while new
// tabs get the latest user. Signing out only clears the shared default when it
// belongs to the session being ended.
const TOKEN_KEY = 'tmms_token';
const USER_KEY = 'tmms_user';

function tabStore() {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch (_) {
    return null;
  }
}

function defaultStore() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch (_) {
    return null;
  }
}

function read(store, key) {
  if (!store) return null;
  try { return store.getItem(key); } catch (_) { return null; }
}

function write(store, key, value) {
  if (!store) return;
  try { store.setItem(key, value); } catch (_) { /* ignore */ }
}

function remove(store, key) {
  if (!store) return;
  try { store.removeItem(key); } catch (_) { /* ignore */ }
}

export function getSessionToken() {
  return read(tabStore(), TOKEN_KEY) || read(defaultStore(), TOKEN_KEY);
}

export function getSessionUser() {
  return read(tabStore(), USER_KEY) || read(defaultStore(), USER_KEY);
}

export function setSession(token, user) {
  const tab = tabStore();
  const def = defaultStore();
  if (tab) { write(tab, TOKEN_KEY, token); write(tab, USER_KEY, JSON.stringify(user)); }
  // A tab signed in for the first time becomes the default for new tabs.
  if (def) { write(def, TOKEN_KEY, token); write(def, USER_KEY, JSON.stringify(user)); }
}

// Refresh the cached user without touching the token (e.g. after /auth/me).
// The shared default is only refreshed when it is this tab's own session, so a
// background tab cannot rewrite another tab's default user.
export function setSessionUser(user) {
  const tab = tabStore();
  const def = defaultStore();
  if (tab) write(tab, USER_KEY, JSON.stringify(user));
  const defTok = read(def, TOKEN_KEY);
  if (defTok && defTok === getSessionToken()) write(def, USER_KEY, JSON.stringify(user));
}

// End a session. `token` is the session being ended (the failing or current
// token): the shared default is only removed when it is that same token, so
// signing out in one tab never evicts another tab's user.
export function clearSession(token) {
  const tabTok = read(tabStore(), TOKEN_KEY);
  remove(tabStore(), TOKEN_KEY);
  remove(tabStore(), USER_KEY);
  const def = defaultStore();
  const defTok = read(def, TOKEN_KEY);
  if (!defTok) return;
  // Remove the shared default when it is the session being ended, or when the
  // tab was relying on the default and no explicit token was supplied.
  if (token ? defTok === token : !tabTok) {
    remove(def, TOKEN_KEY);
    remove(def, USER_KEY);
  }
}
