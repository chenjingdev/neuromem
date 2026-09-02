import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { NodeDeploymentManager } from "../src/node-deployment-manager.js";
import type { RunOptions } from "../src/types.js";
import { FakeRunner, fakeCodex, temporaryPaths } from "./helpers.js";

const DIGEST = "a".repeat(64);

function validEnv(): string {
  const secret = "s".repeat(40);
  return [
    "COMPOSE_PROJECT_NAME=neuromem-node",
    "NEUROMEM_NODE_ID=test-physical-node",
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
    "EMBEDDING_VECTOR_DIMENSIONS=1536",
    "GENERATION_BASE_URL=http://host.docker.internal:11435/v1",
    "GENERATION_API_KEY=local-model",
    "GENERATION_MODEL=qwen3.6",
    "GENERATION_SOURCE=openai_compatible",
    "CONTROL_DB_VOLUME=neuromem-node-control-db",
    "MEMORY_DB_VOLUME=neuromem-node-memory-db",
    "MEMORY_REDIS_VOLUME=neuromem-node-memory-redis",
    "MCP_STATE_VOLUME=neuromem-node-mcp",
    "DGX_MODEL_ENABLED=false",
    "",
  ].join("\n");
}

function withEnvValues(content: string, values: Record<string, string>): string {
  let result = content;
  for (const [key, value] of Object.entries(values)) {
    const expression = new RegExp(`^${key}=.*$`, "m");
    result = expression.test(result)
      ? result.replace(expression, `${key}=${value}`)
      : `${result.trimEnd()}\n${key}=${value}\n`;
  }
  return result;
}

function localTestLoginEnv(overrides: Record<string, string> = {}): string {
  return withEnvValues(validEnv(), {
    NEUROMEM_PUBLIC_HOST: "localhost",
    CLOUDFLARE_TUNNEL_TOKEN: "",
    CONTROL_SECURE_COOKIES: "false",
    LOCAL_TEST_LOGIN_PREFILL: "true",
    LOCAL_TEST_LOGIN_EMAIL: "tester@example.com",
    LOCAL_TEST_LOGIN_PASSWORD: "local-test-password-123",
    ...overrides,
  });
}

async function fixture(t: TestContext) {
  const { home, paths } = await temporaryPaths("neuromem-node-deployment-test-");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const deployment = path.join(home, "deployment");
  await fs.mkdir(deployment, { recursive: true });
  await fs.writeFile(path.join(deployment, "compose.yaml"), "services: {}\n");
  const envFile = path.join(home, "node.env");
  await fs.writeFile(envFile, validEnv(), { mode: 0o600 });
  await fs.chmod(envFile, 0o600);
  const runner = new FakeRunner();
  const manager = new NodeDeploymentManager({ paths, runner, deploymentDir: deployment, platform: "darwin", arch: "arm64" });
  return { home, paths, deployment, envFile, runner, manager };
}

