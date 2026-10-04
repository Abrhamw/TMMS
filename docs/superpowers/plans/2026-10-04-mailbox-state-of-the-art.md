# Mailbox: State-of-the-Art 3-Pane Client - Implementation Plan

> **For agentic workers:** Execute this plan task-by-task, in order. Steps use checkbox (`- [ ]`) syntax for tracking. Verify each task before moving on. Stage explicit paths only; never `git add -A`; never commit `backend/tmms.db*`, `backend/tmms1.db-shm/-wal`, `backend/uploads/`, `dist/`, `design/`, `mobile/LICENSE`.

**Goal:** Rebuild the mailbox as a 3-pane client with a real Junk/Trash lifecycle, lazy per-account auto-junk classification with manual override, a clearly separated reading pane, and the full dynamic interaction set (optimistic actions, undo, bulk, keyboard, swipe, inline reply).

**Architecture:** Backend extends `message_state` additively (`deleted_at`, `junk_at`, `junk_reason`, `starred_at`), adds a small `mail_junk_rule` override table, new folder definitions and endpoints in `backend/routes/mailbox.js`, and pure junk rules in `backend/mail.js`. Frontend turns `pages/Mailbox.jsx` into a thin orchestrator over a new `pages/mailbox/` component folder driven by a `useMailStore` hook.

**Tech Stack:** Node 22 (`node:sqlite`, `node --test`), Express; React 19, Vite 7, Tailwind 4, `motion`, `lucide-react`, vendored `src/ui` kit. Verify with backend tests, `npm run build`, and headless Playwright.

**Spec:** `docs/superpowers/specs/2026-10-04-mailbox-state-of-the-art-design.md`

## Global Constraints

- All API changes are additive; no existing endpoint, field or response shape is removed or renamed.
- Schema changes use the idempotent `migrate()` helper (`backend/db.js:990`) and `CREATE TABLE IF NOT EXISTS`; no drops, no destructive SQL, no data loss.
- Junk/trash actions apply to directed mail only; activity-feed items keep read + archive.
- Permanent delete is per-account (recipient link + state, or sender `deleted_at`); never remove a message other participants hold.
- Reuse existing visibility helpers (`mailParticipant`, `mailVisible`, `loadMailVisible`) and auth middleware on every new handler.
- No code comments. Stage explicit paths only; never `git add -A`.
- New i18n keys (`mailboxJunk`, `mailboxTrash`, `mailboxJunkAction`, `mailboxTrashAction`, `mailboxMore`, `mailboxJunkReason`, `mailboxShortcuts`, `mailboxEmptyJunk`, `mailboxEmptyTrash`) added to every locale in `frontend/src/i18n.js` and mirrored in `frontend/src/phrases.am.js`.
- Motion respects `prefers-reduced-motion`; keyboard focus stays visible; light and dark themes use tokens only.

## File Structure

- `backend/db.js` - `migrate()` calls for the four `message_state` columns; `CREATE TABLE IF NOT EXISTS mail_junk_rule`.
- `backend/mail.js` - internal-domain cache, `SPAM_KEYWORDS`, `junkSignals()`, `classifyIncoming()` helpers.
- `backend/routes/mailbox.js` - folder defs, `mailWhere`/`mailCounts`, classification hook, new endpoints, bulk extension.
- `backend/test/mailboxJunkTrash.test.js` - new tests.
- `frontend/src/pages/Mailbox.jsx` - thin orchestrator (route entry preserved).
- `frontend/src/pages/mailbox/` - `MailLayout`, `FolderRail`, `MessageList`, `ReadingPane`, `ThreadView`, `ComposePanel`, `MessageActions`, `UndoToast`, `EmptyState`, `MailSkeleton`, `mailStore.js`, `useMailKeyboard.js`, `useSwipe.js`, `bodyText.js`.
- `frontend/src/styles.css` - `.mail-*` styles.
- `frontend/src/i18n.js`, `frontend/src/phrases.am.js` - new keys.

## Phase M1 - Backend data model and junk engine

### Task M1.1: Schema

- [ ] Step 1: After the `message_state` `CREATE TABLE`, add `migrate('message_state', 'deleted_at', 'ALTER TABLE message_state ADD COLUMN deleted_at TEXT')` and the same for `junk_at TEXT`, `junk_reason TEXT`, `starred_at TEXT`.
- [ ] Step 2: Add `CREATE TABLE IF NOT EXISTS mail_junk_rule (...)` (columns per spec 4.1) next to the other mail tables, with a `UNIQUE(owner_user_id, match_type, value)`.
- [ ] Step 3: Start the backend; confirm existing data loads and the new columns/table exist via `PRAGMA table_info(message_state)`.

