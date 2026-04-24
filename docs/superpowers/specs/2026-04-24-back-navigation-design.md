# Back Navigation Design — Train Wizard

**Date:** 2026-04-24
**Status:** Approved

## Problem

The Train Wizard is forward-only. If a preprocessing step fails, the user has no way to retry it without starting over. If they want to add more audio or change training epochs, they are stuck. All navigation must become bidirectional.

## Scope

- Clickable sidebar steps for any step at or below the highest step reached
- Back button on every step panel except step 1
- Step 1 PATCHes the existing job instead of creating a new one on return
- Step 2 shows already-uploaded server files when revisited, allows adding/deleting
- Step 3 unlocks all sub-step buttons immediately on return (no forced re-run order)
- Guard against navigating away while a step is actively running (warning, not hard block)

Out of scope: cross-step data invalidation, cascade warnings, forced re-run of downstream steps.

---

## API Changes (finetune-api)

### `PATCH /jobs/{job_id}`

Updates mutable job settings on an existing job. Called when the user returns to step 1 and clicks "Save & continue".

**Request body:**
```json
{ "trainingEpochs": 100, "batchSize": 2 }
```

**Behavior:**
- Updates `trainingEpochs` and `batchSize` columns on `TrainingJob`
- Voice name is read-only after creation (already registered as a `VoiceModel`)
- Returns `{ "updated": true }`

### `GET /jobs/{job_id}/audio`

Lists files already present in the job's `audio/` directory.

**Response:**
```json
{ "files": [{ "name": "sarah.wav", "size": 4820134 }] }
```

**Used by:** Step 2 when entering with an existing job to populate the server files list.

**Deletion:** Reuses the existing `DELETE /voices/{voice_id}/files/{filename}` endpoint — no new endpoint needed.

---

## Frontend Changes (train-wizard.tsx)

### New state / refs

| Name | Type | Purpose |
|------|------|---------|
| `maxStepReached` | `useRef<number>` | Highest step the user has navigated to. Init from `statusToStep(initialJob.status)` or `1`. Updated on every forward navigation. |
| `serverFiles` | `{ name: string; size: number }[]` | Files already on the server for step 2. Fetched from `GET /jobs/{id}/audio` when step 2 is entered with a job. |

### `goToStep(n)` helper

Replaces all direct `setStep(...)` calls for forward navigation.

```ts
const goToStep = (n: number) => {
  maxStepReached.current = Math.max(maxStepReached.current, n);
  setStep(n);
};
```

### `goBack()` helper

```ts
const goBack = () => {
  if (running) {
    // Show inline warning — do not hard block
    setStepError("A step is still running. Results may be incomplete.");
  }
  esRef.current?.close();
  setRunning(false);
  setStep((s) => s - 1);
};
```

### Sidebar

- Steps where `n <= maxStepReached.current` receive `cursor-pointer` and `onClick={() => goToStep(n)}` (or `setStep(n)` for backward navigation — does not update maxStepReached).
- Active step remains non-clickable and highlighted.
- Future steps (n > maxStepReached) remain non-interactive.

Both the mobile dot row and desktop list are updated identically.

### Back button

Added to the bottom of every step panel except step 1, aligned left alongside the forward button:

```tsx
<button onClick={goBack} className="...">
  ← Back
</button>
```

Rendered in all of: `StepUpload`, `StepPreprocess`, `StepCurate`, `StepPhOnemize`, `StepTrain`, `StepDeploy`.

### Step 1 — Save & continue on return

`handleCreateJob` is split:

- If `job === null`: existing behavior — POST to create job, advance to step 2.
- If `job !== null`: PATCH `/jobs/{id}` with current `epochs` and `batchSize`, then advance to step 2.

Button label changes to **"Save & continue"** when `job !== null`.

### Step 2 — Server files

When step becomes 2 and `job !== null`, fetch `GET /jobs/{job.jobId}/audio` and store result in `serverFiles`.

Server files render as a separate list above the client-side upload queue, each with a delete button that calls `DELETE /voices/{voiceModelId}/files/{filename}`. On success, remove the entry from `serverFiles`.

The "Upload & continue" button uploads only new client-side `uploadedFiles`. Server files already uploaded do not need re-uploading.

### Step 3 — Return visit

`StepPreprocess` receives a new `wasCompleted: boolean` prop:

```tsx
wasCompleted={maxStepReached.current > 3}
```

When `wasCompleted` is true, `ranTranscribe` and `ranSegment` initialize to `true`, enabling all sub-step buttons immediately. The user can selectively re-run any sub-step without being forced to run them in order.

---

## Behaviour Summary Per Step

| Step | Going back | Re-running |
|------|-----------|------------|
| 1 | N/A (no Back button) | Change epochs/batchSize → PATCH on forward |
| 2 | Shows server files, add/delete freely | Re-upload replaces/adds files |
| 3 | All sub-steps enabled (wasCompleted=true) | Any sub-step can be re-run independently |
| 4 | Clips re-fetched from server as normal | Excluded set persists in memory; user can toggle differently before re-submitting |
| 5 | Back button, phonemizer re-runnable | Re-run phonemize button always available |
| 6 | Back button (warns if training running) | Re-run training button always available |
| 7 | Back button | Re-deploy always available |

---

## Non-Goals

- Cascade invalidation when going back (user is responsible for re-running downstream steps)
- Cross-backend model lineage (separate design)
- Multi-backend wizard support (separate design)
