import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ComposeController, readNodeEnv } from "./compose.js";
import { assertUuid, assertUuid7, atomicWrite, ensurePrivateDirectory, exists, readJson, safeLabel, sha256File } from "./fs-safe.js";
import { nodeDirectory, nodeFile, type ManagerPaths } from "./paths.js";
import { StateStore } from "./state.js";
import { readManagerRuntimeConfig } from "./runtime-config.js";
import type {
  BackupManifest, CommandRunner, DatabaseManifest, MigrationPlan, NodePhase, NodeRecord, NodeStatus,
  OperationKind, OperationRecord, RestorePlan,
} from "./types.js";

export interface CreateNodeInput {
  node_id: string;
  confirmation: string;
  alias: string;
  ports?: Partial<NodeRecord["ports"]>;
  make_default?: boolean;
}

export interface NodeManagerOptions {
  paths: ManagerPaths;
  runner: CommandRunner;
  fetch?: typeof fetch;
  startTimeoutMs?: number;
  managerPort?: number;
  imageContextRoot?: string;
}

export interface ModelConfiguration {
  embedding_base_url?: string;
  embedding_api_key?: string;
  embedding_model?: string;
  generation_base_url?: string;
  generation_api_key?: string;
  generation_model?: string;
}

const ALIAS_PORTS: Record<string, NodeRecord["ports"]> = {
  personal: { api: 18001, dashboard: 14173, mcp: 18765 },
  company: { api: 28001, dashboard: 24173, mcp: 28765 },
};

export class NodeManager {
  readonly store: StateStore;
  readonly compose: ComposeController;
  readonly paths: ManagerPaths;
  readonly managerPort: number;
  private readonly fetcher: typeof fetch;
  private readonly startTimeoutMs: number;
  private readonly imageContextRoot: string;

  constructor(options: NodeManagerOptions) {
    this.paths = options.paths;
    this.store = new StateStore(options.paths);
    this.compose = new ComposeController(options.paths, options.runner);
    this.fetcher = options.fetch || fetch;
    this.startTimeoutMs = options.startTimeoutMs ?? 180_000;
    this.managerPort = options.managerPort ?? Number(process.env.NEUROMEM_MANAGER_PORT || 14174);
    this.imageContextRoot = path.resolve(options.imageContextRoot || process.env.NEUROMEM_IMAGE_CONTEXT_ROOT || fileURLToPath(new URL("../../assets/images", import.meta.url)));
  }

  async initialize(recoverInterrupted = false): Promise<void> {
    await this.store.initialize();
    if (recoverInterrupted) {
      await this.store.recoverInterruptedOperations();
      await this.reconcileInterruptedCutovers();
    }
  }

  async reconcileDesiredNodes(): Promise<void> {
    for (const node of await this.listNodes()) {
      const status = await this.status(node.node_id).catch(() => null);
      if (!status?.docker_available) continue;
      if (node.desired_state === "stopped" && status.phase !== "stopped") {
        await this.stop(node.node_id).catch(() => undefined);
      } else if (node.desired_state === "running" && ["stopped", "failed"].includes(status.phase)) {
        await this.start(node.node_id).catch(() => undefined);
      }
    }
  }

  async listNodes(): Promise<NodeRecord[]> {
    return (await this.store.registry()).nodes;
  }

  async createNode(input: CreateNodeInput): Promise<OperationRecord> {
    assertUuid7(input.node_id);
    if (input.confirmation !== input.node_id) throw new Error("Node creation requires the exact generated Node UUID confirmation");
    const alias = safeLabel(input.alias).toLowerCase();
    const existing = await this.listNodes();
    const ports = await allocatePorts(existing, alias, input.ports);
    const now = new Date().toISOString();
    const node: NodeRecord = {
      node_id: input.node_id,
      alias,
      ports,
      generation: 1,
      desired_state: "stopped",
      phase: "stopped",
      compose_project: `neuromem-${runtimeKey(input.node_id)}`,
      schema_revision: "uninitialized",
      created_at: now,
      updated_at: now,
    };
    await this.store.addNode(node, input.make_default);
    let operation = await this.store.beginOperation(node.node_id, "create", "preparing_runtime");
    try {
      await this.ensureRuntime(node);
      await this.validateRuntimeIdentity(node);
      operation = await this.store.updateOperation(operation, {
        state: "succeeded",
        phase: "runtime_ready",
        completed_at: new Date().toISOString(),
        result: node,
      });
      return operation;
    } catch (error) {
      await this.store.updateNode(node.node_id, value => { value.phase = "failed"; });
      return this.failOperation(operation, error);
    }
  }

  async status(selector: string): Promise<NodeStatus> {
    const node = await this.store.findNode(selector);
    const endpoints = endpointSet(node);
    const dockerAvailable = await this.compose.dockerAvailable().catch(() => false);
    if (!dockerAvailable) {
      const phase = node.desired_state === "stopped" ? "stopped" : "failed";
      const synchronized = node.phase === phase ? node : await this.store.updateNode(node.node_id, value => { value.phase = phase; });
      return {
        node: synchronized,
        docker_available: false,
        phase,
        components: [],
        endpoints,
        error: "Docker engine is unavailable",
      };
    }
    const components = await this.compose.ps(node);
    if (node.desired_state === "stopped" && components.every(component => !isRunning(component.state))) {
      const synchronized = node.phase === "stopped" ? node : await this.store.updateNode(node.node_id, value => { value.phase = "stopped"; });
      return { node: synchronized, docker_available: true, phase: "stopped", components, endpoints };
    }
    const readiness = await this.probeReady(`${endpoints.api}/ready`, node);
    const expected = ["database", "core", "worker", "mcp", "web"];
    const allRunning = expected.every(name => components.some(component => component.name === name && isRunning(component.state)));
    const unhealthy = components.some(component => component.health && component.health !== "healthy");
    let phase: NodePhase = allRunning && readiness.fully_ready && !unhealthy
      ? "ready"
      : readiness.operational
        ? "degraded"
        : "failed";
    const databaseRunning = components.some(component => component.name === "database" && isRunning(component.state));
    if (!readiness.operational && databaseRunning) {
      const schema = await this.compose.migrationStatus(node, "head").catch(error => ({ ok: false, stdout: "", stderr: (error as Error).message, code: 1 }));
      const detail = `${schema.stdout}\n${schema.stderr}`;
      if (!schema.ok && /schema|revision|expected|extension missing|table missing|halfvec/i.test(detail)) phase = "maintenance";
    }
    const synchronized = node.phase === phase ? node : await this.store.updateNode(node.node_id, value => { value.phase = phase; });
    return { node: synchronized, docker_available: true, phase, components, endpoints };
  }

