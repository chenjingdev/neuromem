import { readNodeEnv } from "./compose.js";
import { fileURLToPath } from "node:url";
import type { ManagerPaths } from "./paths.js";
import type { NodeRecord } from "./types.js";

export async function renderMcpConfig(paths: ManagerPaths, node: NodeRecord, format: "json" | "toml" = "json"): Promise<string> {
  const env = await readNodeEnv(paths, node);
  const token = env.MCP_TOKEN;
  if (!token || Buffer.byteLength(token, "utf8") < 16) throw new Error("The selected Node has no usable MCP token");
  const url = `http://127.0.0.1:${node.ports.mcp}/mcp`;
  if (format === "toml") {
    return [
      `# Neuromem skill: ${packagedSkillPath()}`,
      `[mcp_servers.${node.alias}]`,
      `url = ${JSON.stringify(url)}`,
      `http_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }`,
      "",
    ].join("\n");
  }
  if (format !== "json") throw new Error("MCP config format must be json or toml");
  return `${JSON.stringify({
    skill_path: packagedSkillPath(),
    mcpServers: {
      [node.alias]: {
        url,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  }, null, 2)}\n`;
}

export function packagedSkillPath(): string {
  return fileURLToPath(new URL("../../assets/skill/neuromem-memory/SKILL.md", import.meta.url));
}
