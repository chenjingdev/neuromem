import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import { uuid7 } from "../src/fs-safe.js";
import { NodeManager } from "../src/node-manager.js";
import { FakeRunner, fakeCodex, freePort, okFetch, temporaryPaths, threeFreePorts } from "./helpers.js";

test("create writes private per-Node runtime and status recognizes the deployed service names", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const runner = new FakeRunner();
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner, fetch: okFetch(), startTimeoutMs: 50 });
  const nodeId = uuid7();
  const ports = await threeFreePorts();
  const created = await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "test", ports });
  assert.equal(created.state, "succeeded");
  const envPath = `${paths.nodes}/${nodeId}/.env`;
  assert.equal((await fs.stat(envPath)).mode & 0o777, 0o600);
  const env = await fs.readFile(envPath, "utf8");
  assert.match(env, /POSTGRES_IMAGE=pgvector\/pgvector:0\.8\.6-pg15/);
  assert.match(env, /EMBEDDING_BASE_URL=http:\/\/host\.docker\.internal:11434\/v1/);
  assert.match(env, /EMBEDDING_MODEL=qwen3-embedding:4b/);
  assert.match(env, /EMBEDDING_SEND_DIMENSIONS=false/);
  assert.doesNotMatch(JSON.stringify(created), /POSTGRES_PASSWORD|API_TOKEN|MCP_TOKEN/);
  assert.equal((await manager.store.findNode(nodeId)).schema_revision, "uninitialized");
  assert.equal((await manager.start(nodeId)).state, "succeeded");
  assert.equal((await manager.store.findNode(nodeId)).schema_revision, "0001_initial");
  const status = await manager.status(nodeId);
  assert.equal(status.phase, "ready");
  assert.deepEqual(status.components.map(component => component.name), ["database", "core", "worker", "mcp", "web"]);
});

test("status exposes detailed model health without exposing provider secrets", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const embeddingSecret = "embedding-provider-secret";
  const extractionSecret = "extraction-provider-secret";
  const probedAt = "2026-08-31T01:02:03+00:00";
  const readiness = (async () => new Response(JSON.stringify({
    status: "degraded",
    database: true,
    embedding_configured: true,
    extraction_configured: true,
    embedding_provider_status: "error",
    embedding_provider_detail: `probe rejected ${embeddingSecret}`,
    embedding_last_probe_at: probedAt,
    extraction_provider_status: "ready",
    extraction_provider_detail: `Bearer ${extractionSecret} accepted`,
    extraction_last_probe_at: probedAt,
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner: new FakeRunner(), fetch: readiness, startTimeoutMs: 50 });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "model-health", ports: await threeFreePorts() });
  const configured = await manager.configureModels(nodeId, {
    embedding_api_key: embeddingSecret,
    embedding_model: "qwen3-embedding:4b",
    generation_base_url: "http://host.docker.internal:11434/v1",
    generation_api_key: extractionSecret,
    generation_model: "gpt-oss:20b",
  });
  assert.equal(configured.state, "succeeded", configured.error);
  assert.equal((await manager.start(nodeId)).phase, "degraded");

  const status = await manager.status(nodeId);
  assert.deepEqual(status.models, {
    embedding: {
      configured: true,
      model: "qwen3-embedding:4b",
      provider_status: "error",
      provider_detail: "probe rejected [redacted]",
      last_probe_at: probedAt,
    },
    extraction: {
      configured: true,
      model: "gpt-oss:20b",
      provider_status: "ready",
      provider_detail: "Bearer [redacted] accepted",
      last_probe_at: probedAt,
    },
  });
  assert.doesNotMatch(JSON.stringify(status), new RegExp(`${embeddingSecret}|${extractionSecret}`));
  assert.equal(Object.hasOwn(status.models!.embedding, "api_key"), false);
  assert.equal(Object.hasOwn(status.models!.extraction, "api_key"), false);
});

test("port selection never silently increments a conflicting port", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner: new FakeRunner(), fetch: okFetch() });
  const first = uuid7();
  const ports = await threeFreePorts();
  await manager.createNode({ node_id: first, confirmation: first, alias: "one", ports });
  const second = uuid7();
  await assert.rejects(
    manager.createNode({ node_id: second, confirmation: second, alias: "two", ports }),
    /already assigned/,
  );
});

test("stop never reports success when Compose failed to stop the Node", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const runner = new FakeRunner();
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner, fetch: okFetch(), startTimeoutMs: 50 });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "stop", ports: await threeFreePorts() });
  await manager.start(nodeId);
  runner.fail = (_command, args) => args.includes("stop");
  const stopped = await manager.stop(nodeId);
  assert.equal(stopped.state, "failed");
  assert.equal((await manager.store.findNode(nodeId)).desired_state, "stopped");
});

test("backup is finalized only after checksum and archive verification", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner: new FakeRunner(), fetch: okFetch() });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "backup", ports: await threeFreePorts() });
  await manager.start(nodeId);
  const operation = await manager.backupCreate(nodeId, "before-change");
  assert.equal(operation.state, "succeeded");
  const manifest = operation.result as {
    backup_id: string; label: string; sha256: string; verified: boolean; schema_revision: string;
    row_counts: Record<string, number>; vector_columns: Record<string, { type: string; dimensions: number }>;
  };
  assert.equal(manifest.label, "before-change");
  assert.equal(manifest.verified, true);
  assert.match(manifest.sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.schema_revision, "0001_initial");
  assert.equal(manifest.row_counts.records, 0);
  assert.deepEqual(manifest.vector_columns.record_embeddings, { type: "halfvec(2560)", dimensions: 2560 });
  const listed = await manager.listBackups(nodeId);
  assert.equal(listed.backups.length, 1);
  assert.equal((await manager.backupVerify(nodeId, manifest.backup_id)).state, "succeeded");
  assert.equal((await fs.readdir(`${paths.nodes}/${nodeId}/backups`)).some(name => name.startsWith(".partial-")), false);
});

