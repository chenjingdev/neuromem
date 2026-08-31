#!/usr/bin/env node
import { AdminServer } from "./admin-server.js";
import { NodeManager } from "./node-manager.js";
import { resolveManagerPaths } from "./paths.js";
import { ProcessRunner } from "./process-runner.js";
import { readManagerRuntimeConfig } from "./runtime-config.js";

const paths = resolveManagerPaths();
const runtime = await readManagerRuntimeConfig(paths);
const managerPort = Number(runtime.NEUROMEM_MANAGER_PORT || process.env.NEUROMEM_MANAGER_PORT || 14174);
if (!Number.isSafeInteger(managerPort) || managerPort < 1024 || managerPort > 65535) throw new Error("NEUROMEM_MANAGER_PORT must be an unprivileged TCP port");
const manager = new NodeManager({
  paths,
  runner: new ProcessRunner(),
  managerPort,
  imageContextRoot: runtime.NEUROMEM_IMAGE_CONTEXT_ROOT,
  codexBinary: runtime.NEUROMEM_CODEX_BINARY,
});
const server = new AdminServer({ manager, paths, port: managerPort });

await server.start();

const shutdown = async () => {
  await server.stop();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
