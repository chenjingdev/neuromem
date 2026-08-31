import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalCodexProvider, type CodexProvider, type CodexSessionStatus } from "./codex-provider.js";
import { ComposeController, readNodeEnv } from "./compose.js";
import { assertUuid, assertUuid7, atomicWrite, ensurePrivateDirectory, exists, readJson, safeLabel, sha256File } from "./fs-safe.js";
import { nodeDirectory, nodeFile, type ManagerPaths } from "./paths.js";
import { StateStore } from "./state.js";
import { readManagerRuntimeConfig } from "./runtime-config.js";
import type {
  BackupManifest, CommandRunner, DatabaseManifest, MigrationPlan, NodePhase, NodeRecord, NodeStatus,
  NodeModelStatus, ModelProviderState, OperationKind, OperationRecord, RestorePlan,
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
  codex?: CodexProvider;
  codexBinary?: string;
}

export type GenerationSource = "codex_session" | "openai_compatible";

export interface ModelConfiguration {
  embedding_base_url?: string;
  embedding_api_key?: string;
  embedding_model?: string;
  embedding_send_dimensions?: boolean;
  generation_base_url?: string;
  generation_api_key?: string;
  generation_model?: string;
  generation_source?: GenerationSource;
  generation_direct_base_url?: string;
  generation_direct_api_key?: string;
  generation_direct_model?: string;
}

export interface ModelSelectionInput {
  embedding_model?: string;
  generation_model?: string;
  generation?: GenerationSelectionInput;
}

export interface GenerationConnectionInput {
  base_url: string;
  api_key_action: "keep" | "replace" | "clear";
  api_key?: string;
}

export interface GenerationSelectionInput {
  source: GenerationSource;
  model: string;
  connection?: GenerationConnectionInput;
}

export interface GenerationProbeInput {
  source: GenerationSource;
  model?: string;
  connection?: GenerationConnectionInput;
}

export interface ModelSelectionOption {
  model: string | null;
  available_models: string[];
  diagnostic: string | null;
}

export interface ModelSelectionSnapshot {
  node_id: string;
  embedding: ModelSelectionOption;
  generation: ModelSelectionOption & {
    active_source: GenerationSource | null;
    sources: {
      codex_session: CodexSessionStatus;
      openai_compatible: {
        configured: boolean;
        connection_origin: "generation" | "embedding_fallback" | null;
        display_base_url: string | null;
        api_key_configured: boolean;
        model: string | null;
        available_models: string[];
        diagnostic: string | null;
        last_checked_at: string;
      };
    };
  };
}

interface ModelProvider {
  base_url: string;
  api_key: string;
}

interface ModelCatalog {
  models: string[];
  diagnostic: string | null;
}

interface ModelCompatibilityChecks {
  embedding?: { provider: ModelProvider; model: string };
  generation?: { source: GenerationSource; provider?: ModelProvider; model: string };
}

class EmbeddingProbeError extends Error {}
class GenerationProbeError extends Error {}

const ALIAS_PORTS: Record<string, NodeRecord["ports"]> = {
  personal: { api: 18001, dashboard: 14173, mcp: 18765 },
  company: { api: 28001, dashboard: 24173, mcp: 28765 },
};

interface CoreModelHealth {
  embedding_configured?: boolean;
  extraction_configured?: boolean;
  embedding_provider_status?: string;
  extraction_provider_status?: string;
  embedding_provider_detail?: unknown;
  extraction_provider_detail?: unknown;
  embedding_last_probe_at?: unknown;
  extraction_last_probe_at?: unknown;
}

export class NodeManager {
  readonly store: StateStore;
  readonly compose: ComposeController;
  readonly paths: ManagerPaths;
  readonly managerPort: number;
  private readonly fetcher: typeof fetch;
  private readonly startTimeoutMs: number;
  private readonly imageContextRoot: string;
  private readonly codex: CodexProvider;

  constructor(options: NodeManagerOptions) {
    this.paths = options.paths;
    this.store = new StateStore(options.paths);
    this.compose = new ComposeController(options.paths, options.runner);
    this.fetcher = options.fetch || fetch;
    this.startTimeoutMs = options.startTimeoutMs ?? 180_000;
    this.managerPort = options.managerPort ?? Number(process.env.NEUROMEM_MANAGER_PORT || 14174);
    this.imageContextRoot = path.resolve(options.imageContextRoot || process.env.NEUROMEM_IMAGE_CONTEXT_ROOT || fileURLToPath(new URL("../../assets/images", import.meta.url)));
    this.codex = options.codex || new LocalCodexProvider({ paths: options.paths, binary: options.codexBinary });
  }

  async close(): Promise<void> {
    await this.codex.close();
  }