for (const pendingState of ["dangling-queue", "dangling-spool"] as const) {
  test(`backup fails closed for MCP ${pendingState}`, async t => {
    const { home, paths } = await temporaryPaths();
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    class PendingMcpRunner extends FakeRunner {
      override async run(command: string, args: readonly string[], options = {}) {
        if (args[0] === "volume" && args[1] === "inspect" && String(args[2]).endsWith("-mcp")) {
          return { ok: true, code: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "run" && args.some(value => value.includes("/state/retry-queue.json"))) {
          this.calls.push({ command, args: [...args], options });
          return { ok: false, code: 1, stdout: "", stderr: pendingState };
        }
        return super.run(command, args, options);
      }
    }
    const runner = new PendingMcpRunner();
    const manager = new NodeManager({ codex: fakeCodex(), paths, runner, fetch: okFetch(), startTimeoutMs: 50 });
    const nodeId = uuid7();
    await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: pendingState, ports: await threeFreePorts() });
    await manager.start(nodeId);
    const backup = await manager.backupCreate(nodeId, "blocked");
    assert.equal(backup.state, "failed");
    assert.match(backup.error || "", /pending undelivered records/);
    assert.deepEqual((await manager.listBackups(nodeId)).backups, []);
    const shell = runner.calls.find(call => call.args[0] === "run" && call.args.some(value => value.includes("/state/retry-queue.json")))?.args.at(-1) || "";
    assert.match(shell, /^set -eu;/);
    assert.match(shell, /retry-queue\.json/);
    assert.match(shell, /find \/state\/records/);
  });
}

test("restore apply stages a new generation, verifies it, and preserves the previous volume", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const runner = new FakeRunner();
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner, fetch: okFetch(), startTimeoutMs: 50 });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "restore", ports: await threeFreePorts() });
  await manager.start(nodeId);
  const backup = await manager.backupCreate(nodeId, "source");
  const backupId = (backup.result as { backup_id: string }).backup_id;
  const restored = await manager.restoreApply(nodeId, backupId, nodeId);
  assert.equal(restored.state, "succeeded", restored.error);
  const node = await manager.store.findNode(nodeId);
  assert.equal(node.generation, 2);
  const env = await fs.readFile(`${paths.nodes}/${nodeId}/.env`, "utf8");
  assert.match(env, new RegExp(`DB_VOLUME_NAME=neuromem-${nodeId.replaceAll("-", "")}-pg-g2`));
  assert.equal(runner.calls.some(call => call.args[0] === "volume" && call.args[1] === "rm"), false);
  const finalDump = lastIndexWhere(runner.calls, call => call.args.includes("pg_dump"));
  const stageRestore = runner.calls.findIndex((call, index) => index > finalDump && call.args[0] === "exec" && call.args.includes("pg_restore"));
  const writerStop = lastIndexWhere(runner.calls, (call, index) => index < finalDump && call.args.includes("stop") && call.args.includes("worker") && call.args.includes("core"));
  assert.ok(writerStop >= 0 && writerStop < finalDump && finalDump < stageRestore);
  assert.equal(runner.calls.slice(finalDump + 1, stageRestore).some(call => call.args.includes("up")), false, "writers restarted during restore staging");
});

test("transactional migration records the verified revision rather than the head alias", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const runner = new FakeRunner();
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner, fetch: okFetch(), startTimeoutMs: 50 });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "migration", ports: await threeFreePorts() });
  await manager.start(nodeId);
  const result = await manager.migrationApply(nodeId, "head", nodeId, "transactional");
  assert.equal(result.state, "succeeded", result.error);
  assert.equal((await manager.store.findNode(nodeId)).schema_revision, "0001_initial");
  const finalDump = lastIndexWhere(runner.calls, call => call.args.includes("pg_dump"));
  const migration = runner.calls.findIndex((call, index) => index > finalDump && call.args.includes("migrate") && !call.args.includes("--verify"));
  const writerStop = lastIndexWhere(runner.calls, (call, index) => index < finalDump && call.args.includes("stop") && call.args.includes("worker") && call.args.includes("core"));
  assert.ok(writerStop >= 0 && writerStop < finalDump && finalDump < migration);
  assert.equal(runner.calls.slice(finalDump + 1, migration).some(call => call.args.includes("up")), false, "writers restarted before migration consumed the final dump");
});

test("schema mismatch is reported as maintenance instead of an undifferentiated crash", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  class MismatchRunner extends FakeRunner {
    override async run(command: string, args: readonly string[], options = {}) {
      if (args.includes("migrate") && args.includes("--verify")) {
        return { ok: false, code: 1, stdout: "schema revision is 0001, expected 0002", stderr: "" };
      }
      return super.run(command, args, options);
    }
  }
  const unavailableReady = (async (input: string | URL | Request) => {
    return new Response("{}", { status: String(input).endsWith("/ready") ? 503 : 200 });
  }) as typeof fetch;
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner: new MismatchRunner(), fetch: unavailableReady });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "schema", ports: await threeFreePorts() });
  await manager.store.updateNode(nodeId, node => { node.desired_state = "running"; });
  assert.equal((await manager.status(nodeId)).phase, "maintenance");
});

test("model-unconfigured Node and restored generation remain operational but degraded", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const degradedFetch = (async () => new Response(JSON.stringify({
    status: "degraded", database: true, embedding_configured: false, extraction_configured: false,
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner: new FakeRunner(), fetch: degradedFetch, startTimeoutMs: 50 });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "degraded", ports: await threeFreePorts() });
  const started = await manager.start(nodeId);
  assert.equal(started.state, "succeeded", started.error);
  assert.equal(started.phase, "degraded");
  assert.equal((await manager.store.findNode(nodeId)).schema_revision, "0001_initial");
  const backup = await manager.backupCreate(nodeId, "degraded");
  const restored = await manager.restoreApply(nodeId, (backup.result as { backup_id: string }).backup_id, nodeId);
  assert.equal(restored.state, "succeeded", restored.error);
  assert.equal((await manager.store.findNode(nodeId)).phase, "degraded");
});

test("a later healthy probe synchronizes the registry phase used by Node lists", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let providersReady = false;
  const changingHealth = (async () => new Response(JSON.stringify({
    status: providersReady ? "ok" : "degraded",
    database: true,
    embedding_configured: true,
    extraction_configured: true,
    embedding_provider_status: providersReady ? "ready" : "configured",
    extraction_provider_status: providersReady ? "ready" : "configured",
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner: new FakeRunner(), fetch: changingHealth, startTimeoutMs: 50 });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "health-sync", ports: await threeFreePorts() });
  assert.equal((await manager.start(nodeId)).phase, "degraded");
  providersReady = true;
  assert.equal((await manager.status(nodeId)).phase, "ready");
  assert.equal((await manager.listNodes()).find(node => node.node_id === nodeId)?.phase, "ready");
});

