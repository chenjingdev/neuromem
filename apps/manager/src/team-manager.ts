import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePrivateDirectory, exists, sha256File } from "./fs-safe.js";
import type { ManagerPaths } from "./paths.js";
import type { CommandResult, CommandRunner } from "./types.js";

export type TeamTarget = "auto" | "dgx" | "mac";

export interface TeamCheck {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
}

export interface TeamPreflight {
  ok: boolean;
  target: Exclude<TeamTarget, "auto">;
  platform: string;
  arch: string;
  checks: TeamCheck[];
  warnings: string[];
}

export interface TeamManagerOptions {
  paths: ManagerPaths;
  runner: CommandRunner;
  deploymentDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

const REQUIRED_ENV = [
  "COMPOSE_PROJECT_NAME", "NEUROMEM_PUBLIC_HOST",
  "CONTROL_POSTGRES_DB", "CONTROL_POSTGRES_USER", "CONTROL_POSTGRES_PASSWORD",
  "CONTROL_TOKEN_PEPPER", "CONTROL_INTERNAL_SIGNING_KEY",
  "MEMORY_POSTGRES_DB", "MEMORY_POSTGRES_USER", "MEMORY_POSTGRES_PASSWORD",
  "MEMORY_REDIS_PASSWORD", "MEMORY_INTERNAL_SIGNING_KEY", "MEMORY_AUTH_JWT_SECRET",
  "MEMORY_CORE_IMAGE", "MEMORY_CORE_SOURCE_URL", "MEMORY_CORE_SOURCE_REVISION",
  "EMBEDDING_BASE_URL", "EMBEDDING_API_KEY", "EMBEDDING_MODEL",
  "GENERATION_BASE_URL", "GENERATION_API_KEY", "GENERATION_MODEL",
  "CONTROL_DB_VOLUME", "MEMORY_DB_VOLUME", "MEMORY_REDIS_VOLUME", "MCP_STATE_VOLUME"
] as const;

const SECRET_ENV = [
  "CONTROL_POSTGRES_PASSWORD", "CONTROL_TOKEN_PEPPER", "CONTROL_INTERNAL_SIGNING_KEY",
  "MEMORY_POSTGRES_PASSWORD", "MEMORY_REDIS_PASSWORD", "MEMORY_INTERNAL_SIGNING_KEY",
  "MEMORY_AUTH_JWT_SECRET"
] as const;

const TEAM_SERVICES = new Set([
  "control-database", "memory-database", "memory-redis", "memory-core", "memory-worker",
  "control", "mcp", "web", "edge", "cloudflared", "generation-model"
]);

export class TeamManager {
  readonly paths: ManagerPaths;
  readonly deploymentDir: string;
  readonly #runner: CommandRunner;
  readonly #platform: NodeJS.Platform;
  readonly #arch: string;

  constructor(options: TeamManagerOptions) {
    this.paths = options.paths;
    this.#runner = options.runner;
    this.deploymentDir = options.deploymentDir || resolveTeamDeploymentDir();
    this.#platform = options.platform || process.platform;
    this.#arch = options.arch || process.arch;
  }

  envPath(explicit?: string): string {
    return explicit ? path.resolve(explicit) : this.paths.teamEnv;
  }

