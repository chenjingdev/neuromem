import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, "apps", "manager", "assets");
const managerRoot = path.join(root, "apps", "manager");

async function resetDirectory(target) {
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });
}

async function copyEntry(source, destination) {
  await fs.cp(source, destination, {
    recursive: true,
    filter: candidate => !/(^|\/)(node_modules|dist|\.venv|__pycache__|\.pytest_cache|\.ruff_cache)(\/|$)/.test(candidate),
  });
}

async function copyContext(name, entries) {
  const target = path.join(assets, "images", name);
  await resetDirectory(target);
  for (const entry of entries) {
    await copyEntry(path.join(root, entry), path.join(target, path.basename(entry)));
  }
}

const webDist = path.join(root, "apps", "web", "dist");
await fs.access(path.join(webDist, "index.html"));
const adminDist = path.join(assets, "admin-dist");
await resetDirectory(adminDist);
await fs.cp(webDist, adminDist, { recursive: true });

await copyContext("core", [
  "apps/core/.dockerignore",
  "apps/core/Dockerfile",
  "apps/core/pyproject.toml",
  "apps/core/uv.lock",
  "apps/core/alembic.ini",
  "apps/core/alembic",
  "apps/core/neuromem_core",
]);
await copyContext("mcp", [
  "apps/mcp/.dockerignore",
  "apps/mcp/Dockerfile",
  "apps/mcp/package.json",
  "apps/mcp/package-lock.json",
  "apps/mcp/tsconfig.json",
  "apps/mcp/src",
]);
await copyContext("web", [
  "apps/web/.dockerignore",
  "apps/web/Dockerfile",
  "apps/web/package.json",
  "apps/web/package-lock.json",
  "apps/web/index.html",
  "apps/web/nginx.conf.template",
  "apps/web/tsconfig.json",
  "apps/web/tsconfig.app.json",
  "apps/web/tsconfig.node.json",
  "apps/web/vite.config.ts",
  "apps/web/scripts",
  "apps/web/src",
]);

await fs.writeFile(
  path.join(assets, "build-manifest.json"),
  `${JSON.stringify({ format: 1, version: "0.1.0", images: ["core", "mcp", "web"] }, null, 2)}\n`,
  { mode: 0o644 },
);
await fs.copyFile(path.join(root, "LICENSE"), path.join(managerRoot, "LICENSE"));

const packagedSkill = path.join(assets, "skill", "neuromem-memory");
await resetDirectory(packagedSkill);
await copyEntry(path.join(root, "skills", "neuromem-memory"), packagedSkill);
