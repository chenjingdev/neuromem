import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const composePath = new URL("../deploy/node/compose.yaml", import.meta.url);
const edgePath = new URL("../deploy/node/nginx.conf", import.meta.url);
const envPath = new URL("../deploy/node/node.env.example", import.meta.url);

function serviceBlock(compose, service) {
  const start = compose.indexOf(`  ${service}:`);
  assert.notEqual(start, -1, `missing ${service}`);
  const remainder = compose.slice(start);
  const nextService = remainder.slice(1).search(/^  [A-Za-z0-9_-]+:\s*$/m);
  return nextService === -1 ? remainder : remainder.slice(0, nextService + 1);
}

test("Node deployment exposes only the loopback edge and Cloudflare ingress", async () => {
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
    const block = serviceBlock(compose, service);
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

test("Node environment requires independent control and memory secrets", async () => {
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

test("Control reaches the host-only Manager for signed folder picker requests", async () => {
  const [compose, env, nginx] = await Promise.all([
    readFile(composePath, "utf8"),
    readFile(envPath, "utf8"),
    readFile(edgePath, "utf8"),
  ]);
  const control = serviceBlock(compose, "control");

  assert.match(control, /NEUROMEM_CONTROL_NODE_MANAGER_URL:/);
  assert.match(control, /host\.docker\.internal:14174/);
  assert.match(control, /host\.docker\.internal:host-gateway/);
  assert.match(env, /^NODE_MANAGER_URL=http:\/\/host\.docker\.internal:14174$/m);
  assert.match(nginx, /proxy_read_timeout 610s;/);
});
