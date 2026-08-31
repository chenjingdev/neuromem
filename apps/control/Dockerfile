FROM python:3.12-slim

WORKDIR /app
COPY pyproject.toml README.md ./
COPY neuromem_control ./neuromem_control
RUN pip install --no-cache-dir .

EXPOSE 8090
CMD ["neuromem-control"]

