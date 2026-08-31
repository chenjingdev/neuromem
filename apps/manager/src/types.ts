export type DesiredState = "running" | "stopped";

export type NodePhase =
  | "stopped"
  | "starting"
  | "ready"
  | "degraded"
  | "maintenance"
  | "failed";

export interface NodePorts {
  api: number;
  dashboard: number;
  mcp: number;
}

export interface NodeRecord {
  node_id: string;
  alias: string;
  ports: NodePorts;
  generation: number;
  desired_state: DesiredState;
  phase: NodePhase;
  compose_project: string;
  schema_revision: string;
  created_at: string;
  updated_at: string;
}

export interface RegistryFile {
  format: 1;
  default_node_id: string | null;
  nodes: NodeRecord[];
}

export type OperationKind =
  | "create"
  | "start"
  | "stop"
  | "restart"
  | "backup"
  | "backup_verify"
  | "restore_plan"
  | "restore_apply"
  | "migrate_plan"
  | "migrate_apply"
  | "migrate_verify"
  | "models_configure"
  | "delete";

export type OperationState =
  | "running"
  | "succeeded"
  | "failed"
  | "recovered"
  | "needs_attention";

export interface OperationRecord {
  operation_id: string;
  node_id: string;
  kind: OperationKind;
  state: OperationState;
  phase: string;
  started_at: string;
  updated_at: string;
  completed_at?: string;
  error?: string;
  result?: unknown;
}

export interface CommandResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  inputFile?: string;
  outputFile?: string;
  allowFailure?: boolean;
  timeoutMs?: number;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options?: RunOptions): Promise<CommandResult>;
}

export interface ComponentStatus {
  name: string;
  state: string;
  health?: string;
  detail?: string;
}

export type ModelProviderState =
  | "unconfigured"
  | "configured"
  | "unknown"
  | "ready"
  | "error";

export interface ModelProviderStatus {
  configured: boolean;
  model?: string;
  provider_status: ModelProviderState;
  provider_detail: string | null;
  last_probe_at: string | null;
}

export interface NodeModelStatus {
  embedding: ModelProviderStatus;
  extraction: ModelProviderStatus;
}

export interface NodeStatus {
  node: NodeRecord;
  docker_available: boolean;
  phase: NodePhase;
  components: ComponentStatus[];
  endpoints: {
    api: string;
    dashboard: string;
    mcp: string;
  };
  models?: NodeModelStatus;
  error?: string;
}

export interface BackupManifest {
  format: 1;
  backup_id: string;
  label: string;
  node_id: string;
  node_alias: string;
  generation: number;
  schema_revision: string;
  database_bytes: number;
  row_counts: Record<string, number>;
  extensions: Record<string, string>;
  vector_columns: Record<string, { type: string; dimensions: number | null }>;
  created_at: string;
  archive: string;
  archive_bytes: number;
  sha256: string;
  verified: boolean;
}

export interface DatabaseManifest {
  database_bytes: number;
  schema_revision: string;
  row_counts: Record<string, number>;
  extensions: Record<string, string>;
  vector_columns: Record<string, { type: string; dimensions: number | null }>;
}

export interface RestorePlan {
  ok: boolean;
  node_id: string;
  backup: BackupManifest;
  current_generation: number;
  candidate_generation: number;
  free_bytes: number;
  required_bytes: number;
  requires_pre_restore_backup: true;
  preserves_current_generation: true;
  writes_blocked_during_apply: true;
  steps: string[];
  blockers: string[];
}

export interface MigrationPlan {
  ok: boolean;
  node_id: string;
  current_revision: string;
  target_revision: string;
  requires_backup: boolean;
  apply_mode: "transactional" | "new_generation";
  writes_blocked_during_apply: true;
  blockers: string[];
}
