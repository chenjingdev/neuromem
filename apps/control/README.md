# Neuromem Control Plane

Apache-2.0 service for sovereign Workspaces, nested Projects, Human/Agent Peer
bindings, credentials, federation, two-sided transfers, and cited Project Wikis.
It is an independent team/control boundary and never writes to a live Memory Core
database.

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

The Control Plane mints 60-second HMAC-signed internal context tokens at
`POST /api/v1/internal-context-tokens`. A Memory Core adapter verifies that token
instead of trusting client-supplied Workspace, Project, or Peer identifiers.

## Security invariants

- A Principal is an authentication subject; a Peer is a memory identity.
- Every Workspace membership has its own canonical Human Peer.
- Agent credentials are server-bound to an Agent Peer and cannot choose an author.
- The last active Workspace Owner cannot be removed or demoted.
- Restricted Projects require an explicit grant for non-admin members.
- Workspace links grant no access by themselves; Project grants require both sides.
- A transfer requires source approval, target approval, and a separate import result.
- Wiki revisions require local Message/Conclusion citations. Federated memory must be
  explicitly transferred before it can become local Wiki knowledge.

The root repository's Apache License 2.0 applies to this package.

