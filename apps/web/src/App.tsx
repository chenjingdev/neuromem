import { BookOpen, BrainCircuit, Copy, FileSearch, Home, LogOut, Menu, Network, PanelLeftOpen, Search, UsersRound, X } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { ApiError, authApi, coreApi, exchangeManagerBootstrap, type ProductOnboardingResult } from "./api";
import { Button, EmptyState, ErrorState, LoadingState } from "./components/common";
import { useRemote } from "./hooks";
import { AdminAuthRequired, AdminPage } from "./pages/AdminPage";
import { ClaimsPage } from "./pages/ClaimsPage";
import { OverviewPage } from "./pages/OverviewPage";
import { RecallPage } from "./pages/RecallPage";
import { WikiPage } from "./pages/WikiPage";
import { TeamPage } from "./pages/TeamPage";
import type { ProjectOption, Scope, WorkspaceOption } from "./types";

const productRoutes = [
  { path: "/app", label: "개요", icon: Home },
  { path: "/app/recall", label: "기억 찾기", icon: Search },
  { path: "/app/claims", label: "주장", icon: Network },
  { path: "/app/wiki", label: "Wiki", icon: BookOpen },
  { path: "/app/team", label: "팀 관리", icon: UsersRound },
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
  const auth = useRemote(() => authApi.me(), []);
  if (auth.loading) return <div className="standalone-state"><LoadingState label="Neuromem 세션을 확인하는 중입니다." /></div>;
  if (auth.error instanceof ApiError && auth.error.status === 401) return <ProductAuth inviteMode={path === "/app/invite"} onAuthenticated={auth.retry} />;
  if (auth.error) return <div className="standalone-state"><ErrorState title="Neuromem에 연결하지 못했습니다." error={auth.error} onRetry={auth.retry} /></div>;
  return <AuthenticatedProductApp path={path} setPath={setPath} onLogout={auth.retry} />;
}

function AuthenticatedProductApp({ path, setPath, onLogout }: { path: string; setPath: (path: string) => void; onLogout: () => void }) {
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
      <div className="sidebar-foot"><BrainCircuit /><div><strong>Team memory</strong><small>Control Gateway 연결</small></div><button className="icon-button" aria-label="로그아웃" onClick={async () => { await authApi.logout(); onLogout(); }}><LogOut /></button></div>
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
  if (path === "/app/team") return <TeamPage scope={scope} />;
  return <OverviewPage scope={scope} navigate={navigate} />;
}

type AuthMode = "login" | "bootstrap" | "invite";

function ProductAuth({ inviteMode, onAuthenticated }: { inviteMode: boolean; onAuthenticated: () => void }) {
  const invitationToken = new URLSearchParams(window.location.search).get("token") || "";
  const [mode, setMode] = useState<AuthMode>(inviteMode || invitationToken ? "invite" : "login");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [token, setToken] = useState(invitationToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [onboarding, setOnboarding] = useState<ProductOnboardingResult | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!invitationToken) return;
    // The one-time invitation remains only in component memory after first render.
    window.history.replaceState(null, "", window.location.pathname);
  }, [invitationToken]);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      if (mode === "login") { await authApi.login(email.trim(), password); onAuthenticated(); return; }
      const result = mode === "bootstrap"
        ? await authApi.bootstrap({ email: email.trim(), display_name: displayName.trim(), password, workspace_name: workspaceName.trim() })
        : await authApi.acceptInvitation({ token: token.trim(), display_name: displayName.trim(), password });
      setOnboarding(result);
    } catch (reason) { setError(reason); }
    finally { setBusy(false); }
  };

  if (onboarding) return <main className="auth-shell"><section className="auth-card recovery-card"><span className="brand-mark">N</span><h1>복구 키를 저장하세요</h1><p>이 키는 다시 표시되지 않습니다. 안전한 암호 관리자에 보관한 뒤 계속하세요.</p><code>{onboarding.recovery_credential.token}</code><div className="auth-actions"><Button className="secondary" onClick={async () => { await navigator.clipboard.writeText(onboarding.recovery_credential.token); setCopied(true); }}><Copy size={15} />{copied ? "복사됨" : "복사"}</Button><Button className="primary" onClick={onAuthenticated}>저장했습니다</Button></div></section></main>;

  return <main className="auth-shell"><section className="auth-card"><div className="auth-brand"><span className="brand-mark">N</span><div><strong>Neuromem</strong><small>Workspace memory</small></div></div><h1>{mode === "login" ? "로그인" : mode === "bootstrap" ? "첫 Workspace 만들기" : "팀 초대 수락"}</h1><p>{mode === "login" ? "팀 기억과 프로젝트에 안전하게 접속합니다." : mode === "bootstrap" ? "최초 Owner와 General Project를 함께 생성합니다." : "이 Workspace만의 Human Peer가 자동으로 생성됩니다."}</p>
    <form className="stack-form auth-form" onSubmit={submit}>
      {mode !== "invite" && <label>이메일<input type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" required /></label>}
      {mode !== "login" && <label>표시 이름<input value={displayName} onChange={event => setDisplayName(event.target.value)} autoComplete="name" required /></label>}
      {mode === "bootstrap" && <label>Workspace 이름<input value={workspaceName} onChange={event => setWorkspaceName(event.target.value)} placeholder="Neuromem 팀" required /></label>}
      {mode === "invite" && <label>초대 토큰<input value={token} onChange={event => setToken(event.target.value)} autoComplete="off" required /></label>}
      <label>비밀번호<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={mode === "login" ? undefined : 12} required /></label>
      {Boolean(error) && <div className="inline-message error" role="alert">{error instanceof Error ? error.message : "인증하지 못했습니다."}</div>}
      <Button className="primary" disabled={busy}>{busy ? "처리 중…" : mode === "login" ? "로그인" : mode === "bootstrap" ? "Workspace 생성" : "초대 수락"}</Button>
    </form>
    <div className="auth-switches">{mode !== "login" && <button onClick={() => setMode("login")}>기존 계정 로그인</button>}{mode !== "bootstrap" && <button onClick={() => setMode("bootstrap")}>최초 설정</button>}{mode !== "invite" && <button onClick={() => setMode("invite")}>초대 수락</button>}</div>
  </section></main>;
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
