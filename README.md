# Neuromem

Neuromem is a source-grounded memory engine for people and AI agents. It stores
immutable records first, derives explicit claims asynchronously, and keeps every
derived view traceable to its source.

## Product model

Neuromem is one platform; it does not have separate Personal and Team modes.

```text
Physical Node (one Mac, DGX Spark, or server)
└── Workspace (ownership, membership, and memory-isolation boundary)
    └── Project (working memory, recall, derivation, Dream, and Wiki boundary)
```

- One physical device runs one monolithic Node.
- One Node can host many Workspaces.
- One Workspace can contain many Projects.
- Workspaces share no memory by default.
- An Owner can propose a directional share to another Workspace, but an Owner
  of the recipient Workspace must also approve it.
- A share can appear in the recipient UI as a grouped external Workspace or as
  only the approved Projects. Either side's Owner can revoke it immediately.

Node operators manage Docker services, compute sources, Codex/API model
connections, logs, and recovery. Workspace Owners manage members, Projects,
credentials, and memory-sharing agreements.

## Repository layout

- `apps/core` — Neuromem data-plane API and worker implementation
- `apps/control` — Node gateway, identity, authorization, and Workspace sharing
- `apps/manager` — host-local Node Manager and `neuromem` CLI
- `apps/mcp` — credential-bound MCP adapter
- `apps/web` — Workspace product and host-only Node management UI
- `deploy/node` — monolithic physical Node Compose deployment
- `tests` — cross-service deployment and contract tests

## Development

Requirements:

- Node.js 20+
- Python 3.12+
- Docker with Compose

Install dependencies and run the repository tests:

```sh
npm install
python3 -m venv .venv
.venv/bin/pip install -e 'apps/core[dev]'

npm test
.venv/bin/pytest apps/core/tests
```

## Install the local CLI

The npm package is not published by this repository. Build a local tarball and
install that exact artifact for an end-to-end test:

```sh
npm install
npm run build
npm pack --workspace neuromem
npm install -g ./neuromem-0.1.0.tgz
```

Package installation has no lifecycle script and does not start services.

## Configure and start this Node

`neuromem` creates the missing private Node configuration, starts the complete
Node, verifies its services and compute sources, and opens the application. Use
this fast path when the configured model endpoints are already available:

```sh
neuromem
```

For an explicit first setup, initialize the private `0600` configuration and
edit the path returned by the command before starting:

```sh
neuromem node config init
neuromem node config validate
neuromem node preflight --target auto
neuromem node start --target auto
```

The default local application is `http://localhost:24443`; MCP is available at
`http://localhost:24443/mcp`. No database, Redis, or Memory Core port is
published to the host.

Useful commands:

```sh
neuromem node status
neuromem node compute status
neuromem node logs --service control --tail 200
neuromem node admin open
neuromem node mcp-config --credential-file /private/credential --format toml
neuromem node backup rehearse
neuromem node migrate rehearse --target-revision head
neuromem node stop
neuromem skill path
```

`neuromem node admin open` opens the host-only Node management surface. Compute
configuration belongs to the Node and is shared by all of its Workspaces. The
generation source can reuse the local Codex login or use an OpenAI-compatible
API; embedding and generation health are reported separately.

## Workspace and Project operation

The first bootstrap creates an Owner, a Workspace, and its first Project. From
the application, a user can create additional Workspaces and Projects and
switch the active scope. A Principal is the authentication and permission
subject; each membership receives a distinct Human Peer, and Codex, Claude, or
other agents use separate Agent Peers.

Sharing is a read-only projection, not implicit memory copying:

1. An Owner proposes a target Workspace and display mode.
2. An Owner of the target Workspace approves or rejects the request.
3. An approved `workspace` display groups all current active source Projects.
4. An approved `projects` display shows only the explicitly selected Projects.
5. Revocation immediately removes both the UI projection and federated search
   access.

Permanent copying remains a separate, audited transfer flow that derives new
memory inside the recipient Project.

## Deployment and source boundary

See [`deploy/node/README.md`](deploy/node/README.md) for local, DGX, and
Cloudflare deployment instructions.

The edge exposes only Web, Control API, and MCP. Databases, Redis, model
services, and Memory Core remain private. The Apache-2.0 package includes
Control, Manager, MCP, Web, and deployment inputs. The separately distributed
Memory Core is derived from Honcho v3.1.0 and remains AGPL-3.0-only; its image is
pinned by digest and its exact source URL and revision are recorded in the Node
configuration and `SOURCE_MANIFEST.json`.
