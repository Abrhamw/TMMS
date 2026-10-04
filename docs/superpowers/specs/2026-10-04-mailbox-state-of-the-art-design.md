# Mailbox: State-of-the-Art 3-Pane Client - Design

Date: 2026-10-04
Status: Approved (design)

## 1. Summary

The mailbox today is a single-column page (`frontend/src/pages/Mailbox.jsx`,
1379 lines) over a directed-mail backend (`backend/routes/mailbox.js`, 1348
lines). It supports folders, labels, saved searches, bulk select, threads,
compose, attachments and acknowledge, but it has three real gaps:

1. There is no way to delete mail from the inbox or recover it afterwards.
2. There is no Junk folder and no way to retrieve something filed as junk.
3. Opening a message does not give a clear, separated reading surface - the
   body renders inline with the list.

This design rebuilds the mailbox as a **3-pane client** (folder rail | message
list | reading pane) with a real **Junk** and **Trash** lifecycle, basic
automatic junk classification with manual override, a clearly separated reading
pane, and the dynamic interactions (optimistic actions, undo, keyboard
shortcuts, swipe) that a modern mail client is expected to have.

## 2. Goals

- Add a per-account **Junk** and **Trash** lifecycle: junk / not-junk, trash /
  restore, permanent per-account delete, and empty-trash.
- Add **basic automatic junk classification** (external domain, spam keywords,
  unknown/inactive sender) with a per-account "Not junk" memory, and a visible
  reason chip on junked mail.
- Rebuild the mailbox as a **3-pane layout** with a clearly separated reading
  pane: rich header, action toolbar, and a distinct body block with collapsed
  quoted history and attachment cards.
- Add the **full dynamic interaction set**: optimistic updates, undo toasts,
  bulk actions, keyboard shortcuts, and mobile swipe.
- Add **inline reply/reply-all/forward** in the reading pane plus a floating
  new-mail composer with autosaved drafts.
- Stay **additive**: no existing endpoint, field, or response shape is removed
  or renamed, and no data is destroyed by a migration.
- Respect `prefers-reduced-motion`, and support light and dark themes on
  desktop, tablet and phone.

## 3. Non-goals

- No junk/trash actions on activity-feed items (task/report/comment events).
  Activity items remain derived and keep read + archive only.
- No global hard-delete of a message other participants still hold. Permanent
  delete is per-account (see 4.4).
- No mail server integration (SMTP/IMAP), no external address book.
- No change to the mailbox role guard, i18n keys being present, or other pages.
- No removal of existing mailbox capabilities (labels, saved searches,
  action-only, acknowledge, attachment catalog, printing).

## 4. Backend

### 4.1 Schema (additive, via the existing idempotent `migrate()` helper)

`backend/db.js` already exposes `migrate(table, column, alterSql)`, which reads
`PRAGMA table_info` and only runs the `ALTER TABLE` when the column is absent.

Extend `message_state` (per-account state; read/archive already live here):

- `deleted_at TEXT` - set when the account moves the message to Trash.
- `junk_at TEXT` - set when the account files the message as Junk.
- `junk_reason TEXT` - human-readable reason for an automatic classification.
- `starred_at TEXT` - set when the account stars the message.

Add one small table for the "Not junk" memory:

```sql
CREATE TABLE IF NOT EXISTS mail_junk_rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  match_type TEXT NOT NULL,           -- 'DOMAIN' | 'SENDER'
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(owner_user_id, match_type, value)
);
```

`mail_junk_rule` records senders/domains the account has explicitly marked
"Not junk", so future mail from them is never auto-classified again. It is
additive: no existing table or column is dropped or rewritten.

### 4.2 Automatic junk classification

Rules live in `backend/mail.js` as pure helpers so they are testable without a
request.

Signals (any one files the message to Junk):

- `EXTERNAL_DOMAIN` - the sender person's email domain is not among the internal
  domains. Internal domains are derived from the distinct domains of active
  `person.email` values and cached for the process lifetime.
- `SPAM_KEYWORDS` - the subject or body matches a small keyword list
  (`lottery`, `wire transfer`, `click here`, `winner`, `crypto`, `bitcoin`,
  `urgent transfer`, `act now`, `nigerian`, ...). Case-insensitive substring
  match, list defined as a constant.
- `UNKNOWN_SENDER` - the message has no `sender_person_id`, or the referenced
  person is missing or inactive (`person.active = 0`).

Classification is **lazy and per-account**, evaluated on mailbox load:

