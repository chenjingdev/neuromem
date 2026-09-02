# Neuromem Node deployment

This Compose stack is the monolithic physical Node boundary. One Mac, DGX Spark,
or server runs one Node; that Node can host many isolated Workspaces, and every
Workspace can contain many Projects.

The stack includes Control, Web, MCP, the AGPL Memory Core, workers, PostgreSQL,
Redis, and the edge proxy. Compute providers may run on the host or on a private
network. Node administration stays host-local.

## Prepare the private Node configuration

The preferred path is the CLI because it generates the Node ID and all internal
secrets, writes the file with mode `0600`, and prints its location:

```sh
neuromem node config init
```

To use an explicit path from a source checkout instead:

```sh
cp deploy/node/node.env.example /private/path/node.env
chmod 600 /private/path/node.env
```

Replace every placeholder before validation. In particular:

- keep `MEMORY_CORE_IMAGE` pinned by digest and record its public source URL and
  commit;
- use the same value for `CONTROL_INTERNAL_SIGNING_KEY` and
  `MEMORY_INTERNAL_SIGNING_KEY`;
- give every database, token, and signing secret a random value;
- keep all volume names dedicated to this physical Node;
- configure the embedding and generation providers reachable from the Node.

The Apache package includes the Control, MCP, Web, Compose, and nginx build
inputs. It deliberately does not include the separately distributed AGPL Memory
Core source or build context.

## Local Node

For local-only access use:

```dotenv
NEUROMEM_PUBLIC_HOST=localhost
CLOUDFLARE_TUNNEL_TOKEN=
EDGE_LOOPBACK_PORT=24443
```

Validate and start:

```sh
neuromem node config validate --env /private/path/node.env
neuromem node preflight --target auto
neuromem node start --env /private/path/node.env --target auto
```

When using the default CLI-generated path, omit every `--env` option. The local
application is `http://localhost:24443`; MCP is
`http://localhost:24443/mcp`.

For short-lived loopback UI testing, the login form can be prefilled from the
private `0600` Node env file:

```dotenv
CONTROL_SECURE_COOKIES=false
LOCAL_TEST_LOGIN_PREFILL=true
LOCAL_TEST_LOGIN_EMAIL=tester@example.com
LOCAL_TEST_LOGIN_PASSWORD=local-test-password-123
```

This endpoint is unauthenticated because it is used before login. The CLI
rejects it on public hosts or when Cloudflare Tunnel is configured, and the edge
port is bound to loopback. Disable the flag after testing and never use real or
production credentials for this convenience feature.

`auto` selects DGX only on Linux/ARM64 with Docker's NVIDIA runtime and a
visible GPU. Apple Silicon selects the Mac target and expects host model
endpoints through `host.docker.internal`. A failed required preflight is never
silently ignored.

## Node compute sources

Embedding and generation are Node-level resources shared by every Workspace.
They are not configured per user, Workspace, or Project.

```sh
neuromem node compute status --env /private/path/node.env
neuromem node admin open
```

The host-only Node management UI reports the configured provider, model, probe
result, and last check. Generation can reuse the host's Codex login through the
local Manager bridge or use an OpenAI-compatible endpoint such as Ollama or LM
Studio. Codex credentials are not copied into the Node containers. Embedding
uses its separately configured OpenAI-compatible endpoint and vector dimension.

A missing or unhealthy compute source is reported independently from the Docker
service state; inspect the start warnings and `node compute status`.

## Workspace and Project boundaries

After the Node starts, the application bootstrap creates the first Owner,
Workspace, and Project. Additional Workspaces and Projects are created in the
same application.

Workspaces are isolated by default. Sharing requires an Owner of the source
Workspace to propose a directional read-only projection and an Owner of the
recipient Workspace to approve it.

- `workspace` display mode groups all current active source Projects under the
  external Workspace in the recipient UI.
- `projects` display mode exposes only explicitly selected Projects and flattens
  them into the recipient UI.
- Either side's Owner can revoke an active share immediately.
- Revocation removes both the UI projection and federated search access.
- Permanent memory copying remains a separate audited transfer operation.

## Remote access with Cloudflare Tunnel

For remote access set `NEUROMEM_PUBLIC_HOST` to the public hostname and provide
`CLOUDFLARE_TUNNEL_TOKEN`. The CLI then enables the Compose `cloudflare`
profile. Configure the tunnel so its only origin is `http://edge:8080`.

Only the edge proxy is public. Web and MCP call the Node Control gateway; only a
short-lived signed internal context may reach Memory Core. Never publish the
database, Redis, model, or Memory Core ports.

## Operations

```sh
neuromem node status --env /private/path/node.env
neuromem node logs --env /private/path/node.env --service control --tail 200
neuromem node stop --env /private/path/node.env
```

Schema initialization and non-destructive rehearsals are explicit:

```sh
neuromem node schema init --env /private/path/node.env
neuromem node migrate rehearse --env /private/path/node.env --target-revision head
neuromem node backup rehearse --env /private/path/node.env
```

The backup rehearsal creates fresh compressed dumps, verifies them with
`pg_restore --list`, and writes a hash manifest without stopping or modifying
either database. Migration rehearsal runs Memory Core's verification path
without applying a migration.

Create a client configuration from a one-time credential stored in a separate
`0600` file:

```sh
neuromem node mcp-config --env /private/path/node.env \
  --credential-file /private/path/aram-codex.token --format json
```

The credential fixes the Principal, Workspace, Project, Human Peer, optional
Agent Peer, and capabilities. MCP arguments cannot switch to another memory
scope or author.
