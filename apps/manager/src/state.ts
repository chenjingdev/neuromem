import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite, ensurePrivateDirectory, exists, readJson } from "./fs-safe.js";
import { nodeDirectory, nodeFile, type ManagerPaths } from "./paths.js";
import type { NodeRecord, OperationKind, OperationRecord, RegistryFile } from "./types.js";

const EMPTY_REGISTRY: RegistryFile = { format: 1, default_node_id: null, nodes: [] };

export class StateStore {
  readonly paths: ManagerPaths;
  #mutationQueue: Promise<void> = Promise.resolve();

  constructor(paths: ManagerPaths) {
    this.paths = paths;
  }

  async initialize(): Promise<void> {
    for (const directory of [this.paths.home, this.paths.manager, this.paths.nodes, this.paths.run]) {
      await ensurePrivateDirectory(directory);
    }
    if (!(await exists(this.paths.registry))) {
      await atomicWrite(this.paths.registry, `${JSON.stringify(EMPTY_REGISTRY, null, 2)}\n`);
    }
  }

  async registry(): Promise<RegistryFile> {
    await this.initialize();
    const registry = await readJson<RegistryFile>(this.paths.registry);
    validateRegistry(registry);
    return registry;
  }

  async findNode(selector: string): Promise<NodeRecord> {
    const registry = await this.registry();
    const node = registry.nodes.find(candidate => candidate.node_id === selector || candidate.alias === selector);
    if (!node) throw new Error(`Unknown Neuromem Node: ${selector}`);
    return node;
  }

  async defaultNode(): Promise<NodeRecord | null> {
    const registry = await this.registry();
    if (!registry.default_node_id) return null;
    return registry.nodes.find(node => node.node_id === registry.default_node_id) || null;
  }

  async addNode(node: NodeRecord, makeDefault = false): Promise<void> {
    await this.mutateRegistry(registry => {
      if (registry.nodes.some(candidate => candidate.node_id === node.node_id)) {
        throw new Error(`Node UUID already exists: ${node.node_id}`);
      }
      if (registry.nodes.some(candidate => candidate.alias === node.alias)) {
        throw new Error(`Node alias already exists: ${node.alias}`);
      }
      registry.nodes.push(node);
      if (makeDefault || !registry.default_node_id) registry.default_node_id = node.node_id;
    });
    const directory = nodeDirectory(this.paths, node.node_id);
    for (const child of [directory, path.join(directory, "operations"), path.join(directory, "backups"), path.join(directory, "logs")]) {
      await ensurePrivateDirectory(child);
    }
    await this.writeNodeSnapshot(node);
  }

  async updateNode(nodeId: string, update: (node: NodeRecord) => void): Promise<NodeRecord> {
    let result: NodeRecord | undefined;
    await this.mutateRegistry(registry => {
      const node = registry.nodes.find(candidate => candidate.node_id === nodeId);
      if (!node) throw new Error(`Unknown Neuromem Node: ${nodeId}`);
      update(node);
      node.updated_at = new Date().toISOString();
      result = structuredClone(node);
    });
    if (!result) throw new Error(`Unknown Neuromem Node: ${nodeId}`);
    await this.writeNodeSnapshot(result);
    return result;
  }

  async removeNode(nodeId: string): Promise<void> {
    await this.mutateRegistry(registry => {
      const before = registry.nodes.length;
      registry.nodes = registry.nodes.filter(node => node.node_id !== nodeId);
      if (registry.nodes.length === before) throw new Error(`Unknown Neuromem Node: ${nodeId}`);
      if (registry.default_node_id === nodeId) registry.default_node_id = registry.nodes[0]?.node_id || null;
    });
  }

  async beginOperation(nodeId: string, kind: OperationKind, phase = "starting"): Promise<OperationRecord> {
    const now = new Date().toISOString();
    const operation: OperationRecord = {
      operation_id: crypto.randomUUID(),
      node_id: nodeId,
      kind,
      state: "running",
      phase,
      started_at: now,
      updated_at: now,
    };
    await this.writeOperation(operation);
    return operation;
  }

  async updateOperation(operation: OperationRecord, patch: Partial<OperationRecord>): Promise<OperationRecord> {
    const next: OperationRecord = {
      ...operation,
      ...patch,
      operation_id: operation.operation_id,
      node_id: operation.node_id,
      kind: operation.kind,
      updated_at: new Date().toISOString(),
    };
    await this.writeOperation(next);
    return next;
  }

