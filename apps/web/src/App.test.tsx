import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
      if (url.endsWith("/health")) return { node, docker_available: true, phase: "ready", components: [{ name: "database", state: "running", health: "healthy" }], endpoints: { api: "http://127.0.0.1:18001" }, models: { embedding: { configured: true, model: "qwen3-embedding:4b", provider_status: "ready", provider_detail: null, last_probe_at: "2026-08-31T00:30:00Z" }, extraction: { configured: false, provider_status: "unconfigured", provider_detail: "generation provider not configured", last_probe_at: null } } };
      if (url.endsWith("/models")) return modelSelection({ activeSource: null, embeddingModel: "qwen3-embedding:4b", embeddingModels: ["qwen3-embedding:4b"] });
      if (url.endsWith("/backlog")) return { node_id: "node-1", available: true, pending: 0, running: 0, failed: 0 };
      if (url.endsWith("/backups")) return { node_id: "node-1", backups: [] };
      if (url.includes("/logs?")) return { logs: [] };
      throw new Error(`Unexpected URL ${url}`);
    });
    render(<App />);
    expect(await screen.findByText("모든 핵심 구성요소가 정상입니다.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Node 시작" })).not.toBeInTheDocument();
    expect(screen.getByText("http://127.0.0.1:18001")).toBeInTheDocument();
    expect(screen.getByText("로컬 AI 상태")).toBeInTheDocument();
    expect(screen.getByLabelText("임베딩 모델 선택")).toHaveValue("qwen3-embedding:4b");
    expect(screen.getByText("생성 모델 연결 방식을 선택하세요.")).toBeInTheDocument();
    expect(screen.getByText("Core에서 최근 모델 연결을 정상 확인했습니다.")).toBeInTheDocument();
    expect(screen.getByText("모델 주소와 이름이 설정되지 않았습니다.")).toBeInTheDocument();
  });

  it("keeps an undiscovered embedding model and applies only an explicitly selected replacement after confirmation", async () => {
    window.history.replaceState(null, "", "/admin");
    const node = { node_id: "node-1", alias: "Personal", ports: { api: 18001, dashboard: 14173, mcp: 18765 }, generation: 1, desired_state: "running", phase: "degraded", compose_project: "neuromem-personal", schema_revision: "0001", created_at: "2026-08-31T00:00:00Z", updated_at: "2026-08-31T00:00:00Z" };
    const postBodies: unknown[] = [];
    const reads = { health: 0, models: 0, backlog: 0, backups: 0 };
    let embeddingModel = "legacy-embed";
    mockFetch((url, init) => {
      if (url.endsWith("/v1/nodes")) return { nodes: [node] };
      if (url.endsWith("/health")) {
        reads.health += 1;
        return { node, docker_available: true, phase: "degraded", components: [{ name: "database", state: "running", health: "healthy" }], endpoints: {}, models: { embedding: { configured: true, model: "legacy-embed", provider_status: "configured", provider_detail: null, last_probe_at: null }, extraction: { configured: false, provider_status: "unconfigured", provider_detail: null, last_probe_at: null } } };
      }
      if (url.endsWith("/models") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        postBodies.push(body);
        embeddingModel = body.embedding_model;
        return { ok: true, state: "succeeded", result: { restarted: true } };
      }
      if (url.endsWith("/models")) {
        reads.models += 1;
        return modelSelection({ activeSource: null, embeddingModel, embeddingModels: ["embed-new"] });
      }
      if (url.endsWith("/backlog")) { reads.backlog += 1; return { node_id: "node-1", available: true, pending: 0, running: 0, failed: 0 }; }
      if (url.endsWith("/backups")) { reads.backups += 1; return { node_id: "node-1", backups: [] }; }
      if (url.includes("/logs?")) return { logs: [] };
      throw new Error(`Unexpected URL ${url}`);
    });

    render(<App />);
    const embedding = await screen.findByLabelText("임베딩 모델 선택");
    const apply = screen.getByRole("button", { name: "변경 적용" });
    expect(embedding).toHaveValue("legacy-embed");
    expect(screen.getByRole("option", { name: "legacy-embed (현재 설정 · 감지되지 않음)" })).toBeInTheDocument();
    expect(apply).toBeDisabled();

    fireEvent.change(embedding, { target: { value: "embed-new" } });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    let dialog = screen.getByRole("dialog", { name: "모델 변경을 적용할까요?" });
    expect(dialog).toHaveTextContent("임베딩: legacy-embed → embed-new");
    expect(dialog).toHaveTextContent("Node 전체가 재시작");
    const cancel = within(dialog).getByRole("button", { name: "취소" });
    expect(cancel).toHaveFocus();
    fireEvent.click(cancel);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(postBodies).toHaveLength(0);

    fireEvent.click(apply);
    dialog = screen.getByRole("dialog", { name: "모델 변경을 적용할까요?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "적용하고 재시작" }));
    await waitFor(() => expect(postBodies).toEqual([{ embedding_model: "embed-new" }]));
    expect(await screen.findByText("모델 설정을 저장하고 Node를 재시작했습니다.")).toBeInTheDocument();
    await waitFor(() => {
      expect(reads.health).toBeGreaterThanOrEqual(2);
      expect(reads.models).toBeGreaterThanOrEqual(2);
      expect(reads.backlog).toBeGreaterThanOrEqual(2);
      expect(reads.backups).toBeGreaterThanOrEqual(2);
    });
  });

  it("disables an unavailable embedding catalog and leaves generation unselected", async () => {
    window.history.replaceState(null, "", "/admin");
    const node = { node_id: "node-1", alias: "Personal", ports: { api: 18001, dashboard: 14173, mcp: 18765 }, generation: 1, desired_state: "running", phase: "degraded", compose_project: "neuromem-personal", schema_revision: "0001", created_at: "2026-08-31T00:00:00Z", updated_at: "2026-08-31T00:00:00Z" };
    mockFetch(url => {
      if (url.endsWith("/v1/nodes")) return { nodes: [node] };
      if (url.endsWith("/health")) return { node, docker_available: true, phase: "degraded", components: [], endpoints: {}, models: { embedding: { configured: true, model: "qwen3-embedding:4b", provider_status: "configured", provider_detail: null, last_probe_at: null }, extraction: { configured: false, provider_status: "unconfigured", provider_detail: null, last_probe_at: null } } };
      if (url.endsWith("/models")) return modelSelection({ activeSource: null, embeddingModel: "qwen3-embedding:4b", embeddingModels: [], embeddingDiagnostic: "설치된 2560차원 임베딩 모델이 없습니다." });
      if (url.endsWith("/backlog")) return { node_id: "node-1", available: true, pending: 0, running: 0, failed: 0 };
      if (url.endsWith("/backups")) return { node_id: "node-1", backups: [] };
      if (url.includes("/logs?")) return { logs: [] };
      throw new Error(`Unexpected URL ${url}`);
    });

    render(<App />);
    const embedding = await screen.findByLabelText("임베딩 모델 선택");
    expect(embedding).toBeDisabled();
    expect(embedding).toHaveValue("qwen3-embedding:4b");
    expect(screen.queryByLabelText("생성 모델 선택 또는 입력")).not.toBeInTheDocument();
    expect(screen.getByText("생성 모델 연결 방식을 선택하세요.")).toBeInTheDocument();
    expect(screen.getByText(/설치된 2560차원 임베딩 모델이 없습니다/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "변경 적용" })).toBeDisabled();
  });

  it("keeps the selected draft and reports an apply failure without refreshing status", async () => {
    window.history.replaceState(null, "", "/admin");
    const node = { node_id: "node-1", alias: "Personal", ports: { api: 18001, dashboard: 14173, mcp: 18765 }, generation: 1, desired_state: "running", phase: "degraded", compose_project: "neuromem-personal", schema_revision: "0001", created_at: "2026-08-31T00:00:00Z", updated_at: "2026-08-31T00:00:00Z" };
    const reads = { health: 0, models: 0, backlog: 0, backups: 0 };
    mockFetch((url, init) => {
      if (url.endsWith("/v1/nodes")) return { nodes: [node] };
      if (url.endsWith("/health")) { reads.health += 1; return { node, docker_available: true, phase: "degraded", components: [], endpoints: {}, models: { embedding: { configured: true, model: "embed", provider_status: "configured", provider_detail: null, last_probe_at: null }, extraction: { configured: false, provider_status: "unconfigured", provider_detail: null, last_probe_at: null } } }; }
      if (url.endsWith("/models") && init?.method === "POST") throw new Error("모델 적용에 실패했습니다.");
      if (url.endsWith("/models")) { reads.models += 1; return modelSelection({ activeSource: null, embeddingModel: "embed", embeddingModels: ["embed", "embed-new"] }); }
      if (url.endsWith("/backlog")) { reads.backlog += 1; return { node_id: "node-1", available: true, pending: 0, running: 0, failed: 0 }; }
      if (url.endsWith("/backups")) { reads.backups += 1; return { node_id: "node-1", backups: [] }; }
      if (url.includes("/logs?")) return { logs: [] };
      throw new Error(`Unexpected URL ${url}`);
    });

    render(<App />);
    const embedding = await screen.findByLabelText("임베딩 모델 선택");
    fireEvent.change(embedding, { target: { value: "embed-new" } });
    fireEvent.click(screen.getByRole("button", { name: "변경 적용" }));
    const dialog = screen.getByRole("dialog", { name: "모델 변경을 적용할까요?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "적용하고 재시작" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("모델 적용에 실패했습니다.");
    expect(embedding).toHaveValue("embed-new");
    expect(screen.getByRole("button", { name: "변경 적용" })).toBeEnabled();
    expect(reads).toEqual({ health: 1, models: 1, backlog: 1, backups: 1 });
  });

  it("locks embedding changes for a stopped Node while allowing a generation model for the next start", async () => {
    window.history.replaceState(null, "", "/admin");
    const node = { node_id: "node-1", alias: "Personal", ports: { api: 18001, dashboard: 14173, mcp: 18765 }, generation: 1, desired_state: "stopped", phase: "stopped", compose_project: "neuromem-personal", schema_revision: "0001", created_at: "2026-08-31T00:00:00Z", updated_at: "2026-08-31T00:00:00Z" };
    const postBodies: unknown[] = [];
    mockFetch((url, init) => {
      if (url.endsWith("/v1/nodes")) return { nodes: [node] };
      if (url.endsWith("/health")) return { node, docker_available: true, phase: "stopped", components: [{ name: "core", state: "exited" }], endpoints: {}, models: { embedding: { configured: true, model: "embed-old", provider_status: "configured", provider_detail: null, last_probe_at: null }, extraction: { configured: true, model: "generate-old", provider_status: "configured", provider_detail: null, last_probe_at: null } } };
      if (url.endsWith("/generation/probe") && init?.method === "POST") return { source: "openai_compatible", available_models: ["generate-old", "generate-new"], model_compatible: true, diagnostic: null };
      if (url.endsWith("/models") && init?.method === "POST") { postBodies.push(JSON.parse(String(init.body))); return { ok: true, state: "succeeded", result: { restarted: false } }; }
      if (url.endsWith("/models")) return modelSelection({ activeSource: "openai_compatible", embeddingModel: "embed-old", embeddingModels: ["embed-old", "embed-new"], generationModel: "generate-old", directModels: ["generate-old", "generate-new"], directConfigured: true, directApiKeyConfigured: true });
      if (url.endsWith("/backlog")) return { node_id: "node-1", available: false, pending: 0, running: 0, failed: 0 };
      if (url.endsWith("/backups")) return { node_id: "node-1", backups: [] };
      if (url.includes("/logs?")) return { logs: [] };
      throw new Error(`Unexpected URL ${url}`);
    });

    render(<App />);
    const embedding = await screen.findByLabelText("임베딩 모델 선택");
    const generation = screen.getByLabelText("생성 모델 선택 또는 입력");
    expect(embedding).toBeDisabled();
    expect(screen.getByText("임베딩 모델 변경은 Node를 먼저 시작해야 합니다.")).toBeInTheDocument();
    expect(generation).toBeEnabled();
    fireEvent.change(embedding, { target: { value: "embed-new" } });
    fireEvent.change(generation, { target: { value: "generate-new" } });
    fireEvent.click(screen.getByRole("button", { name: "연결 확인" }));
    await screen.findByText("연결과 생성 모델의 JSON 호환성을 확인했습니다.");
    fireEvent.click(screen.getByRole("button", { name: "변경 적용" }));
    const dialog = screen.getByRole("dialog", { name: "모델 변경을 적용할까요?" });
    expect(dialog).not.toHaveTextContent("embed-new");
    expect(dialog).toHaveTextContent("다음 Node 시작부터 적용됩니다.");
    fireEvent.click(within(dialog).getByRole("button", { name: "변경 저장" }));

    await waitFor(() => expect(postBodies).toEqual([{ generation: { source: "openai_compatible", model: "generate-new", connection: { base_url: "http://127.0.0.1:11434/v1", api_key_action: "keep" } } }]));
    expect(await screen.findByText("모델 설정을 저장했습니다. 다음 Node 시작부터 적용됩니다.")).toBeInTheDocument();
  });

  it("rejects model choices returned for a different Node", async () => {
    window.history.replaceState(null, "", "/admin");
    const node = { node_id: "node-1", alias: "Personal", ports: { api: 18001, dashboard: 14173, mcp: 18765 }, generation: 1, desired_state: "running", phase: "degraded", compose_project: "neuromem-personal", schema_revision: "0001", created_at: "2026-08-31T00:00:00Z", updated_at: "2026-08-31T00:00:00Z" };
    mockFetch(url => {
      if (url.endsWith("/v1/nodes")) return { nodes: [node] };
      if (url.endsWith("/health")) return { node, docker_available: true, phase: "degraded", components: [], endpoints: {}, models: { embedding: { configured: true, model: "embed", provider_status: "configured", provider_detail: null, last_probe_at: null }, extraction: { configured: false, provider_status: "unconfigured", provider_detail: null, last_probe_at: null } } };
      if (url.endsWith("/models")) return { node_id: "node-2", embedding: { model: "other-embed", available_models: ["other-embed"], diagnostic: null }, generation: { model: "other-generate", available_models: ["other-generate"], diagnostic: null } };
      if (url.endsWith("/backlog")) return { node_id: "node-1", available: true, pending: 0, running: 0, failed: 0 };
      if (url.endsWith("/backups")) return { node_id: "node-1", backups: [] };
      if (url.includes("/logs?")) return { logs: [] };
      throw new Error(`Unexpected URL ${url}`);
    });

    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("현재 Node의 모델 목록을 확인하지 못했습니다.");
    expect(screen.getByLabelText("임베딩 모델 선택")).toBeDisabled();
    expect(screen.getByRole("radio", { name: /^Codex 로그인 사용/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /^API 직접 연결/ })).toBeDisabled();
    expect(screen.queryByRole("option", { name: "other-generate" })).not.toBeInTheDocument();
  });

  it("shows Codex sign-in guidance without exposing an unavailable generation choice", async () => {
    window.history.replaceState(null, "", "/admin");
    const node = adminNode();
    mockFetch(url => {
      if (url.endsWith("/v1/nodes")) return { nodes: [node] };
      if (url.endsWith("/health")) return adminHealth(node);
      if (url.endsWith("/models")) return modelSelection({
        activeSource: null,
        codexAuthStatus: "signed_out",
        codexDiagnostic: "Codex is not signed in with ChatGPT",
      });
      if (url.endsWith("/backlog")) return { node_id: "node-1", available: true, pending: 0, running: 0, failed: 0 };
      if (url.endsWith("/backups")) return { node_id: "node-1", backups: [] };
      if (url.includes("/logs?")) return { logs: [] };
      throw new Error(`Unexpected URL ${url}`);
    });

    render(<App />);
    expect(await screen.findByText("로컬 AI 상태")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "생성 모델 연결 방식" })).toBeInTheDocument();
    const codex = screen.getByRole("radio", { name: /^Codex 로그인 사용/ });
    const direct = screen.getByRole("radio", { name: /^API 직접 연결/ });
    expect(codex).not.toBeChecked();
    expect(direct).not.toBeChecked();

    fireEvent.click(codex);
    expect(await screen.findByText("터미널에서 codex login을 실행한 뒤 다시 확인하세요.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "새로 확인" })).toBeInTheDocument();
    expect(screen.getByLabelText("생성 모델 선택 또는 입력")).toBeDisabled();
    expect(screen.getByRole("button", { name: "변경 적용" })).toBeDisabled();
  });

  it("probes an API connection and applies a nested generation selection without revealing its key", async () => {
    window.history.replaceState(null, "", "/admin");
    const node = adminNode();
    const replacementKey = "replacement-secret-that-must-not-appear-in-confirmation";
    const probeBodies: unknown[] = [];
    const applyBodies: unknown[] = [];
    let appliedModel = "old-generation";
    mockFetch((url, init) => {
      if (url.endsWith("/v1/nodes")) return { nodes: [node] };
      if (url.endsWith("/health")) return adminHealth(node, appliedModel);
      if (url.endsWith("/generation/probe") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        probeBodies.push(body);
        return { source: "openai_compatible", available_models: ["old-generation", "new-generation"], model_compatible: Boolean(body.model), diagnostic: null, display_base_url: "http://127.0.0.1:11434/v1", api_key_configured: true };
      }
      if (url.endsWith("/models") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        applyBodies.push(body);
        appliedModel = body.generation.model;
        return { ok: true, state: "succeeded", result: { restarted: true } };
      }
      if (url.endsWith("/models")) return modelSelection({
        activeSource: "openai_compatible",
        generationModel: appliedModel,
        directModels: ["old-generation"],
        directConfigured: true,
        directApiKeyConfigured: true,
      });
      if (url.endsWith("/backlog")) return { node_id: "node-1", available: true, pending: 0, running: 0, failed: 0 };
      if (url.endsWith("/backups")) return { node_id: "node-1", backups: [] };
      if (url.includes("/logs?")) return { logs: [] };
      throw new Error(`Unexpected URL ${url}`);
    });

    render(<App />);
    expect(await screen.findByText("로컬 AI 상태")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("radio", { name: /^API 직접 연결/ })).toBeChecked());
    const baseUrl = screen.getByLabelText("API 기본 주소");
    const apiKey = screen.getByLabelText(/^API 키/);
    expect(baseUrl).toHaveValue("http://127.0.0.1:11434/v1");
    expect(apiKey).toHaveValue("");
    expect(apiKey).toHaveAttribute("type", "password");

    fireEvent.change(apiKey, { target: { value: replacementKey } });
    fireEvent.click(screen.getByRole("button", { name: "연결 확인" }));
    await waitFor(() => expect(probeBodies).toEqual([{
      source: "openai_compatible",
      model: "old-generation",
      connection: {
        base_url: "http://127.0.0.1:11434/v1",
        api_key_action: "replace",
        api_key: replacementKey,
      },
    }]));

    const generation = await screen.findByLabelText("생성 모델 선택 또는 입력");
    fireEvent.change(generation, { target: { value: "new-generation" } });
    expect(screen.getByRole("button", { name: "변경 적용" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "연결 확인" }));
    await waitFor(() => expect(probeBodies).toHaveLength(2));
    expect(probeBodies[1]).toEqual({
      source: "openai_compatible",
      model: "new-generation",
      connection: {
        base_url: "http://127.0.0.1:11434/v1",
        api_key_action: "replace",
        api_key: replacementKey,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "변경 적용" }));
    const dialog = screen.getByRole("dialog", { name: "모델 변경을 적용할까요?" });
    expect(dialog).toHaveTextContent("new-generation");
    expect(dialog).toHaveTextContent("API 키: 새 키로 교체");
    expect(dialog).not.toHaveTextContent(replacementKey);
    fireEvent.click(within(dialog).getByRole("button", { name: "적용하고 재시작" }));

    await waitFor(() => expect(applyBodies).toEqual([{
      generation: {
        source: "openai_compatible",
        model: "new-generation",
        connection: {
          base_url: "http://127.0.0.1:11434/v1",
          api_key_action: "replace",
          api_key: replacementKey,
        },
      },
    }]));
    expect(await screen.findByText("모델 설정을 저장하고 Node를 재시작했습니다.")).toBeInTheDocument();
  });

  it("keeps an unchanged keyless local API connection pristine", async () => {
    window.history.replaceState(null, "", "/admin");
    const node = adminNode();
    mockFetch(url => {
      if (url.endsWith("/v1/nodes")) return { nodes: [node] };
      if (url.endsWith("/health")) return adminHealth(node, "gpt-oss:20b");
      if (url.endsWith("/models")) return modelSelection({
        activeSource: "openai_compatible",
        generationModel: "gpt-oss:20b",
        directModels: ["gpt-oss:20b"],
        directConfigured: true,
        directApiKeyConfigured: false,
      });
      if (url.endsWith("/backlog")) return { node_id: "node-1", available: true, pending: 0, running: 0, failed: 0 };
      if (url.endsWith("/backups")) return { node_id: "node-1", backups: [] };
      if (url.includes("/logs?")) return { logs: [] };
      throw new Error(`Unexpected URL ${url}`);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByRole("radio", { name: /^API 직접 연결/ })).toBeChecked());
    expect(screen.getByText("저장된 API 키 없음")).toBeInTheDocument();
    expect(screen.getByLabelText(/API 키/)).toHaveValue("");
    expect(screen.getByRole("button", { name: "변경 적용" })).toBeDisabled();
  });

  it("switches to a signed-in Codex model without sending API connection fields", async () => {
    window.history.replaceState(null, "", "/admin");
    const node = adminNode();
    const probeBodies: unknown[] = [];
    const applyBodies: unknown[] = [];
    mockFetch((url, init) => {
      if (url.endsWith("/v1/nodes")) return { nodes: [node] };
      if (url.endsWith("/health")) return adminHealth(node, "old-generation");
      if (url.endsWith("/generation/probe") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        probeBodies.push(body);
        return { source: "codex_session", available_models: ["gpt-5.4", "gpt-5.4-mini"], model_compatible: true, diagnostic: null };
      }
      if (url.endsWith("/models") && init?.method === "POST") {
        applyBodies.push(JSON.parse(String(init.body)));
        return { ok: true, state: "succeeded", result: { restarted: true } };
      }
      if (url.endsWith("/models")) return modelSelection({
        activeSource: "openai_compatible",
        generationModel: "old-generation",
        directModels: ["old-generation"],
        directConfigured: true,
        directApiKeyConfigured: true,
        codexAuthStatus: "signed_in",
        codexModels: ["gpt-5.4", "gpt-5.4-mini"],
      });
      if (url.endsWith("/backlog")) return { node_id: "node-1", available: true, pending: 0, running: 0, failed: 0 };
      if (url.endsWith("/backups")) return { node_id: "node-1", backups: [] };
      if (url.includes("/logs?")) return { logs: [] };
      throw new Error(`Unexpected URL ${url}`);
    });

    render(<App />);
    const codex = await screen.findByRole("radio", { name: /^Codex 로그인 사용/ });
    fireEvent.click(codex);
    const generation = screen.getByLabelText("생성 모델 선택 또는 입력");
    expect(generation).toHaveValue("");
    fireEvent.change(generation, { target: { value: "gpt-5.4" } });
    expect(screen.getByRole("button", { name: "변경 적용" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "연결 확인" }));
    await waitFor(() => expect(probeBodies).toEqual([{ source: "codex_session", model: "gpt-5.4" }]));
    fireEvent.click(screen.getByRole("button", { name: "변경 적용" }));
    const dialog = screen.getByRole("dialog", { name: "모델 변경을 적용할까요?" });
    expect(dialog).toHaveTextContent("Codex 로그인");
    expect(dialog).toHaveTextContent("gpt-5.4");
    fireEvent.click(within(dialog).getByRole("button", { name: "적용하고 재시작" }));

    await waitFor(() => expect(applyBodies).toEqual([{
      generation: {
        source: "codex_session",
        model: "gpt-5.4",
      },
    }]));
    expect(JSON.stringify(applyBodies)).not.toContain("connection");
    expect(JSON.stringify(applyBodies)).not.toContain("api_key");
  });
});