- When the mailbox or a folder is loaded, incoming messages that have **no**
  `message_state` row for the calling account are evaluated once.
- Matching messages get `junk_at` + `junk_reason`; non-matching messages get a
  state row with null flags so they are not re-evaluated.
- New mail is therefore classified on the account's next load. There is no
  global backfill and no per-recipient coupling.
- A sender/domain present in the account's `mail_junk_rule` suppresses the
  `EXTERNAL_DOMAIN` and `UNKNOWN_SENDER` signals at that first evaluation (a
  state row is still written, so nothing is re-evaluated later).

Manual override always wins over the classifier:

- Junk action sets `junk_at` (and `junk_reason = 'MANUAL'`).
- Not-junk action clears `junk_at`/`junk_reason` and inserts a `mail_junk_rule`
  row for the sender's email domain (falling back to the sender person id when
  no email is known).

### 4.3 Folder definitions

Extend `MAIL_FOLDER_DEFS` (`backend/routes/mailbox.js`) additively. Every
existing key keeps its meaning; `deleted_at IS NULL` is added to the folders
that should hide trashed mail.

- `mailinbox` - incoming, `SENT`, not archived, `deleted_at IS NULL`,
  `junk_at IS NULL`.
- `junk` - incoming, `deleted_at IS NULL`, `junk_at IS NOT NULL`.
- `trash` - any direction, `deleted_at IS NOT NULL`.
- `outbox`, `mailsent`, `drafts`, `archive` - unchanged except
  `deleted_at IS NULL`.

`mailWhere()` gains `deleted` / `junk` predicates and `mailCounts()` is extended
with `junk`, `trash` and `junk_unread`. Existing count keys are unchanged.

### 4.4 Permanent (per-account) delete

`DELETE /mailbox/messages/:id` and `POST /mailbox/trash/empty` remove a message
from the **calling account only**:

- When the caller is a recipient: delete the account's `message_recipient` link
  and its `message_state` row. The message then no longer appears in that
  account's folders (the inbox query joins `message_recipient`), while the
  sender and other recipients keep their copy untouched.
- When the caller is the sender (and not a recipient): the `message` row must
  remain for recipients, so the account is hidden from its own Outbox / Sent /
  Drafts view by setting `deleted_at` on its `message_state` row.
- A caller who is both sender and recipient is handled by the recipient branch.
- An attachment's uploaded file is deleted from disk only when no other
  `message_attachment` row (across all remaining participants) still references
  the same `stored_name`.

### 4.5 Endpoints (all additive)

| Method | Path | Body / effect |
| --- | --- | --- |
| `PUT` | `/mailbox/messages/:id/junk` | `{ junk: boolean }` - junk / not-junk (+ rule) |
| `PUT` | `/mailbox/messages/:id/trash` | `{ trash: boolean }` - trash / restore |
| `PUT` | `/mailbox/messages/:id/star` | `{ starred: boolean }` |
| `DELETE` | `/mailbox/messages/:id` | permanent per-account delete |
| `POST` | `/mailbox/trash/empty` | permanently clear the caller's Trash |
| `POST` | `/mailbox/messages/bulk` | extended `action`: `junk`, `not_junk`, `trash`, `restore`, `star`, `unstar`, `delete` |
| `GET` | `/mailbox/junk-rules` | list the caller's Not-junk rules |
| `DELETE` | `/mailbox/junk-rules/:id` | clear one rule |
| `GET` | `/mailbox/summary` | existing, now also returns `junk` / `trash` counts |
| `GET` | `/mailbox` | existing, now also returns `junk` / `trash` counts |

All new handlers reuse the existing visibility helpers (`mailParticipant`,
`mailVisible`, `loadMailVisible`) and the existing auth middleware. No existing
endpoint is renamed or changes shape.

## 5. Frontend architecture

`frontend/src/pages/Mailbox.jsx` stays the route entry so `App.jsx`, guards,
i18n and prefetch are untouched, but it becomes a thin orchestrator that renders
a new folder of focused units under `frontend/src/pages/mailbox/`:

- `MailLayout` - the 3-pane grid and responsive switching.
- `FolderRail` - Compose button, folders with live counts + icons (Inbox,
  Unread, Junk, Trash, Outbox, Sent, Drafts, Archive), Labels, Saved searches.
  Collapses to an icon rail on tablet and a slide-in drawer on mobile.