  async initialize(recoverInterrupted = false): Promise<void> {
    await this.store.initialize();
    if (recoverInterrupted) {
      await this.store.recoverInterruptedOperations();
      await this.reconcileInterruptedModelConfigurations();
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
      const models = await this.configuredModels(node).catch(() => undefined);
      return {
        node: synchronized,
        docker_available: false,
        phase,
        components: [],
        endpoints,
        ...(models ? { models } : {}),
        error: "Docker engine is unavailable",
      };
    }
    const components = await this.compose.ps(node);
    if (node.desired_state === "stopped" && components.every(component => !isRunning(component.state))) {
      const synchronized = node.phase === "stopped" ? node : await this.store.updateNode(node.node_id, value => { value.phase = "stopped"; });
      const models = await this.configuredModels(node).catch(() => undefined);
      return { node: synchronized, docker_available: true, phase: "stopped", components, endpoints, ...(models ? { models } : {}) };
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
    return {
      node: synchronized,
      docker_available: true,
      phase,
      components,
      endpoints,
      ...(readiness.models ? { models: readiness.models } : {}),
    };
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
      const latest = await this.store.findNode(node.node_id);
      return this.configureModelsLocked(latest, configuration, updates);
    });
  }

  async modelSelection(selector: string): Promise<ModelSelectionSnapshot> {
    const node = await this.store.findNode(selector);
    const env = await readNodeEnv(this.paths, node);
    return { node_id: node.node_id, ...(await this.discoverModelSelection(node, env)).snapshot };
  }

  async generationProbe(selector: string, input: unknown): Promise<Record<string, unknown>> {
    const probe = validateGenerationProbeInput(input);
    const node = await this.store.findNode(selector);
    const env = await readNodeEnv(this.paths, node);
    if (probe.source === "codex_session") {
      const status = await this.codex.sessionStatus();
      if (status.auth_status !== "signed_in") throw new Error("Codex is not signed in with ChatGPT");
      if (probe.model && !status.available_models.includes(probe.model)) throw new Error("Selected Codex model is unavailable");
      if (probe.model) await this.probeCodexCompatibility(probe.model);
      return {
        source: probe.source,
        available_models: status.available_models,
        model_compatible: Boolean(probe.model),
        diagnostic: null,
        codex: status,
      };
    }
    const resolved = directGenerationProvider(node, env, probe.connection);
    const catalog = await this.discoverProviderModels(resolved.provider);
    const available = roleCatalog(catalog, "generation");
    if (probe.model) await this.probeGenerationCompatibility(resolved.provider, probe.model);
    return {
      source: probe.source,
      available_models: available.available_models,
      model_compatible: Boolean(probe.model),
      diagnostic: available.diagnostic,
      display_base_url: displayProviderUrl(resolved.provider.base_url),
      api_key_configured: Boolean(resolved.provider.api_key),
    };
  }

  async selectModels(selector: string, input: unknown): Promise<OperationRecord> {
    const selection = validateModelSelectionInput(input);
    const node = await this.store.findNode(selector);
    return this.store.withNodeLock(node.node_id, async () => {
      const latest = await this.store.findNode(node.node_id);
      const env = await readNodeEnv(this.paths, latest);
      const discovered = await this.discoverModelSelection(latest, env);
      const configuration: ModelConfiguration = {};
      const compatibility: ModelCompatibilityChecks = {};

      if (selection.embedding_model !== undefined && selection.embedding_model !== env.EMBEDDING_MODEL) {
        if (!discovered.snapshot.embedding.available_models.includes(selection.embedding_model)) {
          throw new Error("Selected embedding model is not available from the configured provider");
        }
        if (!discovered.embedding_provider) throw new Error("Embedding model provider is not configured");
        compatibility.embedding = { provider: discovered.embedding_provider, model: selection.embedding_model };
        configuration.embedding_model = selection.embedding_model;
        // Neuromem stores fixed 2560-dimensional vectors. OpenAI-compatible
        // providers such as Ollama can project larger embedding models when the
        // dimensions request field is sent.
        configuration.embedding_send_dimensions = true;
        if (!env.EMBEDDING_BASE_URL) {
          configuration.embedding_base_url = discovered.embedding_provider.base_url;
          configuration.embedding_api_key = discovered.embedding_provider.api_key;
        }
      }

      if (selection.generation) {
        const requested = selection.generation;
        if (requested.source === "codex_session") {
          const status = discovered.snapshot.generation.sources.codex_session;
          if (status.auth_status !== "signed_in") throw new Error("Codex is not signed in with ChatGPT");
          if (!status.available_models.includes(requested.model)) throw new Error("Selected Codex model is unavailable");
          preserveDirectGenerationConfiguration(configuration, latest, env);
          configuration.generation_source = "codex_session";
          configuration.generation_base_url = codexBridgeBaseUrl(this.managerPort, latest.node_id);
          configuration.generation_api_key = env.API_TOKEN || "";
          configuration.generation_model = requested.model;
          compatibility.generation = { source: "codex_session", model: requested.model };
        } else {
          const resolved = directGenerationProvider(latest, env, requested.connection);
          const catalog = await this.discoverProviderModels(resolved.provider);
          const available = roleCatalog(catalog, "generation").available_models;
          if (available.length && !available.includes(requested.model)) {
            throw new Error("Selected generation model is not available from the configured provider");
          }
          configuration.generation_source = "openai_compatible";
          configuration.generation_base_url = resolved.provider.base_url;
          configuration.generation_api_key = resolved.provider.api_key;
          configuration.generation_model = requested.model;
          configuration.generation_direct_base_url = resolved.provider.base_url;
          configuration.generation_direct_api_key = resolved.provider.api_key;
          configuration.generation_direct_model = requested.model;
          compatibility.generation = { source: "openai_compatible", provider: resolved.provider, model: requested.model };
        }
      } else if (selection.generation_model !== undefined && selection.generation_model !== env.GENERATION_MODEL) {
        if (!discovered.snapshot.generation.available_models.includes(selection.generation_model)) {
          throw new Error("Selected generation model is not available from the configured provider");
        }
        if (!discovered.generation_provider) throw new Error("Generation model provider is not configured");
        compatibility.generation = {
          source: generationSource(latest, env) || "openai_compatible",
          provider: discovered.generation_provider,
          model: selection.generation_model,
        };
        configuration.generation_model = selection.generation_model;
        if (!env.GENERATION_BASE_URL) {
          configuration.generation_base_url = discovered.generation_provider.base_url;
          configuration.generation_api_key = discovered.generation_provider.api_key;
        }
      }

      const updates = modelEnvUpdates(configuration);
      if (!Object.keys(updates).length) throw new Error("At least one model selection must change");
      return this.configureModelsLocked(latest, configuration, updates, compatibility);
    });
  }

  async codexBridgeModels(selector: string, authorization: string | undefined): Promise<Record<string, unknown>> {
    const { node, env } = await this.authorizeCodexBridge(selector, authorization);
    if (generationSource(node, env) !== "codex_session") throw new Error("Codex generation is not active for this Node");
    const status = await this.codex.sessionStatus();
    if (status.auth_status !== "signed_in") throw new Error("Codex is not signed in with ChatGPT");
    return { object: "list", data: status.available_models.map(id => ({ id, object: "model", owned_by: "codex" })) };
  }

  async codexChatCompletion(selector: string, authorization: string | undefined, input: unknown): Promise<Record<string, unknown>> {
    const { node, env } = await this.authorizeCodexBridge(selector, authorization);
    if (generationSource(node, env) !== "codex_session") throw new Error("Codex generation is not active for this Node");
    const request = validateCodexChatCompletion(input);
    if (request.model !== env.GENERATION_MODEL) throw new Error("Requested model does not match the configured Codex model");
    const content = await this.codex.generateJson({
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
        EMBEDDING_SEND_DIMENSIONS: runtime.EMBEDDING_SEND_DIMENSIONS || process.env.EMBEDDING_SEND_DIMENSIONS || "false",
        GENERATION_BASE_URL: runtime.GENERATION_BASE_URL || process.env.GENERATION_BASE_URL || "",
        GENERATION_API_KEY: runtime.GENERATION_API_KEY || process.env.GENERATION_API_KEY || "",
        GENERATION_MODEL: runtime.GENERATION_MODEL || process.env.GENERATION_MODEL || "",
        GENERATION_SOURCE: runtime.GENERATION_BASE_URL || process.env.GENERATION_BASE_URL ? "openai_compatible" : "",
        GENERATION_DIRECT_BASE_URL: runtime.GENERATION_BASE_URL || process.env.GENERATION_BASE_URL || "",
        GENERATION_DIRECT_API_KEY: runtime.GENERATION_API_KEY || process.env.GENERATION_API_KEY || "",
        GENERATION_DIRECT_MODEL: runtime.GENERATION_MODEL || process.env.GENERATION_MODEL || "",
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

  private async configuredModels(node: NodeRecord): Promise<NodeModelStatus> {
    return modelStatusFrom(await readNodeEnv(this.paths, node));
  }

  private async configureModelsLocked(
    node: NodeRecord,
    configuration: ModelConfiguration,
    updates: Record<string, string>,
    compatibility: ModelCompatibilityChecks = {},
  ): Promise<OperationRecord> {
    let operation = await this.store.beginOperation(node.node_id, "models_configure", "updating_runtime");
    const target = nodeFile(this.paths, node.node_id, ".env");
    const original = await fs.readFile(target, "utf8");
    const env = await readNodeEnv(this.paths, node);
    const embeddingChanged = configuration.embedding_model !== undefined && configuration.embedding_model !== env.EMBEDDING_MODEL;
    const composeTarget = nodeFile(this.paths, node.node_id, "compose.yaml");
    const originalCompose = Object.hasOwn(updates, "EMBEDDING_SEND_DIMENSIONS")
      ? await fs.readFile(composeTarget, "utf8")
      : null;
    try {
      if (embeddingChanged) {
        if (node.desired_state !== "running") {
          throw new Error("Changing the embedding model on a stopped Node is blocked because existing model-bound data cannot be verified");
        }
        operation = await this.store.updateOperation(operation, { phase: "quiescing_model_writers" });
        await this.compose.stopWriters(node);
        operation = await this.store.updateOperation(operation, { phase: "verifying_empty_node" });
        let manifest: DatabaseManifest;
        try {
          manifest = await this.compose.databaseManifest(node);
        } catch {
          throw new Error("Changing the embedding model is blocked because existing model-bound data could not be verified");
        }
        const modelBoundRows = ["records", "claims", "jobs", "embedding_profiles", "record_embeddings", "claim_embeddings"]
          .reduce((sum, table) => sum + Number(manifest.row_counts[table] || 0), 0);
        if (modelBoundRows > 0) {
          throw new Error("Changing the embedding model requires an empty Node until a re-embedding migration is supported");
        }
      }
      if (compatibility.embedding) {
        operation = await this.store.updateOperation(operation, { phase: "probing_embedding_model" });
        await this.probeEmbeddingCompatibility(compatibility.embedding.provider, compatibility.embedding.model);
      }
      if (compatibility.generation) {
        operation = await this.store.updateOperation(operation, { phase: "probing_generation_model" });
        if (compatibility.generation.source === "codex_session") {
          await this.probeCodexCompatibility(compatibility.generation.model);
        } else {
          if (!compatibility.generation.provider) throw new Error("Generation model provider is not configured");
          await this.probeGenerationCompatibility(compatibility.generation.provider, compatibility.generation.model);
        }
      }
      if (originalCompose !== null) await atomicWrite(composeTarget, ensureEmbeddingDimensionsCompose(originalCompose));
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
      let rollbackFailed = false;
      try {
        await atomicWrite(target, original);
        if (originalCompose !== null) await atomicWrite(composeTarget, originalCompose);
      } catch {
        rollbackFailed = true;
      }
      if (node.desired_state === "running") {
        try {
          await this.compose.stop(node);
          await this.compose.up(node);
          const recovered = await this.waitForReady(node.node_id);
          if (recovered.phase !== "ready" && recovered.phase !== "degraded") throw new Error("rollback recovery did not become operational");
          await this.store.updateNode(node.node_id, value => { value.phase = recovered.phase; });
        } catch {
          rollbackFailed = true;
        }
      }
      if (rollbackFailed) {
        await this.store.updateNode(node.node_id, value => { value.phase = "failed"; }).catch(() => undefined);
        const message = (error as Error).message || String(error);
        return this.failOperation(operation, new Error(`${message}; rollback recovery failed`));
      }
      return this.failOperation(operation, error);
    }
  }

  private async probeEmbeddingCompatibility(provider: ModelProvider, model: string): Promise<void> {
    let target: URL;
    try {
      target = providerEndpoint(provider.base_url, "embeddings");
    } catch {
      throw new Error("Configured embedding provider URL is invalid");
    }
    try {
      const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
      if (provider.api_key) headers.authorization = `Bearer ${provider.api_key}`;
      const response = await this.fetcher(target, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, input: ["Neuromem compatibility probe"], dimensions: 2560, encoding_format: "float" }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new EmbeddingProbeError(`Selected embedding model failed the 2560-dimension compatibility probe (HTTP ${response.status})`);
      const payload = await response.json().catch(() => null) as { data?: Array<{ embedding?: unknown }> } | null;
      const embedding = payload?.data?.[0]?.embedding;
      if (!Array.isArray(embedding)) throw new EmbeddingProbeError("Selected embedding model returned an invalid compatibility probe response");
      if (embedding.length !== 2560) {
        throw new EmbeddingProbeError(`Selected embedding model returned ${embedding.length} dimensions; Neuromem requires 2560`);
      }
      if (!embedding.every(value => typeof value === "number" && Number.isFinite(value))) {
        throw new EmbeddingProbeError("Selected embedding model returned invalid vector values during the compatibility probe");
      }
      const norm = Math.sqrt(embedding.reduce((sum: number, value) => sum + (value as number) * (value as number), 0));
      if (!Number.isFinite(norm) || norm === 0) {
        throw new EmbeddingProbeError("Selected embedding model returned an invalid vector norm during the compatibility probe");
      }
    } catch (error) {
      if (error instanceof EmbeddingProbeError) throw error;
      throw new Error("Could not complete the selected embedding model compatibility probe");
    }
  }

  private async probeGenerationCompatibility(provider: ModelProvider, model: string): Promise<void> {
    let target: URL;
    try {
      target = providerEndpoint(provider.base_url, "chat/completions");
    } catch {
      throw new Error("Configured generation provider URL is invalid");
    }
    try {
      const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
      if (provider.api_key) headers.authorization = `Bearer ${provider.api_key}`;
      const response = await this.fetcher(target, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Return one JSON object with an ok field." }],
          response_format: { type: "json_object" },
          temperature: 0,
          max_tokens: 32,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new GenerationProbeError(`Selected generation model failed the JSON chat compatibility probe (HTTP ${response.status})`);
      const payload = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: unknown } }> } | null;
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new GenerationProbeError("Selected generation model returned an invalid chat compatibility response");
      const parsed = JSON.parse(content) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new GenerationProbeError("Selected generation model did not return a JSON object");
      }
    } catch (error) {
      if (error instanceof GenerationProbeError) throw error;
      throw new Error("Could not complete the selected generation model compatibility probe");
    }
  }

  private async probeCodexCompatibility(model: string): Promise<void> {
    const status = await this.codex.sessionStatus();
    if (status.auth_status !== "signed_in") throw new Error("Codex is not signed in with ChatGPT");
    if (!status.available_models.includes(model)) throw new Error("Selected Codex model is unavailable");
    const content = await this.codex.generateJson({
      model,
      messages: [{ role: "user", content: "Return one JSON object whose ok field is true. Do not use tools." }],
      output_schema: {
        type: "object",
        properties: { ok: { type: "boolean", const: true } },
        required: ["ok"],
        additionalProperties: false,
      },
    });
    const parsed = JSON.parse(content) as { ok?: unknown };
    if (parsed.ok !== true) throw new Error("Selected Codex model failed the JSON compatibility probe");
  }

  private async authorizeCodexBridge(
    selector: string,
    authorization: string | undefined,
  ): Promise<{ node: NodeRecord; env: Record<string, string> }> {
    const node = await this.store.findNode(selector);
    const env = await readNodeEnv(this.paths, node);
    const provided = String(authorization || "").match(/^Bearer\s+(.+)$/i)?.[1] || "";
    const expected = env.API_TOKEN || "";
    const left = Buffer.from(provided);
    const right = Buffer.from(expected);
    if (!provided || !expected || left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
      throw new Error("Invalid Node bridge authorization");
    }
    return { node, env };
  }

  private async discoverModelSelection(node: NodeRecord, env: Record<string, string>): Promise<{
    snapshot: Omit<ModelSelectionSnapshot, "node_id">;
    embedding_provider: ModelProvider | null;
    generation_provider: ModelProvider | null;
  }> {
    const activeSource = generationSource(node, env);
    const configuredEmbedding = modelProvider(env.EMBEDDING_BASE_URL, env.EMBEDDING_API_KEY);
    const direct = savedDirectGenerationProvider(node, env);
    const embeddingProvider = configuredEmbedding || (activeSource === "openai_compatible" ? direct.provider : null);
    const generationProvider = activeSource === "codex_session"
      ? modelProvider(codexBridgeBaseUrl(this.managerPort, node.node_id), env.API_TOKEN)
      : direct.provider;
    const catalogs = new Map<string, Promise<ModelCatalog>>();
    const discover = (provider: ModelProvider | null): Promise<ModelCatalog> => {
      if (!provider) return Promise.resolve({ models: [], diagnostic: "Model provider is not configured" });
      const key = `${provider.base_url}\0${provider.api_key}`;
      const existing = catalogs.get(key);
      if (existing) return existing;
      const pending = this.discoverProviderModels(provider);
      catalogs.set(key, pending);
      return pending;
    };
    const [embeddingCatalog, directGenerationCatalog, codexStatus] = await Promise.all([
      discover(embeddingProvider),
      discover(direct.provider),
      this.codex.sessionStatus(),
    ]);
    const secrets = providerSensitiveValues(env);
    const directSelection = roleCatalog(directGenerationCatalog, "generation");
    const activeGeneration = activeSource === "codex_session"
      ? {
          available_models: codexStatus.available_models,
          diagnostic: codexStatus.auth_status === "signed_in" ? null : codexStatus.diagnostic,
        }
      : directSelection;
    return {
      snapshot: {
        embedding: {
          model: safeModelName(env.EMBEDDING_MODEL, secrets) || null,
          ...roleCatalog(embeddingCatalog, "embedding"),
        },
        generation: {
          model: safeModelName(env.GENERATION_MODEL, secrets) || null,
          ...activeGeneration,
          active_source: activeSource,
          sources: {
            codex_session: codexStatus,
            openai_compatible: {
              configured: Boolean(direct.provider),
              connection_origin: direct.origin,
              display_base_url: direct.provider ? displayProviderUrl(direct.provider.base_url) : null,
              api_key_configured: Boolean(direct.provider?.api_key),
              model: safeModelName(direct.model || undefined, secrets) || null,
              available_models: directSelection.available_models,
              diagnostic: directSelection.diagnostic,
              last_checked_at: new Date().toISOString(),
            },
          },
        },
      },
      embedding_provider: embeddingProvider,
      generation_provider: generationProvider,
    };
  }

  private async discoverProviderModels(provider: ModelProvider): Promise<ModelCatalog> {
    let target: URL;
    try {
      target = providerEndpoint(provider.base_url, "models");
    } catch {
      return { models: [], diagnostic: "Configured model provider URL is invalid" };
    }
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (provider.api_key) headers.authorization = `Bearer ${provider.api_key}`;
      const response = await this.fetcher(target, { headers, signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return { models: [], diagnostic: `Model provider returned HTTP ${response.status}` };
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > 1024 * 1024) return { models: [], diagnostic: "Model provider returned an oversized model catalog" };
      const payload = await response.json().catch(() => null) as { data?: unknown } | null;
      if (!payload || !Array.isArray(payload.data)) {
        return { models: [], diagnostic: "Model provider returned an invalid model catalog" };
      }
      if (payload.data.length > 1_000) return { models: [], diagnostic: "Model provider returned an oversized model catalog" };
      const models = new Set<string>();
      let totalIdLength = 0;
      for (const entry of payload.data) {
        if (!entry || typeof entry !== "object" || !("id" in entry)) continue;
        const id = (entry as { id?: unknown }).id;
        if (typeof id !== "string") continue;
        totalIdLength += id.length;
        if (totalIdLength > 64 * 1024) return { models: [], diagnostic: "Model provider returned an oversized model catalog" };
        if (validModelName(id) && !modelNameLeaksProvider(id, provider)) models.add(id);
      }
      return { models: [...models].sort((left, right) => left.localeCompare(right)), diagnostic: null };
    } catch {
      return { models: [], diagnostic: "Could not reach the configured model provider" };
    }
  }

  private async probeReady(
    url: string,
    node: NodeRecord,
  ): Promise<{ operational: boolean; fully_ready: boolean; models?: NodeModelStatus }> {
    let env: Record<string, string> | undefined;
    try {
      env = await readNodeEnv(this.paths, node);
      const response = await this.fetcher(url, {
        headers: { authorization: `Bearer ${env.API_TOKEN || ""}` },
        signal: AbortSignal.timeout(3_000),
      });
      const payload = await response.json().catch(() => ({})) as {
        status?: string; database?: boolean; embedding_configured?: boolean; extraction_configured?: boolean;
        embedding_provider_status?: string; extraction_provider_status?: string;
        embedding_provider_detail?: unknown; extraction_provider_detail?: unknown;
        embedding_last_probe_at?: unknown; extraction_last_probe_at?: unknown;
      };
      const operational = response.ok && payload.database !== false;
      const fullyReady = operational
        && payload.status !== "degraded"
        && payload.embedding_configured !== false
        && payload.extraction_configured !== false
        && (payload.embedding_provider_status === undefined || ["ready", "configured"].includes(payload.embedding_provider_status))
        && (payload.extraction_provider_status === undefined || ["ready", "configured"].includes(payload.extraction_provider_status));
      return { operational, fully_ready: fullyReady, models: modelStatusFrom(env, payload) };
    } catch {
      return {
        operational: false,
        fully_ready: false,
        ...(env ? { models: modelStatusFrom(env) } : {}),
      };
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

  private async reconcileInterruptedModelConfigurations(): Promise<void> {
    const retryablePhases = new Set(["manager_restarted", "model_recovery_restarting", "model_recovery_failed"]);
    for (const node of await this.listNodes()) {
      const interrupted = (await this.store.operations(node.node_id)).reverse().find(operation => (
        operation.kind === "models_configure"
        && operation.state === "needs_attention"
        && retryablePhases.has(operation.phase)
      ));
      if (!interrupted) continue;
      await this.store.withNodeLock(node.node_id, async () => {
        const latest = await this.store.findNode(node.node_id);
        let recovering = await this.store.updateOperation(interrupted, {
          state: "needs_attention",
          phase: "model_recovery_restarting",
          completed_at: undefined,
          error: "The Node Manager is synchronizing the runtime with the saved model configuration",
        });
        try {
          await readNodeEnv(this.paths, latest);
          if (latest.desired_state === "stopped") {
            await this.store.updateNode(latest.node_id, value => { value.phase = "stopped"; });
            await this.store.updateOperation(recovering, {
              state: "recovered",
              phase: "model_configuration_saved_for_next_start",
              completed_at: new Date().toISOString(),
              error: undefined,
              result: modelRecoveryResult(recovering.result, false),
            });
            return;
          }
          await this.compose.stop(latest);
          await this.compose.up(latest);
          const status = await this.waitForReady(latest.node_id);
          if (status.phase !== "ready" && status.phase !== "degraded") {
            throw new Error("Recovered model runtime did not become operational");
          }
          await this.store.updateNode(latest.node_id, value => { value.phase = status.phase; });
          recovering = await this.store.updateOperation(recovering, {
            state: "recovered",
            phase: "model_runtime_synced_after_manager_restart",
            completed_at: new Date().toISOString(),
            error: undefined,
            result: modelRecoveryResult(recovering.result, true),
          });
        } catch {
          await this.store.updateNode(latest.node_id, value => { value.phase = "failed"; }).catch(() => undefined);
          await this.store.updateOperation(recovering, {
            state: "needs_attention",
            phase: "model_recovery_failed",
            completed_at: new Date().toISOString(),
            error: "Model configuration recovery failed; restart the Node Manager to retry",
          });
        }
      });
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

function modelStatusFrom(env: Record<string, string>, payload: CoreModelHealth = {}): NodeModelStatus {
  const secrets = providerSensitiveValues(env);
  const embeddingConfigured = typeof payload.embedding_configured === "boolean"
    ? payload.embedding_configured
    : Boolean(env.EMBEDDING_BASE_URL && env.EMBEDDING_MODEL);
  const extractionConfigured = typeof payload.extraction_configured === "boolean"
    ? payload.extraction_configured
    : Boolean(env.GENERATION_BASE_URL && env.GENERATION_MODEL);
  const embeddingModel = safeModelName(env.EMBEDDING_MODEL, secrets);
  const extractionModel = safeModelName(env.GENERATION_MODEL, secrets);
  return {
    embedding: {
      configured: embeddingConfigured,
      ...(embeddingModel ? { model: embeddingModel } : {}),
      provider_status: modelProviderState(payload.embedding_provider_status, embeddingConfigured),
      provider_detail: providerDetail(payload.embedding_provider_detail, secrets),
      last_probe_at: probeTimestamp(payload.embedding_last_probe_at),
    },
    extraction: {
      configured: extractionConfigured,
      ...(extractionModel ? { model: extractionModel } : {}),
      provider_status: modelProviderState(payload.extraction_provider_status, extractionConfigured),
      provider_detail: providerDetail(payload.extraction_provider_detail, secrets),
      last_probe_at: probeTimestamp(payload.extraction_last_probe_at),
    },
  };
}

function modelProviderState(value: string | undefined, configured: boolean): ModelProviderState {
  if (["unconfigured", "configured", "unknown", "ready", "error"].includes(value || "")) {
    return value as ModelProviderState;
  }
  return configured ? "configured" : "unconfigured";
}

function providerDetail(value: unknown, secrets: string[]): string | null {
  if (typeof value !== "string" || !value) return null;
  let sanitized = redact(value);
  for (const secret of secrets) sanitized = sanitized.replaceAll(secret, "[redacted]");
  return sanitized.slice(0, 500);
}

function probeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 128 || /[\r\n\0]/.test(value)) return null;
  return value;
}

function safeModelName(value: string | undefined, secrets: string[]): string | undefined {
  const model = value?.trim();
  if (!model || model.length > 512 || /[\r\n\0]/.test(model) || /^https?:\/\//i.test(model)) return undefined;
  if (secrets.some(secret => sharesSensitiveFragment(model, secret))) return undefined;
  return model;
}

function providerSensitiveValues(env: Record<string, string>): string[] {
  const values = [
    env.API_TOKEN, env.EMBEDDING_API_KEY, env.GENERATION_API_KEY, env.GENERATION_DIRECT_API_KEY,
    env.EMBEDDING_BASE_URL, env.GENERATION_BASE_URL, env.GENERATION_DIRECT_BASE_URL,
  ]
    .filter((value): value is string => Boolean(value));
  for (const baseUrl of [env.EMBEDDING_BASE_URL, env.GENERATION_BASE_URL, env.GENERATION_DIRECT_BASE_URL]) {
    if (!baseUrl) continue;
    try {
      const parsed = new URL(baseUrl);
      values.push(parsed.hostname);
      if (parsed.hostname.toLowerCase() === "host.docker.internal") values.push("127.0.0.1");
    } catch {}
  }
  return [...new Set(values)];
}

function redact(value: string): string {
  return value
    .replace(/(POSTGRES_PASSWORD|API_TOKEN|MCP_TOKEN|EMBEDDING_API_KEY|GENERATION_API_KEY|GENERATION_DIRECT_API_KEY|CORE_TOKEN|authorization)(\s*[=:]\s*)[^\s,}]+/gi, "$1$2[redacted]")
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

function ensureEmbeddingDimensionsCompose(source: string): string {
  if (/^\s+NEUROMEM_EMBEDDING_SEND_DIMENSIONS:/m.test(source)) return source;
  const marker = /^(\s+)NEUROMEM_EMBEDDING_DIMENSIONS:.*$/m;
  if (!marker.test(source)) throw new Error("Runtime Compose is missing the embedding dimensions setting");
  return source.replace(marker, line => `${line}\n${line.match(/^\s+/)?.[0] || "    "}NEUROMEM_EMBEDDING_SEND_DIMENSIONS: \${EMBEDDING_SEND_DIMENSIONS:-false}`);
}

function replaceEnvValues(source: string, values: Record<string, string>): string {
  let next = source;
  for (const [key, value] of Object.entries(values)) {
    if (!new RegExp(`^${key}=.*$`, "m").test(next)) {
      next = `${next}${next.endsWith("\n") ? "" : "\n"}${key}=${escapeEnv(value)}\n`;
      continue;
    }
    next = replaceEnv(next, key, value);
  }
  return next;
}

function modelEnvUpdates(configuration: ModelConfiguration): Record<string, string> {
  const mappings: Array<[keyof ModelConfiguration, string, "url" | "text", boolean?]> = [
    ["embedding_base_url", "EMBEDDING_BASE_URL", "url"],
    ["embedding_api_key", "EMBEDDING_API_KEY", "text", true],
    ["embedding_model", "EMBEDDING_MODEL", "text"],
    ["generation_base_url", "GENERATION_BASE_URL", "url"],
    ["generation_api_key", "GENERATION_API_KEY", "text", true],
    ["generation_model", "GENERATION_MODEL", "text"],
    ["generation_direct_base_url", "GENERATION_DIRECT_BASE_URL", "url"],
    ["generation_direct_api_key", "GENERATION_DIRECT_API_KEY", "text", true],
    ["generation_direct_model", "GENERATION_DIRECT_MODEL", "text"],
  ];
  const updates: Record<string, string> = {};
  for (const [input, output, kind, allowEmpty] of mappings) {
    const value = configuration[input];
    if (value === undefined) continue;
    if (typeof value !== "string" || (!allowEmpty && !value) || /[\r\n\0]/.test(value)) throw new Error(`Invalid ${input}`);
    if (kind === "url") {
      validatedProviderBaseUrl(value, String(input));
    }
    updates[output] = value;
  }
  if (configuration.embedding_send_dimensions !== undefined) {
    if (typeof configuration.embedding_send_dimensions !== "boolean") throw new Error("Invalid embedding_send_dimensions");
    updates.EMBEDDING_SEND_DIMENSIONS = String(configuration.embedding_send_dimensions);
  }
  if (configuration.generation_source !== undefined) updates.GENERATION_SOURCE = configuration.generation_source;
  return updates;
}

function validateModelSelectionInput(value: unknown): ModelSelectionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Model selection must be a JSON object");
  const allowed = new Set(["embedding_model", "generation_model", "generation"]);
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.has(key))) throw new Error("Unsupported model selection field");
  const input = value as Record<string, unknown>;
  const output: ModelSelectionInput = {};
  for (const key of ["embedding_model", "generation_model"] as const) {
    const selected = input[key];
    if (selected === undefined) continue;
    if (typeof selected !== "string" || !validModelName(selected)) throw new Error(`Invalid ${key}`);
    output[key] = selected;
  }
  if (input.generation !== undefined) output.generation = validateGenerationSelection(input.generation);
  if (output.generation && output.generation_model) throw new Error("generation and generation_model cannot be combined");
  if (!Object.keys(output).length) throw new Error("At least one model selection is required");
  return output;
}

