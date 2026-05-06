# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Self-hosted ElevenLabs clone. Multiple GPU-backed AI model services behind a Next.js frontend. All services are containerized and orchestrated via `docker-compose.yml`.

| Service | Port | Purpose |
|---|---|---|
| frontend | 3001 | Next.js 15 (T3 stack) |
| styletts2-api | 8100 | Text-to-speech (StyleTTS2) |
| seedvc-api | 8101 | Voice conversion (Seed-VC) |
| make-an-audio-api | 8102 | Sound effect generation |
| finetune-api | 8103 | StyleTTS2 voice fine-tuning |
| jupyterlab | 8104 | Notebook workspace |
| gptsovits-api | 8105 | GPT-SoVITS voice training |
| inngest | 8288 | Job queue dev server |

---

## Commands

### Frontend (`elevenlabs-clone-frontend/`)

```bash
npm run dev          # dev server on :3001 (Turbopack)
npm run build
npm run check        # lint + typecheck together
npm run typecheck    # tsc --noEmit only
npm run lint:fix
npm run format:write

npm run db:push      # apply schema without migration (dev)
npm run db:generate  # prisma migrate dev (creates migration file)
npm run db:migrate   # prisma migrate deploy (prod)
npm run db:studio    # Prisma Studio GUI

npm run inngest-dev  # local Inngest dev server (separate terminal)
```

### Python backends (`finetune-api/`, `gptsovits-api/`)

```bash
# Run all tests
cd finetune-api && pytest
cd gptsovits-api && pytest

# Run a single test file
cd finetune-api && pytest tests/test_back_nav.py

# Run a single test by name
cd gptsovits-api && pytest tests/test_api.py::test_create_job
```

### Docker (full stack)

```bash
docker compose up --build   # build and start all services
docker compose up frontend  # start single service
```

---

## Architecture

### Frontend — Next.js 15 (T3 stack)

**Environment validation** — `src/env.js` uses `@t3-oss/env-nextjs`. Every env var (backend URLs, S3 config, API key) is declared and validated at build time. Adding a new backend env var requires updating `env.js`, not just `.env`.

**Auth** — NextAuth v5, credentials-only (email + bcrypt password), JWT sessions. Config in `src/server/auth/config.ts`. Middleware at `src/middleware.ts` gates all `/app/*` routes except sign-in/sign-up.

**Database** — Prisma with SQLite at `elevenlabs-clone-frontend/prisma/db.sqlite`. Key models: `User`, `VoiceModel`, `TrainingJob`, `GeneratedAudioClip`.

**Audio generation flow:**
1. Server action (`src/actions/generate-speech.ts`) creates a `GeneratedAudioClip` record, fires an `inngest` event.
2. Inngest function (`src/inngest/functions.ts`) throttles at 3 requests/min/user, calls the appropriate AI backend, saves the returned S3 key back to the DB.
3. Client polls `generationStatus()` server action until `s3Key` is set.

**Voice training flow (StyleTTS2):**
- Multi-step wizard: `src/components/client/voice-lab/train-wizard.tsx`
- Next.js routes at `/api/voice-lab/jobs/[jobId]/...` proxy to `finetune-api`
- SSE log streaming via `/api/voice-lab/jobs/[jobId]/logs`

**Voice training flow (GPT-SoVITS):**
- Wizard: `src/components/client/voice-lab/gptsovits-wizard.tsx`
- Backend selected via `backend-selector.tsx` on the train page
- Routes at `/api/voice-lab/gptsovits/jobs/[jobId]/...` proxy to `gptsovits-api`

**State management** — Zustand stores in `src/stores/`:
- `voice-store.ts` — all voices (base Seed-VC voices + custom trained voices), selected voice per service; hydrated server-side by `VoiceStoreInitializer`
- `audio-store.ts` — playback state
- `ui-store.ts` — sidebar/UI state

### Python backends

Both `finetune-api/api.py` and `gptsovits-api/api.py` follow the same pattern:
- Single FastAPI `api.py` per service
- Bearer token auth via `BACKEND_API_KEY` env var
- Long-running training steps launched as subprocesses tracked in `running_procs: dict[str, Popen]`
- SSE log streaming via `sse-starlette`
- Read/write the shared SQLite DB directly with `sqlite3` (same file as Prisma — no ORM)

### Shared volume

The `finetune_workspace` Docker volume is mounted in `finetune-api`, `gptsovits-api`, and `jupyterlab`. Training artifacts, model checkpoints, and uploaded audio all live here.

### S3

All generated audio is stored in S3 (`b-gpt-elevenlabs-clone` bucket). Backends upload output and return an `s3_key`. Frontend generates presigned URLs for playback via `src/lib/s3.ts`.

---

## Key constraints

- The Python backends write directly to the Prisma SQLite file using raw `sqlite3`. Schema changes in `prisma/schema.prisma` must stay compatible with the column names used in both `finetune-api/api.py` and `gptsovits-api/api.py`.
- Adding new backend service routes requires: new Next.js proxy route, new env var in `src/env.js`, update `.env`/`.env.example`, update `docker-compose.yml`.
- The Inngest throttle (3/min/user) is the primary mechanism protecting GPU backends from overload — don't bypass it with direct fetch calls from server actions.
