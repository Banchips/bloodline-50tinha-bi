FROM python:3.12-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    BLOODLINE_DB=/data/bloodline.db \
    BLOODLINE_COOKIE_SECURE=1

COPY . /app
EXPOSE 8000
CMD ["python", "cloud_start.py"]
