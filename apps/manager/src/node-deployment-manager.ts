import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite, ensurePrivateDirectory, exists, sha256File } from "./fs-safe.js";
import type { ManagerPaths } from "./paths.js";
import type { CommandResult, CommandRunner, NodeRecord, NodeStatus } from "./types.js";
import { LocalCodexProvider, type CodexProvider } from "./codex-provider.js";
import type { GenerationProbeInput, ModelSelectionInput, ModelSelectionSnapshot } from "./node-manager.js";

export type NodeTarget = "auto" | "dgx" | "mac";

export interface NodeCheck {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
}

export interface NodePreflight {
  ok: boolean;
  target: Exclude<NodeTarget, "auto">;
  platform: string;
  arch: string;
  checks: NodeCheck[];
  warnings: string[];
}

export interface NodeDeploymentManagerOptions {
  paths: ManagerPaths;
  runner: CommandRunner;
  deploymentDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetch?: typeof fetch;
  managerPort?: number;
  codex?: CodexProvider;
}

export interface NodeStartProgress {
  stage: "config" | "preflight" | "databases" | "schema" | "services" | "compute" | "ready";
  current: number;
  total: 7;
  message: string;
}

export interface ComputeSourceStatus {
  source: "openai_compatible" | "codex_session" | "unknown";
  endpoint: string;
  model: string;
  status: "ready" | "unavailable" | "unknown";
  available_models: string[];
  provider?: string;
  detail?: string;
  checked_at: string;
}

export interface NodeComputeStatus {
  embedding: ComputeSourceStatus;
  generation: ComputeSourceStatus;
}

interface ModelHealthFingerprint {
  embedding: {
    model: string;
    source: "openai_compatible";
    endpoint_fingerprint: string;
    dimensions: number | null;
    api_key_configured: boolean;
  };
  generation: {
    model: string;
    source: "openai_compatible" | "codex_session";
    endpoint_fingerprint: string;
    api_key_configured: boolean;
  };
}

interface ModelHealthCache {
  format: 1;
  node_id: string;
  verified_at: string;
  fingerprint: ModelHealthFingerprint;
  compute: NodeComputeStatus;
}

