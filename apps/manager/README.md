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