function validateGenerationProbeInput(value: unknown): GenerationProbeInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Generation probe must be a JSON object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["source", "model", "connection"].includes(key))) throw new Error("Unsupported generation probe field");
  const source = validateGenerationSource(input.source);
  const model = input.model === undefined ? undefined : input.model;
  if (model !== undefined && (typeof model !== "string" || !validModelName(model))) throw new Error("Invalid generation model");
  if (source === "codex_session") {
    if (input.connection !== undefined) throw new Error("Codex session probes cannot include API connection fields");
    return { source, ...(model ? { model } : {}) };
  }
  return { source, ...(model ? { model } : {}), connection: validateGenerationConnection(input.connection) };
}

function validateGenerationSelection(value: unknown): GenerationSelectionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Generation selection must be a JSON object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["source", "model", "connection"].includes(key))) throw new Error("Unsupported generation selection field");
  const source = validateGenerationSource(input.source);
  if (typeof input.model !== "string" || !validModelName(input.model)) throw new Error("Invalid generation model");
  if (source === "codex_session") {
    if (input.connection !== undefined) throw new Error("Codex session selection cannot include API connection fields");
    return { source, model: input.model };
  }
  return { source, model: input.model, connection: validateGenerationConnection(input.connection) };
}

function validateGenerationSource(value: unknown): GenerationSource {
  if (value !== "codex_session" && value !== "openai_compatible") throw new Error("Invalid generation source");
  return value;
}