  async validateConfig(explicitEnv?: string): Promise<{
    ok: true;
    env_file: string;
    compose_file: string;
    project: string;
    public_url: string;
    memory_core: { image: string; source: string; revision: string };
  }> {
    const envFile = this.envPath(explicitEnv);
    const env = await readPrivateEnv(envFile);
    for (const key of REQUIRED_ENV) {
      const value = env[key];
      if (!value || /replace-with|example\.com|^<.*>$/i.test(value)) throw new Error(`${key} must be configured in the private team env file`);
    }
    for (const key of SECRET_ENV) {
      if (Buffer.byteLength(env[key]!, "utf8") < 32) throw new Error(`${key} must contain at least 32 bytes`);
    }
    if (env.CONTROL_INTERNAL_SIGNING_KEY !== env.MEMORY_INTERNAL_SIGNING_KEY) {
      throw new Error("CONTROL_INTERNAL_SIGNING_KEY and MEMORY_INTERNAL_SIGNING_KEY must match");
    }
    if (!/^[a-z0-9][a-z0-9.-]+$/i.test(env.NEUROMEM_PUBLIC_HOST!) || env.NEUROMEM_PUBLIC_HOST!.includes("..")) {
      throw new Error("NEUROMEM_PUBLIC_HOST must be a hostname without a scheme or path");
    }
    if (!/^[a-z0-9][a-z0-9_-]{1,62}$/i.test(env.COMPOSE_PROJECT_NAME!)) throw new Error("COMPOSE_PROJECT_NAME is invalid");
    if (!/@sha256:[0-9a-f]{64}$/i.test(env.MEMORY_CORE_IMAGE!)) {
      throw new Error("MEMORY_CORE_IMAGE must be pinned by sha256 digest; local AGPL source is not vendored into the team package");
    }
    if (!/^[0-9a-f]{7,64}$/i.test(env.MEMORY_CORE_SOURCE_REVISION!)) throw new Error("MEMORY_CORE_SOURCE_REVISION must be a pinned commit");
    for (const key of ["CONTROL_DB_VOLUME", "MEMORY_DB_VOLUME", "MEMORY_REDIS_VOLUME", "MCP_STATE_VOLUME"] as const) {
      if (!/^neuromem-team-[a-z0-9][a-z0-9-]{1,62}$/i.test(env[key]!)) throw new Error(`${key} must be a dedicated neuromem-team-* volume`);
    }
    const compose = await this.#compose(envFile, ["config", "--quiet"], true, 60_000);
    if (!compose.ok) throw new Error(`team Compose configuration is invalid${compose.stderr ? `: ${compose.stderr}` : ""}`);
    return {
      ok: true,
      env_file: envFile,
      compose_file: this.composeFile(),
      project: env.COMPOSE_PROJECT_NAME!,
      public_url: `https://${env.NEUROMEM_PUBLIC_HOST}`,
      memory_core: { image: env.MEMORY_CORE_IMAGE!, source: env.MEMORY_CORE_SOURCE_URL!, revision: env.MEMORY_CORE_SOURCE_REVISION! }
    };
  }

