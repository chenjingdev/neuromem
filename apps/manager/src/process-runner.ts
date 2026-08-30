import { spawn } from "node:child_process";
import fs from "node:fs";
import type { CommandResult, CommandRunner, RunOptions } from "./types.js";

export class ProcessRunner implements CommandRunner {
  run(command: string, args: readonly string[], options: RunOptions = {}): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const input = options.inputFile ? fs.createReadStream(options.inputFile) : null;
      const output = options.outputFile
        ? fs.createWriteStream(options.outputFile, { flags: "wx", mode: 0o600 })
        : null;
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env || process.env,
        stdio: [input ? "pipe" : "ignore", output ? "pipe" : "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = options.timeoutMs
        ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs)
        : null;
      const finish = (error?: Error, code = -1) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) {
          output?.destroy();
          reject(error);
          return;
        }
        const result = { ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() };
        if (!result.ok && !options.allowFailure) {
          reject(new Error(`${command} failed (${code})${result.stderr ? `: ${result.stderr}` : ""}`));
        } else {
          resolve(result);
        }
      };
      child.on("error", error => finish(error));
      input?.on("error", error => finish(error));
      output?.on("error", error => finish(error));
      child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
      if (output && child.stdout) child.stdout.pipe(output);
      else child.stdout?.on("data", chunk => { stdout += chunk.toString(); });
      if (input && child.stdin) input.pipe(child.stdin);
      child.on("close", code => {
        if (output && !output.closed) output.once("close", () => finish(undefined, code ?? -1));
        else finish(undefined, code ?? -1);
      });
    });
  }
}
