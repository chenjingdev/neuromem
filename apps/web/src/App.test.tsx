import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const workspace = { id: "workspace-1", slug: "personal", name: "아람 개인", metadata: {}, created_at: "2026-08-31T00:00:00Z" };
const project = { id: "project-1", workspace_id: workspace.id, slug: "neuromem", name: "Neuromem", metadata: {}, created_at: "2026-08-31T00:00:00Z" };

describe("Neuromem web routes", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/app");
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("shows project health and MCP address immediately without setup steps", async () => {
    mockFetch(url => {
      if (url.endsWith("/v1/workspaces")) return { items: [workspace] };
      if (url.includes("/v1/workspaces/workspace-1/projects")) return { items: [project] };
      if (url.includes("/v1/projects/project-1/overview")) return { workspace_id: workspace.id, project_id: project.id, records: 28, claims: 7, sessions: 3, peers: 2, jobs: { pending: 0, running: 0, failed: 0 }, embedding_configured: true, extraction_configured: true, mcp_url: "http://127.0.0.1:18765/mcp" };
      if (url.includes("/v1/projects/project-1/claims")) return { items: [{ claim: { id: "claim-1", workspace_id: workspace.id, project_id: project.id, content: "근거가 있는 최근 주장", status: "active", derivation_method: "llm_extracted", occurred_at: "2026-08-31T00:00:00Z", created_at: "2026-08-31T00:00:00Z" }, evidence_count: 1 }] };
      throw new Error(`Unexpected URL ${url}`);
    });
    render(<App />);
    expect(await screen.findByText("기억의 현재 상태")).toBeInTheDocument();
    expect(screen.getByText("http://127.0.0.1:18765/mcp")).toBeInTheDocument();
    expect(screen.getByText("주소가 보이고 상태가 정상이라면 바로 사용할 수 있습니다.")).toBeInTheDocument();
    expect(screen.getByText("근거가 있는 최근 주장")).toBeInTheDocument();
    expect(screen.queryByText(/Enter/)).not.toBeInTheDocument();
  });

  it("shows one direct create form when no workspace exists", async () => {
    mockFetch(url => {
      if (url.endsWith("/v1/workspaces")) return { items: [] };
      throw new Error(`Unexpected URL ${url}`);
    });
    render(<App />);
    expect(await screen.findByText("첫 프로젝트를 만드세요.")).toBeInTheDocument();
    expect(screen.getByLabelText("Workspace 이름")).toBeInTheDocument();
    expect(screen.getByLabelText("Project 이름")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "바로 시작" })).toBeInTheDocument();
  });

  it("renders an accessible graph and drills from a relation into record evidence", async () => {
    window.history.replaceState(null, "", "/app/graph");
    mockFetch(url => {
      if (url.endsWith("/v1/workspaces")) return { items: [workspace] };
      if (url.includes("/v1/workspaces/workspace-1/projects")) return { items: [project] };
      if (url.includes("/v1/projects/project-1/graph")) return { nodes: [{ id: "project:1", type: "project", label: "Neuromem" }, { id: "decision:1", type: "decision", label: "Embedding" }], edges: [{ id: "edge-1", claim_id: "claim-1", source: "project:1", predicate: "USES", target: "decision:1" }] };
      if (url.includes("/v1/claims/claim-1/evidence")) return { claim: { id: "claim-1", project_id: project.id, content: "2560차원 임베딩을 사용한다", status: "active", derivation_method: "explicit", created_at: "2026-08-31T00:00:00Z" }, evidence: [{ source_id: "source-1", role: "supports", quote: "2560으로 정하자", record: { id: "record-1", kind: "message", content: "2560으로 정하자", occurred_at: "2026-08-31T00:00:00Z", source_app: "codex", project_id: project.id } }] };
      if (url.includes("/v1/records/record-1/context")) return { target_record_id: "record-1", records: [{ id: "record-1", kind: "message", content: "2560으로 정하자", occurred_at: "2026-08-31T00:00:00Z", source_app: "codex", project_id: project.id }] };
      throw new Error(`Unexpected URL ${url}`);
    });
    render(<App />);
    expect(await screen.findByRole("img", { name: "프로젝트 기억 관계 그래프" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Neuromem.*USES.*Embedding/ }));
    expect(await screen.findByText("2560차원 임베딩을 사용한다")).toBeInTheDocument();
    expect(screen.getByText("2560으로 정하자")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /supports.*2560으로 정하자/ }));
    expect(await screen.findByText("원본 기록")).toBeInTheDocument();
    expect(screen.getByText("codex")).toBeInTheDocument();
  });

  it("does not offer a start button when a Node is healthy", async () => {
    window.history.replaceState(null, "", "/admin");
    const node = { node_id: "node-1", alias: "Personal", ports: { api: 18001, dashboard: 14173, mcp: 18765 }, generation: 1, desired_state: "running", phase: "ready", compose_project: "neuromem-personal", schema_revision: "0001", created_at: "2026-08-31T00:00:00Z", updated_at: "2026-08-31T00:00:00Z" };
    mockFetch(url => {
      if (url.endsWith("/v1/nodes")) return { nodes: [node] };
      if (url.endsWith("/health")) return { node, docker_available: true, phase: "ready", components: [{ name: "database", state: "running", health: "healthy" }], endpoints: { api: "http://127.0.0.1:18001" } };
      if (url.endsWith("/backlog")) return { node_id: "node-1", available: true, pending: 0, running: 0, failed: 0 };
      if (url.endsWith("/backups")) return { node_id: "node-1", backups: [] };
      throw new Error(`Unexpected URL ${url}`);
    });
    render(<App />);
    expect(await screen.findByText("모든 핵심 구성요소가 정상입니다.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Node 시작" })).not.toBeInTheDocument();
    expect(screen.getByText("http://127.0.0.1:18001")).toBeInTheDocument();
  });
});

function mockFetch(resolve: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    try {
      const payload = resolve(url, init);
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    } catch (error) {
      return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "unexpected" }), { status: 500, headers: { "content-type": "application/json" } });
    }
  }));
}
