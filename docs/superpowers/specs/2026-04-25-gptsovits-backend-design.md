# GPT-SoVITS Parallel Backend Design

**Goal:** Add GPT-SoVITS v2 as a fully isolated parallel training backend alongside StyleTTS2, with its own wizard UI, FastAPI service, and Docker container.

**Architecture:** A new `gptsovits-api` FastAPI service runs inside the `xxxxrt666/gpt-sovits:latest-cu126` Docker image and shares the existing SQLite DB via volume mount. A new `GptSoVitsWizard` React component handles the GPT-SoVITS-specific pipeline steps with SSE log streaming. A backend selector on the Voice Lab page routes users to either the existing `TrainWizard` (StyleTTS2) or the new `GptSoVitsWizard`.

**Tech Stack:** GPT-SoVITS v2, FastAPI, Python, PyTorch Lightning, React, Next.js App Router, SQLite, Docker, SSE, Whisper (transcription), HuBERT (feature extraction).

---

## 1. Architecture Overview

```
Voice Lab page
├── Backend selector (StyleTTS2 | GPT-SoVITS)
│
├── StyleTTS2 selected → TrainWizard (existing, unchanged)
│     calls /api/voice-lab/jobs/*  →  finetune-api (port 8103)
│
└── GPT-SoVITS selected → GptSoVitsWizard (new)
      calls /api/voice-lab/gptsovits/*  →  gptsovits-api (port 8105)
```

The two backends are completely isolated:
- Separate Docker containers with separate Python environments
- Separate Next.js proxy route namespaces
- Separate React wizard components
- Shared SQLite DB (discriminated by `VoiceModel.service` field)
- Shared `finetune_workspace` Docker volume for job working directories

Resuming an existing voice model uses `VoiceModel.service` to determine which wizard to render — no selector shown on resume.

---

## 2. `gptsovits-api` FastAPI Service

### Directory structure

```
gptsovits-api/
├── api.py          # FastAPI application
├── Dockerfile      # extends xxxxrt666/gpt-sovits:latest-cu126
└── requirements.txt
```

`requirements.txt` is minimal (fastapi, uvicorn) — all ML dependencies are already present in the base image.

### Pipeline steps

| Step key | What runs |
|----------|-----------|
| `transcribe` | Whisper on each uploaded WAV → writes `inp_text.list` (`filename\|speaker\|lang\|text`) |
| `features` | `1-get-text.py` → `2-get-hubert-wav32k.py` → `3-get-semantic.py` sequentially |
| `train-gpt` | `GPT_SoVITS/s1_train.py` with GPT epoch count from job |
| `train-sovits` | `GPT_SoVITS/s2_train.py` with SoVITS epoch count from job |
| `deploy` | Copies final `.ckpt` and `.pth` weights to named output folder under `/workspace/output/{job_id}/` |

Each step streams stdout/stderr to the client via SSE, exactly matching the `finetune-api` pattern.

### API endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/jobs` | Create job + VoiceModel (`service='gptsovits'`) |
| GET | `/jobs/{job_id}/status` | Job status and current step |
| GET | `/jobs/{job_id}/audio` | List uploaded WAV files |
| GET | `/jobs/{job_id}/run/{step}` | SSE stream: run a pipeline step |
| PATCH | `/jobs/{job_id}` | Update `gptEpochs` / `sovitsEpochs` |
| DELETE | `/jobs/{job_id}` | Delete job and working directory |

All endpoints require `Authorization: Bearer <API_KEY>` header.

### Job working directory layout

```
/workspace/jobs/{job_id}/
├── audio/              # uploaded WAV files
├── inp_text.list       # Whisper transcription output
├── features/           # dataset prep outputs (BERT, HuBERT, semantic)
├── logs/               # per-step log files
└── output/
    ├── gpt/            # s1_train checkpoints
    └── sovits/         # s2_train checkpoints
```

### Dockerfile

```dockerfile
FROM xxxxrt666/gpt-sovits:latest-cu126
WORKDIR /gptsovits-api
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY api.py .
CMD ["uvicorn", "api:app", "--host", "0.0.0.0", "--port", "8000"]
```

---

## 3. Database Schema Changes

One new field on `TrainingJob` in `schema.prisma`:

