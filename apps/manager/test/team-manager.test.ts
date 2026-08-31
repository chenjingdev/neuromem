import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { TeamManager } from "../src/team-manager.js";
import type { RunOptions } from "../src/types.js";
import { FakeRunner, temporaryPaths } from "./helpers.js";

const DIGEST = "a".repeat(64);

function validEnv(): string {
  const secret = "s".repeat(40);
  return [
    "COMPOSE_PROJECT_NAME=neuromem-team",
    "NEUROMEM_PUBLIC_HOST=memory.example.test",
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
    `MEMORY_CORE_SERVICE_TOKEN=${secret}`,
    `MEMORY_CORE_IMAGE=registry.example.test/neuromem-memory-core@sha256:${DIGEST}`,
    "MEMORY_CORE_SOURCE_URL=https://example.test/neuromem-memory-core",
    "MEMORY_CORE_SOURCE_REVISION=9380bf2",
    "EMBEDDING_BASE_URL=http://host.docker.internal:11434/v1",
    "EMBEDDING_API_KEY=local-model",
    "EMBEDDING_MODEL=qwen3-embedding",
    "GENERATION_BASE_URL=http://host.docker.internal:11435/v1",
    "GENERATION_API_KEY=local-model",
    "GENERATION_MODEL=qwen3.6",
    "CONTROL_DB_VOLUME=neuromem-team-control-db-g1",
    "MEMORY_DB_VOLUME=neuromem-team-memory-db-g1",
    "MEMORY_REDIS_VOLUME=neuromem-team-redis-g1",
    "MCP_STATE_VOLUME=neuromem-team-mcp-g1",
    "DGX_MODEL_ENABLED=false",
    "",
  ].join("\n");
}

async function fixture(t: TestContext) {
  const { home, paths } = await temporaryPaths("neuromem-team-manager-test-");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const deployment = path.join(home, "deployment");
  await fs.mkdir(deployment, { recursive: true });
  await fs.writeFile(path.join(deployment, "compose.yaml"), "services: {}\n");
  const envFile = path.join(home, "team.env");
  await fs.writeFile(envFile, validEnv(), { mode: 0o600 });
  await fs.chmod(envFile, 0o600);
  const runner = new FakeRunner();
  const manager = new TeamManager({ paths, runner, deploymentDir: deployment, platform: "darwin", arch: "arm64" });
  return { home, paths, deployment, envFile, runner, manager };
}

test("team config validation keeps env private and requires an external digest-pinned Memory Core", async t => {
  const { envFile, runner, manager } = await fixture(t);
  const result = await manager.validateConfig(envFile);
  assert.equal(result.ok, true);
  assert.equal(result.memory_core.image, `registry.example.test/neuromem-memory-core@sha256:${DIGEST}`);
  assert.equal(result.memory_core.revision, "9380bf2");
  assert.ok(runner.calls.some(call => call.command === "docker" && call.args.includes("config") && call.args.includes("--quiet")));

  await fs.writeFile(envFile, validEnv().replace(`@sha256:${DIGEST}`, ":latest"), { mode: 0o600 });
  await assert.rejects(manager.validateConfig(envFile), /pinned by sha256 digest/);
  await fs.writeFile(envFile, validEnv(), { mode: 0o644 });
  await fs.chmod(envFile, 0o644);
  await assert.rejects(manager.validateConfig(envFile), /permissions must be 0600/);
});