test("CLI-only model configuration upgrades a degraded Node without exposing provider keys", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const nodeId = uuid7();
  const readiness = (async () => {
    const env = await fs.readFile(`${paths.nodes}/${nodeId}/.env`, "utf8").catch(() => "");
    const value = (key: string) => env.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.replace(/^"|"$/g, "") || "";
    const configured = Boolean(value("GENERATION_BASE_URL") && value("GENERATION_MODEL"));
    return new Response(JSON.stringify({
      status: configured ? "ok" : "degraded",
      database: true,
      embedding_configured: true,
      extraction_configured: configured,
      embedding_provider_status: "ready",
      extraction_provider_status: configured ? "ready" : "unconfigured",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner: new FakeRunner(), fetch: readiness, startTimeoutMs: 50 });
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "models", ports: await threeFreePorts() });
  assert.equal((await manager.start(nodeId)).phase, "degraded");
  const secret = "provider-key-never-in-operation-journal";
  const configured = await manager.configureModels(nodeId, {
    generation_base_url: "http://host.docker.internal:11434/v1",
    generation_api_key: secret,
    generation_model: "qwen3:4b",
  });
  assert.equal(configured.state, "succeeded", configured.error);
  assert.equal(configured.phase, "ready");
  assert.doesNotMatch(JSON.stringify(configured), new RegExp(secret));
  assert.equal((await manager.store.findNode(nodeId)).phase, "ready");
  const env = await fs.readFile(`${paths.nodes}/${nodeId}/.env`, "utf8");
  assert.match(env, /^GENERATION_MODEL=qwen3:4b$/m);
  assert.match(env, new RegExp(`^GENERATION_API_KEY=${secret}$`, "m"));
});

test("Admin model selection discovers role-safe options without exposing provider configuration", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const secret = "catalog-secret-never-returned";
  const catalogFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return new Response(JSON.stringify({
      data: [
        { id: "qwen3-embedding:8b" },
        { id: "qwen3-embedding-honcho-8192:latest" },
        { id: "embeddinggemma:300m" },
        { id: "snowflake-arctic-embed2" },
        { id: "gpt-oss:20b" },
        { id: `leak-${secret}-suffix` },
        { id: "catalog-secr" },
        { id: "host.docker.internal" },
        { id: "http://host.docker.internal:11434/v1" },
        { id: "bad model name" },
        { object: "model" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const runner = new FakeRunner();
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner, fetch: catalogFetch });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "catalog", ports: await threeFreePorts() });
  await manager.configureModels(nodeId, { embedding_api_key: secret, generation_model: "https://elsewhere.invalid/provider" });

  const selection = await manager.modelSelection(nodeId);
  assert.equal(selection.node_id, nodeId);
  assert.deepEqual(selection.embedding, {
    model: "qwen3-embedding:4b",
    available_models: ["embeddinggemma:300m", "qwen3-embedding-honcho-8192:latest", "qwen3-embedding:8b", "snowflake-arctic-embed2"],
    diagnostic: null,
  });
  assert.deepEqual({
    model: selection.generation.model,
    available_models: selection.generation.available_models,
    diagnostic: selection.generation.diagnostic,
    active_source: selection.generation.active_source,
  }, { model: null, available_models: ["gpt-oss:20b"], diagnostic: null, active_source: "openai_compatible" });
  assert.equal(selection.generation.sources.codex_session.auth_status, "signed_in");
  assert.equal(selection.generation.sources.openai_compatible.api_key_configured, true);
  assert.equal(selection.generation.sources.openai_compatible.display_base_url, "http://127.0.0.1:11434/v1");
  assert.deepEqual(calls, [{ url: "http://127.0.0.1:11434/v1/models", authorization: `Bearer ${secret}` }]);
  assert.doesNotMatch(JSON.stringify(selection), new RegExp(`${secret}|host\\.docker\\.internal`));
});

test("Admin model selection preserves providers and safely fills a missing generation provider", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const secret = "selection-provider-secret";
  const catalogFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const payload = url.endsWith("/v1/models")
      ? { data: [{ id: "qwen3-embedding:8b" }, { id: "gpt-oss:20b" }] }
      : url.endsWith("/v1/embeddings")
        ? { data: [{ embedding: Array(2560).fill(0.1) }] }
        : url.endsWith("/v1/chat/completions")
          ? { choices: [{ message: { content: "{\"ok\":true}" } }] }
        : { status: "ok", database: true, embedding_configured: true, extraction_configured: true };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const runner = new FakeRunner();
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner, fetch: catalogFetch });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "selection", ports: await threeFreePorts() });
  await manager.configureModels(nodeId, { embedding_api_key: secret });
  const envPath = `${paths.nodes}/${nodeId}/.env`;
  const composePath = `${paths.nodes}/${nodeId}/compose.yaml`;
  await fs.writeFile(envPath, (await fs.readFile(envPath, "utf8")).replace(/^EMBEDDING_SEND_DIMENSIONS=.*\n/m, ""));
  await fs.writeFile(composePath, (await fs.readFile(composePath, "utf8")).replace(/^\s+NEUROMEM_EMBEDDING_SEND_DIMENSIONS:.*\n/m, ""));
  await manager.store.updateNode(nodeId, node => { node.desired_state = "running"; node.phase = "ready"; });
  runner.calls.length = 0;

  const embedding = await manager.selectModels(nodeId, { embedding_model: "qwen3-embedding:8b" });
  assert.equal(embedding.state, "succeeded", embedding.error);
  const quiesce = runner.calls.findIndex(call => call.args.includes("stop") && call.args.includes("worker") && call.args.includes("core") && call.args.includes("mcp"));
  const manifest = runner.calls.findIndex(call => call.args.some(value => value.includes("json_build_object")));
  const restart = runner.calls.findIndex((call, index) => index > manifest && call.args.at(-1) === "stop");
  const up = runner.calls.findIndex((call, index) => index > restart && call.args.includes("up") && call.args.includes("-d"));
  assert.ok(quiesce >= 0 && manifest > quiesce && restart > manifest && up > restart, JSON.stringify(runner.calls.map(call => call.args)));
  assert.deepEqual((embedding.result as { updated_fields: string[] }).updated_fields.sort(), [
    "EMBEDDING_MODEL", "EMBEDDING_SEND_DIMENSIONS",
  ]);
  const generation = await manager.selectModels(nodeId, { generation_model: "gpt-oss:20b" });
  assert.equal(generation.state, "succeeded", generation.error);
  const env = await fs.readFile(`${paths.nodes}/${nodeId}/.env`, "utf8");
  assert.match(env, /^EMBEDDING_BASE_URL=http:\/\/host\.docker\.internal:11434\/v1$/m);
  assert.match(env, new RegExp(`^EMBEDDING_API_KEY=${secret}$`, "m"));
  assert.match(env, /^EMBEDDING_MODEL=qwen3-embedding:8b$/m);
  assert.match(env, /^EMBEDDING_SEND_DIMENSIONS=true$/m);
  assert.match(env, /^GENERATION_BASE_URL=http:\/\/host\.docker\.internal:11434\/v1$/m);
  assert.match(env, new RegExp(`^GENERATION_API_KEY=${secret}$`, "m"));
  assert.match(env, /^GENERATION_MODEL=gpt-oss:20b$/m);
  assert.match(await fs.readFile(composePath, "utf8"), /^\s+NEUROMEM_EMBEDDING_SEND_DIMENSIONS: \$\{EMBEDDING_SEND_DIMENSIONS:-false\}$/m);
  assert.doesNotMatch(JSON.stringify([embedding, generation]), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify([embedding, generation]), /host\.docker\.internal|11434/);
});