```prisma
model TrainingJob {
  // ... all existing fields unchanged ...
  trainingEpochs  Int  @default(75)   // reused: GPT stage epochs for GPT-SoVITS jobs
  batchSize       Int  @default(2)    // reused: GPT stage batch size
  sovitsEpochs    Int  @default(8)    // NEW: SoVITS stage epochs
}
```

`VoiceModel.service` already exists. GPT-SoVITS jobs write `service = 'gptsovits'`.

A Prisma migration adds the `sovitsEpochs` column with default 8.

---

## 4. Frontend Changes

### Backend selector

Added to the Voice Lab page as two clickable cards shown before any wizard opens:

```
┌─────────────────────┐  ┌─────────────────────┐
│     StyleTTS2       │  │    GPT-SoVITS        │
│  Fast fine-tuning   │  │  High-quality v2     │
│  English focused    │  │  Multilingual        │
└─────────────────────┘  └─────────────────────┘
```

State: `selectedBackend: 'styletts2' | 'gptsovits' | null`. When non-null, renders the corresponding wizard. When resuming an existing voice, `VoiceModel.service` sets the backend directly (no selector shown).

### `GptSoVitsWizard` component

New file: `elevenlabs-clone-frontend/src/components/client/voice-lab/gptsovits-wizard.tsx`

**Wizard steps:**

| # | Step | Key controls |
|---|------|-------------|
| 1 | Name Voice | Name text input, language dropdown (en / zh / ja) |
| 2 | Upload Audio | Reuses existing upload component, accepts all audio formats |
| 3 | Transcribe | Run button → SSE log window |
| 4 | Extract Features | Run button → SSE log window (3 scripts run sequentially in one stream) |
| 5 | Train | GPT epochs slider + SoVITS epochs slider, Run button → SSE log window |
| 6 | Deploy | Run button → SSE log window, shows output weight paths on completion |

- Back navigation, clickable sidebar, and log-streaming window work identically to `TrainWizard`.
- Sidebar shows 6 steps with GPT-SoVITS-specific labels.
- `maxStepReached` ref tracks the furthest step for sidebar clickability.

### Next.js proxy routes

New directory: `elevenlabs-clone-frontend/src/app/api/voice-lab/gptsovits/`

```
gptsovits/
├── jobs/
│   └── route.ts              # POST /jobs
└── jobs/[jobId]/
    ├── route.ts              # GET status, PATCH, DELETE
    ├── audio/
    │   └── route.ts          # GET audio list
    └── run/[step]/
        └── route.ts          # GET SSE stream
```

Each route mirrors the existing `/api/voice-lab/jobs/` routes but forwards to `GPTSOVITS_API_ROUTE` (env var pointing to `http://gptsovits-api:8000`).

---

## 5. Docker Setup

### Addition to `docker-compose.yml`

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

### Frontend environment

Add to `docker-compose.yml` frontend service environment:
```yaml
- GPTSOVITS_API_ROUTE=http://gptsovits-api:8000
```

Add to `elevenlabs-clone-frontend/.env.example`:
```
GPTSOVITS_API_ROUTE=http://gptsovits-api:8000
```

### Pretrained models download script

`scripts/download_gptsovits_models.sh` — idempotent, skips files that already exist.

Downloads into `GPT-SoVITS/GPT_SoVITS/pretrained_models/`:

| File | Source | Size |
|------|--------|------|
| `s1v3.ckpt` | `lj1995/GPT-SoVITS` on Hugging Face | ~100 MB |
| `s2G2333k.pth` | `lj1995/GPT-SoVITS` on Hugging Face | ~300 MB |
| `s2D2333k.pth` | `lj1995/GPT-SoVITS` on Hugging Face | ~400 MB |
| `chinese-hubert-base/` (dir) | `TencentGameMate/chinese-hubert-base` on Hugging Face | ~400 MB |

Run once before starting the `gptsovits-api` container:
```bash
bash scripts/download_gptsovits_models.sh
```

---

## 6. Testing

- **`gptsovits-api/tests/`** — pytest suite mirroring `finetune-api/tests/`, covering: job creation, status, audio listing, PATCH, DELETE, and each run-step endpoint (mocked subprocess)
- **Manual E2E** — full wizard run with a short audio clip, verifying SSE streams, back navigation, and trained weight files appearing in the output directory
