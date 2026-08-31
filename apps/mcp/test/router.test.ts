import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CoreClient,
  CoreRequestError,
  DurableRetryQueue,
  FederatedMemoryRouter,
  loadRouterConfig,
  MEMORY_TOOLS,
  TEAM_MEMORY_TOOLS,
  MemoryToolDispatcher,
  type AuthContext,
  type FederatedResult,
  type JsonObject,
  uuid7
} from "../src/index.js";

const WORKSPACE_ID = "018f0f86-4d65-7a3c-8f2c-123456789abc";
const PROJECT_ID = "018f0f86-4d66-7a3c-8f2c-123456789abc";
const SESSION_ID = "018f0f86-4d67-7a3c-8f2c-123456789abc";
const RECORD_ID = "018f0f86-4d68-7a3c-8f2c-123456789abc";
const CLAIM_ID = "018f0f86-4d69-7a3c-8f2c-123456789abc";
const LOGICAL_SCOPE = { workspace_id: WORKSPACE_ID, project_id: PROJECT_ID };
const HUMAN_PEER_ID = "018f0f86-4d71-7a3c-8f2c-123456789abc";
const AGENT_PEER_ID = "018f0f86-4d72-7a3c-8f2c-123456789abc";
const TEAM_AUTH: AuthContext = {
  principal_id: "018f0f86-4d73-7a3c-8f2c-123456789abc",
  credential_id: "018f0f86-4d74-7a3c-8f2c-123456789abc",
  workspace_id: WORKSPACE_ID,
  project_id: PROJECT_ID,
  human_peer_id: HUMAN_PEER_ID,
  agent_peer_id: AGENT_PEER_ID,
  capabilities: ["*"],
  client: "codex"
};

interface CapturedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body?: JsonObject;
  receivedAt: number;
}

interface MockReply {
  status?: number;
  body?: unknown;
  delayMs?: number;
}

async function mockNode(handler: (request: CapturedRequest) => MockReply | Promise<MockReply>): Promise<{
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const captured: CapturedRequest = {
      method: request.method ?? "",
      path: request.url ?? "",
      headers: request.headers,
      ...(rawBody ? { body: JSON.parse(rawBody) as JsonObject } : {}),
      receivedAt: Date.now()
    };
    requests.push(captured);
    const reply = await handler(captured);
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    response.statusCode = reply.status ?? 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(reply.body ?? { ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function stateFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else output.push(path);
    }
  }
  await visit(root);
  return output;
}

function scope(): JsonObject {
  return { workspace_id: WORKSPACE_ID, project_id: PROJECT_ID };
}

test("the dispatcher exposes exactly the eight final memory tools", () => {
  assert.deepEqual(MEMORY_TOOLS.map((tool) => tool.name), [
    "memory_record",
    "search_records",
    "search_claims",
    "recall",
    "get_record_context",
    "get_claim_evidence",
    "wiki_read",
    "graph_read"
  ]);
  assert.equal(new Set(MEMORY_TOOLS.map((tool) => tool.name)).size, 8);
  assert.ok(MEMORY_TOOLS.every((tool) => tool.inputSchema.additionalProperties === false));
  assert.ok(MEMORY_TOOLS.every((tool) => {
    const properties = tool.inputSchema.properties as Record<string, unknown>;
    return !("targets" in properties) && "target" in properties;
  }));
  assert.ok(MEMORY_TOOLS.every((tool) => {
    const required = tool.inputSchema.required as string[];
    return required.includes("workspace_id") && required.includes("project_id");
  }));
});