test("Codex source applies a per-Node bridge and runs the FakeCodex JSON probe without exposing credentials", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const managerPort = await freePort();
  const codex = fakeCodex();
  const manager = new NodeManager({ codex, paths, runner: new FakeRunner(), fetch: okFetch(), managerPort });
  const nodeId = uuid7();
  const directKey = "preserved-direct-key-never-returned";
  const directUrl = "https://models.example.test/v1";
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "codex-source", ports: await threeFreePorts() });
  await manager.configureModels(nodeId, {
    generation_source: "openai_compatible",
    generation_base_url: directUrl,
    generation_api_key: directKey,
    generation_model: "direct-model",
    generation_direct_base_url: directUrl,
    generation_direct_api_key: directKey,
    generation_direct_model: "direct-model",
  });

  const operation = await manager.selectModels(nodeId, {
    generation: { source: "codex_session", model: "gpt-5.6-luna" },
  });
  assert.equal(operation.state, "succeeded", operation.error);
  assert.deepEqual(codex.requests, [{
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: "Return one JSON object whose ok field is true. Do not use tools." }],
    output_schema: {
      type: "object",
      properties: { ok: { type: "boolean", const: true } },
      required: ["ok"],
      additionalProperties: false,
    },
  }]);

  const env = await fs.readFile(`${paths.nodes}/${nodeId}/.env`, "utf8");
  const nodeToken = envValue(env, "API_TOKEN");
  assert.ok(nodeToken);
  assert.equal(envValue(env, "GENERATION_SOURCE"), "codex_session");
  assert.equal(
    envValue(env, "GENERATION_BASE_URL"),
    `http://host.docker.internal:${managerPort}/v1/internal/codex/nodes/${nodeId}`,
  );
  assert.equal(envValue(env, "GENERATION_API_KEY"), nodeToken);
  assert.equal(envValue(env, "GENERATION_MODEL"), "gpt-5.6-luna");
  assert.equal(envValue(env, "GENERATION_DIRECT_BASE_URL"), directUrl);
  assert.equal(envValue(env, "GENERATION_DIRECT_API_KEY"), directKey);
  assert.equal(envValue(env, "GENERATION_DIRECT_MODEL"), "direct-model");

  const selection = await manager.modelSelection(nodeId);
  const publicResult = JSON.stringify({ operation, selection, journal: await manager.store.operations(nodeId) });
  assert.doesNotMatch(publicResult, new RegExp(`${escapeRegExp(nodeToken)}|${escapeRegExp(directKey)}`));
  assert.doesNotMatch(publicResult, /Bearer\s+/i);
  assert.equal(Object.hasOwn(selection.generation.sources.openai_compatible, "api_key"), false);
  assert.equal(Object.hasOwn(selection.generation.sources.codex_session, "token"), false);
});

test("OpenAI-compatible source keeps, replaces, and clears a key while rejecting keep after an address change", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const savedKey = "saved-direct-generation-key";
  const replacementKey = "replacement-direct-generation-key";
  const providerPort = await freePort();
  const providerUrl = `http://127.0.0.1:${providerPort}/v1`;
  const calls: Array<{ url: string; authorization: string | null; method: string }> = [];
  const providerFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
      method: init?.method || "GET",
    });
    const payload = url.endsWith("/models")
      ? { data: [{ id: "keep-model" }, { id: "replace-model" }, { id: "clear-model" }] }
      : { choices: [{ message: { content: "{\"ok\":true}" } }] };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner: new FakeRunner(), fetch: providerFetch });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "direct-key-actions", ports: await threeFreePorts() });
  await manager.configureModels(nodeId, {
    generation_source: "openai_compatible",
    generation_base_url: providerUrl,
    generation_api_key: savedKey,
    generation_model: "initial-model",
    generation_direct_base_url: providerUrl,
    generation_direct_api_key: savedKey,
    generation_direct_model: "initial-model",
  });

  const keep = await manager.selectModels(nodeId, {
    generation: {
      source: "openai_compatible",
      model: "keep-model",
      connection: { base_url: providerUrl, api_key_action: "keep" },
    },
  });
  assert.equal(keep.state, "succeeded", keep.error);
  let env = await fs.readFile(`${paths.nodes}/${nodeId}/.env`, "utf8");
  assert.equal(envValue(env, "GENERATION_API_KEY"), savedKey);
  assert.equal(envValue(env, "GENERATION_DIRECT_API_KEY"), savedKey);
  assert.doesNotMatch(JSON.stringify(keep), new RegExp(escapeRegExp(savedKey)));

  const replace = await manager.selectModels(nodeId, {
    generation: {
      source: "openai_compatible",
      model: "replace-model",
      connection: { base_url: providerUrl, api_key_action: "replace", api_key: replacementKey },
    },
  });
  assert.equal(replace.state, "succeeded", replace.error);
  env = await fs.readFile(`${paths.nodes}/${nodeId}/.env`, "utf8");
  assert.equal(envValue(env, "GENERATION_API_KEY"), replacementKey);
  assert.equal(envValue(env, "GENERATION_DIRECT_API_KEY"), replacementKey);
  assert.doesNotMatch(JSON.stringify(replace), new RegExp(escapeRegExp(replacementKey)));

  const beforeRejectedKeep = env;
  await assert.rejects(manager.selectModels(nodeId, {
    generation: {
      source: "openai_compatible",
      model: "keep-model",
      connection: { base_url: `http://127.0.0.1:${await freePort()}/v1`, api_key_action: "keep" },
    },
  }), /saved API key cannot be reused after changing the provider address/);
  assert.equal(await fs.readFile(`${paths.nodes}/${nodeId}/.env`, "utf8"), beforeRejectedKeep);

  const clear = await manager.selectModels(nodeId, {
    generation: {
      source: "openai_compatible",
      model: "clear-model",
      connection: { base_url: providerUrl, api_key_action: "clear" },
    },
  });
  assert.equal(clear.state, "succeeded", clear.error);
  env = await fs.readFile(`${paths.nodes}/${nodeId}/.env`, "utf8");
  assert.equal(envValue(env, "GENERATION_API_KEY"), "");
  assert.equal(envValue(env, "GENERATION_DIRECT_API_KEY"), "");

  const generationProbes = calls.filter(call => call.url.endsWith("/chat/completions"));
  assert.deepEqual(generationProbes.map(call => call.authorization), [
    `Bearer ${savedKey}`,
    `Bearer ${replacementKey}`,
    null,
  ]);
});

