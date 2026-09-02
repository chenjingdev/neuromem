import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { AdminServer } from "../src/admin-server.js";
import { ManagerClient } from "../src/client.js";
import { uuid7 } from "../src/fs-safe.js";
import { NodeManager } from "../src/node-manager.js";
import { NodeDeploymentManager } from "../src/node-deployment-manager.js";
import { FakeRunner, fakeCodex, freePort, okFetch, temporaryPaths, threeFreePorts } from "./helpers.js";

test("Admin HTTP survives independently, exchanges one-time auth, and protects API routes", async t => {
  const { home, paths } = await temporaryPaths();
  const web = path.join(home, "web");
  await fs.mkdir(path.join(web, "assets"), { recursive: true });
  await fs.writeFile(path.join(web, "index.html"), "<h1>admin shell</h1>");
  await fs.writeFile(path.join(web, "assets", "app-123.js"), "console.log('ok')");
  await fs.writeFile(path.join(home, "secret.txt"), "must-not-leak");
  const port = await freePort();
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner: new FakeRunner(), fetch: okFetch() });
  const server = new AdminServer({ manager, paths, port, webDist: web });
  await server.start();
  t.after(async () => { await server.stop(); await fs.rm(home, { recursive: true, force: true }); });
  assert.equal((await fs.stat(paths.socket)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(paths.adminToken)).mode & 0o777, 0o600);

  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/v1/nodes`, { headers: { origin: base } })).status, 401);

  const client = new ManagerClient(paths);
  const bootstrap = await client.request<{ token: string }>("POST", "/v1/admin/bootstrap", {});
  assert.equal((await fetch(`${base}/v1/admin/session`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: bootstrap.token }),
  })).status, 403);
  const exchange = await fetch(`${base}/v1/admin/session`, {
    method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ token: bootstrap.token }),
  });
  assert.equal(exchange.status, 200);
  const cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
  assert.match(exchange.headers.get("set-cookie")!, /HttpOnly/);
  assert.match(exchange.headers.get("set-cookie")!, /SameSite=Strict/);
  assert.equal((await fetch(`${base}/v1/nodes`, { headers: { origin: base, cookie } })).status, 200);
  assert.equal((await fetch(`${base}/v1/admin/session`, {
    method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ token: bootstrap.token }),
  })).status, 400);
  assert.equal((await fetch(`${base}/v1/nodes`, { headers: { origin: "http://evil.invalid", cookie } })).status, 403);
});

test("Admin static server denies traversal and applies immutable cache only to assets", async t => {
  const { home, paths } = await temporaryPaths();
  const web = path.join(home, "web");
  await fs.mkdir(path.join(web, "assets"), { recursive: true });
  await fs.writeFile(path.join(web, "index.html"), '<script type="module" src="./assets/app-abc.js"></script>');
  await fs.writeFile(path.join(web, "assets", "app-abc.js"), "asset-body");
  await fs.writeFile(path.join(home, "secret.txt"), "secret-body");
  await fs.symlink(path.join(home, "secret.txt"), path.join(web, "assets", "escape.js"));
  const port = await freePort();
  const server = new AdminServer({ manager: new NodeManager({ codex: fakeCodex(), paths, runner: new FakeRunner(), fetch: okFetch() }), paths, port, webDist: web });
  await server.start();
  t.after(async () => { await server.stop(); await fs.rm(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const redirect = await fetch(`${base}/admin`, { redirect: "manual" });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), "/admin/");
  const index = await fetch(`${base}/admin/`);
  assert.match(await index.text(), /\.\/assets\/app-abc\.js/);
  assert.equal(index.headers.get("cache-control"), "no-store");
  const assetUrl = new URL("./assets/app-abc.js", index.url);
  assert.equal(assetUrl.pathname, "/admin/assets/app-abc.js");
  const asset = await fetch(assetUrl);
  assert.equal(await asset.text(), "asset-body");
  assert.match(asset.headers.get("content-type")!, /text\/javascript/);
  assert.match(asset.headers.get("cache-control")!, /immutable/);
  const traversal = await fetch(`${base}/admin/%2e%2e/secret.txt`);
  assert.notEqual(await traversal.text(), "secret-body");
  const symlink = await fetch(`${base}/admin/assets/escape.js`);
  assert.equal(symlink.status, 403);
  assert.doesNotMatch(await symlink.text(), /secret-body/);
});

test("Admin model selection routes require a browser session and reject unlisted names", async t => {
  const { home, paths } = await temporaryPaths();
  const port = await freePort();
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner: new FakeRunner(), fetch: okFetch() });
  const server = new AdminServer({ manager, paths, port });
  await server.start();
  t.after(async () => { await server.stop(); await fs.rm(home, { recursive: true, force: true }); });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "model-admin", ports: await threeFreePorts() });
  const base = `http://127.0.0.1:${port}`;
  const endpoint = `${base}/v1/nodes/${nodeId}/models`;
  assert.equal((await fetch(endpoint, { headers: { origin: base } })).status, 401);
  assert.equal((await fetch(endpoint, {
    method: "POST", headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ generation_model: "missing" }),
  })).status, 401);

  const client = new ManagerClient(paths);
  const bootstrap = await client.request<{ token: string }>("POST", "/v1/admin/bootstrap", { node_id: nodeId });
  const exchange = await fetch(`${base}/v1/admin/session`, {
    method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ token: bootstrap.token }),
  });
  const cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
  const models = await fetch(endpoint, { headers: { origin: base, cookie } });
  assert.equal(models.status, 200);
  assert.equal((await models.json() as { node_id: string }).node_id, nodeId);
  const invalid = await fetch(endpoint, {
    method: "POST", headers: { origin: base, cookie, "content-type": "application/json" },
    body: JSON.stringify({ generation_model: "missing" }),
  });
  assert.equal(invalid.status, 400);
  assert.doesNotMatch(await invalid.text(), /EMBEDDING_API_KEY|GENERATION_API_KEY|host\.docker\.internal/);
});