const REQUIRED_ENV = [
  "COMPOSE_PROJECT_NAME", "NEUROMEM_NODE_ID", "NEUROMEM_PUBLIC_HOST",
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

const NODE_SERVICES = new Set([
  "control-database", "memory-database", "memory-redis", "memory-core", "memory-worker",
  "control", "mcp", "web", "edge", "cloudflared", "generation-model"
]);

export class NodeDeploymentManager {
  readonly paths: ManagerPaths;
  readonly deploymentDir: string;
  readonly #runner: CommandRunner;
  readonly #platform: NodeJS.Platform;
  readonly #arch: string;
  readonly #fetch: typeof fetch;
  readonly #managerPort: number;
  readonly #codex: CodexProvider;

  constructor(options: NodeDeploymentManagerOptions) {
    this.paths = options.paths;
    this.#runner = options.runner;
    this.deploymentDir = options.deploymentDir || resolveNodeDeploymentDir();
    this.#platform = options.platform || process.platform;
    this.#arch = options.arch || process.arch;
    this.#fetch = options.fetch || fetch;
    this.#managerPort = options.managerPort ?? Number(process.env.NEUROMEM_MANAGER_PORT || 14174);
    this.#codex = options.codex || new LocalCodexProvider({ paths: options.paths });
  }

  async close(): Promise<void> {
    await this.#codex.close();
  }

  envPath(explicit?: string): string {
    return explicit ? path.resolve(explicit) : this.paths.nodeEnv;
  }

  async initializeConfig(explicitEnv?: string): Promise<{ ok: true; env_file: string }> {
    const target = explicitEnv ? path.resolve(explicitEnv) : this.paths.nodeEnv;
    if (await exists(target)) throw new Error(`Node env already exists: ${target}`);
    const template = await fs.readFile(path.join(this.deploymentDir, "node.env.example"), "utf8");
    const sharedSigningKey = crypto.randomBytes(32).toString("base64url");
    const nodeId = crypto.randomUUID();
    const bridgeToken = crypto.randomBytes(32).toString("base64url");
    const values: Record<string, string> = {
      COMPOSE_PROJECT_NAME: "neuromem-node",
      NEUROMEM_NODE_ID: nodeId,
      NEUROMEM_PUBLIC_HOST: "localhost",
      CLOUDFLARE_TUNNEL_TOKEN: "",
      CONTROL_POSTGRES_PASSWORD: crypto.randomBytes(32).toString("base64url"),
      CONTROL_TOKEN_PEPPER: crypto.randomBytes(32).toString("base64url"),
      CONTROL_INTERNAL_SIGNING_KEY: sharedSigningKey,
      CONTROL_SECURE_COOKIES: "false",
      MEMORY_POSTGRES_PASSWORD: crypto.randomBytes(32).toString("base64url"),
      MEMORY_REDIS_PASSWORD: crypto.randomBytes(32).toString("base64url"),
      MEMORY_INTERNAL_SIGNING_KEY: sharedSigningKey,
      MEMORY_AUTH_JWT_SECRET: crypto.randomBytes(32).toString("base64url"),
      GENERATION_BASE_URL: `http://host.docker.internal:${this.#managerPort}/v1/internal/codex/nodes/${nodeId}`,
      GENERATION_API_KEY: bridgeToken,
      GENERATION_MODEL: "gpt-5.6-sol",
      GENERATION_SOURCE: "codex_session",
      GENERATION_DIRECT_BASE_URL: "",
      GENERATION_DIRECT_API_KEY: "",
      GENERATION_DIRECT_MODEL: "",
      NODE_CODEX_BRIDGE_TOKEN: bridgeToken,
      CONTROL_DB_VOLUME: "neuromem-node-control-db",
      MEMORY_DB_VOLUME: "neuromem-node-memory-db",
      MEMORY_REDIS_VOLUME: "neuromem-node-memory-redis",
      MCP_STATE_VOLUME: "neuromem-node-mcp",
    };
    let content = template;
    for (const [key, value] of Object.entries(values)) {
      const expression = new RegExp(`^${key}=.*$`, "m");
      if (!expression.test(content)) throw new Error(`Node env template is missing ${key}`);
      content = content.replace(expression, `${key}=${value}`);
    }
    await ensurePrivateDirectory(path.dirname(target));
    await fs.writeFile(target, content, { flag: "wx", mode: 0o600 });
    await fs.chmod(target, 0o600);
    return { ok: true, env_file: target };
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
      if (!value || /replace-with|example\.com|^<.*>$/i.test(value)) throw new Error(`${key} must be configured in the private Node env file`);
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
    if (!["true", "false"].includes(env.LOCAL_TEST_LOGIN_PREFILL || "false")) throw new Error("LOCAL_TEST_LOGIN_PREFILL must be true or false");
    const localTestLogin = env.LOCAL_TEST_LOGIN_PREFILL === "true";
    const localTestEmail = env.LOCAL_TEST_LOGIN_EMAIL || "";
    const localTestPassword = env.LOCAL_TEST_LOGIN_PASSWORD || "";
    if (localTestLogin) {
      if (!["localhost", "127.0.0.1"].includes(env.NEUROMEM_PUBLIC_HOST!.toLowerCase()) || env.CLOUDFLARE_TUNNEL_TOKEN) {
        throw new Error("Local test login prefill cannot be enabled on a public Node or with Cloudflare Tunnel");
      }
      if (env.CONTROL_SECURE_COOKIES !== "false") throw new Error("Local test login prefill requires loopback cookies");
      if (!/^\S+@\S+\.\S+$/.test(localTestEmail) || Buffer.byteLength(localTestEmail, "utf8") > 320) throw new Error("LOCAL_TEST_LOGIN_EMAIL is invalid");
      if (localTestPassword.length < 12 || /[\r\n\0]/.test(localTestPassword)) throw new Error("LOCAL_TEST_LOGIN_PASSWORD must contain at least 12 safe characters");
    } else if (localTestEmail || localTestPassword) {
      throw new Error("Local test login values require LOCAL_TEST_LOGIN_PREFILL=true");
    }
    if (!/^[a-z0-9][a-z0-9_-]{1,62}$/i.test(env.COMPOSE_PROJECT_NAME!)) throw new Error("COMPOSE_PROJECT_NAME is invalid");
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(env.NEUROMEM_NODE_ID!)) throw new Error("NEUROMEM_NODE_ID is invalid");
    if (!/@sha256:[0-9a-f]{64}$/i.test(env.MEMORY_CORE_IMAGE!)) {
      throw new Error("MEMORY_CORE_IMAGE must be pinned by sha256 digest; local AGPL source is not vendored into the Node package");
    }
    if (!/^[0-9a-f]{7,64}$/i.test(env.MEMORY_CORE_SOURCE_REVISION!)) throw new Error("MEMORY_CORE_SOURCE_REVISION must be a pinned commit");
    for (const key of ["CONTROL_DB_VOLUME", "MEMORY_DB_VOLUME", "MEMORY_REDIS_VOLUME", "MCP_STATE_VOLUME"] as const) {
      if (!/^neuromem-node-[a-z0-9][a-z0-9-]{1,62}$/i.test(env[key]!)) throw new Error(`${key} must be a dedicated neuromem-node-* volume`);
    }
    const compose = await this.#compose(envFile, ["config", "--quiet"], true, 60_000);
    if (!compose.ok) throw new Error(`Node Compose configuration is invalid${compose.stderr ? `: ${compose.stderr}` : ""}`);
    return {
      ok: true,
      env_file: envFile,
      compose_file: this.composeFile(),
      project: env.COMPOSE_PROJECT_NAME!,
      public_url: nodePublicUrl(env),
      memory_core: { image: env.MEMORY_CORE_IMAGE!, source: env.MEMORY_CORE_SOURCE_URL!, revision: env.MEMORY_CORE_SOURCE_REVISION! }
    };
  }

  async preflight(target: NodeTarget = "auto"): Promise<NodePreflight> {
    if (!["auto", "dgx", "mac"].includes(target)) throw new Error("Node target must be auto, dgx, or mac");
    const resolved = target === "auto" ? (this.#platform === "linux" && this.#arch === "arm64" ? "dgx" : "mac") : target;
    const checks: NodeCheck[] = [];
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

  async start(options: { envFile?: string; target?: NodeTarget; onProgress?: (progress: NodeStartProgress) => void } = {}): Promise<unknown> {
    const progress = (stage: NodeStartProgress["stage"], current: number, message: string) => options.onProgress?.({ stage, current, total: 7, message });
    progress("config", 1, "Node 설정을 확인합니다.");
    if (!options.envFile && !existsSync(this.paths.nodeEnv)) {
      await this.initializeConfig();
    }
    const config = await this.validateConfig(options.envFile);
    progress("preflight", 2, "장치와 Docker 실행 환경을 확인합니다.");
    const preflight = await this.preflight(options.target || "auto");
    if (!preflight.ok) throw new Error(`Node preflight failed: ${preflight.checks.filter(check => check.required && !check.ok).map(check => check.name).join(", ")}`);
    const env = await readPrivateEnv(config.env_file);
    progress("databases", 3, "Node 데이터 서비스를 시작합니다.");
    await this.#compose(config.env_file, ["up", "-d", "--wait", "--wait-timeout", "600", "control-database", "memory-database", "memory-redis"], false, 10 * 60_000, env, preflight.target);
    progress("schema", 4, "Workspace와 Project 스키마를 준비합니다.");
    await this.schemaInit(config.env_file, preflight.target);
    progress("services", 5, "메모리·Control·MCP·Web 서비스를 시작합니다.");
    await this.#compose(config.env_file, ["up", "-d", "--build", "--remove-orphans", "--wait", "--wait-timeout", "900"], false, 20 * 60_000, env, preflight.target);
    progress("compute", 6, "스키마와 임베딩·생성 계약을 검증합니다.");
    await this.#verifyUnifiedSchema(config.env_file, env, preflight.target);
    const compute = await this.#verifyModelContracts(config.env_file, env);
    const computeWarnings = Object.entries(compute)
      .filter(([, value]) => value.status !== "ready")
      .map(([role, value]) => `${role} source is ${value.status}: ${value.detail || "probe failed"}`);
    progress("ready", 7, "Node가 준비되었습니다.");
    return {
      ok: true,
      phase: computeWarnings.length === 0 ? "ready" : "degraded",
      node: config.project,
      device: preflight.target,
      dashboard: config.public_url,
      mcp: `${config.public_url}/mcp`,
      compute,
      warnings: [...preflight.warnings, ...computeWarnings],
    };
  }

  async stop(explicitEnv?: string): Promise<unknown> {
    const config = await this.validateConfig(explicitEnv);
    await this.#compose(config.env_file, ["stop"], false, 10 * 60_000, await readPrivateEnv(config.env_file), "dgx");
    return { ok: true, node: config.project, volumes_preserved: true };
  }

  async status(explicitEnv?: string): Promise<unknown> {
    const config = await this.validateConfig(explicitEnv);
    const result = await this.#compose(config.env_file, ["ps", "--format", "json"], true, 60_000, await readPrivateEnv(config.env_file));
    return {
      ok: result.ok,
      node: config.project,
      dashboard: config.public_url,
      services: parseComposePs(result.stdout),
      compute: await this.computeStatus(config.env_file),
      error: result.ok ? undefined : result.stderr || "docker compose ps failed",
    };
  }

  async adminStatus(explicitEnv?: string): Promise<NodeStatus> {
    const config = await this.validateConfig(explicitEnv);
    const env = await readPrivateEnv(config.env_file);
    const result = await this.#compose(config.env_file, ["ps", "--format", "json"], true, 60_000, env);
    const services = parseComposePs(result.stdout);
    const cachedCompute = await this.#cachedModelHealth(config.env_file, env);
    const compute = cachedCompute || await this.computeStatus(config.env_file);
    const components = services.map(service => ({
      name: String(service.Service || service.service || service.Name || service.name || "unknown"),
      state: String(service.State || service.state || "unknown").toLowerCase(),
      health: service.Health ? String(service.Health).toLowerCase() : undefined,
      detail: String(service.Status || service.status || service.Health || service.health || ""),
    }));
    const running = components.filter(component => component.state === "running").length;
    const unhealthy = components.some(component => component.health && component.health !== "healthy");
    const servicePhase = !result.ok ? "failed" : components.length === 0 || running === 0 ? "stopped" : unhealthy || running !== components.length ? "degraded" : "ready";
    const verifiedModelsDegraded = Boolean(cachedCompute && Object.values(cachedCompute).some(source => source.status !== "ready"));
    const phase = servicePhase === "ready" && verifiedModelsDegraded ? "degraded" : servicePhase;
    const port = Number(env.EDGE_LOOPBACK_PORT || 24443);
    const now = new Date().toISOString();
    const record: NodeRecord = {
      node_id: nodeId(env),
      alias: env.NEUROMEM_NODE_NAME || env.COMPOSE_PROJECT_NAME || "Neuromem Node",
      ports: { api: port, dashboard: port, mcp: port },
      generation: 1,
      desired_state: phase === "stopped" ? "stopped" : "running",
      phase,
      compose_project: env.COMPOSE_PROJECT_NAME!,
      schema_revision: env.MEMORY_CORE_SOURCE_REVISION || "unknown",
      created_at: now,
      updated_at: now,
    };
    return {
      node: record,
      docker_available: result.ok,
      phase,
      components,
      endpoints: { api: `${config.public_url}/api`, dashboard: config.public_url, mcp: `${config.public_url}/mcp` },
      models: {
        embedding: computeProviderStatus(compute.embedding),
        extraction: computeProviderStatus(compute.generation),
      },
      ...(!result.ok ? { error: result.stderr || "Docker Compose status failed" } : {}),
    };
  }

  async adminOperation(action: "start" | "stop" | "restart", explicitEnv?: string): Promise<Record<string, unknown>> {
    const env = await readPrivateEnv(this.envPath(explicitEnv));
    let phase = action === "stop" ? "stopped" : "ready";
    if (action === "stop") await this.stop(explicitEnv);
    else if (action === "restart") {
      await this.stop(explicitEnv);
      const result = await this.start({ envFile: explicitEnv }) as { phase?: string };
      if (result.phase === "degraded") phase = "degraded";
    } else {
      const result = await this.start({ envFile: explicitEnv }) as { phase?: string };
      if (result.phase === "degraded") phase = "degraded";
    }
    return operationResult(nodeId(env), action, phase);
  }

  async computeStatus(explicitEnv?: string): Promise<NodeComputeStatus> {
    const envFile = this.envPath(explicitEnv);
    const env = await readPrivateEnv(envFile);
    const [embedding, generation] = await Promise.all([
      this.#probeComputeSource("embedding", env.EMBEDDING_BASE_URL!, env.EMBEDDING_MODEL!, env.EMBEDDING_API_KEY || ""),
      this.#probeComputeSource("generation", env.GENERATION_BASE_URL!, env.GENERATION_MODEL!, env.GENERATION_API_KEY || ""),
    ]);
    return { embedding, generation };
  }

  async modelSelection(explicitEnv?: string): Promise<ModelSelectionSnapshot> {
    const envFile = this.envPath(explicitEnv);
    const env = await readPrivateEnv(envFile);
    const [compute, codex] = await Promise.all([this.computeStatus(envFile), this.#codex.sessionStatus()]);
    const activeSource = generationSource(env, compute.generation);
    const directBase = env.GENERATION_DIRECT_BASE_URL || (activeSource === "openai_compatible" ? env.GENERATION_BASE_URL : "");
    const directModel = env.GENERATION_DIRECT_MODEL || (activeSource === "openai_compatible" ? env.GENERATION_MODEL : "");
    const directKey = env.GENERATION_DIRECT_API_KEY || (activeSource === "openai_compatible" ? env.GENERATION_API_KEY : "");
    const direct = directBase
      ? await this.#probeComputeSource("generation", directBase, directModel || env.GENERATION_MODEL!, directKey || "")
      : null;
    return {
      node_id: nodeId(env),
      embedding: {
        model: env.EMBEDDING_MODEL || null,
        available_models: compute.embedding.available_models,
        diagnostic: compute.embedding.status === "ready" ? null : compute.embedding.detail || "Embedding provider is unavailable",
      },
      generation: {
        model: env.GENERATION_MODEL || null,
        available_models: activeSource === "codex_session" ? codex.available_models : direct?.available_models || [],
        diagnostic: activeSource === "codex_session"
          ? (codex.auth_status === "signed_in" ? null : codex.diagnostic)
          : (direct?.status === "ready" ? null : direct?.detail || "Generation provider is unavailable"),
        active_source: activeSource,
        sources: {
          codex_session: codex,
          openai_compatible: {
            configured: Boolean(directBase),
            connection_origin: directBase ? "generation" : null,
            display_base_url: directBase ? displayEndpoint(directBase) : null,
            api_key_configured: Boolean(directKey),
            model: directModel || null,
            available_models: direct?.available_models || [],
            diagnostic: direct ? (direct.status === "ready" ? null : direct.detail || "Generation provider is unavailable") : "Model provider is not configured",
            last_checked_at: direct?.checked_at || new Date().toISOString(),
          },
        },
      },
    };
  }

  async generationProbe(input: unknown, explicitEnv?: string): Promise<Record<string, unknown>> {
    const env = await readPrivateEnv(this.envPath(explicitEnv));
    const probe = validateGenerationProbe(input);
    if (probe.source === "codex_session") {
      const status = await this.#codex.sessionStatus();
      if (status.auth_status !== "signed_in") throw new Error("Codex is not signed in with ChatGPT");
      if (probe.model && !status.available_models.includes(probe.model)) throw new Error("Selected Codex model is unavailable");
      return {
        source: "codex_session",
        available_models: status.available_models,
        model_compatible: Boolean(probe.model),
        diagnostic: null,
        codex: status,
      };
    }
    const connection = resolveDirectConnection(env, probe.connection);
    const status = await this.#probeComputeSource("generation", connection.base_url, probe.model || env.GENERATION_DIRECT_MODEL || env.GENERATION_MODEL!, connection.api_key);
    return {
      source: "openai_compatible",
      available_models: status.available_models,
      model_compatible: Boolean(probe.model && (status.available_models.length === 0 || status.available_models.includes(probe.model))),
      diagnostic: status.status === "ready" ? null : status.detail || "Generation provider is unavailable",
      display_base_url: status.endpoint,
      api_key_configured: Boolean(connection.api_key),
    };
  }

  async selectModels(input: unknown, explicitEnv?: string): Promise<Record<string, unknown>> {
    const selection = validateModelSelection(input);
    const envFile = this.envPath(explicitEnv);
    const previous = await readPrivateText(envFile);
    const env = await readPrivateEnv(envFile);
    const updates: Record<string, string> = {};
    if (selection.embedding_model) {
      const compute = await this.computeStatus(envFile);
      if (compute.embedding.available_models.length && !compute.embedding.available_models.some(model => model === selection.embedding_model || model.replace(/:latest$/, "") === selection.embedding_model)) {
        throw new Error("Selected embedding model is unavailable");
      }
      updates.EMBEDDING_MODEL = selection.embedding_model;
    }
    if (selection.generation) {
      await this.generationProbe(selection.generation, envFile);
      if (selection.generation.source === "codex_session") {
        const token = env.NODE_CODEX_BRIDGE_TOKEN || crypto.randomBytes(32).toString("base64url");
        updates.GENERATION_SOURCE = "codex_session";
        updates.GENERATION_BASE_URL = codexBridgeBaseUrl(this.#managerPort, nodeId(env));
        updates.GENERATION_API_KEY = token;
        updates.GENERATION_MODEL = selection.generation.model;
        updates.NODE_CODEX_BRIDGE_TOKEN = token;
      } else {
        const connection = resolveDirectConnection(env, selection.generation.connection);
        updates.GENERATION_SOURCE = "openai_compatible";
        updates.GENERATION_BASE_URL = containerEndpoint(connection.base_url);
        updates.GENERATION_API_KEY = connection.api_key;
        updates.GENERATION_MODEL = selection.generation.model;
        updates.GENERATION_DIRECT_BASE_URL = containerEndpoint(connection.base_url);
        updates.GENERATION_DIRECT_API_KEY = connection.api_key;
        updates.GENERATION_DIRECT_MODEL = selection.generation.model;
      }
    }
    if (!Object.keys(updates).length) throw new Error("At least one model selection is required");
    const next = replaceEnvValues(previous, updates);
    await this.#invalidateModelHealth(envFile);
    try {
      await writePrivateEnv(envFile, next);
      const config = await this.validateConfig(envFile);
      const parsed = await readPrivateEnv(config.env_file);
      await this.#compose(config.env_file, ["up", "-d", "--force-recreate", "--wait", "--wait-timeout", "300", "memory-core", "memory-worker", "control"], false, 10 * 60_000, parsed);
    } catch (error) {
      await writePrivateEnv(envFile, previous);
      await this.#invalidateModelHealth(envFile);
      throw error;
    }
    return operationResult(nodeId(env), "models_configure", "applied", { compute: await this.computeStatus(envFile) });
  }

  async codexBridgeModels(selector: string, authorization: string | undefined, explicitEnv?: string): Promise<Record<string, unknown>> {
    const env = await this.#authorizeCodexBridge(selector, authorization, explicitEnv);
    if (generationSource(env) !== "codex_session") throw new Error("Codex generation is not active for this Node");
    const status = await this.#codex.sessionStatus();
    if (status.auth_status !== "signed_in") throw new Error("Codex is not signed in with ChatGPT");
    return { object: "list", data: status.available_models.map(id => ({ id, object: "model", owned_by: "codex" })) };
  }

  async codexChatCompletion(selector: string, authorization: string | undefined, input: unknown, explicitEnv?: string): Promise<Record<string, unknown>> {
    const env = await this.#authorizeCodexBridge(selector, authorization, explicitEnv);
    if (generationSource(env) !== "codex_session") throw new Error("Codex generation is not active for this Node");
    const request = validateCodexCompletion(input, env.GENERATION_MODEL!);
    const content = await this.#codex.generateJson({
      model: request.model,
      messages: request.messages,
      output_schema: request.output_schema,
    });
    return {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    };
  }

  async logs(explicitEnv: string | undefined, service: string, tail = 200): Promise<string> {
    if (!NODE_SERVICES.has(service)) throw new Error(`unsupported Node service '${service}'`);
    if (!Number.isSafeInteger(tail) || tail < 1 || tail > 5_000) throw new Error("tail must be between 1 and 5000");
    const config = await this.validateConfig(explicitEnv);
    const result = await this.#compose(config.env_file, ["logs", "--no-color", "--tail", String(tail), service], true, 120_000, await readPrivateEnv(config.env_file));
    return [result.stdout, result.stderr].filter(Boolean).join("\n").slice(-2_000_000);
  }

  async schemaInit(explicitEnv?: string, target: Exclude<NodeTarget, "auto"> = "mac"): Promise<unknown> {
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
    const parent = outputDirectory ? path.dirname(path.resolve(outputDirectory)) : this.paths.nodeBackups;
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
    if (Buffer.byteLength(token, "utf8") < 32 || /[\r\n\0]/.test(token)) throw new Error("Node MCP credential file is invalid");
    const url = `${config.public_url}/mcp`;
    if (format === "toml") return `[mcp_servers.neuromem]\nurl = ${JSON.stringify(url)}\nhttp_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }\n`;
    if (format !== "json") throw new Error("MCP config format must be json or toml");
    return `${JSON.stringify({ mcpServers: { neuromem: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)}\n`;
  }

  composeFile(): string { return path.join(this.deploymentDir, "compose.yaml"); }

  async #verifyUnifiedSchema(
    envFile: string,
    env: Record<string, string>,
    target: Exclude<NodeTarget, "auto">,
  ): Promise<void> {
    const checks = [
      {
        service: "control-database",
        user: env.CONTROL_POSTGRES_USER!,
        database: env.CONTROL_POSTGRES_DB!,
        sql: "SELECT CASE WHEN to_regclass('public.principals') IS NOT NULL AND to_regclass('public.workspaces') IS NOT NULL AND to_regclass('public.projects') IS NOT NULL THEN 'ok' ELSE 'missing' END;",
      },
      {
        service: "memory-database",
        user: env.MEMORY_POSTGRES_USER!,
        database: env.MEMORY_POSTGRES_DB!,
        sql: "SELECT CASE WHEN to_regclass('public.workspaces') IS NOT NULL AND to_regclass('public.queue') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN 'ok' ELSE 'missing' END;",
      },
    ];
    for (const check of checks) {
      const result = await this.#compose(envFile, [
        "exec", "-T", check.service, "psql", "-U", check.user, "-d", check.database,
        "-v", "ON_ERROR_STOP=1", "-qAtc", check.sql,
      ], true, 30_000, env, target);
      if (!result.ok || result.stdout.trim() !== "ok") throw new Error(`${check.service} schema verification failed`);
    }
  }

  async #verifyModelContracts(envFile: string, env: Record<string, string>): Promise<NodeComputeStatus> {
    const discovered = await this.computeStatus(envFile);
    const [embedding, generation] = await Promise.all([
      this.#verifyEmbeddingContract(env, discovered.embedding),
      this.#verifyGenerationContract(env, discovered.generation),
    ]);
    const compute = modelHealthCompute({ embedding, generation }, env);
    const cache: ModelHealthCache = {
      format: 1,
      node_id: nodeId(env),
      verified_at: new Date().toISOString(),
      fingerprint: modelHealthFingerprint(env),
      compute,
    };
    await atomicWrite(this.#modelHealthPath(envFile), `${JSON.stringify(cache, null, 2)}\n`, 0o600);
    return compute;
  }

  async #verifyEmbeddingContract(env: Record<string, string>, discovered: ComputeSourceStatus): Promise<ComputeSourceStatus> {
    try {
      const dimensions = configuredEmbeddingDimensions(env);
      const response = await this.#fetch(providerUrl(env.EMBEDDING_BASE_URL!, "embeddings"), {
        method: "POST",
        headers: modelRequestHeaders(env.EMBEDDING_API_KEY || ""),
        body: JSON.stringify({
          model: env.EMBEDDING_MODEL!,
          input: ["Neuromem compatibility probe"],
          dimensions,
          encoding_format: "float",
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new ModelContractError(`Embedding compatibility probe returned HTTP ${response.status}`);
      const payload = await response.json().catch(() => null) as { data?: Array<{ embedding?: unknown }> } | null;
      const embedding = payload?.data?.[0]?.embedding;
      if (!Array.isArray(embedding)) throw new ModelContractError("Embedding compatibility probe returned an invalid vector");
      if (embedding.length !== dimensions) throw new ModelContractError(`Embedding compatibility probe returned ${embedding.length} dimensions; expected ${dimensions}`);
      if (!embedding.every(value => typeof value === "number" && Number.isFinite(value))) {
        throw new ModelContractError("Embedding compatibility probe returned non-finite vector values");
      }
      const norm = Math.sqrt(embedding.reduce((sum: number, value) => sum + (value as number) * (value as number), 0));
      if (!Number.isFinite(norm) || norm === 0) throw new ModelContractError("Embedding compatibility probe returned a zero or invalid vector norm");
      return verifiedModelStatus(discovered, "openai_compatible", "ready");
    } catch (error) {
      return verifiedModelStatus(discovered, "openai_compatible", "unavailable", modelContractDetail(error, "Could not complete the embedding compatibility probe"));
    }
  }

  async #verifyGenerationContract(env: Record<string, string>, discovered: ComputeSourceStatus): Promise<ComputeSourceStatus> {
    const source = generationSource(env, discovered);
    try {
      if (source === "codex_session") {
        const session = await this.#codex.sessionStatus();
        if (session.auth_status !== "signed_in") throw new ModelContractError("Codex is not signed in with ChatGPT");
        if (!session.available_models.includes(env.GENERATION_MODEL!)) throw new ModelContractError("Configured Codex model is unavailable");
        const content = await this.#codex.generateJson({
          model: env.GENERATION_MODEL!,
          messages: [{ role: "user", content: "Return one JSON object whose ok field is true. Do not use tools." }],
          output_schema: {
            type: "object",
            properties: { ok: { type: "boolean", const: true } },
            required: ["ok"],
            additionalProperties: false,
          },
        });
        const parsed = parseJsonObject(content, "Codex compatibility probe did not return a JSON object");
        if (parsed.ok !== true) throw new ModelContractError("Codex compatibility probe did not return ok=true");
        return verifiedModelStatus({
          ...discovered,
          source,
          provider: discovered.provider || "openai-codex",
          available_models: [...new Set(session.available_models)].sort(),
        }, source, "ready");
      }
      const response = await this.#fetch(providerUrl(env.GENERATION_BASE_URL!, "chat/completions"), {
        method: "POST",
        headers: modelRequestHeaders(env.GENERATION_API_KEY || ""),
        body: JSON.stringify({
          model: env.GENERATION_MODEL!,
          messages: [{ role: "user", content: "Return one JSON object with an ok field." }],
          response_format: { type: "json_object" },
          temperature: 0,
          max_tokens: 32,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new ModelContractError(`Generation compatibility probe returned HTTP ${response.status}`);
      const payload = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: unknown } }> } | null;
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new ModelContractError("Generation compatibility probe returned an invalid chat response");
      parseJsonObject(content, "Generation compatibility probe did not return a JSON object");
      return verifiedModelStatus(discovered, source, "ready");
    } catch (error) {
      return verifiedModelStatus(discovered, source, "unavailable", modelContractDetail(error, "Could not complete the generation compatibility probe"));
    }
  }

  async #cachedModelHealth(envFile: string, env: Record<string, string>): Promise<NodeComputeStatus | null> {
    try {
      const parsed = JSON.parse(await readPrivateText(this.#modelHealthPath(envFile))) as Record<string, unknown>;
      if (parsed.format !== 1 || parsed.node_id !== nodeId(env)) return null;
      if (JSON.stringify(parsed.fingerprint) !== JSON.stringify(modelHealthFingerprint(env))) return null;
      return cachedComputeStatus(parsed.compute);
    } catch {
      return null;
    }
  }

  async #invalidateModelHealth(envFile: string): Promise<void> {
    try {
      await fs.unlink(this.#modelHealthPath(envFile));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  #modelHealthPath(envFile: string): string {
    return path.join(path.dirname(path.resolve(envFile)), "model-health.json");
  }

  async #compose(
    envFile: string,
    command: readonly string[],
    allowFailure: boolean,
    timeoutMs: number,
    parsedEnv?: Record<string, string>,
    target?: Exclude<NodeTarget, "auto">,
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

  async #probeComputeSource(
    role: "embedding" | "generation",
    baseUrl: string,
    model: string,
    apiKey: string,
  ): Promise<ComputeSourceStatus> {
    const checkedAt = new Date().toISOString();
    const source = role === "generation" && /\/internal\/codex(?:\/|$)/i.test(baseUrl)
      ? "codex_session" as const
      : "openai_compatible" as const;
    const endpoint = safeDisplayEndpoint(baseUrl);
    if (endpoint === "invalid") {
      return {
        source,
        endpoint,
        model,
        status: "unknown",
        available_models: [],
        detail: "model provider URL is invalid",
        checked_at: checkedAt,
      };
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const availableModels: string[] = [];
    let health: Record<string, unknown> | null = null;
    let catalogError = "";
    try {
      const modelsUrl = providerUrl(baseUrl, "models");
      const response = await this.#fetch(modelsUrl, { headers, signal: AbortSignal.timeout(4_000) });
      if (response.ok) {
        const payload = await response.json().catch(() => null) as { data?: Array<{ id?: unknown }> } | null;
        for (const item of payload?.data || []) {
          if (typeof item?.id === "string" && item.id.length <= 256) availableModels.push(item.id);
        }
      } else {
        catalogError = `model catalog returned HTTP ${response.status}`;
      }
    } catch (error) {
      catalogError = error instanceof Error ? error.message : "model catalog probe failed";
    }
    if (role === "generation" && availableModels.length === 0) {
      try {
        const healthUrl = new URL(displayEndpoint(baseUrl));
        healthUrl.pathname = "/health";
        healthUrl.search = "";
        healthUrl.hash = "";
        const response = await this.#fetch(healthUrl, { headers, signal: AbortSignal.timeout(4_000) });
        if (response.ok) health = await response.json().catch(() => null) as Record<string, unknown> | null;
      } catch { /* Model bridges are allowed to omit a health route. */ }
    }
    const normalizedModel = model.replace(/:latest$/, "");
    const advertised = availableModels.some(item => item === model || item.replace(/:latest$/, "") === normalizedModel);
    const healthModel = typeof health?.default_model === "string" ? health.default_model : null;
    const ready = advertised || healthModel === model || (Boolean(health) && role === "generation");
    return {
      source: typeof health?.provider === "string" && /codex/i.test(health.provider) ? "codex_session" : source,
      endpoint,
      model,
      status: ready ? "ready" : availableModels.length ? "unavailable" : "unknown",
      available_models: [...new Set(availableModels)].sort(),
      ...(typeof health?.provider === "string" ? { provider: health.provider } : {}),
      ...(!ready ? { detail: catalogError || "configured model was not advertised by the provider" } : {}),
      checked_at: checkedAt,
    };
  }

  async #authorizeCodexBridge(selector: string, authorization: string | undefined, explicitEnv?: string): Promise<Record<string, string>> {
    const env = await readPrivateEnv(this.envPath(explicitEnv));
    if (selector !== nodeId(env)) throw new Error("Unknown Node");
    const provided = String(authorization || "").match(/^Bearer\s+(.+)$/i)?.[1] || "";
    const expected = env.NODE_CODEX_BRIDGE_TOKEN || env.GENERATION_API_KEY || "";
    const left = Buffer.from(provided);
    const right = Buffer.from(expected);
    if (!provided || !expected || left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
      throw new Error("Invalid Node bridge authorization");
    }
    return env;
  }
}


