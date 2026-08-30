export const managerOpenApi = {
  openapi: "3.1.0",
  info: { title: "Neuromem Node Manager", version: "0.1.0" },
  servers: [{ url: "http://127.0.0.1:14174" }],
  paths: {
    "/health": { get: { summary: "Manager liveness" } },
    "/v1/nodes": { get: { summary: "List local Nodes" } },
    "/v1/nodes/{id}/health": { get: { summary: "Inspect Node and component health" } },
    "/v1/nodes/{id}/backlog": { get: { summary: "Inspect processing backlog" } },
    "/v1/nodes/{id}/logs": { get: { summary: "Read bounded, redacted logs" } },
    "/v1/nodes/{id}/start": { post: { summary: "Start the complete Node" } },
    "/v1/nodes/{id}/stop": { post: { summary: "Stop the complete Node without deleting data" } },
    "/v1/nodes/{id}/restart": { post: { summary: "Restart the complete Node" } },
    "/v1/nodes/{id}/backups": {
      get: { summary: "List complete backups" },
      post: { summary: "Create and verify a backup" },
    },
    "/v1/nodes/{id}/backups/{backupId}/verify": { post: { summary: "Verify checksum and archive structure" } },
    "/v1/nodes/{id}/restore/plan": { post: { summary: "Plan a staged restore; never applies it" } },
    "/v1/nodes/{id}/migrate/plan": { post: { summary: "Plan a schema migration; never applies it" } },
    "/v1/admin/session": { post: { summary: "Exchange a one-time bootstrap token for an HttpOnly session" } },
  },
} as const;
