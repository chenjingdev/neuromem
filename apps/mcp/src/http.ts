#!/usr/bin/env node
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import { loadRouterConfig } from "./config.js";
import { uuid7 } from "./ids.js";
import { dispatchRpc, type JsonRpcRequest, RpcError, rpcErrorMessage, validJsonRpcId } from "./rpc.js";
import { FederatedMemoryRouter } from "./router.js";
import { MemoryToolDispatcher } from "./tools.js";
import type { JsonObject } from "./types.js";

const managedRouters = new WeakMap<Server, FederatedMemoryRouter>();

interface Session {
  lastSeenAt: number;
}

export interface McpHttpServerOptions {
  dispatcher: MemoryToolDispatcher;
  bearerToken: string;
  maxBodyBytes?: number;
  sessionTtlMs?: number;
  maxSessions?: number;
  maxInFlight?: number;
}

class HttpInputError extends Error {
  constructor(readonly status: number, message: string, readonly closeConnection = false) {
    super(message);
  }
}

function isLoopbackHost(value: string): boolean {
  try {
    const parsed = new URL(`http://${value}`);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  } catch {
    return false;
  }
}

function validateBrowserOrigin(request: IncomingMessage): void {
  const host = headerValue(request.headers.host);
  if (!host || !isLoopbackHost(host)) throw new HttpInputError(403, "loopback Host is required");
  const origin = headerValue(request.headers.origin);
  if (!origin) return;
  try {
    const parsed = new URL(origin);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !isLoopbackHost(parsed.host)) throw new Error("not loopback");
  } catch {
    throw new HttpInputError(403, "Origin is not allowed");
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const expectedHash = createHash("sha256").update(expected).digest();
  const providedHash = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedHash, providedHash) && provided.length > 0;
}

function writeJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  let body = JSON.stringify(value);
  if (Buffer.byteLength(body, "utf8") > 1_048_576) {
    status = 500;
    body = JSON.stringify({ error: "response_too_large" });
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  });
  response.end(body);
}

async function readJson(request: IncomingMessage, maximum: number): Promise<JsonRpcRequest | JsonRpcRequest[]> {
  const contentType = headerValue(request.headers["content-type"]) ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) throw new HttpInputError(415, "application/json is required");
  const contentLength = headerValue(request.headers["content-length"]);
  if (contentLength !== undefined) {
    const parsed = Number(contentLength);
    if (!Number.isInteger(parsed) || parsed < 0) throw new HttpInputError(400, "invalid content length");
    if (parsed > maximum) {
      request.pause();
      throw new HttpInputError(413, "request body is too large", true);
    }
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    received += buffer.length;
    if (received > maximum) {
      request.pause();
      throw new HttpInputError(413, "request body is too large", true);
    }
    chunks.push(buffer);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpInputError(400, "invalid JSON");
  }
  if (Array.isArray(decoded)) {
    if (decoded.length === 0 || decoded.length > 32 || decoded.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) {
      throw new HttpInputError(400, "JSON-RPC batches must contain 1 to 32 request objects");
    }
    return decoded as JsonRpcRequest[];
  }
  if (decoded === null || typeof decoded !== "object") {
    throw new HttpInputError(400, "a JSON-RPC request object is required");
  }
  return decoded as JsonRpcRequest;
}

async function rpcEnvelope(dispatcher: MemoryToolDispatcher, rpc: JsonRpcRequest): Promise<JsonObject | undefined> {
  try {
    const result = await dispatchRpc(dispatcher, rpc);
    return rpc.id === undefined ? undefined : { jsonrpc: "2.0", id: rpc.id, result };
  } catch (error) {
    if (rpc.id === undefined) return undefined;
    return {
      jsonrpc: "2.0",
      id: validJsonRpcId(rpc.id) ? rpc.id : null,
      error: { code: error instanceof RpcError ? error.code : -32603, message: rpcErrorMessage(error) }
    };
  }
}

function boundBatchReplies(replies: JsonObject[]): JsonObject[] {
  const bounded: JsonObject[] = [];
  for (let index = 0; index < replies.length; index += 1) {
    const reply = replies[index]!;
    const reserveBytes = (replies.length - index - 1) * 2_048;
    const candidate = [...bounded, reply];
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= 1_048_576 - reserveBytes) {
      bounded.push(reply);
      continue;
    }
    const safeId = Buffer.byteLength(JSON.stringify(reply.id ?? null), "utf8") <= 1_024 ? reply.id ?? null : null;
    const replacement: JsonObject = {
      jsonrpc: "2.0",
      id: safeId,
      error: { code: -32001, message: "Response omitted by batch size limit" }
    };
    bounded.push(replacement);
  }
  return bounded;
}

