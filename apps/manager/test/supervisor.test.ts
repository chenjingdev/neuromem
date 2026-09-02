import assert from "node:assert/strict";
import test from "node:test";
import { supervisorEnvironmentPath } from "../src/supervisor.js";

test("supervisor PATH keeps package-manager and Docker locations available", () => {
  const value = supervisorEnvironmentPath("/custom/bin:/usr/bin", "/opt/node/bin/node");
  const entries = value.split(":");
  assert.deepEqual(entries.slice(0, 7), [
    "/opt/node/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]);
  assert.equal(entries.filter(entry => entry === "/usr/bin").length, 1);
  assert.ok(entries.includes("/custom/bin"));
});
