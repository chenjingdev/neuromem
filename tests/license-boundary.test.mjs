import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("source manifest pins the separate AGPL memory core", async () => {
  const manifest = JSON.parse(await readFile(new URL("../SOURCE_MANIFEST.json", import.meta.url), "utf8"));
  assert.equal(manifest.product.license, "Apache-2.0");
  assert.equal(manifest.services.memory_core.license, "AGPL-3.0-only");
  assert.equal(manifest.services.memory_core.upstream_tag, "v3.1.0");
  assert.equal(
    manifest.services.memory_core.upstream_commit,
    "9380bf2753b0001cee6bea34c95896b5bda56fc2",
  );
  assert.equal(
    manifest.services.memory_core.commit,
    "307a6051ffe0b56bfaad88d8c905f4aa00f73724",
  );
  assert.match(
    manifest.services.memory_core.image,
    /^ghcr\.io\/chenjingdev\/neuromem-memory-core@sha256:[0-9a-f]{64}$/,
  );
  assert.equal(
    manifest.services.memory_core.publication_status,
    "source-and-image-published",
  );
  assert.notEqual(manifest.product.repository, manifest.services.memory_core.repository);
});