function validateGenerationConnection(value: unknown): GenerationConnectionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("API connection settings are required");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["base_url", "api_key_action", "api_key"].includes(key))) throw new Error("Unsupported API connection field");
  if (typeof input.base_url !== "string") throw new Error("API base URL is required");
  const baseUrl = validatedProviderBaseUrl(input.base_url);
  if (!(["keep", "replace", "clear"] as unknown[]).includes(input.api_key_action)) throw new Error("Invalid API key action");
  const action = input.api_key_action as GenerationConnectionInput["api_key_action"];
  if (action === "replace") {
    if (typeof input.api_key !== "string" || !input.api_key || input.api_key.length > 8192 || /[\r\n\0]/.test(input.api_key)) {
      throw new Error("A valid API key is required when replacing the key");
    }
    return { base_url: baseUrl, api_key_action: action, api_key: input.api_key };
  }
  if (input.api_key !== undefined) throw new Error("API key may only be supplied when replacing the key");
  return { base_url: baseUrl, api_key_action: action };
}

function validateCodexChatCompletion(value: unknown): {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  output_schema: Record<string, unknown>;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Chat completion must be a JSON object");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["model", "messages", "response_format", "temperature", "max_tokens", "max_completion_tokens", "stream"]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error("Unsupported Codex chat completion field");
  if (typeof input.model !== "string" || !validModelName(input.model)) throw new Error("Invalid Codex model");
  if (input.stream === true) throw new Error("Streaming Codex completions are not supported");
  if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > 64) throw new Error("Invalid Codex chat messages");
  const messages = input.messages.map(message => {
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid Codex chat message");
    const item = message as Record<string, unknown>;
    if (Object.keys(item).some(key => !["role", "content"].includes(key))) throw new Error("Unsupported Codex chat message field");
    if (item.role !== "system" && item.role !== "user" && item.role !== "assistant") throw new Error("Invalid Codex chat role");
    if (typeof item.content !== "string" || item.content.length > 900_000) throw new Error("Invalid Codex chat content");
    return { role: item.role as "system" | "user" | "assistant", content: item.content };
  });
  const format = input.response_format;
  if (!format || typeof format !== "object" || Array.isArray(format)) throw new Error("Codex requires a JSON response format");
  const responseFormat = format as Record<string, unknown>;
  let schema: Record<string, unknown>;
  if (responseFormat.type === "json_schema") {
    const wrapper = responseFormat.json_schema;
    if (!wrapper || typeof wrapper !== "object" || Array.isArray(wrapper)) throw new Error("Invalid Codex JSON schema");
    const candidate = (wrapper as Record<string, unknown>).schema;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Invalid Codex JSON schema");
    schema = candidate as Record<string, unknown>;
  } else if (responseFormat.type === "json_object") {
    schema = { type: "object", additionalProperties: true };
  } else {
    throw new Error("Codex only supports JSON response formats");
  }
  return { model: input.model, messages, output_schema: schema };
}