### Task M1.2: Junk rules (`backend/mail.js`)

- [ ] Step 1: Add a module-level cache of internal email domains built from `SELECT DISTINCT email FROM person WHERE active = 1 AND email IS NOT NULL`, reduced to lowercased domains, with a getter that builds it once.
- [ ] Step 2: Define `SPAM_KEYWORDS` (lowercased) and a `domainOf(email)` helper.
- [ ] Step 3: Add `junkSignals({ subject, body, senderPersonId })` returning `{ externalDomain, spamKeywords, unknownSender }` and a `junkReasonFor(signals)` that maps to a human string.
- [ ] Step 4: Add `domainsForSender(personId)`/`senderRuleValue(...)` helpers used by the not-junk override.
- [ ] Step 5: Export the new helpers and add a focused unit test for `junkSignals` (external vs internal domain, keyword hit, unknown sender).

### Task M1.3: Folder definitions and counts (`backend/routes/mailbox.js`)

- [ ] Step 1: Extend `MAIL_FOLDER_DEFS` with `junk: { direction: 'in', status: 'SENT', archived: false, junk: true }` and `trash: { direction: 'any', status: null, deleted: true }`.
- [ ] Step 2: Extend `mailWhere()` to append `AND EXISTS/NOT EXISTS (message_state ... deleted_at)` for `def.deleted` and the junk predicate for `def.junk`; add `deleted_at IS NULL` + `junk_at IS NULL` to `mailinbox` and `deleted_at IS NULL` to `outbox`/`mailsent`/`drafts`/`archive`.
- [ ] Step 3: Extend `mailCounts()` with `junk`, `trash` and `junk_unread` (junk + unread), leaving existing keys untouched.
- [ ] Step 4: `GET /mailbox` and `GET /mailbox/summary` return the new counts; confirm no existing key changed.

### Task M1.4: Lazy classification hook

- [ ] Step 1: Add `classifyIncoming(user)`: select incoming SENT messages with no `message_state` row for `user.id` (bounded batch, e.g. 500) joined to `person` for email/active.
- [ ] Step 2: For each, evaluate `junkSignals` minus the account's `mail_junk_rule` overrides; insert a `message_state` row with `junk_at`+`junk_reason` when matched, else all-null flags (so it is never re-evaluated).
- [ ] Step 3: Call `classifyIncoming(user)` at the top of `GET /mailbox` and `GET /mailbox/folder` before counting/querying.
- [ ] Step 4: Verify: send a message from an unknown/external sender, load the mailbox, and confirm it lands in Junk with a reason; internal mail stays in Inbox.

## Phase M2 - Backend endpoints

### Task M2.1: Junk / not-junk and rules

