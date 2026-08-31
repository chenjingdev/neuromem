import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createControlCredentialResolver, createMcpHttpServer, FederatedMemoryRouter, MemoryToolDispatcher, type AuthContext } from "../src/index.js";

const WORKSPACE_ID = "018f0f86-4d65-7a3c-8f2c-123456789abc";
const PROJECT_ID = "018f0f86-4d66-7a3c-8f2c-123456789abc";
const CORE_TOKEN = "core-secret-0123456789abcdefghijklmn";
const MCP_TOKEN = "mcp-secret-0123456789";

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("HTTP MCP enforces bearer auth, body limits, and session lifecycle", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "neuromem-mcp-http-test-"));
  let largeWiki = false;
  const coreRequests: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const core = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${CORE_TOKEN}`);
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      coreRequests.push({ path: request.url ?? "", ...(raw ? { body: JSON.parse(raw) as Record<string, unknown> } : {}) });
      const path = request.url ?? "";
      const payload = path.includes("/wiki")
        ? {
            workspace_id: WORKSPACE_ID,
            project_id: PROJECT_ID,
            sections: largeWiki
              ? [{ title: "large", content: "x".repeat(2 * 1_048_576) }]
              : [{ title: "Project facts", claims: [{ content: "A cited fact" }] }]
          }
        : path.includes("/graph")
          ? { workspace_id: WORKSPACE_ID, project_id: PROJECT_ID, nodes: [{ id: "n1", label: "Node one" }], edges: [] }
          : path.includes("/evidence")
            ? { claim: { id: "018f0f86-4d69-7a3c-8f2c-123456789abc", content: "Claim text" }, evidence: [{ quote: "Evidence quote" }] }
            : { ok: true };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
    });
  });
  const coreUrl = await listen(core);
  const router = new FederatedMemoryRouter({
    nodes: [{ id: "personal", baseUrl: coreUrl, token: CORE_TOKEN }],
    stateDir
  });
  assert.throws(() => createMcpHttpServer({
    dispatcher: new MemoryToolDispatcher(router), bearerToken: "too-short"
  }), /at least 16 bytes/);
  const server = createMcpHttpServer({
    dispatcher: new MemoryToolDispatcher(router),
    bearerToken: MCP_TOKEN,
    maxBodyBytes: 1_024,
    sessionTtlMs: 60_000,
    maxSessions: 1
  });
  const baseUrl = await listen(server);
  context.after(async () => {
    await Promise.all([close(server), close(core)]);
    await rm(stateDir, { recursive: true, force: true });
  });

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const unauthorized = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wrong" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(JSON.stringify(await unauthorized.json()).includes("mcp-secret"), false);

  const hostileOrigin = await fetch(`${baseUrl}/health`, { headers: { origin: "https://evil.example" } });
  assert.equal(hostileOrigin.status, 403);

  const invalidInitialize = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${MCP_TOKEN}` },
    body: JSON.stringify({ jsonrpc: "1.0", id: 99, method: "initialize", params: {} })
  });
  assert.equal(invalidInitialize.status, 200);
  assert.equal(invalidInitialize.headers.get("mcp-session-id"), null);
  const invalidPayload = await invalidInitialize.json() as { error: { code: number } };
  assert.equal(invalidPayload.error.code, -32600);

  const nullIdInitialize = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${MCP_TOKEN}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "invalid-client", version: "1.0.0" }
      }
    })
  });
  assert.equal(nullIdInitialize.status, 200);
  assert.equal(nullIdInitialize.headers.get("mcp-session-id"), null);
  assert.equal((await nullIdInitialize.json() as { error: { code: number } }).error.code, -32600);

  const initialize = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${MCP_TOKEN}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" }
      }
    })
  });
  assert.equal(initialize.status, 200);
  const sessionId = initialize.headers.get("mcp-session-id");
  assert.match(sessionId ?? "", /^[0-9a-f-]{14}7[0-9a-f-]+$/);

  const noSession = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${MCP_TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
  });
  assert.equal(noSession.status, 400);

  const list = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${MCP_TOKEN}`,
      "mcp-session-id": sessionId!
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })
  });
  const listPayload = await list.json() as { result: { tools: Array<{ name: string }> } };
  assert.equal(listPayload.result.tools.length, 8);
  assert.equal(listPayload.result.tools[0]?.name, "memory_record");

  const batch = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${MCP_TOKEN}`,
      "mcp-session-id": sessionId!
    },
    body: JSON.stringify([
      { jsonrpc: "2.0", id: 21, method: "ping" },
      { jsonrpc: "2.0", method: "unknown/notification" },
      { jsonrpc: "2.0", id: 22, method: "tools/list" }
    ])
  });
  assert.equal(batch.status, 200);
  const batchPayload = await batch.json() as Array<{ id: number }>;
  assert.deepEqual(batchPayload.map((item) => item.id), [21, 22]);
  const notificationBatch = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${MCP_TOKEN}`,
      "mcp-session-id": sessionId!
    },
    body: JSON.stringify([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "unknown/notification" }
    ])
  });
  assert.equal(notificationBatch.status, 202);
  assert.equal(await notificationBatch.text(), "");

  const recordCall = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${MCP_TOKEN}`,
      "mcp-session-id": sessionId!
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: {
        name: "memory_record",
        arguments: {
          workspace_id: WORKSPACE_ID,
          project_id: PROJECT_ID,
          session_id: "018f0f86-4d67-7a3c-8f2c-123456789abc",
          author_key: "agent-codex",
          author_kind: "agent",
          content: "Agent Said This"
        }
      }
    })
  });
  assert.equal(recordCall.status, 200);
  const recordBody = coreRequests.find((request) => request.path === "/v1/records:batch")?.body;
  assert.equal(((recordBody?.records as Array<Record<string, unknown>>)[0]?.author_kind), "agent");
  assert.equal(((recordBody?.records as Array<Record<string, unknown>>)[0]?.content), "Agent Said This");

  const call = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${MCP_TOKEN}`,
      "mcp-session-id": sessionId!
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "wiki_read", arguments: { workspace_id: WORKSPACE_ID, project_id: PROJECT_ID } }
    })
  });
  const callPayload = await call.json() as {
    result: { isError: boolean; structuredContent: { results: Array<{ origin_node: string }> } };
  };
  assert.equal(callPayload.result.isError, false);
  assert.equal(callPayload.result.structuredContent.results[0]?.origin_node, "personal");
  const previewText = (callPayload as unknown as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
  assert.ok(Buffer.byteLength(previewText, "utf8") <= 16 * 1_024);
  const preview = JSON.parse(previewText) as { summary: string; results: Array<{ origin_node: string; rrf_score: number }> };
  assert.match(preview.summary, /^Returned 1 memory result/);
  assert.equal(preview.results[0]?.origin_node, "personal");
  assert.equal(typeof preview.results[0]?.rrf_score, "number");
  assert.equal(previewText.includes("Project facts"), true);

  for (const [name, argumentsValue, expected] of [
    ["graph_read", { workspace_id: WORKSPACE_ID, project_id: PROJECT_ID }, "Node one"],
    ["get_claim_evidence", {
      workspace_id: WORKSPACE_ID,
      project_id: PROJECT_ID,
      claim_id: "018f0f86-4d69-7a3c-8f2c-123456789abc"
    }, "Evidence quote"]
  ] as const) {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${MCP_TOKEN}`,
        "mcp-session-id": sessionId!
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: `preview-${name}`, method: "tools/call", params: { name, arguments: argumentsValue } })
    });
    const payload = await response.json() as { result: { content: Array<{ text: string }> } };
    assert.equal(payload.result.content[0]?.text.includes(expected), true);
  }

  largeWiki = true;
  const bounded = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${MCP_TOKEN}`,
      "mcp-session-id": sessionId!
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: { name: "wiki_read", arguments: { workspace_id: WORKSPACE_ID, project_id: PROJECT_ID } }
    })
  });
  const boundedText = await bounded.text();
  assert.ok(Buffer.byteLength(boundedText, "utf8") <= 1_048_576);
  const boundedPayload = JSON.parse(boundedText) as { result: { structuredContent: { truncated: boolean } } };
  assert.equal(boundedPayload.result.structuredContent.truncated, true);

  const oversized = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${MCP_TOKEN}`,
      "mcp-session-id": sessionId!
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping", padding: "x".repeat(2_000) })
  });
  assert.equal(oversized.status, 413);

  const deleted = await fetch(`${baseUrl}/mcp`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${MCP_TOKEN}`, "mcp-session-id": sessionId! }
  });
  assert.equal(deleted.status, 204);
  const afterDelete = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${MCP_TOKEN}`,
      "mcp-session-id": sessionId!
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "ping" })
  });
  assert.equal(afterDelete.status, 404);
});

