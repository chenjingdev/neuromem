import type { AuthContext, JsonObject } from "./types.js";

export class TeamGatewayError extends Error {
  constructor(readonly code: string, readonly httpStatus?: number, readonly retryable = false) {
    super(code);
    this.name = "TeamGatewayError";
  }
}

export interface TeamGatewayRequest {
  body?: JsonObject;
  query?: Record<string, string | number | boolean | undefined>;
  idempotencyKey?: string;
}

/**
 * Stateless transport to the signed Control Gateway. The caller supplies the
 * bearer for one request; this class never stores it on an instance or disk.
 */
export class TeamGatewayClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #ensuredProjects = new Set<string>();

  constructor(baseUrl: string, timeoutMs = 120_000, maxResponseBytes = 16 * 1_048_576) {
    let parsed: URL;
    try { parsed = new URL(baseUrl); }
    catch { throw new Error("team Gateway URL must be an HTTP(S) URL"); }
    if (!(["http:", "https:"] as string[]).includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("team Gateway URL must be an HTTP(S) URL without credentials");
    }
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#timeoutMs = timeoutMs;
    this.#maxResponseBytes = maxResponseBytes;
  }

  async request(
    method: "GET" | "POST",
    path: string,
    context: AuthContext,
    bearerToken: string,
    options: TeamGatewayRequest = {}
  ): Promise<unknown> {
    if (!path.startsWith("/api/v1/") || path.startsWith("//")) throw new Error("team Gateway path must stay under /api/v1");
    if (!bearerToken || /[\r\n\0]/.test(bearerToken)) throw new TeamGatewayError("invalid_credential");
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query || {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${bearerToken}`,
      "x-neuromem-workspace": context.workspace_id,
      "x-neuromem-project": context.project_id,
      ...(context.request_id ? { "x-request-id": context.request_id } : {})
    };
    if (options.body) headers["content-type"] = "application/json";
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    timer.unref?.();
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        redirect: "error",
        signal: controller.signal
      });
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        await response.body?.cancel();
        throw new TeamGatewayError(`gateway_http_${response.status}`, response.status, retryable);
      }
      if (response.status === 204) return null;
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) { await response.body?.cancel(); throw new TeamGatewayError("gateway_invalid_json"); }
      return await readBoundedJson(response, this.#maxResponseBytes);
    } catch (error) {
      if (error instanceof TeamGatewayError) throw error;
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw new TeamGatewayError("gateway_timeout", undefined, true);
      throw new TeamGatewayError("gateway_unavailable", undefined, true);
    } finally {
      clearTimeout(timer);
    }
  }

  async record(
    context: AuthContext,
    bearerToken: string,
    sessionId: string,
    body: JsonObject,
    idempotencyKey: string
  ): Promise<unknown> {
    const scopeKey = `${context.workspace_id}:${context.project_id}`;
    if (!this.#ensuredProjects.has(scopeKey)) {
      try {
        await this.request("POST", `/api/v1/memory/projects/${encodeURIComponent(context.project_id)}:ensure`, context, bearerToken, { body: { metadata: {}, configuration: {} } });
        this.#ensuredProjects.add(scopeKey);
      } catch (error) {
        // Existing Projects may be used by contributors who can write but lack
        // project.create. Control remains authoritative; continue to the
        // scoped session endpoint and let it decide whether provisioning exists.
        if (!(error instanceof TeamGatewayError) || error.httpStatus !== 403) throw error;
      }
    }
    const path = `/api/v1/memory/sessions/${encodeURIComponent(sessionId)}/messages`;
    try {
      return await this.request("POST", path, context, bearerToken, { body, idempotencyKey });
    } catch (error) {
      if (!(error instanceof TeamGatewayError) || error.httpStatus !== 404) throw error;
      await this.request("POST", "/api/v1/memory/sessions", context, bearerToken, {
        body: { session_id: sessionId, name: context.client || "Agent session", metadata: { source: "neuromem-mcp" } },
        idempotencyKey: `session:${context.project_id}:${sessionId}`
      });
      return this.request("POST", path, context, bearerToken, { body, idempotencyKey });
    }
  }
}

async function readBoundedJson(response: Response, maximum: number): Promise<unknown> {
  if (!response.body) throw new TeamGatewayError("gateway_invalid_json");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) { await reader.cancel(); throw new TeamGatewayError("gateway_response_too_large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new TeamGatewayError("gateway_invalid_json"); }
}
