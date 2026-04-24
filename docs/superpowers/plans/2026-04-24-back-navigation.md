# Back Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Train Wizard fully bidirectional — users can click any completed step in the sidebar, use Back buttons on every panel, re-run steps freely, return to step 1 to change settings, and revisit step 2 to manage uploaded files.

**Architecture:** Two new finetune-api endpoints (`PATCH /jobs/{id}` and `GET /jobs/{id}/audio`) proxied through the existing Next.js API layer. The wizard gains a `maxStepReached` ref for sidebar state and `goToStep`/`goBack` helpers that replace direct `setStep` calls. Step sub-components each receive an `onBack` prop.

**Tech Stack:** FastAPI + SQLite (backend), Next.js App Router API routes (proxy), React + TypeScript (wizard)

---

## File Map

| File | Change |
|------|--------|
| `finetune-api/api.py` | Add `UpdateJobRequest` model, `PATCH /jobs/{job_id}`, `GET /jobs/{job_id}/audio` |
| `finetune-api/tests/__init__.py` | Create (empty) |
| `finetune-api/tests/conftest.py` | Create — pytest fixtures: temp DB + temp workspace |
| `finetune-api/tests/test_back_nav.py` | Create — tests for both new endpoints |
| `elevenlabs-clone-frontend/src/app/api/voice-lab/jobs/[jobId]/route.ts` | Add `PATCH` handler |
| `elevenlabs-clone-frontend/src/app/api/voice-lab/jobs/[jobId]/audio/route.ts` | Create — `GET` proxy |
| `elevenlabs-clone-frontend/src/components/client/voice-lab/train-wizard.tsx` | All wizard changes |

---

## Task 1: Backend test infrastructure

**Files:**
- Create: `finetune-api/tests/__init__.py`
- Create: `finetune-api/tests/conftest.py`
- Create: `finetune-api/tests/test_back_nav.py`

- [ ] **Step 1: Install test dependency**

```bash
cd /home/b/ElevenLabs-Clone/finetune-api
pip install httpx pytest --quiet
```

Expected: installs without error.

- [ ] **Step 2: Create the test package**

Create `finetune-api/tests/__init__.py` (empty file).

- [ ] **Step 3: Create conftest.py**

Create `finetune-api/tests/conftest.py`:

```python
import os
import sqlite3
import pytest
from starlette.testclient import TestClient


SCHEMA = """
CREATE TABLE IF NOT EXISTS VoiceModel (
    id TEXT PRIMARY KEY, userId TEXT, name TEXT, voiceId TEXT, service TEXT,
    gradientColors TEXT, isActive INTEGER, checkpointPath TEXT,
    referenceAudioPath TEXT, createdAt TEXT, updatedAt TEXT
);
CREATE TABLE IF NOT EXISTS TrainingJob (
    id TEXT PRIMARY KEY, userId TEXT, voiceModelId TEXT, status TEXT,
    currentStep INTEGER, jobWorkDir TEXT, trainingEpochs INTEGER,
    batchSize INTEGER, language TEXT, errorMessage TEXT,
    createdAt TEXT, updatedAt TEXT
);
"""


@pytest.fixture()
def env_setup(tmp_path, monkeypatch):
    db_path = str(tmp_path / "test.sqlite")
    jobs_dir = str(tmp_path / "jobs")
    os.makedirs(jobs_dir)

    monkeypatch.setenv("API_KEY", "test-key")
    monkeypatch.setenv("DB_PATH", db_path)
    monkeypatch.setenv("WORKSPACE", str(tmp_path))

    import api
    monkeypatch.setattr(api, "DB_PATH", db_path)
    monkeypatch.setattr(api, "JOBS_DIR", jobs_dir)

    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()

    return {"db_path": db_path, "jobs_dir": jobs_dir, "tmp_path": tmp_path}


@pytest.fixture()
def client(env_setup):
    import api
    with TestClient(api.app, raise_server_exceptions=True) as c:
        yield c, env_setup
```

