import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { AdminServer } from "../src/admin-server.js";
import { ManagerClient } from "../src/client.js";
import { uuid7 } from "../src/fs-safe.js";
import { NodeManager } from "../src/node-manager.js";
import { FakeRunner, freePort, okFetch, temporaryPaths, threeFreePorts } from "./helpers.js";

test("Admin HTTP survives independently, exchanges one-time auth, and protects API routes", async t => {
  const { home, paths } = await temporaryPaths();
  const web = path.join(home, "web");
  await fs.mkdir(path.join(web, "assets"), { recursive: true });
  await fs.writeFile(path.join(web, "index.html"), "<h1>admin shell</h1>");
  await fs.writeFile(path.join(web, "assets", "app-123.js"), "console.log('ok')");
  await fs.writeFile(path.join(home, "secret.txt"), "must-not-leak");
  const port = await freePort();
  const manager = new NodeManager({ paths, runner: new FakeRunner(), fetch: okFetch() });
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
  await fs.writeFile(path.join(web, "index.html"), "admin-index");
  await fs.writeFile(path.join(web, "assets", "app-abc.js"), "asset-body");
  await fs.writeFile(path.join(home, "secret.txt"), "secret-body");
  await fs.symlink(path.join(home, "secret.txt"), path.join(web, "assets", "escape.js"));
  const port = await freePort();
  const server = new AdminServer({ manager: new NodeManager({ paths, runner: new FakeRunner(), fetch: okFetch() }), paths, port, webDist: web });
  await server.start();
  t.after(async () => { await server.stop(); await fs.rm(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const index = await fetch(`${base}/admin`);
  assert.equal(await index.text(), "admin-index");
  assert.equal(index.headers.get("cache-control"), "no-store");
  const asset = await fetch(`${base}/admin/assets/app-abc.js`);
  assert.equal(await asset.text(), "asset-body");
  assert.match(asset.headers.get("cache-control")!, /immutable/);
  const traversal = await fetch(`${base}/admin/%2e%2e/secret.txt`);
  assert.notEqual(await traversal.text(), "secret-body");
  const symlink = await fetch(`${base}/admin/assets/escape.js`);
  assert.equal(symlink.status, 403);
  assert.doesNotMatch(await symlink.text(), /secret-body/);
});

test("CLI-only Node creation is unreachable over TCP", async t => {
  const { home, paths } = await temporaryPaths();
  const port = await freePort();
  const manager = new NodeManager({ paths, runner: new FakeRunner(), fetch: okFetch() });
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
  const first = new AdminServer({ manager: new NodeManager({ paths, runner: new FakeRunner(), fetch: okFetch() }), paths, port });
  await first.start();
  t.after(async () => { await first.stop(); await fs.rm(home, { recursive: true, force: true }); });
  const second = new AdminServer({ manager: new NodeManager({ paths, runner: new FakeRunner(), fetch: okFetch() }), paths, port });
  await assert.rejects(second.start(), /already running|already starting/);
  assert.equal((await fs.stat(paths.socket)).mode & 0o777, 0o600);
  assert.equal((await new ManagerClient(paths).health()).ok, true);
});
