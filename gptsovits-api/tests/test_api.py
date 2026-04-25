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
