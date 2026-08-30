# Neuromem

Neuromem is a source-grounded memory engine for people and AI agents. It stores immutable records first, derives explicit claims asynchronously, and keeps every derived view traceable to its source.

## Repository layout

- `apps/core` — FastAPI data API and durable workers
- `apps/manager` — local Node Manager and `neuromem` CLI
- `apps/mcp` — direct Node MCP adapter and multi-node router
- `apps/web` — memory application and local administration UI
- `deploy` — parameterized container deployment
- `tests` — cross-service contract and end-to-end tests

## Development

Requirements:

- Node.js 20+
- Python 3.12+
- Docker with Compose

Install JavaScript dependencies:

```sh
npm install
```

Install the Core in a virtual environment:

```sh
python3 -m venv .venv
.venv/bin/pip install -e 'apps/core[dev]'
```

Run unit tests:

```sh
npm test
.venv/bin/pytest apps/core/tests
```

Start an isolated development Node:

```sh
cp deploy/nodes/personal.env.example deploy/nodes/personal.env
docker compose -p neuromem-personal --env-file deploy/nodes/personal.env -f deploy/compose.yaml up --build
```

The default local endpoints are:

- Memory app: `http://127.0.0.1:14173`
- Core API: `http://127.0.0.1:18001`
- MCP: `http://127.0.0.1:18765/mcp`

PostgreSQL is not published to the host.

## Run the local product

The npm package is not published by this repository. Build and install the local
tarball for an end-to-end installation test:

```sh
npm install
npm run build
npm pack --workspace neuromem
npm install -g ./neuromem-0.1.0.tgz
```

Docker is required. An OpenAI-compatible model endpoint is optional for raw
record storage but required for embeddings, Claims, Wiki, and Graph. With the
models already available in local Ollama, start the default Personal Node with:

```sh
EMBEDDING_BASE_URL=http://host.docker.internal:11434/v1 \
EMBEDDING_API_KEY=ollama \
EMBEDDING_MODEL=qwen3-embedding:4b \
GENERATION_BASE_URL=http://host.docker.internal:11434/v1 \
GENERATION_API_KEY=ollama \
GENERATION_MODEL=gpt-oss:20b \
neuromem
```

The explicit `neuromem` command prepares missing local runtime images, starts
the whole Node, checks it, and opens `/app`. Package installation itself does
not change host services.

Useful commands:

```sh
neuromem node status
neuromem node logs
neuromem node backup create
neuromem admin open
neuromem node mcp-config --format toml
neuromem skill path
```

`/app` is the memory product. `/admin` remains available from the host-side
Manager even when the database or Core API is unavailable. Restore and schema
migration apply operations are CLI-only.
