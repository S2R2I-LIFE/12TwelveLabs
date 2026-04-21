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
import requests
import yaml
from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── Config ─────────────────────────────────────────────────────────────────────
API_KEY = os.getenv("API_KEY", "")
WORKSPACE = os.getenv("WORKSPACE", "/workspace")
STYLETTS2_PATH = os.getenv("STYLETTS2_PATH", "/StyleTTS2")
FINETUNE_SCRIPTS = os.getenv("FINETUNE_SCRIPTS_PATH", "/FineTune")
STYLETTS2_API_URL = os.getenv("STYLETTS2_API_URL", "http://styletts2-api:8000")
DB_PATH = os.getenv("DB_PATH", "/db.sqlite")

JOBS_DIR = os.path.join(WORKSPACE, "jobs")
VOICES_DIR = os.path.join(WORKSPACE, "voices")

GRADIENT_COLORS = [
    "linear-gradient(45deg, #8b5cf6, #ec4899, #ffffff, #3b82f6)",
    "linear-gradient(45deg, #3b82f6, #10b981, #ffffff, #f59e0b)",
    "linear-gradient(45deg, #ec4899, #f97316, #ffffff, #8b5cf6)",
    "linear-gradient(45deg, #10b981, #3b82f6, #ffffff, #f43f5e)",
    "linear-gradient(45deg, #f43f5e, #f59e0b, #ffffff, #10b981)",
]

# Track running subprocesses per job
running_procs: dict[str, subprocess.Popen] = {}


# Notebooks to seed into /workspace/notebooks/ on startup (source → dest filename)
NOTEBOOKS_DIR = os.path.join(WORKSPACE, "notebooks")
SEED_NOTEBOOKS = [
    (os.path.join(FINETUNE_SCRIPTS, "curate.ipynb"),                                   "01_curate_dataset.ipynb"),
    (os.path.join(FINETUNE_SCRIPTS, "PhonemeCoverage.ipynb"),                          "02_phoneme_coverage.ipynb"),
    (os.path.join(FINETUNE_SCRIPTS, "makeDataset/tools/other_options/PhonemeCoverage.ipynb"), "02b_phoneme_coverage_alt.ipynb"),
    (os.path.join(STYLETTS2_PATH,   "Colab/StyleTTS2_Finetune_Demo.ipynb"),            "03_finetune_demo.ipynb"),
    (os.path.join(STYLETTS2_PATH,   "Demo/Inference_LibriTTS.ipynb"),                  "04_inference_libritts.ipynb"),
    (os.path.join(STYLETTS2_PATH,   "Colab/StyleTTS2_Demo_LibriTTS.ipynb"),            "05_demo_libritts.ipynb"),
    (os.path.join(STYLETTS2_PATH,   "Colab/StyleTTS2_Demo_LJSpeech.ipynb"),            "06_demo_ljspeech.ipynb"),
    (os.path.join(STYLETTS2_PATH,   "Demo/Inference_LJSpeech.ipynb"),                  "07_inference_ljspeech.ipynb"),
]


# ── Startup ─────────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(JOBS_DIR, exist_ok=True)
    os.makedirs(VOICES_DIR, exist_ok=True)

    # Seed reference notebooks into the shared workspace (skips if already present)
    os.makedirs(NOTEBOOKS_DIR, exist_ok=True)
    for src, dest_name in SEED_NOTEBOOKS:
        dest = os.path.join(NOTEBOOKS_DIR, dest_name)
        if not os.path.exists(dest) and os.path.exists(src):
            try:
                shutil.copy2(src, dest)
                # Make readable/writable by all (jovyan in jupyterlab container)
                os.chmod(dest, 0o666)
                logger.info(f"Seeded notebook: {dest_name}")
            except Exception as e:
                logger.warning(f"Could not seed notebook {dest_name}: {e}")

    # Also ensure the notebooks dir itself is world-writable so jupyterlab can save
    try:
        os.chmod(NOTEBOOKS_DIR, 0o777)
    except Exception:
        pass

    yield


app = FastAPI(title="Fine-Tune API", lifespan=lifespan)