export function createMcpHttpServer(options: McpHttpServerOptions): Server {
  if (Buffer.byteLength(options.bearerToken, "utf8") < 16) {
    throw new Error("NEUROMEM_MCP_TOKEN must be at least 16 bytes");
  }
  const maxBodyBytes = options.maxBodyBytes ?? 5 * 1_048_576;
  const sessionTtlMs = options.sessionTtlMs ?? 30 * 60_000;
  const maxSessions = options.maxSessions ?? 1_024;
  const maxInFlight = options.maxInFlight ?? 64;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) throw new Error("maxBodyBytes must be positive");
  if (!Number.isInteger(sessionTtlMs) || sessionTtlMs < 1) throw new Error("sessionTtlMs must be positive");
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new Error("maxSessions must be positive");
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) throw new Error("maxInFlight must be positive");
  const sessions = new Map<string, Session>();
  let activeRequests = 0;

  function pruneSessions(now = Date.now()): void {
    for (const [id, session] of sessions) {
      if (now - session.lastSeenAt > sessionTtlMs) sessions.delete(id);
    }
  }

  function requireSession(request: IncomingMessage): string {
    pruneSessions();
    const id = headerValue(request.headers["mcp-session-id"]);
    const session = id ? sessions.get(id) : undefined;
    if (!id) throw new HttpInputError(400, "Mcp-Session-Id is required");
    if (!session) throw new HttpInputError(404, "MCP session not found");
    session.lastSeenAt = Date.now();
    return id;
  }

  const server = createServer((request, response) => {
    let counted = false;
    void (async () => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      validateBrowserOrigin(request);
      if (path === "/health" && request.method === "GET") {
        writeJson(response, 200, { status: "ok" });
        return;
      }
      if (path !== "/mcp") {
        writeJson(response, 404, { error: "not_found" });
        return;
      }
      if (activeRequests >= maxInFlight) throw new HttpInputError(503, "too many in-flight requests");
      activeRequests += 1;
      counted = true;
      if (!tokenMatches(headerValue(request.headers.authorization), options.bearerToken)) {
        writeJson(response, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
        return;
      }
      if (request.method === "GET") {
        requireSession(request);
        response.writeHead(405, { allow: "POST, DELETE", "cache-control": "no-store" });
        response.end();
        return;
      }
      if (request.method === "DELETE") {
        const sessionId = requireSession(request);
        sessions.delete(sessionId);
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405, { allow: "POST, DELETE" });
        response.end();
        return;
      }

      const incoming = await readJson(request, maxBodyBytes);
      if (Array.isArray(incoming)) {
        if (incoming.some((rpc) => rpc.method === "initialize")) {
          throw new HttpInputError(400, "initialize must be a single request");
        }
        const sessionId = requireSession(request);
        const replies = (await Promise.all(incoming.map((rpc) => rpcEnvelope(options.dispatcher, rpc))))
          .filter((reply): reply is JsonObject => reply !== undefined);
        if (replies.length === 0) {
          response.writeHead(202, { "mcp-session-id": sessionId, "cache-control": "no-store" });
          response.end();
        } else {
          writeJson(response, 200, boundBatchReplies(replies), { "mcp-session-id": sessionId });
        }
        return;
      }
      const rpc = incoming;
      let sessionId: string;
      const initializing = rpc.method === "initialize";
      if (initializing) {
        if (rpc.id === undefined) throw new HttpInputError(400, "initialize requires a JSON-RPC id");
        if (headerValue(request.headers["mcp-session-id"])) throw new HttpInputError(400, "initialize must not reuse a session");
        pruneSessions();
        if (sessions.size >= maxSessions) throw new HttpInputError(503, "session capacity reached");
        sessionId = uuid7();
        sessions.set(sessionId, { lastSeenAt: Date.now() });
      } else {
        sessionId = requireSession(request);
      }

      try {
        const result = await dispatchRpc(options.dispatcher, rpc);
        if (rpc.id === undefined) {
          response.writeHead(202, { "mcp-session-id": sessionId, "cache-control": "no-store" });
          response.end();
          return;
        }
        writeJson(response, 200, { jsonrpc: "2.0", id: rpc.id, result }, { "mcp-session-id": sessionId });
      } catch (error) {
        const code = error instanceof RpcError ? error.code : -32603;
        if (initializing) sessions.delete(sessionId);
        if (rpc.id === undefined) {
          response.writeHead(202, { "cache-control": "no-store" });
          response.end();
          return;
        }
        writeJson(response, 200, {
          jsonrpc: "2.0",
          id: validJsonRpcId(rpc.id) ? rpc.id ?? null : null,
          error: { code, message: rpcErrorMessage(error) }
        }, initializing ? {} : { "mcp-session-id": sessionId });
      }
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = error instanceof HttpInputError ? error.status : 500;
      const message = error instanceof HttpInputError ? error.message : "internal_error";
      if (error instanceof HttpInputError && error.closeConnection) {
        response.once("finish", () => request.destroy());
        writeJson(response, status, { error: message }, { connection: "close" });
      } else {
        writeJson(response, status, { error: message });
      }
    }).finally(() => {
      if (counted) activeRequests -= 1;
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

function positivePort(value: string | undefined): number {
  const parsed = Number(value ?? "3001");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error("PORT must be an integer from 1 to 65535");
  return parsed;
}

export async function startHttpServerFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<Server> {
  const token = env.NEUROMEM_MCP_TOKEN;
  if (!token || Buffer.byteLength(token, "utf8") < 16) {
    throw new Error("NEUROMEM_MCP_TOKEN must be at least 16 bytes");
  }
  const router = new FederatedMemoryRouter(loadRouterConfig(env));
  await router.ready();
  const dispatcher = new MemoryToolDispatcher(router);
  router.startRetryWorker();
  const server = createMcpHttpServer({
    dispatcher,
    bearerToken: token,
    maxBodyBytes: env.NEUROMEM_MCP_MAX_BODY_BYTES ? Number(env.NEUROMEM_MCP_MAX_BODY_BYTES) : undefined
  });
  const host = env.HOST || "127.0.0.1";
  const port = positivePort(env.PORT);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  managedRouters.set(server, router);
  return server;
}

export async function stopHttpServer(server: Server): Promise<void> {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  await managedRouters.get(server)?.close();
  managedRouters.delete(server);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void startHttpServerFromEnv().then((server) => {
    const shutdown = () => {
      void stopHttpServer(server).then(() => process.exit(0), () => process.exit(1));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }).catch((error: unknown) => {
    process.stderr.write(`MCP server failed: ${rpcErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