  async preflight(target: TeamTarget = "auto"): Promise<TeamPreflight> {
    if (!["auto", "dgx", "mac"].includes(target)) throw new Error("team target must be auto, dgx, or mac");
    const resolved = target === "auto" ? (this.#platform === "linux" && this.#arch === "arm64" ? "dgx" : "mac") : target;
    const checks: TeamCheck[] = [];
    const docker = await this.#runner.run("docker", ["info", "--format", "{{.ServerVersion}}"], { allowFailure: true, timeoutMs: 15_000 });
    checks.push({ name: "docker", ok: docker.ok, detail: docker.ok ? docker.stdout || "available" : docker.stderr || "unavailable", required: true });
    const compose = await this.#runner.run("docker", ["compose", "version", "--short"], { allowFailure: true, timeoutMs: 15_000 });
    checks.push({ name: "compose", ok: compose.ok, detail: compose.ok ? compose.stdout || "available" : compose.stderr || "unavailable", required: true });
    const warnings: string[] = [];
    if (resolved === "dgx") {
      const platformOk = this.#platform === "linux" && this.#arch === "arm64";
      checks.push({ name: "dgx-platform", ok: platformOk, detail: `${this.#platform}/${this.#arch}`, required: true });
      const runtimes = await this.#runner.run("docker", ["info", "--format", "{{json .Runtimes}}"], { allowFailure: true, timeoutMs: 15_000 });
      checks.push({ name: "nvidia-container-runtime", ok: runtimes.ok && /nvidia/i.test(runtimes.stdout), detail: runtimes.stdout || runtimes.stderr || "not reported", required: true });
      const gpu = await this.#runner.run("nvidia-smi", ["-L"], { allowFailure: true, timeoutMs: 15_000 });
      checks.push({ name: "nvidia-gpu", ok: gpu.ok && /GPU/i.test(gpu.stdout), detail: gpu.stdout || gpu.stderr || "not detected", required: true });
    } else {
      const platformOk = this.#platform === "darwin" && this.#arch === "arm64";
      checks.push({ name: "mac-fallback-platform", ok: platformOk, detail: `${this.#platform}/${this.#arch}`, required: true });
      warnings.push("Mac fallback uses external model endpoints through host.docker.internal; NVIDIA containers are disabled.");
    }
    return { ok: checks.every(check => !check.required || check.ok), target: resolved, platform: this.#platform, arch: this.#arch, checks, warnings };
  }

  async start(options: { envFile?: string; target?: TeamTarget } = {}): Promise<unknown> {
    const config = await this.validateConfig(options.envFile);
    const preflight = await this.preflight(options.target || "auto");
    if (!preflight.ok) throw new Error(`team preflight failed: ${preflight.checks.filter(check => check.required && !check.ok).map(check => check.name).join(", ")}`);
    const env = await readPrivateEnv(config.env_file);
    await this.#compose(config.env_file, ["up", "-d", "--wait", "--wait-timeout", "600", "control-database", "memory-database", "memory-redis"], false, 10 * 60_000, env, preflight.target);
    await this.schemaInit(config.env_file, preflight.target);
    await this.#compose(config.env_file, ["up", "-d", "--build", "--remove-orphans", "--wait", "--wait-timeout", "900"], false, 20 * 60_000, env, preflight.target);
    return { ok: true, target: preflight.target, project: config.project, dashboard: config.public_url, mcp: `${config.public_url}/mcp`, warnings: preflight.warnings };
  }

  async stop(explicitEnv?: string): Promise<unknown> {
    const config = await this.validateConfig(explicitEnv);
    await this.#compose(config.env_file, ["stop"], false, 10 * 60_000, await readPrivateEnv(config.env_file), "dgx");
    return { ok: true, project: config.project, volumes_preserved: true };
  }

  async status(explicitEnv?: string): Promise<unknown> {
    const config = await this.validateConfig(explicitEnv);
    const result = await this.#compose(config.env_file, ["ps", "--format", "json"], true, 60_000, await readPrivateEnv(config.env_file));
    return { ok: result.ok, project: config.project, services: parseComposePs(result.stdout), error: result.ok ? undefined : result.stderr || "docker compose ps failed" };
  }

  async logs(explicitEnv: string | undefined, service: string, tail = 200): Promise<string> {
    if (!TEAM_SERVICES.has(service)) throw new Error(`unsupported team service '${service}'`);
    if (!Number.isSafeInteger(tail) || tail < 1 || tail > 5_000) throw new Error("tail must be between 1 and 5000");
    const config = await this.validateConfig(explicitEnv);
    const result = await this.#compose(config.env_file, ["logs", "--no-color", "--tail", String(tail), service], true, 120_000, await readPrivateEnv(config.env_file));
    return [result.stdout, result.stderr].filter(Boolean).join("\n").slice(-2_000_000);
  }

  async schemaInit(explicitEnv?: string, target: Exclude<TeamTarget, "auto"> = "mac"): Promise<unknown> {
    const config = await this.validateConfig(explicitEnv);
    const env = await readPrivateEnv(config.env_file);
    await this.#compose(config.env_file, ["build", "control"], false, 10 * 60_000, env, target);
    await this.#compose(config.env_file, ["up", "-d", "--wait", "--wait-timeout", "300", "control-database"], false, 5 * 60_000, env, target);
    await this.#compose(config.env_file, ["run", "--rm", "--no-deps", "control", "neuromem-control-init"], false, 10 * 60_000, env, target);
    return { ok: true, control_schema: "initialized", memory_schema: "owned by pinned Memory Core entrypoint" };
  }

  async migrationRehearsal(explicitEnv?: string, targetRevision = "head"): Promise<unknown> {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(targetRevision)) throw new Error("invalid migration target revision");
    const config = await this.validateConfig(explicitEnv);
    const env = await readPrivateEnv(config.env_file);
    await this.#compose(config.env_file, ["up", "-d", "--wait", "--wait-timeout", "300", "memory-database"], false, 5 * 60_000, env);
    const entrypoint = "/app/.venv/bin/alembic";
    const current = await this.#compose(config.env_file, ["run", "--rm", "--no-deps", "--entrypoint", entrypoint, "memory-core", "current"], true, 10 * 60_000, env);
    const heads = await this.#compose(config.env_file, ["run", "--rm", "--no-deps", "--entrypoint", entrypoint, "memory-core", "heads"], true, 10 * 60_000, env);
    const currentRevisions = revisionIds(current.stdout);
    const headRevisions = revisionIds(heads.stdout);
    const atTarget = targetRevision === "head"
      ? headRevisions.length > 0 && headRevisions.every(revision => currentRevisions.includes(revision))
      : currentRevisions.some(revision => revision.startsWith(targetRevision.toLowerCase()));
    return {
      ok: current.ok && heads.ok && atTarget,
      applied: false,
      target_revision: targetRevision,
      current_revisions: currentRevisions,
      head_revisions: headRevisions,
      error: current.ok && heads.ok && atTarget ? undefined : current.stderr || heads.stderr || "Memory Core database is not at the requested revision"
    };
  }

  async backupRehearsal(explicitEnv?: string, outputDirectory?: string): Promise<unknown> {
    const config = await this.validateConfig(explicitEnv);
    const env = await readPrivateEnv(config.env_file);
    const parent = outputDirectory ? path.dirname(path.resolve(outputDirectory)) : this.paths.teamBackups;
    await ensurePrivateDirectory(parent);
    const target = outputDirectory ? path.resolve(outputDirectory) : path.join(parent, new Date().toISOString().replace(/[:.]/g, "-"));
    if (await exists(target)) throw new Error(`backup rehearsal output already exists: ${target}`);
    await fs.mkdir(target, { mode: 0o700 });
    const controlDump = path.join(target, "control.dump");
    const memoryDump = path.join(target, "memory.dump");
    await this.#compose(config.env_file, ["exec", "-T", "control-database", "pg_dump", "-U", env.CONTROL_POSTGRES_USER!, "-d", env.CONTROL_POSTGRES_DB!, "-Fc", "-Z", "3"], false, 60 * 60_000, env, undefined, { outputFile: controlDump });
    await this.#compose(config.env_file, ["exec", "-T", "memory-database", "pg_dump", "-U", env.MEMORY_POSTGRES_USER!, "-d", env.MEMORY_POSTGRES_DB!, "-Fc", "-Z", "3"], false, 60 * 60_000, env, undefined, { outputFile: memoryDump });
    for (const [dump, image] of [[controlDump, "postgres:15-bookworm"], [memoryDump, "pgvector/pgvector:0.8.6-pg15"]] as const) {
      await this.#runner.run("docker", ["run", "--rm", "--mount", `type=bind,source=${dump},target=/backup/database.dump,readonly`, "--entrypoint", "pg_restore", image, "--list", "/backup/database.dump"], { timeoutMs: 10 * 60_000 });
    }
    const files = await Promise.all([controlDump, memoryDump].map(async file => ({ name: path.basename(file), bytes: (await fs.stat(file)).size, sha256: await sha256File(file) })));
    const manifest = { format: 1, created_at: new Date().toISOString(), project: config.project, rehearsal: true, databases_stopped: false, files };
    await fs.writeFile(path.join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return { ok: true, applied: false, output: target, manifest };
  }

  async mcpConfig(explicitEnv: string | undefined, credentialFile: string, format: "json" | "toml" = "json"): Promise<string> {
    const config = await this.validateConfig(explicitEnv);
    const token = (await readPrivateText(credentialFile)).trim();
    if (Buffer.byteLength(token, "utf8") < 32 || /[\r\n\0]/.test(token)) throw new Error("team MCP credential file is invalid");
    const url = `${config.public_url}/mcp`;
    if (format === "toml") return `[mcp_servers.neuromem-team]\nurl = ${JSON.stringify(url)}\nhttp_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }\n`;
    if (format !== "json") throw new Error("MCP config format must be json or toml");
    return `${JSON.stringify({ mcpServers: { "neuromem-team": { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)}\n`;
  }

  composeFile(): string { return path.join(this.deploymentDir, "compose.yaml"); }

  async #compose(
    envFile: string,
    command: readonly string[],
    allowFailure: boolean,
    timeoutMs: number,
    parsedEnv?: Record<string, string>,
    target?: Exclude<TeamTarget, "auto">,
    streams: { outputFile?: string } = {}
  ): Promise<CommandResult> {
    const env = parsedEnv || await readPrivateEnv(envFile);
    const profiles: string[] = [];
    if (env.CLOUDFLARE_TUNNEL_TOKEN && !/replace-with/i.test(env.CLOUDFLARE_TUNNEL_TOKEN)) profiles.push("--profile", "cloudflare");
    if (target !== "mac" && env.DGX_MODEL_ENABLED === "true") profiles.push("--profile", "dgx-model");
    return this.#runner.run("docker", ["compose", "--env-file", envFile, "--file", this.composeFile(), ...profiles, ...command], {
      cwd: this.deploymentDir,
      env: {
        ...process.env,
        CONTROL_BUILD_CONTEXT: await buildContext(this.deploymentDir, "control"),
        MCP_BUILD_CONTEXT: await buildContext(this.deploymentDir, "mcp"),
        WEB_BUILD_CONTEXT: await buildContext(this.deploymentDir, "web")
      },
      allowFailure,
      timeoutMs,
      ...streams
    });
  }
}

