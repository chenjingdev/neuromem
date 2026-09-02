# Neuromem

`neuromem` installs and supervises one Neuromem Node on the physical Mac or
DGX device. A Node is the monolithic server boundary and can host multiple
isolated Workspaces, each with multiple Projects. Package installation has no
lifecycle scripts and changes no host services; the first explicit `neuromem`
run starts and verifies the Node and opens its Dashboard.

```sh
npm install -g neuromem
neuromem
```

The host-local manager listens on a private Unix socket for CLI control and on
loopback for the Node management UI. PostgreSQL, Control, the memory API,
workers, MCP, and the application UI remain in the managed Node runtime.

## Node operations

The CLI operates the single physical Node through Docker Compose:

```sh
neuromem node config validate --env /private/node.env
neuromem node preflight --target auto
neuromem node start --env /private/node.env
neuromem node status --env /private/node.env
neuromem node compute status --env /private/node.env
neuromem node logs --env /private/node.env --service control
neuromem node stop --env /private/node.env
```

The env file must be outside the repository with mode `0600`. Validation
requires an external AGPL Memory Core image pinned by digest plus its source URL
and commit. The npm package contains Control, MCP, Web, Compose, and nginx build
inputs, but does not contain that Memory Core source.

`node preflight` supports DGX Linux/ARM64 with the NVIDIA container runtime and
Apple Silicon Mac. `node backup rehearse` creates and verifies fresh dumps
without stopping databases; `node migrate rehearse` compares Alembic's current
revision and code heads without applying a migration. `node mcp-config`
reads a credential from a separate `0600` file
so it is not placed on the command line.
