FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY pyproject.toml alembic.ini ./
COPY alembic ./alembic
COPY neuromem_core ./neuromem_core
RUN pip install --no-cache-dir .

RUN addgroup --system neuromem \
    && adduser --system --ingroup neuromem --home /home/neuromem neuromem \
    && chown -R neuromem:neuromem /app

EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2).read()"
USER neuromem
ENTRYPOINT ["python", "-m", "neuromem_core.entrypoint"]
CMD ["api"]