test("internal Codex bridge binds bearer authorization to one Node and returns an allowed JSON completion", async t => {
  const { home, paths } = await temporaryPaths();
  const port = await freePort();
  const codex = fakeCodex();
  const manager = new NodeManager({ codex, paths, runner: new FakeRunner(), fetch: okFetch(), managerPort: port });
  const server = new AdminServer({ manager, paths, port });
  await server.start();
  t.after(async () => { await server.stop(); await fs.rm(home, { recursive: true, force: true }); });

  const nodeId = uuid7();
  const otherNodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "codex-bridge", ports: await threeFreePorts() });
  await manager.createNode({ node_id: otherNodeId, confirmation: otherNodeId, alias: "other-bridge", ports: await threeFreePorts() });
  const selected = await manager.selectModels(nodeId, {
    generation: { source: "codex_session", model: "gpt-5.6-terra" },
  });
  assert.equal(selected.state, "succeeded", selected.error);
  codex.requests.length = 0;

  const nodeEnv = await fs.readFile(`${paths.nodes}/${nodeId}/.env`, "utf8");
  const otherNodeEnv = await fs.readFile(`${paths.nodes}/${otherNodeId}/.env`, "utf8");
  const nodeToken = envValue(nodeEnv, "API_TOKEN");
  const otherNodeToken = envValue(otherNodeEnv, "API_TOKEN");
  assert.notEqual(nodeToken, otherNodeToken);
  const endpoint = `http://127.0.0.1:${port}/v1/internal/codex/nodes/${nodeId}/chat/completions`;
  const schema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  };
  const requestBody = {
    model: "gpt-5.6-terra",
    messages: [
      { role: "system", content: "Return structured JSON." },
      { role: "user", content: "Confirm the bridge." },
    ],
    response_format: { type: "json_schema", json_schema: { name: "bridge_probe", strict: true, schema } },
    temperature: 0,
    stream: false,
  };
  const post = (authorization: string) => fetch(endpoint, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  const wrong = await post("Bearer definitely-not-the-node-token");
  assert.equal(wrong.status, 401);
  assert.doesNotMatch(await wrong.text(), new RegExp(`${escapeRegExp(nodeToken)}|${escapeRegExp(otherNodeToken)}`));
  const crossNode = await post(`Bearer ${otherNodeToken}`);
  assert.equal(crossNode.status, 401);
  assert.doesNotMatch(await crossNode.text(), new RegExp(`${escapeRegExp(nodeToken)}|${escapeRegExp(otherNodeToken)}`));

  const allowed = await post(`Bearer ${nodeToken}`);
  assert.equal(allowed.status, 200);
  const completion = await allowed.json() as {
    model: string;
    choices: Array<{ message: { role: string; content: string } }>;
  };
  assert.equal(completion.model, "gpt-5.6-terra");
  assert.equal(completion.choices[0]?.message.role, "assistant");
  assert.deepEqual(JSON.parse(completion.choices[0]!.message.content), { ok: true });
  assert.deepEqual(codex.requests, [{
    model: "gpt-5.6-terra",
    messages: requestBody.messages,
    output_schema: schema,
  }]);
  assert.doesNotMatch(JSON.stringify(completion), new RegExp(`${escapeRegExp(nodeToken)}|${escapeRegExp(otherNodeToken)}`));
});

