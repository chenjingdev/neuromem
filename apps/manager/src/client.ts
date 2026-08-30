import http from "node:http";
import type { ManagerPaths } from "./paths.js";

export class ManagerClient {
  constructor(private readonly paths: ManagerPaths) {}

  request<T>(method: string, route: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? "" : JSON.stringify(body);
      const request = http.request({
        socketPath: this.paths.socket,
        path: route,
        method,
        headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : undefined,
      }, response => {
        let raw = "";
        response.on("data", chunk => { raw += chunk.toString(); });
        response.on("end", () => {
          let parsed: unknown;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { return reject(new Error("Node Manager returned invalid JSON")); }
          if ((response.statusCode || 500) >= 400) {
            return reject(new Error((parsed as { error?: string } | null)?.error || `Node Manager returned HTTP ${response.statusCode}`));
          }
          resolve(parsed as T);
        });
      });
      request.on("error", reject);
      if (payload) request.end(payload);
      else request.end();
    });
  }

  health(): Promise<{ ok: boolean }> {
    return this.request("GET", "/health");
  }
}
