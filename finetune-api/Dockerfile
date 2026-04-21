FROM pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime

WORKDIR /app

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

RUN apt-get update && apt-get install -y \
    build-essential \
    git \
    python3-dev \
    libsndfile1 \
    espeak-ng \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt
# monotonic_align is a Cython extension (must be compiled for the target Python version)
RUN pip install git+https://github.com/resemble-ai/monotonic_align.git
# wavlm / SLM model download cache buster — ensure transformers is imported at build time
RUN python3 -c "import transformers; import matplotlib; import monotonic_align" 2>/dev/null || true

COPY api.py .

ENV PYTHONPATH=/app
ENV WORKSPACE=/workspace

EXPOSE 8000

CMD ["uvicorn", "api:app", "--host", "0.0.0.0", "--port", "8000"]