export function resolveTeamDeploymentDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NEUROMEM_TEAM_DEPLOY_DIR) return path.resolve(env.NEUROMEM_TEAM_DEPLOY_DIR);
  const packaged = fileURLToPath(new URL("../../assets/team", import.meta.url));
  const repository = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)), "deploy", "team");
  return existsSync(path.join(packaged, "compose.yaml")) ? packaged : repository;
}

export async function readPrivateEnv(target: string): Promise<Record<string, string>> {
  const raw = await readPrivateText(target);
  const env: Record<string, string> = {};
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) throw new Error(`invalid team env entry on line ${index + 1}`);
    const key = trimmed.slice(0, separator);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`invalid team env key '${key}'`);
    const value = trimmed.slice(separator + 1).replace(/^(['"])(.*)\1$/, "$2");
    if (/[\r\n\0]/.test(value)) throw new Error(`invalid control character in ${key}`);
    env[key] = value;
  }
  return env;
}

async function readPrivateText(target: string): Promise<string> {
  const resolved = path.resolve(target);
  const stat = await fs.stat(resolved).catch(() => { throw new Error(`private file does not exist: ${resolved}`); });
  if (!stat.isFile()) throw new Error(`private path is not a file: ${resolved}`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error(`private file permissions must be 0600: ${resolved}`);
  return fs.readFile(resolved, "utf8");
}

async function buildContext(deploymentDir: string, service: "control" | "mcp" | "web"): Promise<string> {
  const packaged = path.join(deploymentDir, "images", service);
  if (await exists(packaged)) return packaged;
  const sharedPackaged = path.resolve(deploymentDir, "..", "images", service);
  if (await exists(sharedPackaged)) return sharedPackaged;
  return path.resolve(deploymentDir, "..", "..", "apps", service);
}

function parseComposePs(raw: string): Array<Record<string, unknown>> {
  if (!raw.trim()) return [];
  try {
    return raw.trim().startsWith("[")
      ? JSON.parse(raw) as Array<Record<string, unknown>>
      : raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [{ service: "compose", state: "unknown", detail: raw.slice(0, 2_000) }];
  }
}

function revisionIds(raw: string): string[] {
  return [...new Set((raw.toLowerCase().match(/\b[0-9a-f]{7,64}\b/g) || []))];
}
