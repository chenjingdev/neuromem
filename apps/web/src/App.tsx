import { BookOpen, BrainCircuit, FileSearch, GitFork, Home, Menu, Network, PanelLeftClose, PanelLeftOpen, Search, X } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { coreApi, exchangeManagerBootstrap } from "./api";
import { Button, EmptyState, ErrorState, LoadingState } from "./components/common";
import { useRemote } from "./hooks";
import { AdminAuthRequired, AdminPage } from "./pages/AdminPage";
import { ClaimsPage } from "./pages/ClaimsPage";
import { GraphPage } from "./pages/GraphPage";
import { OverviewPage } from "./pages/OverviewPage";
import { RecallPage } from "./pages/RecallPage";
import { WikiPage } from "./pages/WikiPage";
import type { ProjectOption, Scope, WorkspaceOption } from "./types";

const productRoutes = [
  { path: "/app", label: "개요", icon: Home },
  { path: "/app/recall", label: "기억 찾기", icon: Search },
  { path: "/app/claims", label: "주장", icon: Network },
  { path: "/app/wiki", label: "Wiki", icon: BookOpen },
  { path: "/app/graph", label: "그래프", icon: GitFork },
];

export default function App() {
  const [path, setPath] = useState(normalizedPath());
  const isAdmin = path === "/admin" || path.startsWith("/admin/");
  const [adminReady, setAdminReady] = useState(!isAdmin);
  const [adminBootstrapError, setAdminBootstrapError] = useState<unknown>(null);

  useEffect(() => {
    if (window.location.pathname === "/") {
      window.history.replaceState(null, "", "/app");
      setPath("/app");
    }
    const pop = () => setPath(normalizedPath());
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  useEffect(() => {
    if (!isAdmin) { setAdminReady(true); return; }
    let current = true;
    exchangeManagerBootstrap().then(() => { if (current) setAdminReady(true); }).catch(error => {
      if (!current) return;
      setAdminBootstrapError(error);
      setAdminReady(true);
    });
    return () => { current = false; };
  }, [isAdmin]);

  if (isAdmin) {
    if (!adminReady) return <div className="standalone-state"><LoadingState label="안전한 관리자 세션을 여는 중입니다." /></div>;
    if (adminBootstrapError) return <div className="standalone-state"><AdminAuthRequired /></div>;
    return <AdminPage productUrl={productUrl()} />;
  }
  return <ProductApp path={path} setPath={setPath} />;
}

function ProductApp({ path, setPath }: { path: string; setPath: (path: string) => void }) {
  const workspaces = useRemote(() => coreApi.workspaces(), []);
  const [workspaceId, setWorkspaceId] = useState(() => localStorage.getItem("neuromem.workspace") || "");
  const [projectId, setProjectId] = useState(() => localStorage.getItem("neuromem.project") || "");
  const [mobileNav, setMobileNav] = useState(false);

  const workspace = useMemo(() => workspaces.data?.find(item => item.id === workspaceId) || workspaces.data?.[0] || null, [workspaces.data, workspaceId]);
  const project = useMemo(() => workspace?.projects?.find(item => item.id === projectId) || workspace?.projects?.[0] || null, [workspace, projectId]);

  useEffect(() => {
    if (!workspace) return;
    if (workspace.id !== workspaceId) { setWorkspaceId(workspace.id); localStorage.setItem("neuromem.workspace", workspace.id); }
    const next = workspace.projects?.find(item => item.id === projectId) || workspace.projects?.[0];
    if (next && next.id !== projectId) { setProjectId(next.id); localStorage.setItem("neuromem.project", next.id); }
  }, [workspace, workspaceId, projectId]);

  const navigate = (next: string) => {
    window.history.pushState(null, "", next);
    setPath(next); setMobileNav(false); window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const chooseWorkspace = (id: string) => {
    const next = workspaces.data?.find(item => item.id === id);
    setWorkspaceId(id); localStorage.setItem("neuromem.workspace", id);
    const first = next?.projects?.[0]?.id || "";
    setProjectId(first); if (first) localStorage.setItem("neuromem.project", first); else localStorage.removeItem("neuromem.project");
  };
  const chooseProject = (id: string) => { setProjectId(id); localStorage.setItem("neuromem.project", id); };

  return <div className="product-shell">
    <aside className={`product-sidebar ${mobileNav ? "open" : ""}`}>
      <div className="sidebar-head"><a className="wordmark" href="/app" onClick={event => { event.preventDefault(); navigate("/app"); }}><span className="brand-mark">N</span><span>Neuromem</span></a><button className="icon-button mobile-only" onClick={() => setMobileNav(false)} aria-label="메뉴 닫기"><X /></button></div>
      {workspace && <div className="scope-controls"><label><span>Workspace</span><select value={workspace.id} onChange={event => chooseWorkspace(event.target.value)}>{workspaces.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label><span>Project</span><select value={project?.id || ""} onChange={event => chooseProject(event.target.value)} disabled={!workspace.projects?.length}>{workspace.projects?.length ? workspace.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>) : <option value="">프로젝트 없음</option>}</select></label></div>}
      <nav aria-label="기억 메뉴">{productRoutes.map(route => { const Icon = route.icon; return <button key={route.path} className={path === route.path ? "active" : ""} onClick={() => navigate(route.path)}><Icon /><span>{route.label}</span></button>; })}</nav>
      <div className="sidebar-foot"><BrainCircuit /><div><strong>Memory core</strong><small>기록 · 주장 · 근거</small></div></div>
    </aside>
    {mobileNav && <button className="sidebar-scrim" aria-label="메뉴 닫기" onClick={() => setMobileNav(false)} />}
    <main className="product-main"><header className="mobile-header"><button className="icon-button" onClick={() => setMobileNav(true)} aria-label="메뉴 열기"><Menu /></button><span className="wordmark"><span className="brand-mark">N</span><span>Neuromem</span></span></header><div className="page-container">
      {workspaces.loading ? <LoadingState label="Workspace와 Project를 불러오는 중입니다." />
        : workspaces.error ? <ErrorState error={workspaces.error} onRetry={workspaces.retry} />
          : !workspace ? <CreateWorkspace onCreated={workspaces.retry} />
            : !project ? <CreateProject workspace={workspace} onCreated={workspaces.retry} />
              : <ProductRoute path={path} scope={{ workspaceId: workspace.id, projectId: project.id, workspaceName: workspace.name, projectName: project.name }} navigate={navigate} />}
    </div></main>
  </div>;
}

function ProductRoute({ path, scope, navigate }: { path: string; scope: Scope; navigate: (path: string) => void }) {
  if (path === "/app/recall") return <RecallPage scope={scope} />;
  if (path === "/app/claims") return <ClaimsPage scope={scope} />;
  if (path === "/app/wiki") return <WikiPage scope={scope} />;
  if (path === "/app/graph") return <GraphPage scope={scope} />;
  return <OverviewPage scope={scope} navigate={navigate} />;
}

function CreateWorkspace({ onCreated }: { onCreated: () => void }) {
  const [workspaceName, setWorkspaceName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try { const workspace = await coreApi.createWorkspace(workspaceName.trim()); await coreApi.createProject(workspace.id, projectName.trim()); onCreated(); }
    catch (reason) { setError(reason); }
    finally { setBusy(false); }
  };
  return <EmptyState icon={<PanelLeftOpen />} title="첫 프로젝트를 만드세요.">기억을 담을 Workspace와 Project를 한 번에 만듭니다.<form className="inline-setup-form" onSubmit={submit}><label>Workspace 이름<input value={workspaceName} onChange={event => setWorkspaceName(event.target.value)} placeholder="아람 개인" required /></label><label>Project 이름<input value={projectName} onChange={event => setProjectName(event.target.value)} placeholder="Neuromem" required /></label>{Boolean(error) && <span className="error-copy">{error instanceof Error ? error.message : "만들지 못했습니다."}</span>}<Button className="primary" disabled={busy || !workspaceName.trim() || !projectName.trim()}>{busy ? "만드는 중…" : "바로 시작"}</Button></form></EmptyState>;
}

function CreateProject({ workspace, onCreated }: { workspace: WorkspaceOption; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try { await coreApi.createProject(workspace.id, name.trim()); onCreated(); }
    catch (reason) { setError(reason); }
    finally { setBusy(false); }
  };
  return <EmptyState icon={<FileSearch />} title={`${workspace.name}에 Project가 없습니다.`}>작업 기억을 분리할 첫 Project를 만드세요.<form className="inline-setup-form single" onSubmit={submit}><label>Project 이름<input value={name} onChange={event => setName(event.target.value)} placeholder="Neuromem" required /></label>{Boolean(error) && <span className="error-copy">{error instanceof Error ? error.message : "만들지 못했습니다."}</span>}<Button className="primary" disabled={busy || !name.trim()}>{busy ? "만드는 중…" : "Project 만들기"}</Button></form></EmptyState>;
}

function normalizedPath() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  return path;
}

function productUrl() {
  const current = new URL(window.location.href);
  if (["127.0.0.1", "localhost", "[::1]"].includes(current.hostname) && current.port === "14174") {
    current.port = "14173";
    current.pathname = "/app";
    current.search = "";
    current.hash = "";
    return current.toString();
  }
  return "/app";
}
