import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const workspace = { id: "workspace-1", slug: "primary", name: "아람 Workspace", metadata: {}, created_at: "2026-08-31T00:00:00Z" };
const project = { id: "project-1", workspace_id: workspace.id, slug: "neuromem", name: "Neuromem", metadata: {}, created_at: "2026-08-31T00:00:00Z" };

describe("Neuromem web routes", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/app");
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("shows project health and MCP address immediately without setup steps", async () => {
    mockFetch(url => {
      if (url.endsWith("/api/v1/me")) return { principal: { id: "principal-1", email: "aram@example.com", display_name: "아람" }, context: { capabilities: ["project.read"] } };
      if (url.endsWith("/api/v1/workspaces")) return [workspace];
      if (url.includes("/api/v1/workspaces/workspace-1/projects")) return [project];
      if (url.includes("/api/v1/memory/conclusions")) return { items: [{ claim_id: "claim-1", project_id: project.id, content: "근거가 있는 최근 주장", status: "active", derivation_method: "deductive" }] };
      throw new Error(`Unexpected URL ${url}`);
    });
    render(<App />);
    expect(await screen.findByText("기억의 현재 상태")).toBeInTheDocument();
    const projectScope = screen.getByRole("region", { name: "현재 Project 범위" });
    expect(within(projectScope).getByLabelText("Workspace")).toHaveValue(workspace.id);
    expect(within(projectScope).getByLabelText("Project")).toHaveValue(project.id);
    expect(screen.getByText(`${window.location.origin}/mcp`)).toBeInTheDocument();
    expect(screen.getByText(/Credential에 묶인 Workspace/)).toBeInTheDocument();
    expect(screen.getByText("근거가 있는 최근 주장")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "그래프" })).not.toBeInTheDocument();
    const desktopSidebar = screen.getByRole("complementary", { name: "Neuromem 사이드바" });
    expect(desktopSidebar).not.toHaveAttribute("inert");
    expect(desktopSidebar).not.toHaveAttribute("aria-hidden");
  });

  it("normalizes the legacy /app/team route to /app/workspace", async () => {
    window.history.replaceState(null, "", "/app/team");
    mockFetch(url => {
      if (url.endsWith("/api/v1/me")) return { principal: { id: "principal-1", email: "aram@example.com", display_name: "아람" }, context: { capabilities: ["project.read"] } };
      if (url.endsWith("/api/v1/workspaces")) return [workspace];
      if (url.includes("/api/v1/workspaces/workspace-1/projects")) return [project];
      throw new Error(`Unexpected URL ${url}`);
    });

    render(<App />);
    await waitFor(() => expect(window.location.pathname).toBe("/app/workspace"));
    expect(await screen.findByRole("link", { name: "Workspace 관리" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByRole("region", { name: "현재 Workspace 범위" })).toBeInTheDocument();
  });

  it("changes the whole Project surface when its explicit scope changes", async () => {
    const projectTwo = { ...project, id: "project-2", slug: "research", name: "Research" };
    const workspaceTwo = { ...workspace, id: "workspace-2", slug: "external", name: "연구 Workspace" };
    const projectThree = { ...project, id: "project-3", workspace_id: workspaceTwo.id, slug: "models", name: "Models" };
    const seenScopes: string[] = [];
    mockFetch((url, init) => {
      if (url.endsWith("/api/v1/me")) return { principal: { id: "principal-1", email: "aram@example.com", display_name: "아람" }, context: { capabilities: ["project.read"] } };
      if (url.endsWith("/api/v1/workspaces")) return [workspace, workspaceTwo];
      if (url.includes("/api/v1/workspaces/workspace-1/projects")) return [project, projectTwo];
      if (url.includes("/api/v1/workspaces/workspace-2/projects")) return [projectThree];
      if (url.includes("/api/v1/memory/conclusions")) {
        const headers = init?.headers as Record<string, string>;
        const key = `${headers["x-neuromem-workspace"]}:${headers["x-neuromem-project"]}`;
        seenScopes.push(key);
        if (key === `${workspace.id}:${project.id}`) return { items: [{ claim_id: "claim-1", project_id: project.id, content: "첫 Project 주장", status: "active", derivation_method: "explicit" }] };
        if (key === `${workspace.id}:${projectTwo.id}`) return { items: [{ claim_id: "claim-2", project_id: projectTwo.id, content: "두 번째 Project 주장", status: "active", derivation_method: "explicit" }] };
        if (key === `${workspaceTwo.id}:${projectThree.id}`) return { items: [{ claim_id: "claim-3", project_id: projectThree.id, content: "다른 Workspace 주장", status: "active", derivation_method: "explicit" }] };
        throw new Error(`Mixed scope ${key}`);
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    render(<App />);
    expect(await screen.findByText("첫 Project 주장")).toBeInTheDocument();
    let projectScope = screen.getByRole("region", { name: "현재 Project 범위" });
    fireEvent.change(within(projectScope).getByLabelText("Project"), { target: { value: projectTwo.id } });
    expect(await screen.findByText("두 번째 Project 주장")).toBeInTheDocument();
    expect(screen.queryByText("첫 Project 주장")).not.toBeInTheDocument();

    projectScope = screen.getByRole("region", { name: "현재 Project 범위" });
    fireEvent.change(within(projectScope).getByLabelText("Workspace"), { target: { value: workspaceTwo.id } });
    expect(await screen.findByText("다른 Workspace 주장")).toBeInTheDocument();
    projectScope = screen.getByRole("region", { name: "현재 Project 범위" });
    expect(within(projectScope).getByLabelText("Workspace")).toHaveValue(workspaceTwo.id);
    expect(within(projectScope).getByLabelText("Project")).toHaveValue(projectThree.id);
    expect(seenScopes).toEqual([
      `${workspace.id}:${project.id}`,
      `${workspace.id}:${projectTwo.id}`,
      `${workspaceTwo.id}:${projectThree.id}`,
    ]);
  });

  it("supports login, first bootstrap, and invitation acceptance without storing a bearer", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/api/v1/me")) return new Response(JSON.stringify({ detail: "invalid authentication" }), { status: 401, headers: { "content-type": "application/json" } });
      if (url.endsWith("/api/v1/auth/bootstrap")) return new Response(JSON.stringify({ principal: { id: "p", email: "owner@example.com", display_name: "Owner" }, context: { capabilities: ["*"] }, workspace, general_project: project, recovery_credential: { token: "recovery-secret", credential: { token_prefix: "prefix" } } }), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error(`Unexpected URL ${url}`);
    }));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "최초 설정" }));
    fireEvent.change(screen.getByLabelText("이메일"), { target: { value: "owner@example.com" } });
    fireEvent.change(screen.getByLabelText("표시 이름"), { target: { value: "Owner" } });
    fireEvent.change(screen.getByLabelText("Workspace 이름"), { target: { value: "Main Workspace" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "very-secure-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Workspace 생성" }));
    expect(await screen.findByText("복구 키를 저장하세요")).toBeInTheDocument();
    expect(screen.getByText("recovery-secret")).toBeInTheDocument();
    expect(calls.find(call => call.url.endsWith("/auth/bootstrap"))?.body).toMatchObject({ email: "owner@example.com", workspace_name: "Main Workspace" });
    expect(localStorage.getItem("neuromem-token")).toBeNull();
    expect(sessionStorage.getItem("neuromem-token")).toBeNull();
  });

  it("prefills only local test login mode without submitting credentials", async () => {
    const prefill = { email: "tester@example.test", password: "fake-local-test-password" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/me")) return new Response(JSON.stringify({ detail: "invalid authentication" }), { status: 401, headers: { "content-type": "application/json" } });
      if (url.endsWith("/api/v1/auth/local-test-prefill")) return new Response(JSON.stringify(prefill), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText("이메일")).toHaveValue(prefill.email);
      expect(screen.getByLabelText("비밀번호")).toHaveValue(prefill.password);
    });

    fireEvent.click(screen.getByRole("button", { name: "최초 설정" }));
    expect(screen.getByRole("heading", { name: "첫 Workspace 만들기" })).toBeInTheDocument();
    expect(screen.getByLabelText("이메일")).toHaveValue("");
    expect(screen.getByLabelText("비밀번호")).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "기존 계정 로그인" }));
    expect(screen.getByLabelText("이메일")).toHaveValue(prefill.email);
    expect(screen.getByLabelText("비밀번호")).toHaveValue(prefill.password);

    fireEvent.click(screen.getByRole("button", { name: "초대 수락" }));
    expect(screen.getByRole("heading", { name: "Workspace 초대 수락" })).toBeInTheDocument();
    expect(screen.queryByLabelText("이메일")).not.toBeInTheDocument();
    expect(screen.getByLabelText("비밀번호")).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "기존 계정 로그인" }));
    expect(screen.getByLabelText("이메일")).toHaveValue(prefill.email);
    expect(screen.getByLabelText("비밀번호")).toHaveValue(prefill.password);
    expect(fetchMock.mock.calls.filter(call => String(call[0]).endsWith("/api/v1/auth/login"))).toHaveLength(0);
  });

  it("logs in through the HttpOnly product session and reloads the scoped product", async () => {
    let authenticated = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/me")) return new Response(JSON.stringify(authenticated
        ? { principal: { id: "principal-1", email: "aram@example.com", display_name: "아람" }, context: { capabilities: ["project.read"] } }
        : { detail: "invalid authentication" }), { status: authenticated ? 200 : 401, headers: { "content-type": "application/json" } });
      if (url.endsWith("/api/v1/auth/login")) { authenticated = true; return new Response(JSON.stringify({ principal: { id: "principal-1", email: "aram@example.com", display_name: "아람" }, context: { capabilities: ["workspace.create"] } }), { status: 200, headers: { "content-type": "application/json" } }); }
      if (url.endsWith("/api/v1/workspaces")) return new Response(JSON.stringify([workspace]), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/api/v1/workspaces/workspace-1/projects")) return new Response(JSON.stringify([project]), { status: 200, headers: { "content-type": "application/json" } });
      if (url.endsWith("/api/v1/memory/conclusions")) return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("이메일"), { target: { value: "aram@example.com" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "correct-password" } });
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));
    expect(await screen.findByText("기억의 현재 상태")).toBeInTheDocument();
    const loginCall = fetchMock.mock.calls.find(call => String(call[0]).endsWith("/auth/login"));
    expect(loginCall?.[1]).toMatchObject({ method: "POST", credentials: "include" });
    expect(localStorage.getItem("neuromem-token")).toBeNull();
  });

  it("accepts an invitation from /app/invite and shows the one-time recovery key", async () => {
    const inviteToken = "invite-token-that-is-at-least-thirty-two-characters";
    window.history.replaceState(null, "", `/app/invite?token=${inviteToken}`);
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/me")) return new Response(JSON.stringify({ detail: "invalid authentication" }), { status: 401, headers: { "content-type": "application/json" } });
      if (url.endsWith("/api/v1/auth/invitations:accept")) { bodies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ principal: { id: "p", email: "new@example.com", display_name: "New" }, context: { capabilities: ["project.read"] }, workspace, general_project: project, recovery_credential: { token: "invite-recovery-secret", credential: { token_prefix: "prefix" } } }), { status: 200, headers: { "content-type": "application/json" } }); }
      throw new Error(`Unexpected URL ${url}`);
    }));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Workspace 초대 수락" })).toBeInTheDocument();
    expect(screen.getByLabelText("초대 토큰")).toHaveValue(inviteToken);
    fireEvent.change(screen.getByLabelText("표시 이름"), { target: { value: "New Member" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "new-member-password" } });
    fireEvent.click(screen.getByRole("button", { name: "초대 수락" }));
    expect(await screen.findByText("invite-recovery-secret")).toBeInTheDocument();
    expect(bodies).toEqual([{ token: inviteToken, display_name: "New Member", password: "new-member-password" }]);
  });

  it("shows projects, Workspace membership, owner-agreed shares, and Node management in one platform", async () => {
    window.history.replaceState(null, "", "/app/workspace");
    const mutationCalls: string[] = [];
    mockFetch((url, init) => {
      if (url.endsWith("/api/v1/me")) return { principal: { id: "principal-1", email: "aram@example.com", display_name: "아람" }, context: { capabilities: ["*"] } };
      if (url.endsWith("/api/v1/workspaces")) return [workspace];
      if (url.includes("/api/v1/workspaces/workspace-1/projects")) return [project];
      if (url.endsWith("/api/v1/workspaces/workspace-1/members")) return [{ id: "member-1", workspace_id: workspace.id, principal_id: "principal-1", role: "owner", status: "active" }];
      if (url.endsWith("/api/v1/workspaces/workspace-1/peer-bindings")) return [{ principal_id: "principal-1", peer: { id: "018f0f86-4d65-7a3c-8f2c-123456789abc", workspace_id: workspace.id, name: "아람", kind: "human", status: "active" }, kind: "primary_human", status: "active" }, { principal_id: null, peer: { id: "018f0f86-4d66-7a3c-8f2c-123456789abc", workspace_id: workspace.id, name: "아람 Codex", kind: "agent", status: "active" }, kind: "agent_owner", client: "codex", owner_principal_id: "principal-1", status: "active" }, { principal_id: null, peer: { id: "018f0f86-4d67-7a3c-8f2c-123456789abc", workspace_id: workspace.id, name: "아람 Claude", kind: "agent", status: "active" }, kind: "agent_owner", client: "claude", owner_principal_id: "principal-1", status: "active" }];
      if (url.endsWith("/api/v1/credentials")) return [{ id: "credential-1", name: "Codex MCP", token_prefix: "nmem_abcd", kind: "mcp", workspace_id: workspace.id, project_ids: [project.id], principal_id: "principal-1", agent_peer_id: "018f0f86-4d66-7a3c-8f2c-123456789abc", capabilities: ["memory:read"] }];
      if (url.endsWith("/api/v1/projects/project-1/grants")) return { items: [] };
      if (url.endsWith("/api/v1/workspace-shares/share-1:approve") && init?.method === "POST") { mutationCalls.push(url); return { id: "share-1", owner_workspace_id: "workspace-2", owner_workspace_name: "External 연구", recipient_workspace_id: workspace.id, recipient_workspace_name: workspace.name, display_mode: "projects", project_refs: [{ id: "project-2", name: "공유 연구" }], owner_approved_at: "2026-08-31T00:00:00Z", recipient_approved_at: "2026-08-31T00:01:00Z", status: "active" }; }
      if (url.endsWith("/api/v1/workspace-shares")) return [{ id: "share-1", owner_workspace_id: "workspace-2", owner_workspace_name: "External 연구", recipient_workspace_id: workspace.id, recipient_workspace_name: workspace.name, display_mode: "projects", project_refs: [{ id: "project-2", name: "공유 연구" }], owner_approved_at: "2026-08-31T00:00:00Z", recipient_approved_at: null, status: "proposed" }];
      if (url.endsWith("/api/v1/workspace-projections")) return [
        { share_id: "share-workspace", owner_workspace_id: "workspace-3", owner_workspace_name: "연구소 Workspace", display_mode: "workspace", project_refs: [{ id: "project-3", name: "모델 연구" }] },
        { share_id: "share-project", owner_workspace_id: "workspace-4", owner_workspace_name: "디자인 Workspace", display_mode: "projects", project_refs: [{ id: "project-4", name: "공유 디자인" }] },
      ];
      if (url.includes("/api/v1/transfer-requests?")) return [{ id: "transfer-1", source_workspace_id: "workspace-2", source_project_id: "project-2", target_workspace_id: workspace.id, target_project_id: project.id, source_record_id: "record-1", provenance: { reason: "공유 승인된 설계 결정" }, status: "pending_target", created_at: "2026-08-31T00:00:00Z" }];
      if (url.endsWith("/api/v1/transfer-requests/transfer-1:approve") && init?.method === "POST") { mutationCalls.push(url); return { id: "transfer-1", source_workspace_id: "workspace-2", source_project_id: "project-2", target_workspace_id: workspace.id, target_project_id: project.id, source_record_id: "record-1", provenance: { reason: "공유 승인된 설계 결정" }, status: "approved" }; }
      throw new Error(`Unexpected URL ${url}`);
    });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Workspace 관리" })).toBeInTheDocument();
    const workspaceScope = screen.getByRole("region", { name: "현재 Workspace 범위" });
    expect(within(workspaceScope).getByLabelText("Workspace")).toHaveValue(workspace.id);
    expect(within(workspaceScope).queryByLabelText("Project")).not.toBeInTheDocument();
    const projectAccess = screen.getByRole("region", { name: "Project 연결과 권한" });
    expect(within(projectAccess).getByLabelText("관리할 Project")).toHaveValue(project.id);
    const nodeAdmin = new URL(screen.getByRole("link", { name: "Node 관리" }).getAttribute("href")!);
    expect(nodeAdmin.origin).toBe("http://127.0.0.1:14174");
    expect(nodeAdmin.pathname).toBe("/admin/");
    expect(nodeAdmin.searchParams.get("return_to")).toBe(`${window.location.origin}/app`);
    expect(screen.getByRole("heading", { name: "프로젝트" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Workspace 추가" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project 추가" })).toBeInTheDocument();
    expect(screen.getByText("Human Peer")).toBeInTheDocument();
    expect(screen.getByText("아람 Codex")).toBeInTheDocument();
    expect(screen.getByText("아람 Claude")).toBeInTheDocument();
    expect(screen.getByText("공유 승인된 설계 결정")).toBeInTheDocument();
    expect(screen.getByText("External 연구에서 보낸 요청")).toBeInTheDocument();
    expect(screen.getByText("연구소 Workspace")).toBeInTheDocument();
    expect(screen.getByText("모델 연구")).toBeInTheDocument();
    expect(screen.getByText("공유 디자인")).toBeInTheDocument();
    expect(screen.getByText("디자인 Workspace")).toBeInTheDocument();

    const agreements = screen.getByRole("heading", { name: "공유 합의와 관리" }).parentElement;
    fireEvent.click(within(agreements!).getByRole("button", { name: "승인" }));
    await waitFor(() => expect(mutationCalls).toHaveLength(1));
    expect(await screen.findByText("공유를 승인했습니다.")).toBeInTheDocument();
  });

  it("opens the project folder picker only on request and preserves the binding when selection is cancelled", async () => {
    window.history.replaceState(null, "", "/app/workspace");
    const firstFolder = { id: "folder-1", project_id: project.id, display_name: "neuromem", display_path: "~/dev/neuromem", status: "active", updated_at: "2026-09-01T01:00:00Z" };
    const replacement = { ...firstFolder, id: "folder-2", display_name: "neuromem-next", display_path: "~/work/neuromem-next", updated_at: "2026-09-01T01:01:00Z" };
    let binding: typeof firstFolder | null = null;
    let pickerCalls = 0;
    let resolveFirstPick: ((value: typeof firstFolder) => void) | undefined;
    const firstPick = new Promise<typeof firstFolder>(resolve => { resolveFirstPick = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/me")) return jsonResponse({ principal: { id: "principal-1", email: "aram@example.com", display_name: "아람" }, context: { capabilities: ["*"] } });
      if (url.endsWith("/api/v1/workspaces")) return jsonResponse([workspace]);
      if (url.includes("/api/v1/workspaces/workspace-1/projects")) return jsonResponse([project]);
      if (url.endsWith("/api/v1/workspaces/workspace-1/members") || url.endsWith("/api/v1/workspaces/workspace-1/peer-bindings") || url.endsWith("/api/v1/credentials") || url.endsWith("/api/v1/workspace-shares") || url.endsWith("/api/v1/workspace-projections") || url.includes("/api/v1/transfer-requests?")) return jsonResponse([]);
      if (url.endsWith("/api/v1/projects/project-1/grants")) return jsonResponse({ items: [] });
      if (url.endsWith("/api/v1/projects/project-1/local-folder:pick") && init?.method === "POST") {
        pickerCalls += 1;
        if (pickerCalls === 1) { binding = await firstPick; return jsonResponse(binding); }
        if (pickerCalls === 2) return jsonResponse(null);
        binding = replacement;
        return jsonResponse(binding);
      }
      if (url.endsWith("/api/v1/projects/project-1/local-folder") && init?.method === "DELETE") { binding = null; return jsonResponse({ ok: true }); }
      if (url.endsWith("/api/v1/projects/project-1/local-folder")) return jsonResponse(binding);
      return jsonResponse({ error: `Unexpected URL ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    const folderCard = (await screen.findByRole("heading", { name: "로컬 프로젝트 폴더" })).closest("section")!;
    const select = await within(folderCard).findByRole("button", { name: "폴더 선택…" });
    expect(pickerCalls).toBe(0);

    fireEvent.click(select);
    const waiting = within(folderCard).getByRole("button", { name: "선택창을 기다리는 중…" });
    expect(waiting).toBeDisabled();
    fireEvent.click(waiting);
    expect(pickerCalls).toBe(1);
    resolveFirstPick?.(firstFolder);

    expect(await within(folderCard).findByText(firstFolder.display_path)).toBeInTheDocument();
    expect(within(folderCard).getByText("연결됨")).toBeInTheDocument();
    fireEvent.click(within(folderCard).getByRole("button", { name: "폴더 변경…" }));
    await waitFor(() => expect(pickerCalls).toBe(2));
    expect(within(folderCard).getByText(firstFolder.display_path)).toBeInTheDocument();
    expect(within(folderCard).queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(within(folderCard).getByRole("button", { name: "폴더 변경…" }));
    expect(await within(folderCard).findByText(replacement.display_path)).toBeInTheDocument();
    expect(within(folderCard).queryByText(firstFolder.display_path)).not.toBeInTheDocument();
    fireEvent.click(within(folderCard).getByRole("button", { name: "연결 해제" }));
    expect(await within(folderCard).findByText("연결된 폴더가 없습니다.")).toBeInTheDocument();

    const pickerRequests = fetchMock.mock.calls.filter(call => String(call[0]).endsWith("/local-folder:pick"));
    expect(pickerRequests).toHaveLength(3);
    expect(pickerRequests[0]?.[1]).toMatchObject({ method: "POST", credentials: "include", body: "{}" });
    expect((pickerRequests[0]?.[1]?.headers as Record<string, string>)["x-neuromem-workspace"]).toBe(workspace.id);
    expect((pickerRequests[0]?.[1]?.headers as Record<string, string>)["x-neuromem-project"]).toBe(project.id);
    expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith("/local-folder") && call[1]?.method === "DELETE")).toBe(true);
  });

  it("discards a late folder response after the selected Project changes", async () => {
    window.history.replaceState(null, "", "/app/workspace");
    const projectTwo = { ...project, id: "project-2", slug: "research", name: "Research" };
    const staleFolder = { id: "folder-old", project_id: project.id, display_name: "old", display_path: "~/dev/old", status: "active", updated_at: "2026-09-01T01:00:00Z" };
    const currentFolder = { id: "folder-current", project_id: projectTwo.id, display_name: "research", display_path: "~/dev/research", status: "active", updated_at: "2026-09-01T01:01:00Z" };
    let resolveStale: ((value: typeof staleFolder) => void) | undefined;
    const staleResponse = new Promise<typeof staleFolder>(resolve => { resolveStale = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/me")) return jsonResponse({ principal: { id: "principal-1", email: "aram@example.com", display_name: "아람" }, context: { capabilities: ["*"] } });
      if (url.endsWith("/api/v1/workspaces")) return jsonResponse([workspace]);
      if (url.includes("/api/v1/workspaces/workspace-1/projects")) return jsonResponse([project, projectTwo]);
      if (url.endsWith("/api/v1/workspaces/workspace-1/members") || url.endsWith("/api/v1/workspaces/workspace-1/peer-bindings") || url.endsWith("/api/v1/credentials") || url.endsWith("/api/v1/workspace-shares") || url.endsWith("/api/v1/workspace-projections") || url.includes("/api/v1/transfer-requests?")) return jsonResponse([]);
      if (/\/api\/v1\/projects\/project-[12]\/grants$/.test(url)) return jsonResponse({ items: [] });
      if (url.endsWith("/api/v1/projects/project-1/local-folder")) return jsonResponse(await staleResponse);
      if (url.endsWith("/api/v1/projects/project-2/local-folder")) return jsonResponse(currentFolder);
      return jsonResponse({ error: `Unexpected URL ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Project 연결과 권한" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("관리할 Project"), { target: { value: projectTwo.id } });
    expect(await screen.findByText(currentFolder.display_path)).toBeInTheDocument();
    resolveStale?.(staleFolder);
    await waitFor(() => expect(screen.queryByText(staleFolder.display_path)).not.toBeInTheDocument());
    expect(screen.getByText(currentFolder.display_path)).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(call => String(call[0]).endsWith("/local-folder:pick"))).toHaveLength(0);
    expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith("/projects/project-2/local-folder"))).toBe(true);
  });

  it("omits unsupported graph, claim-evidence, and record-context surfaces", async () => {
    window.history.replaceState(null, "", "/app/graph");
    const seen: string[] = [];
    mockFetch(url => { seen.push(url);
      if (url.endsWith("/api/v1/me")) return { principal: { id: "principal-1", email: "aram@example.com", display_name: "아람" }, context: { capabilities: ["project.read"] } };
      if (url.endsWith("/api/v1/workspaces")) return [workspace];
      if (url.includes("/api/v1/workspaces/workspace-1/projects")) return [project];
      if (url.includes("/api/v1/memory/conclusions")) return { items: [] };
      throw new Error(`Unexpected URL ${url}`);
    });
    render(<App />);
    expect(await screen.findByText("기억의 현재 상태")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "그래프" })).not.toBeInTheDocument();
    expect(seen.some(url => /graph|evidence|record.*context/.test(url))).toBe(false);
  });

  it("does not offer a start button when a Node is healthy", async () => {
    const dashboardOrigin = "http://localhost:18443";
    window.history.replaceState(null, "", `/admin/?return_to=${encodeURIComponent(`${dashboardOrigin}/app`)}`);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, media: "(max-width: 820px)", onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })));
    const requested: string[] = [];
    const node = { node_id: "node-1", alias: "MacBook Node", ports: { api: 18001, dashboard: 18443, mcp: 18765 }, generation: 1, desired_state: "running", phase: "ready", compose_project: "neuromem-node", schema_revision: "0001", created_at: "2026-08-31T00:00:00Z", updated_at: "2026-08-31T00:00:00Z" };
    mockFetch(url => {
      requested.push(url);
      if (url.endsWith("/v1/nodes")) return { nodes: [node, { ...node, node_id: "legacy-logical-node", alias: "표시하면 안 되는 논리 Node" }] };
      if (url.endsWith("/health")) return { node, docker_available: true, phase: "ready", components: [{ name: "database", state: "running", health: "healthy" }], endpoints: { api: "http://127.0.0.1:18001" }, models: { embedding: { configured: true, model: "qwen3-embedding:4b", provider_status: "ready", provider_detail: null, last_probe_at: "2026-08-31T00:30:00Z" }, extraction: { configured: false, provider_status: "unconfigured", provider_detail: "generation provider not configured", last_probe_at: null } } };
      if (url.endsWith("/models")) return modelSelection({ activeSource: null, embeddingModel: "qwen3-embedding:4b", embeddingModels: ["qwen3-embedding:4b"] });
      if (url.endsWith("/backlog")) return { node_id: "node-1", available: true, pending: 0, running: 0, failed: 0 };
      if (url.endsWith("/backups")) return { node_id: "node-1", backups: [] };
      if (url.includes("/logs?")) return { logs: [] };
      throw new Error(`Unexpected URL ${url}`);
    });
    render(<App />);
    expect(await screen.findByText("모든 핵심 구성요소가 정상입니다.")).toBeInTheDocument();
    const sidebar = document.querySelector<HTMLElement>('aside[aria-label="Neuromem 사이드바"]');
    expect(sidebar).not.toBeNull();
    expect(sidebar).toHaveAttribute("inert");
    expect(sidebar).toHaveAttribute("aria-hidden", "true");
    const mobileMenu = screen.getByRole("button", { name: "메뉴 열기" });
    expect(mobileMenu).toHaveAttribute("aria-controls", "neuromem-sidebar");
    expect(mobileMenu).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(mobileMenu);
    expect(mobileMenu).toHaveAttribute("aria-expanded", "true");
    expect(sidebar).not.toHaveAttribute("inert");
    expect(sidebar).not.toHaveAttribute("aria-hidden");
    expect(sidebar).toHaveClass("open");
    const navigation = screen.getByRole("navigation", { name: "Neuromem 메뉴" });
    expect(within(navigation).getByRole("link", { name: "Node 관리" })).toHaveAttribute("aria-current", "page");
    await waitFor(() => expect(within(navigation).getByRole("link", { name: "개요" })).toHaveAttribute("href", `${dashboardOrigin}/app`));
    expect(within(navigation).getByRole("link", { name: "기억 찾기" })).toBeInTheDocument();
    expect(within(navigation).getByRole("link", { name: "주장" })).toBeInTheDocument();
    expect(within(navigation).getByRole("link", { name: "Wiki" })).toBeInTheDocument();
    expect(within(navigation).getByRole("link", { name: "Workspace 관리" })).toBeInTheDocument();
    expect(document.querySelectorAll("main")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: /현재 (Project|Workspace) 범위/ })).not.toBeInTheDocument();
    expect(requested.some(url => url.includes("/api/v1/me") || url.includes("/api/v1/workspaces"))).toBe(false);
    expect(screen.queryByText("표시하면 안 되는 논리 Node")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Node 시작" })).not.toBeInTheDocument();
    expect(screen.getByText("http://127.0.0.1:18001")).toBeInTheDocument();
    expect(screen.getByText("컴퓨팅 소스")).toBeInTheDocument();
    expect(screen.getByLabelText("임베딩 모델 선택")).toHaveValue("qwen3-embedding:4b");
    expect(screen.getByText("생성 모델 연결 방식을 선택하세요.")).toBeInTheDocument();
    expect(screen.getByText("Core에서 최근 모델 연결을 정상 확인했습니다.")).toBeInTheDocument();
    expect(screen.getByText("모델 주소와 이름이 설정되지 않았습니다.")).toBeInTheDocument();
  });

  it("keeps the platform sidebar when the local Node administrator session is missing", async () => {
    window.history.replaceState(null, "", `/admin/?return_to=${encodeURIComponent("http://localhost:9999/app")}`);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/nodes")) return new Response(JSON.stringify({ error: "Admin session is required" }), { status: 401, headers: { "content-type": "application/json" } });
      throw new Error(`Unexpected URL ${url}`);
    }));

    render(<App />);
    expect(await screen.findByText("관리자 링크가 필요합니다.")).toBeInTheDocument();
    const navigation = screen.getByRole("navigation", { name: "Neuromem 메뉴" });
    expect(within(navigation).getByRole("link", { name: "Node 관리" })).toHaveAttribute("aria-current", "page");
    expect(within(navigation).getByRole("link", { name: "Workspace 관리" })).toBeInTheDocument();
    expect(within(navigation).getByRole("link", { name: "개요" })).toHaveAttribute("href", `${window.location.origin}/app`);
    expect(screen.queryByRole("button", { name: "로그아웃" })).not.toBeInTheDocument();
  });

  it("keeps an undiscovered embedding model and applies only an explicitly selected replacement after confirmation", async () => {
    window.history.replaceState(null, "", "/admin");
    const node = { node_id: "node-1", alias: "MacBook Node", ports: { api: 18001, dashboard: 14173, mcp: 18765 }, generation: 1, desired_state: "running", phase: "degraded", compose_project: "neuromem-node", schema_revision: "0001", created_at: "2026-08-31T00:00:00Z", updated_at: "2026-08-31T00:00:00Z" };
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
    const node = { node_id: "node-1", alias: "MacBook Node", ports: { api: 18001, dashboard: 14173, mcp: 18765 }, generation: 1, desired_state: "running", phase: "degraded", compose_project: "neuromem-node", schema_revision: "0001", created_at: "2026-08-31T00:00:00Z", updated_at: "2026-08-31T00:00:00Z" };
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
    const node = { node_id: "node-1", alias: "MacBook Node", ports: { api: 18001, dashboard: 14173, mcp: 18765 }, generation: 1, desired_state: "running", phase: "degraded", compose_project: "neuromem-node", schema_revision: "0001", created_at: "2026-08-31T00:00:00Z", updated_at: "2026-08-31T00:00:00Z" };
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
    const node = { node_id: "node-1", alias: "MacBook Node", ports: { api: 18001, dashboard: 14173, mcp: 18765 }, generation: 1, desired_state: "stopped", phase: "stopped", compose_project: "neuromem-node", schema_revision: "0001", created_at: "2026-08-31T00:00:00Z", updated_at: "2026-08-31T00:00:00Z" };
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
    const node = { node_id: "node-1", alias: "MacBook Node", ports: { api: 18001, dashboard: 14173, mcp: 18765 }, generation: 1, desired_state: "running", phase: "degraded", compose_project: "neuromem-node", schema_revision: "0001", created_at: "2026-08-31T00:00:00Z", updated_at: "2026-08-31T00:00:00Z" };
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
    expect(await screen.findByText("컴퓨팅 소스")).toBeInTheDocument();
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
    expect(await screen.findByText("컴퓨팅 소스")).toBeInTheDocument();
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
  return { node_id: "node-1", alias: "MacBook Node", ports: { api: 18001, dashboard: 14173, mcp: 18765 }, generation: 1, desired_state: "running", phase: "degraded", compose_project: "neuromem-node", schema_revision: "0001", created_at: "2026-08-31T00:00:00Z", updated_at: "2026-08-31T00:00:00Z" };
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

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
