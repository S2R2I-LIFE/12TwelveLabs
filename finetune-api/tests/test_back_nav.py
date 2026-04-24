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
