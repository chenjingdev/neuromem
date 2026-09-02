#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ManagerClient } from "./client.js";
import { packagedSkillPath } from "./mcp-config.js";
import { resolveManagerPaths } from "./paths.js";
import { ProcessRunner } from "./process-runner.js";
import { installSupervisor } from "./supervisor.js";
import { persistManagerRuntimeConfig } from "./runtime-config.js";
import { NodeDeploymentManager, type NodeTarget, type NodeStartProgress } from "./node-deployment-manager.js";

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
  neuromem                         Start this physical Node and open Neuromem
  neuromem node start|stop|status [--env /private/node.env] [--target auto|dgx|mac]
  neuromem node preflight [--target auto|dgx|mac]
  neuromem node config init|validate [--env /private/node.env]
  neuromem node compute status [--env /private/node.env]
  neuromem node logs [--service control] [--tail 200]
  neuromem node admin open          Open the host-only Node management UI
  neuromem node schema init
  neuromem node mcp-config --credential-file /private/credential [--format json|toml]
  neuromem node backup rehearse [--output /private/backup-dir]
  neuromem node migrate rehearse [--target-revision head]
  neuromem skill path              Print the packaged Agent memory skill path

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
  throw new Error(`The local Node Manager did not start; inspect ${paths.managerLog} and rerun \`neuromem node start\``);
}

async function waitForManager(milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await client.health().then(result => result.ok).catch(() => false)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

async function defaultLaunch(): Promise<void> {
  const result = await startPhysicalNode(true);
  if (!flag("--no-open")) await openUrl(String((result as { dashboard: string }).dashboard));
}

async function main(): Promise<void> {
  if (flag("--help") || args[0] === "help") return help();
  if (flag("--version") || args[0] === "version") return print(VERSION);
  if (args[0] === "skill" && args[1] === "path") return print(packagedSkillPath());
  await persistManagerRuntimeConfig(paths, process.env);
  if (!args.length || (args.length === 1 && args[0] === "--no-open")) return defaultLaunch();
  if (args[0] === "node") return nodeCommand();
  help();
  process.exitCode = 1;
}

async function nodeCommand(): Promise<void> {
  const node = new NodeDeploymentManager({ paths, runner });
  const envFile = take("--env");
  const target = take("--target", "auto") as NodeTarget;
  if (args[1] === "admin" && args[2] === "open") {
    await ensureManager();
    const result = await client.request<{ url: string }>("POST", "/v1/admin/bootstrap", {});
    await openUrl(result.url);
    const admin = new URL(result.url);
    return print({ ok: true, admin: `${admin.origin}/admin/` });
  }
  if (args[1] === "config" && args[2] === "init") return print(await node.initializeConfig(envFile));
  if (args[1] === "config" && args[2] === "validate") return print(await node.validateConfig(envFile));
  if (args[1] === "preflight") return print(await node.preflight(target));
  if (args[1] === "start") return print(await startPhysicalNode(false));
  if (args[1] === "stop") return print(await node.stop(envFile));
  if (args[1] === "status") return print(await node.status(envFile));
  if (args[1] === "compute" && args[2] === "status") return print(await node.computeStatus(envFile));
  if (args[1] === "logs") return print(await node.logs(envFile, take("--service", "control")!, Number(take("--tail", "200"))));
  if (args[1] === "schema" && args[2] === "init") {
    const resolved = target === "auto" ? (await node.preflight("auto")).target : target;
    return print(await node.schemaInit(envFile, resolved as Exclude<NodeTarget, "auto">));
  }
  if (args[1] === "mcp-config") {
    const format = take("--format", "json");
    if (format !== "json" && format !== "toml") throw new Error("--format must be json or toml");
    return print(await node.mcpConfig(envFile, required("--credential-file"), format));
  }
  if (args[1] === "backup" && args[2] === "rehearse") return print(await node.backupRehearsal(envFile, take("--output")));
  if (args[1] === "migrate" && args[2] === "rehearse") return print(await node.migrationRehearsal(envFile, take("--target-revision", "head")));
  throw new Error("unknown Node command; run `neuromem --help`");
}

async function startPhysicalNode(_defaultLaunch: boolean): Promise<unknown> {
  await ensureManager();
  const node = new NodeDeploymentManager({ paths, runner });
  const onProgress = (progress: NodeStartProgress) => {
    process.stderr.write(`[${progress.current}/${progress.total}] ${progress.message}\n`);
  };
  return node.start({
    envFile: take("--env"),
    target: take("--target", "auto") as NodeTarget,
    onProgress,
  });
}

function required(name: string): string {
  const value = take(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function openUrl(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  await runner.run(command, [url], { allowFailure: true, timeoutMs: 10_000 });
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: (error as Error).message }, null, 2)}\n`);
  process.exitCode = 1;
});
