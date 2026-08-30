#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ManagerClient } from "./client.js";
import { uuid7 } from "./fs-safe.js";
import { packagedSkillPath, renderMcpConfig } from "./mcp-config.js";
import { NodeManager } from "./node-manager.js";
import { resolveManagerPaths } from "./paths.js";
import { ProcessRunner } from "./process-runner.js";
import { installSupervisor } from "./supervisor.js";
import { persistManagerRuntimeConfig } from "./runtime-config.js";
import type { NodeRecord, OperationRecord, RegistryFile } from "./types.js";

const VERSION = "0.1.0";
const args = process.argv.slice(2);
const paths = resolveManagerPaths();
const runner = new ProcessRunner();
const client = new ManagerClient(paths);
const daemonPath = fileURLToPath(new URL("./daemon.js", import.meta.url));

function take(name: string, fallback?: string): string | undefined {
  const inline = args.find(value => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1] && !args[index + 1]!.startsWith("--")) return args[index + 1];
  return fallback;
}

function flag(name: string): boolean {
  return args.includes(name);
}

function print(value: unknown): void {
  if (value && typeof value === "object" && "state" in value && ["failed", "needs_attention"].includes(String((value as { state?: unknown }).state))) {
    process.exitCode = 1;
  }
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function help(): void {
  print(`Neuromem ${VERSION}

Usage:
  neuromem                         Prepare, start, verify, and open the default Node
  neuromem admin open [--node ID]  Open the recovery-safe local Admin UI
  neuromem skill path              Print the packaged Agent memory skill path
  neuromem node list
  neuromem node create --alias personal --node-id UUID --confirm UUID
  neuromem node status|start|stop|restart [--node ID]
  neuromem node logs [--node ID] [--service api] [--tail 200]
  neuromem node mcp-config [--node ID] [--format json|toml]
  neuromem node models configure [--node ID] --embedding-base-url URL --embedding-model MODEL --generation-base-url URL --generation-model MODEL
  neuromem node backup create|list|verify [--node ID] [--backup ID]
  neuromem node restore plan|apply [--node ID] --backup ID [--confirm UUID]
  neuromem node migrate plan|apply|verify [--node ID] [--target head] [--confirm UUID]
  neuromem node delete [--node ID] --confirm UUID [--purge-data]

Options:
  --help
  --version`);
}

async function ensureManager(): Promise<void> {
  if (await client.health().then(result => result.ok).catch(() => false)) return;
  await installSupervisor(daemonPath, paths, runner);
  if (await waitForManager(5_000)) return;
  if (!(await client.health().then(result => result.ok).catch(() => false))) {
    const child = spawn(process.execPath, [daemonPath], { detached: true, stdio: "ignore", env: { ...process.env, NEUROMEM_HOME: paths.home } });
    child.unref();
  }
  if (await waitForManager(10_000)) return;
  throw new Error("The local Node Manager did not start; run `neuromem manager repair`");
}

async function waitForManager(milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await client.health().then(result => result.ok).catch(() => false)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

async function selector(): Promise<string> {
  const explicit = take("--node");
  if (explicit) return explicit;
  const registry = await client.request<{ nodes: NodeRecord[]; default_node_id?: string | null }>("GET", "/v1/nodes");
  const first = registry.nodes.find(node => node.node_id === registry.default_node_id) || registry.nodes[0];
  if (!first) throw new Error("No Node exists; run `neuromem` once to create the default Node");
  return first.node_id;
}

async function defaultLaunch(): Promise<void> {
  await ensureManager();
  let registry = await client.request<{ nodes: NodeRecord[]; default_node_id?: string | null }>("GET", "/v1/nodes");
  let nodes = registry.nodes;
  if (!nodes.length) {
    const nodeId = uuid7();
    const created = await client.request<OperationRecord>("POST", "/v1/cli/nodes", {
      node_id: nodeId,
      confirmation: nodeId,
      alias: process.env.NEUROMEM_DEFAULT_NODE || "personal",
      make_default: true,
    });
    if (created.state !== "succeeded") throw new Error(created.error || "Default Node creation failed");
    registry = await client.request<{ nodes: NodeRecord[]; default_node_id?: string | null }>("GET", "/v1/nodes");
    nodes = registry.nodes;
  }
  const node = nodes.find(candidate => candidate.node_id === registry.default_node_id) || nodes[0]!;
  const started = await client.request<OperationRecord>("POST", `/v1/nodes/${encodeURIComponent(node.node_id)}/start`, {});
  if (started.state !== "succeeded") throw new Error(started.error || "Node start failed");
  const url = `http://127.0.0.1:${node.ports.dashboard}/app`;
  print({ ok: true, node: node.alias, dashboard: url, mcp: `http://127.0.0.1:${node.ports.mcp}/mcp` });
  if (!flag("--no-open")) await openUrl(url);
}

async function main(): Promise<void> {
  if (flag("--help") || args[0] === "help") return help();
  if (flag("--version") || args[0] === "version") return print(VERSION);
  if (args[0] === "skill" && args[1] === "path") return print(packagedSkillPath());
  await persistManagerRuntimeConfig(paths, process.env);
  if (!args.length || (args.length === 1 && args[0] === "--no-open")) return defaultLaunch();
  await ensureManager();
  if (args[0] === "admin" && args[1] === "open") {
    const result = await client.request<{ url: string }>("POST", "/v1/admin/bootstrap", { node_id: take("--node") });
    await openUrl(result.url);
    const admin = new URL(result.url);
    return print({ ok: true, admin: `${admin.origin}/admin/` });
  }
  if (args[0] === "manager" && args[1] === "status") return print(await client.health());
  if (args[0] !== "node") return help();
  if (args[1] === "list") return print(await client.request("GET", "/v1/nodes"));
  if (args[1] === "create") {
    const nodeId = take("--node-id");
    const confirmation = take("--confirm");
    if (!nodeId || !confirmation) throw new Error("create requires --node-id UUIDv7 and --confirm with the exact same UUID");
    return print(await client.request("POST", "/v1/cli/nodes", {
      node_id: nodeId,
      confirmation,
      alias: take("--alias", "personal"),
      ports: explicitPorts(),
    }));
  }
  const node = await selector();
  if (args[1] === "status" || args[1] === "doctor") return print(await client.request("GET", `/v1/nodes/${encodeURIComponent(node)}/health`));
  if (["start", "stop", "restart"].includes(args[1] || "")) return print(await client.request("POST", `/v1/nodes/${encodeURIComponent(node)}/${args[1]}`, {}));
  if (args[1] === "logs") {
    const params = new URLSearchParams({ service: take("--service", "api")!, tail: take("--tail", "200")! });
    return print(await client.request("GET", `/v1/nodes/${encodeURIComponent(node)}/logs?${params}`));
  }
  if (args[1] === "mcp-config") {
    const direct = new NodeManager({ paths, runner });
    await direct.initialize();
    const selected = await direct.store.findNode(node);
    const format = take("--format", "json");
    if (format !== "json" && format !== "toml") throw new Error("--format must be json or toml");
    return print(await renderMcpConfig(paths, selected, format));
  }
  if (args[1] === "models" && args[2] === "configure") {
    return print(await client.request("POST", `/v1/cli/nodes/${encodeURIComponent(node)}/models/configure`, {
      embedding_base_url: take("--embedding-base-url", process.env.EMBEDDING_BASE_URL),
      embedding_api_key: process.env.EMBEDDING_API_KEY || process.env.NEUROMEM_EMBEDDING_API_KEY,
      embedding_model: take("--embedding-model", process.env.EMBEDDING_MODEL),
      generation_base_url: take("--generation-base-url", process.env.GENERATION_BASE_URL),
      generation_api_key: process.env.GENERATION_API_KEY || process.env.NEUROMEM_GENERATION_API_KEY,
      generation_model: take("--generation-model", process.env.GENERATION_MODEL),
    }));
  }
  if (args[1] === "backup") {
    if (args[2] === "list") return print(await client.request("GET", `/v1/nodes/${encodeURIComponent(node)}/backups`));
    if (args[2] === "create") return print(await client.request("POST", `/v1/nodes/${encodeURIComponent(node)}/backups`, { label: take("--label", "manual") }));
    if (args[2] === "verify") return print(await client.request("POST", `/v1/nodes/${encodeURIComponent(node)}/backups/${encodeURIComponent(required("--backup"))}/verify`, {}));
  }
  if (args[1] === "restore" && args[2] === "plan") {
    return print(await client.request("POST", `/v1/nodes/${encodeURIComponent(node)}/restore/plan`, { backup_id: required("--backup") }));
  }
  if (args[1] === "migrate" && args[2] === "plan") {
    return print(await client.request("POST", `/v1/nodes/${encodeURIComponent(node)}/migrate/plan`, { target_revision: take("--target", "head"), apply_mode: take("--mode", "new_generation") }));
  }
  if (args[1] === "restore" && args[2] === "apply") {
    return print(await client.request("POST", `/v1/cli/nodes/${encodeURIComponent(node)}/restore/apply`, {
      backup_id: required("--backup"), confirmation: required("--confirm"),
    }));
  }
  if (args[1] === "migrate" && args[2] === "apply") {
    return print(await client.request("POST", `/v1/cli/nodes/${encodeURIComponent(node)}/migrate/apply`, {
      target_revision: take("--target", "head"), confirmation: required("--confirm"), apply_mode: take("--mode", "new_generation"),
    }));
  }
  if (args[1] === "migrate" && args[2] === "verify") {
    return print(await client.request("POST", `/v1/cli/nodes/${encodeURIComponent(node)}/migrate/verify`, {
      target_revision: take("--target", "head"),
    }));
  }
  if (args[1] === "delete") {
    return print(await client.request("DELETE", `/v1/cli/nodes/${encodeURIComponent(node)}`, {
      confirmation: required("--confirm"), purge_data: flag("--purge-data"),
    }));
  }
  help();
  process.exitCode = 1;
}

function required(name: string): string {
  const value = take(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function explicitPorts(): Record<string, number> | undefined {
  const values = [take("--api-port"), take("--dashboard-port"), take("--mcp-port")];
  if (values.every(value => value === undefined)) return undefined;
  if (values.some(value => value === undefined)) throw new Error("Explicit ports require --api-port, --dashboard-port, and --mcp-port together");
  return { api: Number(values[0]), dashboard: Number(values[1]), mcp: Number(values[2]) };
}

async function openUrl(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  await runner.run(command, [url], { allowFailure: true, timeoutMs: 10_000 });
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: (error as Error).message }, null, 2)}\n`);
  process.exitCode = 1;
});
