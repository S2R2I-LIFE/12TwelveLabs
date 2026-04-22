# FastAPI Backend — SQLite, Background Tasks, SSE Streaming

## Project: `finetune-api/api.py`

This service manages training jobs: creates them, runs pipeline steps as background tasks, and streams logs via SSE.

## SQLite Direct Access (no ORM)

The backend accesses the same SQLite database as the Next.js frontend (Prisma):

```python
import sqlite3

DB_PATH = os.environ.get("DB_PATH", "/prisma-data/db.sqlite")

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row  # allows dict-like access: row["field"]
    return conn

def db_fetchone(sql, params=()):
    conn = get_db()
    try:
        return conn.execute(sql, params).fetchone()
    finally:
        conn.close()

def db_execute(sql, params=()):
    conn = get_db()
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()
```

**Key:** Prisma uses camelCase column names (e.g., `jobWorkDir`, `batchSize`). Query these exactly.

## Background Task Pattern

FastAPI's `BackgroundTasks` runs functions after the response is sent:

```python
from fastapi import BackgroundTasks

@app.post("/jobs/{job_id}/run-step")
async def run_step(job_id: str, body: RunStepRequest, background_tasks: BackgroundTasks):
    background_tasks.add_task(_run_step_task, job_id, body.step)
    return {"status": "started"}

def _run_step_task(job_id: str, step: str):
    log_path = os.path.join(get_job_dir(job_id), "logs", "current_step.log")
    with open(log_path, "w") as log_file:
        proc = subprocess.Popen(
            ["python", "script.py", "--arg", "value"],
            stdout=log_file,
            stderr=subprocess.STDOUT,
            cwd=work_dir,
        )
        proc.wait()
    # update DB status after completion
    db_execute("UPDATE TrainingJob SET status=? WHERE id=?", ("step_done", job_id))
```

## SSE Log Streaming

Server-Sent Events let the browser receive a live stream of log lines without WebSockets:

```python
from fastapi.responses import StreamingResponse
import asyncio, aiofiles

@app.get("/jobs/{job_id}/logs")
async def stream_logs(job_id: str):
    log_path = os.path.join(get_job_dir(job_id), "logs", "current_step.log")

    async def event_generator():
        async with aiofiles.open(log_path, "r") as f:
            while True:
                line = await f.readline()
                if line:
                    yield f"data: {line.rstrip()}\n\n"
                else:
                    # Check if process has exited
                    status = db_fetchone("SELECT status FROM TrainingJob WHERE id=?", (job_id,))
                    if status and status["status"].endswith("_done"):
                        break
                    await asyncio.sleep(0.2)

    return StreamingResponse(event_generator(), media_type="text/event-stream")
```

**Client-side (React):**
```typescript
const es = new EventSource(`/api/voice-lab/jobs/${jobId}/logs`);
es.onmessage = (e) => setLogs(prev => [...prev, e.data]);
es.onerror = () => es.close();
```

## API Proxy Pattern (Next.js → FastAPI)

Next.js API routes proxy to the Python backend, adding auth:

```typescript
// src/app/api/voice-lab/jobs/[jobId]/logs/route.ts
export async function GET(req: Request, { params }: { params: { jobId: string } }) {
  const upstream = await fetch(
    `${env.FINETUNE_API_ROUTE}/jobs/${params.jobId}/logs`,
    { headers: { "X-API-Key": env.BACKEND_API_KEY } }
  );
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
```

## File Upload (multipart → disk)

```python
from fastapi import UploadFile, File
import aiofiles

@app.post("/jobs/{job_id}/upload")
async def upload_audio(job_id: str, files: list[UploadFile] = File(...)):
    audio_dir = os.path.join(get_job_dir(job_id), "audio")
    os.makedirs(audio_dir, exist_ok=True)
    
    for f in files:
        dest = os.path.join(audio_dir, f.filename)
        async with aiofiles.open(dest, "wb") as out:
            content = await f.read()
            await out.write(content)
    
    return {"uploaded": [f.filename for f in files]}
```

## Environment and Startup

```python
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: re-register all active voices from DB
    rows = db_fetchall("SELECT * FROM VoiceModel WHERE isActive=1")
    for row in rows:
        await register_voice_with_styletts2(row)
    yield
    # Shutdown cleanup if needed

app = FastAPI(lifespan=lifespan)
```

## API Key Auth

```python
from fastapi import Security, HTTPException
from fastapi.security import APIKeyHeader

api_key_header = APIKeyHeader(name="X-API-Key")

def verify_api_key(key: str = Security(api_key_header)):
    if key != os.environ["API_KEY"]:
        raise HTTPException(status_code=403, detail="Invalid API key")
    return key

# Use as dependency:
@app.get("/protected", dependencies=[Depends(verify_api_key)])
```

## Patching External Scripts at Runtime

When a vendored script has a bug you can't fix in the source:

```python
import shutil, re

# Copy script to job dir
shutil.copy("/FineTune/phonemized.py", job_dir)
patched_path = os.path.join(job_dir, "phonemized.py")

with open(patched_path) as f:
    content = f.read()

# Patch the buggy sort key
content = content.replace(
    'key=lambda x: int(x[0].split("_")[1].split(".")[0])',
    'key=lambda x: int(x[0].rsplit("_", 1)[1].split(".")[0])',
)

with open(patched_path, "w") as f:
    f.write(content)

# Run the patched version
subprocess.run(["python", patched_path, "--language", lang], ...)
```