test("Mac fallback preflight and team lifecycle use Compose without starting the Node daemon", async t => {
  const { envFile, runner, manager } = await fixture(t);
  const preflight = await manager.preflight("auto");
  assert.equal(preflight.ok, true);
  assert.equal(preflight.target, "mac");
  assert.match(preflight.warnings.join(" "), /host\.docker\.internal/);

  const started = await manager.start({ envFile, target: "mac" }) as { ok: boolean; dashboard: string };
  assert.equal(started.ok, true);
  assert.equal(started.dashboard, "https://memory.example.test");
  assert.ok(runner.calls.some(call => call.args.join(" ").includes("run --rm --no-deps control neuromem-control-init")));
  assert.ok(runner.calls.some(call => call.args.join(" ").includes("up -d --build --remove-orphans")));
  assert.ok(runner.calls.filter(call => call.command === "docker" && call.args.includes("--file")).every(call => call.args.includes("--env-file") && call.args.includes(envFile)));

  const stopped = await manager.stop(envFile) as { volumes_preserved: boolean };
  assert.equal(stopped.volumes_preserved, true);
  assert.ok(runner.calls.some(call => call.args.includes("stop")));
});

test("DGX preflight requires Linux ARM64, NVIDIA container runtime, and a visible GPU", async t => {
  const { home, paths, deployment, envFile } = await fixture(t);
  class DgxRunner extends FakeRunner {
    override async run(command: string, args: readonly string[], options: RunOptions = {}) {
      const base = await super.run(command, args, options);
      if (command === "docker" && args.includes("{{json .Runtimes}}")) return { ...base, stdout: '{"runc":{},"nvidia":{}}' };
      if (command === "nvidia-smi") return { ...base, stdout: "GPU 0: NVIDIA GB10" };
      return base;
    }
  }
  const runner = new DgxRunner();
  const manager = new TeamManager({ paths, runner, deploymentDir: deployment, platform: "linux", arch: "arm64" });
  const result = await manager.preflight("dgx");
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.filter(check => check.name.startsWith("nvidia")).map(check => check.ok), [true, true]);

  const missing = new TeamManager({ paths, runner: new FakeRunner(), deploymentDir: deployment, platform: "linux", arch: "arm64" });
  assert.equal((await missing.preflight("dgx")).ok, false);
  assert.equal((await manager.validateConfig(envFile)).ok, true);
  await fs.access(home);
});

test("team MCP config reads a separate 0600 credential and backup/migration rehearsals are non-destructive", async t => {
  const { home, envFile, runner, manager } = await fixture(t);
  const credential = path.join(home, "codex.token");
  const secret = "credential-" + "x".repeat(40);
  await fs.writeFile(credential, `${secret}\n`, { mode: 0o600 });
  await fs.chmod(credential, 0o600);
  const config = JSON.parse(await manager.mcpConfig(envFile, credential, "json"));
  assert.equal(config.mcpServers["neuromem-team"].url, "https://memory.example.test/mcp");
  assert.equal(config.mcpServers["neuromem-team"].headers.Authorization, `Bearer ${secret}`);

  const output = path.join(home, "rehearsal");
  const backup = await manager.backupRehearsal(envFile, output) as { applied: boolean; manifest: { files: Array<{ sha256: string }> } };
  assert.equal(backup.applied, false);
  assert.equal(backup.manifest.files.length, 2);
  assert.ok(backup.manifest.files.every(file => /^[0-9a-f]{64}$/.test(file.sha256)));
  assert.equal(JSON.parse(await fs.readFile(path.join(output, "manifest.json"), "utf8")).databases_stopped, false);
  assert.ok(runner.calls.filter(call => call.args.includes("pg_dump")).every(call => !call.args.includes("--clean")));
  assert.ok(runner.calls.filter(call => call.args.includes("pg_restore")).every(call => call.args.includes("--list")));

  const migration = await manager.migrationRehearsal(envFile, "head") as { applied: boolean };
  assert.equal(migration.applied, false);
  assert.ok(runner.calls.some(call => call.args.join(" ").includes("--entrypoint /app/.venv/bin/alembic memory-core current")));
  assert.ok(runner.calls.some(call => call.args.join(" ").includes("--entrypoint /app/.venv/bin/alembic memory-core heads")));
  assert.equal(runner.calls.some(call => call.args.includes("upgrade")), false);
});