function modelProvider(baseUrl: string | undefined, apiKey: string | undefined): ModelProvider | null {
  if (!baseUrl?.trim()) return null;
  return { base_url: baseUrl.trim(), api_key: apiKey || "" };
}

function generationSource(node: NodeRecord, env: Record<string, string>): GenerationSource | null {
  if (env.GENERATION_SOURCE === "codex_session" || env.GENERATION_SOURCE === "openai_compatible") return env.GENERATION_SOURCE;
  if (env.GENERATION_BASE_URL === codexBridgeBaseUrl(Number(env.MANAGER_PORT || 14174), node.node_id)) return "codex_session";
  if (env.GENERATION_BASE_URL || env.GENERATION_MODEL) return "openai_compatible";
  return null;
}

function savedDirectGenerationProvider(
  node: NodeRecord,
  env: Record<string, string>,
): { provider: ModelProvider | null; origin: "generation" | "embedding_fallback" | null; model: string | null } {
  const activeSource = generationSource(node, env);
  const saved = modelProvider(env.GENERATION_DIRECT_BASE_URL, env.GENERATION_DIRECT_API_KEY);
  if (saved) return { provider: saved, origin: "generation", model: env.GENERATION_DIRECT_MODEL || null };
  if (activeSource !== "codex_session") {
    const active = modelProvider(env.GENERATION_BASE_URL, env.GENERATION_API_KEY);
    if (active) return { provider: active, origin: "generation", model: env.GENERATION_MODEL || null };
  }
  const embedding = modelProvider(env.EMBEDDING_BASE_URL, env.EMBEDDING_API_KEY);
  return { provider: embedding, origin: embedding ? "embedding_fallback" : null, model: null };
}

