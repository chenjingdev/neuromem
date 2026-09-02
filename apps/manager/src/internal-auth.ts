import crypto from "node:crypto";

export interface ControlInternalContext {
  principal_id: string;
  credential_id: string | null;
  workspace_id: string;
  project_id: string;
  human_peer_id: string | null;
  agent_peer_id: string | null;
  capabilities: string[];
  request_id: string;
}

interface ControlInternalPayload {
  v: number;
  iat: number;
  exp: number;
  context: unknown;
}

export class InternalAuthorizationError extends Error {
  constructor() {
    super("Invalid internal authorization");
    this.name = "InternalAuthorizationError";
  }
}

/** Verify the short-lived nmic1 AuthContext envelope minted by Control. */
export function verifyControlInternalAuthorization(
  authorization: string | string[] | undefined,
  secret: string,
  now = Date.now(),
): ControlInternalContext {
  try {
    if (Array.isArray(authorization) || typeof authorization !== "string") throw new Error();
    if (Buffer.byteLength(secret, "utf8") < 32) throw new Error();
    const matched = authorization.match(/^Internal\s+(nmic1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i);
    if (!matched || matched[1]!.length > 32_768) throw new Error();
    const [version, encoded, provided] = matched[1]!.split(".");
    if (!version || version.toLowerCase() !== "nmic1" || !encoded || !provided || provided.length !== 43) throw new Error();

    const expected = crypto.createHmac("sha256", secret).update(encoded).digest();
    const actual = Buffer.from(provided, "base64url");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error();

    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ControlInternalPayload;
    const nowSeconds = Math.floor(now / 1000);
    if (payload.v !== 1 || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)) throw new Error();
    if (payload.iat > nowSeconds + 60 || payload.exp <= nowSeconds || payload.exp <= payload.iat || payload.exp - payload.iat > 300) throw new Error();
    return validateContext(payload.context);
  } catch {
    throw new InternalAuthorizationError();
  }
}

function validateContext(value: unknown): ControlInternalContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const context = value as Record<string, unknown>;
  const principalId = scopedString(context.principal_id);
  const workspaceId = scopedString(context.workspace_id);
  const projectId = scopedString(context.project_id);
  const requestId = scopedString(context.request_id);
  if (!Array.isArray(context.capabilities) || context.capabilities.length > 128) throw new Error();
  const capabilities = context.capabilities.map(capability => scopedString(capability, 128));
  if (new Set(capabilities).size !== capabilities.length) throw new Error();
  return {
    principal_id: principalId,
    credential_id: optionalString(context.credential_id),
    workspace_id: workspaceId,
    project_id: projectId,
    human_peer_id: optionalString(context.human_peer_id),
    agent_peer_id: optionalString(context.agent_peer_id),
    capabilities,
    request_id: requestId,
  };
}

function scopedString(value: unknown, maxLength = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\0\r\n]/.test(value)) throw new Error();
  return value;
}

function optionalString(value: unknown): string | null {
  return value === null || value === undefined ? null : scopedString(value);
}
