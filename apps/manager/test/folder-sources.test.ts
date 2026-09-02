import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FolderSourceError, FolderSourceManager, MACOS_FOLDER_PICKER_SCRIPT } from "../src/folder-sources.js";
import type { CommandResult, CommandRunner, RunOptions } from "../src/types.js";
import { temporaryPaths } from "./helpers.js";

const context = { principal_id: "principal-1", workspace_id: "workspace-1", project_id: "project-1" };

test("macOS picker uses an argument array, stores only private raw state, and detaches by bound context", async t => {
  const { home: managerHome, paths } = await temporaryPaths("neuromem-folder-state-");
  const userHome = await fs.mkdtemp(path.join(os.homedir(), ".neuromem-folder-user-"));
  const selected = path.join(userHome, "dev", "neuromem");
  await fs.mkdir(selected, { recursive: true });
  t.after(async () => Promise.all([
    fs.rm(managerHome, { recursive: true, force: true }),
    fs.rm(userHome, { recursive: true, force: true }),
  ]).then(() => undefined));
  const runner = new ScriptedRunner([pickerSelection(selected)]);
  const manager = new FolderSourceManager({ paths, runner, platform: "darwin", home: userHome });

  const result = await manager.pick(context);
  assert.equal(result.cancelled, false);
  if (result.cancelled) return;
  assert.deepEqual(Object.keys(result.source).sort(), ["display_name", "display_path", "source_id", "status"]);
  assert.equal(result.source.display_name, "neuromem");
  assert.equal(result.source.display_path, "~/dev/neuromem");
  assert.equal(result.source.status, "active");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(escapeRegExp(selected)));

  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0]!.command, "/usr/bin/osascript");
  assert.deepEqual(runner.calls[0]!.args.slice(0, 3), ["-l", "JavaScript", "-e"]);
  assert.equal(runner.calls[0]!.args[3], MACOS_FOLDER_PICKER_SCRIPT);
  assert.ok(!runner.calls[0]!.args.some(argument => argument.includes(selected)));
  assert.deepEqual(runner.calls[0]!.options, { allowFailure: true, timeoutMs: 600_000 });

  const state = JSON.parse(await fs.readFile(paths.folderSources, "utf8")) as { sources: Array<Record<string, string>> };
  assert.equal((await fs.stat(paths.folderSources)).mode & 0o777, 0o600);
  assert.equal(state.sources[0]!.path, await fs.realpath(selected));
  assert.equal(state.sources[0]!.principal_id, context.principal_id);
  assert.equal(state.sources[0]!.workspace_id, context.workspace_id);
  assert.equal(state.sources[0]!.project_id, context.project_id);

  await assert.rejects(
    manager.detach({ ...context, project_id: "another-project" }, result.source.source_id),
    (error: unknown) => error instanceof FolderSourceError && error.code === "source_not_found",
  );
  await manager.detach(context, result.source.source_id);
  const detached = JSON.parse(await fs.readFile(paths.folderSources, "utf8")) as { sources: unknown[] };
  assert.deepEqual(detached.sources, []);
});

test("picker cancellation is quiet, non-macOS is unsupported, and concurrent dialogs are rejected", async t => {
  const { home: managerHome, paths } = await temporaryPaths("neuromem-folder-flow-");
  const userHome = await fs.mkdtemp(path.join(os.homedir(), ".neuromem-folder-user-"));
  t.after(async () => Promise.all([
    fs.rm(managerHome, { recursive: true, force: true }),
    fs.rm(userHome, { recursive: true, force: true }),
  ]).then(() => undefined));

  const cancelled = new ScriptedRunner([ok(JSON.stringify({ cancelled: true }))]);
  assert.deepEqual(await new FolderSourceManager({ paths, runner: cancelled, platform: "darwin", home: userHome }).pick(context), { cancelled: true });
  assert.equal(await fileExists(paths.folderSources), false);

  const classicCancel = new ScriptedRunner([{ ok: false, code: 1, stdout: "", stderr: "execution error: User canceled. (-128)" }]);
  assert.deepEqual(await new FolderSourceManager({ paths, runner: classicCancel, platform: "darwin", home: userHome }).pick(context), { cancelled: true });

  const unsupportedRunner = new ScriptedRunner([]);
  await assert.rejects(
    new FolderSourceManager({ paths, runner: unsupportedRunner, platform: "linux", home: userHome }).pick(context),
    (error: unknown) => error instanceof FolderSourceError && error.code === "unsupported_platform" && error.status === 501,
  );
  assert.equal(unsupportedRunner.calls.length, 0);

  let resolvePicker!: (result: CommandResult) => void;
  const pending = new Promise<CommandResult>(resolve => { resolvePicker = resolve; });
  const concurrentRunner = new ScriptedRunner([pending]);
  const concurrent = new FolderSourceManager({ paths, runner: concurrentRunner, platform: "darwin", home: userHome });
  const first = concurrent.pick(context);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(
    concurrent.pick(context),
    (error: unknown) => error instanceof FolderSourceError && error.code === "picker_busy" && error.status === 409,
  );
  resolvePicker(ok(JSON.stringify({ cancelled: true })));
  assert.deepEqual(await first, { cancelled: true });
});