function directGenerationProvider(
  node: NodeRecord,
  env: Record<string, string>,
  connection: GenerationConnectionInput | undefined,
): { provider: ModelProvider } {
  if (!connection) throw new Error("API connection settings are required");
  const current = savedDirectGenerationProvider(node, env).provider;
  const sameAddress = Boolean(current && normalizedProviderBaseUrl(current.base_url) === normalizedProviderBaseUrl(connection.base_url));
  if (connection.api_key_action === "keep") {
    if (!current || !sameAddress) throw new Error("The saved API key cannot be reused after changing the provider address");
    return { provider: { base_url: containerProviderBaseUrl(connection.base_url), api_key: current.api_key } };
  }
  return {
    provider: {
      base_url: containerProviderBaseUrl(connection.base_url),
      api_key: connection.api_key_action === "replace" ? connection.api_key || "" : "",
    },
  };
}

function preserveDirectGenerationConfiguration(
  configuration: ModelConfiguration,
  node: NodeRecord,
  env: Record<string, string>,
): void {
  const direct = savedDirectGenerationProvider(node, env);
  if (!direct.provider || direct.origin !== "generation") return;
  configuration.generation_direct_base_url = direct.provider.base_url;
  configuration.generation_direct_api_key = direct.provider.api_key;
  if (direct.model) configuration.generation_direct_model = direct.model;
}

