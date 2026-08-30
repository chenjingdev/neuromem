import type { CommandResult, CommandRunner, ComponentStatus, DatabaseManifest, NodeRecord } from "./types.js";
import { nodeFile, type ManagerPaths } from "./paths.js";

const SERVICE_ALIASES = new Map([
  ["database", "database"],
  ["api", "core"],
  ["core", "core"],
  ["worker", "worker"],
  ["mcp", "mcp"],
  ["dashboard", "web"],
  ["web", "web"],
]);

export class ComposeController {
  constructor(
    private readonly paths: ManagerPaths,
    private readonly runner: CommandRunner,
  ) {}

  async dockerAvailable(): Promise<boolean> {
    const result = await this.runner.run("docker", ["info", "--format", "{{.ServerVersion}}"], { allowFailure: true, timeoutMs: 10_000 });
    return result.ok;
  }

  async up(node: NodeRecord): Promise<void> {
    await this.compose(node, ["up", "-d"], false, 10 * 60_000);
  }

  async stop(node: NodeRecord): Promise<void> {
    await this.compose(node, ["stop"], false, 5 * 60_000);
  }

  async stopWriters(node: NodeRecord): Promise<void> {
    await this.compose(node, ["stop", "worker", "core", "mcp"], false, 5 * 60_000);
  }

  async down(node: NodeRecord): Promise<void> {
    await this.compose(node, ["down", "--remove-orphans"], false, 5 * 60_000);
  }

  async ps(node: NodeRecord): Promise<ComponentStatus[]> {
    const result = await this.compose(node, ["ps", "--format", "json"], true, 30_000);
    if (!result.ok || !result.stdout) return [];
    try {
      const parsed = result.stdout.trim().startsWith("[")
        ? JSON.parse(result.stdout) as Record<string, unknown>[]
        : result.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
      return parsed.map(item => ({
        name: String(item.Service || item.Name || "unknown"),
        state: String(item.State || item.Status || "unknown"),
        health: item.Health ? String(item.Health) : undefined,
      }));
    } catch (error) {
      return [{ name: "compose", state: "unknown", detail: `Cannot parse docker compose status: ${(error as Error).message}` }];
    }
  }

  async logs(node: NodeRecord, service: string, tail: number): Promise<string> {
    const resolvedService = SERVICE_ALIASES.get(service);
    if (!resolvedService) throw new Error(`Unsupported service: ${service}`);
    if (!Number.isSafeInteger(tail) || tail < 1 || tail > 5_000) throw new Error("tail must be between 1 and 5000");
    const result = await this.compose(node, ["logs", "--no-color", "--tail", String(tail), resolvedService], true, 30_000);
    return [result.stdout, result.stderr].filter(Boolean).join("\n").slice(-2_000_000);
  }

  async pgDump(node: NodeRecord, target: string): Promise<void> {
    const env = await readNodeEnv(this.paths, node);
    await this.compose(node, [
      "exec", "-T", "database", "pg_dump",
      "-U", env.POSTGRES_USER || "neuromem",
      "-d", env.POSTGRES_DB || "neuromem",
      "-Fc", "-Z", "3",
    ], false, 60 * 60_000, { outputFile: target });
  }

  async verifyDump(node: NodeRecord, source: string): Promise<void> {
    const env = await readNodeEnv(this.paths, node);
    const image = env.POSTGRES_IMAGE || "pgvector/pgvector:0.8.6-pg15";
    await this.runner.run("docker", [
      "run", "--rm",
      "--mount", `type=bind,source=${source},target=/backup/database.dump,readonly`,
      "--entrypoint", "pg_restore", image,
      "--list", "/backup/database.dump",
    ], { timeoutMs: 10 * 60_000 });
  }

  async createVolume(volume: string): Promise<void> {
    validateVolume(volume);
    await this.runner.run("docker", ["volume", "create", volume], { timeoutMs: 30_000 });
  }

  async removeVolume(volume: string): Promise<void> {
    validateVolume(volume);
    await this.runner.run("docker", ["volume", "rm", volume], { timeoutMs: 30_000 });
  }

  async volumeExists(volume: string): Promise<boolean> {
    validateVolume(volume);
    return (await this.runner.run("docker", ["volume", "inspect", volume], { allowFailure: true, timeoutMs: 30_000 })).ok;
  }

  async listNodeVolumes(nodeId: string): Promise<string[]> {
    const prefix = `neuromem-${nodeId.replaceAll("-", "").toLowerCase()}-`;
    const result = await this.runner.run("docker", ["volume", "ls", "--format", "{{.Name}}", "--filter", `name=${prefix}`], { allowFailure: true, timeoutMs: 30_000 });
    if (!result.ok) throw new Error("Cannot enumerate Node volumes before purge");
    return result.stdout.split(/\r?\n/).filter(name => name.startsWith(prefix)).filter(name => {
      try { validateVolume(name); return true; } catch { return false; }
    });
  }

  async runDocker(args: readonly string[], options: Parameters<CommandRunner["run"]>[2] = {}): Promise<CommandResult> {
    return this.runner.run("docker", args, options);
  }

