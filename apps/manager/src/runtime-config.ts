import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite, exists, readJson } from "./fs-safe.js";
import type { ManagerPaths } from "./paths.js";

const ALLOWED = [
  "NEUROMEM_MANAGER_PORT",
  "NEUROMEM_CORE_IMAGE",
  "NEUROMEM_MCP_IMAGE",
  "NEUROMEM_DASHBOARD_IMAGE",
  "POSTGRES_IMAGE",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_API_KEY",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIMENSIONS",
  "EMBEDDING_SEND_DIMENSIONS",
  "GENERATION_BASE_URL",
  "GENERATION_API_KEY",
  "GENERATION_MODEL",
  "NEUROMEM_CODEX_BINARY",
  "NEUROMEM_COMPOSE_TEMPLATE",
  "NEUROMEM_IMAGE_CONTEXT_ROOT",
  "NEUROMEM_DEFAULT_NODE",
] as const;

export type ManagerRuntimeConfig = Partial<Record<(typeof ALLOWED)[number], string>>;

export function runtimeConfigPath(paths: ManagerPaths): string {
  return path.join(paths.manager, "runtime-config.json");
}

export async function readManagerRuntimeConfig(paths: ManagerPaths): Promise<ManagerRuntimeConfig> {
  const target = runtimeConfigPath(paths);
  if (!(await exists(target))) return {};
  const decoded = await readJson<Record<string, unknown>>(target);
  const config: ManagerRuntimeConfig = {};
  for (const key of ALLOWED) {
    const value = decoded[key];
    if (typeof value === "string" && value && !/[\r\n\0]/.test(value)) config[key] = value;
  }
  return config;
}

export async function persistManagerRuntimeConfig(paths: ManagerPaths, env: NodeJS.ProcessEnv): Promise<ManagerRuntimeConfig> {
  const config = await readManagerRuntimeConfig(paths);
  for (const key of ALLOWED) {
    const value = env[key];
    if (value === undefined || value === "") continue;
    if (/[\r\n\0]/.test(value)) throw new Error(`Invalid control character in ${key}`);
    config[key] = value;
  }
  await atomicWrite(runtimeConfigPath(paths), `${JSON.stringify(config, null, 2)}\n`);
  await fs.chmod(runtimeConfigPath(paths), 0o600);
  return config;
}

export async function applyManagerRuntimeConfig(paths: ManagerPaths): Promise<ManagerRuntimeConfig> {
  const config = await readManagerRuntimeConfig(paths);
  for (const [key, value] of Object.entries(config)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return config;
}
