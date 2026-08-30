import crypto from "node:crypto";
import fs from "node:fs/promises";
import { atomicWrite, exists, readJson } from "./fs-safe.js";
import type { ManagerPaths } from "./paths.js";

interface SignedPayload {
  type: "bootstrap" | "session";
  exp: number;
  nonce: string;
  node_id?: string;
}

export class AdminAuth {
  #secret: Buffer | null = null;
  #exchangeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly paths: ManagerPaths) {}

  async initialize(): Promise<void> {
    if (!(await exists(this.paths.adminToken))) {
      await atomicWrite(this.paths.adminToken, `${crypto.randomBytes(32).toString("base64url")}\n`);
    }
    await fs.chmod(this.paths.adminToken, 0o600);
    if (!(await exists(this.paths.adminNonces))) await atomicWrite(this.paths.adminNonces, "{}\n");
    await fs.chmod(this.paths.adminNonces, 0o600);
    this.#secret = Buffer.from((await fs.readFile(this.paths.adminToken, "utf8")).trim(), "base64url");
    if (this.#secret.length < 32) throw new Error("The Node Manager admin secret is invalid");
  }

  async issueBootstrap(nodeId?: string): Promise<string> {
    await this.ready();
    return this.sign({
      type: "bootstrap",
      exp: Date.now() + 60_000,
      nonce: crypto.randomBytes(18).toString("base64url"),
      node_id: nodeId,
    });
  }

  async exchangeBootstrap(token: string): Promise<string> {
    await this.ready();
    const payload = this.verify(token, "bootstrap");
    let failure: Error | null = null;
    const exchange = this.#exchangeQueue.then(async () => {
      const now = Date.now();
      const used: Record<string, number> = await readJson<Record<string, number>>(this.paths.adminNonces).catch(() => ({} as Record<string, number>));
      for (const [nonce, expiry] of Object.entries(used)) if (expiry < now) delete used[nonce];
      if (used[payload.nonce]) {
        failure = new Error("Bootstrap token has already been used");
        return;
      }
      used[payload.nonce] = payload.exp;
      await atomicWrite(this.paths.adminNonces, `${JSON.stringify(used)}\n`);
    });
    this.#exchangeQueue = exchange.catch(() => undefined);
    await exchange;
    if (failure) throw failure;
    return this.sign({
      type: "session",
      exp: Date.now() + 8 * 60 * 60_000,
      nonce: crypto.randomBytes(18).toString("base64url"),
      node_id: payload.node_id,
    });
  }

  async validateSession(token: string): Promise<boolean> {
    try {
      await this.ready();
      this.verify(token, "session");
      return true;
    } catch {
      return false;
    }
  }

  private async ready(): Promise<void> {
    if (!this.#secret) await this.initialize();
  }

  private sign(payload: SignedPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = crypto.createHmac("sha256", this.#secret!).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  private verify(token: string, type: SignedPayload["type"]): SignedPayload {
    const [encoded, provided] = token.split(".");
    if (!encoded || !provided) throw new Error("Malformed admin token");
    const expected = crypto.createHmac("sha256", this.#secret!).update(encoded).digest();
    const actual = Buffer.from(provided, "base64url");
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw new Error("Invalid admin token");
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SignedPayload;
    if (payload.type !== type || payload.exp < Date.now() || !payload.nonce) throw new Error("Expired or invalid admin token");
    return payload;
  }
}