test("generation probes exercise both providers without persisting configuration or operations", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const providerPort = await freePort();
  const providerUrl = `http://127.0.0.1:${providerPort}/v1`;
  const probeKey = "ephemeral-generation-probe-key";
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const providerFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    const payload = url.endsWith("/models")
      ? { data: [{ id: "probe-model" }] }
      : { choices: [{ message: { content: "{\"ok\":true}" } }] };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const codex = fakeCodex();
  const manager = new NodeManager({ codex, paths, runner: new FakeRunner(), fetch: providerFetch });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "ephemeral-probes", ports: await threeFreePorts() });
  const envPath = `${paths.nodes}/${nodeId}/.env`;
  const beforeEnv = await fs.readFile(envPath, "utf8");
  const beforeOperations = JSON.stringify(await manager.store.operations(nodeId));

  const direct = await manager.generationProbe(nodeId, {
    source: "openai_compatible",
    model: "probe-model",
    connection: { base_url: providerUrl, api_key_action: "replace", api_key: probeKey },
  });
  assert.equal(direct.model_compatible, true);
  assert.equal(direct.api_key_configured, true);
  assert.doesNotMatch(JSON.stringify(direct), new RegExp(escapeRegExp(probeKey)));
  assert.deepEqual(calls.map(call => call.authorization), [`Bearer ${probeKey}`, `Bearer ${probeKey}`]);
  assert.equal(await fs.readFile(envPath, "utf8"), beforeEnv);
  assert.equal(JSON.stringify(await manager.store.operations(nodeId)), beforeOperations);

  const codexProbe = await manager.generationProbe(nodeId, { source: "codex_session", model: "gpt-5.6-terra" });
  assert.equal(codexProbe.model_compatible, true);
  assert.deepEqual(codex.requests, [{
    model: "gpt-5.6-terra",
    messages: [{ role: "user", content: "Return one JSON object whose ok field is true. Do not use tools." }],
    output_schema: {
      type: "object",
      properties: { ok: { type: "boolean", const: true } },
      required: ["ok"],
      additionalProperties: false,
    },
  }]);
  assert.equal(await fs.readFile(envPath, "utf8"), beforeEnv);
  assert.equal(JSON.stringify(await manager.store.operations(nodeId)), beforeOperations);
});

test("Embedding selection probes 2560 dimensions before changing runtime configuration", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const secret = "probe-secret-not-in-errors";
  const calls: string[] = [];
  let probeVector = Array(4096).fill(0.1);
  const incompatibleFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const payload = url.endsWith("/v1/models")
      ? { data: [{ id: "qwen3-embedding:8b" }] }
      : { data: [{ embedding: probeVector }], detail: `${secret} at ${url}` };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner: new FakeRunner(), fetch: incompatibleFetch });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "probe", ports: await threeFreePorts() });
  await manager.configureModels(nodeId, { embedding_api_key: secret });
  await manager.store.updateNode(nodeId, node => { node.desired_state = "running"; node.phase = "ready"; });
  const before = await fs.readFile(`${paths.nodes}/${nodeId}/.env`, "utf8");
  const operation = await manager.selectModels(nodeId, { embedding_model: "qwen3-embedding:8b" });
  assert.equal(operation.state, "failed");
  assert.match(operation.error || "", /4096 dimensions.*requires 2560/);
  assert.doesNotMatch(operation.error || "", new RegExp(`${secret}|host\\.docker\\.internal|11434`));
  assert.equal(await fs.readFile(`${paths.nodes}/${nodeId}/.env`, "utf8"), before);
  probeVector = Array(2560).fill(0);
  const zeroNorm = await manager.selectModels(nodeId, { embedding_model: "qwen3-embedding:8b" });
  assert.equal(zeroNorm.state, "failed");
  assert.match(zeroNorm.error || "", /invalid vector norm/);
  assert.equal(await fs.readFile(`${paths.nodes}/${nodeId}/.env`, "utf8"), before);
  assert.ok(calls.some(url => url === "http://127.0.0.1:11434/v1/embeddings"));
});

test("Generation selection requires JSON chat compatibility before changing runtime configuration", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const secret = "generation-probe-secret";
  const calls: string[] = [];
  const incompatibleFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const payload = url.endsWith("/v1/models")
      ? { data: [{ id: "speech-to-text-model" }] }
      : { choices: [{ message: { content: `not json ${secret} ${url}` } }] };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner: new FakeRunner(), fetch: incompatibleFetch });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "generation-probe", ports: await threeFreePorts() });
  await manager.configureModels(nodeId, { embedding_api_key: secret });
  const before = await fs.readFile(`${paths.nodes}/${nodeId}/.env`, "utf8");
  const operation = await manager.selectModels(nodeId, { generation_model: "speech-to-text-model" });
  assert.equal(operation.state, "failed");
  assert.match(operation.error || "", /generation model compatibility probe/);
  assert.doesNotMatch(operation.error || "", new RegExp(`${secret}|host\\.docker\\.internal|11434`));
  assert.equal(await fs.readFile(`${paths.nodes}/${nodeId}/.env`, "utf8"), before);
  assert.equal(calls.filter(url => url.endsWith("/v1/chat/completions")).length, 1);
});