export function resolveNodeDeploymentDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NEUROMEM_NODE_DEPLOY_DIR) return path.resolve(env.NEUROMEM_NODE_DEPLOY_DIR);
  const packaged = fileURLToPath(new URL("../../assets/node", import.meta.url));
  const repository = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)), "deploy", "node");
  return existsSync(path.join(packaged, "compose.yaml")) ? packaged : repository;
}

function nodePublicUrl(env: Record<string, string>): string {
  const host = env.NEUROMEM_PUBLIC_HOST!;
  if (["localhost", "127.0.0.1", "::1"].includes(host.toLowerCase())) {
    const port = Number(env.EDGE_LOOPBACK_PORT || 24443);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("EDGE_LOOPBACK_PORT is invalid");
    return `http://${host === "::1" ? "[::1]" : host}:${port}`;
  }
  return `https://${host}`;
}

function displayEndpoint(value: string): string {
  const target = new URL(value);
  if (target.hostname.toLowerCase() === "host.docker.internal") target.hostname = "127.0.0.1";
  target.username = "";
  target.password = "";
  target.search = "";
  target.hash = "";
  return target.toString().replace(/\/+$/, "");
}

function providerUrl(baseUrl: string, resource: "models" | "embeddings" | "chat/completions"): URL {
  const target = new URL(displayEndpoint(baseUrl));
  if (!["http:", "https:"].includes(target.protocol)) throw new Error("model provider URL must use HTTP(S)");
  const basePath = target.pathname.replace(/\/+$/, "");
  target.pathname = basePath.endsWith(`/${resource}`) ? basePath : `${basePath}/${resource}`;
  return target;
}