  async backlog(selector: string): Promise<Record<string, unknown>> {
    const node = await this.store.findNode(selector);
    try {
      const env = await readNodeEnv(this.paths, node);
      const response = await this.fetcher(`${endpointSet(node).api}/v1/system/backlog`, {
        headers: { authorization: `Bearer ${env.API_TOKEN || ""}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`Core returned HTTP ${response.status}`);
      const body = await response.json() as Record<string, unknown>;
      return { node_id: node.node_id, available: true, ...body };
    } catch (error) {
      return { node_id: node.node_id, available: false, pending: null, running: null, failed: null, error: (error as Error).message };
    }
  }

  async logs(selector: string, service = "api", tail = 200): Promise<Record<string, unknown>> {
    const node = await this.store.findNode(selector);
    const logs = redact(await this.compose.logs(node, service, tail));
    return { node_id: node.node_id, service, tail, logs };
  }

  start(selector: string): Promise<OperationRecord> {
    return this.lifecycle(selector, "start", async node => {
      await this.ensureRuntime(node);
      await this.validateRuntimeIdentity(node);
      await this.ensureImages(node);
      await this.store.updateNode(node.node_id, value => {
        value.desired_state = "running";
        value.phase = "starting";
      });
      await this.compose.up(node);
      const status = await this.waitForReady(node.node_id);
      let actualRevision = node.schema_revision;
      if (status.phase === "ready" || status.phase === "degraded") {
        const verification = await this.compose.runMigration(node, "head", true);
        actualRevision = parseVerifiedRevision(verification.stdout, "head");
      }
      const updated = await this.store.updateNode(node.node_id, value => {
        value.phase = status.phase;
        value.schema_revision = actualRevision;
      });
      if (status.phase !== "ready" && status.phase !== "degraded") throw new Error(`Node did not become operational; current phase is ${status.phase}`);
      return { ...status, node: updated };
    });
  }

  stop(selector: string): Promise<OperationRecord> {
    return this.lifecycle(selector, "stop", async node => {
      await this.store.updateNode(node.node_id, value => { value.desired_state = "stopped"; });
      await this.compose.stop(node);
      const updated = await this.store.updateNode(node.node_id, value => { value.phase = "stopped"; });
      return { node: updated, data_preserved: true };
    });
  }

  restart(selector: string): Promise<OperationRecord> {
    return this.lifecycle(selector, "restart", async node => {
      await this.ensureRuntime(node);
      await this.validateRuntimeIdentity(node);
      await this.ensureImages(node);
      await this.store.updateNode(node.node_id, value => {
        value.desired_state = "running";
        value.phase = "starting";
      });
      await this.compose.stop(node);
      await this.compose.up(node);
      const status = await this.waitForReady(node.node_id);
      let actualRevision = node.schema_revision;
      if ((status.phase === "ready" || status.phase === "degraded") && node.schema_revision === "uninitialized") {
        actualRevision = parseVerifiedRevision((await this.compose.runMigration(node, "head", true)).stdout, "head");
      }
      const updated = await this.store.updateNode(node.node_id, value => {
        value.phase = status.phase;
        value.schema_revision = actualRevision;
      });
      if (status.phase !== "ready" && status.phase !== "degraded") throw new Error(`Node did not become operational; current phase is ${status.phase}`);
      return { ...status, node: updated };
    });
  }

  async backupCreate(selector: string, label = "manual"): Promise<OperationRecord> {
    const node = await this.store.findNode(selector);
    if (node.schema_revision === "uninitialized") throw new Error("Start and verify the Node before creating a backup");
    return this.store.withNodeLock(node.node_id, async () => {
      let operation = await this.store.beginOperation(node.node_id, "backup", "dumping");
      const backupId = crypto.randomUUID();
      const safe = safeLabel(label);
      const partial = nodeFile(this.paths, node.node_id, path.join("backups", `.partial-${backupId}`));
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const finalDirectory = nodeFile(this.paths, node.node_id, path.join("backups", `${timestamp}-${safe}-${backupId}`));
      const resumeServices = node.desired_state === "running";
      try {
        await ensurePrivateDirectory(partial);
        const archive = path.join(partial, "database.dump");
        if (resumeServices) await this.compose.stopWriters(node);
        if (!(await this.compose.mcpQueueEmpty(node))) throw new Error("Backup is blocked while MCP has pending undelivered records");
        const database = await this.compose.databaseManifest(node);
        await this.compose.pgDump(node, archive);
        await this.compose.verifyDump(node, archive);
        const afterDump = await this.compose.databaseManifest(node);
        if (!sameLogicalManifest(database, afterDump)) throw new Error("Database changed while the backup snapshot was being created");
        const info = await fs.stat(archive);
        const manifest: BackupManifest = {
          format: 1,
          backup_id: backupId,
          label: safe,
          node_id: node.node_id,
          node_alias: node.alias,
          generation: node.generation,
          schema_revision: database.schema_revision,
          database_bytes: database.database_bytes,
          row_counts: database.row_counts,
          extensions: database.extensions,
          vector_columns: database.vector_columns,
          created_at: new Date().toISOString(),
          archive: "database.dump",
          archive_bytes: info.size,
          sha256: await sha256File(archive),
          verified: true,
        };
        await atomicWrite(path.join(partial, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
        await fs.rename(partial, finalDirectory);
        if (resumeServices) await this.compose.up(node);
        operation = await this.store.updateOperation(operation, {
          state: "succeeded", phase: "verified", completed_at: new Date().toISOString(), result: manifest,
        });
        return operation;
      } catch (error) {
        if (resumeServices) await this.compose.up(node).catch(() => undefined);
        await fs.rm(partial, { recursive: true, force: true });
        return this.failOperation(operation, error);
      }
    });
  }

  async listBackups(selector: string): Promise<{ node_id: string; backups: BackupManifest[] }> {
    const node = await this.store.findNode(selector);
    const directory = nodeFile(this.paths, node.node_id, "backups");
    await ensurePrivateDirectory(directory);
    const backups: BackupManifest[] = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".partial-")) continue;
      const manifest = await readJson<BackupManifest>(path.join(directory, entry.name, "manifest.json")).catch(() => null);
      if (manifest?.node_id === node.node_id) backups.push(manifest);
    }
    backups.sort((left, right) => right.created_at.localeCompare(left.created_at));
    return { node_id: node.node_id, backups };
  }

  async backupVerify(selector: string, backupId: string): Promise<OperationRecord> {
    const node = await this.store.findNode(selector);
    return this.store.withNodeLock(node.node_id, async () => {
      let operation = await this.store.beginOperation(node.node_id, "backup_verify", "checking_archive");
      try {
        const located = await this.locateBackup(node, backupId);
        const hash = await sha256File(located.archive);
        if (hash !== located.manifest.sha256) throw new Error("Backup checksum does not match its manifest");
        await this.compose.verifyDump(node, located.archive);
        const result = { ok: true, manifest: located.manifest, checks: { checksum: true, archive_structure: true } };
        operation = await this.store.updateOperation(operation, {
          state: "succeeded", phase: "verified", completed_at: new Date().toISOString(), result,
        });
        return operation;
      } catch (error) {
        return this.failOperation(operation, error);
      }
    });
  }

  async restorePlan(selector: string, backupId: string): Promise<OperationRecord> {
    const node = await this.store.findNode(selector);
    let operation = await this.store.beginOperation(node.node_id, "restore_plan", "inspecting");
    try {
      const located = await this.locateBackup(node, backupId);
      await this.verifyLocatedBackup(node, located);
      const stat = await fs.statfs(nodeDirectory(this.paths, node.node_id));
      const freeBytes = stat.bavail * stat.bsize;
      const requiredBytes = Math.max(
        located.manifest.database_bytes + located.manifest.archive_bytes * 2,
        Math.ceil(located.manifest.database_bytes * 1.25),
        1024 ** 3,
      );
      const queueEmpty = await this.compose.mcpQueueEmpty(node);
      const blockers = [
        ...(located.manifest.node_id !== node.node_id ? ["Backup belongs to another Node"] : []),
        ...(located.manifest.schema_revision !== node.schema_revision ? [`Backup schema ${located.manifest.schema_revision} does not match Node schema ${node.schema_revision}`] : []),
        ...manifestStructureBlockers(located.manifest),
        ...(!queueEmpty ? ["MCP has pending undelivered records; drain or resolve them before restore"] : []),
        ...(freeBytes < requiredBytes ? ["Insufficient free disk space for a staged restore"] : []),
      ];
      const plan: RestorePlan = {
        ok: blockers.length === 0,
        node_id: node.node_id,
        backup: located.manifest,
        current_generation: node.generation,
        candidate_generation: node.generation + 1,
        free_bytes: freeBytes,
        required_bytes: requiredBytes,
        requires_pre_restore_backup: true,
        preserves_current_generation: true,
        writes_blocked_during_apply: true,
        steps: [
          "Enter maintenance and stop all record writers",
          "Create a final pre-restore backup while writers remain stopped",
          "Restore into a new PostgreSQL volume generation",
          "Verify schema, row counts, writes, reads, and vector search on a private stack",
          "Stop writers and atomically switch the active generation",
          "Roll back to the previous generation if health verification fails",
          "Preserve both the previous generation and the backup",
        ],
        blockers,
      };
      operation = await this.store.updateOperation(operation, {
        state: "succeeded", phase: "planned", completed_at: new Date().toISOString(), result: plan,
      });
      return operation;
    } catch (error) {
      return this.failOperation(operation, error);
    }
  }

  async migrationPlan(selector: string, targetRevision: string, requestedMode?: string): Promise<OperationRecord> {
    const node = await this.store.findNode(selector);
    let operation = await this.store.beginOperation(node.node_id, "migrate_plan", "inspecting");
    try {
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(targetRevision)) throw new Error("Invalid target schema revision");
      const mode = requestedMode === "transactional" ? "transactional" : "new_generation";
      const blockers = targetRevision === node.schema_revision ? ["Node is already at the target revision"] : [];
      const plan: MigrationPlan = {
        ok: blockers.length === 0,
        node_id: node.node_id,
        current_revision: node.schema_revision,
        target_revision: targetRevision,
        requires_backup: targetRevision !== node.schema_revision,
        apply_mode: mode,
        writes_blocked_during_apply: true,
        blockers,
      };
      operation = await this.store.updateOperation(operation, {
        state: "succeeded", phase: "planned", completed_at: new Date().toISOString(), result: plan,
      });
      return operation;
    } catch (error) {
      return this.failOperation(operation, error);
    }
  }

  async restoreApply(selector: string, backupId: string, confirmation: string): Promise<OperationRecord> {
    const node = await this.store.findNode(selector);
    if (confirmation !== node.node_id) throw new Error("Restore requires --confirm with the exact Node UUID");
    const planned = await this.restorePlan(node.node_id, backupId);
    const plan = planned.result as RestorePlan | undefined;
    if (planned.state !== "succeeded" || !plan?.ok) throw new Error(planned.error || `Restore plan is blocked: ${plan?.blockers.join("; ") || "unknown reason"}`);
    return this.store.withNodeLock(node.node_id, async () => {
      let operation = await this.store.beginOperation(node.node_id, "restore_apply", "entering_maintenance");
      let latest = node;
      try {
        const located = await this.locateBackup(node, backupId);
        await this.verifyLocatedBackup(node, located);
        latest = await this.store.findNode(node.node_id);
        if (latest.generation !== node.generation || latest.schema_revision !== node.schema_revision) throw new Error("Node generation or schema changed before restore maintenance; retry the restore");
        const blockers = manifestStructureBlockers(located.manifest);
        if (located.manifest.schema_revision !== latest.schema_revision) blockers.push("Backup schema does not match the active Node schema");
        if (blockers.length) throw new Error(`Backup cannot be restored: ${blockers.join("; ")}`);
        await this.store.updateNode(latest.node_id, value => { value.phase = "maintenance"; });
        await this.compose.stopWriters(latest);
        if (!(await this.compose.mcpQueueEmpty(latest))) throw new Error("Restore is blocked while MCP has pending undelivered records");
        operation = await this.store.updateOperation(operation, { phase: "quiesced_snapshot" });
        const safetyBackup = await this.snapshotWhileQuiesced(latest, "pre-restore");
        operation = await this.store.updateOperation(operation, { phase: "staging" });
        const candidateGeneration = await this.nextUnusedGeneration(latest);
        const candidateVolume = volumeName(node, candidateGeneration);
        const actualRevision = await this.stageDatabase(node, located.archive, candidateVolume, candidateGeneration, located.manifest, "exact", located.manifest.schema_revision);
        operation = await this.journalCutover(operation, latest, candidateGeneration, candidateVolume, actualRevision || located.manifest.schema_revision);
        const status = await this.cutover(latest, candidateVolume, candidateGeneration, actualRevision || located.manifest.schema_revision);
        operation = await this.store.updateOperation(operation, {
          state: "succeeded",
          phase: "verified",
          completed_at: new Date().toISOString(),
          result: {
            status,
            backup: located.manifest,
            pre_restore_backup: safetyBackup.backup_id,
            previous_generation: node.generation,
            active_generation: candidateGeneration,
            previous_generation_preserved: true,
          },
        });
        return operation;
      } catch (error) {
        await this.resumeExistingGeneration(latest);
        return this.failOperation(operation, error);
      }
    });
  }

  async migrationApply(selector: string, targetRevision: string, confirmation: string, requestedMode = "new_generation"): Promise<OperationRecord> {
    const node = await this.store.findNode(selector);
    if (confirmation !== node.node_id) throw new Error("Migration requires --confirm with the exact Node UUID");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(targetRevision)) throw new Error("Invalid target schema revision");
    return this.store.withNodeLock(node.node_id, async () => {
      let operation = await this.store.beginOperation(node.node_id, "migrate_apply", "entering_maintenance");
      let latest = node;
      try {
        latest = await this.store.findNode(node.node_id);
        if (latest.generation !== node.generation || latest.schema_revision !== node.schema_revision) throw new Error("Node generation or schema changed before migration maintenance; retry the migration");
        await this.store.updateNode(latest.node_id, value => { value.phase = "maintenance"; });
        await this.compose.stopWriters(latest);
        if (!(await this.compose.mcpQueueEmpty(latest))) throw new Error("Migration is blocked while MCP has pending undelivered records");
        operation = await this.store.updateOperation(operation, { phase: "quiesced_snapshot" });
        const manifest = await this.snapshotWhileQuiesced(latest, "pre-migrate");
        if (manifest.schema_revision !== latest.schema_revision) throw new Error("Pre-migration backup schema does not match the active Node schema");
        if (requestedMode !== "transactional") {
          const stat = await fs.statfs(nodeDirectory(this.paths, latest.node_id));
          const freeBytes = stat.bavail * stat.bsize;
          const requiredBytes = Math.max(manifest.database_bytes + manifest.archive_bytes * 2, Math.ceil(manifest.database_bytes * 1.25), 1024 ** 3);
          if (freeBytes < requiredBytes) throw new Error(`Migration requires ${requiredBytes} free bytes but only ${freeBytes} are available`);
        }
        if (requestedMode === "transactional") {
          operation = await this.store.updateOperation(operation, { phase: "migrating" });
          await this.compose.runMigration(latest, targetRevision, false);
          const verification = await this.compose.runMigration(latest, targetRevision, true);
          const actualRevision = parseVerifiedRevision(verification.stdout, targetRevision);
          await this.compose.up(latest);
          const status = await this.waitForReady(latest.node_id);
          if (status.phase !== "ready" && status.phase !== "degraded") throw new Error("Node did not become operational after transactional migration");
          await this.store.updateNode(latest.node_id, value => {
            value.schema_revision = actualRevision;
            value.phase = status.phase;
          });
          return this.store.updateOperation(operation, {
            state: "succeeded", phase: "verified", completed_at: new Date().toISOString(),
            result: { mode: "transactional", actual_revision: actualRevision, backup_id: manifest.backup_id, status },
          });
        }
        const located = await this.locateBackup(latest, manifest.backup_id);
        await this.verifyLocatedBackup(latest, located);
        const candidateGeneration = await this.nextUnusedGeneration(latest);
        const candidateVolume = volumeName(latest, candidateGeneration);
        const actualRevision = await this.stageDatabase(latest, located.archive, candidateVolume, candidateGeneration, located.manifest, "migration", targetRevision);
        operation = await this.journalCutover(operation, latest, candidateGeneration, candidateVolume, actualRevision || targetRevision);
        const status = await this.cutover(latest, candidateVolume, candidateGeneration, actualRevision || targetRevision);
        return this.store.updateOperation(operation, {
          state: "succeeded", phase: "verified", completed_at: new Date().toISOString(),
          result: {
            mode: "new_generation", actual_revision: actualRevision || targetRevision,
            backup_id: manifest.backup_id, previous_generation: latest.generation,
            active_generation: candidateGeneration, previous_generation_preserved: true, status,
          },
        });
      } catch (error) {
        await this.resumeExistingGeneration(latest);
        return this.failOperation(operation, error);
      }
    });
  }

  async migrationVerify(selector: string, targetRevision = "head"): Promise<OperationRecord> {
    const node = await this.store.findNode(selector);
    return this.store.withNodeLock(node.node_id, async () => {
      let operation = await this.store.beginOperation(node.node_id, "migrate_verify", "verifying");
      try {
        const result = await this.compose.runMigration(node, targetRevision, true);
        const actualRevision = parseVerifiedRevision(result.stdout, targetRevision);
        await this.store.updateNode(node.node_id, value => { value.schema_revision = actualRevision; });
        operation = await this.store.updateOperation(operation, {
          state: "succeeded", phase: "verified", completed_at: new Date().toISOString(), result: { ok: true, actual_revision: actualRevision },
        });
        return operation;
      } catch (error) {
        return this.failOperation(operation, error);
      }
    });
  }

  async configureModels(selector: string, configuration: ModelConfiguration): Promise<OperationRecord> {
    const node = await this.store.findNode(selector);
    const updates = modelEnvUpdates(configuration);
    if (!Object.keys(updates).length) throw new Error("At least one model setting is required");
    return this.store.withNodeLock(node.node_id, async () => {
      let operation = await this.store.beginOperation(node.node_id, "models_configure", "updating_runtime");
      const target = nodeFile(this.paths, node.node_id, ".env");
      const original = await fs.readFile(target, "utf8");
      try {
        await atomicWrite(target, replaceEnvValues(original, updates));
        let status: NodeStatus | null = null;
        if (node.desired_state === "running") {
          await this.compose.stop(node);
          await this.compose.up(node);
          status = await this.waitForReady(node.node_id);
          if (status.phase !== "ready" && status.phase !== "degraded") throw new Error(`Node did not become operational after model configuration: ${status.phase}`);
          await this.store.updateNode(node.node_id, value => { value.phase = status!.phase; });
        }
        operation = await this.store.updateOperation(operation, {
          state: "succeeded",
          phase: status?.phase || "configured",
          completed_at: new Date().toISOString(),
          result: { updated_fields: Object.keys(updates), restarted: node.desired_state === "running", status },
        });
        return operation;
      } catch (error) {
        await atomicWrite(target, original);
        if (node.desired_state === "running") {
          await this.compose.stop(node).catch(() => undefined);
          await this.compose.up(node).catch(() => undefined);
        }
        return this.failOperation(operation, error);
      }
    });
  }

  async deleteNode(selector: string, confirmation: string, purgeData: boolean): Promise<OperationRecord> {
    const node = await this.store.findNode(selector);
    if (confirmation !== node.node_id) throw new Error("Node deletion requires the exact Node UUID confirmation");
    return this.store.withNodeLock(node.node_id, async () => {
      let operation = await this.store.beginOperation(node.node_id, "delete", "stopping");
      try {
        await this.compose.down(node);
        if (purgeData) {
          const env = await readNodeEnv(this.paths, node);
          const volume = env.DB_VOLUME_NAME;
          if (!volume || !volume.includes(runtimeKey(node.node_id))) throw new Error("Refusing to purge an unrecognized volume name");
          const mcpVolume = env.MCP_STATE_VOLUME_NAME;
          if (!mcpVolume || !mcpVolume.includes(runtimeKey(node.node_id))) throw new Error("Refusing to purge an unrecognized MCP state volume name");
          const discovered = await this.compose.listNodeVolumes(node.node_id);
          const volumes = [...new Set([volume, mcpVolume, ...discovered])];
          for (const target of volumes) await this.compose.removeVolume(target);
        }
        operation = await this.store.updateOperation(operation, {
          state: "succeeded", phase: "detached", completed_at: new Date().toISOString(), result: { data_preserved: !purgeData },
        });
        await this.store.removeNode(node.node_id);
        if (purgeData) {
          const tombstone = path.join(this.paths.manager, "tombstones", `${node.node_id}.json`);
          await atomicWrite(tombstone, `${JSON.stringify({ node_id: node.node_id, alias: node.alias, purged_at: new Date().toISOString() }, null, 2)}\n`);
          await fs.rm(nodeDirectory(this.paths, node.node_id), { recursive: true, force: true });
        }
        return operation;
      } catch (error) {
        return this.failOperation(operation, error);
      }
    });
  }

  private async lifecycle(
    selector: string,
    kind: Extract<OperationKind, "start" | "stop" | "restart">,
    action: (node: NodeRecord) => Promise<unknown>,
  ): Promise<OperationRecord> {
    const node = await this.store.findNode(selector);
    return this.store.withNodeLock(node.node_id, async () => {
      let operation = await this.store.beginOperation(node.node_id, kind, kind === "stop" ? "stopping" : "starting");
      try {
        const result = await action(node);
        operation = await this.store.updateOperation(operation, {
          state: "succeeded",
          phase: kind === "stop" ? "stopped" : ((result as NodeStatus | undefined)?.phase || "ready"),
          completed_at: new Date().toISOString(), result,
        });
        return operation;
      } catch (error) {
        await this.store.updateNode(node.node_id, value => { value.phase = "failed"; }).catch(() => undefined);
        return this.failOperation(operation, error);
      }
    });
  }

  private async failOperation(operation: OperationRecord, error: unknown): Promise<OperationRecord> {
    return this.store.updateOperation(operation, {
      state: "failed",
      phase: "failed",
      completed_at: new Date().toISOString(),
      error: redact((error as Error).message || String(error)),
    });
  }

  private async snapshotWhileQuiesced(node: NodeRecord, label: string): Promise<BackupManifest> {
    const backupId = crypto.randomUUID();
    const safe = safeLabel(label);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const partial = nodeFile(this.paths, node.node_id, path.join("backups", `.partial-${backupId}`));
    const finalDirectory = nodeFile(this.paths, node.node_id, path.join("backups", `${timestamp}-${safe}-${backupId}`));
    await ensurePrivateDirectory(partial);
    try {
      const archive = path.join(partial, "database.dump");
      const before = await this.compose.databaseManifest(node);
      await this.compose.pgDump(node, archive);
      await this.compose.verifyDump(node, archive);
      const after = await this.compose.databaseManifest(node);
      if (!sameLogicalManifest(before, after)) throw new Error("Database changed while writers were quiesced");
      const info = await fs.stat(archive);
      const manifest: BackupManifest = {
        format: 1,
        backup_id: backupId,
        label: safe,
        node_id: node.node_id,
        node_alias: node.alias,
        generation: node.generation,
        schema_revision: before.schema_revision,
        database_bytes: before.database_bytes,
        row_counts: before.row_counts,
        extensions: before.extensions,
        vector_columns: before.vector_columns,
        created_at: new Date().toISOString(),
        archive: "database.dump",
        archive_bytes: info.size,
        sha256: await sha256File(archive),
        verified: true,
      };
      await atomicWrite(path.join(partial, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      await fs.rename(partial, finalDirectory);
      return manifest;
    } catch (error) {
      await fs.rm(partial, { recursive: true, force: true });
      throw error;
    }
  }

  private async resumeExistingGeneration(node: NodeRecord): Promise<void> {
    if (node.desired_state !== "running") {
      await this.store.updateNode(node.node_id, value => { value.phase = "stopped"; }).catch(() => undefined);
      return;
    }
    try {
      await this.compose.up(node);
      const status = await this.waitForReady(node.node_id);
      await this.store.updateNode(node.node_id, value => { value.phase = status.phase; });
    } catch {
      await this.store.updateNode(node.node_id, value => { value.phase = "failed"; }).catch(() => undefined);
    }
  }

  private async ensureRuntime(node: NodeRecord): Promise<void> {
    const directory = nodeDirectory(this.paths, node.node_id);
    await ensurePrivateDirectory(directory);
    const runtime = await readManagerRuntimeConfig(this.paths);
    const composeTarget = nodeFile(this.paths, node.node_id, "compose.yaml");
    if (!(await exists(composeTarget))) {
      const configured = runtime.NEUROMEM_COMPOSE_TEMPLATE || process.env.NEUROMEM_COMPOSE_TEMPLATE;
      const source = configured
        ? path.resolve(configured)
        : fileURLToPath(new URL("../../assets/compose.yaml", import.meta.url));
      await fs.copyFile(source, composeTarget);
      await fs.chmod(composeTarget, 0o600);
    }
    const envTarget = nodeFile(this.paths, node.node_id, ".env");
    if (!(await exists(envTarget))) {
      const prefix = runtimeKey(node.node_id);
      const values: Record<string, string | number> = {
        COMPOSE_PROJECT_NAME: node.compose_project,
        NODE_ID: node.node_id,
        NODE_ALIAS: node.alias,
        POSTGRES_DB: "neuromem",
        POSTGRES_USER: "neuromem",
        POSTGRES_PASSWORD: crypto.randomBytes(32).toString("base64url"),
        API_TOKEN: crypto.randomBytes(32).toString("base64url"),
        MCP_TOKEN: crypto.randomBytes(32).toString("base64url"),
        DB_VOLUME_NAME: `neuromem-${prefix}-pg-g${node.generation}`,
        MCP_STATE_VOLUME_NAME: `neuromem-${prefix}-mcp`,
        API_PORT: node.ports.api,
        MCP_PORT: node.ports.mcp,
        DASHBOARD_PORT: node.ports.dashboard,
        MANAGER_PORT: this.managerPort,
        NEUROMEM_CORE_IMAGE: runtime.NEUROMEM_CORE_IMAGE || process.env.NEUROMEM_CORE_IMAGE || "neuromem/core:0.1.0",
        NEUROMEM_MCP_IMAGE: runtime.NEUROMEM_MCP_IMAGE || process.env.NEUROMEM_MCP_IMAGE || "neuromem/mcp:0.1.0",
        NEUROMEM_DASHBOARD_IMAGE: runtime.NEUROMEM_DASHBOARD_IMAGE || process.env.NEUROMEM_DASHBOARD_IMAGE || "neuromem/dashboard:0.1.0",
        POSTGRES_IMAGE: runtime.POSTGRES_IMAGE || process.env.POSTGRES_IMAGE || "pgvector/pgvector:0.8.6-pg15",
        EMBEDDING_BASE_URL: runtime.EMBEDDING_BASE_URL || process.env.EMBEDDING_BASE_URL || "http://host.docker.internal:11434/v1",
        EMBEDDING_API_KEY: runtime.EMBEDDING_API_KEY || process.env.EMBEDDING_API_KEY || "",
        EMBEDDING_MODEL: runtime.EMBEDDING_MODEL || process.env.EMBEDDING_MODEL || "qwen3-embedding:4b",
        EMBEDDING_DIMENSIONS: runtime.EMBEDDING_DIMENSIONS || process.env.EMBEDDING_DIMENSIONS || "2560",
        GENERATION_BASE_URL: runtime.GENERATION_BASE_URL || process.env.GENERATION_BASE_URL || "",
        GENERATION_API_KEY: runtime.GENERATION_API_KEY || process.env.GENERATION_API_KEY || "",
        GENERATION_MODEL: runtime.GENERATION_MODEL || process.env.GENERATION_MODEL || "",
      };
      await atomicWrite(envTarget, `${Object.entries(values).map(([key, value]) => `${key}=${escapeEnv(String(value))}`).join("\n")}\n`);
    }
  }

  private async ensureImages(node: NodeRecord): Promise<void> {
    const env = await readNodeEnv(this.paths, node);
    const runtime = await readManagerRuntimeConfig(this.paths);
    const contextRoot = path.resolve(runtime.NEUROMEM_IMAGE_CONTEXT_ROOT || this.imageContextRoot);
    const images = [
      { name: "core", image: env.NEUROMEM_CORE_IMAGE },
      { name: "mcp", image: env.NEUROMEM_MCP_IMAGE },
      { name: "web", image: env.NEUROMEM_DASHBOARD_IMAGE },
    ];
    for (const entry of images) {
      if (!entry.image) throw new Error(`Runtime image is not configured for ${entry.name}`);
      const context = path.join(contextRoot, entry.name);
      const hasContext = await exists(path.join(context, "Dockerfile"));
      const contextDigest = hasContext ? await directoryDigest(context) : null;
      const present = await this.compose.runDocker(["image", "inspect", entry.image], { allowFailure: true, timeoutMs: 30_000 });
      if (present.ok && contextDigest) {
        const label = await this.compose.runDocker([
          "image", "inspect", "--format", '{{ index .Config.Labels "dev.neuromem.context-sha256" }}', entry.image,
        ], { allowFailure: true, timeoutMs: 30_000 });
        if (label.ok && label.stdout === contextDigest) continue;
      } else if (present.ok) {
        continue;
      }
      if (contextDigest) {
        await this.compose.runDocker([
          "build", "--label", `dev.neuromem.context-sha256=${contextDigest}`, "--tag", entry.image, context,
        ], { timeoutMs: 60 * 60_000 });
        continue;
      }
      const pulled = await this.compose.runDocker(["pull", entry.image], { allowFailure: true, timeoutMs: 60 * 60_000 });
      if (!pulled.ok) {
        throw new Error(`Image ${entry.image} is unavailable and packaged build context ${context} is missing`);
      }
    }
  }

  private async validateRuntimeIdentity(node: NodeRecord): Promise<void> {
    const env = await readNodeEnv(this.paths, node);
    const key = runtimeKey(node.node_id);
    const expected = {
      NODE_ID: node.node_id,
      NODE_ALIAS: node.alias,
      COMPOSE_PROJECT_NAME: `neuromem-${key}`,
      DB_VOLUME_NAME: `neuromem-${key}-pg-g${node.generation}`,
      MCP_STATE_VOLUME_NAME: `neuromem-${key}-mcp`,
      API_PORT: String(node.ports.api),
      DASHBOARD_PORT: String(node.ports.dashboard),
      MCP_PORT: String(node.ports.mcp),
    };
    for (const [name, value] of Object.entries(expected)) {
      if (env[name] !== value) throw new Error(`Runtime identity mismatch for ${name}; refusing Docker lifecycle action`);
    }
  }

  private async waitForReady(nodeId: string): Promise<NodeStatus> {
    const deadline = Date.now() + this.startTimeoutMs;
    let status = await this.status(nodeId);
    while (Date.now() < deadline && !["ready", "degraded", "maintenance"].includes(status.phase)) {
      await new Promise(resolve => setTimeout(resolve, 1_000));
      status = await this.status(nodeId);
    }
    return status;
  }

  private async probe(url: string, node: NodeRecord): Promise<boolean> {
    const env = await readNodeEnv(this.paths, node);
    const response = await this.fetcher(url, {
      headers: { authorization: `Bearer ${env.API_TOKEN || ""}` },
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  }

  private async probeReady(url: string, node: NodeRecord): Promise<{ operational: boolean; fully_ready: boolean }> {
    try {
      const env = await readNodeEnv(this.paths, node);
      const response = await this.fetcher(url, {
        headers: { authorization: `Bearer ${env.API_TOKEN || ""}` },
        signal: AbortSignal.timeout(3_000),
      });
      const payload = await response.json().catch(() => ({})) as {
        status?: string; database?: boolean; embedding_configured?: boolean; extraction_configured?: boolean;
        embedding_provider_status?: string; extraction_provider_status?: string;
      };
      const operational = response.ok && payload.database !== false;
      const fullyReady = operational
        && payload.status !== "degraded"
        && payload.embedding_configured !== false
        && payload.extraction_configured !== false
        && (payload.embedding_provider_status === undefined || ["ready", "configured"].includes(payload.embedding_provider_status))
        && (payload.extraction_provider_status === undefined || ["ready", "configured"].includes(payload.extraction_provider_status));
      return { operational, fully_ready: fullyReady };
    } catch {
      return { operational: false, fully_ready: false };
    }
  }

  private async locateBackup(node: NodeRecord, backupId: string): Promise<{ manifest: BackupManifest; archive: string }> {
    assertUuid(backupId, "backup_id");
    const root = nodeFile(this.paths, node.node_id, "backups");
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".partial-")) continue;
      const directory = path.join(root, entry.name);
      const manifest = await readJson<BackupManifest>(path.join(directory, "manifest.json")).catch(() => null);
      if (!manifest || manifest.backup_id !== backupId) continue;
      if (manifest.node_id !== node.node_id) throw new Error("Backup Node identity mismatch");
      const archive = path.resolve(directory, manifest.archive);
      if (!archive.startsWith(`${path.resolve(directory)}${path.sep}`)) throw new Error("Unsafe backup archive path");
      if (!(await exists(archive))) throw new Error("Backup archive is missing");
      return { manifest, archive };
    }
    throw new Error(`Unknown backup: ${backupId}`);
  }

  private async verifyLocatedBackup(node: NodeRecord, located: { manifest: BackupManifest; archive: string }): Promise<void> {
    if (await sha256File(located.archive) !== located.manifest.sha256) throw new Error("Backup checksum does not match its manifest");
    await this.compose.verifyDump(node, located.archive);
  }

  private async stageDatabase(
    node: NodeRecord,
    archive: string,
    candidateVolume: string,
    candidateGeneration: number,
    expected: BackupManifest,
    verificationMode: "exact" | "migration",
    migrationTarget?: string,
  ): Promise<string | undefined> {
    if (await this.compose.volumeExists(candidateVolume)) throw new Error(`Candidate volume already exists: ${candidateVolume}`);
    await this.compose.createVolume(candidateVolume);
    const env = await readNodeEnv(this.paths, node);
    const image = env.POSTGRES_IMAGE || "pgvector/pgvector:0.8.6-pg15";
    const container = `neuromem-stage-${runtimeKey(node.node_id)}-g${candidateGeneration}`;
    const envFile = nodeFile(this.paths, node.node_id, `.stage-${candidateGeneration}.env`);
    await atomicWrite(envFile, [
      `POSTGRES_DB=${escapeEnv(env.POSTGRES_DB || "neuromem")}`,
      `POSTGRES_USER=${escapeEnv(env.POSTGRES_USER || "neuromem")}`,
      `POSTGRES_PASSWORD=${escapeEnv(env.POSTGRES_PASSWORD || "")}`,
      "PGDATA=/var/lib/postgresql/data/pgdata",
      "",
    ].join("\n"));
    let actualRevision: string | undefined;
    try {
      await this.compose.runDocker([
        "run", "-d", "--name", container, "--env-file", envFile,
        "--mount", `type=volume,source=${candidateVolume},target=/var/lib/postgresql/data`, image,
      ], { timeoutMs: 5 * 60_000 });
      const deadline = Date.now() + 120_000;
      let ready = false;
      while (Date.now() < deadline) {
        const check = await this.compose.runDocker([
          "exec", container, "pg_isready", "-U", env.POSTGRES_USER || "neuromem", "-d", env.POSTGRES_DB || "neuromem",
        ], { allowFailure: true, timeoutMs: 10_000 });
        if (check.ok) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
      if (!ready) throw new Error("Candidate PostgreSQL did not become ready");
      await this.compose.runDocker([
        "exec", "-i", container, "pg_restore", "-U", env.POSTGRES_USER || "neuromem", "-d", env.POSTGRES_DB || "neuromem",
        "--no-owner", "--no-privileges",
      ], { inputFile: archive, timeoutMs: 60 * 60_000 });
      if (migrationTarget) {
        const coreEnv = nodeFile(this.paths, node.node_id, `.stage-core-${candidateGeneration}.env`);
        const databaseUrl = `postgresql+asyncpg://${encodeURIComponent(env.POSTGRES_USER || "neuromem")}:${encodeURIComponent(env.POSTGRES_PASSWORD || "")}@127.0.0.1:5432/${encodeURIComponent(env.POSTGRES_DB || "neuromem")}`;
        await atomicWrite(coreEnv, [
          `DATABASE_URL=${databaseUrl}`,
          `NEUROMEM_NODE_ID=${node.node_id}`,
          `NEUROMEM_API_TOKEN=${env.API_TOKEN || ""}`,
          "",
        ].join("\n"));
        try {
          const coreImage = env.NEUROMEM_CORE_IMAGE || "neuromem/core:0.1.0";
          await this.compose.runDocker([
            "run", "--rm", "--network", `container:${container}`, "--env-file", coreEnv,
            coreImage, "migrate", "--target", migrationTarget,
          ], { timeoutMs: 60 * 60_000 });
          const verification = await this.compose.runDocker([
            "run", "--rm", "--network", `container:${container}`, "--env-file", coreEnv,
            coreImage, "migrate", "--verify", "--target", migrationTarget,
          ], { timeoutMs: 60 * 60_000 });
          actualRevision = parseVerifiedRevision(verification.stdout, migrationTarget);
        } finally {
          await fs.rm(coreEnv, { force: true });
        }
      }
      await this.compose.runDocker([
        "exec", container, "psql", "-U", env.POSTGRES_USER || "neuromem", "-d", env.POSTGRES_DB || "neuromem",
        "-v", "ON_ERROR_STOP=1", "-Atc", "SELECT 1; SELECT extversion FROM pg_extension WHERE extname='vector';",
      ], { timeoutMs: 30_000 });
      const candidateManifest = await this.inspectCandidateDatabase(container, env);
      verifyCandidateManifest(expected, candidateManifest, verificationMode);
      if (actualRevision && candidateManifest.schema_revision !== actualRevision) {
        throw new Error(`Candidate schema verification mismatch: migrator reported ${actualRevision}, database reports ${candidateManifest.schema_revision}`);
      }
      await this.compose.runDocker([
        "exec", container, "psql", "-U", env.POSTGRES_USER || "neuromem", "-d", env.POSTGRES_DB || "neuromem",
        "-v", "ON_ERROR_STOP=1", "-Atc",
        "BEGIN; CREATE TEMP TABLE neuromem_restore_probe(id integer); INSERT INTO neuromem_restore_probe VALUES (1); SELECT count(*) FROM neuromem_restore_probe; ROLLBACK; SELECT array_fill(0.0::real, ARRAY[2560])::halfvec(2560) <=> array_fill(0.0::real, ARRAY[2560])::halfvec(2560);",
      ], { timeoutMs: 30_000 });
      return actualRevision;
    } catch (error) {
      // Candidate data is retained for inspection; the active generation is untouched.
      throw error;
    } finally {
      await this.compose.runDocker(["rm", "-f", container], { allowFailure: true, timeoutMs: 30_000 });
      await fs.rm(envFile, { force: true });
    }
  }

  private async inspectCandidateDatabase(container: string, env: Record<string, string>) {
    const { databaseManifestSql, parseDatabaseManifest } = await import("./compose.js");
    const result = await this.compose.runDocker([
      "exec", container, "psql", "-U", env.POSTGRES_USER || "neuromem", "-d", env.POSTGRES_DB || "neuromem",
      "-v", "ON_ERROR_STOP=1", "-qAtc", databaseManifestSql(),
    ], { timeoutMs: 5 * 60_000 });
    return parseDatabaseManifest(result.stdout);
  }

  private async nextUnusedGeneration(node: NodeRecord): Promise<number> {
    let generation = node.generation + 1;
    while (await this.compose.volumeExists(volumeName(node, generation))) generation += 1;
    return generation;
  }

  private async journalCutover(
    operation: OperationRecord,
    node: NodeRecord,
    toGeneration: number,
    toVolume: string,
    toSchema: string,
  ): Promise<OperationRecord> {
    const env = await readNodeEnv(this.paths, node);
    const source = await fs.readFile(nodeFile(this.paths, node.node_id, ".env"), "utf8");
    return this.store.updateOperation(operation, {
      phase: "cutover_prepared",
      result: {
        cutover: {
          from_generation: node.generation,
          from_volume: env.DB_VOLUME_NAME,
          from_schema: node.schema_revision,
          to_generation: toGeneration,
          to_volume: toVolume,
          to_schema: toSchema,
          env_sha256: crypto.createHash("sha256").update(source).digest("hex"),
        },
      },
    });
  }

  private async reconcileInterruptedCutovers(): Promise<void> {
    for (const node of await this.listNodes()) {
      const interrupted = (await this.store.operations(node.node_id)).reverse().find(operation => {
        const result = operation.result as { cutover?: unknown; recovery?: unknown } | undefined;
        return operation.state === "needs_attention"
          && operation.phase === "manager_restarted"
          && Boolean(result?.cutover)
          && !result?.recovery;
      });
      if (!interrupted) continue;
      const cutover = (interrupted.result as { cutover: {
        from_generation: number; from_volume: string; from_schema: string;
        to_generation: number; to_volume: string; to_schema: string; env_sha256: string;
      } }).cutover;
      if (!Number.isSafeInteger(cutover.from_generation) || !cutover.from_volume || !cutover.from_schema) continue;
      const envTarget = nodeFile(this.paths, node.node_id, ".env");
      try {
        await this.compose.stop(node).catch(() => undefined);
        const current = await fs.readFile(envTarget, "utf8");
        const rolledBackEnv = replaceEnv(current, "DB_VOLUME_NAME", cutover.from_volume);
        const restoredHash = crypto.createHash("sha256").update(rolledBackEnv).digest("hex");
        if (restoredHash !== cutover.env_sha256) throw new Error("Runtime environment changed after cutover preparation; automatic rollback refused");
        await atomicWrite(envTarget, rolledBackEnv);
        const rolledBack = await this.store.updateNode(node.node_id, value => {
          value.generation = cutover.from_generation;
          value.schema_revision = cutover.from_schema;
          value.phase = value.desired_state === "running" ? "starting" : "stopped";
        });
        if (rolledBack.desired_state === "running") {
          await this.compose.up(rolledBack);
          const status = await this.waitForReady(rolledBack.node_id);
          if (status.phase !== "ready" && status.phase !== "degraded") throw new Error(`Rolled-back Node is ${status.phase}`);
          await this.store.updateNode(rolledBack.node_id, value => { value.phase = status.phase; });
        }
        await this.store.updateOperation(interrupted, {
          state: "recovered",
          phase: "rolled_back_after_manager_restart",
          completed_at: new Date().toISOString(),
          result: {
            ...interrupted.result as object,
            recovery: {
              active_volume: cutover.from_volume,
              candidate_volume_preserved: cutover.to_volume,
              recovery_completed_at: new Date().toISOString(),
            },
          },
        });
      } catch {
        await this.store.updateNode(node.node_id, value => { value.phase = "failed"; });
      }
    }
  }

  private async cutover(
    node: NodeRecord,
    candidateVolume: string,
    candidateGeneration: number,
    schemaRevision: string,
  ): Promise<NodeStatus> {
    const envTarget = nodeFile(this.paths, node.node_id, ".env");
    const originalEnv = await fs.readFile(envTarget, "utf8");
    const candidateEnv = replaceEnv(originalEnv, "DB_VOLUME_NAME", candidateVolume);
    await this.compose.stop(node);
    try {
      await atomicWrite(envTarget, candidateEnv);
      await this.store.updateNode(node.node_id, value => {
        value.generation = candidateGeneration;
        value.schema_revision = schemaRevision;
        value.desired_state = "running";
        value.phase = "starting";
      });
      await this.compose.up(node);
      const status = await this.waitForReady(node.node_id);
      if (status.phase !== "ready" && status.phase !== "degraded") throw new Error("Candidate generation failed the post-cutover health check");
      await this.store.updateNode(node.node_id, value => { value.phase = status.phase; });
      return status;
    } catch (error) {
      await this.compose.stop(node).catch(() => undefined);
      await atomicWrite(envTarget, originalEnv);
      await this.store.updateNode(node.node_id, value => {
        value.generation = node.generation;
        value.schema_revision = node.schema_revision;
        value.desired_state = "running";
        value.phase = "starting";
      });
      await this.compose.up(node).catch(() => undefined);
      const rollback = await this.waitForReady(node.node_id).catch(() => null);
      await this.store.updateNode(node.node_id, value => { value.phase = rollback?.phase || "failed"; });
      throw error;
    }
  }
}

function endpointSet(node: NodeRecord): NodeStatus["endpoints"] {
  return {
    api: `http://127.0.0.1:${node.ports.api}`,
    dashboard: `http://127.0.0.1:${node.ports.dashboard}`,
    mcp: `http://127.0.0.1:${node.ports.mcp}/mcp`,
  };
}

async function allocatePorts(existing: NodeRecord[], alias: string, requested: Partial<NodeRecord["ports"]> = {}): Promise<NodeRecord["ports"]> {
  const defaults = ALIAS_PORTS[alias];
  if (!defaults && Object.keys(requested).length !== 3) {
    throw new Error("Non-standard Node aliases require explicit api, dashboard, and mcp ports");
  }
  const used = new Set(existing.flatMap(node => Object.values(node.ports)));
  const output = { ...(defaults || { api: 0, dashboard: 0, mcp: 0 }), ...requested };
  for (const key of Object.keys(output) as (keyof typeof output)[]) {
    const port = output[key];
    validatePort(port);
    if (used.has(port)) throw new Error(`Port ${port} is already assigned to another Node`);
    if (!(await portIsFree(port))) throw new Error(`Port ${port} is already in use; choose an explicit free port`);
    used.add(port);
  }
  return output;
}

function validatePort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error(`Invalid unprivileged port: ${port}`);
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

function isRunning(value: string): boolean {
  return /running|up/i.test(value);
}

function escapeEnv(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function redact(value: string): string {
  return value
    .replace(/(POSTGRES_PASSWORD|API_TOKEN|MCP_TOKEN|EMBEDDING_API_KEY|GENERATION_API_KEY|CORE_TOKEN|authorization)(\s*[=:]\s*)[^\s,}]+/gi, "$1$2[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/(postgres(?:ql)?(?:\+[a-z0-9]+)?:\/\/[^:\s/]+:)[^@\s]+(@)/gi, "$1[redacted]$2");
}

function volumeName(node: NodeRecord, generation: number): string {
  return `neuromem-${runtimeKey(node.node_id)}-pg-g${generation}`;
}

function runtimeKey(nodeId: string): string {
  return nodeId.replaceAll("-", "").toLowerCase();
}

async function directoryDigest(root: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const walk = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target).split(path.sep).join("/");
      if (entry.isSymbolicLink()) throw new Error(`Packaged image context contains a symbolic link: ${relative}`);
      hash.update(entry.isDirectory() ? `D\0${relative}\0` : `F\0${relative}\0`);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) hash.update(await fs.readFile(target));
      else throw new Error(`Unsupported packaged image context entry: ${relative}`);
    }
  };
  await walk(root);
  return hash.digest("hex");
}

