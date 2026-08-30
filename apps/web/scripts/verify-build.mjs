import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
const nginx = await readFile(new URL("../nginx.conf.template", import.meta.url), "utf8");
const assets = [...html.matchAll(/(?:src|href)="([^"]+\/assets\/[^"]+)"/g)].map(match => match[1]);

assert.ok(assets.length >= 2, "built index must reference JavaScript and CSS assets");
for (const asset of assets) {
  assert.ok(asset.startsWith("./assets/"), `asset path must be relative: ${asset}`);
  assert.match(new URL(asset, "http://127.0.0.1:14174/admin/").pathname, /^\/admin\/assets\//);
  assert.match(new URL(asset, "http://127.0.0.1:14173/app/").pathname, /^\/app\/assets\//);
}

assert.match(nginx, /absolute_redirect\s+off;/, "SPA redirects must preserve the published host port");
assert.doesNotMatch(nginx, /return\s+30[1278]\s+https?:\/\//, "SPA redirects must not hard-code an internal origin");

process.stdout.write("verified relative assets and host-port-safe SPA redirects\n");
