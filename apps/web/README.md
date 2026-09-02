# Neuromem Web

React/TypeScript UI for one Neuromem platform. The product surface at `/app`
uses the hierarchy `Node > Workspace > Project`; `/app/workspace` manages the
selected Workspace's projects, members, credentials, and owner-approved external
memory shares. The Node operator surface at `/admin` manages the physical Node,
including compute sources, Codex/API generation, health, logs, and recovery.

```sh
npm install
npm run dev
npm test
npm run build
```

The browser calls Control through same-origin `/api` with its HttpOnly product
session. It never receives a Memory Core token or calls Core directly. Manager access uses the one-time
fragment produced by `neuromem node admin open`, exchanges it for an HttpOnly cookie,
and removes the fragment immediately.

Product calls use `VITE_PRODUCT_API_URL` (default `/api`) with the product
session cookie and `X-Neuromem-Workspace` / `X-Neuromem-Project` scope headers.
`VITE_PRODUCT_URL` is the Workspace surface opened from Node management.
`VITE_NODE_ADMIN_URL` points the product navigation at the host-only Node
operator surface; this security boundary is not a separate product mode.