test("team mode derives scope and author Peers from the credential and applies safe context defaults", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "neuromem-mcp-team-test-"));
  const node = await mockNode((request) => {
    if (request.path === "/v1/records:batch") return { status: 201, body: { records: [] } };
    if (request.path === "/v1/recall") return {
      body: {
        records: [{ record_id: RECORD_ID, content: "shared result", rank: 1, source_workspace_id: "external-workspace", source_project_id: "external-project", source_peer_id: HUMAN_PEER_ID, grant_id: "grant-1" }],
        claims: [], record_snippets: [], embedding_used: true
      }
    };
    if (request.path === "/v1/transfer-requests") return { body: { id: "transfer-1", status: "pending_source" } };
    return { status: 404 };
  });
  context.after(async () => { await node.close(); await rm(stateDir, { recursive: true, force: true }); });
  const dispatcher = new MemoryToolDispatcher(new FederatedMemoryRouter({
    nodes: [{ id: "gateway", baseUrl: node.baseUrl, token: "gateway-token-0123456789abcdefghijkl" }],
    stateDir
  }), { authMode: "team", authContext: TEAM_AUTH });

  assert.equal(TEAM_MEMORY_TOOLS.length, 16);
  const recordSchema = dispatcher.listTools().find((tool) => tool.name === "memory_record")!.inputSchema;
  assert.equal("workspace_id" in (recordSchema.properties as JsonObject), false);
  assert.equal("author_key" in (recordSchema.properties as JsonObject), false);

  await dispatcher.callTool("memory_record", { session_id: SESSION_ID, speaker: "agent", content: "credential-bound agent message" });
  const written = (node.requests[0]?.body?.records as JsonObject[])[0]!;
  assert.equal(node.requests[0]?.body?.workspace_id, WORKSPACE_ID);
  assert.equal(node.requests[0]?.body?.project_id, PROJECT_ID);
  assert.equal(written.author_key, AGENT_PEER_ID);
  assert.equal(written.author_kind, "agent");
  assert.equal(written.source_app, "codex");

  const recalled = await dispatcher.callTool("recall", { query: "shared" }) as FederatedResult;
  assert.deepEqual(node.requests[1]?.body, {
    workspace_id: WORKSPACE_ID, project_id: PROJECT_ID, query: "shared", include: ["records", "claims"], limit: 10,
    include_general: true, include_federated: false
  });
  assert.equal(recalled.results[0]?.source_workspace_id, "external-workspace");
  assert.equal(recalled.results[0]?.source_project_id, "external-project");
  assert.equal(recalled.results[0]?.source_peer_id, HUMAN_PEER_ID);
  assert.equal(recalled.results[0]?.grant_id, "grant-1");

  await dispatcher.callTool("transfer_request", {
    target_workspace_id: "018f0f86-4d76-7a3c-8f2c-123456789abc",
    target_project_id: "018f0f86-4d77-7a3c-8f2c-123456789abc",
    record_id: RECORD_ID,
    source_content_hash: "a".repeat(64),
    source_snapshot: "approved source snapshot",
    reason: "share the accepted architecture"
  });
  assert.deepEqual(node.requests[2]?.body, {
    source_workspace_id: WORKSPACE_ID,
    source_project_id: PROJECT_ID,
    target_workspace_id: "018f0f86-4d76-7a3c-8f2c-123456789abc",
    target_project_id: "018f0f86-4d77-7a3c-8f2c-123456789abc",
    source_record_id: RECORD_ID,
    source_content_hash: "a".repeat(64),
    source_snapshot: "approved source snapshot",
    provenance: { reason: "share the accepted architecture" }
  });

  await assert.rejects(dispatcher.callTool("memory_record", {
    workspace_id: "018f0f86-4d75-7a3c-8f2c-123456789abc",
    session_id: SESSION_ID, speaker: "agent", content: "spoof"
  }), /unknown argument 'workspace_id'/);
  await assert.rejects(new MemoryToolDispatcher(dispatcher.router, {
    authMode: "team", authContext: { ...TEAM_AUTH, capabilities: ["project.read"] }
  }).callTool("memory_record", { session_id: SESSION_ID, speaker: "agent", content: "forbidden" }), /lacks 'project.write'/);
});

test("memory_record sends the exact batch shape with one UUIDv7 across nodes", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "neuromem-mcp-test-"));
  let companyAvailable = false;
  const personal = await mockNode(() => ({ status: 201, body: { records: [] } }));
  const company = await mockNode(() => companyAvailable
    ? { status: 201, body: { records: [] } }
    : { status: 503, body: { error: "temporary" } });
  context.after(async () => {
    await Promise.all([personal.close(), company.close()]);
    await rm(stateDir, { recursive: true, force: true });
  });

  const secret = "token-that-must-not-be-persisted";
  const content = "payload stored once for retry";
  const router = new FederatedMemoryRouter({
    nodes: [
      { id: "personal", baseUrl: personal.baseUrl, token: secret },
      { id: "company", baseUrl: company.baseUrl, token: secret }
    ],
    stateDir,
    defaultReadTargets: ["personal"],
    defaultWriteTargets: ["personal", "company"],
    requestTimeoutMs: 1_000
  });
  const dispatcher = new MemoryToolDispatcher(router);
  const result = await dispatcher.callTool("memory_record", {
    ...scope(),
    session_id: SESSION_ID,
    author_key: "user-aram",
    author_name: "Aram",
    author_kind: "human",
    kind: "message",
    content,
    source_app: "codex",
    metadata: { channel: "test" },
    target: "both"
  }) as { record_id: string; deliveries: Record<string, { status: string }> };

  assert.match(result.record_id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(result.deliveries.personal?.status, "stored");
  assert.equal(result.deliveries.company?.status, "pending");
  const expectedPath = "/v1/records:batch";
  for (const request of [personal.requests[0], company.requests[0]]) {
    assert.equal(request?.path, expectedPath);
    assert.equal(request?.headers["idempotency-key"], result.record_id);
    const occurredAt = ((request?.body?.records as JsonObject[] | undefined)?.[0]?.occurred_at);
    assert.equal(occurredAt, new Date(Number(BigInt(`0x${result.record_id.replaceAll("-", "").slice(0, 12)}`))).toISOString());
    assert.deepEqual(request?.body, {
      workspace_id: WORKSPACE_ID,
      project_id: PROJECT_ID,
      session_id: SESSION_ID,
      records: [{
        id: result.record_id,
        author_key: "user-aram",
        content,
        author_name: "Aram",
        author_kind: "human",
        kind: "message",
        occurred_at: occurredAt,
        source_app: "codex",
        metadata: { channel: "test" }
      }]
    });
  }

  const queueText = await readFile(join(stateDir, "retry-queue.json"), "utf8");
  assert.equal(queueText.includes(content), false);
  assert.equal(queueText.includes(secret), false);
  const queue = JSON.parse(queueText) as Array<Record<string, unknown>>;
  assert.deepEqual(queue.map(({ record_id, target_node }) => ({ record_id, target_node })), [
    { record_id: result.record_id, target_node: "company" }
  ]);
  const files = await stateFiles(stateDir);
  const persisted = (await Promise.all(files.map((path) => readFile(path, "utf8")))).join("\n");
  assert.equal(persisted.includes(secret), false);
  assert.equal(persisted.split(content).length - 1, 1);

  companyAvailable = true;
  const retry = await router.retryPending({ force: true }) as {
    deliveries: Record<string, { status: string }>;
    remaining: number;
  };
  assert.equal(retry.deliveries[`${result.record_id}:company`]?.status, "stored");
  assert.equal(retry.remaining, 0);
  assert.equal((company.requests[1]?.body?.records as JsonObject[] | undefined)?.[0]?.id, result.record_id);
  assert.deepEqual(JSON.parse(await readFile(join(stateDir, "retry-queue.json"), "utf8")), []);
  assert.deepEqual(await readdir(join(stateDir, "records")), []);
});