- [ ] **Step 4: Write failing tests**

Create `finetune-api/tests/test_back_nav.py`:

```python
import os
import sqlite3
from pathlib import Path


AUTH = {"Authorization": "Bearer test-key"}


def insert_job(db_path: str, job_id: str, jobs_dir: str):
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO VoiceModel (id, userId, name, voiceId, service, gradientColors, isActive, createdAt, updatedAt) "
        "VALUES (?, 'u1', 'Test', ?, 'styletts2', '', 0, datetime('now'), datetime('now'))",
        (f"vm-{job_id}", f"vm-{job_id}"),
    )
    conn.execute(
        "INSERT INTO TrainingJob (id, userId, voiceModelId, status, currentStep, jobWorkDir, "
        "trainingEpochs, batchSize, language, createdAt, updatedAt) "
        "VALUES (?, 'u1', ?, 'uploading', 0, ?, 75, 2, 'en-us', datetime('now'), datetime('now'))",
        (job_id, f"vm-{job_id}", os.path.join(jobs_dir, job_id)),
    )
    conn.commit()
    conn.close()


# ── PATCH /jobs/{job_id} ──────────────────────────────────────────────────────

def test_patch_job_updates_epochs_and_batch(client):
    c, env = client
    insert_job(env["db_path"], "job-1", env["jobs_dir"])

    resp = c.patch("/jobs/job-1", json={"trainingEpochs": 150, "batchSize": 1}, headers=AUTH)
    assert resp.status_code == 200
    assert resp.json() == {"updated": True}

    conn = sqlite3.connect(env["db_path"])
    row = conn.execute("SELECT trainingEpochs, batchSize FROM TrainingJob WHERE id = 'job-1'").fetchone()
    conn.close()
    assert row == (150, 1)


def test_patch_job_partial_update(client):
    c, env = client
    insert_job(env["db_path"], "job-2", env["jobs_dir"])

    resp = c.patch("/jobs/job-2", json={"trainingEpochs": 200}, headers=AUTH)
    assert resp.status_code == 200

    conn = sqlite3.connect(env["db_path"])
    row = conn.execute("SELECT trainingEpochs, batchSize FROM TrainingJob WHERE id = 'job-2'").fetchone()
    conn.close()
    assert row == (200, 2)  # batchSize unchanged


def test_patch_job_not_found(client):
    c, _ = client
    resp = c.patch("/jobs/nonexistent", json={"trainingEpochs": 100}, headers=AUTH)
    assert resp.status_code == 404


# ── GET /jobs/{job_id}/audio ──────────────────────────────────────────────────

def test_get_audio_lists_wav_files(client):
    c, env = client
    job_id = "job-3"
    insert_job(env["db_path"], job_id, env["jobs_dir"])

    audio_dir = os.path.join(env["jobs_dir"], job_id, "audio")
    os.makedirs(audio_dir)
    Path(audio_dir + "/sarah.wav").write_bytes(b"RIFF" + b"\x00" * 40)
    Path(audio_dir + "/john.wav").write_bytes(b"RIFF" + b"\x00" * 20)

    resp = c.get(f"/jobs/{job_id}/audio", headers=AUTH)
    assert resp.status_code == 200
    files = resp.json()["files"]
    assert len(files) == 2
    names = {f["name"] for f in files}
    assert names == {"john.wav", "sarah.wav"}
    assert all("size" in f for f in files)


def test_get_audio_empty_dir(client):
    c, env = client
    job_id = "job-4"
    insert_job(env["db_path"], job_id, env["jobs_dir"])
    os.makedirs(os.path.join(env["jobs_dir"], job_id, "audio"))

    resp = c.get(f"/jobs/{job_id}/audio", headers=AUTH)
    assert resp.status_code == 200
    assert resp.json() == {"files": []}


def test_get_audio_job_not_found(client):
    c, _ = client
    resp = c.get("/jobs/nonexistent/audio", headers=AUTH)
    assert resp.status_code == 404
```

