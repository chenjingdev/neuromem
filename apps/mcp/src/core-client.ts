import type { CoreNodeConfig, JsonObject } from "./types.js";

export class CoreRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;

  constructor(code: string, retryable: boolean, httpStatus?: number) {
    super(code);
    this.name = "CoreRequestError";
    this.code = code;
    this.retryable = retryable;
    this.httpStatus = httpStatus;
  }
}

export interface CoreRequestOptions {
  body?: JsonObject;
  query?: Record<string, string | number | boolean | undefined>;
  idempotencyKey?: string;
  expectJson?: boolean;
  maxResponseBytes?: number;
}

async function readJsonBounded(response: Response, maximum: number): Promise<unknown> {
  if (!response.body) throw new CoreRequestError("invalid_json_response", false, response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new CoreRequestError("response_too_large", false, response.status);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CoreRequestError("invalid_json_response", false, response.status);
  }
}

export class CoreClient {
  readonly nodeId: string;
  readonly #baseUrl: string;
  readonly #token?: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(node: CoreNodeConfig, timeoutMs: number, maxResponseBytes = 64 * 1_048_576) {
    this.nodeId = node.id;
    this.#baseUrl = node.baseUrl;
    this.#token = node.token;
    this.#timeoutMs = timeoutMs;
    this.#maxResponseBytes = maxResponseBytes;
  }

  async request(method: "GET" | "POST", path: string, options: CoreRequestOptions = {}): Promise<unknown> {
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.body) headers["content-type"] = "application/json";
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    timeout.unref?.();
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
        throw new CoreRequestError(`http_${response.status}`, retryable, response.status);
      }
      if (response.status === 204) return null;
      if (options.expectJson === false) {
        await response.body?.cancel();
        return { ok: true };
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        await response.body?.cancel();
        throw new CoreRequestError("invalid_json_response", false, response.status);
      }
      try {
        return await readJsonBounded(response, options.maxResponseBytes ?? this.#maxResponseBytes);
      } catch (error) {
        if (error instanceof CoreRequestError) throw error;
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          throw new CoreRequestError("timeout", true);
        }
        throw new CoreRequestError("invalid_json_response", false, response.status);
      }
    } catch (error) {
      if (error instanceof CoreRequestError) throw error;
      const code = controller.signal.aborted || (error instanceof Error && error.name === "AbortError")
        ? "timeout"
        : "network_error";
      throw new CoreRequestError(code, true);
    } finally {
      clearTimeout(timeout);
    }
  }
}