  async recoverInterruptedOperations(): Promise<number> {
    const registry = await this.registry();
    let recovered = 0;
    for (const node of registry.nodes) {
      const activeOwner = await readJson<{ pid: number }>(nodeFile(this.paths, node.node_id, path.join(".operation.lock", "owner.json"))).catch(() => null);
      if (activeOwner && processIsAlive(activeOwner.pid)) continue;
      const operationsDirectory = path.join(nodeDirectory(this.paths, node.node_id), "operations");
      if (!(await exists(operationsDirectory))) continue;
      for (const entry of await fs.readdir(operationsDirectory)) {
        if (!entry.endsWith(".json")) continue;
        const target = path.join(operationsDirectory, entry);
        const operation = await readJson<OperationRecord>(target).catch(() => null);
        if (!operation || operation.state !== "running") continue;
        await this.updateOperation(operation, {
          state: "needs_attention",
          phase: "manager_restarted",
          error: "The Node Manager restarted during this operation; it was not replayed automatically",
          completed_at: new Date().toISOString(),
        });
        recovered += 1;
      }
    }
    return recovered;
  }

  async operations(nodeId: string): Promise<OperationRecord[]> {
    const directory = nodeFile(this.paths, nodeId, "operations");
    if (!(await exists(directory))) return [];
    const operations: OperationRecord[] = [];
    for (const entry of await fs.readdir(directory)) {
      if (!entry.endsWith(".json")) continue;
      const operation = await readJson<OperationRecord>(path.join(directory, entry)).catch(() => null);
      if (operation?.node_id === nodeId) operations.push(operation);
    }
    return operations.sort((left, right) => left.started_at.localeCompare(right.started_at));
  }

  async withNodeLock<T>(nodeId: string, action: () => Promise<T>): Promise<T> {
    const lock = nodeFile(this.paths, nodeId, ".operation.lock");
    await ensurePrivateDirectory(path.dirname(lock));
    try {
      await fs.mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readJson<{ pid: number }>(path.join(lock, "owner.json")).catch(() => null);
      if (owner && processIsAlive(owner.pid)) {
        throw new Error(`Node ${nodeId} already has a lifecycle operation in progress`);
      }
      if (!owner) {
        const age = Date.now() - (await fs.stat(lock)).mtimeMs;
        if (age < 30_000) throw new Error(`Node ${nodeId} already has a lifecycle operation in progress`);
      }
      await fs.rm(lock, { recursive: true, force: true });
      await fs.mkdir(lock, { mode: 0o700 });
    }
    await atomicWrite(path.join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`);
    try {
      return await action();
    } finally {
      await fs.rm(lock, { recursive: true, force: true });
    }
  }

  private async mutateRegistry(mutation: (registry: RegistryFile) => void): Promise<void> {
    const work = this.#mutationQueue.then(async () => {
      const registry = await this.registry();
      mutation(registry);
      validateRegistry(registry);
      await atomicWrite(this.paths.registry, `${JSON.stringify(registry, null, 2)}\n`);
    });
    this.#mutationQueue = work.catch(() => undefined);
    await work;
  }

  private async writeNodeSnapshot(node: NodeRecord): Promise<void> {
    await atomicWrite(nodeFile(this.paths, node.node_id, "node.json"), `${JSON.stringify(node, null, 2)}\n`);
  }

  private async writeOperation(operation: OperationRecord): Promise<void> {
    const target = nodeFile(this.paths, operation.node_id, path.join("operations", `${operation.operation_id}.json`));
    await atomicWrite(target, `${JSON.stringify(operation, null, 2)}\n`);
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function validateRegistry(registry: RegistryFile): void {
  if (registry.format !== 1 || !Array.isArray(registry.nodes)) throw new Error("Unsupported Node registry format");
  const ids = new Set<string>();
  const aliases = new Set<string>();
  const composeProjects = new Set<string>();
  for (const node of registry.nodes) {
    if (ids.has(node.node_id)) throw new Error(`Duplicate Node UUID: ${node.node_id}`);
    if (aliases.has(node.alias)) throw new Error(`Duplicate Node alias: ${node.alias}`);
    if (composeProjects.has(node.compose_project)) throw new Error(`Duplicate Compose project: ${node.compose_project}`);
    const expectedProject = `neuromem-${node.node_id.replaceAll("-", "").toLowerCase()}`;
    if (node.compose_project !== expectedProject) throw new Error(`Invalid Compose project for Node ${node.node_id}`);
    ids.add(node.node_id);
    aliases.add(node.alias);
    composeProjects.add(node.compose_project);
  }
  if (registry.default_node_id && !ids.has(registry.default_node_id)) {
    throw new Error("The default Node does not exist in the registry");
  }
}