test("non-429 4xx writes are permanent and never expose response bodies or tokens", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "neuromem-mcp-test-"));
  const secret = "private-bearer-token-0123456789abcdef";
  const node = await mockNode(() => ({ status: 401, body: { error: secret } }));
  context.after(async () => {
    await node.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const router = new FederatedMemoryRouter({ nodes: [{ id: "personal", baseUrl: node.baseUrl, token: secret }], stateDir });
  const result = await router.memoryRecord({
    workspace_id: WORKSPACE_ID,
    project_id: PROJECT_ID,
    session_id: SESSION_ID,
    author_key: "user-aram",
    author_kind: "human",
    content: "do not retain"
  });
  assert.deepEqual(result.deliveries.personal, {
    origin_node: "personal", origin_scope: LOGICAL_SCOPE, logical_scope: LOGICAL_SCOPE,
    status: "failed", error_code: "http_401", http_status: 401
  });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(JSON.parse(await readFile(join(stateDir, "retry-queue.json"), "utf8")), []);
  assert.deepEqual(await readdir(join(stateDir, "records")), []);
});

test("a fresh session is created once before retrying the same record id", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "neuromem-mcp-test-"));
  let sessionExists = false;
  const node = await mockNode((request) => {
    if (request.path === "/v1/records:batch") {
      return sessionExists ? { status: 201, body: { records: [] } } : { status: 404, body: { detail: "session not found" } };
    }
    const sessionPath = `/v1/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}/sessions`;
    if (request.path === sessionPath) {
      assert.deepEqual(request.body, {
        id: SESSION_ID,
        external_key: SESSION_ID,
        name: "codex"
      });
      sessionExists = true;
      return { status: 200, body: { id: SESSION_ID } };
    }
    return { status: 404 };
  });
  context.after(async () => {
    await node.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const router = new FederatedMemoryRouter({
    nodes: [{ id: "personal", baseUrl: node.baseUrl, token: "core-token-0123456789abcdefghijklmn" }],
    stateDir
  });
  const result = await router.memoryRecord({
    workspace_id: WORKSPACE_ID,
    project_id: PROJECT_ID,
    session_id: SESSION_ID,
    author_key: "user-aram",
    author_kind: "agent",
    content: "first session record",
    source_app: "codex"
  });
  assert.equal(result.deliveries.personal?.status, "stored");
  assert.deepEqual(node.requests.map((request) => request.path), [
    "/v1/records:batch",
    `/v1/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}/sessions`,
    "/v1/records:batch"
  ]);
  const firstId = ((node.requests[0]?.body?.records as JsonObject[])[0]?.id);
  const retriedId = ((node.requests[2]?.body?.records as JsonObject[])[0]?.id);
  assert.equal(firstId, result.record_id);
  assert.equal(retriedId, result.record_id);
  assert.equal(node.requests[0]?.headers["idempotency-key"], result.record_id);
  assert.equal(node.requests[2]?.headers["idempotency-key"], result.record_id);
});