function replaceEnv(source: string, key: string, value: string): string {
  const expression = new RegExp(`^${key}=.*$`, "m");
  if (!expression.test(source)) throw new Error(`Runtime environment is missing ${key}`);
  return source.replace(expression, `${key}=${escapeEnv(value)}`);
}

function replaceEnvValues(source: string, values: Record<string, string>): string {
  let next = source;
  for (const [key, value] of Object.entries(values)) next = replaceEnv(next, key, value);
  return next;
}

function modelEnvUpdates(configuration: ModelConfiguration): Record<string, string> {
  const mappings: Array<[keyof ModelConfiguration, string, "url" | "text"]> = [
    ["embedding_base_url", "EMBEDDING_BASE_URL", "url"],
    ["embedding_api_key", "EMBEDDING_API_KEY", "text"],
    ["embedding_model", "EMBEDDING_MODEL", "text"],
    ["generation_base_url", "GENERATION_BASE_URL", "url"],
    ["generation_api_key", "GENERATION_API_KEY", "text"],
    ["generation_model", "GENERATION_MODEL", "text"],
  ];
  const updates: Record<string, string> = {};
  for (const [input, output, kind] of mappings) {
    const value = configuration[input];
    if (value === undefined) continue;
    if (!value || /[\r\n\0]/.test(value)) throw new Error(`Invalid ${input}`);
    if (kind === "url") {
      let parsed: URL;
      try { parsed = new URL(value); } catch { throw new Error(`${input} must be an HTTP(S) URL`); }
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(`${input} must be an HTTP(S) URL without credentials`);
    }
    updates[output] = value;
  }
  return updates;
}