# ── Auth ────────────────────────────────────────────────────────────────────────
async def verify_api_key(authorization: str = Header(None)):
    if not authorization:
        raise HTTPException(status_code=401, detail="API key missing")
    token = authorization.replace("Bearer ", "") if authorization.startswith("Bearer ") else authorization
    if API_KEY and token != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return token


# ── DB helpers ──────────────────────────────────────────────────────────────────
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


def db_fetchall(sql: str, params: tuple = ()):
    conn = _db_connect()
    try:
        rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ── Models ──────────────────────────────────────────────────────────────────────
class CreateJobRequest(BaseModel):
    voiceName: str
    language: str = "en-us"
    trainingEpochs: int = 75
    batchSize: int = 2
    userId: str


class RunStepRequest(BaseModel):
    step: str


class CurateRequest(BaseModel):
    excludeFiles: list[str]


class DeployRequest(BaseModel):
    userId: str


# ── Helpers ─────────────────────────────────────────────────────────────────────
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
    db_execute(f"UPDATE TrainingJob SET {', '.join(parts)}, updatedAt = datetime('now') WHERE id = ?", tuple(vals))


def generate_config(job_id: str, epochs: int, batch_size: int) -> str:
    jd = job_dir(job_id)
    data_dir = os.path.join(jd, "trainingdata")
    wavs_dir = os.path.join(jd, "segmentedAudio")

    # Load the reference config as a base so all required sections are present
    ref_config_path = os.path.join(STYLETTS2_PATH, "Models", "LibriTTS", "config_ft.yml")
    with open(ref_config_path) as f:
        config = yaml.safe_load(f)

    # Override only the job-specific fields
    config["log_dir"] = f"{jd}/Models"
    config["save_freq"] = 10
    config["epochs"] = epochs
    config["batch_size"] = batch_size
    config["pretrained_model"] = f"{STYLETTS2_PATH}/Models/LibriTTS/epochs_2nd_00020.pth"
    config["second_stage_load_pretrained"] = True
    config["load_only_params"] = True
    config["F0_path"] = f"{STYLETTS2_PATH}/Utils/JDC/bst.t7"
    config["ASR_config"] = f"{STYLETTS2_PATH}/Utils/ASR/config.yml"
    config["ASR_path"] = f"{STYLETTS2_PATH}/Utils/ASR/epoch_00080.pth"
    config["PLBERT_dir"] = f"{STYLETTS2_PATH}/Utils/PLBERT/"
    config["data_params"] = {
        "train_data": f"{data_dir}/train_list.txt",
        "val_data": f"{data_dir}/val_list.txt",
        "root_path": wavs_dir,
        "OOD_data": f"{STYLETTS2_PATH}/Data/OOD_texts.txt",
        "min_length": 10,  # low threshold for fine-tuning with small datasets
    }

    config_dir = os.path.join(jd, "Configs")
    os.makedirs(config_dir, exist_ok=True)
    config_path = os.path.join(config_dir, "config_ft.yml")
    with open(config_path, "w") as f:
        yaml.dump(config, f)
    return config_path


async def run_subprocess_step(job_id: str, cmd: list[str], cwd: str, step_name: str, step_num: int, extra_env: dict = None):
    jd = job_dir(job_id)
    os.makedirs(os.path.join(jd, "logs"), exist_ok=True)
    log_file = log_path(job_id)

    update_job_status(job_id, step_name, step=step_num)

    try:
        with open(log_file, "w") as lf:
            lf.write(f"[finetune-api] Starting step: {step_name}\n")
            lf.write(f"[finetune-api] Command: {' '.join(cmd)}\n")
            lf.flush()

            env = {**os.environ, "PYTHONUNBUFFERED": "1"}
            if extra_env:
                env.update(extra_env)
            proc = subprocess.Popen(
                cmd,
                cwd=cwd,
                stdout=lf,
                stderr=subprocess.STDOUT,
                env=env,
            )
            running_procs[job_id] = proc
    except (FileNotFoundError, PermissionError) as exc:
        with open(log_file, "a") as lf:
            lf.write(f"\n[finetune-api] ERROR: Could not launch command: {exc}\n")
            lf.write(f"[finetune-api] Command was: {' '.join(cmd)}\n")
        update_job_status(job_id, "failed", error=f"Could not launch {step_name}: {exc}")
        return

    loop = asyncio.get_event_loop()
    return_code = await loop.run_in_executor(None, proc.wait)
    running_procs.pop(job_id, None)

    with open(log_file, "a") as lf:
        lf.write(f"\n[finetune-api] Step {step_name} finished with exit code {return_code}\n")

    if return_code != 0:
        update_job_status(job_id, "failed", error=f"Step {step_name} failed (exit {return_code})")
    else:
        update_job_status(job_id, f"{step_name}_done")


