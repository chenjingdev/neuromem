import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { InternalAuthorizationError, verifyControlInternalAuthorization } from "../src/internal-auth.js";

const secret = "control-internal-signing-key-0123456789abcdef";
const context = {
  principal_id: "principal-1",
  credential_id: null,
  workspace_id: "workspace-1",
  project_id: "project-1",
  human_peer_id: "peer-1",
  agent_peer_id: null,
  capabilities: ["project.read", "project.write"],
  request_id: "request-1",
};

test("Control nmic1 verification accepts a current project-bound AuthContext", () => {
  const now = Date.now();
  const token = sign({ v: 1, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 60, context }, secret);
  assert.deepEqual(verifyControlInternalAuthorization(`Internal ${token}`, secret, now), context);
  assert.deepEqual(verifyControlInternalAuthorization(`internal ${token}`, secret, now), context);
});

test("Control nmic1 verification rejects tampering, expiry, wrong secrets, and incomplete scope", () => {
  const now = Date.now();
  const epoch = Math.floor(now / 1000);
  const valid = sign({ v: 1, iat: epoch, exp: epoch + 60, context }, secret);
  const cases: Array<() => unknown> = [
    () => verifyControlInternalAuthorization(undefined, secret, now),
    () => verifyControlInternalAuthorization(`Bearer ${valid}`, secret, now),
    () => verifyControlInternalAuthorization(`Internal ${valid}x`, secret, now),
    () => verifyControlInternalAuthorization(`Internal ${valid}`, "wrong-secret-that-is-still-at-least-32-bytes", now),
    () => verifyControlInternalAuthorization(`Internal ${sign({ v: 1, iat: epoch - 120, exp: epoch, context }, secret)}`, secret, now),
    () => verifyControlInternalAuthorization(`Internal ${sign({ v: 1, iat: epoch + 120, exp: epoch + 180, context }, secret)}`, secret, now),
    () => verifyControlInternalAuthorization(`Internal ${sign({ v: 1, iat: epoch, exp: epoch + 60, context: { ...context, project_id: null } }, secret)}`, secret, now),
    () => verifyControlInternalAuthorization(`Internal ${sign({ v: 1, iat: epoch, exp: epoch + 60, context: { ...context, capabilities: ["project.write", "project.write"] } }, secret)}`, secret, now),
  ];
  for (const attempt of cases) assert.throws(attempt, InternalAuthorizationError);
});

function sign(payload: unknown, signingKey: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", signingKey).update(encoded).digest("base64url");
  return `nmic1.${encoded}.${signature}`;
}
