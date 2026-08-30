# Neuromem Web

React/TypeScript UI for the product surface at `/app` and the machine-local
Node operator surface at `/admin`.

```sh
npm install
npm run dev
npm test
npm run build
```

The browser calls Core through same-origin `/core-api`. The development proxy
and the production container inject `CORE_API_TOKEN` server-side; secrets are
never compiled into the JavaScript bundle. Manager access uses the one-time
fragment produced by `neuromem admin open`, exchanges it for an HttpOnly cookie,
and removes the fragment immediately.