function configuredEmbeddingDimensions(env: Record<string, string>): number {
  const raw = env.EMBEDDING_VECTOR_DIMENSIONS || "1536";
  const dimensions = Number(raw);
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 65_536) {
    throw new ModelContractError("EMBEDDING_VECTOR_DIMENSIONS must be an integer between 1 and 65536");
  }
  return dimensions;
}

function modelHealthFingerprint(env: Record<string, string>): ModelHealthFingerprint {
  let dimensions: number | null = null;
  try { dimensions = configuredEmbeddingDimensions(env); } catch { /* Invalid dimensions remain part of the failed verification state. */ }
  const sensitive = modelHealthSensitiveValues(env);
  return {
    embedding: {
      model: safeModelHealthName(env.EMBEDDING_MODEL || "", sensitive),
      source: "openai_compatible",
      endpoint_fingerprint: providerEndpointFingerprint(env.EMBEDDING_BASE_URL || ""),
      dimensions,
      api_key_configured: Boolean(env.EMBEDDING_API_KEY),
    },
    generation: {
      model: safeModelHealthName(env.GENERATION_MODEL || "", sensitive),
      source: generationSource(env),
      endpoint_fingerprint: providerEndpointFingerprint(env.GENERATION_BASE_URL || ""),
      api_key_configured: Boolean(env.GENERATION_API_KEY),
    },
  };
}

