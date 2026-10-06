# Crew Runner Checklist, Photo and Close UX - Implementation Plan

> **For agentic workers:** Execute task-by-task. Steps use checkbox (`- [ ]`) syntax. Stage explicit paths only; never `git add -A`; never commit `backend/tmms.db*`, `backend/uploads/`, `dist/`, `design/`, `mobile/LICENSE`.

**Goal:** Multi-photo upload, an X close plus a Done button in the crew runner, and OK / Not OK buttons for select-based checklist responses.

**Spec:** `docs/superpowers/specs/2026-10-06-runner-checklist-photo-ux-design.md`

## Global Constraints

- No backend, API or schema change.
- Apply checklist changes in the shared `ChecklistItem` component.
- Motion respects `prefers-reduced-motion`; light and dark tokens only.
- No code comments. Stage explicit paths only; never `git add -A`.

## File Structure

- `frontend/src/components/ChecklistItem.jsx` - button responses.
- `frontend/src/components/TaskRunner.jsx` - multi-upload, X close, Done button.
- `frontend/src/i18n.js`, `frontend/src/phrases.am.js` - new keys.

## Task 1: i18n keys

- [ ] Step 1: Add `ok`, `notOk`, `done`, `uploadPhotos` to the en, es and zh locales in `frontend/src/i18n.js`.
- [ ] Step 2: Add `"OK"`, `"Not OK"`, `"Done"`, `"Upload photos"` entries to `frontend/src/phrases.am.js`.

## Task 2: Checklist response buttons

- [ ] Step 1: Import `Button` and `t` into `ChecklistItem.jsx`.
- [ ] Step 2: Replace the `PASS_FAIL`/`YES_NO` dropdown with OK / Not OK toggle buttons.
- [ ] Step 3: Replace the `SELECT` dropdown with a button per option.
- [ ] Step 4: Run `npm run build`.

## Task 3: Photos and closing (TaskRunner)

- [ ] Step 1: Replace `uploadFile` with `uploadFiles(fileList)` and add a `readFileData` helper.
- [ ] Step 2: Pass `uploadFiles` into `CaptureSheets`; add a Take photo input (`capture`) and an Upload photos input (`multiple`).
- [ ] Step 3: Replace the header Cancel button with an X icon button calling `onClose`.
- [ ] Step 4: Add a primary Done button to the Hand off step calling `onClose`.
- [ ] Step 5: Run `npm run build`.

## Task 4: Verification and commit

- [ ] Step 1: Playwright as `ayu`: OK / Not OK sets the answer; multiple photos upload; X and Done close the runner.
- [ ] Step 2: Commit frontend paths only and push.