test("a missing project preserves the original batch 404", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "neuromem-mcp-test-"));
  const node = await mockNode((request) => request.path === "/v1/records:batch"
    ? { status: 404, body: { detail: "session not found" } }
    : { status: 404, body: { detail: "project not found" } });
  context.after(async () => {
    await node.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const router = new FederatedMemoryRouter({
    nodes: [{ id: "personal", baseUrl: node.baseUrl, token: "core-token-0123456789abcdefghijklmn" }],
    stateDir
  });
  const result = await router.memoryRecord({
    workspace_id: WORKSPACE_ID,
    project_id: PROJECT_ID,
    session_id: SESSION_ID,
    author_key: "user-aram",
    author_kind: "agent",
    content: "cannot be stored"
  });
  assert.deepEqual(result.deliveries.personal, {
    origin_node: "personal", origin_scope: LOGICAL_SCOPE, logical_scope: LOGICAL_SCOPE,
    status: "failed", error_code: "http_404", http_status: 404
  });
  assert.equal(node.requests.length, 2);
  assert.deepEqual(JSON.parse(await readFile(join(stateDir, "retry-queue.json"), "utf8")), []);
});

test("a session id scope collision preserves the original batch 404", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "neuromem-mcp-test-"));
  const node = await mockNode((request) => request.path === "/v1/records:batch"
    ? { status: 404, body: { detail: "session not found" } }
    : { status: 409, body: { detail: "session id belongs to another scope" } });
  context.after(async () => {
    await node.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const router = new FederatedMemoryRouter({
    nodes: [{ id: "personal", baseUrl: node.baseUrl, token: "core-token-0123456789abcdefghijklmn" }],
    stateDir
  });
  const result = await router.memoryRecord({
    workspace_id: WORKSPACE_ID,
    project_id: PROJECT_ID,
    session_id: SESSION_ID,
    author_key: "user-aram",
    author_kind: "agent",
    content: "cannot cross scopes"
  });
  assert.deepEqual(result.deliveries.personal, {
    origin_node: "personal", origin_scope: LOGICAL_SCOPE, logical_scope: LOGICAL_SCOPE,
    status: "failed", error_code: "http_404", http_status: 404
  });
  assert.equal(node.requests.length, 2);
  assert.deepEqual(JSON.parse(await readFile(join(stateDir, "retry-queue.json"), "utf8")), []);
});

test("a transient session-create failure keeps the durable write pending", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "neuromem-mcp-test-"));
  const node = await mockNode((request) => request.path === "/v1/records:batch"
    ? { status: 404, body: { detail: "session not found" } }
    : { status: 503, body: { detail: "temporarily unavailable" } });
  context.after(async () => {
    await node.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const router = new FederatedMemoryRouter({
    nodes: [{ id: "personal", baseUrl: node.baseUrl, token: "core-token-0123456789abcdefghijklmn" }],
    stateDir
  });
  const result = await router.memoryRecord({
    workspace_id: WORKSPACE_ID,
    project_id: PROJECT_ID,
    session_id: SESSION_ID,
    author_key: "user-aram",
    author_kind: "agent",
    content: "retry after session service recovery"
  });
  assert.equal(result.deliveries.personal?.status, "pending");
  assert.equal(result.deliveries.personal?.error_code, "http_503");
  const queue = JSON.parse(await readFile(join(stateDir, "retry-queue.json"), "utf8")) as unknown[];
  assert.equal(queue.length, 1);
  assert.equal((await readdir(join(stateDir, "records"))).length, 1);
});