function safeDisplayEndpoint(value: string): string {
  try { return displayEndpoint(value); } catch { return "invalid"; }
}

function providerEndpointFingerprint(value: string): string {
  const endpoint = safeDisplayEndpoint(value);
  return endpoint === "invalid"
    ? "invalid"
    : crypto.createHash("sha256").update(endpoint).digest("hex");
}

function modelHealthSensitiveValues(env: Record<string, string>): string[] {
  return [...new Set([
    env.EMBEDDING_API_KEY,
    env.GENERATION_API_KEY,
    env.GENERATION_DIRECT_API_KEY,
    env.NODE_CODEX_BRIDGE_TOKEN,
  ].filter((value): value is string => Boolean(value && value.length >= 4)))];
}

function safeModelHealthName(value: string, sensitive: string[]): string {
  const model = value.trim();
  if (!validModel(model) || /^https?:\/\//i.test(model) || sensitive.some(secret => model.includes(secret))) {
    return "unavailable";
  }
  return model;
}

function safeModelHealthEndpoint(value: string): string {
  const endpoint = safeDisplayEndpoint(value);
  if (endpoint === "invalid") return endpoint;
  try {
    return new URL(endpoint).origin;
  } catch {
    return "invalid";
  }
}

function modelHealthCompute(compute: NodeComputeStatus, env: Record<string, string>): NodeComputeStatus {
  const sensitive = modelHealthSensitiveValues(env);
  const sanitize = (source: ComputeSourceStatus): ComputeSourceStatus => ({
    source: source.source,
    endpoint: safeModelHealthEndpoint(source.endpoint),
    model: safeModelHealthName(source.model, sensitive),
    status: source.status,
    available_models: [],
    ...(source.detail ? { detail: safeModelHealthDetail(source.detail, sensitive) } : {}),
    checked_at: source.checked_at,
  });
  return { embedding: sanitize(compute.embedding), generation: sanitize(compute.generation) };
}

