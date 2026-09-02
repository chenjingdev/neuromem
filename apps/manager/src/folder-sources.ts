import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWrite, ensurePrivateDirectory, exists } from "./fs-safe.js";
import type { ManagerPaths } from "./paths.js";
import type { CommandRunner } from "./types.js";

export interface ProjectFolderContext {
  principal_id: string;
  workspace_id: string;
  project_id: string;
}

export interface PublicFolderSource {
  source_id: string;
  display_name: string;
  display_path: string;
  status: "active";
}

export type FolderPickResult =
  | { cancelled: true }
  | { cancelled: false; source: PublicFolderSource };

interface StoredFolderSource extends ProjectFolderContext {
  source_id: string;
  path: string;
  display_name: string;
  created_at: string;
  updated_at: string;
}

interface FolderSourceFile {
  version: 1;
  sources: StoredFolderSource[];
}

export type FolderSourceErrorCode =
  | "unsupported_platform"
  | "picker_busy"
  | "picker_failed"
  | "invalid_selection"
  | "blocked_selection"
  | "source_conflict"
  | "source_not_found"
  | "invalid_store";

export class FolderSourceError extends Error {
  constructor(readonly code: FolderSourceErrorCode, readonly status: number, message: string) {
    super(message);
    this.name = "FolderSourceError";
  }
}

export interface FolderSourceManagerOptions {
  paths: ManagerPaths;
  runner: CommandRunner;
  platform?: NodeJS.Platform;
  home?: string;
  pickerTimeoutMs?: number;
}

/** Constant JXA program: no path, Project name, or user-controlled value is interpolated. */
export const MACOS_FOLDER_PICKER_SCRIPT = String.raw`
ObjC.import("AppKit");
function run() {
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  app.activateIgnoringOtherApps(true);
  const panel = $.NSOpenPanel.openPanel;
  panel.canChooseFiles = false;
  panel.canChooseDirectories = true;
  panel.allowsMultipleSelection = false;
  panel.resolvesAliases = true;
  panel.canCreateDirectories = false;
  panel.title = "Neuromem 프로젝트 폴더 선택";
  panel.prompt = "선택";
  const result = panel.runModal;
  if (Number(result) !== Number($.NSModalResponseOK)) return JSON.stringify({ cancelled: true });
  return JSON.stringify({ cancelled: false, path: ObjC.unwrap(panel.URL.path) });
}`.trim();

