import fs from "node:fs/promises";
import fsSync from "node:fs";
import crypto from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdminAuth } from "./auth.js";
import { exists } from "./fs-safe.js";
import { FolderSourceError, FolderSourceManager, type ProjectFolderContext } from "./folder-sources.js";
import { InternalAuthorizationError, verifyControlInternalAuthorization } from "./internal-auth.js";
import { managerOpenApi } from "./openapi.js";
import type { ManagerPaths } from "./paths.js";
import { ProcessRunner } from "./process-runner.js";
import type { NodeManager } from "./node-manager.js";
import { readPrivateEnv, type NodeDeploymentManager } from "./node-deployment-manager.js";

type Transport = "tcp" | "unix";

export interface AdminServerOptions {
  manager: NodeManager;
  deployment?: NodeDeploymentManager;
  paths: ManagerPaths;
  port?: number;
  webDist?: string;
  folderSources?: FolderSourceManager;
}

export class AdminServer {
  readonly port: number;
  readonly auth: AdminAuth;
  readonly webDist: string;
  readonly folderSources: FolderSourceManager;
  #tcp: http.Server | null = null;
  #unix: http.Server | null = null;
  #reconcileTimer: NodeJS.Timeout | null = null;
  #reconciling = false;
  #instanceLockOwned = false;
  #socketOwned = false;

  constructor(private readonly options: AdminServerOptions) {
    this.port = options.port ?? Number(process.env.NEUROMEM_MANAGER_PORT || 14174);
    this.auth = new AdminAuth(options.paths);
    const packaged = fileURLToPath(new URL("../../assets/admin-dist", import.meta.url));
    const fallback = fileURLToPath(new URL("../../assets/admin", import.meta.url));
    this.webDist = path.resolve(options.webDist || process.env.NEUROMEM_WEB_DIST || (fsSync.existsSync(path.join(packaged, "index.html")) ? packaged : fallback));
    this.folderSources = options.folderSources || new FolderSourceManager({ paths: options.paths, runner: new ProcessRunner() });
  }

