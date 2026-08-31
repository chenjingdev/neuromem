# Neuromem

`neuromem` installs and supervises one or more local Neuromem Nodes. Package
installation has no lifecycle scripts and changes no host services; the first
explicit `neuromem` run prepares the default Node, starts it, verifies it, and
opens its Dashboard.

```sh
npm install -g neuromem
neuromem
```

The host-local manager listens on a private Unix socket for CLI control and on
loopback for the Admin UI. PostgreSQL, the memory API, workers, MCP, and the
main application UI remain in the managed Node runtime.

## Team deployment

Team operations run directly through Docker Compose and do not start or alter
the local Node daemon:

```sh
neuromem team config validate --env /private/team.env
neuromem team preflight --target auto
neuromem team start --env /private/team.env
neuromem team status --env /private/team.env
neuromem team logs --env /private/team.env --service control
neuromem team stop --env /private/team.env
```

The env file must be outside the repository with mode `0600`. Validation
requires an external AGPL Memory Core image pinned by digest plus its source URL
and commit. The npm package contains Control, MCP, Web, Compose, and nginx build
inputs, but does not contain that Memory Core source.

`team preflight` supports DGX Linux/ARM64 with the NVIDIA container runtime and
Apple Silicon Mac fallback. `team backup rehearse` creates and verifies fresh
dumps without stopping databases; `team migrate rehearse` invokes verify-only
mode. `team mcp-config` reads a one-time credential from a separate `0600` file
so it is not placed on the command line.