- [ ] Step 1: `PUT /mailbox/messages/:id/junk { junk }` - `true` sets `junk_at`+`junk_reason='MANUAL'`; `false` clears both and upserts a `mail_junk_rule` (domain preferred, else `SENDER` person id).
- [ ] Step 2: `GET /mailbox/junk-rules` (caller's rules) and `DELETE /mailbox/junk-rules/:id` (owner-scoped).
- [ ] Step 3: Guard every handler with `loadMailVisible`.

### Task M2.2: Trash / restore

- [ ] Step 1: `PUT /mailbox/messages/:id/trash { trash }` sets/clears `deleted_at`.
- [ ] Step 2: Guard with `loadMailVisible`; returning `{ ok: true, deleted_at }`.

### Task M2.3: Star

- [ ] Step 1: `PUT /mailbox/messages/:id/star { starred }` sets/clears `starred_at`.
- [ ] Step 2: Include `starred` in `mailRow()` output (additive).

### Task M2.4: Permanent delete and empty trash

- [ ] Step 1: `DELETE /mailbox/messages/:id` - recipient: delete `message_recipient` link + `message_state`; sender-only: upsert `message_state.deleted_at`; both: resolve after.
- [ ] Step 2: After the row work, for each attachment `stored_name` on the message, delete the file only when no remaining `message_attachment` references it.
- [ ] Step 3: `POST /mailbox/trash/empty` - loop the caller's trashed messages through the same per-account delete; return `{ deleted: n }`.

### Task M2.5: Bulk and summary

- [ ] Step 1: Extend `POST /mailbox/messages/bulk` to accept `action` in `junk|not_junk|trash|restore|star|unstar|delete`, reusing the single-message logic; preserve existing actions.
- [ ] Step 2: Ensure `GET /mailbox/summary` exposes `junk`/`trash`/`junk_unread`.

### Task M2.6: Tests

- [ ] Step 1: `backend/test/mailboxJunkTrash.test.js` using the existing temp-db harness: folder defs, auto-classification + override, junk/not-junk, trash/restore, star, per-account permanent-delete isolation, attachment GC, and extended counts.
- [ ] Step 2: `node --test "test/*.test.js"` all pass (30 existing + new).

## Phase M3 - Frontend foundation

### Task M3.1: Store

- [ ] Step 1: `pages/mailbox/mailStore.js` - a hook owning folders, counts, paged rows, selection, labels/searches passthrough, and all mutations with optimistic update + rollback.
- [ ] Step 2: Wire `GET /mailbox`, `/mailbox/folder`, `/mailbox/summary`, `/mailbox/labels`, `/mailbox/searches`; light refresh on window focus.

### Task M3.2: Layout and rail

- [ ] Step 1: `MailLayout` 3-pane grid; desktop rail|list|pane, tablet icon rail, mobile single-column master/detail.
- [ ] Step 2: `FolderRail` - Compose button, folders with counts/icons (Inbox, Unread, Junk, Trash, Outbox, Sent, Drafts, Archive), Labels, Saved searches.

### Task M3.3: Message list

- [ ] Step 1: `MessageList` toolbar (search, action-only, select-all) + server-paged rows + load-more.
- [ ] Step 2: Rows: avatar, sender, subject, snippet, time, chips, unread dot, star, hover quick-actions (star/junk/trash/archive), selection checkbox; `UserAvatar`/`Skeleton` from kit.

### Task M3.4: Reading pane

- [ ] Step 1: `ReadingPane` header (avatar, sender+email, expandable To/Cc/Bcc, timestamp, chips) and action toolbar.
- [ ] Step 2: `bodyText.js` - render body with preserved line breaks, safe linkification, and collapsible quoted history/signature; visually distinct `.mail-body` block.
- [ ] Step 3: Attachment cards reusing the attachment catalog/print links.

### Task M3.5: Thread

- [ ] Step 1: `ThreadView` stacked conversation with per-message collapse and unread markers, reusing `GET /mailbox/messages/:id/thread`.

## Phase M4 - Compose, actions, states

### Task M4.1: Compose

- [ ] Step 1: `ComposePanel` inline reply/reply-all/forward docked under the reading pane, reusing the existing recipient picker and attachment catalog.
- [ ] Step 2: Floating new-mail panel; autosave draft (existing `/mailbox/messages` DRAFT path); send/schedule preserved.

### Task M4.2: Actions and undo

- [ ] Step 1: `MessageActions` shared handlers with optimistic store mutations.
- [ ] Step 2: `UndoToast` (5s) for trash/junk/archive/bulk, calling restore endpoints.

### Task M4.3: States

- [ ] Step 1: `MailSkeleton` per pane; `EmptyState` per folder ("Junk is clear", "Trash is empty").
- [ ] Step 2: Inline error + retry per pane; never an infinite spinner. Confirm dialogs for permanent delete and empty trash.

## Phase M5 - Interactions and styling

### Task M5.1: Keyboard

- [ ] Step 1: `useMailKeyboard` - `j/k`, `Enter`, `e`, `#`, `!`, `s`, `u`, `r`, `a`, `f`, `/`, `x`, `Esc`, `?`; disabled while typing.

### Task M5.2: Responsive and swipe

- [ ] Step 1: `useSwipe` for list rows (left archive, right trash) and reading-pane right-swipe back; mobile bottom action bar.

### Task M5.3: Motion and styles

- [ ] Step 1: `motion` transitions for list/pane/toast/unread fade, gated by `prefers-reduced-motion`.
- [ ] Step 2: `.mail-*` styles in `styles.css` using tokens only; dark-mode coverage; responsive breakpoints.

### Task M5.4: i18n

- [ ] Step 1: Add the new keys to all locales in `i18n.js` and `phrases.am.js`.

## Phase M6 - Verify and ship

- [ ] Step 1: `node --test "test/*.test.js"` all pass; `cd frontend && npm run build` passes.
- [ ] Step 2: Playwright admin and crew at 1440x900 and 390x844, light and dark: 3-pane renders, click shows a separated body, junk → restore, trash → restore → permanent delete, undo, bulk, keyboard, swipe; zero console errors; no infinite spinner on failed fetch.
- [ ] Step 3: Commit explicit changed paths (db, mail, routes, test, `pages/Mailbox.jsx`, `pages/mailbox/*`, `styles.css`, i18n) and push; do not commit `backend/tmms.db*` or untracked artifacts.