test("folder validation canonicalizes symlinks and blocks broad, sensitive, and non-directory selections", async t => {
  const { home: managerHome, paths } = await temporaryPaths("neuromem-folder-validation-");
  const userHome = await fs.mkdtemp(path.join(os.homedir(), ".neuromem-folder-user-"));
  const ssh = path.join(userHome, ".ssh");
  const linkedSsh = path.join(userHome, "linked-secret");
  const regularFile = path.join(userHome, "file.txt");
  await fs.mkdir(ssh);
  await fs.symlink(ssh, linkedSsh);
  await fs.writeFile(regularFile, "not a directory");
  t.after(async () => Promise.all([
    fs.rm(managerHome, { recursive: true, force: true }),
    fs.rm(userHome, { recursive: true, force: true }),
  ]).then(() => undefined));
  const runner = new ScriptedRunner([
    pickerSelection("/"),
    pickerSelection(userHome),
    pickerSelection(ssh),
    pickerSelection(linkedSsh),
    pickerSelection(regularFile),
  ]);
  const manager = new FolderSourceManager({ paths, runner, platform: "darwin", home: userHome });

  for (const code of ["blocked_selection", "blocked_selection", "blocked_selection", "blocked_selection", "invalid_selection"]) {
    await assert.rejects(manager.pick(context), (error: unknown) => error instanceof FolderSourceError && error.code === code);
  }
  assert.equal(await fileExists(paths.folderSources), false);
});

test("one canonical folder cannot be connected to a different principal or Project", async t => {
  const { home: managerHome, paths } = await temporaryPaths("neuromem-folder-conflict-");
  const userHome = await fs.mkdtemp(path.join(os.homedir(), ".neuromem-folder-user-"));
  const selected = path.join(userHome, "project");
  await fs.mkdir(selected);
  t.after(async () => Promise.all([
    fs.rm(managerHome, { recursive: true, force: true }),
    fs.rm(userHome, { recursive: true, force: true }),
  ]).then(() => undefined));
  const manager = new FolderSourceManager({
    paths,
    runner: new ScriptedRunner([pickerSelection(selected), pickerSelection(selected)]),
    platform: "darwin",
    home: userHome,
  });
  await manager.pick(context);
  await assert.rejects(
    manager.pick({ ...context, principal_id: "principal-2" }),
    (error: unknown) => error instanceof FolderSourceError && error.code === "source_conflict" && error.status === 409,
  );
});

class ScriptedRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[]; options: RunOptions }> = [];
  constructor(private readonly results: Array<CommandResult | Promise<CommandResult>>) {}

  async run(command: string, args: readonly string[], options: RunOptions = {}): Promise<CommandResult> {
    this.calls.push({ command, args: [...args], options });
    const next = this.results.shift();
    if (!next) throw new Error("Unexpected command");
    return next;
  }
}

function pickerSelection(selectedPath: string): CommandResult {
  return ok(JSON.stringify({ cancelled: false, path: selectedPath }));
}

function ok(stdout: string): CommandResult {
  return { ok: true, code: 0, stdout, stderr: "" };
}

async function fileExists(target: string): Promise<boolean> {
  try { await fs.access(target); return true; } catch { return false; }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