function parseVerifiedRevision(output: string, requested: string): string {
  const trimmed = output.trim();
  if (!trimmed) {
    if (requested === "head") throw new Error("Migration verification did not report the actual schema revision");
    return requested;
  }
  try {
    const value = JSON.parse(trimmed) as { current_revision?: string; revision?: string };
    const revision = value.current_revision || value.revision;
    if (revision && /^[A-Za-z0-9._-]{1,128}$/.test(revision)) return revision;
  } catch {}
  const match = trimmed.match(/(?:current_revision|revision)\s*[=:]\s*([A-Za-z0-9._-]+)/i)
    || trimmed.match(/schema\s+verified\s+at\s+([A-Za-z0-9._-]+)/i);
  if (match?.[1]) return match[1];
  if (/^[A-Za-z0-9._-]{1,128}$/.test(trimmed)) return trimmed;
  throw new Error("Migration verification returned an invalid schema revision");
}

function manifestStructureBlockers(manifest: BackupManifest): string[] {
  const blockers: string[] = [];
  const requiredTables = [
    "workspaces", "projects", "peers", "sessions", "session_peers", "records", "record_segments", "claims",
    "claim_sources", "claim_relations", "claim_edges", "embedding_profiles", "record_embeddings",
    "claim_embeddings", "jobs",
  ];
  if (!manifest.schema_revision || manifest.schema_revision === "missing") blockers.push("Backup has no schema revision");
  for (const table of requiredTables) {
    if (!Number.isSafeInteger(manifest.row_counts?.[table]) || manifest.row_counts[table]! < 0) blockers.push(`Backup has no valid row count for ${table}`);
  }
  if (!manifest.extensions?.vector) blockers.push("Backup has no pgvector extension version");
  if (!manifest.extensions?.pg_trgm) blockers.push("Backup has no pg_trgm extension version");
  for (const table of ["record_embeddings", "claim_embeddings"]) {
    const vector = manifest.vector_columns?.[table];
    if (vector?.type !== "halfvec(2560)" || vector.dimensions !== 2560) blockers.push(`${table} is not halfvec(2560)`);
  }
  return blockers;
}

