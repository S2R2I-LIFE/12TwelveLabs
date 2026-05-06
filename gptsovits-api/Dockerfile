FROM xxxxrt666/gpt-sovits:latest-cu126
WORKDIR /gptsovits-api
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN /root/conda/bin/pip install --no-cache-dir --force-reinstall --no-deps --index-url https://download.pytorch.org/whl/cu126 "torchaudio==2.10.0"
COPY api.py .
CMD ["uvicorn", "api:app", "--host", "0.0.0.0", "--port", "8000"]