test("Admin exposes the single physical deployment Node and its compute sources", async t => {
  const { home, paths } = await temporaryPaths();
  const deploymentDir = path.join(home, "deployment");
  await fs.mkdir(deploymentDir, { recursive: true });
  await fs.writeFile(path.join(deploymentDir, "compose.yaml"), "services: {}\n");
  await fs.mkdir(paths.node, { recursive: true });
  const bridgeToken = "bridge-" + "x".repeat(40);
  await fs.writeFile(paths.nodeEnv, physicalNodeEnv(bridgeToken), { mode: 0o600 });
  await fs.chmod(paths.nodeEnv, 0o600);
  const port = await freePort();
  const runner = new FakeRunner();
  const deploymentCodex = fakeCodex();
  const modelFetch: typeof fetch = (async input => {
    const url = String(input);
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "qwen3-embedding" }, { id: "gpt-5.6-terra" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: "ok", provider: "openai-codex", default_model: "gpt-5.6-terra" }), { status: 200 });
  }) as typeof fetch;
  const legacy = new NodeManager({ codex: fakeCodex(), paths, runner, fetch: okFetch() });
  const deployment = new NodeDeploymentManager({ paths, runner, deploymentDir, managerPort: port, codex: deploymentCodex, fetch: modelFetch });
  const server = new AdminServer({ manager: legacy, deployment, paths, port });
  await server.start();
  t.after(async () => { await server.stop(); await fs.rm(home, { recursive: true, force: true }); });

  const client = new ManagerClient(paths);
  const bootstrap = await client.request<{ token: string }>("POST", "/v1/admin/bootstrap", {});
  const base = `http://127.0.0.1:${port}`;
  const exchange = await fetch(`${base}/v1/admin/session`, {
    method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ token: bootstrap.token }),
  });
  const cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
  const nodes = await fetch(`${base}/v1/nodes`, { headers: { origin: base, cookie } }).then(response => response.json()) as { nodes: Array<{ node_id: string }> };
  assert.deepEqual(nodes.nodes.map(node => node.node_id), ["physical-node"]);
  const models = await fetch(`${base}/v1/nodes/physical-node/models`, { headers: { origin: base, cookie } }).then(response => response.json()) as { node_id: string; generation: { active_source: string } };
  assert.equal(models.node_id, "physical-node");
  assert.equal(models.generation.active_source, "codex_session");

  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
  const completion = await fetch(`${base}/v1/internal/codex/nodes/physical-node/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${bridgeToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-terra",
      messages: [{ role: "user", content: "Return JSON" }],
      response_format: { type: "json_schema", json_schema: { schema } },
    }),
  });
  assert.equal(completion.status, 200);
  assert.deepEqual(JSON.parse((await completion.json() as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content), { ok: true });
  assert.doesNotMatch(JSON.stringify(models), new RegExp(escapeRegExp(bridgeToken)));
});

test("CLI-only Node creation is unreachable over TCP", async t => {
  const { home, paths } = await temporaryPaths();
  const port = await freePort();
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner: new FakeRunner(), fetch: okFetch() });
  const server = new AdminServer({ manager, paths, port });
  await server.start();
  t.after(async () => { await server.stop(); await fs.rm(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const client = new ManagerClient(paths);
  const bootstrap = await client.request<{ token: string }>("POST", "/v1/admin/bootstrap", {});
  const exchange = await fetch(`${base}/v1/admin/session`, {
    method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ token: bootstrap.token }),
  });
  const cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
  const nodeId = uuid7();
  const response = await fetch(`${base}/v1/cli/nodes`, {
    method: "POST", headers: { origin: base, cookie, "content-type": "application/json" },
    body: JSON.stringify({ node_id: nodeId, confirmation: nodeId, alias: "personal", ports: await threeFreePorts() }),
  });
  assert.equal(response.status, 404);
  const apply = await fetch(`${base}/v1/cli/nodes/${nodeId}/restore/apply`, {
    method: "POST", headers: { origin: base, cookie, "content-type": "application/json" },
    body: JSON.stringify({ backup_id: uuid7(), confirmation: nodeId }),
  });
  assert.equal(apply.status, 404);
  const models = await fetch(`${base}/v1/cli/nodes/${nodeId}/models/configure`, {
    method: "POST", headers: { origin: base, cookie, "content-type": "application/json" },
    body: JSON.stringify({ generation_base_url: "http://127.0.0.1:11434/v1", generation_model: "qwen3:4b" }),
  });
  assert.equal(models.status, 404);
});

test("a second daemon cannot remove or replace the active Manager socket", async t => {
  const { home, paths } = await temporaryPaths();
  const port = await freePort();
  const first = new AdminServer({ manager: new NodeManager({ codex: fakeCodex(), paths, runner: new FakeRunner(), fetch: okFetch() }), paths, port });
  await first.start();
  t.after(async () => { await first.stop(); await fs.rm(home, { recursive: true, force: true }); });
  const second = new AdminServer({ manager: new NodeManager({ codex: fakeCodex(), paths, runner: new FakeRunner(), fetch: okFetch() }), paths, port });
  await assert.rejects(second.start(), /already running|already starting/);
  assert.equal((await fs.stat(paths.socket)).mode & 0o777, 0o600);
  assert.equal((await new ManagerClient(paths).health()).ok, true);
});

function envValue(source: string, key: string): string {
  const match = source.match(new RegExp(`^${escapeRegExp(key)}=(.*)$`, "m"));
  assert.ok(match, `Missing ${key} in the Node environment`);
  const value = match[1]!;
  return value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\")
    : value;
}

function physicalNodeEnv(bridgeToken: string): string {
  const secret = "s".repeat(40);
  return [
    "COMPOSE_PROJECT_NAME=neuromem-node",
    "NEUROMEM_NODE_ID=physical-node",
    "NEUROMEM_PUBLIC_HOST=localhost",
    "EDGE_LOOPBACK_PORT=24443",
    "CONTROL_POSTGRES_DB=neuromem_control",
    "CONTROL_POSTGRES_USER=neuromem_control",
    `CONTROL_POSTGRES_PASSWORD=${secret}`,
    `CONTROL_TOKEN_PEPPER=${secret}`,
    `CONTROL_INTERNAL_SIGNING_KEY=${secret}`,
    "MEMORY_POSTGRES_DB=neuromem_memory",
    "MEMORY_POSTGRES_USER=neuromem_memory",
    `MEMORY_POSTGRES_PASSWORD=${secret}`,
    `MEMORY_REDIS_PASSWORD=${secret}`,
    `MEMORY_INTERNAL_SIGNING_KEY=${secret}`,
    `MEMORY_AUTH_JWT_SECRET=${secret}`,
    `MEMORY_CORE_IMAGE=example.test/core@sha256:${"a".repeat(64)}`,
    "MEMORY_CORE_SOURCE_URL=https://example.test/core",
    "MEMORY_CORE_SOURCE_REVISION=abcdef1",
    "EMBEDDING_BASE_URL=http://host.docker.internal:11434/v1",
    "EMBEDDING_API_KEY=local-model",
    "EMBEDDING_MODEL=qwen3-embedding",
    "GENERATION_SOURCE=codex_session",
    "GENERATION_BASE_URL=http://host.docker.internal:14174/v1/internal/codex/nodes/physical-node",
    `GENERATION_API_KEY=${bridgeToken}`,
    "GENERATION_MODEL=gpt-5.6-terra",
    `NODE_CODEX_BRIDGE_TOKEN=${bridgeToken}`,
    "GENERATION_DIRECT_BASE_URL=",
    "GENERATION_DIRECT_API_KEY=",
    "GENERATION_DIRECT_MODEL=",
    "CONTROL_DB_VOLUME=neuromem-node-control-db",
    "MEMORY_DB_VOLUME=neuromem-node-memory-db",
    "MEMORY_REDIS_VOLUME=neuromem-node-memory-redis",
    "MCP_STATE_VOLUME=neuromem-node-mcp",
    "DGX_MODEL_ENABLED=false",
    "",
  ].join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
