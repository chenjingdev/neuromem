import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { CommandResult, CommandRunner, RunOptions } from "../src/types.js";
import { resolveManagerPaths } from "../src/paths.js";

export class FakeRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[]; options: RunOptions }> = [];
  fail?: (command: string, args: readonly string[]) => boolean;

  async run(command: string, args: readonly string[], options: RunOptions = {}): Promise<CommandResult> {
    this.calls.push({ command, args: [...args], options });
    if (options.outputFile) await fs.writeFile(options.outputFile, "portable-database-archive", { flag: "wx", mode: 0o600 });
    if (this.fail?.(command, args)) {
      const result = { ok: false, code: 1, stdout: "", stderr: "simulated failure" };
      if (!options.allowFailure) throw new Error("simulated failure");
      return result;
    }
    if (args[0] === "volume" && args[1] === "inspect") return { ok: false, code: 1, stdout: "", stderr: "not found" };
    if (args.includes("ps") && args.includes("json")) {
      return {
        ok: true, code: 0, stderr: "", stdout: ["database", "core", "worker", "mcp", "web"]
          .map(Service => JSON.stringify({ Service, State: "running", Health: "healthy" })).join("\n"),
      };
    }
    if (args.includes("--verify") && args.includes("migrate")) {
      const target = args[args.indexOf("--target") + 1] || "a1b2c3";
      return { ok: true, code: 0, stderr: "", stdout: `schema verified at ${target === "head" ? "0001_initial" : target}` };
    }
    if (args.some(value => value.includes("json_build_object"))) {
      return {
        ok: true, code: 0, stderr: "", stdout: JSON.stringify({
          database_bytes: 4096,
          schema_revision: "0001_initial",
          row_counts: Object.fromEntries([
            "workspaces", "projects", "peers", "sessions", "session_peers", "records", "record_segments", "claims",
            "claim_sources", "claim_relations", "claim_edges", "embedding_profiles", "record_embeddings",
            "claim_embeddings", "jobs",
          ].map(name => [name, 0])),
          extensions: { vector: "0.8.6", pg_trgm: "1.6" },
          vector_columns: {
            record_embeddings: { type: "halfvec(2560)", dimensions: 2560 },
            claim_embeddings: { type: "halfvec(2560)", dimensions: 2560 },
          },
        }),
      };
    }
    return { ok: true, code: 0, stdout: "ok", stderr: "" };
  }
}

export async function temporaryPaths(prefix = "neuromem-manager-test-") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return { home, paths: resolveManagerPaths({ NEUROMEM_HOME: home, NEUROMEM_RUNTIME_DIR: path.join(home, "run") }) };
}

export function okFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.endsWith("/v1/system/backlog")
      ? { pending: 1, running: 0, failed: 0, oldest_pending_at: null }
      : {
          status: "ok", database: true, embedding_configured: true, extraction_configured: true,
          embedding_provider_status: "ready", extraction_provider_status: "ready",
        };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No TCP address"));
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

export async function threeFreePorts(): Promise<{ api: number; dashboard: number; mcp: number }> {
  return { api: await freePort(), dashboard: await freePort(), mcp: await freePort() };
}
