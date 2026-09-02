import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWrite, ensurePrivateDirectory } from "./fs-safe.js";
import type { ManagerPaths } from "./paths.js";
import type { CommandRunner } from "./types.js";

export async function installSupervisor(
  daemonPath: string,
  paths: ManagerPaths,
  runner: CommandRunner,
): Promise<{ installed: boolean; target?: string }> {
  if (process.env.NEUROMEM_NO_SUPERVISOR === "1") return { installed: false };
  const executablePath = supervisorEnvironmentPath();
  if (process.platform === "darwin") {
    const directory = path.join(os.homedir(), "Library", "LaunchAgents");
    await ensurePrivateDirectory(directory);
    const target = path.join(directory, "dev.neuromem.manager.plist");
    const plist = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      '<key>Label</key><string>dev.neuromem.manager</string>',
      `<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(daemonPath)}</string></array>`,
      '<key>RunAtLoad</key><true/>',
      '<key>KeepAlive</key><true/>',
      `<key>EnvironmentVariables</key><dict><key>NEUROMEM_HOME</key><string>${xml(paths.home)}</string><key>PATH</key><string>${xml(executablePath)}</string></dict>`,
      `<key>StandardOutPath</key><string>${xml(paths.managerLog)}</string>`,
      `<key>StandardErrorPath</key><string>${xml(paths.managerLog)}</string>`,
      '</dict></plist>',
      '',
    ].join("\n");
    await atomicWrite(target, plist);
    const uid = process.getuid?.();
    if (uid !== undefined) {
      await runner.run("launchctl", ["bootout", `gui/${uid}/dev.neuromem.manager`], { allowFailure: true });
      await runner.run("launchctl", ["bootstrap", `gui/${uid}`, target], { allowFailure: true });
      await runner.run("launchctl", ["kickstart", "-k", `gui/${uid}/dev.neuromem.manager`], { allowFailure: true });
    }
    return { installed: true, target };
  }
  if (process.platform === "linux") {
    const directory = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd", "user");
    await ensurePrivateDirectory(directory);
    const target = path.join(directory, "neuromem-manager.service");
    const unit = [
      "[Unit]",
      "Description=Neuromem Node Manager",
      "After=docker.service",
      "",
      "[Service]",
      `ExecStart=${systemdEscape(process.execPath)} ${systemdEscape(daemonPath)}`,
      `Environment=NEUROMEM_HOME=${systemdEscape(paths.home)}`,
      `Environment=PATH=${systemdEscape(executablePath)}`,
      "Restart=on-failure",
      "RestartSec=3",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
    await fs.writeFile(target, unit, { mode: 0o600 });
    await runner.run("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
    await runner.run("systemctl", ["--user", "enable", "--now", "neuromem-manager.service"], { allowFailure: true });
    return { installed: true, target };
  }
  return { installed: false };
}

export function supervisorEnvironmentPath(
  inherited = process.env.PATH,
  nodeExecutable = process.execPath,
): string {
  const entries = [
    path.dirname(nodeExecutable),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    ...String(inherited || "").split(path.delimiter),
  ].filter(Boolean);
  return [...new Set(entries)].join(path.delimiter);
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function systemdEscape(value: string): string {
  return value.replaceAll("\\", "\\x5c").replaceAll(" ", "\\x20");
}
