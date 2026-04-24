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
