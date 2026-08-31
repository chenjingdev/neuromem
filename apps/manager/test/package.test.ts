import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("package is publishable as neuromem and has no install lifecycle mutation", async () => {
  const pkg = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8"));
  assert.equal(pkg.name, "neuromem");
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.license, "Apache-2.0");
  assert.equal(pkg.private, undefined);
  for (const script of ["preinstall", "install", "postinstall", "prepare"]) assert.equal(pkg.scripts?.[script], undefined);
  assert.deepEqual(Object.keys(pkg.bin).sort(), ["neuromem", "neuromemd"]);
  const fallback = await fs.readFile(path.resolve("assets/admin/admin.js"), "utf8");
  assert.match(fallback, /\/v1\/admin\/session/);
  assert.match(fallback, /history\.replaceState/);
  assert.doesNotMatch(fallback, /localStorage|sessionStorage/);
});

test("packed CLI installs in an isolated prefix and exposes help without host mutation", async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "neuromem-pack-test-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const prepared = spawnSync("npm", ["run", "prepack"], { encoding: "utf8" });
  assert.equal(prepared.status, 0, prepared.stderr);
  const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const filename = [...packed.stdout.matchAll(/"filename"\s*:\s*"([^"]+)"/g)].at(-1)?.[1];
  assert.ok(filename, `npm pack did not report a filename: ${packed.stdout.slice(-500)}`);
  const tarball = path.join(temporary, filename);
  const listing = spawnSync("tar", ["-tf", tarball], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /package\/assets\/admin-dist\/index\.html/);
  assert.match(listing.stdout, /package\/assets\/admin-dist\/assets\/[^\n]+-[A-Za-z0-9_-]+\.js/);
  assert.match(listing.stdout, /package\/assets\/admin-dist\/assets\/[^\n]+-[A-Za-z0-9_-]+\.css/);
  for (const image of ["core", "control", "mcp", "web"]) assert.match(listing.stdout, new RegExp(`package/assets/images/${image}/Dockerfile`));
  for (const file of ["compose.yaml", "nginx.conf", "team.env.example", "README.md"]) {
    assert.match(listing.stdout, new RegExp(`package/assets/team/${file.replace(".", "\\.")}`));
  }
  assert.match(listing.stdout, /package\/LICENSE/);
  assert.match(listing.stdout, /package\/assets\/skill\/neuromem-memory\/SKILL\.md/);
  const prefix = path.join(temporary, "prefix");
  const installed = spawnSync("npm", ["install", "--prefix", prefix, tarball], { encoding: "utf8" });
  assert.equal(installed.status, 0, installed.stderr);
  const cli = path.join(prefix, "node_modules", ".bin", "neuromem");
  const help = spawnSync(cli, ["--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Prepare, start, verify, and open the default Node/);
  const skill = spawnSync(cli, ["skill", "path"], { encoding: "utf8" });
  assert.equal(skill.status, 0, skill.stderr);
  assert.match(skill.stdout.trim(), /assets\/skill\/neuromem-memory\/SKILL\.md$/);
  await fs.access(skill.stdout.trim());

  const home = path.join(temporary, "home");
  const runtime = path.join(home, "run");
  await fs.mkdir(runtime, { recursive: true });
  const socket = path.join(runtime, "manager.sock");
  const node = {
    node_id: "018bcfe5-6800-7000-8000-000000000001", alias: "personal",
    ports: { api: 18001, dashboard: 14173, mcp: 18765 }, generation: 1,
    desired_state: "stopped", phase: "stopped", compose_project: "neuromem-test",
    schema_revision: "0001", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  let nodes: typeof node[] = [];
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") response.end('{"ok":true}');
    else if (request.url === "/v1/nodes" && request.method === "GET") response.end(JSON.stringify({ nodes }));
    else if (request.url === "/v1/cli/nodes" && request.method === "POST") {
      nodes = [node];
      response.end(JSON.stringify({ state: "succeeded", result: node }));
    } else if (request.url?.endsWith("/start")) response.end(JSON.stringify({ state: "succeeded" }));
    else { response.statusCode = 404; response.end('{"error":"missing"}'); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve());
  });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const launched = await spawnResult(cli, ["--no-open"], {
    ...process.env,
    NEUROMEM_HOME: home,
    NEUROMEM_RUNTIME_DIR: runtime,
    NEUROMEM_NO_SUPERVISOR: "1",
  });
  assert.equal(launched.code, 0, launched.stderr);
  assert.match(launched.stdout, /"dashboard": "http:\/\/127\.0\.0\.1:14173\/app"/);
});

test("packaged team deployment references a pinned external Memory Core without vendoring its source", async () => {
  const prepared = spawnSync("npm", ["run", "prepack"], { encoding: "utf8" });
  assert.equal(prepared.status, 0, prepared.stderr);
  const compose = await fs.readFile(path.resolve("assets/team/compose.yaml"), "utf8");
  assert.match(compose, /MEMORY_CORE_IMAGE:\?MEMORY_CORE_IMAGE digest is required/);
  assert.match(compose, /MEMORY_CORE_SOURCE_URL/);
  assert.doesNotMatch(compose, /MEMORY_CORE_CONTEXT|context:.*memory-core/i);
  const manifest = JSON.parse(await fs.readFile(path.resolve("assets/build-manifest.json"), "utf8"));
  assert.equal(manifest.memory_core_vendored, false);
  assert.equal(manifest.team_deployment, "assets/team/compose.yaml");
});

test("packaged Compose contract stays aligned with the root deployment contract", async () => {
  const packaged = await fs.readFile(path.resolve("assets/compose.yaml"), "utf8");
  const root = await fs.readFile(path.resolve("../../deploy/compose.yaml"), "utf8");
  for (const marker of [
    "pgvector/pgvector:0.8.6-pg15",
    "postgresql+asyncpg://",
    "NEUROMEM_NODE_ID",
    "NEUROMEM_API_TOKEN",
    "NEUROMEM_EMBEDDING_BASE_URL",
    "NEUROMEM_GENERATION_BASE_URL",
    "NEUROMEM_CORE_URL: http://core:8000",
    "import os; os.kill(1, 0)",
  ]) {
    assert.match(packaged, new RegExp(escapeRegExp(marker)), `packaged Compose missing ${marker}`);
    assert.match(root, new RegExp(escapeRegExp(marker)), `root Compose missing ${marker}`);
  }
  assert.match(packaged, /:3001/);
  assert.match(root, /:3001/);
  assert.match(packaged, /:8080/);
  assert.match(root, /:8080/);
  for (const service of ["database", "core", "worker", "mcp", "web"]) {
    assert.match(packaged, new RegExp(`^  ${service}:`, "m"));
    assert.match(root, new RegExp(`^  ${service}:`, "m"));
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function spawnResult(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", code => resolve({ code: code ?? -1, stdout, stderr }));
  });
}
