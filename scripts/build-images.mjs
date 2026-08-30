import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const images = [
  ["neuromem/core:0.1.0", "apps/core"],
  ["neuromem/mcp:0.1.0", "apps/mcp"],
  ["neuromem/dashboard:0.1.0", "apps/web"],
];

for (const [tag, context] of images) {
  await run("docker", ["build", "--tag", tag, path.join(root, context)]);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with status ${code ?? "unknown"}`));
    });
  });
}