test("Embedding selection blocks stopped Nodes and any model-bound database rows", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let embeddingProbeCalls = 0;
  const catalogFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/v1/embeddings")) embeddingProbeCalls += 1;
    return new Response(JSON.stringify(url.endsWith("/v1/models")
      ? { data: [{ id: "qwen3-embedding:8b" }] }
      : { data: [{ embedding: Array(2560).fill(0.1) }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner: new FakeRunner(), fetch: catalogFetch });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "data-guard", ports: await threeFreePorts() });
  const stopped = await manager.selectModels(nodeId, { embedding_model: "qwen3-embedding:8b" });
  assert.equal(stopped.state, "failed");
  assert.match(stopped.error || "", /stopped Node/);
  await manager.store.updateNode(nodeId, node => { node.desired_state = "running"; node.phase = "ready"; });
  manager.compose.databaseManifest = async () => ({
    database_bytes: 4096,
    schema_revision: "0001_initial",
    row_counts: { records: 0, claims: 0, jobs: 1, embedding_profiles: 1, record_embeddings: 0, claim_embeddings: 0 },
    extensions: { vector: "0.8.6", pg_trgm: "1.6" },
    vector_columns: {},
  });
  const blocked = await manager.selectModels(nodeId, { embedding_model: "qwen3-embedding:8b" });
  assert.equal(blocked.state, "failed");
  assert.match(blocked.error || "", /empty Node.*re-embedding migration/);
  assert.equal((await manager.store.findNode(nodeId)).phase, "ready");
  assert.equal(embeddingProbeCalls, 0);
  assert.match(await fs.readFile(`${paths.nodes}/${nodeId}/.env`, "utf8"), /^EMBEDDING_MODEL=qwen3-embedding:4b$/m);
});

test("Model configuration marks the Node failed when rollback recovery cannot restart it", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const catalogFetch = (async () => new Response(JSON.stringify({ data: [{ id: "qwen3-embedding:8b" }] }), {
    status: 200, headers: { "content-type": "application/json" },
  })) as typeof fetch;
  const runner = new FakeRunner();
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner, fetch: catalogFetch });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "rollback-failure", ports: await threeFreePorts() });
  await manager.store.updateNode(nodeId, node => { node.desired_state = "running"; node.phase = "ready"; });
  manager.compose.databaseManifest = async () => ({
    database_bytes: 4096,
    schema_revision: "0001_initial",
    row_counts: { records: 0, claims: 0, jobs: 0, embedding_profiles: 1, record_embeddings: 0, claim_embeddings: 0 },
    extensions: { vector: "0.8.6", pg_trgm: "1.6" },
    vector_columns: {},
  });
  runner.fail = (_command, args) => args.includes("up") && args.includes("-d");
  const operation = await manager.selectModels(nodeId, { embedding_model: "qwen3-embedding:8b" });
  assert.equal(operation.state, "failed");
  assert.match(operation.error || "", /rollback recovery failed/);
  assert.equal((await manager.store.findNode(nodeId)).phase, "failed");
  assert.match(await fs.readFile(`${paths.nodes}/${nodeId}/.env`, "utf8"), /^EMBEDDING_MODEL=qwen3-embedding:4b$/m);
});

test("Admin model selection rejects undiscovered or malformed model names and unknown fields", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const catalogFetch = (async () => new Response(JSON.stringify({ data: [{ id: "qwen3-embedding:8b" }] }), {
    status: 200, headers: { "content-type": "application/json" },
  })) as typeof fetch;
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner: new FakeRunner(), fetch: catalogFetch });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "invalid-selection", ports: await threeFreePorts() });
  await assert.rejects(manager.selectModels(nodeId, { embedding_model: "not-installed" }), /not available/);
  await assert.rejects(manager.selectModels(nodeId, { embedding_model: "bad\nname" }), /Invalid embedding_model/);
  await assert.rejects(manager.selectModels(nodeId, { embedding_model: "qwen3-embedding:8b", embedding_api_key: "injected" }), /Unsupported model selection field/);
  await assert.rejects(manager.selectModels(nodeId, {}), /At least one model selection/);
});

test("Model discovery failure returns an empty catalog and a secret-free diagnostic", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const secret = "failed-catalog-secret";
  const failingFetch = (async () => { throw new Error(`request with ${secret} failed at http://host.docker.internal:11434/v1/models`); }) as typeof fetch;
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner: new FakeRunner(), fetch: failingFetch });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "failed-catalog", ports: await threeFreePorts() });
  await manager.configureModels(nodeId, { embedding_api_key: secret });
  const selection = await manager.modelSelection(nodeId);
  assert.deepEqual(selection.embedding.available_models, []);
  assert.deepEqual(selection.generation.available_models, []);
  assert.equal(selection.embedding.diagnostic, "Could not reach the configured model provider");
  assert.equal(selection.generation.diagnostic, "Could not reach the configured model provider");
  assert.doesNotMatch(JSON.stringify(selection), new RegExp(`${secret}|host\\.docker\\.internal`));
});

test("purge requires the exact Node UUID and removes only validated Node volumes plus local data", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const runner = new FakeRunner();
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner, fetch: okFetch() });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "purge", ports: await threeFreePorts() });
  await assert.rejects(manager.deleteNode(nodeId, uuid7(), true), /exact Node UUID/);
  const result = await manager.deleteNode(nodeId, nodeId, true);
  assert.equal(result.state, "succeeded");
  await assert.rejects(fs.access(`${paths.nodes}/${nodeId}`));
  const removed = runner.calls.filter(call => call.args[0] === "volume" && call.args[1] === "rm").map(call => call.args[2]);
  const key = nodeId.replaceAll("-", "");
  assert.deepEqual(removed.sort(), [`neuromem-${key}-mcp`, `neuromem-${key}-pg-g1`].sort());
  assert.equal(JSON.parse(await fs.readFile(`${paths.manager}/tombstones/${nodeId}.json`, "utf8")).node_id, nodeId);
});

test("same-millisecond UUIDv7 Nodes never share Compose, database, MCP, or stage names", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner: new FakeRunner(), fetch: okFetch() });
  const firstId = uuid7(1_700_000_000_000);
  const secondId = uuid7(1_700_000_000_000);
  assert.equal(firstId.slice(0, 8), secondId.slice(0, 8));
  await manager.createNode({ node_id: firstId, confirmation: firstId, alias: "first", ports: await threeFreePorts() });
  await manager.createNode({ node_id: secondId, confirmation: secondId, alias: "second", ports: await threeFreePorts() });
  const first = await manager.store.findNode(firstId);
  const second = await manager.store.findNode(secondId);
  assert.notEqual(first.compose_project, second.compose_project);
  const firstEnv = await fs.readFile(`${paths.nodes}/${firstId}/.env`, "utf8");
  const secondEnv = await fs.readFile(`${paths.nodes}/${secondId}/.env`, "utf8");
  for (const key of ["DB_VOLUME_NAME", "MCP_STATE_VOLUME_NAME"]) {
    const read = (value: string) => value.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1];
    assert.notEqual(read(firstEnv), read(secondEnv));
  }
});

