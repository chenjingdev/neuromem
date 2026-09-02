import { BookOpen, BrainCircuit, Copy, FileSearch, Home, LogOut, Menu, Network, PanelLeftOpen, Search, Server, Settings, X } from "lucide-react";
import { FormEvent, type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, authApi, coreApi, exchangeManagerBootstrap, type ProductOnboardingResult } from "./api";
import { Button, EmptyState, ErrorState, LoadingState } from "./components/common";
import { useRemote } from "./hooks";
import { AdminAuthRequired, AdminPage } from "./pages/AdminPage";
import { ClaimsPage } from "./pages/ClaimsPage";
import { OverviewPage } from "./pages/OverviewPage";
import { RecallPage } from "./pages/RecallPage";
import { WikiPage } from "./pages/WikiPage";
import { WorkspacePage } from "./pages/WorkspacePage";
import type { ProjectOption, Scope, WorkspaceOption } from "./types";

const projectRoutes = [
  { path: "/app", label: "개요", icon: Home },
  { path: "/app/recall", label: "기억 찾기", icon: Search },
  { path: "/app/claims", label: "주장", icon: Network },
  { path: "/app/wiki", label: "Wiki", icon: BookOpen },
];

const workspaceRoute = { path: "/app/workspace", label: "Workspace 관리", icon: Settings };