function safeModelHealthDetail(value: string, sensitive: string[]): string {
  let result = value.replace(/https?:\/\/\S+/gi, "[provider]");
  for (const secret of sensitive) result = result.replaceAll(secret, "[redacted]");
  return result.replace(/[\r\n\0]+/g, " ").slice(0, 500);
}

function modelRequestHeaders(apiKey: string): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}

class ModelContractError extends Error {}

function modelContractDetail(error: unknown, fallback: string): string {
  return (error instanceof ModelContractError ? error.message : fallback).slice(0, 500);
}

function verifiedModelStatus(
  discovered: ComputeSourceStatus,
  source: ComputeSourceStatus["source"],
  status: "ready" | "unavailable",
  detail?: string,
): ComputeSourceStatus {
  const result: ComputeSourceStatus = {
    ...discovered,
    source,
    status,
    checked_at: new Date().toISOString(),
  };
  if (detail) result.detail = detail;
  else delete result.detail;
  return result;
}

function parseJsonObject(value: string, message: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new ModelContractError(message); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ModelContractError(message);
  return parsed as Record<string, unknown>;
}

function cachedComputeStatus(value: unknown): NodeComputeStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const embedding = cachedSourceStatus(record.embedding);
  const generation = cachedSourceStatus(record.generation);
  return embedding && generation ? { embedding, generation } : null;
}

