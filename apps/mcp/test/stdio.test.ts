import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("stdio harness initializes once, supports bounded batches, and suppresses notifications", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "neuromem-mcp-stdio-test-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  const entry = fileURLToPath(new URL("../src/stdio.js", import.meta.url));
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      NEUROMEM_NODE_ID: "018f0f86-4d70-7a3c-8f2c-123456789abc",
      NEUROMEM_CORE_URL: "http://127.0.0.1:9",
      NEUROMEM_CORE_TOKEN: "core-token-0123456789abcdefghijklmn",
      NEUROMEM_MCP_STATE_DIR: stateDir
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "stdio-test", version: "1.0.0" }
    }
  })}\n`);
  child.stdin.write(`${JSON.stringify([
    { jsonrpc: "2.0", id: 2, method: "ping" },
    { jsonrpc: "2.0", method: "unknown/notification" },
    { jsonrpc: "2.0", id: 3, method: "tools/list" }
  ])}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "unknown/notification" })}\n`);
  child.stdin.end();
  const exitCode = await new Promise<number | null>((resolve) => child.once("close", resolve));
  assert.equal(exitCode, 0, stderr);
  const messages = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);
  assert.equal(messages.length, 2);
  assert.equal((messages[0] as { id: number }).id, 1);
  const batch = messages[1] as Array<{ id: number; result?: { tools?: unknown[] } }>;
  assert.deepEqual(batch.map((item) => item.id), [2, 3]);
  assert.equal(batch[1]?.result?.tools?.length, 8);
});
