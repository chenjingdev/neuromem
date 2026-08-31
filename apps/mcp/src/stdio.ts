#!/usr/bin/env node
import { createInterface } from "node:readline";

import { loadMcpAuthConfig, loadRouterConfig } from "./config.js";
import { dispatchRpc, type JsonRpcRequest, RpcError, rpcErrorMessage, validJsonRpcId } from "./rpc.js";
import { FederatedMemoryRouter } from "./router.js";
import { MemoryToolDispatcher } from "./tools.js";
import type { JsonObject } from "./types.js";

function emit(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const router = new FederatedMemoryRouter(loadRouterConfig());
await router.ready();
const auth = loadMcpAuthConfig();
const dispatcher = new MemoryToolDispatcher(router, { authMode: auth.mode, authContext: auth.context });
router.startRetryWorker();
let initialized = false;
let processing = Promise.resolve();

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  processing = processing.then(() => handleLine(line), () => handleLine(line));
});
lines.on("close", () => {
  void processing.finally(() => router.close());
});

async function envelope(request: JsonRpcRequest): Promise<JsonObject | undefined> {
  try {
    const result = await dispatchRpc(dispatcher, request);
    return request.id === undefined ? undefined : { jsonrpc: "2.0", id: request.id, result };
  } catch (error) {
    if (request.id === undefined) return undefined;
    return {
      jsonrpc: "2.0",
      id: validJsonRpcId(request.id) ? request.id : null,
      error: { code: error instanceof RpcError ? error.code : -32603, message: rpcErrorMessage(error) }
    };
  }
}

async function handleLine(line: string): Promise<void> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    emit({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (Array.isArray(decoded)) {
    if (!initialized || decoded.length === 0 || decoded.length > 32 || decoded.some((item) => (
      !item || typeof item !== "object" || Array.isArray(item) || (item as JsonRpcRequest).method === "initialize"
    ))) {
      emit({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      return;
    }
    const replies = (await Promise.all((decoded as JsonRpcRequest[]).map(envelope)))
      .filter((reply): reply is JsonObject => reply !== undefined);
    if (replies.length > 0) emit(replies);
    return;
  }
  if (!decoded || typeof decoded !== "object") {
    emit({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    return;
  }
  const request = decoded as JsonRpcRequest;
  if (!initialized && request.method !== "initialize") {
    if (request.id !== undefined) emit({ jsonrpc: "2.0", id: request.id, error: { code: -32002, message: "Not initialized" } });
    return;
  }
  const reply = await envelope(request);
  if (request.method === "initialize" && reply && !("error" in reply)) initialized = true;
  if (reply) emit(reply);
}
