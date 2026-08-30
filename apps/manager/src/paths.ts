import os from "node:os";
import path from "node:path";

export interface ManagerPaths {
  home: string;
  manager: string;
  nodes: string;
  run: string;
  socket: string;
  registry: string;
  adminToken: string;
  adminNonces: string;
  managerLog: string;
}

export function resolveManagerPaths(env: NodeJS.ProcessEnv = process.env): ManagerPaths {
  const home = env.NEUROMEM_HOME
    ? path.resolve(env.NEUROMEM_HOME)
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "Neuromem")
      : path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "neuromem");
  const runtimeBase = env.NEUROMEM_RUNTIME_DIR
    ? path.resolve(env.NEUROMEM_RUNTIME_DIR)
    : env.XDG_RUNTIME_DIR
      ? path.join(env.XDG_RUNTIME_DIR, "neuromem")
      : path.join(home, "run");
  const manager = path.join(home, "manager");
  return {
    home,
    manager,
    nodes: path.join(home, "nodes"),
    run: runtimeBase,
    socket: path.join(runtimeBase, "manager.sock"),
    registry: path.join(manager, "registry.json"),
    adminToken: path.join(manager, "admin.token"),
    adminNonces: path.join(manager, "admin-nonces.json"),
    managerLog: path.join(manager, "manager.log"),
  };
}

export function nodeDirectory(paths: ManagerPaths, nodeId: string): string {
  return path.join(paths.nodes, nodeId);
}

export function nodeFile(paths: ManagerPaths, nodeId: string, name: string): string {
  return path.join(nodeDirectory(paths, nodeId), name);
}
