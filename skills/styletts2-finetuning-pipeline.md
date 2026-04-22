# StyleTTS2 Fine-Tuning Pipeline

## Overview
The fine-tuning pipeline takes raw WAV audio, processes it through several steps, and produces a checkpoint that can be hot-loaded into the running StyleTTS2 API without rebuilding Docker.

## Pipeline Steps (in order)

```
audio/ (uploaded WAVs)
  → silence-buffer (optional)  silencebuffer.py
  → transcribe                  whisperx → srt/
  → segment                     srtsegmenter.py → segmentedAudio/ + trainingdata/output.txt
  → add-padding                 add_padding.py
  → phonemize                   phonemized.py → train_list.txt + val_list.txt
  → train                       accelerate launch train_finetune_accelerate.py
  → deploy                      copy checkpoint + call /admin/register-voice
```

## Job Work Directory Structure

```
/workspace/jobs/{id}/
  audio/            ← uploaded WAVs
  srt/              ← WhisperX transcription output
  segmentedAudio/   ← srtsegmenter output clips
  trainingdata/
    output.txt      ← "path|speaker|text" lines
    train_list.txt  ← 90% split (after phonemize)
    val_list.txt    ← 10% split (after phonemize)
  Configs/
    config_ft.yml   ← generated from base config with absolute paths injected
  logs/
    current_step.log ← tailed by SSE endpoint
```

## Common Errors and Fixes

### `steps_per_epoch = 0`
**Cause:** Small dataset → 90/10 split → `drop_last=True` + batch_size=2 → 0 full batches.

**Fix in `generate_config()`:**
```python
with open(train_list_path) as f:
    train_lines = [l for l in f.readlines() if l.strip()]

# Bootstrap from val if train is empty
if len(train_lines) == 0 and os.path.exists(val_list_path):
    with open(val_list_path) as f:
        train_lines = [l for l in f.readlines() if l.strip()]
    with open(train_list_path, "w") as f:
        f.writelines(train_lines)

# Duplicate entries until we reach batch_size
if 0 < len(train_lines) < batch_size:
    original = train_lines[:]
    while len(train_lines) < batch_size:
        train_lines += original
    with open(train_list_path, "w") as f:
        f.writelines(train_lines)

# Clamp batch_size to actual count
if len(train_lines) > 0:
    batch_size = min(batch_size, len(train_lines))
config["batch_size"] = batch_size
```

Also replicate this in `_run_phonemize()` immediately after building train_list.txt, before returning.

### `IndexError: Dimension out of range (expected [-1, 0], got 1)`
**File:** `StyleTTS2/train_finetune_accelerate.py`  
**Cause:** `.squeeze()` with no args removes ALL size-1 dimensions — including the batch dim when `batch_size=1`.

**Fix:** Change `.squeeze()` to `.squeeze(1)` in the training loop (~line 340) and validation loop (~line 659):
```python
# Before (broken with batch_size=1)
s_dur = torch.stack(ss).squeeze()
gs = torch.stack(gs).squeeze()

# After (safe)
s_dur = torch.stack(ss).squeeze(1)
gs = torch.stack(gs).squeeze(1)
```

### `phonemized.py` sort key crash with custom filenames
**Cause:** Sort key uses `x[0].split("_")[1]` which assumes `word_N.wav` format. Custom recordings may use different naming like `recording-1234567890_0.wav`.

**Fix in `finetune-api/api.py`** — patch the copied file before running:
```python
phonemize_content = phonemize_content.replace(
    'key=lambda x: int(x[0].split("_")[1].split(".")[0])',
    'key=lambda x: int(x[0].rsplit("_", 1)[1].split(".")[0])',
)
```

## config_ft.yml Generation

The config must inject absolute job-specific paths. Key fields to override from the base config:

```python
config["data"]["train_data"] = train_list_path   # absolute path
config["data"]["val_data"] = val_list_path         # absolute path
config["data"]["root_path"] = audio_dir            # segmentedAudio/
config["loss_params"]["diff_epoch"] = epochs
config["loss_params"]["joint_epoch"] = epochs // 2
config["batch_size"] = batch_size
config["epochs"] = epochs
config["log_dir"] = os.path.join(job_dir, "logs")
config["save_dir"] = os.path.join(job_dir, "checkpoints")
config["pretrained_model"] = "/StyleTTS2/Models/LJSpeech/epoch_2nd_00100.pth"
config["model_params"]["OnnxExport"] = False
```

## Hot-Loading Voices (no Docker rebuild)

`POST /admin/register-voice` on the StyleTTS2 API adds a voice to the in-memory `TARGET_VOICES` dict at runtime:

```python
@app.post("/admin/register-voice")
async def register_voice(req: RegisterVoiceRequest, api_key: str = Depends(verify_api_key)):
    TARGET_VOICES[req.voiceId] = {
        "name": req.voiceName,
        "checkpoint": req.checkpointPath,
        "ref_audio": req.referenceAudioPath,
    }
    return {"status": "ok"}
```

On startup (lifespan), re-register active voices from the database so they survive container restarts.

## Language Support

The phonemizer language flag maps to espeak-ng locales:
- `en-us` → English (US)
- `en-gb` → English (UK)  
- `de` → German
- `fr-fr` → French
- `es` → Spanish
- `zh` → Chinese (Mandarin)

Pass via `phonemized.py --language <lang>`.