test("first explicit start builds missing application images from packaged contexts", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const contexts = `${home}/image-contexts`;
  for (const name of ["core", "mcp", "web"]) {
    await fs.mkdir(`${contexts}/${name}`, { recursive: true });
    await fs.writeFile(`${contexts}/${name}/Dockerfile`, "FROM scratch\n");
  }
  class MissingImagesRunner extends FakeRunner {
    override async run(command: string, args: readonly string[], options = {}) {
      if (args[0] === "image" && args[1] === "inspect") return { ok: false, code: 1, stdout: "", stderr: "missing" };
      if (args[0] === "pull") return { ok: false, code: 1, stdout: "", stderr: "not published" };
      return super.run(command, args, options);
    }
  }
  const runner = new MissingImagesRunner();
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner, fetch: okFetch(), startTimeoutMs: 50, imageContextRoot: contexts });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "images", ports: await threeFreePorts() });
  const operation = await manager.start(nodeId);
  assert.equal(operation.state, "succeeded", operation.error);
  const builds = runner.calls.filter(call => call.args[0] === "build");
  assert.equal(builds.length, 3);
  assert.deepEqual(builds.map(call => call.args.at(-1)?.split("/").at(-1)).sort(), ["core", "mcp", "web"]);
  assert.ok(builds.every(call => call.args.includes("--label") && call.args.some(value => /^dev\.neuromem\.context-sha256=[0-9a-f]{64}$/.test(value))));
});

test("stale same-version image tags rebuild once from the exact packaged context digest", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const contexts = `${home}/provenance-contexts`;
  for (const name of ["core", "mcp", "web"]) {
    await fs.mkdir(`${contexts}/${name}`, { recursive: true });
    await fs.writeFile(`${contexts}/${name}/Dockerfile`, `FROM scratch\n# ${name}\n`);
  }
  class ProvenanceRunner extends FakeRunner {
    labels = new Map<string, string>();
    override async run(command: string, args: readonly string[], options = {}) {
      if (args[0] === "image" && args[1] === "inspect" && !args.includes("--format")) {
        return { ok: true, code: 0, stdout: "present", stderr: "" };
      }
      if (args[0] === "image" && args[1] === "inspect" && args.includes("--format")) {
        const image = args.at(-1)!;
        return { ok: true, code: 0, stdout: this.labels.get(image) || "stale", stderr: "" };
      }
      if (args[0] === "build") {
        const label = args.find(value => value.startsWith("dev.neuromem.context-sha256="))!.split("=")[1]!;
        const image = args[args.indexOf("--tag") + 1]!;
        this.labels.set(image, label);
      }
      return super.run(command, args, options);
    }
  }
  const runner = new ProvenanceRunner();
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner, fetch: okFetch(), startTimeoutMs: 50, imageContextRoot: contexts });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "provenance", ports: await threeFreePorts() });
  await manager.start(nodeId);
  assert.equal(runner.calls.filter(call => call.args[0] === "build").length, 3);
  runner.calls.length = 0;
  await manager.restart(nodeId);
  assert.equal(runner.calls.filter(call => call.args[0] === "build").length, 0);
});

test("manager restart rolls an interrupted cutover back before restarting the desired Node", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const runner = new FakeRunner();
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner, fetch: okFetch(), startTimeoutMs: 50 });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "crash", ports: await threeFreePorts() });
  await manager.start(nodeId);
  const key = nodeId.replaceAll("-", "");
  const fromVolume = `neuromem-${key}-pg-g1`;
  const toVolume = `neuromem-${key}-pg-g2`;
  const operation = await manager.store.beginOperation(nodeId, "restore_apply", "cutover_prepared");
  const envPath = `${paths.nodes}/${nodeId}/.env`;
  const originalEnv = await fs.readFile(envPath, "utf8");
  await manager.store.updateOperation(operation, {
    phase: "cutover_prepared",
    result: { cutover: {
      from_generation: 1, from_volume: fromVolume, from_schema: "0001_initial",
      to_generation: 2, to_volume: toVolume, to_schema: "0001_initial",
      env_sha256: crypto.createHash("sha256").update(originalEnv).digest("hex"),
    } },
  });
  await fs.writeFile(envPath, originalEnv.replace(/^DB_VOLUME_NAME=.*$/m, `DB_VOLUME_NAME=${toVolume}`));
  await manager.store.updateNode(nodeId, node => { node.generation = 2; });

  const recovered = new NodeManager({ codex: fakeCodex(), paths, runner, fetch: okFetch(), startTimeoutMs: 50 });
  await recovered.initialize(true);
  const node = await recovered.store.findNode(nodeId);
  assert.equal(node.generation, 1);
  assert.match(await fs.readFile(envPath, "utf8"), new RegExp(`^DB_VOLUME_NAME=${fromVolume}$`, "m"));
  const journal = (await recovered.store.operations(nodeId)).find(item => item.operation_id === operation.operation_id)!;
  assert.equal(journal.state, "recovered");
  assert.equal(journal.phase, "rolled_back_after_manager_restart");
  assert.equal(typeof (journal.result as { recovery: { recovery_completed_at: string } }).recovery.recovery_completed_at, "string");
  assert.ok(runner.calls.some(call => call.args.includes("stop")));
  assert.ok(runner.calls.some(call => call.args.includes("up")));

  const generationThreeVolume = `neuromem-${key}-pg-g3`;
  const currentEnv = await fs.readFile(envPath, "utf8");
  await fs.writeFile(envPath, currentEnv.replace(/^DB_VOLUME_NAME=.*$/m, `DB_VOLUME_NAME=${generationThreeVolume}`));
  await recovered.store.updateNode(nodeId, value => {
    value.generation = 3;
    value.phase = "ready";
  });
  const successful = await recovered.store.beginOperation(nodeId, "restore_apply", "cutover_prepared");
  await recovered.store.updateOperation(successful, {
    state: "succeeded",
    phase: "verified",
    completed_at: new Date().toISOString(),
    result: { active_generation: 3 },
  });

  const restartedAgain = new NodeManager({ codex: fakeCodex(), paths, runner, fetch: okFetch(), startTimeoutMs: 50 });
  await restartedAgain.initialize(true);
  assert.equal((await restartedAgain.store.findNode(nodeId)).generation, 3);
  assert.match(await fs.readFile(envPath, "utf8"), new RegExp(`^DB_VOLUME_NAME=${generationThreeVolume}$`, "m"));
  const oldJournal = (await restartedAgain.store.operations(nodeId)).find(item => item.operation_id === operation.operation_id)!;
  assert.equal(oldJournal.state, "recovered");
});

