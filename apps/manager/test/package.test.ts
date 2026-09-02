import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
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
  for (const image of ["control", "mcp", "web"]) assert.match(listing.stdout, new RegExp(`package/assets/images/${image}/Dockerfile`));
  assert.doesNotMatch(listing.stdout, /package\/assets\/images\/core\//);
  assert.doesNotMatch(listing.stdout, /package\/assets\/compose\.yaml/);
  for (const file of ["compose.yaml", "nginx.conf", "node.env.example", "README.md"]) {
    assert.match(listing.stdout, new RegExp(`package/assets/node/${file.replace(".", "\\.")}`));
  }
  assert.match(listing.stdout, /package\/LICENSE/);
  assert.match(listing.stdout, /package\/assets\/skill\/neuromem-memory\/SKILL\.md/);
  const prefix = path.join(temporary, "prefix");
  const installed = spawnSync("npm", ["install", "--prefix", prefix, tarball], { encoding: "utf8" });
  assert.equal(installed.status, 0, installed.stderr);
  const cli = path.join(prefix, "node_modules", ".bin", "neuromem");
  const help = spawnSync(cli, ["--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Start this physical Node and open Neuromem/);
  assert.match(help.stdout, /node compute status/);
  const skill = spawnSync(cli, ["skill", "path"], { encoding: "utf8" });
  assert.equal(skill.status, 0, skill.stderr);
  assert.match(skill.stdout.trim(), /assets\/skill\/neuromem-memory\/SKILL\.md$/);
  await fs.access(skill.stdout.trim());

  const home = path.join(temporary, "home");
  const initialized = spawnSync(cli, ["node", "config", "init"], {
    encoding: "utf8",
    env: {
    ...process.env,
    NEUROMEM_HOME: home,
    },
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  const envFile = JSON.parse(initialized.stdout).env_file as string;
  const stat = await fs.stat(envFile);
  assert.equal(stat.mode & 0o077, 0);
  const env = await fs.readFile(envFile, "utf8");
  assert.match(env, /^COMPOSE_PROJECT_NAME=neuromem-node$/m);
  assert.match(env, /^NEUROMEM_NODE_ID=[0-9a-f-]+$/m);
  assert.doesNotMatch(env, /replace-with-random-secret/);
});

test("packaged Node deployment references a pinned external Memory Core without vendoring its source", async () => {
  const prepared = spawnSync("npm", ["run", "prepack"], { encoding: "utf8" });
  assert.equal(prepared.status, 0, prepared.stderr);
  const compose = await fs.readFile(path.resolve("assets/node/compose.yaml"), "utf8");
  assert.match(compose, /MEMORY_CORE_IMAGE:\?MEMORY_CORE_IMAGE digest is required/);
  assert.match(compose, /MEMORY_CORE_SOURCE_URL/);
  assert.doesNotMatch(compose, /MEMORY_CORE_CONTEXT|context:.*memory-core/i);
  const manifest = JSON.parse(await fs.readFile(path.resolve("assets/build-manifest.json"), "utf8"));
  assert.equal(manifest.memory_core_vendored, false);
  assert.equal(manifest.node_deployment, "assets/node/compose.yaml");
});