test("recall runs selected nodes in parallel, dedupes, and applies reciprocal-rank fusion", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "neuromem-mcp-test-"));
  const personal = await mockNode(() => ({
    delayMs: 140,
    body: {
      records: [
        { record_id: "shared", content: "shared personal copy" },
        { record_id: "personal-only", content: "personal result" },
        { content: "same content without an id" }
      ],
      record_snippets: [{
        session_id: SESSION_ID,
        matched_record_ids: ["shared"],
        records: [{ id: "context-personal", content: "nearby personal context" }]
      }],
      embedding_used: true,
      claims: [
        { claim_id: "shared-claim", content: "personal claim wording", rank: 1 },
        { result_id: "shared-result", content: "personal fallback wording", rank: 2 }
      ]
    }
  }));
  const company = await mockNode(() => ({
    delayMs: 140,
    body: {
      records: [
        { record_id: "company-only", content: "company result" },
        { record_id: "shared", content: "shared company copy" },
        { content: "same   content without an id" }
      ],
      record_snippets: [{
        session_id: SESSION_ID,
        matched_record_ids: ["shared"],
        records: [{ id: "context-company", content: "nearby company context" }]
      }],
      embedding_used: false,
      claims: [
        { claim_id: "shared-claim", content: "company claim wording", rank: 1 },
        { result_id: "shared-result", content: "company fallback wording", rank: 2 }
      ]
    }
  }));
  context.after(async () => {
    await Promise.all([personal.close(), company.close()]);
    await rm(stateDir, { recursive: true, force: true });
  });
  const dispatcher = new MemoryToolDispatcher(new FederatedMemoryRouter({
    nodes: [
      { id: "personal", baseUrl: personal.baseUrl, token: "personal-core-token-0123456789abcdef" },
      { id: "company", baseUrl: company.baseUrl, token: "company-core-token-0123456789abcdef" }
    ],
    stateDir,
    defaultReadTargets: ["personal", "company"]
  }));

  const started = Date.now();
  const result = await dispatcher.callTool("search_records", {
    ...scope(), query: "shared", target: "both", limit: 10
  }) as FederatedResult;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 260, `parallel query took ${elapsed}ms`);
  assert.ok(Math.abs((personal.requests[0]?.receivedAt ?? 0) - (company.requests[0]?.receivedAt ?? 0)) < 80);
  assert.deepEqual(personal.requests[0]?.body, {
    ...scope(), query: "shared", include: ["records"], limit: 10
  });
  assert.equal(result.results.length, 5);
  assert.equal(result.results[0]?.record_id, "shared");
  assert.equal(result.results[0]?.origin_node, "personal");
  assert.deepEqual(result.results[0]?.origin_nodes, ["personal", "company"]);
  assert.deepEqual((result.results[0]?.context_records as JsonObject[]).map((item) => item.id), ["context-personal", "context-company"]);
  assert.ok((result.results[0]?.context_records as JsonObject[]).every((item) => typeof item.origin_node === "string"));
  assert.equal((result.results[0]?.record_snippet as JsonObject | undefined)?.session_id, SESSION_ID);
  assert.equal(result.results.filter((item) => String(item.content).replace(/\s+/g, " ") === "same content without an id").length, 2);
  assert.ok(result.results.every((item) => typeof item.origin_node === "string"));
  assert.equal(result.embedding_used, true);
  assert.deepEqual(result.embedding_used_by_node, { personal: true, company: false });
  assert.equal(result.record_snippets?.length, 2);
  const topSnippetRefs = new Set(result.record_snippets?.map((snippet) => snippet.snippet_ref));
  assert.ok(topSnippetRefs.has((result.results[0]?.record_snippet as JsonObject | undefined)?.snippet_ref));
  const claimResult = await dispatcher.callTool("search_claims", {
    ...scope(), query: "shared", target: "both", limit: 10
  }) as { results: JsonObject[] };
  assert.equal(claimResult.results.length, 3);
  assert.deepEqual(claimResult.results.map((item) => item.origin_nodes), [
    ["personal", "company"], ["personal"], ["company"]
  ]);
});

test("all read tools use the fixed Core endpoints and include selectors", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "neuromem-mcp-test-"));
  const node = await mockNode((request) => {
    if (request.path === "/v1/recall") return {
      body: {
        records: [{ record_id: RECORD_ID, content: "same text", rank: 1 }],
        record_snippets: [{
          session_id: SESSION_ID,
          matched_record_ids: [RECORD_ID],
          records: [{ id: "context-record", content: "nearby context" }]
        }],
        claims: [{ claim_id: CLAIM_ID, content: "same text", rank: 1 }]
      }
    };
    if (request.path.includes("/context")) return { body: { target_record_id: RECORD_ID, records: [] } };
    if (request.path.includes("/evidence")) return { body: { claim: { id: CLAIM_ID }, evidence: [] } };
    if (request.path.includes("/wiki")) return { body: { sections: [] } };
    if (request.path.includes("/graph")) return { body: { nodes: [], edges: [] } };
    return { body: { value: "item" } };
  });
  context.after(async () => {
    await node.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const dispatcher = new MemoryToolDispatcher(new FederatedMemoryRouter({
    nodes: [{ id: "personal", baseUrl: node.baseUrl, token: "core-token-0123456789abcdefghijklmn" }],
    stateDir
  }));

  const recordSearch = await dispatcher.callTool("search_records", { ...scope(), query: "q" }) as { results: JsonObject[] };
  const claimSearch = await dispatcher.callTool("search_claims", { ...scope(), query: "q" }) as { results: JsonObject[] };
  const combined = await dispatcher.callTool("recall", { ...scope(), query: "q" }) as { results: JsonObject[] };
  const contextResult = await dispatcher.callTool("get_record_context", { ...scope(), record_id: RECORD_ID }) as { results: JsonObject[] };
  const evidenceResult = await dispatcher.callTool("get_claim_evidence", { ...scope(), claim_id: CLAIM_ID }) as { results: JsonObject[] };
  const wikiResult = await dispatcher.callTool("wiki_read", scope()) as { results: JsonObject[] };
  const graphResult = await dispatcher.callTool("graph_read", scope()) as { results: JsonObject[] };

  assert.deepEqual(recordSearch.results.map((item) => item.memory_kind), ["record"]);
  assert.deepEqual(claimSearch.results.map((item) => item.memory_kind), ["claim"]);
  assert.deepEqual(combined.results.map((item) => item.memory_kind), ["record", "claim"]);
  assert.equal((recordSearch.results[0]?.context_records as JsonObject[])[0]?.content, "nearby context");
  assert.equal((combined.results[0]?.context_records as JsonObject[])[0]?.content, "nearby context");
  assert.equal(contextResult.results[0]?.target_record_id, RECORD_ID);
  assert.deepEqual(contextResult.results[0]?.records, []);
  assert.deepEqual(evidenceResult.results[0]?.evidence, []);
  assert.deepEqual(wikiResult.results[0]?.sections, []);
  assert.deepEqual(graphResult.results[0]?.nodes, []);

  const query = `workspace_id=${WORKSPACE_ID}&project_id=${PROJECT_ID}`;
  assert.deepEqual(node.requests.map(({ method, path }) => ({ method, path })), [
    { method: "POST", path: "/v1/recall" },
    { method: "POST", path: "/v1/recall" },
    { method: "POST", path: "/v1/recall" },
    { method: "GET", path: `/v1/records/${RECORD_ID}/context?${query}` },
    { method: "GET", path: `/v1/claims/${CLAIM_ID}/evidence?${query}` },
    { method: "GET", path: `/v1/projects/${PROJECT_ID}/wiki?${query}` },
    { method: "GET", path: `/v1/projects/${PROJECT_ID}/graph?${query}` }
  ]);
  assert.deepEqual(node.requests.slice(0, 3).map((request) => request.body?.include), [
    ["records"], ["claims"], ["records", "claims"]
  ]);
});

