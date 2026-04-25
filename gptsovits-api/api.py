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