function codexBridgeBaseUrl(managerPort: number, nodeId: string): string {
  return `http://host.docker.internal:${managerPort}/v1/internal/codex/nodes/${nodeId}`;
}

function validatedProviderBaseUrl(value: string, label = "base_url"): string {
  const trimmed = value.trim();
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { throw new Error(`${label} must be an HTTP(S) URL`); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an HTTP(S) URL without credentials, query, or fragment`);
  }
  return trimmed.replace(/\/+$/, "");
}

function normalizedProviderBaseUrl(value: string): string {
  const target = new URL(validatedProviderBaseUrl(value));
  const host = target.hostname.toLowerCase();
  target.hostname = ["localhost", "host.docker.internal"].includes(host) ? "127.0.0.1" : host;
  return target.toString().replace(/\/+$/, "");
}

function containerProviderBaseUrl(value: string): string {
  const target = new URL(validatedProviderBaseUrl(value));
  if (["127.0.0.1", "localhost", "::1"].includes(target.hostname.toLowerCase())) target.hostname = "host.docker.internal";
  return target.toString().replace(/\/$/, "");
}

function displayProviderUrl(value: string): string {
  try {
    const target = new URL(value);
    target.username = "";
    target.password = "";
    target.search = "";
    target.hash = "";
    if (target.hostname.toLowerCase() === "host.docker.internal") target.hostname = "127.0.0.1";
    return target.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function providerEndpoint(baseUrl: string, resource: "models" | "embeddings" | "chat/completions"): URL {
  const target = new URL(baseUrl);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new Error("Invalid provider URL");
  if (target.hostname.toLowerCase() === "host.docker.internal") target.hostname = "127.0.0.1";
  const path = target.pathname.replace(/\/+$/, "");
  target.pathname = path.endsWith(`/${resource}`) ? path : `${path}/${resource}`;
  target.search = "";
  target.hash = "";
  return target;
}

function validModelName(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/^https?:\/\//i.test(value) && /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(value);
}

function modelNameLeaksProvider(value: string, provider: ModelProvider): boolean {
  const sensitive = [provider.api_key, provider.base_url];
  try {
    const configured = new URL(provider.base_url);
    sensitive.push(configured.hostname);
    if (configured.hostname.toLowerCase() === "host.docker.internal") sensitive.push("127.0.0.1");
  } catch {}
  return sensitive.some(item => item && sharesSensitiveFragment(value, item));
}

function sharesSensitiveFragment(value: string, sensitive: string): boolean {
  const left = value.toLowerCase();
  const right = sensitive.toLowerCase();
  const width = Math.min(12, right.length);
  if (!width) return false;
  if (left.includes(right) || right.includes(left)) return true;
  return left.includes(right.slice(0, width)) || left.includes(right.slice(-width));
}

function likelyEmbeddingModel(value: string): boolean {
  return /embed(?:ding)?/i.test(value)
    || /(?:^|[/:._-])(?:bge|e5|gte|instructor|minilm)(?:$|[/:._-])/i.test(value);
}

function modelRecoveryResult(existing: unknown, restarted: boolean): Record<string, unknown> {
  const prior = existing && typeof existing === "object" && !Array.isArray(existing)
    ? existing as Record<string, unknown>
    : {};
  return {
    ...prior,
    recovery: {
      runtime_source: "saved_node_environment",
      restarted,
      recovery_completed_at: new Date().toISOString(),
    },
  };
}

function roleCatalog(catalog: ModelCatalog, role: "embedding" | "generation"): Pick<ModelSelectionOption, "available_models" | "diagnostic"> {
  if (catalog.diagnostic) return { available_models: [], diagnostic: catalog.diagnostic };
  const available = catalog.models.filter(model => role === "embedding" ? likelyEmbeddingModel(model) : !likelyEmbeddingModel(model));
  if (!available.length && catalog.models.length) {
    return { available_models: [], diagnostic: `No ${role}-compatible models were found` };
  }
  return { available_models: available, diagnostic: null };
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