export class FolderSourceManager {
  readonly #paths: ManagerPaths;
  readonly #runner: CommandRunner;
  readonly #platform: NodeJS.Platform;
  readonly #home: string;
  readonly #pickerTimeoutMs: number;
  #pickerActive = false;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(options: FolderSourceManagerOptions) {
    this.#paths = options.paths;
    this.#runner = options.runner;
    this.#platform = options.platform || process.platform;
    this.#home = path.resolve(options.home || os.homedir());
    this.#pickerTimeoutMs = options.pickerTimeoutMs ?? 10 * 60_000;
  }

  async pick(context: ProjectFolderContext): Promise<FolderPickResult> {
    validateContext(context);
    if (this.#platform !== "darwin") {
      throw new FolderSourceError("unsupported_platform", 501, "Native folder selection is only available on macOS");
    }
    if (this.#pickerActive) throw new FolderSourceError("picker_busy", 409, "A folder selection is already in progress");
    this.#pickerActive = true;
    try {
      const result = await this.#runner.run(
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", MACOS_FOLDER_PICKER_SCRIPT],
        { allowFailure: true, timeoutMs: this.#pickerTimeoutMs },
      );
      if (!result.ok) {
        if (result.code === 1 && /(?:-128|user canceled|user cancelled|취소)/i.test(result.stderr)) return { cancelled: true };
        throw new FolderSourceError("picker_failed", 503, "The macOS folder picker could not be opened");
      }
      const selected = parsePickerResult(result.stdout);
      if (selected.cancelled) return { cancelled: true };
      const canonical = await canonicalDirectory(selected.path);
      await assertAllowedDirectory(canonical, this.#home, this.#paths.home);
      const stored = await this.attach(context, canonical);
      return { cancelled: false, source: publicSource(stored, this.#home) };
    } finally {
      this.#pickerActive = false;
    }
  }

  async detach(context: ProjectFolderContext, sourceId: string): Promise<void> {
    validateContext(context);
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(sourceId)) {
      throw new FolderSourceError("source_not_found", 404, "Folder source not found");
    }
    await this.serializedWrite(async () => {
      const state = await this.load();
      const index = state.sources.findIndex(source => sameContext(source, context));
      if (index < 0 || state.sources[index]!.source_id !== sourceId) {
        throw new FolderSourceError("source_not_found", 404, "Folder source not found");
      }
      state.sources.splice(index, 1);
      await this.save(state);
    });
  }

  private async attach(context: ProjectFolderContext, canonicalPath: string): Promise<StoredFolderSource> {
    return this.serializedWrite(async () => {
      const state = await this.load();
      const conflict = state.sources.find(source => source.path === canonicalPath && !sameContext(source, context));
      if (conflict) {
        throw new FolderSourceError("source_conflict", 409, "The selected folder is already connected to another Project");
      }
      const existingIndex = state.sources.findIndex(source => sameContext(source, context));
      const existing = existingIndex >= 0 ? state.sources[existingIndex]! : null;
      if (existing?.path === canonicalPath) return existing;
      const now = new Date().toISOString();
      const source: StoredFolderSource = {
        ...context,
        source_id: crypto.randomUUID(),
        path: canonicalPath,
        display_name: path.basename(canonicalPath),
        created_at: existing?.created_at || now,
        updated_at: now,
      };
      if (existingIndex >= 0) state.sources[existingIndex] = source;
      else state.sources.push(source);
      await this.save(state);
      return source;
    });
  }

  private async load(): Promise<FolderSourceFile> {
    if (!(await exists(this.#paths.folderSources))) return { version: 1, sources: [] };
    const info = await fs.lstat(this.#paths.folderSources).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > 5 * 1024 * 1024) {
      throw new FolderSourceError("invalid_store", 503, "The local folder source store is invalid");
    }
    await fs.chmod(this.#paths.folderSources, 0o600);
    let decoded: unknown;
    try {
      decoded = JSON.parse(await fs.readFile(this.#paths.folderSources, "utf8"));
    } catch {
      throw new FolderSourceError("invalid_store", 503, "The local folder source store is invalid");
    }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new FolderSourceError("invalid_store", 503, "The local folder source store is invalid");
    }
    const value = decoded as { version?: unknown; sources?: unknown };
    if (value.version !== 1 || !Array.isArray(value.sources) || value.sources.length > 10_000) {
      throw new FolderSourceError("invalid_store", 503, "The local folder source store is invalid");
    }
    const sources = value.sources.map(validateStoredSource);
    const keys = new Set<string>();
    const paths = new Set<string>();
    for (const source of sources) {
      const key = contextKey(source);
      if (keys.has(key) || paths.has(source.path)) throw new FolderSourceError("invalid_store", 503, "The local folder source store is invalid");
      keys.add(key);
      paths.add(source.path);
    }
    return { version: 1, sources };
  }

  private async save(state: FolderSourceFile): Promise<void> {
    await ensurePrivateDirectory(path.dirname(this.#paths.folderSources));
    await atomicWrite(this.#paths.folderSources, `${JSON.stringify(state, null, 2)}\n`, 0o600);
    await fs.chmod(this.#paths.folderSources, 0o600);
  }

  private serializedWrite<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#writeQueue.then(action);
    this.#writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function parsePickerResult(stdout: string): { cancelled: true } | { cancelled: false; path: string } {
  try {
    const value = JSON.parse(stdout) as { cancelled?: unknown; path?: unknown };
    if (value.cancelled === true) return { cancelled: true };
    if (value.cancelled !== false || typeof value.path !== "string" || value.path.length === 0 || value.path.length > 4096 || /[\0\r\n]/.test(value.path)) throw new Error();
    return { cancelled: false, path: value.path };
  } catch {
    throw new FolderSourceError("picker_failed", 503, "The macOS folder picker returned an invalid selection");
  }
}

async function canonicalDirectory(selectedPath: string): Promise<string> {
  try {
    const target = await fs.realpath(selectedPath);
    if (!(await fs.stat(target)).isDirectory()) throw new Error();
    return target;
  } catch {
    throw new FolderSourceError("invalid_selection", 400, "The selected item is not an accessible directory");
  }
}

async function assertAllowedDirectory(target: string, configuredHome: string, managerHome: string): Promise<void> {
  const home = await fs.realpath(configuredHome).catch(() => path.resolve(configuredHome));
  const stateHome = await fs.realpath(managerHome).catch(() => path.resolve(managerHome));
  const root = path.parse(target).root;
  const broadExact = [root, "/Network", "/Users", "/Volumes", "/cores", "/opt"];
  const absoluteBlocked = [
    "/Applications",
    "/Library",
    "/System",
    "/bin",
    "/dev",
    "/etc",
    "/private",
    "/sbin",
    "/usr",
    "/var",
  ];
  const homeBlocked = [
    path.join(home, ".aws"),
    path.join(home, ".azure"),
    path.join(home, ".claude"),
    path.join(home, ".codex"),
    path.join(home, ".config"),
    path.join(home, ".docker"),
    path.join(home, ".gnupg"),
    path.join(home, ".kube"),
    path.join(home, ".ssh"),
    path.join(home, "Library"),
    stateHome,
  ];
  if (broadExact.includes(target) || target === home || absoluteBlocked.some(blocked => target === blocked || isWithin(blocked, target)) || homeBlocked.some(blocked => target === blocked || isWithin(blocked, target))) {
    throw new FolderSourceError("blocked_selection", 400, "The selected directory is too broad or contains sensitive local data");
  }
  if ([".git", ".hg", ".svn"].includes(path.basename(target).toLowerCase())) {
    throw new FolderSourceError("blocked_selection", 400, "Repository metadata directories cannot be connected directly");
  }
}

function publicSource(source: StoredFolderSource, home: string): PublicFolderSource {
  return {
    source_id: source.source_id,
    display_name: source.display_name,
    display_path: displayPath(source.path, home),
    status: "active",
  };
}

function displayPath(target: string, home: string): string {
  const relative = path.relative(home, target);
  if (relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) {
    return `~/${relative.split(path.sep).join("/")}`;
  }
  return `…/${path.basename(target)}`;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validateContext(context: ProjectFolderContext): void {
  for (const value of [context.principal_id, context.workspace_id, context.project_id]) {
    if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\0\r\n]/.test(value)) {
      throw new FolderSourceError("invalid_selection", 400, "A complete Project context is required");
    }
  }
}

function sameContext(source: ProjectFolderContext, context: ProjectFolderContext): boolean {
  return source.principal_id === context.principal_id && source.workspace_id === context.workspace_id && source.project_id === context.project_id;
}

function contextKey(context: ProjectFolderContext): string {
  return `${context.principal_id}\0${context.workspace_id}\0${context.project_id}`;
}

function validateStoredSource(value: unknown): StoredFolderSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FolderSourceError("invalid_store", 503, "The local folder source store is invalid");
  const source = value as Record<string, unknown>;
  const required = ["source_id", "principal_id", "workspace_id", "project_id", "path", "display_name", "created_at", "updated_at"] as const;
  for (const key of required) {
    if (typeof source[key] !== "string" || source[key].length === 0 || source[key].length > 4096 || /[\0\r\n]/.test(source[key])) {
      throw new FolderSourceError("invalid_store", 503, "The local folder source store is invalid");
    }
  }
  if (!path.isAbsolute(source.path as string) || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(source.source_id as string)) {
    throw new FolderSourceError("invalid_store", 503, "The local folder source store is invalid");
  }
  if ([source.principal_id, source.workspace_id, source.project_id].some(item => (item as string).length > 256)) {
    throw new FolderSourceError("invalid_store", 503, "The local folder source store is invalid");
  }
  return source as unknown as StoredFolderSource;
}
