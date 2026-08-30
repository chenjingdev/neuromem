import type { MemoryToolDispatcher } from "./tools.js";

export interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "RpcError";
  }
}

export function validJsonRpcId(value: unknown): boolean {
  return value === undefined || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

export function rpcErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "internal_error";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function truncateText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}

function compactPreview(value: unknown, depth: number, stringLimit: number, arrayLimit: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return truncateText(value, stringLimit);
  if (depth <= 0) return "[depth limit]";
  if (Array.isArray(value)) return value.slice(0, arrayLimit).map((item) => compactPreview(item, depth - 1, stringLimit, arrayLimit));
  const object = objectValue(value);
  if (!object) return String(value);
  const preview: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object).slice(0, 24)) {
    if (/(?:embedding|vector|base64|binary|blob)/i.test(key)) continue;
    preview[key] = compactPreview(item, depth - 1, stringLimit, arrayLimit);
  }
  return preview;
}

function encodeBoundedPreview(value: unknown): string {
  for (const [depth, stringLimit, arrayLimit] of [[5, 1_024, 5], [4, 512, 3], [3, 256, 2]] as const) {
    const encoded = JSON.stringify(compactPreview(value, depth, stringLimit, arrayLimit));
    if (Buffer.byteLength(encoded, "utf8") <= 16 * 1_024) return encoded;
  }
  return JSON.stringify({ summary: "Memory result preview exceeded 16 KiB.", truncated: true });
}

function summarizeResult(value: unknown): string {
  const result = objectValue(value);
  if (!result) return "Memory operation completed.";
  if (typeof result.record_id === "string") {
    const deliveries = objectValue(result.deliveries);
    const statuses = deliveries
      ? Object.entries(deliveries).map(([node, delivery]) => `${node}=${String(objectValue(delivery)?.status ?? "unknown")}`).join(", ")
      : "no delivery status";
    return `Record ${result.record_id}: ${statuses}.`;
  }
  if (Array.isArray(result.results)) {
    const errors = Array.isArray(result.errors) ? result.errors.length : 0;
    const preview = {
      summary: `Returned ${result.results.length} memory result(s) with ${errors} node error(s).`,
      truncated: result.truncated === true,
      results: result.results.slice(0, 5),
      errors: Array.isArray(result.errors) ? result.errors.slice(0, 5) : []
    };
    return encodeBoundedPreview(preview);
  }
  return "Memory operation completed.";
}

export async function dispatchRpc(dispatcher: MemoryToolDispatcher, request: JsonRpcRequest): Promise<unknown> {
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string" || !validJsonRpcId(request.id)) {
    throw new RpcError(-32600, "Invalid Request");
  }
  switch (request.method) {
    case "initialize":
      {
        const params = objectValue(request.params);
        const clientInfo = objectValue(params?.clientInfo);
        if (
          typeof params?.protocolVersion !== "string"
          || !objectValue(params.capabilities)
          || typeof clientInfo?.name !== "string"
          || typeof clientInfo.version !== "string"
        ) {
          throw new RpcError(-32602, "Invalid initialize parameters");
        }
      return {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "neuromem-mcp", version: "0.1.0" }
      };
      }
    case "notifications/initialized":
      return undefined;
    case "ping":
      return {};
    case "tools/list":
      return { tools: dispatcher.listTools() };
    case "tools/call": {
      const params = request.params && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
      const name = typeof params.name === "string" ? params.name : "";
      if (!name || !dispatcher.listTools().some((tool) => tool.name === name)) throw new RpcError(-32602, "Unknown tool");
      if (params.arguments !== undefined && !objectValue(params.arguments)) throw new RpcError(-32602, "Tool arguments must be an object");
      try {
        const value = await dispatcher.callTool(name, params.arguments);
        return {
          content: [{ type: "text", text: summarizeResult(value) }],
          structuredContent: value,
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: rpcErrorMessage(error) }],
          isError: true
        };
      }
    }
    default:
      throw new RpcError(-32601, "Method not found");
  }
}
