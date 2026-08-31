import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  createControlCredentialResolver,
  createMcpHttpServer,
  MemoryToolDispatcher,
  startHttpServerFromEnv,
  stopHttpServer,
  TeamGatewayClient,
  type AuthContext,
} from "../src/index.js";

const WORKSPACE_ID = "018f0f86-4d65-7a3c-8f2c-123456789abc";
const PROJECT_A = "018f0f86-4d66-7a3c-8f2c-123456789abc";
const PROJECT_B = "018f0f86-4d67-7a3c-8f2c-123456789abc";
const HUMAN_A = "018f0f86-4d68-7a3c-8f2c-123456789abc";
const HUMAN_B = "018f0f86-4d69-7a3c-8f2c-123456789abc";

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function auth(credential: string, project: string, human: string): AuthContext {
  return {
    principal_id: human,
    credential_id: credential,
    workspace_id: WORKSPACE_ID,
    project_id: project,
    human_peer_id: human,
    agent_peer_id: undefined,
    capabilities: ["project.read", "project.write", "wiki.read", "transfer.request"],
    request_id: `request-${credential}`,
    client: "codex",
  };
}

test("team MCP isolates two credentials and exposes only Control Gateway-backed tools", async context => {
  const tokenA = "credential-a-secret";
  const tokenB = "credential-b-secret";
  const contexts = new Map([[tokenA, auth("credential-a", PROJECT_A, HUMAN_A)], [tokenB, auth("credential-b", PROJECT_B, HUMAN_B)]]);
  const gatewayCalls: Array<{ authorization: string; projectHeader?: string; path: string; body: Record<string, unknown> }> = [];
  const control = createServer(async (request, response) => {
    const authorization = String(request.headers.authorization || "");
    const token = authorization.replace(/^Bearer /, "");
    const selected = contexts.get(token);
    response.setHeader("content-type", "application/json");
    if (!selected) { response.statusCode = 401; response.end(JSON.stringify({ detail: "invalid" })); return; }
    if (request.url === "/api/v1/me") { response.end(JSON.stringify({ context: selected })); return; }
    const body = await jsonBody(request);
    gatewayCalls.push({ authorization, projectHeader: request.headers["x-neuromem-project"] as string | undefined, path: request.url || "", body });
    response.end(JSON.stringify({ workspace_id: WORKSPACE_ID, project_id: selected.project_id, records: [{ record_id: selected.project_id, project_id: selected.project_id, content: "isolated", matched_content: "isolated", rank: 1 }], claims: [], record_snippets: [], federated_persisted: false }));
  });
  const controlUrl = await listen(control);
  const mcp = createMcpHttpServer({
    dispatcher: new MemoryToolDispatcher(undefined, { authMode: "team" }),
    credentialResolver: createControlCredentialResolver(controlUrl),
    teamGateway: new TeamGatewayClient(controlUrl),
    authMode: "team",
  });
  const mcpUrl = await listen(mcp);
  context.after(async () => Promise.all([close(mcp), close(control)]));

  async function initialize(token: string): Promise<string> {
    const response = await fetch(`${mcpUrl}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) });
    assert.equal(response.status, 200);
    return response.headers.get("mcp-session-id")!;
  }
  async function rpc(token: string, session: string, request: unknown) {
    const response = await fetch(`${mcpUrl}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "mcp-session-id": session, "content-type": "application/json" }, body: JSON.stringify(request) });
    return response.json() as Promise<Record<string, unknown>>;
  }

  const [sessionA, sessionB] = await Promise.all([initialize(tokenA), initialize(tokenB)]);
  const listed = await rpc(tokenA, sessionA, { jsonrpc: "2.0", id: 2, method: "tools/list" }) as { result: { tools: Array<{ name: string }> } };
  const names = listed.result.tools.map(tool => tool.name);
  assert.deepEqual(names, ["memory_record", "search_records", "search_claims", "recall", "wiki_read", "representation_read", "peer_card_read", "session_context", "dynamic_context", "dialectic_chat", "schedule_dream", "federated_search", "transfer_request"]);
  assert.equal(names.includes("get_record_context"), false);
  assert.equal(names.includes("get_claim_evidence"), false);
  assert.equal(names.includes("graph_read"), false);

  await Promise.all([
    rpc(tokenA, sessionA, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "recall", arguments: { query: "alpha" } } }),
    rpc(tokenB, sessionB, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "recall", arguments: { query: "beta" } } }),
  ]);
  assert.deepEqual(gatewayCalls.map(call => call.projectHeader).sort(), [PROJECT_A, PROJECT_B].sort());
  assert.deepEqual(gatewayCalls.map(call => call.body.project_id).sort(), [PROJECT_A, PROJECT_B].sort());
  assert.ok(gatewayCalls.every(call => call.path === "/api/v1/recall"));
  assert.equal(JSON.stringify(gatewayCalls.map(call => call.body)).includes(tokenA), false);
  assert.equal(JSON.stringify(gatewayCalls.map(call => call.body)).includes(tokenB), false);

  const swapped = await fetch(`${mcpUrl}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tokenB}`, "mcp-session-id": sessionA, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }) });
  assert.equal(swapped.status, 401);
});

test("team HTTP startup requires only NEUROMEM_CONTROL_API_URL", async context => {
  await assert.rejects(startHttpServerFromEnv({
    NEUROMEM_MCP_AUTH_MODE: "team",
    NEUROMEM_MCP_TOKEN: "legacy-static-token",
    NEUROMEM_MCP_AUTH_CONTEXT: JSON.stringify(auth("credential-a", PROJECT_A, HUMAN_A)),
  }), /requires NEUROMEM_CONTROL_API_URL/);
  const control = createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.statusCode = 401; response.end(JSON.stringify({ detail: "auth required" })); });
  const controlUrl = await listen(control);
  const reservation = createServer();
  await listen(reservation);
  const port = (reservation.address() as AddressInfo).port;
  await close(reservation);
  const server = await startHttpServerFromEnv({ NEUROMEM_CONTROL_API_URL: controlUrl, HOST: "127.0.0.1", PORT: String(port) });
  context.after(async () => { await stopHttpServer(server); await close(control); });
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
});
