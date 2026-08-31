# Neuromem Web

React/TypeScript UI for the product surface at `/app` and the machine-local
Node operator surface at `/admin`. `/app/team` manages Workspace members,
Human/Agent Peer bindings, MCP credentials, Project grants, Workspace links,
federated grants, and the audited transfer inbox. Host administration remains a
separate session and route.

```sh
npm install
npm run dev
npm test
npm run build
```

The browser calls Control through same-origin `/api` with its HttpOnly product
session. It never receives a Memory Core token or calls Core directly. Manager access uses the one-time
fragment produced by `neuromem admin open`, exchanges it for an HttpOnly cookie,
and removes the fragment immediately.

Team product calls use `VITE_TEAM_API_URL` (default `/api`) with the product
session cookie and `X-Neuromem-Workspace` / `X-Neuromem-Project` scope headers.
