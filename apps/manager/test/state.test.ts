import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { assertUuid7, uuid7 } from "../src/fs-safe.js";
import { StateStore } from "../src/state.js";
import type { NodeRecord } from "../src/types.js";
import { temporaryPaths } from "./helpers.js";

test("UUIDv7 generator preserves timestamp order and validates Node IDs", () => {
  const first = uuid7(1_700_000_000_000);
  const second = uuid7(1_700_000_000_001);
  assertUuid7(first);
  assertUuid7(second);
  assert.ok(first < second);
  assert.throws(() => assertUuid7("00000000-0000-4000-8000-000000000000"), /UUIDv7/);
});

test("registry, snapshots, operation journal, and lock live outside PostgreSQL", async t => {
  const { home, paths } = await temporaryPaths();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const store = new StateStore(paths);
  const now = new Date().toISOString();
  const nodeId = uuid7();
  const node: NodeRecord = {
    node_id: nodeId, alias: "personal", ports: { api: 18001, dashboard: 14173, mcp: 18765 },
    generation: 1, desired_state: "stopped", phase: "stopped", compose_project: `neuromem-${nodeId.replaceAll("-", "")}`,
    schema_revision: "0001", created_at: now, updated_at: now,
  };
  await store.addNode(node, true);
  assert.equal((await store.defaultNode())?.node_id, node.node_id);
  const operation = await store.beginOperation(node.node_id, "restore_apply", "staging");
  assert.equal(await store.recoverInterruptedOperations(), 1);
  const recovered = JSON.parse(await fs.readFile(`${paths.nodes}/${node.node_id}/operations/${operation.operation_id}.json`, "utf8"));
  assert.equal(recovered.state, "needs_attention");

  let release!: () => void;
  const held = store.withNodeLock(node.node_id, () => new Promise<void>(resolve => { release = resolve; }));
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(store.withNodeLock(node.node_id, async () => undefined), /already has/);
  release();
  await held;
});
