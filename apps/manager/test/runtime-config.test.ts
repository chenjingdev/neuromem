import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { uuid7 } from "../src/fs-safe.js";
import { NodeManager } from "../src/node-manager.js";
import { persistManagerRuntimeConfig, runtimeConfigPath } from "../src/runtime-config.js";
import { FakeRunner, okFetch, temporaryPaths, threeFreePorts } from "./helpers.js";

test("0600 Manager config carries allowlisted model settings into daemon-created runtime without logging secrets", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const generationKey = "generation-secret-which-must-not-be-logged";
  await persistManagerRuntimeConfig(paths, {
    GENERATION_BASE_URL: "http://host.docker.internal:11434/v1",
    GENERATION_API_KEY: generationKey,
    GENERATION_MODEL: "qwen3:4b",
    EMBEDDING_MODEL: "qwen3-embedding:4b",
  });
  assert.equal((await fs.stat(runtimeConfigPath(paths))).mode & 0o777, 0o600);
  const manager = new NodeManager({ paths, runner: new FakeRunner(), fetch: okFetch() });
  const nodeId = uuid7();
  const operation = await manager.createNode({ node_id: nodeId, confirmation: nodeId, alias: "configured", ports: await threeFreePorts() });
  assert.equal(operation.state, "succeeded");
  const env = await fs.readFile(`${paths.nodes}/${nodeId}/.env`, "utf8");
  assert.match(env, /^GENERATION_BASE_URL=http:\/\/host\.docker\.internal:11434\/v1$/m);
  assert.match(env, /^GENERATION_MODEL=qwen3:4b$/m);
  assert.match(env, new RegExp(`^GENERATION_API_KEY=${generationKey}$`, "m"));
  assert.doesNotMatch(JSON.stringify(operation), new RegExp(generationKey));
});
