# GPT-SoVITS Parallel Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GPT-SoVITS v2 as a fully isolated parallel training backend — new FastAPI service, Docker container, Prisma migration, and React wizard — alongside the existing StyleTTS2 pipeline.

**Architecture:** A new `gptsovits-api` FastAPI service runs inside the `xxxxrt666/gpt-sovits:latest-cu126` Docker image and shares the same SQLite DB as `finetune-api` via volume mount. A new `GptSoVitsWizard` React component mirrors `TrainWizard` but drives the GPT-SoVITS pipeline (transcribe → features → train-gpt+sovits → deploy). A `BackendSelector` component on the train page lets the user pick between the two backends.

**Tech Stack:** Python 3.10+, FastAPI, faster-whisper, PyYAML, sqlite3, Next.js App Router, React, TypeScript, Prisma, Docker.

**Spec:** `docs/superpowers/specs/2026-04-25-gptsovits-backend-design.md`

---

## File Map

**Created:**
- `gptsovits-api/api.py` — FastAPI training orchestration service
- `gptsovits-api/requirements.txt`
- `gptsovits-api/Dockerfile`
- `gptsovits-api/tests/__init__.py`
- `gptsovits-api/tests/conftest.py`
- `gptsovits-api/tests/test_api.py`
- `scripts/download_gptsovits_models.sh`
- `elevenlabs-clone-frontend/src/app/api/voice-lab/gptsovits/jobs/route.ts`
- `elevenlabs-clone-frontend/src/app/api/voice-lab/gptsovits/jobs/[jobId]/route.ts`
- `elevenlabs-clone-frontend/src/app/api/voice-lab/gptsovits/jobs/[jobId]/audio/route.ts`
- `elevenlabs-clone-frontend/src/app/api/voice-lab/gptsovits/jobs/[jobId]/logs/route.ts`
- `elevenlabs-clone-frontend/src/app/api/voice-lab/gptsovits/jobs/[jobId]/run-step/route.ts`
- `elevenlabs-clone-frontend/src/app/api/voice-lab/gptsovits/jobs/[jobId]/upload/route.ts`
- `elevenlabs-clone-frontend/src/components/client/voice-lab/gptsovits-wizard.tsx`
- `elevenlabs-clone-frontend/src/components/client/voice-lab/backend-selector.tsx`

**Modified:**
- `elevenlabs-clone-frontend/prisma/schema.prisma` — add `sovitsEpochs Int @default(8)`
- `docker-compose.yml` — add `gptsovits-api` service
- `elevenlabs-clone-frontend/src/env.js` — add `GPTSOVITS_API_ROUTE`
- `elevenlabs-clone-frontend/.env.example` — add `GPTSOVITS_API_ROUTE`
- `elevenlabs-clone-frontend/src/app/app/voice-lab/train/page.tsx` — add BackendSelector

---

## ── PHASE 1: BACKEND ──────────────────────────────────────────

### Task 1: Prisma schema migration — add `sovitsEpochs`

**Files:**
- Modify: `elevenlabs-clone-frontend/prisma/schema.prisma:93-112`

- [ ] **Step 1: Add `sovitsEpochs` field to schema**

In `schema.prisma`, inside `model TrainingJob`, add the field after `batchSize`:

```prisma
model TrainingJob {
    id             String     @id @default(cuid())
    userId         String
    voiceModelId   String     @unique
    status         String     @default("uploading")
    currentStep    Int        @default(0)
    errorMessage   String?
    jobWorkDir     String?
    trainingEpochs Int        @default(75)
    batchSize      Int        @default(2)
    sovitsEpochs   Int        @default(8)
    language       String     @default("en-us")
    createdAt      DateTime   @default(now())
    updatedAt      DateTime   @updatedAt

    user           User       @relation(fields: [userId], references: [id], onDelete: Cascade)
    voiceModel     VoiceModel @relation(fields: [voiceModelId], references: [id], onDelete: Cascade)

    @@index([userId])
    @@index([status])
}
```

- [ ] **Step 2: Run migration**

```bash
cd elevenlabs-clone-frontend
npx prisma migrate dev --name add_sovits_epochs
```

Expected: Migration created and applied. `db.sqlite` gains the `sovitsEpochs` column.

- [ ] **Step 3: Verify column exists**

```bash
cd elevenlabs-clone-frontend
node -e "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.trainingJob.findFirst().then(r=>console.log('sovitsEpochs' in (r??{})||'column exists (no rows)')).finally(()=>p.\$disconnect())"
```

Expected: prints `true` or `column exists (no rows)`.

- [ ] **Step 4: Commit**

```bash
git add elevenlabs-clone-frontend/prisma/schema.prisma elevenlabs-clone-frontend/prisma/migrations/
git commit -m "feat(schema): add sovitsEpochs to TrainingJob"
```

---

### Task 2: Write failing tests for `gptsovits-api`

**Files:**
- Create: `gptsovits-api/tests/__init__.py`
- Create: `gptsovits-api/tests/conftest.py`
- Create: `gptsovits-api/tests/test_api.py`

- [ ] **Step 1: Create `gptsovits-api/tests/__init__.py`**

```python
```

(empty file)