test("Node config validation keeps env private and requires an external digest-pinned Memory Core", async t => {
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

test("Local test login prefill is accepted only for an explicit loopback Node", async t => {
  const { envFile, manager } = await fixture(t);

  await fs.writeFile(envFile, localTestLoginEnv());
  assert.equal((await manager.validateConfig(envFile)).ok, true);

  await fs.writeFile(envFile, localTestLoginEnv({ NEUROMEM_PUBLIC_HOST: "memory.example.test" }));
  await assert.rejects(manager.validateConfig(envFile), /cannot be enabled on a public Node/);

  await fs.writeFile(envFile, localTestLoginEnv({ CLOUDFLARE_TUNNEL_TOKEN: "tunnel-token" }));
  await assert.rejects(manager.validateConfig(envFile), /with Cloudflare Tunnel/);

  await fs.writeFile(envFile, localTestLoginEnv({ CONTROL_SECURE_COOKIES: "true" }));
  await assert.rejects(manager.validateConfig(envFile), /requires loopback cookies/);

  await fs.writeFile(envFile, localTestLoginEnv({ LOCAL_TEST_LOGIN_PREFILL: "false" }));
  await assert.rejects(manager.validateConfig(envFile), /require LOCAL_TEST_LOGIN_PREFILL=true/);

  await fs.writeFile(envFile, localTestLoginEnv({ LOCAL_TEST_LOGIN_EMAIL: "not-an-email" }));
  await assert.rejects(manager.validateConfig(envFile), /LOCAL_TEST_LOGIN_EMAIL is invalid/);

  await fs.writeFile(envFile, localTestLoginEnv({ LOCAL_TEST_LOGIN_PASSWORD: "too-short" }));
  await assert.rejects(manager.validateConfig(envFile), /at least 12 safe characters/);
});

test("Mac fallback preflight and Node lifecycle use Compose without starting a second daemon", async t => {
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

test("physical start fails closed when the post-start schema is missing and never reports ready", async t => {
  const { paths, deployment, envFile } = await fixture(t);
  class MissingSchemaRunner extends FakeRunner {
    override async run(command: string, args: readonly string[], options: RunOptions = {}) {
      const result = await super.run(command, args, options);
      if (args.some(value => value.includes("public.principals"))) return { ...result, stdout: "missing" };
      return result;
    }
  }
  let fetchCalls = 0;
  const manager = new NodeDeploymentManager({
    paths,
    deploymentDir: deployment,
    platform: "darwin",
    arch: "arm64",
    runner: new MissingSchemaRunner(),
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("model probes must not run after schema failure");
    },
  });
  const progress: string[] = [];
  await assert.rejects(
    manager.start({ envFile, target: "mac", onProgress: event => progress.push(event.stage) }),
    /control-database schema verification failed/,
  );
  assert.equal(progress.includes("ready"), false);
  assert.equal(fetchCalls, 0);
});

test("physical start verifies actual model contracts on every run and stores a private reusable Admin cache", async t => {
  const { home, paths, deployment, envFile, runner } = await fixture(t);
  let actualProbes = 0;
  let online = true;
  const fetcher: typeof fetch = async (input, init) => {
    if (!online) throw new Error("provider is offline");
    const url = String(input);
    if (url.endsWith("/models")) {
      const id = url.includes(":11434/") ? "qwen3-embedding" : "qwen3.6";
      return new Response(JSON.stringify({ data: [{ id }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/embeddings")) {
      actualProbes += 1;
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body)) as { dimensions: number };
      assert.equal(body.dimensions, 1536);
      return new Response(JSON.stringify({ data: [{ embedding: Array(1536).fill(0.1) }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/chat/completions")) {
      actualProbes += 1;
      assert.equal(init?.method, "POST");
      return new Response(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };
  const manager = new NodeDeploymentManager({ paths, runner, deploymentDir: deployment, platform: "darwin", arch: "arm64", fetch: fetcher });

  const first = await manager.start({ envFile, target: "mac" }) as { ok: boolean; phase: string; compute: { embedding: { status: string }; generation: { status: string } } };
  assert.equal(first.ok, true);
  assert.equal(first.phase, "ready");
  assert.equal(first.compute.embedding.status, "ready");
  assert.equal(first.compute.generation.status, "ready");
  await manager.start({ envFile, target: "mac" });
  assert.equal(actualProbes, 4, "start must execute both actual compatibility probes on every run");

  const cachePath = path.join(home, "model-health.json");
  const cacheText = await fs.readFile(cachePath, "utf8");
  const cache = JSON.parse(cacheText) as { fingerprint: { embedding: { dimensions: number; api_key_configured: boolean }; generation: { api_key_configured: boolean } } };
  assert.equal((await fs.stat(cachePath)).mode & 0o777, 0o600);
  assert.equal(cache.fingerprint.embedding.dimensions, 1536);
  assert.equal(cache.fingerprint.embedding.api_key_configured, true);
  assert.equal(cache.fingerprint.generation.api_key_configured, true);
  assert.doesNotMatch(cacheText, /local-model|authorization/i);

  online = false;
  const admin = await manager.adminStatus(envFile);
  assert.equal(admin.phase, "ready");
  assert.equal(admin.models?.embedding.provider_status, "ready");
  assert.equal(actualProbes, 4, "Admin status should reuse the matching verified cache");

  online = true;
  const replacementKey = "replacement-key-that-is-not-written-to-cache";
  await manager.selectModels({
    generation: {
      source: "openai_compatible",
      model: "qwen3.6",
      connection: { base_url: "http://127.0.0.1:11435/v1", api_key_action: "replace", api_key: replacementKey },
    },
  }, envFile);
  await assert.rejects(fs.access(cachePath), /ENOENT/);
  assert.match(await fs.readFile(envFile, "utf8"), new RegExp(`GENERATION_API_KEY=${replacementKey}`));

  await manager.start({ envFile, target: "mac" });
  runner.fail = (_command, args) => args.includes("--force-recreate");
  await assert.rejects(manager.selectModels({
    generation: {
      source: "openai_compatible",
      model: "qwen3.6",
      connection: { base_url: "http://127.0.0.1:11435/v1", api_key_action: "replace", api_key: "failed-cutover-key" },
    },
  }, envFile), /simulated failure/);
  runner.fail = undefined;
  const restoredEnv = await fs.readFile(envFile, "utf8");
  assert.match(restoredEnv, new RegExp(`GENERATION_API_KEY=${replacementKey}`));
  assert.doesNotMatch(restoredEnv, /failed-cutover-key/);
  await assert.rejects(fs.access(cachePath), /ENOENT/);
});

test("an invalid model provider URL degrades the Node instead of failing start", async t => {
  const { home, paths, deployment, envFile, runner } = await fixture(t);
  const pathSecret = "invalid-provider-path-secret";
  await fs.writeFile(envFile, withEnvValues(validEnv(), {
    EMBEDDING_BASE_URL: `not-a-url-${pathSecret}`,
  }), { mode: 0o600 });
  const fetcher: typeof fetch = async input => {
    const url = String(input);
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "qwen3.6" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/chat/completions")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };
  const manager = new NodeDeploymentManager({ paths, runner, deploymentDir: deployment, platform: "darwin", arch: "arm64", fetch: fetcher });

  const started = await manager.start({ envFile, target: "mac" }) as {
    ok: boolean;
    phase: string;
    warnings: string[];
    compute: { embedding: { status: string; endpoint: string } };
  };
  assert.equal(started.ok, true);
  assert.equal(started.phase, "degraded");
  assert.equal(started.compute.embedding.status, "unavailable");
  assert.equal(started.compute.embedding.endpoint, "invalid");
  assert.match(started.warnings.join(" "), /embedding source is unavailable/);
  assert.doesNotMatch(JSON.stringify(started), new RegExp(pathSecret));
  assert.doesNotMatch(await fs.readFile(path.join(home, "model-health.json"), "utf8"), new RegExp(pathSecret));
});

test("bad model contract responses degrade the Node without reflecting provider secrets", async t => {
  const { home, paths, deployment, envFile, runner } = await fixture(t);
  const providerSecret = "provider-secret-that-must-never-be-reported";
  const responseSecret = "response-secret-that-must-never-be-reported";
  const providerPathSecret = "provider-path-secret-that-must-never-be-stored";
  await fs.writeFile(envFile, withEnvValues(validEnv(), {
    EMBEDDING_API_KEY: providerSecret,
    GENERATION_API_KEY: providerSecret,
    GENERATION_BASE_URL: `http://host.docker.internal:11435/v1/${providerPathSecret}`,
  }), { mode: 0o600 });
  const fetcher: typeof fetch = async input => {
    const url = String(input);
    if (url.endsWith("/models")) {
      const data = url.includes(":11434/") ? [{ id: "qwen3-embedding" }] : [];
      return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({ provider: responseSecret, default_model: "qwen3.6" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/embeddings")) {
      return new Response(JSON.stringify({ data: [{ embedding: Array(1536).fill(0) }], debug: responseSecret }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/chat/completions")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: responseSecret } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: responseSecret }), { status: 500, headers: { "content-type": "application/json" } });
  };
  const manager = new NodeDeploymentManager({ paths, runner, deploymentDir: deployment, platform: "darwin", arch: "arm64", fetch: fetcher });
  const started = await manager.start({ envFile, target: "mac" }) as {
    ok: boolean;
    phase: string;
    warnings: string[];
    compute: { embedding: { status: string }; generation: { status: string } };
  };
  assert.equal(started.ok, true);
  assert.equal(started.phase, "degraded");
  assert.equal(started.compute.embedding.status, "unavailable");
  assert.equal(started.compute.generation.status, "unavailable");
  assert.match(started.warnings.join(" "), /vector norm/);
  assert.match(started.warnings.join(" "), /JSON object/);
  assert.doesNotMatch(JSON.stringify(started), new RegExp(`${providerSecret}|${responseSecret}|${providerPathSecret}`));
  assert.doesNotMatch(await fs.readFile(path.join(home, "model-health.json"), "utf8"), new RegExp(`${providerSecret}|${responseSecret}|${providerPathSecret}`));
  assert.equal((await manager.adminStatus(envFile)).phase, "degraded");
  assert.equal((await manager.adminOperation("start", envFile)).phase, "degraded");
});

test("physical start exercises the configured Codex JSON contract and degrades an incompatible result", async t => {
  const { paths, deployment, envFile, runner } = await fixture(t);
  await fs.writeFile(envFile, withEnvValues(validEnv(), {
    GENERATION_SOURCE: "codex_session",
    GENERATION_BASE_URL: "http://host.docker.internal:14174/v1/internal/codex/nodes/test-physical-node",
    GENERATION_MODEL: "gpt-5.6-luna",
  }), { mode: 0o600 });
  const codex = fakeCodex();
  const fetcher: typeof fetch = async input => {
    const url = String(input);
    if (url.endsWith("/models")) {
      const id = url.includes(":11434/") ? "qwen3-embedding" : "gpt-5.6-luna";
      return new Response(JSON.stringify({ data: [{ id }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/embeddings")) {
      return new Response(JSON.stringify({ data: [{ embedding: Array(1536).fill(0.1) }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };
  const manager = new NodeDeploymentManager({ paths, runner, deploymentDir: deployment, platform: "darwin", arch: "arm64", fetch: fetcher, codex });
  const ready = await manager.start({ envFile, target: "mac" }) as { compute: { generation: { status: string } } };
  assert.equal(ready.compute.generation.status, "ready");
  assert.equal(codex.requests.length, 1);
  assert.deepEqual(codex.requests[0]?.output_schema, {
    type: "object",
    properties: { ok: { type: "boolean", const: true } },
    required: ["ok"],
    additionalProperties: false,
  });

  codex.output = { ok: false };
  const degraded = await manager.start({ envFile, target: "mac" }) as { ok: boolean; warnings: string[]; compute: { generation: { status: string } } };
  assert.equal(degraded.ok, true);
  assert.equal(degraded.compute.generation.status, "unavailable");
  assert.match(degraded.warnings.join(" "), /ok=true/);
  assert.equal(codex.requests.length, 2);
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
  const manager = new NodeDeploymentManager({ paths, runner, deploymentDir: deployment, platform: "linux", arch: "arm64" });
  const result = await manager.preflight("dgx");
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.filter(check => check.name.startsWith("nvidia")).map(check => check.ok), [true, true]);

  const missing = new NodeDeploymentManager({ paths, runner: new FakeRunner(), deploymentDir: deployment, platform: "linux", arch: "arm64" });
  assert.equal((await missing.preflight("dgx")).ok, false);
  assert.equal((await manager.validateConfig(envFile)).ok, true);
  await fs.access(home);
});

test("Node compute status reports configured sources without exposing provider secrets", async t => {
  const { paths, deployment, envFile, runner } = await fixture(t);
  const fetcher: typeof fetch = async input => {
    const url = String(input);
    if (url === "http://127.0.0.1:11434/v1/models") {
      return new Response(JSON.stringify({ data: [{ id: "qwen3-embedding:latest" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "http://127.0.0.1:11435/health") {
      return new Response(JSON.stringify({ status: "ok", provider: "openai-codex", default_model: "qwen3.6" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };
  const manager = new NodeDeploymentManager({ paths, runner, deploymentDir: deployment, platform: "darwin", arch: "arm64", fetch: fetcher });
  const status = await manager.computeStatus(envFile);
  assert.equal(status.embedding.status, "ready");
  assert.equal(status.embedding.endpoint, "http://127.0.0.1:11434/v1");
  assert.equal(status.generation.status, "ready");
  assert.equal(status.generation.source, "codex_session");
  assert.equal(status.generation.provider, "openai-codex");
  assert.doesNotMatch(JSON.stringify(status), /local-model|authorization/i);
});

test("Node MCP config reads a separate 0600 credential and backup/migration rehearsals are non-destructive", async t => {
  const { home, envFile, runner, manager } = await fixture(t);
  const credential = path.join(home, "codex.token");
  const secret = "credential-" + "x".repeat(40);
  await fs.writeFile(credential, `${secret}\n`, { mode: 0o600 });
  await fs.chmod(credential, 0o600);
  const config = JSON.parse(await manager.mcpConfig(envFile, credential, "json"));
  assert.equal(config.mcpServers.neuromem.url, "https://memory.example.test/mcp");
  assert.equal(config.mcpServers.neuromem.headers.Authorization, `Bearer ${secret}`);

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
