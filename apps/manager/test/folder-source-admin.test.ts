import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AdminServer } from "../src/admin-server.js";
import { FolderSourceManager } from "../src/folder-sources.js";
import { NodeDeploymentManager } from "../src/node-deployment-manager.js";
import { NodeManager } from "../src/node-manager.js";
import type { CommandResult, CommandRunner, RunOptions } from "../src/types.js";
import { FakeRunner, fakeCodex, freePort, okFetch, temporaryPaths } from "./helpers.js";

const signingKey = "control-internal-signing-key-0123456789abcdef";
const nodeId = "physical-node";
const scopedContext = {
  principal_id: "principal-1",
  credential_id: null,
  workspace_id: "workspace-1",
  project_id: "project-1",
  human_peer_id: "peer-1",
  agent_peer_id: null,
  capabilities: ["project.read", "project.write"],
  request_id: "request-1",
};

test("internal folder routes bind a signed Control context to the physical Node before admin auth", async t => {
  const { home: managerHome, paths } = await temporaryPaths("neuromem-folder-admin-");
  const userHome = await fs.mkdtemp(path.join(os.homedir(), ".neuromem-folder-http-"));
  const selected = path.join(userHome, "project");
  await fs.mkdir(selected);
  await fs.mkdir(paths.node, { recursive: true });
  await fs.writeFile(paths.nodeEnv, [
    `NEUROMEM_NODE_ID=${nodeId}`,
    `CONTROL_INTERNAL_SIGNING_KEY=${signingKey}`,
    "",
  ].join("\n"), { mode: 0o600 });

  const runner = new FakeRunner();
  const pickerRunner = new PickerRunner(selected);
  const legacy = new NodeManager({ paths, runner, codex: fakeCodex(), fetch: okFetch() });
  const deployment = new NodeDeploymentManager({ paths, runner, codex: fakeCodex() });
  const folderSources = new FolderSourceManager({ paths, runner: pickerRunner, platform: "darwin", home: userHome });
  const port = await freePort();
  const server = new AdminServer({ manager: legacy, deployment, paths, port, folderSources });
  await server.start();
  t.after(async () => {
    await server.stop();
    await Promise.all([
      fs.rm(managerHome, { recursive: true, force: true }),
      fs.rm(userHome, { recursive: true, force: true }),
    ]);
  });

  const base = `http://127.0.0.1:${port}`;
  const pickPath = `/v1/internal/nodes/${nodeId}/folder-sources:pick`;
  const detachPath = `/v1/internal/nodes/${nodeId}/folder-sources:detach`;
  const valid = controlToken(scopedContext, signingKey);

  assert.equal((await post(base, pickPath)).status, 401);
  assert.equal((await post(base, pickPath, controlToken(scopedContext, "wrong-signing-key-that-is-at-least-32-bytes"))).status, 401);
  assert.equal((await post(base, `/v1/internal/nodes/another-node/folder-sources:pick`, valid)).status, 404);
  assert.equal((await post(base, pickPath, controlToken({ ...scopedContext, capabilities: ["project.read"] }, signingKey))).status, 403);
  assert.equal((await post(base, pickPath, valid, undefined, "http://127.0.0.1:24443")).status, 403);
  assert.equal(pickerRunner.calls.length, 0);

  const pickedResponse = await post(base, pickPath, valid);
  assert.equal(pickedResponse.status, 200, await pickedResponse.clone().text());
  const picked = await pickedResponse.json() as { cancelled: boolean; source: { source_id: string; display_path: string; status: string } };
  assert.equal(picked.cancelled, false);
  assert.equal(picked.source.display_path, "~/project");
  assert.equal(picked.source.status, "active");
  assert.doesNotMatch(JSON.stringify(picked), new RegExp(escapeRegExp(selected)));
  assert.equal(pickerRunner.calls.length, 1);
  assert.equal((await fs.stat(paths.folderSources)).mode & 0o777, 0o600);

  const foreignContext = controlToken({ ...scopedContext, principal_id: "principal-2" }, signingKey);
  const foreignDetach = await post(base, detachPath, foreignContext, { source_id: picked.source.source_id });
  assert.equal(foreignDetach.status, 404);
  const detached = await post(base, detachPath, valid, { source_id: picked.source.source_id });
  assert.equal(detached.status, 200);
  assert.deepEqual(await detached.json(), { ok: true });
});

class PickerRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[]; options: RunOptions }> = [];
  constructor(private readonly selected: string) {}

  async run(command: string, args: readonly string[], options: RunOptions = {}): Promise<CommandResult> {
    this.calls.push({ command, args: [...args], options });
    return { ok: true, code: 0, stdout: JSON.stringify({ cancelled: false, path: this.selected }), stderr: "" };
  }
}

function post(base: string, requestPath: string, token?: string, body?: unknown, origin?: string): Promise<Response> {
  return fetch(`${base}${requestPath}`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Internal ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(origin ? { origin } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function controlToken(context: Record<string, unknown>, secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const encoded = Buffer.from(JSON.stringify({ v: 1, iat: now, exp: now + 60, context })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  return `nmic1.${encoded}.${signature}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
