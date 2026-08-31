import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { LocalCodexProvider, type CodexGenerationRequest } from "../src/codex-provider.js";
import { temporaryPaths } from "./helpers.js";

const REQUEST: CodexGenerationRequest = {
  model: "gpt-5.6-luna",
  messages: [{ role: "user", content: "Return ok." }],
  output_schema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  },
};

test("Codex children inherit only the login and network allowlist", { concurrency: false }, async t => {
  const { home, paths } = await temporaryPaths("neuromem-codex-env-test-");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const marker = `${home}/child-environment.json`;
  const binary = `${home}/fake-codex.cjs`;
  await executable(binary, `
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    if (args[0] !== "exec") process.exit(2);
    fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.env));
    const output = args[args.indexOf("--output-last-message") + 1];
    fs.writeFileSync(output, JSON.stringify({ ok: true }));
    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message" } }) + "\\n");
  `);

  const changes: Record<string, string> = {
    CODEX_HOME: `${home}/codex-home`,
    HTTPS_PROXY: "http://corporate-proxy.invalid:8080",
    NO_PROXY: "127.0.0.1,localhost",
    SSL_CERT_FILE: "/private/etc/corporate-ca.pem",
    LANG: "ko_KR.UTF-8",
    OPENAI_API_KEY: "must-not-reach-codex",
    ANTHROPIC_API_KEY: "must-not-reach-codex",
    GENERATION_DIRECT_API_KEY: "must-not-reach-codex",
    NEUROMEM_TEST_SECRET: "must-not-reach-codex",
    AWS_SECRET_ACCESS_KEY: "must-not-reach-codex",
    UNRELATED_APPLICATION_VALUE: "must-not-reach-codex",
  };
  const restore = replaceEnvironment(changes);
  t.after(restore);

  const provider = new LocalCodexProvider({ paths, binary, timeoutMs: 2_000 });
  t.after(() => provider.close());
  assert.equal(await provider.generateJson(REQUEST), '{"ok":true}');
  const inherited = JSON.parse(await fs.readFile(marker, "utf8")) as Record<string, string>;
  assert.equal(inherited.CODEX_HOME, changes.CODEX_HOME);
  assert.equal(inherited.HTTPS_PROXY, changes.HTTPS_PROXY);
  assert.equal(inherited.NO_PROXY, changes.NO_PROXY);
  assert.equal(inherited.SSL_CERT_FILE, changes.SSL_CERT_FILE);
  assert.equal(inherited.LANG, changes.LANG);
  for (const key of [
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GENERATION_DIRECT_API_KEY", "NEUROMEM_TEST_SECRET",
    "AWS_SECRET_ACCESS_KEY", "UNRELATED_APPLICATION_VALUE",
  ]) {
    assert.equal(inherited[key], undefined, `${key} must not be inherited`);
  }
});

test("Codex App Server stdin closure is handled without an unhandled EPIPE", async t => {
  const { home, paths } = await temporaryPaths("neuromem-codex-epipe-test-");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const binary = `${home}/fake-codex.cjs`;
  await executable(binary, `
    if (process.argv[2] !== "app-server") process.exit(2);
    process.stdin.once("data", () => {
      process.stdin.destroy();
      process.stdout.write(JSON.stringify({ id: 0, result: {} }) + "\\n");
      setTimeout(() => process.exit(0), 50);
    });
  `);
  const provider = new LocalCodexProvider({ paths, binary, timeoutMs: 2_000 });
  t.after(() => provider.close());
  const status = await provider.sessionStatus();
  assert.equal(status.auth_status, "unknown");
  assert.equal(status.diagnostic, "Could not read the Codex login session");
});

test("close escalates to SIGKILL and waits for the child close event", async t => {
  const { home, paths } = await temporaryPaths("neuromem-codex-close-test-");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const marker = `${home}/child-pid`;
  const binary = `${home}/fake-codex.cjs`;
  await executable(binary, `
    const fs = require("node:fs");
    if (process.argv[2] !== "exec") process.exit(2);
    fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
    process.on("SIGTERM", () => {});
    process.stdin.resume();
    setInterval(() => {}, 1000);
  `);
  const provider = new LocalCodexProvider({ paths, binary, timeoutMs: 10_000 });
  t.after(() => provider.close());
  const generation = provider.generateJson(REQUEST);
  void generation.catch(() => undefined);
  const pid = Number(await waitForFile(marker));
  await provider.close();
  await assert.rejects(generation, /Codex generation failed/);
  assert.throws(
    () => process.kill(pid, 0),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ESRCH"),
  );
});

async function executable(file: string, body: string): Promise<void> {
  await fs.writeFile(file, `#!/usr/bin/env node\n${body.trim()}\n`, { mode: 0o700 });
  await fs.chmod(file, 0o700);
}

async function waitForFile(file: string): Promise<string> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { return await fs.readFile(file, "utf8"); } catch {}
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${file}`);
}

function replaceEnvironment(changes: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(changes)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