# ── Endpoints ───────────────────────────────────────────────────────────────────

@app.post("/jobs", dependencies=[Depends(verify_api_key)])
async def create_job(req: CreateJobRequest):
    job_id = str(uuid.uuid4())
    voice_id = f"voice-{uuid.uuid4().hex[:8]}"
    jd = job_dir(job_id)

    for sub in ["audio", "srt", "segmentedAudio", "badAudio", "trainingdata", "logs", "Configs", "Models"]:
        os.makedirs(os.path.join(jd, sub), exist_ok=True)

    gradient = GRADIENT_COLORS[hash(req.voiceName) % len(GRADIENT_COLORS)]

    # Create VoiceModel
    db_execute(
        "INSERT INTO VoiceModel (id, userId, name, voiceId, service, gradientColors, isActive, createdAt, updatedAt) "
        "VALUES (?, ?, ?, ?, 'styletts2', ?, 0, datetime('now'), datetime('now'))",
        (voice_id, req.userId, req.voiceName, voice_id, gradient),
    )

    # Create TrainingJob
    db_execute(
        "INSERT INTO TrainingJob (id, userId, voiceModelId, status, currentStep, jobWorkDir, "
        "trainingEpochs, batchSize, language, createdAt, updatedAt) "
        "VALUES (?, ?, ?, 'uploading', 0, ?, ?, ?, ?, datetime('now'), datetime('now'))",
        (job_id, req.userId, voice_id, jd, req.trainingEpochs, req.batchSize, req.language),
    )

    return {"jobId": job_id, "voiceModelId": voice_id, "workDir": jd}


@app.post("/jobs/{job_id}/upload", dependencies=[Depends(verify_api_key)])
async def upload_audio(job_id: str, file: UploadFile):
    audio_dir = os.path.join(job_dir(job_id), "audio")
    if not os.path.exists(audio_dir):
        raise HTTPException(status_code=404, detail="Job not found")

    dest = os.path.join(audio_dir, file.filename)
    async with aiofiles.open(dest, "wb") as f:
        content = await file.read()
        await f.write(content)

    update_job_status(job_id, "uploading")
    return {"filename": file.filename, "size": len(content)}