function cachedSourceStatus(value: unknown): ComputeSourceStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (!["openai_compatible", "codex_session", "unknown"].includes(String(source.source))) return null;
  if (!["ready", "unavailable", "unknown"].includes(String(source.status))) return null;
  if (typeof source.endpoint !== "string" || source.endpoint.length > 2_048) return null;
  if (typeof source.model !== "string" || source.model.length > 256) return null;
  if (typeof source.checked_at !== "string" || source.checked_at.length > 128) return null;
  if (!Array.isArray(source.available_models) || source.available_models.length > 512 || source.available_models.some(item => typeof item !== "string" || item.length > 256)) return null;
  if (source.provider !== undefined && (typeof source.provider !== "string" || source.provider.length > 256)) return null;
  if (source.detail !== undefined && (typeof source.detail !== "string" || source.detail.length > 500)) return null;
  return {
    source: source.source as ComputeSourceStatus["source"],
    endpoint: source.endpoint,
    model: source.model,
    status: source.status as ComputeSourceStatus["status"],
    available_models: [...source.available_models] as string[],
    ...(typeof source.provider === "string" ? { provider: source.provider } : {}),
    ...(typeof source.detail === "string" ? { detail: source.detail } : {}),
    checked_at: source.checked_at,
  };
}

function nodeId(env: Record<string, string>): string {
  return env.NEUROMEM_NODE_ID || "local";
}

function generationSource(env: Record<string, string>, status?: ComputeSourceStatus): "codex_session" | "openai_compatible" {
  if (env.GENERATION_SOURCE === "codex_session" || env.GENERATION_SOURCE === "openai_compatible") return env.GENERATION_SOURCE;
  if (status?.source === "codex_session" || /\/internal\/codex(?:\/|$)/i.test(env.GENERATION_BASE_URL || "")) return "codex_session";
  return "openai_compatible";
}

