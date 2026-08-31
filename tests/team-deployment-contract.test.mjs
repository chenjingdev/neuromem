import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const composePath = new URL("../deploy/team/compose.yaml", import.meta.url);
const edgePath = new URL("../deploy/team/nginx.conf", import.meta.url);
const envPath = new URL("../deploy/team/team.env.example", import.meta.url);

test("team deployment exposes only the loopback edge and Cloudflare ingress", async () => {
  const compose = await readFile(composePath, "utf8");

  for (const service of [
    "control-database",
    "memory-database",
    "memory-redis",
    "memory-core",
    "memory-worker",
    "control",
    "mcp",
    "web",
  ]) {
    const start = compose.indexOf(`  ${service}:`);
    assert.notEqual(start, -1, `missing ${service}`);
    const next = compose.indexOf("\n  ", start + 3);
    const block = compose.slice(start, next === -1 ? compose.length : next);
    assert.doesNotMatch(block, /^\s+ports:/m, `${service} must not publish a host port`);
  }

  assert.match(compose, /127\.0\.0\.1:\$\{EDGE_LOOPBACK_PORT/);
  assert.match(compose, /cloudflare\/cloudflared:/);
  assert.match(compose, /backend: \{\}/);
});

test("edge sends API and MCP traffic only to product gateways", async () => {
  const nginx = await readFile(edgePath, "utf8");
  assert.match(nginx, /location \/api\//);
  assert.match(nginx, /proxy_pass http:\/\/control_api/);
  assert.match(nginx, /location \/mcp/);
  assert.match(nginx, /proxy_pass http:\/\/mcp_api/);
  assert.doesNotMatch(nginx, /memory-core|memory-database|memory-redis/);
});

test("team environment requires independent control and memory secrets", async () => {
  const env = await readFile(envPath, "utf8");
  for (const key of [
    "CONTROL_POSTGRES_PASSWORD",
    "CONTROL_TOKEN_PEPPER",
    "CONTROL_INTERNAL_SIGNING_KEY",
    "MEMORY_POSTGRES_PASSWORD",
    "MEMORY_REDIS_PASSWORD",
    "MEMORY_INTERNAL_SIGNING_KEY",
    "MEMORY_AUTH_JWT_SECRET",
    "CLOUDFLARE_TUNNEL_TOKEN",
  ]) {
    assert.match(env, new RegExp(`^${key}=`, "m"), `missing ${key}`);
  }
});
