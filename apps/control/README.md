# Neuromem Control Plane

Apache-2.0 control service for one physical Neuromem Node. A Node is one
monolithic installation on a Mac, DGX Spark, or another server. Each Node owns
many isolated Workspaces, and each Workspace owns many Projects. The Control
service manages identities, sharing, Human/Agent Peer bindings, credentials,
two-sided transfers, and cited Project Wikis without writing directly to the
Memory Core database.

## Run locally

```bash
cp .env.example .env
uv sync --extra dev
uv run neuromem-control-init
uv run neuromem-control
```

Use `sqlite:///./neuromem-control.db` and
`NEUROMEM_CONTROL_AUTO_CREATE_SCHEMA=true` only for development. Production uses a
dedicated PostgreSQL database via `postgresql+psycopg://...`; initialize it once
with `neuromem-control-init`.

All product routes live under `/api/v1`. OpenAPI is available at
`/openapi.json` and interactive documentation at `/docs`.

Authentication accepts a one-time-returned API/MCP credential through
`Authorization: Bearer ...` or an HttpOnly Web session cookie. Select scope with:

```text
X-Neuromem-Workspace: <workspace UUIDv7>
X-Neuromem-Project: <project UUIDv7>  # required for project memory/Wiki access
```

`GET /api/v1/workspaces` lists every local Workspace the Principal belongs to.
`POST /api/v1/workspaces/{workspace_id}:select` validates a Workspace switch and
returns its active Projects plus the resulting authorization context. Selection
remains request-scoped; the server does not hide global mutable "current
Workspace" state in a session.

## Workspace sharing

Workspaces are isolated by default. An Owner can propose a directional,
read-only memory projection with `POST /api/v1/workspace-shares`; an Owner of the
recipient Workspace must explicitly approve it. Admins cannot approve on behalf
of Owners. Either side's Owner can revoke the share immediately.

`display_mode=workspace` projects the owner's current active Projects grouped
under its Workspace. `display_mode=projects` requires an explicit `project_ids`
list and lets the recipient UI show only those Projects. Approved incoming
projections are available from `GET /api/v1/workspace-projections`. Shared
memory is searched only when callers opt in with `include_federated=true`, and
revocation removes both the projection and search access.

The Control Plane mints 60-second HMAC-signed internal context tokens at
`POST /api/v1/internal-context-tokens`. A Memory Core adapter verifies that token
instead of trusting client-supplied Workspace, Project, or Peer identifiers.

Configure the bounded gateway with `NEUROMEM_CONTROL_MEMORY_CORE_URL`. Every Core
request carries `Authorization: Internal nmic1.<payload>.<signature>`; clients never
receive the Core address or signing key.

## Memory Gateway

The Node gateway is available under `/api/v1/memory`; compatibility aliases
used by Neuromem MCP are also exposed:

| Gateway route | Core v3.1 route |
| --- | --- |
| `POST /memory/projects/{id}:ensure` | `POST /v3/workspaces/{w}/projects` |
| `POST /memory/sessions` | `POST /v3/workspaces/{w}/sessions?project_id=...` |
| `POST /records:batch` | `POST /v3/workspaces/{w}/sessions/{s}/messages?project_id=...` |
| `POST /recall` | workspace/session search plus conclusion query |
| `POST /memory/conclusions` | conclusion list/query |
| `GET /peers/{p}/representation` | project-aware peer representation |
| `GET /peers/{p}/card` | project-aware peer card |
| `GET /sessions/{s}/context` | project-aware session context |
| `POST /chat` | project-aware Dialectic chat |
| `POST /dreams` | project-aware Dream scheduling |
| `POST /context` | local Wiki → representation → relevant local/federated sources |

Dynamic Context uses a conservative UTF-8 token estimate and never writes search or
federated results. A federated search receives a separately signed, read-only source
scope only after an active link, grant, and assignment are verified.

The current Core contract does not provide a project-safe record-context lookup from
a record ID alone, direct claim-evidence expansion, or an ontology graph. Therefore
`/records/{id}/context`, `/claims/{id}/evidence`, and `/projects/{id}/graph` are not
fabricated by this service. Project-aware representation/card/context/chat/Dream
require the Neuromem v3.1 Core patch to honor `project_id` and `include_general`.

## Security invariants

- A Principal is an authentication subject; a Peer is a memory identity.
- Every Workspace membership has its own canonical Human Peer.
- Agent credentials are server-bound to an Agent Peer and cannot choose an author.
- The last active Workspace Owner cannot be removed or demoted.
- Restricted Projects require an explicit grant for non-admin members.
- Workspaces share no memory until both Workspace Owners approve a share.
- A shared Workspace can be grouped as a Workspace or flattened to Projects.
- Either Workspace Owner can revoke projected memory access immediately.
- Workspace links grant no access by themselves; Project grants require both sides.
- A transfer requires source approval, target approval, and a separate import result.
- Wiki revisions require local Message/Conclusion citations. Federated memory must be
  explicitly transferred before it can become local Wiki knowledge.

The root repository's Apache License 2.0 applies to this package.