function codexBridgeBaseUrl(managerPort: number, id: string): string {
  return `http://host.docker.internal:${managerPort}/v1/internal/codex/nodes/${id}`;
}

function containerEndpoint(value: string): string {
  const target = new URL(value);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.search || target.hash) {
    throw new Error("API base URL must be HTTP(S) without credentials, query, or fragment");
  }
  if (["127.0.0.1", "localhost", "::1"].includes(target.hostname.toLowerCase())) target.hostname = "host.docker.internal";
  return target.toString().replace(/\/+$/, "");
}

function validateGenerationProbe(value: unknown): GenerationProbeInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Generation probe must be a JSON object");
  const input = value as Record<string, unknown>;
  if (input.source !== "codex_session" && input.source !== "openai_compatible") throw new Error("Invalid generation source");
  if (input.model !== undefined && (typeof input.model !== "string" || !validModel(input.model))) throw new Error("Invalid generation model");
  if (input.source === "codex_session" && input.connection !== undefined) throw new Error("Codex session probes cannot include API connection fields");
  return input as unknown as GenerationProbeInput;
}

function validateModelSelection(value: unknown): ModelSelectionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Model selection must be a JSON object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["embedding_model", "generation_model", "generation"].includes(key))) throw new Error("Unsupported model selection field");
  if (input.embedding_model !== undefined && (typeof input.embedding_model !== "string" || !validModel(input.embedding_model))) throw new Error("Invalid embedding model");
  if (input.generation_model !== undefined) throw new Error("Use the generation source selector when changing generation models");
  if (input.generation !== undefined) {
    const generation = validateGenerationProbe(input.generation);
    if (!generation.model) throw new Error("Generation model is required");
  }
  if (input.embedding_model === undefined && input.generation === undefined) throw new Error("At least one model selection is required");
  return input as unknown as ModelSelectionInput;
}

function resolveDirectConnection(
  env: Record<string, string>,
  value: GenerationProbeInput["connection"],
): { base_url: string; api_key: string } {
  const savedBase = env.GENERATION_DIRECT_BASE_URL || (generationSource(env) === "openai_compatible" ? env.GENERATION_BASE_URL : "");
  const savedKey = env.GENERATION_DIRECT_API_KEY || (generationSource(env) === "openai_compatible" ? env.GENERATION_API_KEY : "");
  if (!value) {
    if (!savedBase) throw new Error("API connection settings are required");
    return { base_url: displayEndpoint(savedBase), api_key: savedKey || "" };
  }
  if (typeof value.base_url !== "string") throw new Error("API base URL is required");
  const base = displayEndpoint(value.base_url);
  if (value.api_key_action === "keep") {
    if (!savedBase || displayEndpoint(savedBase) !== base) throw new Error("An existing API key cannot be reused after the endpoint changes");
    return { base_url: base, api_key: savedKey || "" };
  }
  if (value.api_key_action === "clear") return { base_url: base, api_key: "" };
  if (value.api_key_action !== "replace" || typeof value.api_key !== "string" || !value.api_key || /[\r\n\0]/.test(value.api_key)) {
    throw new Error("A valid API key is required when replacing the key");
  }
  return { base_url: base, api_key: value.api_key };
}

function validModel(value: string): boolean {
  return value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(value);
}

function replaceEnvValues(source: string, values: Record<string, string>): string {
  let output = source;
  for (const [key, value] of Object.entries(values)) {
    if (/[^\x20-\x7e]/.test(value) || /[\r\n\0]/.test(value)) throw new Error(`Invalid ${key}`);
    const expression = new RegExp(`^${key}=.*$`, "m");
    output = expression.test(output)
      ? output.replace(expression, `${key}=${value}`)
      : `${output}${output.endsWith("\n") ? "" : "\n"}${key}=${value}\n`;
  }
  return output;
}

async function writePrivateEnv(target: string, content: string): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, target);
}

function operationResult(node: string, kind: string, phase: string, result?: unknown): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    operation_id: crypto.randomUUID(),
    node_id: node,
    kind,
    state: "succeeded",
    phase,
    started_at: now,
    updated_at: now,
    completed_at: now,
    result,
  };
}

function computeProviderStatus(source: ComputeSourceStatus): {
  configured: boolean;
  model: string;
  provider_status: "ready" | "error" | "unknown";
  provider_detail: string | null;
  last_probe_at: string;
} {
  return {
    configured: true,
    model: source.model,
    provider_status: source.status === "ready" ? "ready" : source.status === "unavailable" ? "error" : "unknown",
    provider_detail: source.detail || source.provider || null,
    last_probe_at: source.checked_at,
  };
}

function validateCodexCompletion(input: unknown, configuredModel: string): {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  output_schema: Record<string, unknown>;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Codex generation request");
  const body = input as Record<string, unknown>;
  if (body.model !== configuredModel || typeof body.model !== "string") throw new Error("Requested model does not match the configured Codex model");
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 64) throw new Error("Invalid Codex chat messages");
  const messages = body.messages.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid Codex chat message");
    const message = item as Record<string, unknown>;
    if (!["system", "user", "assistant"].includes(String(message.role)) || typeof message.content !== "string" || message.content.length > 100_000) {
      throw new Error("Invalid Codex chat message");
    }
    return { role: message.role as "system" | "user" | "assistant", content: message.content };
  });
  const responseFormat = body.response_format && typeof body.response_format === "object" && !Array.isArray(body.response_format)
    ? body.response_format as Record<string, unknown>
    : null;
  const jsonSchema = responseFormat?.json_schema && typeof responseFormat.json_schema === "object" && !Array.isArray(responseFormat.json_schema)
    ? responseFormat.json_schema as Record<string, unknown>
    : null;
  const outputSchema = jsonSchema?.schema && typeof jsonSchema.schema === "object" && !Array.isArray(jsonSchema.schema)
    ? jsonSchema.schema as Record<string, unknown>
    : { type: "object", additionalProperties: true };
  return { model: body.model, messages, output_schema: outputSchema };
}

export async function readPrivateEnv(target: string): Promise<Record<string, string>> {
  const raw = await readPrivateText(target);
  const env: Record<string, string> = {};
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) throw new Error(`invalid Node env entry on line ${index + 1}`);
    const key = trimmed.slice(0, separator);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`invalid Node env key '${key}'`);
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