function adminNode() {
  return { node_id: "node-1", alias: "Personal", ports: { api: 18001, dashboard: 14173, mcp: 18765 }, generation: 1, desired_state: "running", phase: "degraded", compose_project: "neuromem-personal", schema_revision: "0001", created_at: "2026-08-31T00:00:00Z", updated_at: "2026-08-31T00:00:00Z" };
}

function adminHealth(node: ReturnType<typeof adminNode>, generationModel: string | null = null) {
  return { node, docker_available: true, phase: "degraded", components: [{ name: "database", state: "running", health: "healthy" }], endpoints: {}, models: { embedding: { configured: true, model: "embed", provider_status: "configured", provider_detail: null, last_probe_at: null }, extraction: { configured: Boolean(generationModel), model: generationModel || undefined, provider_status: generationModel ? "configured" : "unconfigured", provider_detail: null, last_probe_at: null } } };
}

function modelSelection({
  activeSource,
  embeddingModel = "embed",
  embeddingModels = ["embed"],
  embeddingDiagnostic = null,
  generationModel = null,
  codexAuthStatus = "signed_out",
  codexModels = [],
  codexDiagnostic = null,
  directModels = [],
  directConfigured = false,
  directApiKeyConfigured = false,
}: {
  activeSource: "codex_session" | "openai_compatible" | null;
  embeddingModel?: string | null;
  embeddingModels?: string[];
  embeddingDiagnostic?: string | null;
  generationModel?: string | null;
  codexAuthStatus?: "signed_in" | "signed_out" | "expired" | "unavailable" | "unknown";
  codexModels?: string[];
  codexDiagnostic?: string | null;
  directModels?: string[];
  directConfigured?: boolean;
  directApiKeyConfigured?: boolean;
}) {
  return {
    node_id: "node-1",
    embedding: { model: embeddingModel, available_models: embeddingModels, diagnostic: embeddingDiagnostic },
    generation: {
      model: generationModel,
      available_models: activeSource === "codex_session" ? codexModels : directModels,
      diagnostic: null,
      active_source: activeSource,
      sources: {
        codex_session: {
          available: codexAuthStatus !== "unavailable",
          auth_status: codexAuthStatus,
          plan_type: null,
          available_models: codexModels,
          diagnostic: codexDiagnostic,
          last_checked_at: "2026-08-31T00:31:00Z",
        },
        openai_compatible: {
          configured: directConfigured,
          connection_origin: directConfigured ? "generation" : null,
          display_base_url: directConfigured ? "http://127.0.0.1:11434/v1" : null,
          api_key_configured: directApiKeyConfigured,
          model: activeSource === "openai_compatible" ? generationModel : null,
          available_models: directModels,
          diagnostic: null,
          last_checked_at: "2026-08-31T00:31:00Z",
        },
      },
    },
  };
}

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