- [ ] **Step 2: Create `gptsovits-api/tests/conftest.py`**

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
    batchSize INTEGER, sovitsEpochs INTEGER, language TEXT, errorMessage TEXT,
    createdAt TEXT, updatedAt TEXT
);
"""


@pytest.fixture()
def env_setup(tmp_path, monkeypatch):
    db_path = str(tmp_path / "test.sqlite")
    jobs_dir = str(tmp_path / "gptsovits-jobs")
    os.makedirs(jobs_dir)

    monkeypatch.setenv("API_KEY", "test-key")
    monkeypatch.setenv("DB_PATH", db_path)
    monkeypatch.setenv("WORKSPACE", str(tmp_path))

    import api
    monkeypatch.setattr(api, "DB_PATH", db_path)
    monkeypatch.setattr(api, "JOBS_DIR", jobs_dir)
    monkeypatch.setattr(api, "GPTSOVITS_PATH", str(tmp_path / "GPT-SoVITS"))
    monkeypatch.setattr(api, "PRETRAINED_DIR", str(tmp_path / "pretrained"))
    monkeypatch.setattr(api, "PREPARE_DIR", str(tmp_path / "prepare_datasets"))

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

- [ ] **Step 3: Create `gptsovits-api/tests/test_api.py`**

```python
import os
import sqlite3
from pathlib import Path

AUTH = {"Authorization": "Bearer test-key"}


def insert_job(db_path: str, job_id: str, jobs_dir: str):
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO VoiceModel (id, userId, name, voiceId, service, gradientColors, isActive, createdAt, updatedAt) "
        "VALUES (?, 'u1', 'Test', ?, 'gptsovits', '', 0, datetime('now'), datetime('now'))",
        (f"vm-{job_id}", f"vm-{job_id}"),
    )
    conn.execute(
        "INSERT INTO TrainingJob (id, userId, voiceModelId, status, currentStep, jobWorkDir, "
        "trainingEpochs, batchSize, sovitsEpochs, language, createdAt, updatedAt) "
        "VALUES (?, 'u1', ?, 'uploading', 0, ?, 15, 4, 8, 'en', datetime('now'), datetime('now'))",
        (job_id, f"vm-{job_id}", os.path.join(jobs_dir, job_id)),
    )
    conn.commit()
    conn.close()
    os.makedirs(os.path.join(jobs_dir, job_id, "audio"), exist_ok=True)
    os.makedirs(os.path.join(jobs_dir, job_id, "logs"), exist_ok=True)


# ── POST /jobs ────────────────────────────────────────────────────────────────

def test_create_job_returns_ids(client):
    c, env = client
    resp = c.post(
        "/jobs",
        json={"voiceName": "Alice", "language": "en", "gptEpochs": 15, "sovitsEpochs": 8, "userId": "u1"},
        headers=AUTH,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "jobId" in data
    assert "voiceModelId" in data


def test_create_job_sets_gptsovits_service(client):
    c, env = client
    resp = c.post(
        "/jobs",
        json={"voiceName": "Bob", "language": "en", "gptEpochs": 15, "sovitsEpochs": 8, "userId": "u1"},
        headers=AUTH,
    )
    vm_id = resp.json()["voiceModelId"]
    conn = sqlite3.connect(env["db_path"])
    row = conn.execute("SELECT service FROM VoiceModel WHERE id = ?", (vm_id,)).fetchone()
    conn.close()
    assert row[0] == "gptsovits"


# ── GET /jobs/{job_id}/audio ──────────────────────────────────────────────────

def test_list_audio_returns_wav_files(client):
    c, env = client
    insert_job(env["db_path"], "job-1", env["jobs_dir"])
    audio_dir = os.path.join(env["jobs_dir"], "job-1", "audio")
    Path(os.path.join(audio_dir, "voice.wav")).write_bytes(b"RIFF" + b"\x00" * 40)

    resp = c.get("/jobs/job-1/audio", headers=AUTH)
    assert resp.status_code == 200
    files = resp.json()["files"]
    assert len(files) == 1
    assert files[0]["name"] == "voice.wav"


def test_list_audio_empty(client):
    c, env = client
    insert_job(env["db_path"], "job-2", env["jobs_dir"])
    resp = c.get("/jobs/job-2/audio", headers=AUTH)
    assert resp.status_code == 200
    assert resp.json() == {"files": []}


def test_list_audio_not_found(client):
    c, _ = client
    resp = c.get("/jobs/nonexistent/audio", headers=AUTH)
    assert resp.status_code == 404


# ── PATCH /jobs/{job_id} ──────────────────────────────────────────────────────

def test_patch_updates_gpt_and_sovits_epochs(client):
    c, env = client
    insert_job(env["db_path"], "job-3", env["jobs_dir"])

    resp = c.patch("/jobs/job-3", json={"gptEpochs": 20, "sovitsEpochs": 12}, headers=AUTH)
    assert resp.status_code == 200
    assert resp.json() == {"updated": True}

    conn = sqlite3.connect(env["db_path"])
    row = conn.execute("SELECT trainingEpochs, sovitsEpochs FROM TrainingJob WHERE id = 'job-3'").fetchone()
    conn.close()
    assert row == (20, 12)


def test_patch_partial_update(client):
    c, env = client
    insert_job(env["db_path"], "job-4", env["jobs_dir"])

    resp = c.patch("/jobs/job-4", json={"gptEpochs": 25}, headers=AUTH)
    assert resp.status_code == 200

    conn = sqlite3.connect(env["db_path"])
    row = conn.execute("SELECT trainingEpochs, sovitsEpochs FROM TrainingJob WHERE id = 'job-4'").fetchone()
    conn.close()
    assert row == (25, 8)  # sovitsEpochs unchanged


def test_patch_not_found(client):
    c, _ = client
    resp = c.patch("/jobs/nonexistent", json={"gptEpochs": 20}, headers=AUTH)
    assert resp.status_code == 404


# ── POST /jobs/{job_id}/run-step ──────────────────────────────────────────────

def test_run_step_transcribe_accepted(client):
    c, env = client
    insert_job(env["db_path"], "job-5", env["jobs_dir"])
    Path(os.path.join(env["jobs_dir"], "job-5", "audio", "voice.wav")).write_bytes(b"RIFF" + b"\x00" * 40)

    resp = c.post("/jobs/job-5/run-step", json={"step": "transcribe"}, headers=AUTH)
    assert resp.status_code == 200
    assert resp.json()["accepted"] is True
    assert resp.json()["step"] == "transcribe"


def test_run_step_transcribe_requires_audio(client):
    c, env = client
    insert_job(env["db_path"], "job-6", env["jobs_dir"])
    # No WAV files in audio dir
    resp = c.post("/jobs/job-6/run-step", json={"step": "transcribe"}, headers=AUTH)
    assert resp.status_code == 400


def test_run_step_features_requires_transcription(client):
    c, env = client
    insert_job(env["db_path"], "job-7", env["jobs_dir"])
    # No inp_text.list yet
    resp = c.post("/jobs/job-7/run-step", json={"step": "features"}, headers=AUTH)
    assert resp.status_code == 400
    assert "Transcription" in resp.json()["detail"]


def test_run_step_not_found(client):
    c, _ = client
    resp = c.post("/jobs/nonexistent/run-step", json={"step": "transcribe"}, headers=AUTH)
    assert resp.status_code == 404


def test_run_step_unknown_rejected(client):
    c, env = client
    insert_job(env["db_path"], "job-8", env["jobs_dir"])
    resp = c.post("/jobs/job-8/run-step", json={"step": "bogus"}, headers=AUTH)
    assert resp.status_code == 400
```

- [ ] **Step 4: Verify tests fail (api module doesn't exist yet)**

```bash
cd gptsovits-api
python -m pytest tests/ -v 2>&1 | head -20
```

Expected: `ModuleNotFoundError: No module named 'api'` or import errors — confirms tests are wired correctly and code doesn't exist yet.

---

### Task 3: Implement `gptsovits-api` service

**Files:**
- Create: `gptsovits-api/requirements.txt`
- Create: `gptsovits-api/api.py`
- Create: `gptsovits-api/Dockerfile`

- [ ] **Step 1: Create `gptsovits-api/requirements.txt`**

```
fastapi==0.115.0
uvicorn[standard]==0.30.6
sse-starlette==2.1.3
aiofiles==23.2.1
pydantic==2.9.2
PyYAML==6.0.2
```

(All ML deps — torch, faster-whisper — are already in the `xxxxrt666/gpt-sovits:latest-cu126` base image.)

- [ ] **Step 2: Create `gptsovits-api/api.py`**

```python
import asyncio
import glob
import json
import logging
import os
import shutil
import sqlite3
import subprocess
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import aiofiles
import yaml
from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, UploadFile
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
API_KEY = os.getenv("API_KEY", "")
WORKSPACE = os.getenv("WORKSPACE", "/workspace")
GPTSOVITS_PATH = os.getenv("GPTSOVITS_PATH", "/workspace/GPT-SoVITS")
DB_PATH = os.getenv("DB_PATH", "/db.sqlite")

JOBS_DIR = os.path.join(WORKSPACE, "gptsovits-jobs")
PRETRAINED_DIR = os.path.join(GPTSOVITS_PATH, "GPT_SoVITS", "pretrained_models")
PREPARE_DIR = os.path.join(GPTSOVITS_PATH, "GPT_SoVITS", "prepare_datasets")

GRADIENT_COLORS = [
    "linear-gradient(45deg, #8b5cf6, #ec4899, #ffffff, #3b82f6)",
    "linear-gradient(45deg, #3b82f6, #10b981, #ffffff, #f59e0b)",
    "linear-gradient(45deg, #ec4899, #f97316, #ffffff, #8b5cf6)",
    "linear-gradient(45deg, #10b981, #3b82f6, #ffffff, #f43f5e)",
    "linear-gradient(45deg, #f43f5e, #f59e0b, #ffffff, #10b981)",
]

running_procs: dict[str, subprocess.Popen] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(JOBS_DIR, exist_ok=True)
    yield


app = FastAPI(title="GPT-SoVITS API", lifespan=lifespan)


# ── Auth ──────────────────────────────────────────────────────────────────────
async def verify_api_key(authorization: str = Header(None)):
    if not authorization:
        raise HTTPException(status_code=401, detail="API key missing")
    token = authorization.replace("Bearer ", "") if authorization.startswith("Bearer ") else authorization
    if API_KEY and token != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return token


# ── DB helpers ────────────────────────────────────────────────────────────────
def _db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.row_factory = sqlite3.Row
    return conn


def db_execute(sql: str, params: tuple = ()):
    conn = _db_connect()
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


def db_fetchone(sql: str, params: tuple = ()):
    conn = _db_connect()
    try:
        row = conn.execute(sql, params).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


# ── Pydantic models ───────────────────────────────────────────────────────────
class CreateJobRequest(BaseModel):
    voiceName: str
    language: str = "en"
    gptEpochs: int = 15
    sovitsEpochs: int = 8
    userId: str


class RunStepRequest(BaseModel):
    step: str


class UpdateJobRequest(BaseModel):
    gptEpochs: Optional[int] = None
    sovitsEpochs: Optional[int] = None


# ── Helpers ───────────────────────────────────────────────────────────────────
def job_dir(job_id: str) -> str:
    return os.path.join(JOBS_DIR, job_id)


def log_path(job_id: str) -> str:
    return os.path.join(job_dir(job_id), "logs", "current_step.log")


def update_job_status(job_id: str, status: str, step: int = None, error: str = None):
    parts = ["status = ?"]
    vals: list = [status]
    if step is not None:
        parts.append("currentStep = ?")
        vals.append(step)
    if error is not None:
        parts.append("errorMessage = ?")
        vals.append(error)
    vals.append(job_id)
    db_execute(
        f"UPDATE TrainingJob SET {', '.join(parts)}, updatedAt = datetime('now') WHERE id = ?",
        tuple(vals),
    )


def generate_gpt_config(job_id: str, gpt_epochs: int, jd: str) -> str:
    features_dir = os.path.join(jd, "features")
    gpt_output_dir = os.path.join(jd, "output", "gpt")
    gpt_weights_dir = os.path.join(jd, "output", "gpt_weights")

    base_path = os.path.join(GPTSOVITS_PATH, "GPT_SoVITS", "configs", "s1.yaml")
    with open(base_path) as f:
        config = yaml.safe_load(f)

    config["train_semantic_path"] = os.path.join(features_dir, "6-name2semantic.tsv")
    config["train_phoneme_path"] = os.path.join(features_dir, "2-name2text.txt")
    config["output_dir"] = gpt_output_dir
    config["pretrained_s1"] = os.path.join(PRETRAINED_DIR, "s1v3.ckpt")
    config["train"]["epochs"] = gpt_epochs
    config["train"]["exp_name"] = job_id
    config["train"]["if_save_latest"] = True
    config["train"]["if_save_every_weights"] = True
    config["train"]["half_weights_save_dir"] = gpt_weights_dir
    config["train"]["save_every_n_epoch"] = 1
    config["train"]["batch_size"] = 4

    os.makedirs(os.path.join(jd, "configs"), exist_ok=True)
    os.makedirs(gpt_output_dir, exist_ok=True)
    os.makedirs(gpt_weights_dir, exist_ok=True)

    config_path = os.path.join(jd, "configs", "s1.yaml")
    with open(config_path, "w") as f:
        yaml.dump(config, f)
    return config_path


def generate_sovits_config(job_id: str, sovits_epochs: int, jd: str) -> str:
    features_dir = os.path.join(jd, "features")
    sovits_ckpt_dir = os.path.join(jd, "output", "sovits")

    base_path = os.path.join(GPTSOVITS_PATH, "GPT_SoVITS", "configs", "s2.json")
    with open(base_path) as f:
        config = json.load(f)

    config["train"]["epochs"] = sovits_epochs
    config["train"]["pretrained_s2G"] = os.path.join(PRETRAINED_DIR, "s2G2333k.pth")
    config["train"]["pretrained_s2D"] = os.path.join(PRETRAINED_DIR, "s2D2333k.pth")
    config["data"]["exp_dir"] = features_dir
    config["s2_ckpt_dir"] = sovits_ckpt_dir
    config["model"]["version"] = "v2"

    os.makedirs(sovits_ckpt_dir, exist_ok=True)

    config_path = os.path.join(jd, "configs", "s2.json")
    with open(config_path, "w") as f:
        json.dump(config, f, indent=2)
    return config_path


# ── Background tasks ──────────────────────────────────────────────────────────

async def _run_transcribe(job_id: str, audio_files: list[str], language: str, voice_model_id: str, jd: str):
    os.makedirs(os.path.join(jd, "logs"), exist_ok=True)
    lp = log_path(job_id)
    update_job_status(job_id, "transcribing", step=2)

    vm = db_fetchone("SELECT name FROM VoiceModel WHERE id = ?", (voice_model_id,))
    spk_name = vm["name"] if vm else "speaker"
    lang_code = language.split("-")[0]

    with open(lp, "w") as lf:
        lf.write("[gptsovits-api] Starting transcription (Whisper large-v3)\n")
        lf.flush()
        try:
            import torch
            from faster_whisper import WhisperModel

            device = "cuda" if torch.cuda.is_available() else "cpu"
            compute_type = "float16" if device == "cuda" else "int8"
            lf.write(f"[gptsovits-api] Loading model on {device} ({compute_type})...\n")
            lf.flush()

            model = WhisperModel("large-v3", device=device, compute_type=compute_type)
            inp_text_path = os.path.join(jd, "inp_text.list")

            with open(inp_text_path, "w", encoding="utf-8") as tf:
                for audio_path in audio_files:
                    wav_name = os.path.basename(audio_path)
                    lf.write(f"[gptsovits-api] Transcribing: {wav_name}\n")
                    lf.flush()
                    segments, _info = model.transcribe(
                        audio_path,
                        beam_size=5,
                        language=lang_code,
                        vad_filter=True,
                        condition_on_previous_text=True,
                    )
                    text = " ".join(seg.text.strip() for seg in segments).strip()
                    tf.write(f"{wav_name}|{spk_name}|{lang_code}|{text}\n")
                    lf.write(f"  → {text}\n")
                    lf.flush()

            lf.write("\n[gptsovits-api] Transcription complete\n")
        except Exception as e:
            import traceback as tb
            lf.write(f"\n[gptsovits-api] Transcription failed: {e}\n{tb.format_exc()}\n")
            update_job_status(job_id, "failed", error=f"Transcription failed: {e}")
            return

    update_job_status(job_id, "transcribing_done", step=2)


async def _run_features(job_id: str, jd: str):
    os.makedirs(os.path.join(jd, "logs"), exist_ok=True)
    lp = log_path(job_id)
    features_dir = os.path.join(jd, "features")
    inp_text = os.path.join(jd, "inp_text.list")
    audio_dir = os.path.join(jd, "audio")
    update_job_status(job_id, "extracting", step=3)
    loop = asyncio.get_event_loop()

    gpts_root = os.path.join(GPTSOVITS_PATH, "GPT_SoVITS")
    base_env = {
        **os.environ,
        "PYTHONUNBUFFERED": "1",
        "PYTHONPATH": gpts_root,
        "inp_text": inp_text,
        "inp_wav_dir": audio_dir,
        "exp_name": job_id,
        "i_part": "0",
        "all_parts": "1",
        "opt_dir": features_dir,
        "_CUDA_VISIBLE_DEVICES": "0",
    }
    os.makedirs(features_dir, exist_ok=True)

    # Script 1: text processing (BERT features for Chinese; phoneme text for all)
    script1_env = {**base_env, "bert_pretrained_dir": os.path.join(PRETRAINED_DIR, "chinese-roberta-wwm-ext-large")}
    cmd1 = ["python", os.path.join(PREPARE_DIR, "1-get-text.py")]
    try:
        with open(lp, "w") as lf:
            lf.write("[gptsovits-api] === Feature extraction 1/3: text processing ===\n")
            lf.flush()
            proc = subprocess.Popen(cmd1, cwd=gpts_root, stdout=lf, stderr=subprocess.STDOUT, env=script1_env)
            running_procs[job_id] = proc
    except Exception as exc:
        update_job_status(job_id, "failed", error=str(exc))
        return

    rc = await loop.run_in_executor(None, proc.wait)
    running_procs.pop(job_id, None)

    # Rename 2-name2text-0.txt → 2-name2text.txt (s2_train reads without i_part suffix)
    part_txt = os.path.join(features_dir, "2-name2text-0.txt")
    merged_txt = os.path.join(features_dir, "2-name2text.txt")
    if os.path.exists(part_txt):
        shutil.copy(part_txt, merged_txt)

    with open(lp, "a") as lf:
        lf.write(f"\n[gptsovits-api] Text processing exit code {rc}\n")
    if rc != 0:
        update_job_status(job_id, "failed", error=f"Feature extraction (text) failed (exit {rc})")
        return

    # Script 2: HuBERT feature extraction + 32kHz resample
    script2_env = {**base_env, "cnhubert_base_dir": os.path.join(PRETRAINED_DIR, "chinese-hubert-base")}
    cmd2 = ["python", os.path.join(PREPARE_DIR, "2-get-hubert-wav32k.py")]
    try:
        with open(lp, "a") as lf:
            lf.write("\n[gptsovits-api] === Feature extraction 2/3: HuBERT + wav32k ===\n")
            lf.flush()
            proc = subprocess.Popen(cmd2, cwd=gpts_root, stdout=lf, stderr=subprocess.STDOUT, env=script2_env)
            running_procs[job_id] = proc
    except Exception as exc:
        update_job_status(job_id, "failed", error=str(exc))
        return

    rc = await loop.run_in_executor(None, proc.wait)
    running_procs.pop(job_id, None)
    with open(lp, "a") as lf:
        lf.write(f"\n[gptsovits-api] HuBERT exit code {rc}\n")
    if rc != 0:
        update_job_status(job_id, "failed", error=f"Feature extraction (HuBERT) failed (exit {rc})")
        return

    # Script 3: semantic token extraction (input to s1_train)
    script3_env = {
        **base_env,
        "pretrained_s2G": os.path.join(PRETRAINED_DIR, "s2G2333k.pth"),
        "s2config_path": os.path.join(GPTSOVITS_PATH, "GPT_SoVITS", "configs", "s2.json"),
    }
    cmd3 = ["python", os.path.join(PREPARE_DIR, "3-get-semantic.py")]
    try:
        with open(lp, "a") as lf:
            lf.write("\n[gptsovits-api] === Feature extraction 3/3: semantic tokens ===\n")
            lf.flush()
            proc = subprocess.Popen(cmd3, cwd=gpts_root, stdout=lf, stderr=subprocess.STDOUT, env=script3_env)
            running_procs[job_id] = proc
    except Exception as exc:
        update_job_status(job_id, "failed", error=str(exc))
        return

    rc = await loop.run_in_executor(None, proc.wait)
    running_procs.pop(job_id, None)
    with open(lp, "a") as lf:
        lf.write(f"\n[gptsovits-api] Semantic tokens exit code {rc}\n")

    if rc != 0:
        update_job_status(job_id, "failed", error=f"Feature extraction (semantic) failed (exit {rc})")
    else:
        update_job_status(job_id, "extracting_done")


async def _run_training(job_id: str, gpt_epochs: int, sovits_epochs: int, jd: str):
    os.makedirs(os.path.join(jd, "logs"), exist_ok=True)
    lp = log_path(job_id)
    update_job_status(job_id, "training", step=4)
    loop = asyncio.get_event_loop()

    gpts_root = os.path.join(GPTSOVITS_PATH, "GPT_SoVITS")
    base_env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONPATH": gpts_root}

    # GPT stage (s1_train.py)
    gpt_config = generate_gpt_config(job_id, gpt_epochs, jd)
    gpt_cmd = ["python", os.path.join(gpts_root, "s1_train.py"), "--config_file", gpt_config]
    try:
        with open(lp, "w") as lf:
            lf.write("[gptsovits-api] === GPT stage training ===\n")
            lf.flush()
            proc = subprocess.Popen(gpt_cmd, cwd=gpts_root, stdout=lf, stderr=subprocess.STDOUT, env=base_env)
            running_procs[job_id] = proc
    except Exception as exc:
        update_job_status(job_id, "failed", error=str(exc))
        return

    rc = await loop.run_in_executor(None, proc.wait)
    running_procs.pop(job_id, None)
    with open(lp, "a") as lf:
        lf.write(f"\n[gptsovits-api] GPT stage exit code {rc}\n")
    if rc != 0:
        update_job_status(job_id, "failed", error=f"GPT training failed (exit {rc})")
        return

    # SoVITS stage (s2_train.py)
    sovits_config = generate_sovits_config(job_id, sovits_epochs, jd)
    sovits_cmd = ["python", os.path.join(gpts_root, "s2_train.py"), "--config", sovits_config]
    try:
        with open(lp, "a") as lf:
            lf.write("\n[gptsovits-api] === SoVITS stage training ===\n")
            lf.flush()
            proc = subprocess.Popen(sovits_cmd, cwd=gpts_root, stdout=lf, stderr=subprocess.STDOUT, env=base_env)
            running_procs[job_id] = proc
    except Exception as exc:
        update_job_status(job_id, "failed", error=str(exc))
        return

    rc = await loop.run_in_executor(None, proc.wait)
    running_procs.pop(job_id, None)
    with open(lp, "a") as lf:
        lf.write(f"\n[gptsovits-api] SoVITS stage exit code {rc}\n")

    if rc != 0:
        update_job_status(job_id, "failed", error=f"SoVITS training failed (exit {rc})")
    else:
        update_job_status(job_id, "training_done")


async def _run_deploy(job_id: str, jd: str):
    os.makedirs(os.path.join(jd, "logs"), exist_ok=True)
    lp = log_path(job_id)
    update_job_status(job_id, "deploying", step=5)

    job = db_fetchone("SELECT * FROM TrainingJob WHERE id = ?", (job_id,))
    vm = db_fetchone("SELECT * FROM VoiceModel WHERE id = ?", (job["voiceModelId"],)) if job else None
    if not job or not vm:
        return

    features_dir = os.path.join(jd, "features")
    gpt_weights_dir = os.path.join(jd, "output", "gpt_weights")

    gpt_dest = sovits_dest = ref_dest = None

    with open(lp, "w") as lf:
        lf.write("[gptsovits-api] Deploying voice model\n")
        try:
            gpt_ckpts = sorted(glob.glob(os.path.join(gpt_weights_dir, "*-e*.ckpt")))
            if not gpt_ckpts:
                gpt_ckpts = sorted(glob.glob(os.path.join(jd, "output", "gpt", "ckpt", "*.ckpt")))
            if not gpt_ckpts:
                raise FileNotFoundError("No GPT checkpoint found — has GPT training completed?")

            sovits_ckpts = sorted(glob.glob(os.path.join(features_dir, "logs_s2_v2", "G_*.pth")))
            if not sovits_ckpts:
                raise FileNotFoundError("No SoVITS checkpoint found — has SoVITS training completed?")

            audio_files = sorted(glob.glob(os.path.join(jd, "audio", "*.wav")))
            if not audio_files:
                raise FileNotFoundError("No reference audio found")

            voice_id = vm["voiceId"]
            voice_out_dir = os.path.join(WORKSPACE, "voices", voice_id)
            os.makedirs(voice_out_dir, exist_ok=True)

            gpt_dest = os.path.join(voice_out_dir, "gpt.ckpt")
            sovits_dest = os.path.join(voice_out_dir, "sovits.pth")
            ref_dest = os.path.join(voice_out_dir, "reference.wav")

            shutil.copy(gpt_ckpts[-1], gpt_dest)
            shutil.copy(sovits_ckpts[-1], sovits_dest)
            shutil.copy(audio_files[0], ref_dest)

            lf.write(f"[gptsovits-api] Copied weights to {voice_out_dir}\n")
        except Exception as e:
            import traceback as tb
            lf.write(f"\n[gptsovits-api] Deploy failed: {e}\n{tb.format_exc()}\n")
            update_job_status(job_id, "failed", error=f"Deploy failed: {e}")
            return

    db_execute(
        "UPDATE VoiceModel SET isActive = 1, checkpointPath = ?, referenceAudioPath = ?, updatedAt = datetime('now') WHERE id = ?",
        (gpt_dest, ref_dest, vm["id"]),
    )
    db_execute(
        "UPDATE TrainingJob SET status = 'ready', updatedAt = datetime('now') WHERE id = ?",
        (job_id,),
    )


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.post("/jobs", dependencies=[Depends(verify_api_key)])
async def create_job(req: CreateJobRequest):
    job_id = str(uuid.uuid4())
    voice_id = f"voice-{uuid.uuid4().hex[:8]}"
    jd = job_dir(job_id)

    for sub in ["audio", "features", "logs",
                os.path.join("output", "gpt"),
                os.path.join("output", "sovits"),
                os.path.join("output", "gpt_weights")]:
        os.makedirs(os.path.join(jd, sub), exist_ok=True)

    gradient = GRADIENT_COLORS[hash(req.voiceName) % len(GRADIENT_COLORS)]

    db_execute(
        "INSERT INTO VoiceModel (id, userId, name, voiceId, service, gradientColors, isActive, createdAt, updatedAt) "
        "VALUES (?, ?, ?, ?, 'gptsovits', ?, 0, datetime('now'), datetime('now'))",
        (voice_id, req.userId, req.voiceName, voice_id, gradient),
    )
    db_execute(
        "INSERT INTO TrainingJob (id, userId, voiceModelId, status, currentStep, jobWorkDir, "
        "trainingEpochs, batchSize, sovitsEpochs, language, createdAt, updatedAt) "
        "VALUES (?, ?, ?, 'uploading', 0, ?, ?, 4, ?, ?, datetime('now'), datetime('now'))",
        (job_id, req.userId, voice_id, jd, req.gptEpochs, req.sovitsEpochs, req.language),
    )

    return {"jobId": job_id, "voiceModelId": voice_id, "workDir": jd}


@app.post("/jobs/{job_id}/upload", dependencies=[Depends(verify_api_key)])
async def upload_audio(job_id: str, file: UploadFile):
    audio_dir = os.path.join(job_dir(job_id), "audio")
    if not os.path.exists(audio_dir):
        raise HTTPException(status_code=404, detail="Job not found")

    original_name = file.filename or "upload"
    stem = Path(original_name).stem
    wav_name = f"{stem}.wav"
    tmp_path = os.path.join(audio_dir, f"_tmp_{original_name}")

    content = await file.read()
    async with aiofiles.open(tmp_path, "wb") as f:
        await f.write(content)

    dest = os.path.join(audio_dir, wav_name)
    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", tmp_path, "-ac", "1", "-ar", "22050", "-sample_fmt", "s16", dest],
            capture_output=True, text=True, timeout=300,
        )
        if result.returncode != 0:
            raise HTTPException(status_code=400, detail=f"Could not convert audio: {result.stderr[-500:]}")
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

    return {"filename": wav_name, "size": os.path.getsize(dest)}


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


@app.get("/jobs/{job_id}/status", dependencies=[Depends(verify_api_key)])
async def get_job_status(job_id: str):
    job = db_fetchone("SELECT * FROM TrainingJob WHERE id = ?", (job_id,))
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.patch("/jobs/{job_id}", dependencies=[Depends(verify_api_key)])
async def update_job(job_id: str, req: UpdateJobRequest):
    job = db_fetchone("SELECT id FROM TrainingJob WHERE id = ?", (job_id,))
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    parts: list[str] = []
    vals: list = []
    if req.gptEpochs is not None:
        parts.append("trainingEpochs = ?")
        vals.append(req.gptEpochs)
    if req.sovitsEpochs is not None:
        parts.append("sovitsEpochs = ?")
        vals.append(req.sovitsEpochs)
    if parts:
        vals.append(job_id)
        db_execute(
            f"UPDATE TrainingJob SET {', '.join(parts)}, updatedAt = datetime('now') WHERE id = ?",
            tuple(vals),
        )
    return {"updated": True}


@app.post("/jobs/{job_id}/run-step", dependencies=[Depends(verify_api_key)])
async def run_step(job_id: str, req: RunStepRequest, background_tasks: BackgroundTasks):
    jd = job_dir(job_id)
    if not os.path.exists(jd):
        raise HTTPException(status_code=404, detail="Job not found")

    job = db_fetchone("SELECT * FROM TrainingJob WHERE id = ?", (job_id,))
    if not job:
        raise HTTPException(status_code=404, detail="Job not found in DB")

    step = req.step

    if step == "transcribe":
        audio_files = glob.glob(os.path.join(jd, "audio", "*.wav"))
        if not audio_files:
            raise HTTPException(status_code=400, detail="No WAV files uploaded")
        background_tasks.add_task(_run_transcribe, job_id, audio_files, job["language"], job["voiceModelId"], jd)

    elif step == "features":
        inp_text = os.path.join(jd, "inp_text.list")
        if not os.path.exists(inp_text):
            raise HTTPException(status_code=400, detail="Transcription not done yet — run 'transcribe' first")
        background_tasks.add_task(_run_features, job_id, jd)

    elif step == "train":
        background_tasks.add_task(_run_training, job_id, job["trainingEpochs"], job["sovitsEpochs"], jd)

    elif step == "deploy":
        background_tasks.add_task(_run_deploy, job_id, jd)

    else:
        raise HTTPException(status_code=400, detail=f"Unknown step: {step}")

    return {"accepted": True, "step": step}


@app.get("/jobs/{job_id}/logs", dependencies=[Depends(verify_api_key)])
async def stream_logs(job_id: str):
    lp = log_path(job_id)

    async def event_generator():
        if not os.path.exists(lp):
            yield {"data": json.dumps({"type": "log", "message": "Waiting for step to start..."})}

        last_pos = 0
        while True:
            if os.path.exists(lp):
                async with aiofiles.open(lp, "r") as f:
                    await f.seek(last_pos)
                    new_content = await f.read()
                    if new_content:
                        for line in new_content.splitlines():
                            yield {"data": json.dumps({"type": "log", "message": line})}
                        last_pos += len(new_content.encode())

            job = db_fetchone("SELECT status FROM TrainingJob WHERE id = ?", (job_id,))
            if job and (job["status"] in ("ready", "failed") or job["status"].endswith("_done")):
                yield {"data": json.dumps({"type": "complete", "status": job["status"]})}
                break

            await asyncio.sleep(0.5)

    return EventSourceResponse(event_generator())


@app.delete("/jobs/{job_id}", dependencies=[Depends(verify_api_key)])
async def delete_job(job_id: str):
    jd = job_dir(job_id)
    if job_id in running_procs:
        running_procs[job_id].terminate()
        running_procs.pop(job_id, None)

    db_execute("UPDATE TrainingJob SET status = 'failed', updatedAt = datetime('now') WHERE id = ?", (job_id,))
    if os.path.exists(jd):
        shutil.rmtree(jd)

    return {"deleted": True}
```

- [ ] **Step 3: Create `gptsovits-api/Dockerfile`**

```dockerfile
FROM xxxxrt666/gpt-sovits:latest-cu126
WORKDIR /gptsovits-api
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY api.py .
CMD ["uvicorn", "api:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 4: Install test deps and run tests**

```bash
cd gptsovits-api
python -m venv .venv
source .venv/bin/activate
pip install fastapi uvicorn sse-starlette aiofiles pydantic pyyaml httpx starlette pytest pytest-asyncio
python -m pytest tests/ -v
```

Expected: All 13 tests pass.

- [ ] **Step 5: Commit**

```bash
git add gptsovits-api/
git commit -m "feat(gptsovits-api): FastAPI training service with TDD"
```

---

### Task 4: Pretrained models download script

**Files:**
- Create: `scripts/download_gptsovits_models.sh`

- [ ] **Step 1: Create `scripts/download_gptsovits_models.sh`**

```bash
#!/usr/bin/env bash
# Downloads GPT-SoVITS v2 pretrained models into GPT-SoVITS/GPT_SoVITS/pretrained_models/
# Idempotent — skips files that already exist.
set -e

DEST="$(dirname "$0")/../GPT-SoVITS/GPT_SoVITS/pretrained_models"
mkdir -p "$DEST"

HF_BASE="https://huggingface.co/lj1995/GPT-SoVITS/resolve/main"

download_if_missing() {
  local url="$1"
  local dest="$2"
  if [ -f "$dest" ]; then
    echo "  [skip] $(basename "$dest") already exists"
  else
    echo "  [download] $(basename "$dest")"
    curl -L --progress-bar -o "$dest" "$url"
  fi
}

echo "=== GPT-SoVITS v2 pretrained models ==="
echo "Target: $DEST"
echo ""

# GPT stage pretrained checkpoint (~100 MB)
download_if_missing \
  "$HF_BASE/s1v3.ckpt" \
  "$DEST/s1v3.ckpt"

# SoVITS G model (~300 MB)
download_if_missing \
  "$HF_BASE/s2G2333k.pth" \
  "$DEST/s2G2333k.pth"

# SoVITS D model (~400 MB)
download_if_missing \
  "$HF_BASE/s2D2333k.pth" \
  "$DEST/s2D2333k.pth"

# Chinese HuBERT model — needed for feature extraction regardless of target language (~400 MB)
HUBERT_DEST="$DEST/chinese-hubert-base"
if [ -d "$HUBERT_DEST" ] && [ -f "$HUBERT_DEST/config.json" ]; then
  echo "  [skip] chinese-hubert-base already exists"
else
  echo "  [download] chinese-hubert-base (from HuggingFace)"
  pip install -q huggingface_hub
  python -c "
from huggingface_hub import snapshot_download
snapshot_download('TencentGameMate/chinese-hubert-base', local_dir='$HUBERT_DEST')
print('Done.')
"
fi

# Chinese RoBERTa model — needed by 1-get-text.py even for non-Chinese text (~400 MB)
BERT_DEST="$DEST/chinese-roberta-wwm-ext-large"
if [ -d "$BERT_DEST" ] && [ -f "$BERT_DEST/config.json" ]; then
  echo "  [skip] chinese-roberta-wwm-ext-large already exists"
else
  echo "  [download] chinese-roberta-wwm-ext-large"
  python -c "
from huggingface_hub import snapshot_download
snapshot_download('hfl/chinese-roberta-wwm-ext-large', local_dir='$BERT_DEST')
print('Done.')
"
fi

echo ""
echo "=== All models ready ==="
echo "Run this before starting the gptsovits-api container."
```

- [ ] **Step 2: Make executable and commit**

```bash
chmod +x scripts/download_gptsovits_models.sh
git add scripts/download_gptsovits_models.sh
git commit -m "feat(scripts): add GPT-SoVITS pretrained model download script"
```

---

### Task 5: Docker service and environment wiring

**Files:**
- Modify: `docker-compose.yml`
- Modify: `elevenlabs-clone-frontend/src/env.js`
- Modify: `elevenlabs-clone-frontend/.env.example`

- [ ] **Step 1: Add `gptsovits-api` service to `docker-compose.yml`**

After the `finetune-api` service block, add:

```yaml
  gptsovits-api:
    build:
      context: ./gptsovits-api
      dockerfile: Dockerfile
    ports:
      - '8105:8000'
    restart: unless-stopped
    environment:
      - API_KEY=${BACKEND_API_KEY}
      - DB_PATH=/prisma-data/db.sqlite
      - WORKSPACE=/workspace
      - GPTSOVITS_PATH=/workspace/GPT-SoVITS
      - is_half=true
    volumes:
      - finetune_workspace:/workspace
      - ./GPT-SoVITS:/workspace/GPT-SoVITS
      - ./elevenlabs-clone-frontend/prisma:/prisma-data
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
```

Also add `GPTSOVITS_API_ROUTE=http://gptsovits-api:8000` to the `frontend` service's `environment` block.

- [ ] **Step 2: Add `GPTSOVITS_API_ROUTE` to `env.js`**

In `elevenlabs-clone-frontend/src/env.js`, inside the `server:` object, add after `FINETUNE_API_ROUTE`:

```js
GPTSOVITS_API_ROUTE: z.string(),
```

Inside `runtimeEnv:`, add:

```js
GPTSOVITS_API_ROUTE: process.env.GPTSOVITS_API_ROUTE,
```

- [ ] **Step 3: Add to `.env.example`**

Append to `elevenlabs-clone-frontend/.env.example`:

```
# GPT-SoVITS training API (docker-compose service on port 8105)
GPTSOVITS_API_ROUTE=http://localhost:8105
```

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml elevenlabs-clone-frontend/src/env.js elevenlabs-clone-frontend/.env.example
git commit -m "feat(docker): add gptsovits-api service and env wiring"
```

---

## ── PHASE 2: FRONTEND ─────────────────────────────────────────

### Task 6: Next.js proxy routes for `gptsovits-api`

**Files (all new):**
- `elevenlabs-clone-frontend/src/app/api/voice-lab/gptsovits/jobs/route.ts`
- `elevenlabs-clone-frontend/src/app/api/voice-lab/gptsovits/jobs/[jobId]/route.ts`
- `elevenlabs-clone-frontend/src/app/api/voice-lab/gptsovits/jobs/[jobId]/audio/route.ts`
- `elevenlabs-clone-frontend/src/app/api/voice-lab/gptsovits/jobs/[jobId]/logs/route.ts`
- `elevenlabs-clone-frontend/src/app/api/voice-lab/gptsovits/jobs/[jobId]/run-step/route.ts`
- `elevenlabs-clone-frontend/src/app/api/voice-lab/gptsovits/jobs/[jobId]/upload/route.ts`

Each route mirrors the existing `/api/voice-lab/jobs/` routes but calls `env.GPTSOVITS_API_ROUTE`.

- [ ] **Step 1: Create `jobs/route.ts` (POST /jobs)**

```typescript
// elevenlabs-clone-frontend/src/app/api/voice-lab/gptsovits/jobs/route.ts
import { NextRequest } from "next/server";
import { env } from "~/env";
import { auth } from "~/server/auth";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const resp = await fetch(`${env.GPTSOVITS_API_ROUTE}/jobs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.BACKEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...body, userId: session.user.id }),
  });

  return Response.json(await resp.json(), { status: resp.status });
}
```

- [ ] **Step 2: Create `jobs/[jobId]/route.ts` (GET status, PATCH, DELETE)**

```typescript
// elevenlabs-clone-frontend/src/app/api/voice-lab/gptsovits/jobs/[jobId]/route.ts
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
  if (!session?.user.id) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { jobId } = await params;
  if (!(await verifyOwnership(jobId, session.user.id))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const resp = await fetch(`${env.GPTSOVITS_API_ROUTE}/jobs/${jobId}/status`, {
    headers: { Authorization: `Bearer ${env.BACKEND_API_KEY}` },
  });
  return Response.json(await resp.json(), { status: resp.status });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const session = await auth();
  if (!session?.user.id) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { jobId } = await params;
  if (!(await verifyOwnership(jobId, session.user.id))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const body = await req.json() as { gptEpochs?: number; sovitsEpochs?: number };
  const resp = await fetch(`${env.GPTSOVITS_API_ROUTE}/jobs/${jobId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${env.BACKEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return Response.json(await resp.json(), { status: resp.status });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const session = await auth();
  if (!session?.user.id) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { jobId } = await params;
  if (!(await verifyOwnership(jobId, session.user.id))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const resp = await fetch(`${env.GPTSOVITS_API_ROUTE}/jobs/${jobId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${env.BACKEND_API_KEY}` },
  });
  return Response.json(await resp.json(), { status: resp.status });
}
```

- [ ] **Step 3: Create `jobs/[jobId]/audio/route.ts`**

```typescript
// elevenlabs-clone-frontend/src/app/api/voice-lab/gptsovits/jobs/[jobId]/audio/route.ts
import { NextRequest } from "next/server";
import { env } from "~/env";
import { auth } from "~/server/auth";
import { db } from "~/server/db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const session = await auth();
  if (!session?.user.id) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { jobId } = await params;
  const job = await db.trainingJob.findFirst({ where: { id: jobId, userId: session.user.id } });
  if (!job) return Response.json({ error: "Not found" }, { status: 404 });
  const resp = await fetch(`${env.GPTSOVITS_API_ROUTE}/jobs/${jobId}/audio`, {
    headers: { Authorization: `Bearer ${env.BACKEND_API_KEY}` },
  });
  return Response.json(await resp.json(), { status: resp.status });
}
```

- [ ] **Step 4: Create `jobs/[jobId]/logs/route.ts` (SSE proxy)**

```typescript
// elevenlabs-clone-frontend/src/app/api/voice-lab/gptsovits/jobs/[jobId]/logs/route.ts
import { NextRequest } from "next/server";
import { env } from "~/env";
import { auth } from "~/server/auth";
import { db } from "~/server/db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const session = await auth();
  if (!session?.user.id) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { jobId } = await params;
  const job = await db.trainingJob.findFirst({ where: { id: jobId, userId: session.user.id } });
  if (!job) return Response.json({ error: "Not found" }, { status: 404 });
  const upstream = await fetch(`${env.GPTSOVITS_API_ROUTE}/jobs/${jobId}/logs`, {
    headers: { Authorization: `Bearer ${env.BACKEND_API_KEY}` },
  });
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
```

- [ ] **Step 5: Create `jobs/[jobId]/run-step/route.ts`**

```typescript
// elevenlabs-clone-frontend/src/app/api/voice-lab/gptsovits/jobs/[jobId]/run-step/route.ts
import { NextRequest } from "next/server";
import { env } from "~/env";
import { auth } from "~/server/auth";
import { db } from "~/server/db";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const session = await auth();
  if (!session?.user.id) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { jobId } = await params;
  const job = await db.trainingJob.findFirst({ where: { id: jobId, userId: session.user.id } });
  if (!job) return Response.json({ error: "Not found" }, { status: 404 });
  const body = await req.json();
  const resp = await fetch(`${env.GPTSOVITS_API_ROUTE}/jobs/${jobId}/run-step`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.BACKEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return Response.json(await resp.json(), { status: resp.status });
}
```

- [ ] **Step 6: Create `jobs/[jobId]/upload/route.ts`**

```typescript
// elevenlabs-clone-frontend/src/app/api/voice-lab/gptsovits/jobs/[jobId]/upload/route.ts
import { NextRequest } from "next/server";
import { env } from "~/env";
import { auth } from "~/server/auth";
import { db } from "~/server/db";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const session = await auth();
  if (!session?.user.id) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { jobId } = await params;
  const job = await db.trainingJob.findFirst({ where: { id: jobId, userId: session.user.id } });
  if (!job) return Response.json({ error: "Not found" }, { status: 404 });
  const formData = await req.formData();
  const resp = await fetch(`${env.GPTSOVITS_API_ROUTE}/jobs/${jobId}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.BACKEND_API_KEY}` },
    body: formData,
  });
  return Response.json(await resp.json(), { status: resp.status });
}
```

- [ ] **Step 7: Verify TypeScript compiles**

```bash
cd elevenlabs-clone-frontend
npx tsc --noEmit 2>&1 | grep -E "error|warning" | head -20
```

Expected: No errors related to the new routes.

- [ ] **Step 8: Commit**

```bash
git add elevenlabs-clone-frontend/src/app/api/voice-lab/gptsovits/
git commit -m "feat(frontend): add Next.js proxy routes for gptsovits-api"
```

---

### Task 7: `GptSoVitsWizard` component

**Files:**
- Create: `elevenlabs-clone-frontend/src/components/client/voice-lab/gptsovits-wizard.tsx`

This component mirrors `train-wizard.tsx` in structure — same sidebar/dot pattern, same log console, same SSE hook — but drives the 6-step GPT-SoVITS pipeline.

- [ ] **Step 1: Create `gptsovits-wizard.tsx`**

```typescript
// elevenlabs-clone-frontend/src/components/client/voice-lab/gptsovits-wizard.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  IoAddOutline,
  IoCheckmarkCircle,
  IoChevronForward,
  IoCloudUploadOutline,
  IoEllipseOutline,
  IoMicOutline,
  IoRefreshOutline,
  IoStopCircleOutline,
  IoTrashOutline,
} from "react-icons/io5";
import { getVoiceModels } from "~/actions/voice-lab";
import { useVoiceStore } from "~/stores/voice-store";

// ── WAV encoding helpers (identical to train-wizard.tsx) ──────────────────────

function audioBufferToWav(buf: AudioBuffer): Blob {
  const numCh = buf.numberOfChannels;
  const sr = buf.sampleRate;
  const len = buf.length;
  const ab = new ArrayBuffer(44 + len * numCh * 2);
  const v = new DataView(ab);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF"); v.setUint32(4, 36 + len * numCh * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, numCh, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * numCh * 2, true); v.setUint16(32, numCh * 2, true);
  v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, len * numCh * 2, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, buf.getChannelData(ch)[i]!));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true); off += 2;
    }
  }
  return new Blob([ab], { type: "audio/wav" });
}

async function blobToWavFile(blob: Blob, name: string): Promise<File> {
  const arrayBuf = await blob.arrayBuffer();
  const ctx = new AudioContext();
  const audioBuf = await ctx.decodeAudioData(arrayBuf);
  await ctx.close();
  return new File([audioBufferToWav(audioBuf)], name, { type: "audio/wav" });
}

// ── Status → wizard step mapping ──────────────────────────────────────────────

function statusToStep(status: string): number {
  if (status === "ready" || status === "training_done") return 6;
  if (status.startsWith("train")) return 5;
  if (status === "extracting_done") return 5;
  if (status.startsWith("extract")) return 4;
  if (status === "transcribing_done") return 4;
  if (status.startsWith("transcrib")) return 3;
  return 2;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STEP_LABELS = [
  "Name Your Voice",
  "Upload Audio",
  "Transcribe",
  "Extract Features",
  "Train",
  "Deploy",
];

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "zh", label: "Chinese" },
  { value: "ja", label: "Japanese" },
];

const ACCEPTED_AUDIO_EXTS = [".wav", ".mp3", ".m4a", ".mp4", ".flac", ".ogg", ".webm", ".aac"];

interface JobState { jobId: string; voiceModelId: string; }

// ── Main component ────────────────────────────────────────────────────────────

export function GptSoVitsWizard({
  initialJob,
}: {
  initialJob: {
    id: string;
    voiceModelId: string;
    jobWorkDir: string | null;
    status: string;
    trainingEpochs: number;
    sovitsEpochs: number;
    language: string;
  } | null;
}) {
  const setVoices = useVoiceStore((s) => s.setVoices);

  const [step, setStep] = useState(initialJob ? statusToStep(initialJob.status) : 1);
  const maxStepReached = useRef(initialJob ? statusToStep(initialJob.status) : 1);
  const [serverFiles, setServerFiles] = useState<{ name: string; size: number }[]>([]);
  const [job, setJob] = useState<JobState | null>(
    initialJob ? { jobId: initialJob.id, voiceModelId: initialJob.voiceModelId } : null,
  );

  // Step 1
  const [voiceName, setVoiceName] = useState("");
  const [language, setLanguage] = useState(initialJob?.language ?? "en");
  const [gptEpochs, setGptEpochs] = useState(initialJob?.trainingEpochs ?? 15);
  const [sovitsEpochs, setSovitsEpochs] = useState(initialJob?.sovitsEpochs ?? 8);
  const [creating, setCreating] = useState(false);

  // Step 2
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Steps 3-5 — log console
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [stepDone, setStepDone] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  // Step 6
  const [deployed, setDeployed] = useState(initialJob?.status === "ready");
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  // ── Effects ──────────────────────────────────────────────────────────────────

  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);

  useEffect(() => {
    setLogs([]);
    setRunning(false);
    setStepDone(false);
    setStepError(null);
  }, [step]);

  useEffect(() => {
    if (step === 2 && job) {
      fetch(`/api/voice-lab/gptsovits/jobs/${job.jobId}/audio`)
        .then((r) => r.json())
        .then((d: { files?: { name: string; size: number }[] }) =>
          setServerFiles(d.files ?? []),
        )
        .catch(console.error);
    }
  }, [step, job]);

  // ── Helpers ──────────────────────────────────────────────────────────────────

  const goToStep = useCallback((n: number) => {
    maxStepReached.current = Math.max(maxStepReached.current, n);
    setStep(n);
  }, []);

  const goBack = useCallback(() => {
    if (running) setStepError("A step is still running. Results may be incomplete.");
    esRef.current?.close();
    setRunning(false);
    setStep((s) => s - 1);
  }, [running]);

  const startSSE = useCallback((jobId: string) => {
    esRef.current?.close();
    setLogs((prev) => [...prev, ...(prev.length > 0 ? [""] : [])]);
    setStepDone(false);
    setStepError(null);
    setRunning(true);

    const es = new EventSource(`/api/voice-lab/gptsovits/jobs/${jobId}/logs`);
    esRef.current = es;

    es.onmessage = (evt) => {
      const data = JSON.parse(evt.data) as { type: string; message?: string; status?: string };
      if (data.type === "log" && data.message) {
        setLogs((prev) => [...prev, data.message!]);
      }
      if (data.type === "complete") {
        setRunning(false);
        es.close();
        if (data.status === "failed") {
          setStepError("Step failed — see log output for details.");
        } else {
          setStepDone(true);
        }
      }
    };

    es.onerror = () => { setRunning(false); es.close(); };
  }, []);

  const runStep = useCallback(async (stepName: string) => {
    if (!job) return;
    const resp = await fetch(`/api/voice-lab/gptsovits/jobs/${job.jobId}/run-step`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: stepName }),
    });
    if (!resp.ok) {
      const err = await resp.json() as { detail?: string };
      setLogs((prev) => [...prev, `Error: ${err.detail ?? JSON.stringify(err)}`]);
      return;
    }
    startSSE(job.jobId);
  }, [job, startSSE]);

  // ── Step handlers ─────────────────────────────────────────────────────────────

  const handleCreateJob = async () => {
    if (!voiceName.trim()) return;
    setCreating(true);
    try {
      if (job) {
        await fetch(`/api/voice-lab/gptsovits/jobs/${job.jobId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gptEpochs, sovitsEpochs }),
        });
      } else {
        const resp = await fetch("/api/voice-lab/gptsovits/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voiceName, language, gptEpochs, sovitsEpochs }),
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

  const handleFileSelect = (files: FileList | null) => {
    if (!files) return;
    const audioFiles = Array.from(files).filter((f) =>
      ACCEPTED_AUDIO_EXTS.some((ext) => f.name.toLowerCase().endsWith(ext)),
    );
    setUploadedFiles((prev) => [...prev, ...audioFiles]);
  };

  const handleUploadFiles = async () => {
    if (!job || uploadedFiles.length === 0) {
      goToStep(3);
      return;
    }
    setUploading(true);
    try {
      for (const file of uploadedFiles) {
        const fd = new FormData();
        fd.append("file", file);
        await fetch(`/api/voice-lab/gptsovits/jobs/${job.jobId}/upload`, {
          method: "POST",
          body: fd,
        });
      }
      goToStep(3);
    } catch (e) {
      console.error(e);
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteServerFile = useCallback(
    async (name: string) => {
      setServerFiles((prev) => prev.filter((f) => f.name !== name));
    },
    [],
  );

  const handleDeploy = async () => {
    if (!job) return;
    setDeploying(true);
    setDeployError(null);
    try {
      const resp = await fetch(`/api/voice-lab/gptsovits/jobs/${job.jobId}/run-step`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: "deploy" }),
      });
      if (resp.ok) {
        startSSE(job.jobId);
      } else {
        const data = await resp.json() as { detail?: string };
        setDeployError(data.detail ?? "Deploy failed");
      }
    } catch (e) {
      setDeployError(e instanceof Error ? e.message : "Deploy failed");
    } finally {
      setDeploying(false);
    }
  };

  const handleNewVoice = async () => {
    setResetting(true);
    esRef.current?.close();
    try {
      if (job && !deployed) {
        await fetch(`/api/voice-lab/gptsovits/jobs/${job.jobId}`, { method: "DELETE" });
      }
    } catch (e) {
      console.error(e);
    }
    setJob(null);
    setStep(1);
    setVoiceName("");
    setLanguage("en");
    setGptEpochs(15);
    setSovitsEpochs(8);
    setUploadedFiles([]);
    setServerFiles([]);
    setLogs([]);
    setRunning(false);
    setStepDone(false);
    setStepError(null);
    setDeployed(false);
    setDeployError(null);
    setResetting(false);
  };

  // When deploy SSE completes successfully, mark as deployed and refresh voices
  useEffect(() => {
    if (step === 6 && stepDone && !deployed) {
      setDeployed(true);
      getVoiceModels().then((v) => { if (v.length > 0) setVoices(v); }).catch(console.error);
    }
  }, [step, stepDone, deployed, setVoices]);

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col gap-4 md:flex-row md:gap-6">
      {/* Left stepper */}
      <div className="md:w-52 md:flex-shrink-0">
        <h2 className="mb-3 font-semibold text-gray-900 dark:text-white md:mb-4">GPT-SoVITS</h2>

        {/* Mobile: compact dots */}
        <div className="flex items-center gap-1 overflow-x-auto pb-1 md:hidden">
          {STEP_LABELS.map((label, idx) => {
            const n = idx + 1;
            const done = n < step;
            const active = n === step;
            const clickable = !active && n <= maxStepReached.current;
            return (
              <div
                key={n}
                onClick={() => { if (clickable) setStep(n); }}
                className={`flex flex-shrink-0 flex-col items-center gap-1 ${clickable ? "cursor-pointer" : "cursor-default"}`}
              >
                <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium ${active ? "bg-gray-900 text-white" : done ? "bg-green-500 text-white" : "bg-gray-200 text-gray-400"}`}>
                  {done ? <IoCheckmarkCircle className="h-4 w-4" /> : n}
                </div>
                {active && (
                  <span className="max-w-[56px] text-center text-[10px] leading-tight text-gray-700">{label}</span>
                )}
              </div>
            );
          })}
        </div>

        {/* Desktop: vertical list */}
        <ol className="hidden space-y-1 md:block">
          {STEP_LABELS.map((label, idx) => {
            const n = idx + 1;
            const done = n < step;
            const active = n === step;
            const clickable = !active && n <= maxStepReached.current;
            return (
              <li
                key={n}
                onClick={() => { if (clickable) setStep(n); }}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${active ? "bg-gray-100 font-medium text-gray-900 dark:bg-gray-700 dark:text-white" : done && clickable ? "cursor-pointer text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800" : "cursor-default text-gray-400 dark:text-gray-600"}`}
              >
                {done ? (
                  <IoCheckmarkCircle className="h-4 w-4 text-green-500" />
                ) : (
                  <IoEllipseOutline className={`h-4 w-4 ${active ? "text-gray-700" : "text-gray-300"}`} />
                )}
                {n}. {label}
              </li>
            );
          })}
        </ol>

        {job && (
          <button
            onClick={handleNewVoice}
            disabled={resetting}
            className="mt-3 flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 md:mt-5"
          >
            <IoAddOutline className="h-3.5 w-3.5" />
            {resetting ? "Resetting…" : "New voice"}
          </button>
        )}
      </div>

      {/* Right panel */}
      <div className="min-h-0 flex-1 overflow-auto">
        {step === 1 && (
          <StepName
            voiceName={voiceName}
            setVoiceName={setVoiceName}
            language={language}
            setLanguage={setLanguage}
            gptEpochs={gptEpochs}
            setGptEpochs={setGptEpochs}
            sovitsEpochs={sovitsEpochs}
            setSovitsEpochs={setSovitsEpochs}
            onCreate={handleCreateJob}
            creating={creating}
            hasJob={job !== null}
          />
        )}

        {step === 2 && (
          <StepUpload
            files={uploadedFiles}
            onSelect={handleFileSelect}
            onRemove={(name) => setUploadedFiles((prev) => prev.filter((f) => f.name !== name))}
            onNext={handleUploadFiles}
            uploading={uploading}
            fileInputRef={fileInputRef}
            onAddRecording={(file) => setUploadedFiles((prev) => [...prev, file])}
            onBack={goBack}
            serverFiles={serverFiles}
            onDeleteServerFile={handleDeleteServerFile}
          />
        )}

        {step === 3 && job && (
          <StepLog
            title="Transcribe"
            description="Whisper transcribes your audio and writes inp_text.list in GPT-SoVITS format."
            runLabel="Transcribe"
            logs={logs}
            running={running}
            stepDone={stepDone}
            stepError={stepError}
            onRun={() => runStep("transcribe")}
            onNext={() => goToStep(4)}
            onBack={goBack}
            logsEndRef={logsEndRef}
            wasCompleted={maxStepReached.current > 3}
          />
        )}

        {step === 4 && job && (
          <StepLog
            title="Extract Features"
            description="Runs BERT text processing, HuBERT feature extraction, and semantic token generation (3 scripts)."
            runLabel="Extract Features"
            logs={logs}
            running={running}
            stepDone={stepDone}
            stepError={stepError}
            onRun={() => runStep("features")}
            onNext={() => goToStep(5)}
            onBack={goBack}
            logsEndRef={logsEndRef}
            wasCompleted={maxStepReached.current > 4}
          />
        )}

        {step === 5 && job && (
          <StepLog
            title="Train"
            description={`GPT training then SoVITS training run sequentially. GPT epochs: ${gptEpochs}  SoVITS epochs: ${sovitsEpochs}`}
            runLabel="Start Training"
            logs={logs}
            running={running}
            stepDone={stepDone}
            stepError={stepError}
            onRun={() => runStep("train")}
            onNext={() => goToStep(6)}
            onBack={goBack}
            logsEndRef={logsEndRef}
            wasCompleted={maxStepReached.current > 5}
          />
        )}

        {step === 6 && job && (
          <StepDeploy
            deployed={deployed}
            deploying={deploying}
            running={running}
            stepDone={stepDone}
            logs={logs}
            logsEndRef={logsEndRef}
            stepError={stepError ?? deployError}
            onDeploy={handleDeploy}
            onBack={goBack}
          />
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StepName({
  voiceName, setVoiceName, language, setLanguage,
  gptEpochs, setGptEpochs, sovitsEpochs, setSovitsEpochs,
  onCreate, creating, hasJob,
}: {
  voiceName: string; setVoiceName: (v: string) => void;
  language: string; setLanguage: (v: string) => void;
  gptEpochs: number; setGptEpochs: (v: number) => void;
  sovitsEpochs: number; setSovitsEpochs: (v: number) => void;
  onCreate: () => void; creating: boolean; hasJob: boolean;
}) {
  return (
    <div className="max-w-md space-y-5">
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Voice name</label>
        <input
          type="text"
          value={voiceName}
          onChange={(e) => setVoiceName(e.target.value)}
          placeholder="My Voice"
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-gray-400 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Language</label>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-gray-400 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
        >
          {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
        </select>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
          GPT epochs: {gptEpochs}
        </label>
        <input type="range" min={5} max={50} step={5} value={gptEpochs}
          onChange={(e) => setGptEpochs(Number(e.target.value))} className="w-full" />
        <div className="mt-1 flex justify-between text-xs text-gray-400"><span>5</span><span>50</span></div>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
          SoVITS epochs: {sovitsEpochs}
        </label>
        <input type="range" min={4} max={20} step={2} value={sovitsEpochs}
          onChange={(e) => setSovitsEpochs(Number(e.target.value))} className="w-full" />
        <div className="mt-1 flex justify-between text-xs text-gray-400"><span>4</span><span>20</span></div>
      </div>

      <button
        onClick={onCreate}
        disabled={!voiceName.trim() || creating}
        className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
      >
        {creating ? "Saving…" : hasJob ? "Save & continue" : "Create job"}
        {!creating && <IoChevronForward />}
      </button>
    </div>
  );
}

function MicRecorder({ onRecorded }: { onRecorded: (f: File) => void }) {
  const [recState, setRecState] = useState<"idle" | "recording" | "processing">("idle");
  const [elapsed, setElapsed] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecState("processing");
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        try {
          const file = await blobToWavFile(blob, `recording-${Date.now()}.wav`);
          onRecorded(file);
        } catch (err) { console.error(err); }
        finally { setRecState("idle"); setElapsed(0); }
      };
      mr.start();
      setRecState("recording");
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } catch (err) { console.error("Microphone access denied:", err); }
  };

  const stopRecording = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    mediaRecorderRef.current?.stop();
  };

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
  }, []);

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <div className="flex items-center gap-3">
      {recState === "idle" && (
        <button onClick={startRecording}
          className="flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800">
          <IoMicOutline className="h-4 w-4" /> Record from microphone
        </button>
      )}
      {recState === "recording" && (
        <>
          <span className="flex items-center gap-2 text-sm text-red-600">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />{mm}:{ss}
          </span>
          <button onClick={stopRecording}
            className="flex items-center gap-2 rounded-lg border border-red-300 px-4 py-2 text-sm text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-400">
            <IoStopCircleOutline className="h-4 w-4" /> Stop
          </button>
        </>
      )}
      {recState === "processing" && (
        <span className="flex items-center gap-2 text-sm text-gray-500">
          <IoRefreshOutline className="h-4 w-4 animate-spin" /> Encoding WAV…
        </span>
      )}
    </div>
  );
}

function StepUpload({
  files, onSelect, onRemove, onNext, uploading, fileInputRef, onAddRecording,
  onBack, serverFiles, onDeleteServerFile,
}: {
  files: File[];
  onSelect: (f: FileList | null) => void;
  onRemove: (name: string) => void;
  onNext: () => void;
  uploading: boolean;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onAddRecording: (f: File) => void;
  onBack: () => void;
  serverFiles: { name: string; size: number }[];
  onDeleteServerFile: (name: string) => Promise<void>;
}) {
  const totalMB = files.reduce((s, f) => s + f.size / 1024 / 1024, 0);
  return (
    <div className="max-w-lg space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Upload audio files for training. At least 5 minutes of clean speech is recommended.
      </p>

      {serverFiles.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Already uploaded</p>
          <ul className="space-y-1 text-sm">
            {serverFiles.map((f) => (
              <li key={f.name} className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-800/50">
                <span className="truncate text-gray-700 dark:text-gray-300">{f.name}</span>
                <div className="ml-2 flex items-center gap-3">
                  <span className="text-xs text-gray-400">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
                  <button onClick={() => onDeleteServerFile(f.name)} className="text-gray-400 hover:text-red-500">
                    <IoTrashOutline />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div
        className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-300 px-6 py-10 hover:border-gray-400 dark:border-gray-600 dark:hover:border-gray-500"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); onSelect(e.dataTransfer.files); }}
      >
        <IoCloudUploadOutline className="mb-2 h-8 w-8 text-gray-400" />
        <p className="text-sm text-gray-500">Click or drag audio files here</p>
        <p className="mt-1 text-xs text-gray-400">WAV, MP3, M4A, FLAC, OGG and more — converted automatically</p>
        <input ref={fileInputRef} type="file" accept=".wav,.mp3,.m4a,.mp4,.flac,.ogg,.webm,.aac"
          multiple className="hidden" onChange={(e) => onSelect(e.target.files)} />
      </div>

      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
        <span className="text-xs text-gray-400">or</span>
        <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
      </div>

      <MicRecorder onRecorded={onAddRecording} />

      {files.length > 0 && (
        <ul className="space-y-1 text-sm">
          {files.map((f) => (
            <li key={f.name} className="flex items-center justify-between rounded-lg border border-gray-100 px-3 py-2 dark:border-gray-700">
              <span className="truncate text-gray-700 dark:text-gray-300">{f.name}</span>
              <div className="ml-2 flex items-center gap-3">
                <span className="text-xs text-gray-400">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
                <button onClick={() => onRemove(f.name)} className="text-gray-400 hover:text-red-500">
                  <IoTrashOutline />
                </button>
              </div>
            </li>
          ))}
          <li className="px-3 py-1 text-xs text-gray-400">Total: {totalMB.toFixed(1)} MB</li>
        </ul>
      )}

      <div className="flex items-center gap-3">
        <button onClick={onBack}
          className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800">
          ← Back
        </button>
        <button onClick={onNext} disabled={(files.length === 0 && serverFiles.length === 0) || uploading}
          className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900">
          {uploading ? "Uploading…" : "Upload & continue"}
          {!uploading && <IoChevronForward />}
        </button>
      </div>
    </div>
  );
}

function LogConsole({ logs, logsEndRef }: { logs: string[]; logsEndRef: React.RefObject<HTMLDivElement> }) {
  return (
    <pre className="mt-3 max-h-96 overflow-y-auto rounded-lg bg-gray-900 p-3 text-xs text-green-400 dark:bg-gray-950">
      {logs.length === 0 ? "Waiting for output…" : logs.join("\n")}
      <div ref={logsEndRef} />
    </pre>
  );
}

function StepLog({
  title, description, runLabel, logs, running, stepDone, stepError,
  onRun, onNext, onBack, logsEndRef, wasCompleted,
}: {
  title: string; description: string; runLabel: string;
  logs: string[]; running: boolean; stepDone: boolean; stepError: string | null;
  onRun: () => void; onNext: () => void; onBack: () => void;
  logsEndRef: React.RefObject<HTMLDivElement>; wasCompleted?: boolean;
}) {
  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h3 className="font-medium text-gray-900 dark:text-white">{title}</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{description}</p>
      </div>

      <button
        onClick={onRun}
        disabled={running}
        className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900"
      >
        {running ? (
          <><IoRefreshOutline className="h-4 w-4 animate-spin" /> Running…</>
        ) : wasCompleted ? (
          <>Re-run {runLabel}</>
        ) : (
          <>{runLabel}</>
        )}
      </button>

      {logs.length > 0 && <LogConsole logs={logs} logsEndRef={logsEndRef} />}

      {stepError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          {stepError}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button onClick={onBack}
          className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800">
          ← Back
        </button>
        <button onClick={onNext} disabled={!stepDone && !wasCompleted}
          className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900">
          Continue <IoChevronForward />
        </button>
      </div>
    </div>
  );
}

function StepDeploy({
  deployed, deploying, running, stepDone, logs, logsEndRef, stepError, onDeploy, onBack,
}: {
  deployed: boolean; deploying: boolean; running: boolean; stepDone: boolean;
  logs: string[]; logsEndRef: React.RefObject<HTMLDivElement>;
  stepError: string | null; onDeploy: () => void; onBack: () => void;
}) {
  return (
    <div className="max-w-lg space-y-4">
      <div>
        <h3 className="font-medium text-gray-900 dark:text-white">Deploy</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Copies the trained GPT and SoVITS weights to the voices directory and marks your voice active.
        </p>
      </div>

      {deployed ? (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300">
          Voice deployed successfully.
        </div>
      ) : (
        <button
          onClick={onDeploy}
          disabled={deploying || running}
          className="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900"
        >
          {deploying || running ? (
            <><IoRefreshOutline className="h-4 w-4 animate-spin" /> Deploying…</>
          ) : "Deploy Voice"}
        </button>
      )}

      {logs.length > 0 && <LogConsole logs={logs} logsEndRef={logsEndRef} />}

      {stepError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          {stepError}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button onClick={onBack}
          className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800">
          ← Back
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd elevenlabs-clone-frontend
npx tsc --noEmit 2>&1 | grep "error" | head -20
```

Expected: No errors in `gptsovits-wizard.tsx`.

- [ ] **Step 3: Commit**

```bash
git add elevenlabs-clone-frontend/src/components/client/voice-lab/gptsovits-wizard.tsx
git commit -m "feat(frontend): add GptSoVitsWizard component"
```

---

### Task 8: `BackendSelector` component + train page update

**Files:**
- Create: `elevenlabs-clone-frontend/src/components/client/voice-lab/backend-selector.tsx`
- Modify: `elevenlabs-clone-frontend/src/app/app/voice-lab/train/page.tsx`

- [ ] **Step 1: Create `backend-selector.tsx`**

```typescript
// elevenlabs-clone-frontend/src/components/client/voice-lab/backend-selector.tsx
"use client";

import { useState } from "react";
import { TrainWizard } from "./train-wizard";
import { GptSoVitsWizard } from "./gptsovits-wizard";

type StyleTTS2Job = {
  id: string; voiceModelId: string; jobWorkDir: string | null;
  status: string; trainingEpochs: number;
} | null;

type GptSoVitsJob = {
  id: string; voiceModelId: string; jobWorkDir: string | null;
  status: string; trainingEpochs: number; sovitsEpochs: number; language: string;
} | null;

export function BackendSelector({
  styletts2Job,
  gptsovitsJob,
}: {
  styletts2Job: StyleTTS2Job;
  gptsovitsJob: GptSoVitsJob;
}) {
  const [selected, setSelected] = useState<"styletts2" | "gptsovits" | null>(
    styletts2Job ? "styletts2" : gptsovitsJob ? "gptsovits" : null,
  );

  if (!selected) {
    return (
      <div className="flex flex-col items-start gap-6 p-4 sm:flex-row sm:items-stretch">
        <button
          onClick={() => setSelected("styletts2")}
          className="flex w-full flex-col gap-2 rounded-xl border-2 border-gray-200 p-6 text-left hover:border-gray-400 hover:bg-gray-50 dark:border-gray-700 dark:hover:border-gray-500 dark:hover:bg-gray-800 sm:w-64"
        >
          <span className="text-base font-semibold text-gray-900 dark:text-white">StyleTTS2</span>
          <span className="text-sm text-gray-500 dark:text-gray-400">
            Fast fine-tuning · English focused · Established pipeline
          </span>
        </button>

        <button
          onClick={() => setSelected("gptsovits")}
          className="flex w-full flex-col gap-2 rounded-xl border-2 border-gray-200 p-6 text-left hover:border-gray-400 hover:bg-gray-50 dark:border-gray-700 dark:hover:border-gray-500 dark:hover:bg-gray-800 sm:w-64"
        >
          <span className="text-base font-semibold text-gray-900 dark:text-white">GPT-SoVITS v2</span>
          <span className="text-sm text-gray-500 dark:text-gray-400">
            High-quality · Multilingual · GPT semantic tokens + VITS vocoder
          </span>
        </button>
      </div>
    );
  }

  if (selected === "gptsovits") {
    return <GptSoVitsWizard initialJob={gptsovitsJob} />;
  }

  return <TrainWizard initialJob={styletts2Job} />;
}
```

- [ ] **Step 2: Update `train/page.tsx` to use `BackendSelector`**

Replace the full contents of `elevenlabs-clone-frontend/src/app/app/voice-lab/train/page.tsx`:

```typescript
import { PageLayout } from "~/components/client/page-layout";
import { getActiveTrainingJob } from "~/actions/voice-lab";
import { BackendSelector } from "~/components/client/voice-lab/backend-selector";

export default async function TrainPage() {
  const job = await getActiveTrainingJob();
  const service = job?.voiceModel?.service;

  const styletts2Job =
    service === "styletts2"
      ? {
          id: job!.id,
          voiceModelId: job!.voiceModelId,
          jobWorkDir: job!.jobWorkDir,
          status: job!.status,
          trainingEpochs: job!.trainingEpochs,
        }
      : null;

  const gptsovitsJob =
    service === "gptsovits"
      ? {
          id: job!.id,
          voiceModelId: job!.voiceModelId,
          jobWorkDir: job!.jobWorkDir,
          status: job!.status,
          trainingEpochs: job!.trainingEpochs,
          sovitsEpochs: job!.sovitsEpochs ?? 8,
          language: job!.language ?? "en",
        }
      : null;

  return (
    <PageLayout title="Train Voice" service="styletts2" showSidebar={false}>
      <BackendSelector styletts2Job={styletts2Job} gptsovitsJob={gptsovitsJob} />
    </PageLayout>
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles with no errors**

```bash
cd elevenlabs-clone-frontend
npx tsc --noEmit 2>&1 | grep "error" | head -20
```

Expected: No errors.

- [ ] **Step 4: Start dev server and verify the page renders**

```bash
cd elevenlabs-clone-frontend
npm run dev
```

Open `http://localhost:3000/app/voice-lab/train` in a browser.

Expected:
- Two cards appear: "StyleTTS2" and "GPT-SoVITS v2"
- Clicking "StyleTTS2" renders the existing 7-step wizard
- Clicking "GPT-SoVITS v2" renders the 6-step GPT-SoVITS wizard with sidebar labels: Name Your Voice, Upload Audio, Transcribe, Extract Features, Train, Deploy

- [ ] **Step 5: Commit**

```bash
git add elevenlabs-clone-frontend/src/components/client/voice-lab/backend-selector.tsx \
        elevenlabs-clone-frontend/src/app/app/voice-lab/train/page.tsx
git commit -m "feat(frontend): add BackendSelector and wire GPT-SoVITS wizard into train page"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Covered by |
|---|---|
| New isolated `gptsovits-api` service | Task 3 |
| Shares SQLite DB via volume | Task 5 (docker-compose volumes) |
| SSE log streaming | Task 3 (`/logs` endpoint + EventSourceResponse) |
| PATCH gptEpochs/sovitsEpochs | Task 3 (PATCH endpoint), Task 6 (proxy) |
| DELETE | Task 3, Task 6 |
| `sovitsEpochs` schema field | Task 1 |
| Dockerfile | Task 3 |
| Docker service (port 8105) | Task 5 |
| `env.GPTSOVITS_API_ROUTE` | Task 5 |
| 6 proxy route files | Task 6 |
| Backend selector (two cards) | Task 8 |
| `GptSoVitsWizard` (6 steps) | Task 7 |
| Back navigation + clickable sidebar | Task 7 (goBack, maxStepReached) |
| Server files on step 2 | Task 7 (useEffect fetches audio on step 2) |
| Train page wired to selector | Task 8 |
| Download script | Task 4 |
| TDD for backend | Task 2 (failing tests) → Task 3 (implementation) |
| Transcription → inp_text.list format | Task 3 (`_run_transcribe`) |
| Feature extraction (3 scripts) | Task 3 (`_run_features`) |
| GPT + SoVITS chained training | Task 3 (`_run_training`) |
| Deploy copies weights | Task 3 (`_run_deploy`) |

**No placeholders found.**

**Type consistency:** `gptEpochs` → `trainingEpochs` column (PATCH maps correctly). `sovitsEpochs` → `sovitsEpochs` column. `startSSE` called with `job.jobId` in all step handlers. `runStep("transcribe" | "features" | "train" | "deploy")` matches backend step names.
