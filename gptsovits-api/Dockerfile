FROM xxxxrt666/gpt-sovits:latest-cu126
WORKDIR /gptsovits-api
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY api.py .
CMD ["uvicorn", "api:app", "--host", "0.0.0.0", "--port", "8000"]