@app.post("/jobs/{job_id}/run-step", dependencies=[Depends(verify_api_key)])
async def run_step(job_id: str, req: RunStepRequest, background_tasks: BackgroundTasks):
    jd = job_dir(job_id)
    if not os.path.exists(jd):
        raise HTTPException(status_code=404, detail="Job not found")

    job = db_fetchone("SELECT * FROM TrainingJob WHERE id = ?", (job_id,))
    if not job:
        raise HTTPException(status_code=404, detail="Job not found in DB")

    step = req.step

    if step == "silence-buffer":
        script_src = os.path.join(FINETUNE_SCRIPTS, "makeDataset/tools/silencebuffer.py")
        script_dst = os.path.join(jd, "silencebuffer.py")
        shutil.copy(script_src, script_dst)
        cmd = ["python", "silencebuffer.py"]
        background_tasks.add_task(run_subprocess_step, job_id, cmd, jd, "preprocessing", 1)

    elif step == "transcribe":
        audio_files = glob.glob(os.path.join(jd, "audio", "*.wav"))
        if not audio_files:
            raise HTTPException(status_code=400, detail="No WAV files uploaded")
        language = job.get("language", "en-us")
        background_tasks.add_task(_run_transcription, job_id, audio_files, language, jd)

    elif step == "segment":
        script_src = os.path.join(FINETUNE_SCRIPTS, "makeDataset/tools/srtsegmenter.py")
        script_dst = os.path.join(jd, "srtsegmenter.py")
        shutil.copy(script_src, script_dst)
        cmd = ["python", "srtsegmenter.py"]
        background_tasks.add_task(run_subprocess_step, job_id, cmd, jd, "segmenting", 3)

    elif step == "add-padding":
        script_src = os.path.join(FINETUNE_SCRIPTS, "makeDataset/tools/add_padding.py")
        script_dst = os.path.join(jd, "add_padding.py")
        shutil.copy(script_src, script_dst)
        # Patch paths in the script
        with open(script_dst) as f:
            content = f.read()
        content = content.replace("source_dir = 'path/to/segmentedAudio/folder'",
                                  f"source_dir = '{os.path.join(jd, 'segmentedAudio')}'")
        content = content.replace("target_dir = 'path/to/paddedAudio/folder'",
                                  f"target_dir = '{os.path.join(jd, 'paddedAudio')}'")
        with open(script_dst, "w") as f:
            f.write(content)
        cmd = ["python", "add_padding.py"]
        background_tasks.add_task(run_subprocess_step, job_id, cmd, jd, "preprocessing", 2)

    elif step == "phonemize":
        script_src = os.path.join(FINETUNE_SCRIPTS, "makeDataset/tools/phonemized.py")
        script_dst = os.path.join(jd, "phonemized.py")
        shutil.copy(script_src, script_dst)
        language = job.get("language", "en-us")
        cmd = ["python", "phonemized.py", "--language", language]
        background_tasks.add_task(_run_phonemize, job_id, cmd, jd)

    elif step == "train":
        config_path = generate_config(job_id, job["trainingEpochs"], job["batchSize"])
        train_script = os.path.join(STYLETTS2_PATH, "train_finetune_accelerate.py")
        # Copy training scripts to job dir so relative imports work
        for fname in ["train_finetune_accelerate.py", "train_finetune.py", "models.py",
                      "utils.py", "losses.py", "meldataset.py", "optimizers.py", "text_utils.py"]:
            src = os.path.join(STYLETTS2_PATH, fname)
            if os.path.exists(src):
                shutil.copy(src, os.path.join(jd, fname))
        for dname in ["Modules"]:
            src = os.path.join(STYLETTS2_PATH, dname)
            dst = os.path.join(jd, dname)
            if os.path.exists(src) and not os.path.exists(dst):
                shutil.copytree(src, dst)
        cmd = ["accelerate", "launch", "--mixed_precision=fp16", "--num_processes=1",
               "train_finetune_accelerate.py", "--config_path", config_path]
        # PYTHONPATH must include StyleTTS2 root so `from Utils.ASR.models import ...` resolves
        train_env = {"PYTHONPATH": STYLETTS2_PATH}
        background_tasks.add_task(run_subprocess_step, job_id, cmd, jd, "training", 6, extra_env=train_env)

    else:
        raise HTTPException(status_code=400, detail=f"Unknown step: {step}")

    return {"accepted": True, "step": step}


async def _run_phonemize(job_id: str, cmd: list[str], jd: str):
    """Run phonemized.py then guarantee train_list.txt is non-empty.

    When there are very few clips the phonemizer's train/val split can leave
    train_list.txt completely empty, which makes training fail immediately.
    If that happens we copy val_list.txt into train_list.txt so at least one
    example is available.
    """
    await run_subprocess_step(job_id, cmd, jd, "phonemizing", 5)

    data_dir = os.path.join(jd, "trainingdata")
    train_list = os.path.join(data_dir, "train_list.txt")
    val_list   = os.path.join(data_dir, "val_list.txt")

    log_file = log_path(job_id)
    if (os.path.exists(train_list) and os.path.getsize(train_list) == 0
            and os.path.exists(val_list) and os.path.getsize(val_list) > 0):
        shutil.copy(val_list, train_list)
        with open(log_file, "a") as lf:
            lf.write(
                "[finetune-api] train_list.txt was empty — "
                "copied val_list.txt so training has at least one example.\n"
            )