test("HTTP team sessions pin the credential-derived AuthContext", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "neuromem-mcp-team-http-test-"));
  const core = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ records: [], claims: [], record_snippets: [] }));
  });
  const coreUrl = await listen(core);
  const router = new FederatedMemoryRouter({ nodes: [{ id: "gateway", baseUrl: coreUrl, token: CORE_TOKEN }], stateDir });
  await router.ready();
  let currentCapabilities = ["*"];
  const auth = (credentialId: string): AuthContext => ({
    principal_id: "018f0f86-4d70-7a3c-8f2c-123456789abc",
    credential_id: credentialId,
    workspace_id: WORKSPACE_ID,
    project_id: PROJECT_ID,
    human_peer_id: "018f0f86-4d71-7a3c-8f2c-123456789abc",
    agent_peer_id: "018f0f86-4d72-7a3c-8f2c-123456789abc",
    capabilities: currentCapabilities,
    client: "codex"
  });
  const server = createMcpHttpServer({
    dispatcher: new MemoryToolDispatcher(router),
    credentialResolver: token => token === "credential-a" ? auth("credential-a") : token === "credential-b" ? auth("credential-b") : undefined,
    authMode: "team"
  });
  const baseUrl = await listen(server);
  context.after(async () => { await Promise.all([close(server), close(core)]); await rm(stateDir, { recursive: true, force: true }); });

  const initialized = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer credential-a" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "codex", version: "1" } } })
  });
  assert.equal(initialized.status, 200);
  const sessionId = initialized.headers.get("mcp-session-id")!;

  const list = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer credential-a", "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
  });
  const tools = (await list.json() as { result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> } }).result.tools;
  assert.equal(tools.length, 16);
  assert.equal("workspace_id" in tools.find((tool) => tool.name === "memory_record")!.inputSchema.properties, false);

  currentCapabilities = ["project.read"];
  const narrowed = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer credential-a", "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id: 22, method: "tools/list" })
  });
  const narrowedTools = (await narrowed.json() as { result: { tools: Array<{ name: string }> } }).result.tools;
  assert.equal(narrowedTools.some((tool) => tool.name === "memory_record"), false);
  assert.equal(narrowedTools.some((tool) => tool.name === "recall"), true);

  const swapped = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer credential-b", "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })
  });
  assert.equal(swapped.status, 401);
  assert.deepEqual(await swapped.json(), { error: "MCP credential does not match the initialized session" });
});

test("Control credential resolver obtains a complete server-derived team scope", async (context) => {
  const expected: AuthContext = {
    principal_id: "018f0f86-4d70-7a3c-8f2c-123456789abc",
    credential_id: "018f0f86-4d71-7a3c-8f2c-123456789abc",
    workspace_id: WORKSPACE_ID,
    project_id: PROJECT_ID,
    human_peer_id: "018f0f86-4d72-7a3c-8f2c-123456789abc",
    agent_peer_id: "018f0f86-4d73-7a3c-8f2c-123456789abc",
    capabilities: ["project.read", "project.write"],
    request_id: "request-1"
  };
  const control = createServer((request, response) => {
    assert.equal(request.url, "/api/v1/me");
    assert.equal(request.headers.authorization, "Bearer team-credential");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ principal: { id: expected.principal_id }, context: expected }));
  });
  const baseUrl = await listen(control);
  context.after(() => close(control));
  const resolver = createControlCredentialResolver(baseUrl);
  assert.deepEqual(await resolver("team-credential"), expected);
  assert.throws(() => createControlCredentialResolver("ftp://control.invalid"), /HTTP\(S\)/);
});
