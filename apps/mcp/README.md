# `@neuromem/mcp`

A dependency-free Node.js 20+ adapter that exposes eight memory tools and routes them to one or more Core REST nodes.

## Configuration

The Node-local direct mode is selected first when any direct variable is present. It requires all three values and fails closed when the Core token is absent:

```text
NEUROMEM_NODE_ID=<node UUID>
NEUROMEM_CORE_URL=http://core:8000
NEUROMEM_CORE_TOKEN=<Core bearer token>
```

Router mode uses `NEUROMEM_NODES_JSON`, which accepts either a node array:

```json
[
  { "id": "personal", "base_url": "http://127.0.0.1:18001", "token": "..." },
  { "id": "company", "base_url": "http://127.0.0.1:28001", "token": "..." }
]
```

or an object containing `nodes`, `default_read_targets`, `default_write_targets`, `state_dir`, `request_timeout_ms`, `rrf_k`, and `retry_interval_ms`. Every configured node requires a Core token of at least 32 bytes. The two-node shorthand uses `NEUROMEM_PERSONAL_URL`, `NEUROMEM_PERSONAL_TOKEN`, `NEUROMEM_COMPANY_URL`, and `NEUROMEM_COMPANY_TOKEN`.

Each Router node may define `scope_map`, keyed by the caller's logical `project_id`, with a node-local `{ "workspace_id", "project_id" }`. Writes and reads translate per node while results retain both `logical_scope` and `origin_scope`. Missing mappings keep the caller IDs unchanged.

Core requests time out after 120 seconds and responses are capped at 64 MiB by default. Override these with `NEUROMEM_REQUEST_TIMEOUT_MS` and `NEUROMEM_CORE_MAX_RESPONSE_BYTES`.

Defaults intentionally select only `personal` when it exists, otherwise the first configured node. Set `target` to `personal`, `company`, or `both`, or configure defaults at the Router.

## Tool and REST contract

| Tool | Core REST call |
|---|---|
| `memory_record` | `POST /v1/records:batch` |
| `search_records` | `POST /v1/recall`, `include=["records"]` |
| `search_claims` | `POST /v1/recall`, `include=["claims"]` |
| `recall` | `POST /v1/recall`, `include=["records","claims"]` |
| `get_record_context` | `GET /v1/records/:record_id/context?workspace_id&project_id` |
| `get_claim_evidence` | `GET /v1/claims/:claim_id/evidence?workspace_id&project_id` |
| `wiki_read` | `GET /v1/projects/:project_id/wiki?workspace_id&project_id` |
| `graph_read` | `GET /v1/projects/:project_id/graph?workspace_id&project_id` |

Every tool requires `workspace_id` and `project_id`. `memory_record` additionally requires a UUIDv7 `session_id`, `author_key`, explicit `author_kind`, and `content`. It accepts an optional caller UUIDv7 `record_id` or an `idempotency_key`; otherwise it creates a UUIDv7. The same record ID is sent as `id` and `Idempotency-Key` to every selected node. Its Core body is exactly `{ "workspace_id": UUID, "project_id": UUID, "session_id": UUID, "records": [RecordInput] }`.

On the first batch 404, `memory_record` attempts one idempotent session creation and retries the same record ID. Project absence and session-scope conflicts preserve the original permanent 404; transient creation failures remain queued. Idempotency keys are hashed and scoped by logical workspace/project/session. Entries retain active pending writes, otherwise expire after 30 days and are limited to 10,000 per namespace.

HTTP 408, 425, 429, HTTP 5xx, timeouts, and network failures remain pending. Other HTTP 4xx responses are permanent failures. Pending writes retry automatically when the process starts and on a timer. Queue entries contain only routing and retry metadata keyed by `(record_id, target_node)`. The request body and its frozen target scope are stored once in a private record spool until every pending delivery is resolved. Tokens are never persisted.

Federated reads run in parallel and use reciprocal-rank fusion with `k=60`, a default limit of 10, and a public maximum of 50. Replicas merge across nodes only by `record_id` or `claim_id`; node-local `result_id` and no-ID content remain distinct. Every returned item contains `origin_node`.

Recall responses preserve Core `embedding_used` and top-level `record_snippets`. Each record hit carries a resolvable lightweight `record_snippet` reference and a bounded local `context_records` window; claims remain separate `memory_kind=claim` results. Structured results are capped below 1 MiB. Tool TextContent contains a recursive JSON preview capped at 16 KiB without embeddings, vectors, blobs, or binary payloads.

## Run

```sh
npm run build
neuromem-mcp
```

`npm start` runs Streamable HTTP on `HOST` (code default `127.0.0.1`; the container explicitly sets `0.0.0.0`) and `PORT` (default `3001`). `/mcp` requires `Authorization: Bearer $NEUROMEM_MCP_TOKEN` with a token of at least 16 bytes, creates an `Mcp-Session-Id` during `initialize`, and accepts `tools/list`, `tools/call`, `ping`, initialized notifications, deletion, and post-initialization JSON-RPC batches of at most 32 items. Notification-only batches return HTTP 202 without a body. Host and browser Origin checks permit loopback only. `/health` is a body-free liveness endpoint. Incoming JSON is capped at 5 MiB by default (`NEUROMEM_MCP_MAX_BODY_BYTES`).

`neuromem-mcp` remains the stdio executable for newline-delimited JSON-RPC 2.0. `neuromem-mcp-http` starts the HTTP transport.