def _fmt_ts(t: float) -> str:
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    ms = int((t % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


async def _run_transcription(job_id: str, audio_files: list[str], language: str, cwd: str):
    jd = job_dir(job_id)
    os.makedirs(os.path.join(jd, "logs"), exist_ok=True)
    log_file = log_path(job_id)
    update_job_status(job_id, "transcribing", step=2)

    with open(log_file, "w") as lf:
        lf.write("[finetune-api] Starting transcription with faster-whisper (large-v3)\n")
        lf.flush()
        try:
            import torch
            from faster_whisper import WhisperModel

            device = "cuda" if torch.cuda.is_available() else "cpu"
            compute_type = "float16" if device == "cuda" else "int8"
            lf.write(f"[finetune-api] Loading model on {device} ({compute_type})...\n")
            lf.flush()

            model = WhisperModel("large-v3", device=device, compute_type=compute_type)
            srt_dir = os.path.join(jd, "srt")
            lang_code = language.split("-")[0]  # "en-us" -> "en"

            for audio_path in audio_files:
                audio_name = os.path.splitext(os.path.basename(audio_path))[0]
                lf.write(f"[finetune-api] Transcribing: {os.path.basename(audio_path)}\n")
                lf.flush()

                segments, _info = model.transcribe(
                    audio_path,
                    beam_size=5,
                    language=lang_code,
                    vad_filter=True,
                    condition_on_previous_text=True,
                )

                srt_path = os.path.join(srt_dir, f"{audio_name}.srt")
                count = 0
                with open(srt_path, "w", encoding="utf-8") as sf:
                    for i, seg in enumerate(segments, start=1):
                        sf.write(
                            f"{i}\n"
                            f"{_fmt_ts(seg.start)} --> {_fmt_ts(seg.end)}\n"
                            f"{seg.text.strip()}\n\n"
                        )
                        lf.write(f"  [{seg.start:.1f}s] {seg.text.strip()}\n")
                        lf.flush()
                        count += 1

                lf.write(f"[finetune-api] Wrote {count} segments to {audio_name}.srt\n")
                lf.flush()

            lf.write("\n[finetune-api] Transcription complete\n")
        except Exception as e:
            import traceback as tb
            lf.write(f"\n[finetune-api] Transcription failed: {e}\n{tb.format_exc()}\n")
            update_job_status(job_id, "failed", error=f"Transcription failed: {e}")
            return

    update_job_status(job_id, "transcribing_done", step=2)


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


@app.get("/jobs/{job_id}/status", dependencies=[Depends(verify_api_key)])
async def get_job_status(job_id: str):
    job = db_fetchone("SELECT * FROM TrainingJob WHERE id = ?", (job_id,))
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.get("/jobs/{job_id}/dataset-preview", dependencies=[Depends(verify_api_key)])
async def dataset_preview(job_id: str):
    jd = job_dir(job_id)
    output_txt = os.path.join(jd, "trainingdata", "output.txt")

    clips = []
    seen_filenames: set[str] = set()
    if os.path.exists(output_txt):
        with open(output_txt) as f:
            for line in f:
                parts = line.strip().split("|")
                if len(parts) >= 2 and parts[0] not in seen_filenames:
                    filename = parts[0]
                    seen_filenames.add(filename)
                    transcription = parts[1]
                    wav_path = os.path.join(jd, "segmentedAudio", filename)
                    duration = 0.0
                    if os.path.exists(wav_path):
                        try:
                            from pydub import AudioSegment
                            audio = AudioSegment.from_wav(wav_path)
                            duration = len(audio) / 1000.0
                        except Exception:
                            pass
                    clips.append({"filename": filename, "transcription": transcription, "duration": duration})

    return {"clips": clips, "total": len(clips)}


@app.post("/jobs/{job_id}/curate", dependencies=[Depends(verify_api_key)])
async def curate_dataset(job_id: str, req: CurateRequest):
    jd = job_dir(job_id)
    segmented_dir = os.path.join(jd, "segmentedAudio")
    bad_dir = os.path.join(jd, "badAudio")
    output_txt = os.path.join(jd, "trainingdata", "output.txt")
    os.makedirs(bad_dir, exist_ok=True)

    moved = []
    for filename in req.excludeFiles:
        src = os.path.join(segmented_dir, filename)
        if os.path.exists(src):
            shutil.move(src, os.path.join(bad_dir, filename))
            moved.append(filename)

    # Regenerate output.txt without excluded files
    if os.path.exists(output_txt):
        with open(output_txt) as f:
            lines = f.readlines()
        kept = [l for l in lines if not any(exc in l for exc in req.excludeFiles)]
        with open(output_txt, "w") as f:
            f.writelines(kept)

    return {"moved": moved, "remaining": len(kept) if os.path.exists(output_txt) else 0}


@app.post("/jobs/{job_id}/deploy", dependencies=[Depends(verify_api_key)])
async def deploy_voice(job_id: str, req: DeployRequest):
    jd = job_dir(job_id)
    job = db_fetchone("SELECT * FROM TrainingJob WHERE id = ?", (job_id,))
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    voice_model = db_fetchone("SELECT * FROM VoiceModel WHERE id = ?", (job["voiceModelId"],))
    if not voice_model:
        raise HTTPException(status_code=404, detail="Voice model not found")

    # Find best checkpoint
    model_dir = os.path.join(jd, "Models")
    checkpoints = sorted(glob.glob(os.path.join(model_dir, "**", "epoch_2nd_*.pth"), recursive=True))
    if not checkpoints:
        checkpoints = sorted(glob.glob(os.path.join(model_dir, "**", "*.pth"), recursive=True))
    if not checkpoints:
        raise HTTPException(status_code=400, detail="No checkpoint found. Has training completed?")

    best_checkpoint = checkpoints[-1]

    # Find a reference audio clip
    audio_files = glob.glob(os.path.join(jd, "segmentedAudio", "*.wav"))
    if not audio_files:
        audio_files = glob.glob(os.path.join(jd, "audio", "*.wav"))
    if not audio_files:
        raise HTTPException(status_code=400, detail="No audio files found for reference")

    # Copy to voices dir
    voice_id = voice_model["voiceId"]
    voice_out_dir = os.path.join(VOICES_DIR, voice_id)
    os.makedirs(voice_out_dir, exist_ok=True)

    checkpoint_dest = os.path.join(voice_out_dir, "checkpoint.pth")
    reference_dest = os.path.join(voice_out_dir, "reference.wav")
    shutil.copy(best_checkpoint, checkpoint_dest)
    shutil.copy(audio_files[0], reference_dest)

    # Register with styletts2-api
    try:
        resp = requests.post(
            f"{STYLETTS2_API_URL}/admin/register-voice",
            json={
                "voiceId": voice_id,
                "voiceName": voice_model["name"],
                "checkpointPath": checkpoint_dest,
                "referenceAudioPath": reference_dest,
            },
            headers={"Authorization": API_KEY},
            timeout=30,
        )
        resp.raise_for_status()
    except Exception as e:
        logger.warning(f"Could not register voice with styletts2-api: {e}")

    # Mark voice as active in DB
    db_execute(
        "UPDATE VoiceModel SET isActive = 1, checkpointPath = ?, referenceAudioPath = ?, updatedAt = datetime('now') WHERE id = ?",
        (checkpoint_dest, reference_dest, voice_model["id"]),
    )
    db_execute(
        "UPDATE TrainingJob SET status = 'ready', updatedAt = datetime('now') WHERE id = ?",
        (job_id,),
    )

    return {"voiceId": voice_id, "voiceName": voice_model["name"], "checkpointPath": checkpoint_dest}


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


@app.get("/voices", dependencies=[Depends(verify_api_key)])
async def list_voices():
    voices = db_fetchall("SELECT * FROM VoiceModel WHERE isActive = 1")
    return {"voices": voices}