export default function App() {
  const [path, setPath] = useState(normalizedPath());
  const isAdmin = path === "/admin" || path.startsWith("/admin/");
  const [adminReady, setAdminReady] = useState(!isAdmin);
  const [adminBootstrapError, setAdminBootstrapError] = useState<unknown>(null);

  useEffect(() => {
    if (window.location.pathname === "/") {
      window.history.replaceState(null, "", "/app");
      setPath("/app");
    } else if (normalizedPath() === "/app/team") {
      window.history.replaceState(null, "", "/app/workspace");
      setPath("/app/workspace");
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
    return <AdminShell adminReady={adminReady} adminBootstrapError={adminBootstrapError} />;
  }
  return <ProductApp path={path} setPath={setPath} />;
}

function AdminShell({ adminReady, adminBootstrapError }: { adminReady: boolean; adminBootstrapError: unknown }) {
  const [mobileNav, setMobileNav] = useState(false);
  const [resolvedProductUrl, setResolvedProductUrl] = useState(() => productUrl());
  const resolveNodeProductUrl = useCallback((nodeEndpoint: string) => setResolvedProductUrl(productUrl(nodeEndpoint)), []);
  const content = !adminReady
    ? <LoadingState label="안전한 관리자 세션을 여는 중입니다." />
    : adminBootstrapError
      ? <AdminAuthRequired />
      : <AdminPage onProductUrlResolved={resolveNodeProductUrl} />;
  return <div className="product-shell">
    <PlatformSidebar activePath="/admin" productUrl={resolvedProductUrl} nodeUrl={`${window.location.pathname}${window.location.search}`} mobileNav={mobileNav} onClose={() => setMobileNav(false)} />
    {mobileNav && <button className="sidebar-scrim" aria-label="메뉴 닫기" onClick={() => setMobileNav(false)} />}
    <main className="product-main"><MobileHeader open={mobileNav} onOpen={() => setMobileNav(true)} /><div className="page-container admin-content">{content}</div></main>
  </div>;
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
  const scopeKind = path === workspaceRoute.path ? "workspace" : "project";

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
  const registerWorkspace = (createdWorkspace: WorkspaceOption, createdProject: ProjectOption) => {
    workspaces.setData(current => [...(current || []), { ...createdWorkspace, projects: [createdProject] }]);
    setWorkspaceId(createdWorkspace.id); localStorage.setItem("neuromem.workspace", createdWorkspace.id);
    setProjectId(createdProject.id); localStorage.setItem("neuromem.project", createdProject.id);
    workspaces.retry();
  };
  const registerProject = (createdProject: ProjectOption) => {
    if (!workspace) return;
    workspaces.setData(current => current?.map(item => item.id === workspace.id ? { ...item, projects: [...(item.projects || []), createdProject] } : item) || null);
    setProjectId(createdProject.id); localStorage.setItem("neuromem.project", createdProject.id);
    workspaces.retry();
  };

  return <div className="product-shell">
    <PlatformSidebar activePath={path} nodeUrl={nodeAdminUrl()} mobileNav={mobileNav} onNavigate={navigate} onClose={() => setMobileNav(false)} onLogout={async () => { await authApi.logout(); onLogout(); }} />
    {mobileNav && <button className="sidebar-scrim" aria-label="메뉴 닫기" onClick={() => setMobileNav(false)} />}
    <main className="product-main"><MobileHeader open={mobileNav} onOpen={() => setMobileNav(true)} /><div className="page-container">
      {workspaces.loading ? <LoadingState label="Workspace와 Project를 불러오는 중입니다." />
        : workspaces.error ? <ErrorState error={workspaces.error} onRetry={workspaces.retry} />
          : !workspace ? <CreateWorkspace onCreated={workspaces.retry} />
            : !project ? <CreateProject workspace={workspace} onCreated={workspaces.retry} />
              : <><ScopeBar kind={scopeKind} workspace={workspace} project={project} workspaces={workspaces.data || []} onWorkspaceChange={chooseWorkspace} onProjectChange={chooseProject} /><ProductRoute key={`${path}:${workspace.id}:${project.id}`} path={path} scope={{ workspaceId: workspace.id, projectId: project.id, workspaceName: workspace.name, projectName: project.name }} projects={workspace.projects || []} navigate={navigate} onSelectProject={chooseProject} onWorkspaceCreated={registerWorkspace} onProjectCreated={registerProject} /></>}
    </div></main>
  </div>;
}

function PlatformSidebar({ activePath, productUrl, nodeUrl, mobileNav, onNavigate, onClose, onLogout }: { activePath: string; productUrl?: string; nodeUrl: string; mobileNav: boolean; onNavigate?: (path: string) => void; onClose: () => void; onLogout?: () => void | Promise<void> }) {
  const admin = activePath === "/admin" || activePath.startsWith("/admin/");
  const mobileViewport = useMobileViewport();
  const mobileClosed = mobileViewport && !mobileNav;
  const sidebarRef = useRef<HTMLElement>(null);
  const productHref = (path: string) => productUrl ? productRouteUrl(productUrl, path) : path;
  const navigateProduct = (event: ReactMouseEvent<HTMLAnchorElement>, path: string) => {
    if (!onNavigate) return;
    event.preventDefault();
    onNavigate(path);
  };

  useEffect(() => {
    sidebarRef.current?.toggleAttribute("inert", mobileClosed);
  }, [mobileClosed]);

  return <aside ref={sidebarRef} id="neuromem-sidebar" className={`product-sidebar ${mobileNav ? "open" : ""}`} aria-label="Neuromem 사이드바" aria-hidden={mobileClosed || undefined}>
    <div className="sidebar-head"><a className="wordmark" href={productHref("/app")} onClick={event => navigateProduct(event, "/app")}><span className="brand-mark">N</span><span>Neuromem</span></a><button className="icon-button mobile-only" onClick={onClose} aria-label="메뉴 닫기"><X /></button></div>
    <nav aria-label="Neuromem 메뉴">
      <div className="nav-group"><span className="nav-group-label">Project 기억</span>{projectRoutes.map(route => { const Icon = route.icon; const active = activePath === route.path; return <a key={route.path} href={productHref(route.path)} className={active ? "active" : ""} aria-current={active ? "page" : undefined} onClick={event => navigateProduct(event, route.path)}><Icon /><span>{route.label}</span></a>; })}</div>
      <div className="nav-group"><span className="nav-group-label">Workspace</span><a href={productHref(workspaceRoute.path)} className={activePath === workspaceRoute.path ? "active" : ""} aria-current={activePath === workspaceRoute.path ? "page" : undefined} onClick={event => navigateProduct(event, workspaceRoute.path)}><Settings /><span>{workspaceRoute.label}</span></a></div>
      <div className="nav-group"><span className="nav-group-label">로컬 Node</span><a href={nodeUrl} className={admin ? "active" : ""} aria-current={admin ? "page" : undefined}><Server /><span>Node 관리</span></a></div>
    </nav>
    <div className="sidebar-foot">{admin ? <Server /> : <BrainCircuit />}<div><strong>{admin ? "로컬 Node" : "Neuromem Node"}</strong><small>{admin ? "Node 운영자 세션" : "Workspace 격리 활성"}</small></div>{onLogout && <button className="icon-button" aria-label="로그아웃" onClick={onLogout}><LogOut /></button>}</div>
  </aside>;
}

function MobileHeader({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  return <header className="mobile-header"><button className="icon-button" onClick={onOpen} aria-label="메뉴 열기" aria-expanded={open} aria-controls="neuromem-sidebar"><Menu /></button><span className="wordmark"><span className="brand-mark">N</span><span>Neuromem</span></span></header>;
}

function useMobileViewport() {
  const query = "(max-width: 820px)";
  const [matches, setMatches] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(query).matches);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  return matches;
}

function ScopeBar({ kind, workspace, project, workspaces, onWorkspaceChange, onProjectChange }: { kind: "workspace" | "project"; workspace: WorkspaceOption; project: ProjectOption; workspaces: WorkspaceOption[]; onWorkspaceChange: (id: string) => void; onProjectChange: (id: string) => void }) {
  const projectScope = kind === "project";
  return <section className={`scope-bar ${kind}`} aria-label={projectScope ? "현재 Project 범위" : "현재 Workspace 범위"}>
    <div className="scope-bar-copy"><span className="eyebrow">{projectScope ? "PROJECT SCOPE" : "WORKSPACE SCOPE"}</span><strong>{projectScope ? "Project 기억" : "Workspace 관리"}</strong><small>{projectScope ? "이 범위의 기억과 Wiki가 함께 변경됩니다." : "이 Workspace의 멤버·프로젝트·공유를 관리합니다."}</small></div>
    <div className="scope-controls">
      <label><span>Workspace</span><select value={workspace.id} onChange={event => onWorkspaceChange(event.target.value)}>{workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {projectScope && <label><span>Project</span><select value={project.id} onChange={event => onProjectChange(event.target.value)}>{workspace.projects?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
    </div>
  </section>;
}

function ProductRoute({ path, scope, projects, navigate, onSelectProject, onWorkspaceCreated, onProjectCreated }: { path: string; scope: Scope; projects: ProjectOption[]; navigate: (path: string) => void; onSelectProject: (id: string) => void; onWorkspaceCreated: (workspace: WorkspaceOption, project: ProjectOption) => void; onProjectCreated: (project: ProjectOption) => void }) {
  if (path === "/app/recall") return <RecallPage scope={scope} />;
  if (path === "/app/claims") return <ClaimsPage scope={scope} />;
  if (path === "/app/wiki") return <WikiPage scope={scope} />;
  if (path === "/app/workspace") return <WorkspacePage scope={scope} projects={projects} onSelectProject={onSelectProject} onWorkspaceCreated={onWorkspaceCreated} onProjectCreated={onProjectCreated} />;
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
  const [localTestLogin, setLocalTestLogin] = useState<{ email: string; password: string } | null>(null);

  useEffect(() => {
    if (!invitationToken) return;
    // The one-time invitation remains only in component memory after first render.
    window.history.replaceState(null, "", window.location.pathname);
  }, [invitationToken]);

  useEffect(() => {
    if (mode !== "login") return;
    let active = true;
    authApi.localTestLoginPrefill().then(prefill => {
      if (!active || !prefill) return;
      setLocalTestLogin(prefill);
      setEmail(current => current || prefill.email);
      setPassword(current => current || prefill.password);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [mode]);

  const changeMode = (next: AuthMode) => {
    setMode(next); setError(null);
    if (next === "login") {
      setEmail(localTestLogin?.email || "");
      setPassword(localTestLogin?.password || "");
    } else {
      setEmail("");
      setPassword("");
    }
  };

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

  return <main className="auth-shell"><section className="auth-card"><div className="auth-brand"><span className="brand-mark">N</span><div><strong>Neuromem</strong><small>Workspace memory</small></div></div><h1>{mode === "login" ? "로그인" : mode === "bootstrap" ? "첫 Workspace 만들기" : "Workspace 초대 수락"}</h1><p>{mode === "login" ? "내 Workspace와 프로젝트에 안전하게 접속합니다." : mode === "bootstrap" ? "최초 Owner와 General Project를 함께 생성합니다." : "초대받은 Workspace만의 Human Peer가 자동으로 생성됩니다."}</p>
    <form className="stack-form auth-form" onSubmit={submit}>
      {mode !== "invite" && <label>이메일<input type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" required /></label>}
      {mode !== "login" && <label>표시 이름<input value={displayName} onChange={event => setDisplayName(event.target.value)} autoComplete="name" required /></label>}
      {mode === "bootstrap" && <label>Workspace 이름<input value={workspaceName} onChange={event => setWorkspaceName(event.target.value)} placeholder="내 Workspace" required /></label>}
      {mode === "invite" && <label>초대 토큰<input value={token} onChange={event => setToken(event.target.value)} autoComplete="off" required /></label>}
      <label>비밀번호<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={mode === "login" ? undefined : 12} required /></label>
      {Boolean(error) && <div className="inline-message error" role="alert">{error instanceof Error ? error.message : "인증하지 못했습니다."}</div>}
      <Button className="primary" disabled={busy}>{busy ? "처리 중…" : mode === "login" ? "로그인" : mode === "bootstrap" ? "Workspace 생성" : "초대 수락"}</Button>
    </form>
    <div className="auth-switches">{mode !== "login" && <button onClick={() => changeMode("login")}>기존 계정 로그인</button>}{mode !== "bootstrap" && <button onClick={() => changeMode("bootstrap")}>최초 설정</button>}{mode !== "invite" && <button onClick={() => changeMode("invite")}>초대 수락</button>}</div>
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

function productUrl(nodeEndpoint?: string) {
  const configured = import.meta.env.VITE_PRODUCT_URL;
  const current = new URL(window.location.href);
  let fallback = configured || "/app";
  if (!configured && nodeEndpoint) {
    const target = new URL(nodeEndpoint);
    target.pathname = "/app";
    target.search = "";
    target.hash = "";
    fallback = target.toString();
  } else if (!configured && ["127.0.0.1", "localhost", "[::1]"].includes(current.hostname) && current.port === "14174") {
    const target = new URL(current);
    target.port = "24443";
    target.pathname = "/app";
    target.search = "";
    target.hash = "";
    fallback = target.toString();
  }
  const returnTo = safeProductReturnUrl(new URLSearchParams(window.location.search).get("return_to"), new URL(fallback, current).toString());
  if (returnTo) return returnTo;
  return fallback;
}

function nodeAdminUrl() {
  const configured = import.meta.env.VITE_NODE_ADMIN_URL;
  const current = new URL(window.location.href);
  const target = configured || (["127.0.0.1", "localhost", "[::1]"].includes(current.hostname) ? "http://127.0.0.1:14174/admin/" : "/admin/");
  const admin = new URL(target, current);
  if (admin.origin !== current.origin && ["127.0.0.1", "localhost", "[::1]"].includes(admin.hostname)) {
    admin.searchParams.set("return_to", `${current.origin}/app`);
    return admin.toString();
  }
  return configured || `${admin.pathname}${admin.search}${admin.hash}`;
}

function productRouteUrl(productUrl: string, path: string) {
  const target = new URL(productUrl, window.location.href);
  target.pathname = path;
  target.search = "";
  target.hash = "";
  return target.toString();
}

function safeProductReturnUrl(value: string | null, fallback: string) {
  if (!value) return null;
  let target: URL;
  let trusted: URL;
  try { target = new URL(value); trusted = new URL(fallback); } catch { return null; }
  const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"];
  const loopback = loopbackHosts.includes(target.hostname) && loopbackHosts.includes(trusted.hostname);
  const path = target.pathname.replace(/\/+$/, "") || "/";
  if (!loopback || target.protocol !== trusted.protocol || target.port !== trusted.port || target.username || target.password || path !== "/app" || target.search || target.hash) return null;
  return `${target.origin}/app`;
}
