# Crew Runner Checklist, Photo and Close UX - Design

Date: 2026-10-06
Status: Approved (design)

## 1. Summary

Three usability fixes to the crew execution surfaces:

1. The Photos sheet only accepts one image at a time. It must accept several.
2. The guided runner offers no obvious way to finish and dismiss the popup.
3. Pass/fail checklist items are answered through a dropdown; they should be
   answered with OK / Not OK buttons.

## 2. Goals

- Let a crew member upload multiple photos in one action, keeping the existing
  single-file attachment endpoint unchanged.
- Give the runner an always-visible X close control and a primary Done button in
  the Hand off step that dismisses the popup.
- Replace select-based checklist responses with tappable buttons: OK / Not OK
  for pass/fail items, one button per option for custom SELECT items.
- Apply the checklist change in the shared `ChecklistItem` component so every
  surface (guided runner and full task panel) behaves the same.

## 3. Non-goals

- No backend, API or schema change.
- No change to the step order: Equipment (when required) -> Checklist ->
  Location -> Photos -> Hand off.
- No change to how review/verification is recorded, only how answers are input
  and how the runner is dismissed.

## 4. Photos (`frontend/src/components/TaskRunner.jsx`)

- The Photos sheet renders two actions:
  - Take photo: single, `capture="environment"`.
  - Upload photos: `multiple`, no `capture`, so several images can be selected
    from the gallery at once.
- `uploadFile(file)` becomes `uploadFiles(fileList)`, which iterates the files,
  uploads each through `POST /tasks/:id/attachments`, shows `Uploading n/m`, and
  refreshes the task once after the batch. A small `readFileData(file)` helper
  wraps `FileReader` in a promise.

## 5. Closing the runner

- The runner header replaces the Cancel text button with an X icon button that
  calls `onClose` (aria-label `close`).
- The Hand off step gains a primary Done button that calls `onClose`, on every
  task state, alongside the existing Reopen action.

## 6. Checklist responses (`frontend/src/components/ChecklistItem.jsx`)

- `PASS_FAIL` and `YES_NO`: two toggle buttons, OK (`true`, primary when
  selected) and Not OK (`false`, danger when selected), otherwise outline.
- `SELECT`: a wrap of one button per option, the selected option highlighted.
- Numeric, GPS and free-text inputs are unchanged.

## 7. i18n

- Add `ok`, `notOk`, `done`, `uploadPhotos` to the en, es and zh locales in
  `frontend/src/i18n.js`, and the matching English-to-Amharic entries in
  `frontend/src/phrases.am.js`. Reuse `close`, `capturePhotoTitle`,
  `capturePhotoHint` and `syncSaving`.

## 8. Testing

- `cd /workspace/frontend && npm run build`.
- Playwright as `ayu`: open a task runner, confirm OK / Not OK buttons set the
  answer, the multiple-photo input accepts several files and uploads them, the X
  closes the runner, and the Done button closes it from the Hand off step.