- [ ] **Step 5: Run tests — verify they fail**

```bash
cd /home/b/ElevenLabs-Clone/finetune-api
python -m pytest tests/test_back_nav.py -v 2>&1 | head -40
```

Expected: all 5 tests **FAIL** with `405 Method Not Allowed` or `404 Not Found` (endpoints don't exist yet).

---

## Task 2: Implement PATCH /jobs/{job_id}

**Files:**
- Modify: `finetune-api/api.py`

- [ ] **Step 1: Add UpdateJobRequest model**

In `api.py`, after the `DeployRequest` model (around line 158), add:

```python
class UpdateJobRequest(BaseModel):
    trainingEpochs: Optional[int] = None
    batchSize: Optional[int] = None
```

- [ ] **Step 2: Add PATCH endpoint**

In `api.py`, after the `create_job` POST endpoint (after line ~317), add:

```python
@app.patch("/jobs/{job_id}", dependencies=[Depends(verify_api_key)])
async def update_job(job_id: str, req: UpdateJobRequest):
    job = db_fetchone("SELECT id FROM TrainingJob WHERE id = ?", (job_id,))
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    parts: list[str] = []
    vals: list = []
    if req.trainingEpochs is not None:
        parts.append("trainingEpochs = ?")
        vals.append(req.trainingEpochs)
    if req.batchSize is not None:
        parts.append("batchSize = ?")
        vals.append(req.batchSize)
    if parts:
        vals.append(job_id)
        db_execute(
            f"UPDATE TrainingJob SET {', '.join(parts)}, updatedAt = datetime('now') WHERE id = ?",
            tuple(vals),
        )
    return {"updated": True}
```

- [ ] **Step 3: Run PATCH tests — verify they pass**

```bash
cd /home/b/ElevenLabs-Clone/finetune-api
python -m pytest tests/test_back_nav.py -k "patch" -v
```

Expected: `test_patch_job_updates_epochs_and_batch`, `test_patch_job_partial_update`, `test_patch_job_not_found` all **PASS**.

- [ ] **Step 4: Commit**

```bash
git add finetune-api/api.py finetune-api/tests/
git commit -m "feat(finetune-api): add PATCH /jobs/{id} endpoint and tests"
```

---

## Task 3: Implement GET /jobs/{job_id}/audio

**Files:**
- Modify: `finetune-api/api.py`

- [ ] **Step 1: Add GET audio endpoint**

In `api.py`, after the `upload_audio` POST endpoint (around line ~355), add:

```python
@app.get("/jobs/{job_id}/audio", dependencies=[Depends(verify_api_key)])
async def list_audio_files(job_id: str):
    audio_dir = os.path.join(job_dir(job_id), "audio")
    if not os.path.exists(audio_dir):
        raise HTTPException(status_code=404, detail="Job not found")
    files = []
    for fname in sorted(os.listdir(audio_dir)):
        if fname.lower().endswith(".wav"):
            fpath = os.path.join(audio_dir, fname)
            if os.path.isfile(fpath):
                files.append({"name": fname, "size": os.path.getsize(fpath)})
    return {"files": files}
```

- [ ] **Step 2: Run audio tests — verify they pass**

```bash
cd /home/b/ElevenLabs-Clone/finetune-api
python -m pytest tests/test_back_nav.py -k "audio" -v
```

Expected: `test_get_audio_lists_wav_files`, `test_get_audio_empty_dir`, `test_get_audio_job_not_found` all **PASS**.

- [ ] **Step 3: Run all tests**

```bash
python -m pytest tests/test_back_nav.py -v
```

Expected: all 5 tests **PASS**.

- [ ] **Step 4: Commit**

```bash
git add finetune-api/api.py
git commit -m "feat(finetune-api): add GET /jobs/{id}/audio endpoint"
```

---

## Task 4: Next.js proxy routes

**Files:**
- Modify: `elevenlabs-clone-frontend/src/app/api/voice-lab/jobs/[jobId]/route.ts`
- Create: `elevenlabs-clone-frontend/src/app/api/voice-lab/jobs/[jobId]/audio/route.ts`

- [ ] **Step 1: Add PATCH handler to the existing job route**

Open `elevenlabs-clone-frontend/src/app/api/voice-lab/jobs/[jobId]/route.ts` and append after the `DELETE` export:

```typescript
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const session = await auth();
  if (!session?.user.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { jobId } = await params;
  if (!(await verifyOwnership(jobId, session.user.id))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json() as { trainingEpochs?: number; batchSize?: number };
  const resp = await fetch(`${env.FINETUNE_API_ROUTE}/jobs/${jobId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${env.BACKEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return Response.json(await resp.json(), { status: resp.status });
}
```

- [ ] **Step 2: Create the audio list proxy route**

Create `elevenlabs-clone-frontend/src/app/api/voice-lab/jobs/[jobId]/audio/route.ts`:

```typescript
import { NextRequest } from "next/server";
import { env } from "~/env";
import { auth } from "~/server/auth";
import { db } from "~/server/db";

async function verifyOwnership(jobId: string, userId: string) {
  const job = await db.trainingJob.findFirst({ where: { id: jobId, userId } });
  return job !== null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const session = await auth();
  if (!session?.user.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { jobId } = await params;
  if (!(await verifyOwnership(jobId, session.user.id))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const resp = await fetch(`${env.FINETUNE_API_ROUTE}/jobs/${jobId}/audio`, {
    headers: { Authorization: `Bearer ${env.BACKEND_API_KEY}` },
  });
  return Response.json(await resp.json(), { status: resp.status });
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /home/b/ElevenLabs-Clone/elevenlabs-clone-frontend
npx tsc --noEmit 2>&1 | grep -v node_modules | head -20
```

Expected: no errors in the two modified/created files.

- [ ] **Step 4: Commit**

```bash
git add elevenlabs-clone-frontend/src/app/api/voice-lab/jobs/[jobId]/route.ts \
        elevenlabs-clone-frontend/src/app/api/voice-lab/jobs/[jobId]/audio/
git commit -m "feat(frontend): add PATCH job and GET audio Next.js proxy routes"
```

---

## Task 5: Wizard — core navigation state and sidebar

**Files:**
- Modify: `elevenlabs-clone-frontend/src/components/client/voice-lab/train-wizard.tsx`

This task adds the `maxStepReached` ref, `serverFiles` state, `goToStep`/`goBack` helpers, and makes the sidebar clickable.

- [ ] **Step 1: Add maxStepReached ref and serverFiles state**

In `train-wizard.tsx`, find the existing state block that begins with `const [step, setStep]` (around line 124) and add two new declarations immediately after it:

```tsx
  const maxStepReached = useRef(
    initialJob ? statusToStep(initialJob.status) : 1,
  );
  const [serverFiles, setServerFiles] = useState<{ name: string; size: number }[]>([]);
```

- [ ] **Step 2: Add goToStep and goBack helpers**

In `train-wizard.tsx`, find the `runStep` useCallback (around line 291) and add two new helpers immediately before it:

```tsx
  const goToStep = useCallback((n: number) => {
    maxStepReached.current = Math.max(maxStepReached.current, n);
    setStep(n);
  }, []);

  const goBack = useCallback(() => {
    if (running) {
      setStepError("A step is still running. Results may be incomplete.");
    }
    esRef.current?.close();
    setRunning(false);
    setStep((s) => s - 1);
  }, [running]);
```

- [ ] **Step 3: Replace setStep forward-navigation calls with goToStep**

Replace all forward `setStep` calls (not the ones inside goBack or the reset handler). The calls to replace are:

```tsx
// In handleCreateJob:
setStep(2);
// → replace with:
goToStep(2);

// In handleUploadFiles:
setStep(3);
// → replace with:
goToStep(3);

// In StepPreprocess onNext:
onNext={() => setStep(4)}
// → replace with:
onNext={() => goToStep(4)}

// In handleCurate:
setStep(5);
// → replace with:
goToStep(5);

// In StepPhOnemize onNext:
onNext={() => setStep(6)}
// → replace with:
onNext={() => goToStep(6)}

// In StepTrain onNext:
onNext={() => { setTrainingFinished(true); setStep(7); }}
// → replace with:
onNext={() => { setTrainingFinished(true); goToStep(7); }}
```

Leave `setStep` as-is in: `handleNewVoice` (full reset), `goBack` (decrement), the `step` useState initializer.

- [ ] **Step 4: Add useEffect to fetch server files when entering step 2**

In `train-wizard.tsx`, find the existing `useEffect` that loads clips when entering step 4 (around line 203) and add a new effect directly before it:

```tsx
  useEffect(() => {
    if (step === 2 && job) {
      fetch(`/api/voice-lab/jobs/${job.jobId}/audio`)
        .then((r) => r.json())
        .then((d: { files?: { name: string; size: number }[] }) =>
          setServerFiles(d.files ?? []),
        )
        .catch(console.error);
    }
  }, [step, job]);
```

- [ ] **Step 5: Make the desktop sidebar clickable**

In `train-wizard.tsx`, find the desktop `<ol>` sidebar (around line 457). Replace the `<li>` element inside the map with:

```tsx
              <li
                key={n}
                onClick={() => {
                  if (n !== step && n <= maxStepReached.current) setStep(n);
                }}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-gray-100 font-medium text-gray-900 dark:bg-gray-700 dark:text-white"
                    : done && n <= maxStepReached.current
                    ? "cursor-pointer text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800"
                    : "cursor-default text-gray-400 dark:text-gray-600"
                }`}
              >
```

- [ ] **Step 6: Make the mobile sidebar clickable**

In `train-wizard.tsx`, find the mobile dot row (around line 435). Replace the outer `<div key={n}>` with:

```tsx
              <div
                key={n}
                onClick={() => {
                  if (n !== step && n <= maxStepReached.current) setStep(n);
                }}
                className={`flex flex-shrink-0 flex-col items-center gap-1 ${
                  n !== step && n <= maxStepReached.current
                    ? "cursor-pointer"
                    : "cursor-default"
                }`}
              >
```

- [ ] **Step 7: Reset serverFiles in handleNewVoice**

In `handleNewVoice`, find the reset block that clears all state. Add `setServerFiles([]);` alongside the other resets (after `setUploadedFiles([])`):

```tsx
    setServerFiles([]);
```

- [ ] **Step 8: Verify TypeScript**

```bash
cd /home/b/ElevenLabs-Clone/elevenlabs-clone-frontend
npx tsc --noEmit 2>&1 | grep -v node_modules | head -20
```

Expected: no new type errors.

- [ ] **Step 9: Commit**

```bash
git add elevenlabs-clone-frontend/src/components/client/voice-lab/train-wizard.tsx
git commit -m "feat(wizard): add maxStepReached, goToStep/goBack, clickable sidebar"
```

---

## Task 6: Wizard — Back buttons on all step panels

**Files:**
- Modify: `elevenlabs-clone-frontend/src/components/client/voice-lab/train-wizard.tsx`

Each of the 6 step sub-components gets an `onBack` prop and a Back button. The `goBack` helper is passed down from `TrainWizard`.

- [ ] **Step 1: Add onBack prop and Back button to StepUpload**

Find `function StepUpload(` and add `onBack: () => void;` to its props interface:

```tsx
function StepUpload({
  files,
  onSelect,
  onRemove,
  onNext,
  uploading,
  fileInputRef,
  onAddRecording,
  onBack,
}: {
  files: File[];
  onSelect: (f: FileList | null) => void;
  onRemove: (name: string) => void;
  onNext: () => void;
  uploading: boolean;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onAddRecording: (f: File) => void;
  onBack: () => void;
}) {
```

Replace the single forward button at the bottom of `StepUpload` with a row:

```tsx
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          ← Back
        </button>
        <button
          onClick={onNext}
          disabled={files.length === 0 || uploading}
          className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
        >
          {uploading ? "Uploading…" : "Upload & continue"}
          {!uploading && <IoChevronForward />}
        </button>
      </div>
```

- [ ] **Step 2: Add onBack to StepPreprocess**

Add `onBack: () => void;` to `StepPreprocess` props interface. Replace the single forward button at the bottom:

```tsx
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          ← Back
        </button>
        <button
          onClick={onNext}
          disabled={!ranSegment}
          className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
        >
          Continue to curate <IoChevronForward />
        </button>
      </div>
```

- [ ] **Step 3: Add onBack to StepCurate**

Add `onBack: () => void;` to `StepCurate` props. Replace its forward button:

```tsx
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          ← Back
        </button>
        <button
          onClick={onNext}
          disabled={loading}
          className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
        >
          Save & continue <IoChevronForward />
        </button>
      </div>
```

- [ ] **Step 4: Add onBack to StepPhOnemize**

Add `onBack: () => void;` to `StepPhOnemize` props. Replace its forward button:

```tsx
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          ← Back
        </button>
        <button
          onClick={onNext}
          disabled={!stepDone}
          className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
        >
          Continue to train <IoChevronForward />
        </button>
      </div>
```

- [ ] **Step 5: Add onBack to StepTrain**

Add `onBack: () => void;` to `StepTrain` props. Replace its forward button:

```tsx
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          ← Back
        </button>
        <button
          onClick={onNext}
          disabled={!stepDone}
          className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
        >
          Continue to deploy <IoChevronForward />
        </button>
      </div>
```

- [ ] **Step 6: Add onBack to StepDeploy**

Add `onBack: () => void;` to `StepDeploy` props. Add a Back button above the deploy button (or alongside it when not yet deployed):

```tsx
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          ← Back
        </button>
        {!deployed && (
          <button
            onClick={onDeploy}
            disabled={deploying}
            className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
          >
            {deploying ? "Activating…" : "Activate voice"}
          </button>
        )}
      </div>
```

Move the existing error `<div>` below this new row (keep it between the row and the deployed success card).

- [ ] **Step 7: Wire onBack={goBack} in the render section**

In the `TrainWizard` render section, pass `onBack={goBack}` to each step:

```tsx
        {step === 2 && (
          <StepUpload
            ...
            onBack={goBack}
          />
        )}

        {step === 3 && job && (
          <StepPreprocess
            ...
            onBack={goBack}
          />
        )}

        {step === 4 && (
          <StepCurate
            ...
            onBack={goBack}
          />
        )}

        {step === 5 && job && (
          <StepPhOnemize
            ...
            onBack={goBack}
          />
        )}

        {step === 6 && job && (
          <StepTrain
            ...
            onBack={goBack}
          />
        )}

        {step === 7 && job && (
          <StepDeploy
            ...
            onBack={goBack}
          />
        )}
```

- [ ] **Step 8: Verify TypeScript**

```bash
cd /home/b/ElevenLabs-Clone/elevenlabs-clone-frontend
npx tsc --noEmit 2>&1 | grep -v node_modules | head -20
```

Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add elevenlabs-clone-frontend/src/components/client/voice-lab/train-wizard.tsx
git commit -m "feat(wizard): add Back buttons to all step panels"
```

---

## Task 7: Wizard — Step 1 PATCH on return

**Files:**
- Modify: `elevenlabs-clone-frontend/src/components/client/voice-lab/train-wizard.tsx`

- [ ] **Step 1: Split handleCreateJob into create vs update paths**

Replace the existing `handleCreateJob` function (around line 311) with:

```tsx
  const handleCreateJob = async () => {
    if (!voiceName.trim()) return;
    setCreating(true);
    try {
      if (job) {
        await fetch(`/api/voice-lab/jobs/${job.jobId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trainingEpochs: epochs, batchSize }),
        });
      } else {
        const resp = await fetch("/api/voice-lab/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voiceName, language, trainingEpochs: epochs, batchSize }),
        });
        const data = await resp.json() as { jobId: string; voiceModelId: string };
        setJob({ jobId: data.jobId, voiceModelId: data.voiceModelId });
      }
      goToStep(2);
    } catch (e) {
      console.error(e);
    } finally {
      setCreating(false);
    }
  };
```

- [ ] **Step 2: Update the button label in StepNameVoice**

`StepNameVoice` already receives `creating` — pass a new boolean prop `hasJob` to change the button label. Add to `StepNameVoice` props:

```tsx
  hasJob: boolean;
```

Change the button inside `StepNameVoice`:

```tsx
        {creating ? "Saving…" : hasJob ? "Save & continue" : "Create job"}
```

Pass it in the render section:

```tsx
        {step === 1 && (
          <StepNameVoice
            ...
            hasJob={job !== null}
          />
        )}
```

- [ ] **Step 3: Verify TypeScript**

```bash
cd /home/b/ElevenLabs-Clone/elevenlabs-clone-frontend
npx tsc --noEmit 2>&1 | grep -v node_modules | head -20
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add elevenlabs-clone-frontend/src/components/client/voice-lab/train-wizard.tsx
git commit -m "feat(wizard): PATCH existing job settings when returning to step 1"
```

---

## Task 8: Wizard — Step 2 server files list

**Files:**
- Modify: `elevenlabs-clone-frontend/src/components/client/voice-lab/train-wizard.tsx`

- [ ] **Step 1: Add serverFiles props to StepUpload**

Add to `StepUpload` props interface:

```tsx
  serverFiles: { name: string; size: number }[];
  onDeleteServerFile: (name: string) => Promise<void>;
```

- [ ] **Step 2: Render server files list inside StepUpload**

In `StepUpload`, directly after the description `<p>` and before the drop zone, add a server files section that only renders when `serverFiles.length > 0`:

```tsx
      {serverFiles.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
            Already uploaded
          </p>
          <ul className="space-y-1 text-sm">
            {serverFiles.map((f) => (
              <li
                key={f.name}
                className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-800/50"
              >
                <span className="truncate text-gray-700 dark:text-gray-300">{f.name}</span>
                <div className="ml-2 flex items-center gap-3">
                  <span className="text-xs text-gray-400 dark:text-gray-500">
                    {(f.size / 1024 / 1024).toFixed(1)} MB
                  </span>
                  <button
                    onClick={() => onDeleteServerFile(f.name)}
                    className="text-gray-400 hover:text-red-500 dark:text-gray-500"
                  >
                    <IoTrashOutline />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
```

- [ ] **Step 3: Add onDeleteServerFile handler in TrainWizard**

In `train-wizard.tsx`, add a handler in `TrainWizard` after `handleCurate`:

```tsx
  const handleDeleteServerFile = useCallback(
    async (name: string) => {
      if (!job) return;
      await fetch(`/api/voice-lab/voices/${job.voiceModelId}/files`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: name }),
      });
      setServerFiles((prev) => prev.filter((f) => f.name !== name));
    },
    [job],
  );
```

- [ ] **Step 4: Fix the Upload button disabled condition in StepUpload**

The button must be enabled when server files already exist (user can advance without adding new files). Find the Upload & continue button and change its `disabled` prop:

```tsx
        <button
          onClick={onNext}
          disabled={(files.length === 0 && serverFiles.length === 0) || uploading}
          ...
        >
```

- [ ] **Step 5: Pass serverFiles props in the render section**

Update the `StepUpload` render call:

```tsx
        {step === 2 && (
          <StepUpload
            files={uploadedFiles}
            onSelect={handleFileSelect}
            onRemove={(name) =>
              setUploadedFiles((prev) => prev.filter((f) => f.name !== name))
            }
            onNext={handleUploadFiles}
            uploading={uploading}
            fileInputRef={fileInputRef}
            onAddRecording={(file) =>
              setUploadedFiles((prev) => [...prev, file])
            }
            onBack={goBack}
            serverFiles={serverFiles}
            onDeleteServerFile={handleDeleteServerFile}
          />
        )}
```

- [ ] **Step 6: Verify TypeScript**

```bash
cd /home/b/ElevenLabs-Clone/elevenlabs-clone-frontend
npx tsc --noEmit 2>&1 | grep -v node_modules | head -20
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add elevenlabs-clone-frontend/src/components/client/voice-lab/train-wizard.tsx
git commit -m "feat(wizard): show/delete server files on step 2 return, fix upload button"
```

---

## Task 9: Wizard — Step 3 wasCompleted + final verification

**Files:**
- Modify: `elevenlabs-clone-frontend/src/components/client/voice-lab/train-wizard.tsx`

- [ ] **Step 1: Add wasCompleted prop to StepPreprocess**

Add to `StepPreprocess` props interface:

```tsx
  wasCompleted?: boolean;
```

- [ ] **Step 2: Initialize ranTranscribe and ranSegment from wasCompleted**

In `StepPreprocess`, replace the two `useState` initializations:

```tsx
  const [ranTranscribe, setRanTranscribe] = useState(wasCompleted ?? false);
  const [ranSegment, setRanSegment] = useState(wasCompleted ?? false);
```

- [ ] **Step 3: Pass wasCompleted in the render section**

Update the `StepPreprocess` render call:

```tsx
        {step === 3 && job && (
          <StepPreprocess
            jobId={job.jobId}
            logs={logs}
            running={running}
            stepDone={stepDone}
            stepError={stepError}
            onRunStep={runStep}
            onNext={() => goToStep(4)}
            onBack={goBack}
            logsEndRef={logsEndRef}
            wasCompleted={maxStepReached.current > 3}
          />
        )}
```

- [ ] **Step 4: Final TypeScript check**

```bash
cd /home/b/ElevenLabs-Clone/elevenlabs-clone-frontend
npx tsc --noEmit 2>&1 | grep -v node_modules | head -20
```

Expected: zero errors.

- [ ] **Step 5: Run all backend tests**

```bash
cd /home/b/ElevenLabs-Clone/finetune-api
python -m pytest tests/ -v
```

Expected: all 5 tests **PASS**.

- [ ] **Step 6: Final commit**

```bash
git add elevenlabs-clone-frontend/src/components/client/voice-lab/train-wizard.tsx
git commit -m "feat(wizard): unlock step 3 sub-steps on return visit (wasCompleted)"
```

---

## Manual Verification Checklist

After all tasks are done, rebuild the finetune-api container and verify:

```bash
docker compose up --build finetune-api -d
```

- [ ] Start a new training job through the wizard. Complete steps 1–4.
- [ ] Click step 2 in the sidebar → previously uploaded files appear in "Already uploaded" list.
- [ ] Delete a server file → it disappears from the list.
- [ ] Upload a new file → it appears in the queue, "Upload & continue" works.
- [ ] Click step 1 in the sidebar → change epochs, click "Save & continue" → no new job created, wizard advances to step 2.
- [ ] Return to step 3 via sidebar → all four sub-step buttons are enabled immediately.
- [ ] Re-run "Transcribe audio" → log console shows new output.
- [ ] Back button on step 5 → returns to step 4, clips still loaded.
- [ ] Start training (step 6), click Back → warning appears in log area, SSE closed, returns to step 5.
- [ ] "New voice" button still resets all state to step 1 correctly.