test("manager restart synchronizes a running Node after interrupted model configuration", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const runner = new FakeRunner();
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner, fetch: okFetch(), startTimeoutMs: 50 });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "model-crash-running", ports: await threeFreePorts() });
  await manager.store.updateNode(nodeId, node => { node.desired_state = "running"; node.phase = "ready"; });
  const operation = await manager.store.beginOperation(nodeId, "models_configure", "updating_runtime");
  const envPath = `${paths.nodes}/${nodeId}/.env`;
  await fs.writeFile(envPath, (await fs.readFile(envPath, "utf8")).replace(/^EMBEDDING_MODEL=.*$/m, "EMBEDDING_MODEL=qwen3-embedding:8b"));
  runner.calls.length = 0;

  const recovered = new NodeManager({ codex: fakeCodex(), paths, runner, fetch: okFetch(), startTimeoutMs: 50 });
  await recovered.initialize(true);
  const stop = runner.calls.findIndex(call => call.args.at(-1) === "stop");
  const up = runner.calls.findIndex((call, index) => index > stop && call.args.includes("up") && call.args.includes("-d"));
  assert.ok(stop >= 0 && up > stop);
  assert.match(await fs.readFile(envPath, "utf8"), /^EMBEDDING_MODEL=qwen3-embedding:8b$/m);
  assert.equal((await recovered.store.findNode(nodeId)).phase, "ready");
  const journal = (await recovered.store.operations(nodeId)).find(item => item.operation_id === operation.operation_id)!;
  assert.equal(journal.state, "recovered");
  assert.equal(journal.phase, "model_runtime_synced_after_manager_restart");
  assert.equal((journal.result as { recovery: { restarted: boolean } }).recovery.restarted, true);
  assert.equal(journal.error, undefined);
});

test("manager restart preserves interrupted model configuration for a stopped Node without Compose", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const runner = new FakeRunner();
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner, fetch: okFetch(), startTimeoutMs: 50 });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "model-crash-stopped", ports: await threeFreePorts() });
  const operation = await manager.store.beginOperation(nodeId, "models_configure", "updating_runtime");
  const envPath = `${paths.nodes}/${nodeId}/.env`;
  await fs.writeFile(envPath, (await fs.readFile(envPath, "utf8")).replace(/^GENERATION_MODEL=.*$/m, "GENERATION_MODEL=gpt-oss:20b"));
  runner.calls.length = 0;

  const recovered = new NodeManager({ codex: fakeCodex(), paths, runner, fetch: okFetch(), startTimeoutMs: 50 });
  await recovered.initialize(true);
  assert.equal(runner.calls.length, 0);
  assert.match(await fs.readFile(envPath, "utf8"), /^GENERATION_MODEL=gpt-oss:20b$/m);
  assert.equal((await recovered.store.findNode(nodeId)).phase, "stopped");
  const journal = (await recovered.store.operations(nodeId)).find(item => item.operation_id === operation.operation_id)!;
  assert.equal(journal.state, "recovered");
  assert.equal(journal.phase, "model_configuration_saved_for_next_start");
  assert.equal((journal.result as { recovery: { restarted: boolean } }).recovery.restarted, false);
});

test("interrupted model recovery records failure and retries on the next Manager restart", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const runner = new FakeRunner();
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner, fetch: okFetch(), startTimeoutMs: 50 });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "model-recovery-failure", ports: await threeFreePorts() });
  await manager.store.updateNode(nodeId, node => { node.desired_state = "running"; node.phase = "ready"; });
  const operation = await manager.store.beginOperation(nodeId, "models_configure", "updating_runtime");
  const envPath = `${paths.nodes}/${nodeId}/.env`;
  await fs.writeFile(envPath, (await fs.readFile(envPath, "utf8")).replace(/^GENERATION_MODEL=.*$/m, "GENERATION_MODEL=gpt-oss:20b"));
  runner.fail = (_command, args) => args.includes("up") && args.includes("-d");

  const failedRecovery = new NodeManager({ codex: fakeCodex(), paths, runner, fetch: okFetch(), startTimeoutMs: 50 });
  await failedRecovery.initialize(true);
  assert.equal((await failedRecovery.store.findNode(nodeId)).phase, "failed");
  let journal = (await failedRecovery.store.operations(nodeId)).find(item => item.operation_id === operation.operation_id)!;
  assert.equal(journal.state, "needs_attention");
  assert.equal(journal.phase, "model_recovery_failed");
  assert.match(journal.error || "", /restart the Node Manager to retry/);

  runner.fail = undefined;
  runner.calls.length = 0;
  const retried = new NodeManager({ codex: fakeCodex(), paths, runner, fetch: okFetch(), startTimeoutMs: 50 });
  await retried.initialize(true);
  assert.equal((await retried.store.findNode(nodeId)).phase, "ready");
  journal = (await retried.store.operations(nodeId)).find(item => item.operation_id === operation.operation_id)!;
  assert.equal(journal.state, "recovered");
  assert.equal(journal.phase, "model_runtime_synced_after_manager_restart");
});

test("restore skips a retained failed candidate generation", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  class RetainedCandidateRunner extends FakeRunner {
    override async run(command: string, args: readonly string[], options = {}) {
      if (args[0] === "volume" && args[1] === "inspect") {
        return { ok: String(args[2]).endsWith("-pg-g2"), code: String(args[2]).endsWith("-pg-g2") ? 0 : 1, stdout: "", stderr: "" };
      }
      return super.run(command, args, options);
    }
  }
  const manager = new NodeManager({ codex: fakeCodex(), paths, runner: new RetainedCandidateRunner(), fetch: okFetch(), startTimeoutMs: 50 });
  const nodeId = uuid7();
  await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "retry", ports: await threeFreePorts() });
  await manager.start(nodeId);
  const backup = await manager.backupCreate(nodeId, "source");
  const result = await manager.restoreApply(nodeId, (backup.result as { backup_id: string }).backup_id, nodeId);
  assert.equal(result.state, "succeeded", result.error);
  assert.equal((await manager.store.findNode(nodeId)).generation, 3);
});

function lastIndexWhere<T>(items: T[], predicate: (item: T, index: number) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) if (predicate(items[index]!, index)) return index;
  return -1;
}

function envValue(source: string, key: string): string {
  const match = source.match(new RegExp(`^${escapeRegExp(key)}=(.*)$`, "m"));
  assert.ok(match, `Missing ${key} in the Node environment`);
  const value = match[1]!;
  return value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\")
    : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