test("dispatcher rejects missing scope and undeclared arguments", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "neuromem-mcp-test-"));
  const node = await mockNode(() => ({ body: { records: [], claims: [] } }));
  context.after(async () => {
    await node.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const router = new FederatedMemoryRouter({
    nodes: [{ id: "personal", baseUrl: node.baseUrl, token: "core-token-0123456789abcdefghijklmn" }], stateDir
  });
  await router.retryPending({ force: false });
  const dispatcher = new MemoryToolDispatcher(router);
  await assert.rejects(dispatcher.callTool("recall", { project_id: PROJECT_ID, query: "q" }), /workspace_id/);
  await assert.rejects(dispatcher.callTool("wiki_read", { ...scope(), surprise: true }), /unknown argument/);
});

test("environment config supports router objects and safe personal defaults", () => {
  const config = loadRouterConfig({
    NEUROMEM_NODES_JSON: JSON.stringify({
      nodes: [
        { id: "personal", base_url: "http://127.0.0.1:18001", token: "personal-core-token-0123456789abcdef" },
        { id: "company", base_url: "http://127.0.0.1:28001", token: "company-core-token-0123456789abcdef" }
      ],
      state_dir: "/tmp/mcp-state"
    })
  });
  assert.deepEqual(config.defaultReadTargets, ["personal"]);
  assert.deepEqual(config.defaultWriteTargets, ["personal"]);
  assert.equal(config.stateDir, "/tmp/mcp-state");
  assert.equal(config.nodes[1]?.id, "company");
});

