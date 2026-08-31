# Neuromem team deployment

This Compose stack is the remote team boundary. It keeps the AGPL memory core,
PostgreSQL, Redis, and model endpoints private. Cloudflare Tunnel reaches only
the edge proxy, while host administration remains on loopback or Tailscale.

## Prepare

1. Copy `team.env.example` to the default private path shown by
   `neuromem team config validate` (`$NEUROMEM_HOME/team/team.env`) or pass
   `--env /private/path/team.env`. Set mode `0600` and replace every placeholder.
2. Set `NEUROMEM_PUBLIC_HOST` to the Cloudflare hostname and create a tunnel
   whose only origin is `http://edge:8080`.
3. Pin `MEMORY_CORE_IMAGE` by digest and record its public source URL and commit.
   The AGPL source and build context are deliberately not included in the
   Apache Neuromem package. Control, MCP, and Web build contexts are packaged.
4. Keep the environment file mode at `0600`.

## Validate without starting services

```sh
neuromem team config validate --env /private/path/team.env
neuromem team preflight --target auto
```

## Start

```sh
neuromem team start --env /private/path/team.env --target auto
neuromem team status --env /private/path/team.env
neuromem team logs --env /private/path/team.env --service control
```

`auto` selects DGX only on Linux/ARM64 with Docker's NVIDIA runtime and a GPU;
Apple Silicon selects the Mac fallback and expects model endpoints through
`host.docker.internal`. It never silently ignores a failed required preflight.

Schema initialization and non-destructive rehearsals are explicit:

```sh
neuromem team schema init --env /private/path/team.env
neuromem team migrate rehearse --env /private/path/team.env --target-revision head
neuromem team backup rehearse --env /private/path/team.env
```

The backup rehearsal makes new compressed dumps, verifies both with
`pg_restore --list`, and writes a hash manifest without stopping or modifying
either database. Migration rehearsal runs Memory Core's verify mode only.

Create a client config from a one-time credential stored in a `0600` file:

```sh
neuromem team mcp-config --env /private/path/team.env \
  --credential-file /private/path/aram-codex.token --format json
```

No database, Redis, model, or memory-core port is published to the host. The
loopback edge port exists for health checks and recovery; remote traffic must
arrive through Cloudflare Tunnel. Web and MCP call the team Control/Gateway;
only its short-lived signed context may reach Memory Core.
