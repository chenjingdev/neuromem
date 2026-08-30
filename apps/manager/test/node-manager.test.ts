import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import { uuid7 } from "../src/fs-safe.js";
import { NodeManager } from "../src/node-manager.js";
import { FakeRunner, okFetch, temporaryPaths, threeFreePorts } from "./helpers.js";

test("create writes private per-Node runtime and status recognizes the deployed service names", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const runner = new FakeRunner();
  const manager = new NodeManager({ paths, runner, fetch: okFetch(), startTimeoutMs: 50 });
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
  assert.doesNotMatch(JSON.stringify(created), /POSTGRES_PASSWORD|API_TOKEN|MCP_TOKEN/);
  assert.equal((await manager.store.findNode(nodeId)).schema_revision, "uninitialized");
  assert.equal((await manager.start(nodeId)).state, "succeeded");
  assert.equal((await manager.store.findNode(nodeId)).schema_revision, "0001_initial");
  const status = await manager.status(nodeId);
  assert.equal(status.phase, "ready");
  assert.deepEqual(status.components.map(component => component.name), ["database", "core", "worker", "mcp", "web"]);
});

test("port selection never silently increments a conflicting port", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const manager = new NodeManager({ paths, runner: new FakeRunner(), fetch: okFetch() });
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
  const manager = new NodeManager({ paths, runner, fetch: okFetch(), startTimeoutMs: 50 });
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
  const manager = new NodeManager({ paths, runner: new FakeRunner(), fetch: okFetch() });
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
    const manager = new NodeManager({ paths, runner, fetch: okFetch(), startTimeoutMs: 50 });
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
  const manager = new NodeManager({ paths, runner, fetch: okFetch(), startTimeoutMs: 50 });
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
  const manager = new NodeManager({ paths, runner, fetch: okFetch(), startTimeoutMs: 50 });
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
  const manager = new NodeManager({ paths, runner: new MismatchRunner(), fetch: unavailableReady });
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
  const manager = new NodeManager({ paths, runner: new FakeRunner(), fetch: degradedFetch, startTimeoutMs: 50 });
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
  const manager = new NodeManager({ paths, runner: new FakeRunner(), fetch: changingHealth, startTimeoutMs: 50 });
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
  const manager = new NodeManager({ paths, runner: new FakeRunner(), fetch: readiness, startTimeoutMs: 50 });
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

test("purge requires the exact Node UUID and removes only validated Node volumes plus local data", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const runner = new FakeRunner();
  const manager = new NodeManager({ paths, runner, fetch: okFetch() });
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
  const manager = new NodeManager({ paths, runner: new FakeRunner(), fetch: okFetch() });
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
  const manager = new NodeManager({ paths, runner, fetch: okFetch(), startTimeoutMs: 50, imageContextRoot: contexts });
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
  const manager = new NodeManager({ paths, runner, fetch: okFetch(), startTimeoutMs: 50, imageContextRoot: contexts });
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
  const manager = new NodeManager({ paths, runner, fetch: okFetch(), startTimeoutMs: 50 });
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

  const recovered = new NodeManager({ paths, runner, fetch: okFetch(), startTimeoutMs: 50 });
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

  const restartedAgain = new NodeManager({ paths, runner, fetch: okFetch(), startTimeoutMs: 50 });
  await restartedAgain.initialize(true);
  assert.equal((await restartedAgain.store.findNode(nodeId)).generation, 3);
  assert.match(await fs.readFile(envPath, "utf8"), new RegExp(`^DB_VOLUME_NAME=${generationThreeVolume}$`, "m"));
  const oldJournal = (await restartedAgain.store.operations(nodeId)).find(item => item.operation_id === operation.operation_id)!;
  assert.equal(oldJournal.state, "recovered");
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
  const manager = new NodeManager({ paths, runner: new RetainedCandidateRunner(), fetch: okFetch(), startTimeoutMs: 50 });
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