function verifyCandidateManifest(expected: BackupManifest, actual: DatabaseManifest, mode: "exact" | "migration"): void {
  const sourceOfTruth = new Set([
    "workspaces", "projects", "peers", "sessions", "session_peers", "records", "record_segments",
    "claims", "claim_sources", "claim_relations", "claim_edges",
  ]);
  for (const [table, count] of Object.entries(expected.row_counts)) {
    const actualCount = actual.row_counts[table];
    if (mode === "exact" && actualCount !== count) {
      throw new Error(`Candidate row count mismatch for ${table}: expected ${count}, got ${actualCount}`);
    }
    if (mode === "migration" && sourceOfTruth.has(table) && (actualCount === undefined || actualCount < count)) {
      throw new Error(`Migration lost source rows in ${table}: expected at least ${count}, got ${actualCount}`);
    }
  }
  for (const extension of ["vector", "pg_trgm"]) {
    if (!actual.extensions[extension]) throw new Error(`Candidate is missing ${extension}`);
  }
  for (const table of ["record_embeddings", "claim_embeddings"]) {
    const vector = actual.vector_columns[table];
    if (vector?.type !== "halfvec(2560)" || vector.dimensions !== 2560) {
      throw new Error(`Candidate ${table} is not halfvec(2560)`);
    }
  }
}

function sameLogicalManifest(left: DatabaseManifest, right: DatabaseManifest): boolean {
  return left.schema_revision === right.schema_revision
    && stableStringify(left.row_counts) === stableStringify(right.row_counts)
    && stableStringify(left.extensions) === stableStringify(right.extensions)
    && stableStringify(left.vector_columns) === stableStringify(right.vector_columns);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