- `MessageList` - toolbar (search, action-only filter, select-all, bulk bar),
  server-paged rows with load-more. Row: avatar/initial, sender, subject,
  snippet, timestamp, chips (attachment, priority, label, junk reason), unread
  dot/bold, star, and hover quick-actions (star, junk, trash, archive).
- `ReadingPane` - rich header (avatar, sender name + email, expandable
  To/Cc/Bcc, timestamp, priority/label chips), action toolbar (reply, reply-all,
  forward, star, junk/not-junk, delete/restore, archive, label, print), a
  **clearly separated body block** (preserved line breaks, linkified links,
  collapsed quoted history + signature), attachment cards, then the thread.
- `ThreadView` - stacked conversation with per-message collapse and unread
  markers.
- `ComposePanel` - inline reply/reply-all/forward docked at the bottom of the
  reading pane, plus a floating new-mail panel. To/Cc/Bcc reuse the existing
  recipient picker; attachments reuse the attachment catalog; drafts autosave.
- `MessageActions` - the single shared set of optimistic action handlers.
- `UndoToast` - toast-with-Undo for destructive actions.
- `EmptyState`, `MailSkeleton` - per-folder empty and loading states.
- Hooks - `useMailStore` (folders, counts, paged list, selection, optimistic
  mutations + rollback), `useMailKeyboard`, `useSwipe`.

### 5.1 Responsive layout

- Desktop: rail | list | reading pane, reading pane sticky, rail collapsible.
- Tablet: rail becomes an icon rail; list + reading pane.
- Mobile: single-column master/detail with a back button and right-swipe to go
  back; action bar pinned to the bottom.

### 5.2 Reuse, not removal

Labels, saved searches, action-only, acknowledge, attachment catalog,
report/document printing and bulk selection are reorganized into the new shell.
The vendored `src/ui` kit, `api`, `i18n`, `labels` and `readiness` helpers are
reused. Existing routes and role guards are preserved.

## 6. Interactions

- Keyboard: `j`/`k` (or arrows) move selection, `Enter` open, `e` archive,
  `#` trash, `!` junk, `s` star, `u` toggle read, `r` reply, `a` reply-all,
  `f` forward, `/` focus search, `x` select, `Esc` close/back, `?` help.
  Shortcuts are ignored while typing in an input, textarea or contenteditable.
- Mobile swipe: left = archive, right = trash on list rows; right-swipe on the
  reading pane goes back.
- Undo toast (5s) for trash, junk, archive and bulk actions, backed by the
  restore endpoints.
- Optimistic UI: rows, counts and selection update instantly; a failed call
  rolls back and raises an error toast.
- Bulk bar: select all/none and archive / junk / trash / star / read / label.
- Motion via the existing `motion` dependency (list enter/exit, pane
  transitions, unread fade, toasts), gated by `prefers-reduced-motion`.

## 7. Data flow

`useMailStore` centralizes `/mailbox`, `/mailbox/folder`, `/mailbox/summary`,
`/mailbox/labels` and `/mailbox/searches`, holds folder counts, paged rows and
selection, and owns every mutation. Components are presentational and act only
through the store. A lightweight refresh on window focus keeps counts honest;
there is no aggressive polling.

## 8. Error handling

- Per-pane skeletons while loading; per-folder empty states ("Junk is clear").
- Inline error + retry per pane; never an infinite spinner (matches the loading
  pattern already fixed elsewhere in the app).
- Permanent delete and Empty Trash require a confirm dialog.
- Destructive action failures roll back the optimistic change and show a toast.

## 9. Testing and verification

Backend (`node --test`, existing temp-db harness):

- Folder definitions for junk/trash and the exclusions added to existing
  folders.
- Each new endpoint: junk/not-junk, trash/restore, star, permanent delete,
  empty trash and the extended bulk actions.
- Auto-classification: external domain, spam keywords, unknown/inactive sender,
  and the Not-junk override suppressing future classification.
- Per-account delete isolation and attachment file garbage collection.
- Extended counts (`junk`, `trash`, `junk_unread`).

Frontend:

- `npm run build` must pass.
- Playwright smoke: 3-pane render, click-to-show-body separation, junk →
  restore, trash → restore → permanent delete, undo, bulk actions, keyboard
  shortcuts, mobile swipe, light + dark, 0 console errors.

Compatibility: every backend change is additive; no existing endpoint, field or
response shape is removed or renamed, and no migration destroys data.

## 10. Out of scope / future

- Sender-level "always junk" rules, snooze, scheduled send UI changes, mail
  server integration, and activity-feed junking are explicitly future work.