test("direct mode is preferred, token-required, and public targets fail closed", async (context) => {
  const direct = loadRouterConfig({
    NEUROMEM_NODE_ID: "018f0f86-4d70-7a3c-8f2c-123456789abc",
    NEUROMEM_NODE_ALIAS: "personal",
    NEUROMEM_CORE_URL: "http://core:8000",
    NEUROMEM_CORE_TOKEN: "core-token-0123456789abcdefghijklmn",
    NEUROMEM_NODES_JSON: JSON.stringify([{ id: "personal", base_url: "http://ignored", token: "ignored" }]),
    NEUROMEM_MCP_STATE_DIR: "/tmp/direct-mcp-state"
  });
  assert.deepEqual(direct.nodes, [{
    id: "personal", baseUrl: "http://core:8000", token: "core-token-0123456789abcdefghijklmn"
  }]);
  assert.throws(() => loadRouterConfig({
    NEUROMEM_NODE_ID: "node-1", NEUROMEM_CORE_URL: "http://core:8000"
  }), /requires NEUROMEM_NODE_ID/);
  assert.throws(() => loadRouterConfig({
    NEUROMEM_NODES_JSON: JSON.stringify([{ id: "personal", base_url: "http://127.0.0.1:18001" }])
  }), /requires a Core token/);
  assert.throws(() => loadRouterConfig({
    NEUROMEM_NODES_JSON: JSON.stringify([{ id: "personal", base_url: "http://127.0.0.1:18001", token: "too-short" }])
  }), /at least 32 bytes/);

  const stateDir = await mkdtemp(join(tmpdir(), "neuromem-mcp-test-"));
  const node = await mockNode(() => ({ body: { sections: [] } }));
  context.after(async () => {
    await node.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const dispatcher = new MemoryToolDispatcher(new FederatedMemoryRouter({
    nodes: [{ id: "personal", baseUrl: node.baseUrl, token: "core-token-0123456789abcdefghijklmn" }], stateDir
  }));
  await assert.rejects(dispatcher.callTool("wiki_read", { ...scope(), target: "company" }), /unavailable/);
  await assert.rejects(dispatcher.callTool("wiki_read", { ...scope(), target: "both" }), /missing node 'company'/);
  const result = await dispatcher.callTool("wiki_read", { ...scope(), target: "personal" }) as { results: JsonObject[] };
  assert.equal(result.results[0]?.origin_node, "personal");
  const directRouter = new FederatedMemoryRouter({ ...direct, stateDir: join(stateDir, "direct") });
  await directRouter.retryPending({ force: false });
  assert.deepEqual(directRouter.targetsFor("personal"), ["personal"]);
  await directRouter.close();

  const companyDirect = loadRouterConfig({
    NEUROMEM_NODE_ID: "018f0f86-4d70-7a3c-8f2c-123456789abd",
    NEUROMEM_NODE_ALIAS: "company",
    NEUROMEM_CORE_URL: "http://core:8000",
    NEUROMEM_CORE_TOKEN: "core-token-0123456789abcdefghijklmn",
  });
  const companyRouter = new FederatedMemoryRouter({ ...companyDirect, stateDir: join(stateDir, "company-direct") });
  assert.deepEqual(companyRouter.targetsFor("company"), ["company"]);
  assert.throws(() => companyRouter.targetsFor("personal"), /unavailable/);
  await companyRouter.close();
});

test("scope maps translate every fanout request and preserve logical provenance", async (context) => {
  const personalWorkspace = "018f0f86-4d71-7a3c-8f2c-123456789abc";
  const personalProject = "018f0f86-4d72-7a3c-8f2c-123456789abc";
  const companyWorkspace = "018f0f86-4d73-7a3c-8f2c-123456789abc";
  const companyProject = "018f0f86-4d74-7a3c-8f2c-123456789abc";
  const stateDir = await mkdtemp(join(tmpdir(), "neuromem-mcp-test-"));
  const handler = (request: CapturedRequest): MockReply => {
    if (request.path === "/v1/records:batch") return { status: 201, body: { ok: true } };
    if (request.path === "/v1/recall") {
      return {
        body: {
          records: [{ record_id: RECORD_ID, content: "mapped result", rank: 1 }],
          record_snippets: [],
          claims: [],
          embedding_used: true
        }
      };
    }
    if (request.path.includes("/wiki")) return { body: { sections: [] } };
    return { status: 404 };
  };
  const personal = await mockNode(handler);
  const company = await mockNode(handler);
  context.after(async () => {
    await Promise.all([personal.close(), company.close()]);
    await rm(stateDir, { recursive: true, force: true });
  });
  const dispatcher = new MemoryToolDispatcher(new FederatedMemoryRouter({
    nodes: [
      {
        id: "personal", baseUrl: personal.baseUrl, token: "personal-core-token-0123456789abcdef",
        scopeMap: { [PROJECT_ID]: { workspace_id: personalWorkspace, project_id: personalProject } }
      },
      {
        id: "company", baseUrl: company.baseUrl, token: "company-core-token-0123456789abcdef",
        scopeMap: { [PROJECT_ID]: { workspace_id: companyWorkspace, project_id: companyProject } }
      }
    ],
    stateDir
  }));
  const written = await dispatcher.callTool("memory_record", {
    ...scope(), session_id: SESSION_ID, author_key: "agent-codex", author_kind: "agent",
    content: "Mapped CASE-sensitive payload", target: "both"
  }) as { deliveries: Record<string, JsonObject> };
  assert.deepEqual(written.deliveries.personal?.origin_scope, { workspace_id: personalWorkspace, project_id: personalProject });
  assert.deepEqual(written.deliveries.company?.origin_scope, { workspace_id: companyWorkspace, project_id: companyProject });
  assert.equal(((personal.requests[0]?.body?.records as JsonObject[])[0]?.content), "Mapped CASE-sensitive payload");
  assert.deepEqual(
    { workspace_id: personal.requests[0]?.body?.workspace_id, project_id: personal.requests[0]?.body?.project_id },
    { workspace_id: personalWorkspace, project_id: personalProject }
  );
  assert.deepEqual(
    { workspace_id: company.requests[0]?.body?.workspace_id, project_id: company.requests[0]?.body?.project_id },
    { workspace_id: companyWorkspace, project_id: companyProject }
  );

  const recalled = await dispatcher.callTool("search_records", {
    ...scope(), query: "Mapped", target: "both"
  }) as FederatedResult;
  assert.deepEqual(personal.requests[1]?.body?.workspace_id, personalWorkspace);
  assert.deepEqual(company.requests[1]?.body?.project_id, companyProject);
  assert.deepEqual(recalled.results[0]?.logical_scope, LOGICAL_SCOPE);
  assert.deepEqual(recalled.results[0]?.origin_scope, { workspace_id: personalWorkspace, project_id: personalProject });

  const wiki = await dispatcher.callTool("wiki_read", { ...scope(), target: "both" }) as FederatedResult;
  assert.match(personal.requests[2]?.path ?? "", new RegExp(`/projects/${personalProject}/wiki`));
  assert.match(company.requests[2]?.path ?? "", new RegExp(`/projects/${companyProject}/wiki`));
  assert.deepEqual(wiki.results.map((item) => item.origin_scope), [
    { workspace_id: personalWorkspace, project_id: personalProject },
    { workspace_id: companyWorkspace, project_id: companyProject }
  ]);
});

test("idempotency keys and caller UUIDv7 values reuse one global record id", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "neuromem-mcp-test-"));
  const node = await mockNode(() => ({ status: 201, body: { ok: true } }));
  context.after(async () => {
    await node.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const dispatcher = new MemoryToolDispatcher(new FederatedMemoryRouter({
    nodes: [{ id: "personal", baseUrl: node.baseUrl, token: "core-token-0123456789abcdefghijklmn" }], stateDir
  }));
  const firstInput = {
    ...scope(), session_id: SESSION_ID, author_key: "agent-codex", author_kind: "agent",
    content: "Keep My CASE", metadata: { z: 1, a: 2 }, idempotency_key: "event-1"
  };
  const first = await dispatcher.callTool("memory_record", firstInput) as { record_id: string };
  const second = await dispatcher.callTool("memory_record", {
    ...firstInput, metadata: { a: 2, z: 1 }
  }) as { record_id: string };
  assert.equal(second.record_id, first.record_id);
  assert.equal(((node.requests[1]?.body?.records as JsonObject[])[0]?.content), "Keep My CASE");
  await assert.rejects(dispatcher.callTool("memory_record", { ...firstInput, content: "different" }), /different payload/);

  const explicitId = uuid7();
  const bound = await dispatcher.callTool("memory_record", {
    ...scope(), session_id: SESSION_ID, record_id: explicitId.toUpperCase(), idempotency_key: "event-2",
    author_key: "agent-codex", author_kind: "agent", content: "explicit"
  }) as { record_id: string };
  assert.equal(bound.record_id, explicitId);
  await assert.rejects(dispatcher.callTool("memory_record", {
    ...scope(), session_id: SESSION_ID, record_id: uuid7(), idempotency_key: "event-2",
    author_key: "agent-codex", author_kind: "agent", content: "explicit"
  }), /conflicts with idempotency_key/);
  await assert.rejects(dispatcher.callTool("memory_record", {
    ...scope(), session_id: SESSION_ID, record_id: 123, author_key: "agent-codex", author_kind: "agent", content: "bad"
  }), /record_id/);
  const idempotencyFiles = await stateFiles(join(stateDir, "idempotency"));
  const registryText = (await Promise.all(idempotencyFiles.map((path) => readFile(path, "utf8")))).join("\n");
  assert.equal(registryText.includes("event-1"), false);
});

test("two queue instances do not lose concurrent durable entries", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "neuromem-mcp-queue-test-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  const left = new DurableRetryQueue(stateDir);
  const right = new DurableRetryQueue(stateDir);
  await Promise.all([left.initialize(), right.initialize()]);
  await Promise.all(Array.from({ length: 40 }, (_, index) => {
    const recordId = uuid7();
    return (index % 2 === 0 ? left : right).enqueueRecord({ record_id: recordId, index }, ["personal"]);
  }));
  const queue = JSON.parse(await readFile(join(stateDir, "retry-queue.json"), "utf8") as string) as unknown[];
  assert.equal(queue.length, 40);
  assert.equal((await readdir(join(stateDir, "records"))).length, 40);
});

test("queue initialization immediately reclaims an abandoned process lock", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "neuromem-mcp-abandoned-lock-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  const lockDir = join(stateDir, ".retry-queue.lock");
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, "owner.json"), JSON.stringify({ owner: "dead", pid: 999_999 }));
  const started = Date.now();
  await new DurableRetryQueue(stateDir).initialize();
  assert.ok(Date.now() - started < 2_000);
  assert.deepEqual(JSON.parse(await readFile(join(stateDir, "retry-queue.json"), "utf8")), []);
});

test("Core timeout covers a stalled response body", async (context) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.flushHeaders();
    const timer = setTimeout(() => response.end("{}"), 1_000);
    response.on("close", () => clearTimeout(timer));
  });
  const baseUrl = await new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  }));
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const client = new CoreClient({ id: "personal", baseUrl, token: "core-token-0123456789abcdefghijklmn" }, 50);
  await assert.rejects(client.request("GET", "/stall"), (error: unknown) => (
    error instanceof CoreRequestError && error.code === "timeout"
  ));
});