  async runMigration(node: NodeRecord, target: string, verify = false): Promise<CommandResult> {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(target)) throw new Error("Invalid migration target revision");
    return this.compose(node, ["run", "--rm", "core", "migrate", ...(verify ? ["--verify"] : []), "--target", target], false, 60 * 60_000);
  }

  async migrationStatus(node: NodeRecord, target = "head"): Promise<CommandResult> {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(target)) throw new Error("Invalid migration target revision");
    return this.compose(node, ["run", "--rm", "core", "migrate", "--verify", "--target", target], true, 5 * 60_000);
  }

  async databaseManifest(node: NodeRecord): Promise<DatabaseManifest> {
    const env = await readNodeEnv(this.paths, node);
    const result = await this.compose(node, [
      "exec", "-T", "database", "psql", "-U", env.POSTGRES_USER || "neuromem", "-d", env.POSTGRES_DB || "neuromem",
      "-v", "ON_ERROR_STOP=1", "-qAtc", databaseManifestSql(),
    ], false, 5 * 60_000);
    return parseDatabaseManifest(result.stdout);
  }

  async mcpQueueEmpty(node: NodeRecord): Promise<boolean> {
    const env = await readNodeEnv(this.paths, node);
    const volume = env.MCP_STATE_VOLUME_NAME;
    if (!volume) throw new Error("MCP state volume is not configured");
    if (!(await this.volumeExists(volume))) return true;
    const image = env.POSTGRES_IMAGE || "pgvector/pgvector:0.8.6-pg15";
    const result = await this.runner.run("docker", [
      "run", "--rm", "--mount", `type=volume,source=${volume},target=/state,readonly`,
      "--entrypoint", "sh", image, "-c",
      "set -eu; if [ -s /state/retry-queue.json ]; then test \"$(tr -d '[:space:]' < /state/retry-queue.json)\" = '[]'; fi; if [ -d /state/records ]; then test -z \"$(find /state/records -type f -name '*.json' -print -quit)\"; fi",
    ], { allowFailure: true, timeoutMs: 30_000 });
    return result.ok;
  }

  private compose(
    node: NodeRecord,
    extra: readonly string[],
    allowFailure: boolean,
    timeoutMs: number,
    streams: { inputFile?: string; outputFile?: string } = {},
  ): Promise<CommandResult> {
    return this.runner.run("docker", [
      "compose",
      "--project-name", node.compose_project,
      "--env-file", nodeFile(this.paths, node.node_id, ".env"),
      "--file", nodeFile(this.paths, node.node_id, "compose.yaml"),
      ...extra,
    ], {
      cwd: nodeFile(this.paths, node.node_id, "."),
      allowFailure,
      timeoutMs,
      ...streams,
    });
  }
}

export function databaseManifestSql(): string {
  return `BEGIN;
  CREATE TEMP TABLE neuromem_manifest_counts(table_name text PRIMARY KEY, row_count bigint NOT NULL) ON COMMIT DROP;
  CREATE TEMP TABLE neuromem_manifest_revision(revision text) ON COMMIT DROP;
  DO $neuromem$
  DECLARE item record;
  BEGIN
    FOR item IN SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = current_schema() AND tablename <> 'alembic_version'
    LOOP
      EXECUTE format('INSERT INTO neuromem_manifest_counts SELECT %L, count(*) FROM %I.%I', item.tablename, current_schema(), item.tablename);
    END LOOP;
    IF to_regclass(current_schema() || '.alembic_version') IS NOT NULL THEN
      EXECUTE format('INSERT INTO neuromem_manifest_revision SELECT version_num FROM %I.alembic_version LIMIT 1', current_schema());
    END IF;
  END $neuromem$;
  SELECT json_build_object(
    'database_bytes', pg_database_size(current_database()),
    'schema_revision', (SELECT revision FROM neuromem_manifest_revision LIMIT 1),
    'row_counts', COALESCE((SELECT json_object_agg(table_name, row_count ORDER BY table_name) FROM neuromem_manifest_counts), '{}'::json),
    'extensions', COALESCE((SELECT json_object_agg(extname, extversion) FROM pg_extension WHERE extname IN ('vector','pg_trgm')), '{}'::json),
    'vector_columns', COALESCE((SELECT json_object_agg(relname, json_build_object(
      'type', formatted_type,
      'dimensions', CASE WHEN formatted_type ~ '^halfvec\\([0-9]+\\)$' THEN substring(formatted_type FROM '[0-9]+')::int ELSE NULL END
    )) FROM (
      SELECT c.relname, format_type(a.atttypid, a.atttypmod) AS formatted_type
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relname IN ('record_embeddings','claim_embeddings')
        AND a.attname = 'embedding' AND NOT a.attisdropped
    ) vector_types), '{}'::json)
  )::text;
  COMMIT;`;
}

export function parseDatabaseManifest(value: string): DatabaseManifest {
  const parsed = JSON.parse(value.trim()) as DatabaseManifest;
  if (!Number.isFinite(parsed.database_bytes) || !parsed.row_counts || !parsed.vector_columns) {
    throw new Error("Database manifest is incomplete");
  }
  parsed.schema_revision ||= "missing";
  parsed.extensions ||= {};
  return parsed;
}

function validateVolume(volume: string): void {
  if (!/^neuromem-[0-9a-f]{32}-(?:pg-g[1-9][0-9]*|mcp)$/.test(volume)) {
    throw new Error(`Refusing to operate on an unrecognized Neuromem volume: ${volume}`);
  }
}

export async function readNodeEnv(paths: ManagerPaths, node: NodeRecord): Promise<Record<string, string>> {
  const fs = await import("node:fs/promises");
  const raw = await fs.readFile(nodeFile(paths, node.node_id, ".env"), "utf8");
  return Object.fromEntries(raw.split(/\r?\n/).filter(line => line && !line.startsWith("#") && line.includes("=")).map(line => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1).replace(/^"|"$/g, "")];
  }));
}
