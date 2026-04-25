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