  async start(): Promise<void> {
    await this.options.manager.initialize(true);
    await this.auth.initialize();
    await this.acquireInstanceLock();
    try {
      await fs.rm(this.options.paths.socket, { force: true });
      this.#tcp = http.createServer((request, response) => void this.handle(request, response, "tcp"));
      this.#unix = http.createServer((request, response) => void this.handle(request, response, "unix"));
      await listen(this.#tcp, { host: "127.0.0.1", port: this.port });
      await listen(this.#unix, { path: this.options.paths.socket });
      this.#socketOwned = true;
      await fs.chmod(this.options.paths.socket, 0o600);
      void this.triggerReconcile();
      this.#reconcileTimer = setInterval(() => void this.triggerReconcile(), 30_000);
      this.#reconcileTimer.unref();
    } catch (error) {
      await Promise.all([close(this.#tcp).catch(() => undefined), close(this.#unix).catch(() => undefined)]);
      if (this.#socketOwned) await fs.rm(this.options.paths.socket, { force: true });
      await this.releaseInstanceLock();
      this.#tcp = null;
      this.#unix = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#reconcileTimer) clearInterval(this.#reconcileTimer);
    this.#reconcileTimer = null;
    await Promise.all([close(this.#tcp), close(this.#unix)]);
    await Promise.all([this.options.manager.close(), this.options.deployment?.close()]);
    this.#tcp = null;
    this.#unix = null;
    if (this.#socketOwned) await fs.rm(this.options.paths.socket, { force: true });
    this.#socketOwned = false;
    await this.releaseInstanceLock();
  }

  private async handle(request: IncomingMessage, response: ServerResponse, transport: Transport): Promise<void> {
    try {
      const url = new URL(request.url || "/", `http://127.0.0.1:${this.port}`);
      this.setSecurityHeaders(response);
      if (request.method === "OPTIONS") {
        if (!this.allowOrigin(request, response)) return sendError(response, 403, "Origin is not allowed");
        response.statusCode = 204;
        response.end();
        return;
      }
      if (url.pathname === "/health" && request.method === "GET") return sendJson(response, 200, { ok: true, service: "neuromem-manager", version: "0.1.0" });
      if (url.pathname === "/favicon.ico" && request.method === "GET") {
        response.statusCode = 204;
        response.end();
        return;
      }
      if (url.pathname === "/v1/openapi.json" && request.method === "GET") return sendJson(response, 200, managerOpenApi);
      const codexBridge = match(url.pathname, /^\/v1\/internal\/codex\/nodes\/([^/]+)\/(models|chat\/completions)$/);
      if (codexBridge && ((codexBridge[2] === "models" && request.method === "GET") || (codexBridge[2] === "chat/completions" && request.method === "POST"))) {
        try {
          const deploymentId = await this.deploymentNodeId();
          const useDeployment = Boolean(this.options.deployment && deploymentId === codexBridge[1]);
          if (this.options.deployment && !useDeployment) throw new Error("Unknown Node");
          const value = codexBridge[2] === "models"
            ? useDeployment
              ? await this.options.deployment!.codexBridgeModels(codexBridge[1]!, request.headers.authorization)
              : await this.options.manager.codexBridgeModels(codexBridge[1]!, request.headers.authorization)
            : useDeployment
              ? await this.options.deployment!.codexChatCompletion(codexBridge[1]!, request.headers.authorization, await readBody(request))
              : await this.options.manager.codexChatCompletion(codexBridge[1]!, request.headers.authorization, await readBody(request));
          return sendJson(response, 200, value);
        } catch (error) {
          const message = String((error as Error).message || "");
          if (/authorization/i.test(message)) return sendOpenAiError(response, 401, "Invalid Node bridge authorization", "invalid_request_error");
          if (/unknown node/i.test(message)) return sendOpenAiError(response, 404, "Unknown Node", "invalid_request_error");
          if (/invalid|unsupported|does not match/i.test(message)) return sendOpenAiError(response, 400, "Invalid Codex generation request", "invalid_request_error");
          return sendOpenAiError(response, 503, "Codex generation is temporarily unavailable", "provider_unavailable");
        }
      }
      const folderSourceRoute = match(url.pathname, /^\/v1\/internal\/nodes\/([^/]+)\/(folder-sources:pick|folder-sources:detach)$/);
      if (folderSourceRoute && request.method === "POST") {
        if (transport !== "tcp") return sendError(response, 404, "Not found");
        return this.handleInternalFolderSource(request, response, folderSourceRoute[1]!, folderSourceRoute[2]!);
      }
      if (url.pathname === "/v1/admin/session" && request.method === "POST" && transport === "tcp") {
        if (!request.headers.origin) return sendError(response, 403, "A same-origin browser request is required");
        if (!this.allowOrigin(request, response)) return sendError(response, 403, "Origin is not allowed");
        const body = await readBody<{ token?: string }>(request);
        if (!body.token) return sendError(response, 400, "Bootstrap token is required");
        const session = await this.auth.exchangeBootstrap(body.token);
        response.setHeader("set-cookie", `neuromem_admin=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
        return sendJson(response, 200, { ok: true });
      }
      if (url.pathname === "/admin" && request.method === "GET") {
        response.statusCode = 308;
        response.setHeader("location", `/admin/${url.search}`);
        response.setHeader("cache-control", "no-store");
        response.end();
        return;
      }
      if (url.pathname.startsWith("/admin/") && request.method === "GET") {
        return this.serveAdmin(url.pathname, response);
      }
      if (transport === "tcp") {
        if (!this.allowOrigin(request, response)) return sendError(response, 403, "Origin is not allowed");
        if (!["GET", "HEAD"].includes(request.method || "") && !request.headers.origin) {
          return sendError(response, 403, "A same-origin browser request is required");
        }
        if (!(await this.auth.validateSession(cookie(request, "neuromem_admin")))) return sendError(response, 401, "Admin session is required");
      }
      if (url.pathname === "/v1/admin/bootstrap" && request.method === "POST") {
        if (transport !== "unix") return sendError(response, 404, "Not found");
        const body = await readBody<{ node_id?: string }>(request);
        const deploymentId = await this.deploymentNodeId();
        const node = deploymentId ? null : body.node_id ? await this.options.manager.store.findNode(body.node_id) : await this.options.manager.store.defaultNode();
        const token = await this.auth.issueBootstrap(deploymentId || node?.node_id);
        const dashboard = `http://127.0.0.1:${this.port}/admin/#neuromem-admin=${encodeURIComponent(token)}`;
        return sendJson(response, 200, { ok: true, token, url: dashboard, expires_in_seconds: 60 });
      }
      if (url.pathname === "/v1/cli/nodes" && request.method === "POST") {
        if (transport !== "unix") return sendError(response, 404, "Not found");
        if (this.options.deployment) return sendError(response, 404, "The physical Node is configured with `neuromem node config init`");
        return sendJson(response, 200, await this.options.manager.createNode(await readBody(request)));
      }
      const cliDelete = match(url.pathname, /^\/v1\/cli\/nodes\/([^/]+)$/);
      if (cliDelete && request.method === "DELETE") {
        if (transport !== "unix") return sendError(response, 404, "Not found");
        if (this.options.deployment) return sendError(response, 404, "The physical Node cannot be deleted through the legacy Node API");
        const body = await readBody<{ confirmation: string; purge_data?: boolean }>(request);
        return sendJson(response, 200, await this.options.manager.deleteNode(cliDelete[1]!, body.confirmation, Boolean(body.purge_data)));
      }
      const cliApply = match(url.pathname, /^\/v1\/cli\/nodes\/([^/]+)\/(restore\/apply|migrate\/apply|migrate\/verify)$/);
      if (cliApply && request.method === "POST") {
        if (transport !== "unix") return sendError(response, 404, "Not found");
        if (this.options.deployment) return sendError(response, 404, "This operation is not available for the physical Node");
        const body = await readBody<{ backup_id?: string; target_revision?: string; confirmation?: string; apply_mode?: string }>(request);
        if (cliApply[2] === "restore/apply") {
          if (!body.backup_id || !body.confirmation) return sendError(response, 400, "backup_id and confirmation are required");
          return sendJson(response, 200, await this.options.manager.restoreApply(cliApply[1]!, body.backup_id, body.confirmation));
        }
        if (cliApply[2] === "migrate/apply") {
          if (!body.confirmation) return sendError(response, 400, "confirmation is required");
          return sendJson(response, 200, await this.options.manager.migrationApply(cliApply[1]!, body.target_revision || "head", body.confirmation, body.apply_mode));
        }
        return sendJson(response, 200, await this.options.manager.migrationVerify(cliApply[1]!, body.target_revision || "head"));
      }
      const modelConfigure = match(url.pathname, /^\/v1\/cli\/nodes\/([^/]+)\/models\/configure$/);
      if (modelConfigure && request.method === "POST") {
        if (transport !== "unix") return sendError(response, 404, "Not found");
        if (this.options.deployment) return sendError(response, 404, "Use the physical Node model selection API");
        return sendJson(response, 200, await this.options.manager.configureModels(modelConfigure[1]!, await readBody(request)));
      }
      if (url.pathname === "/v1/nodes" && request.method === "GET") {
        if (this.options.deployment) {
          if (!(await this.deploymentNodeId())) return sendJson(response, 200, { nodes: [], default_node_id: null });
          const status = await this.options.deployment!.adminStatus();
          return sendJson(response, 200, { nodes: [status.node], default_node_id: status.node.node_id });
        }
        const registry = await this.options.manager.store.registry();
        return sendJson(response, 200, { nodes: registry.nodes, default_node_id: registry.default_node_id });
      }
      const modelSelection = match(url.pathname, /^\/v1\/nodes\/([^/]+)\/models$/);
      if (modelSelection && request.method === "GET") {
        if (await this.isDeploymentNode(modelSelection[1]!)) return sendJson(response, 200, await this.options.deployment!.modelSelection());
        if (this.options.deployment) return sendError(response, 404, "Node not found");
        return sendJson(response, 200, await this.options.manager.modelSelection(modelSelection[1]!));
      }
      if (modelSelection && request.method === "POST") {
        if (await this.isDeploymentNode(modelSelection[1]!)) return sendJson(response, 200, await this.options.deployment!.selectModels(await readBody(request)));
        if (this.options.deployment) return sendError(response, 404, "Node not found");
        return sendJson(response, 200, await this.options.manager.selectModels(modelSelection[1]!, await readBody(request)));
      }
      const generationProbe = match(url.pathname, /^\/v1\/nodes\/([^/]+)\/generation\/probe$/);
      if (generationProbe && request.method === "POST") {
        if (await this.isDeploymentNode(generationProbe[1]!)) return sendJson(response, 200, await this.options.deployment!.generationProbe(await readBody(request)));
        if (this.options.deployment) return sendError(response, 404, "Node not found");
        return sendJson(response, 200, await this.options.manager.generationProbe(generationProbe[1]!, await readBody(request)));
      }
      const route = match(url.pathname, /^\/v1\/nodes\/([^/]+)\/(health|backlog|logs|start|stop|restart|backups)$/);
      if (route) {
        const [, selector, action] = route;
        if (await this.isDeploymentNode(selector!)) {
          if (action === "health" && request.method === "GET") return sendJson(response, 200, await this.options.deployment!.adminStatus());
          if (action === "backlog" && request.method === "GET") return sendJson(response, 200, { node_id: selector, available: false, pending: 0, running: 0, failed: 0 });
          if (action === "logs" && request.method === "GET") {
            const tail = Number(url.searchParams.get("tail") || "200");
            const requestedService = url.searchParams.get("service") || "control";
            const service = requestedService === "api" ? "control" : requestedService;
            return sendJson(response, 200, { logs: await this.options.deployment!.logs(undefined, service, tail) });
          }
          if (["start", "stop", "restart"].includes(action!) && request.method === "POST") {
            return sendJson(response, 200, await this.options.deployment!.adminOperation(action as "start" | "stop" | "restart"));
          }
          if (action === "backups" && request.method === "GET") return sendJson(response, 200, { backups: [] });
          if (action === "backups" && request.method === "POST") {
            const result = await this.options.deployment!.backupRehearsal();
            return sendJson(response, 200, deploymentOperation(selector!, "backup", "verified", result));
          }
        }
        if (this.options.deployment) return sendError(response, 404, "Node not found");
        if (action === "health" && request.method === "GET") return sendJson(response, 200, await this.options.manager.status(selector!));
        if (action === "backlog" && request.method === "GET") return sendJson(response, 200, await this.options.manager.backlog(selector!));
        if (action === "logs" && request.method === "GET") {
          const tail = Number(url.searchParams.get("tail") || "200");
          return sendJson(response, 200, await this.options.manager.logs(selector!, url.searchParams.get("service") || "api", tail));
        }
        if (action === "start" && request.method === "POST") return sendJson(response, 200, await this.options.manager.start(selector!));
        if (action === "stop" && request.method === "POST") return sendJson(response, 200, await this.options.manager.stop(selector!));
        if (action === "restart" && request.method === "POST") return sendJson(response, 200, await this.options.manager.restart(selector!));
        if (action === "backups" && request.method === "GET") return sendJson(response, 200, await this.options.manager.listBackups(selector!));
        if (action === "backups" && request.method === "POST") {
          const body = await readBody<{ label?: string }>(request);
          return sendJson(response, 200, await this.options.manager.backupCreate(selector!, body.label || "manual"));
        }
      }
      const backupVerify = match(url.pathname, /^\/v1\/nodes\/([^/]+)\/backups\/([^/]+)\/verify$/);
      if (backupVerify && request.method === "POST") {
        if (this.options.deployment) return sendError(response, 404, "This operation is not available for the physical Node");
        return sendJson(response, 200, await this.options.manager.backupVerify(backupVerify[1]!, backupVerify[2]!));
      }
      const plan = match(url.pathname, /^\/v1\/nodes\/([^/]+)\/(restore|migrate)\/plan$/);
      if (plan && request.method === "POST") {
        if (this.options.deployment) return sendError(response, 404, "This operation is not available for the physical Node");
        const body = await readBody<{ backup_id?: string; target_revision?: string; apply_mode?: string }>(request);
        if (plan[2] === "restore") {
          if (!body.backup_id) return sendError(response, 400, "backup_id is required");
          return sendJson(response, 200, await this.options.manager.restorePlan(plan[1]!, body.backup_id));
        }
        if (!body.target_revision) return sendError(response, 400, "target_revision is required");
        return sendJson(response, 200, await this.options.manager.migrationPlan(plan[1]!, body.target_revision, body.apply_mode));
      }
      return sendError(response, 404, "Not found");
    } catch (error) {
      return sendError(response, 400, redactError((error as Error).message));
    }
  }

  private allowOrigin(request: IncomingMessage, response: ServerResponse): boolean {
    const origin = request.headers.origin;
    if (!origin) return true;
    const allowed = origin === `http://127.0.0.1:${this.port}` || origin === `http://localhost:${this.port}`;
    if (allowed) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("access-control-allow-credentials", "true");
      response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
      response.setHeader("access-control-allow-headers", "content-type");
      response.setHeader("vary", "Origin");
    }
    return allowed;
  }

  private async handleInternalFolderSource(
    request: IncomingMessage,
    response: ServerResponse,
    nodeSelector: string,
    action: string,
  ): Promise<void> {
    try {
      if (request.headers.origin) return sendError(response, 403, "Browser origins cannot call internal routes");
      const deployment = this.options.deployment;
      if (!deployment) return sendError(response, 404, "Node not found");
      const target = deployment.envPath();
      if (!(await exists(target))) return sendError(response, 404, "Node not found");
      const env = await readPrivateEnv(target);
      const configuredNodeId = env.NEUROMEM_NODE_ID;
      const signingKey = env.CONTROL_INTERNAL_SIGNING_KEY;
      if (!configuredNodeId || nodeSelector !== configuredNodeId) return sendError(response, 404, "Node not found");
      if (!signingKey || Buffer.byteLength(signingKey, "utf8") < 32) return sendError(response, 503, "Internal authorization is not configured");
      const context = verifyControlInternalAuthorization(request.headers.authorization, signingKey);
      if (!context.capabilities.includes("project.write")) return sendError(response, 403, "Project write capability is required");
      const folderContext: ProjectFolderContext = {
        principal_id: context.principal_id,
        workspace_id: context.workspace_id,
        project_id: context.project_id,
      };
      if (action === "folder-sources:pick") {
        return sendJson(response, 200, await this.folderSources.pick(folderContext));
      }
      const body = await readBody<{ source_id?: string }>(request);
      if (typeof body.source_id !== "string") return sendError(response, 400, "source_id is required");
      await this.folderSources.detach(folderContext, body.source_id);
      return sendJson(response, 200, { ok: true });
    } catch (error) {
      if (error instanceof InternalAuthorizationError) return sendError(response, 401, "Invalid internal authorization");
      if (error instanceof FolderSourceError) return sendError(response, error.status, error.message);
      return sendError(response, 503, "The local folder source service is unavailable");
    }
  }

  private async deploymentNodeId(): Promise<string | null> {
    const deployment = this.options.deployment;
    if (!deployment) return null;
    const target = deployment.envPath();
    if (!(await exists(target))) return null;
    try {
      const env = await readPrivateEnv(target);
      return env.NEUROMEM_NODE_ID || "local";
    } catch {
      return null;
    }
  }

  private async isDeploymentNode(selector: string): Promise<boolean> {
    return Boolean(this.options.deployment && selector === await this.deploymentNodeId());
  }

  private async serveAdmin(requestPath: string, response: ServerResponse): Promise<void> {
    let decoded: string;
    try { decoded = decodeURIComponent(requestPath); } catch { return sendError(response, 400, "Invalid path encoding"); }
    if (decoded.includes("\0") || decoded.includes("\\")) return sendError(response, 400, "Invalid path");
    const realRoot = await fs.realpath(this.webDist).catch(() => this.webDist);
    const relative = decoded.replace(/^\/admin\/?/, "");
    const requested = path.resolve(realRoot, relative || "index.html");
    if (requested !== realRoot && !requested.startsWith(`${realRoot}${path.sep}`)) return sendError(response, 403, "Invalid path");
    const found = await exists(requested) && (await fs.stat(requested)).isFile();
    if (!found && decoded.startsWith("/admin/assets/")) return sendError(response, 404, "Asset not found");
    const target = found ? await fs.realpath(requested) : await fs.realpath(path.join(realRoot, "index.html")).catch(() => path.join(realRoot, "index.html"));
    if (target !== realRoot && !target.startsWith(`${realRoot}${path.sep}`)) return sendError(response, 403, "Invalid path");
    if (!(await exists(target))) return sendError(response, 503, "Admin UI is not installed");
    response.setHeader("content-type", contentType(target));
    response.setHeader("cache-control", decoded.startsWith("/admin/assets/") ? "public, max-age=31536000, immutable" : "no-store");
    response.statusCode = 200;
    response.end(await fs.readFile(target));
  }

  private setSecurityHeaders(response: ServerResponse): void {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'");
  }

  private async triggerReconcile(): Promise<void> {
    if (this.#reconciling) return;
    if (await this.deploymentNodeId()) return;
    this.#reconciling = true;
    try {
      await this.options.manager.reconcileDesiredNodes();
    } finally {
      this.#reconciling = false;
    }
  }

  private async acquireInstanceLock(): Promise<void> {
    const lock = path.join(this.options.paths.run, "manager.instance.lock");
    try {
      await fs.mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await fs.readFile(path.join(lock, "pid"), "utf8").then(Number).catch(() => 0);
      if (owner && processAlive(owner)) throw new Error(`Neuromem Node Manager is already running as PID ${owner}`);
      const age = Date.now() - (await fs.stat(lock)).mtimeMs;
      if (!owner && age < 30_000) throw new Error("Neuromem Node Manager is already starting");
      await fs.rm(lock, { recursive: true, force: true });
      await fs.mkdir(lock, { mode: 0o700 });
    }
    try {
      await fs.writeFile(path.join(lock, "pid"), `${process.pid}\n`, { mode: 0o600, flag: "wx" });
      this.#instanceLockOwned = true;
    } catch (error) {
      await fs.rm(lock, { recursive: true, force: true });
      throw error;
    }
  }

  private async releaseInstanceLock(): Promise<void> {
    if (!this.#instanceLockOwned) return;
    this.#instanceLockOwned = false;
    await fs.rm(path.join(this.options.paths.run, "manager.instance.lock"), { recursive: true, force: true });
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function deploymentOperation(nodeId: string, kind: string, phase: string, result?: unknown): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    operation_id: crypto.randomUUID(),
    node_id: nodeId,
    kind,
    state: "succeeded",
    phase,
    started_at: now,
    updated_at: now,
    completed_at: now,
    result,
  };
}

async function readBody<T = Record<string, unknown>>(request: IncomingMessage): Promise<T> {
  let value = "";
  for await (const chunk of request) {
    value += chunk.toString();
    if (value.length > 1024 * 1024) throw new Error("Request body exceeds 1 MiB");
  }
  return (value ? JSON.parse(value) : {}) as T;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}

function sendError(response: ServerResponse, status: number, error: string): void {
  sendJson(response, status, { ok: false, error });
}

function sendOpenAiError(response: ServerResponse, status: number, message: string, type: string): void {
  sendJson(response, status, { error: { message, type, code: type } });
}

function cookie(request: IncomingMessage, name: string): string {
  for (const part of String(request.headers.cookie || "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return "";
}

function match(value: string, expression: RegExp): RegExpMatchArray | null {
  const result = value.match(expression);
  if (!result) return null;
  for (let index = 1; index < result.length; index += 1) result[index] = decodeURIComponent(result[index]!);
  return result;
}

function contentType(target: string): string {
  if (target.endsWith(".html")) return "text/html; charset=utf-8";
  if (target.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (target.endsWith(".css")) return "text/css; charset=utf-8";
  if (target.endsWith(".svg")) return "image/svg+xml";
  if (target.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function redactError(value: string): string {
  return String(value)
    .replace(/(POSTGRES_PASSWORD|API_TOKEN|MCP_TOKEN|EMBEDDING_API_KEY|GENERATION_API_KEY|GENERATION_DIRECT_API_KEY|CORE_TOKEN|authorization)(\s*[=:]\s*)[^\s,}]+/gi, "$1$2[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/(postgres(?:ql)?(?:\+[a-z0-9]+)?:\/\/[^:\s/]+:)[^@\s]+(@)/gi, "$1[redacted]$2")
    .replace(/neuromem-admin=[^&#\s]+/gi, "neuromem-admin=[redacted]");
}

function listen(server: http.Server, options: { host: string; port: number } | { path: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: http.Server | null): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
