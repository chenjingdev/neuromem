import { Check, Copy, Files, FolderKanban, FolderOpen, KeyRound, Link2, ShieldCheck, UserPlus, UsersRound, X } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { coreApi, workspaceApi } from "../api";
import { Button, Card, EmptyState, ErrorState, formatDate, LoadingState, PageHeading, StatusPill, SuccessMessage } from "../components/common";
import { useRemote } from "../hooks";
import type { CreatedCredential, ProjectOption, Scope, WorkspaceOption, WorkspaceProjection, WorkspaceRole, WorkspaceShare, WorkspaceShareDisplayMode } from "../types";

const DEFAULT_CAPABILITIES = ["project.read", "project.write", "wiki.read", "wiki.write", "transfer.request"];

export function WorkspacePage({ scope, projects, onSelectProject, onWorkspaceCreated, onProjectCreated }: { scope: Scope; projects: ProjectOption[]; onSelectProject: (id: string) => void; onWorkspaceCreated: (workspace: WorkspaceOption, project: ProjectOption) => void; onProjectCreated: (project: ProjectOption) => void }) {
  const remote = useRemote(() => workspaceApi.dashboard(scope), [scope.workspaceId, scope.projectId]);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState<unknown>(null);
  const [createdCredential, setCreatedCredential] = useState<CreatedCredential | null>(null);

  const bindings = useMemo(() => new Map(remote.data?.peer_bindings.map(item => [item.principal_id, item]) || []), [remote.data]);
  const run = async (action: () => Promise<unknown>, success: string) => {
    setActionError(null); setNotice("");
    try { await action(); setNotice(success); remote.retry(); }
    catch (error) { setActionError(error); }
  };

  if (remote.loading) return <LoadingState label="Workspace 구성을 불러오는 중입니다." />;
  if (remote.error || !remote.data) return <ErrorState title="Workspace 관리 정보를 불러오지 못했습니다." error={remote.error} onRetry={remote.retry} />;
  const data = remote.data;
  const pendingShares = data.shares.filter(item => item.status === "proposed").length;

  return <>
    <PageHeading eyebrow="WORKSPACE" title="Workspace 관리" description="이 Workspace의 프로젝트와 멤버를 관리합니다. 다른 Workspace의 기억은 양쪽 소유자가 승인한 범위만 표시됩니다." />
    {notice && <SuccessMessage>{notice}</SuccessMessage>}
    {actionError && <div className="inline-message error" role="alert">{actionError instanceof Error ? actionError.message : "요청을 처리하지 못했습니다."}</div>}
    {createdCredential && <CredentialSecret created={createdCredential} onClose={() => setCreatedCredential(null)} />}

    <div className="workspace-summary-grid">
      <Card><span className="eyebrow">Projects</span><strong className="workspace-metric">{projects.length}</strong><p>현재 Workspace의 기억 구분</p></Card>
      <Card><span className="eyebrow">Members</span><strong className="workspace-metric">{data.members.length}</strong><p>Workspace에 속한 사람과 역할</p></Card>
      <Card><span className="eyebrow">External memory</span><strong className="workspace-metric">{data.projections.length}</strong><p>승인되어 표시되는 외부 공유</p></Card>
      <Card><span className="eyebrow">Waiting agreement</span><strong className="workspace-metric">{pendingShares}</strong><p>상대 소유자 승인을 기다리는 공유</p></Card>
    </div>

    <div className="workspace-two-column">
      <ProjectList workspaceId={scope.workspaceId} projects={projects} selectedId={scope.projectId} onSelect={onSelectProject} onCreated={onProjectCreated} />
      <div className="workspace-side-stack"><CreateWorkspaceCard onCreated={onWorkspaceCreated} /><ShareProposal key={scope.workspaceId} workspaceId={scope.workspaceId} projects={projects} onCreated={() => run(async () => undefined, "공유 요청을 보냈습니다. 상대 Workspace 소유자가 승인하면 표시됩니다.")} onRefresh={remote.retry} onError={setActionError} /></div>
    </div>

    <SharedMemorySection workspaceId={scope.workspaceId} shares={data.shares} projections={data.projections} run={run} />

    <div className="workspace-two-column">
      <Card>
        <div className="card-heading"><div><span className="eyebrow">Membership</span><h2>멤버와 Peer</h2></div><UsersRound /></div>
        <div className="workspace-list">
          {data.members.map(member => {
            const binding = bindings.get(member.principal_id);
            const humanPeerId = binding?.human_peer_id || member.human_peer_id;
            const agentPeers = binding?.agent_peers || member.agent_peers;
            return <article key={member.id} className="workspace-member">
              <header><div><strong>{member.display_name}</strong><small>{member.email || member.principal_id}</small></div><div><span className="role-badge">{member.role}</span><StatusPill state={member.status} /></div></header>
              <div className="peer-binding"><span>Human Peer</span><code>{humanPeerId}</code><StatusPill state={binding?.human_peer_status || member.human_peer_status || "active"} /></div>
              {agentPeers.length > 0 ? <div className="agent-peer-list">{agentPeers.map(peer => <div key={peer.id}><span className={`agent-mark ${peer.client}`}>{peer.client}</span><strong>{peer.name || `${peer.client} Agent`}</strong><code>{peer.id}</code><StatusPill state={peer.status} /></div>)}</div> : <small className="muted-copy">연결된 Agent Peer가 없습니다.</small>}
            </article>;
          })}
          {data.peer_bindings.filter(binding => !data.members.some(member => member.principal_id === binding.principal_id)).map(binding => <article key={binding.principal_id} className="workspace-member">
            <header><div><strong>{binding.display_name || "Workspace 공용 Agent"}</strong><small>Workspace-owned Peer</small></div><StatusPill state="active" /></header>
            <div className="agent-peer-list">{binding.agent_peers.map(peer => <div key={peer.id}><span className={`agent-mark ${peer.client}`}>{peer.client}</span><strong>{peer.name || `${peer.client} Agent`}</strong><code>{peer.id}</code><StatusPill state={peer.status} /></div>)}</div>
          </article>)}
        </div>
      </Card>
      <InviteMember workspaceId={scope.workspaceId} onCreated={() => run(async () => undefined, "초대 링크를 생성했습니다.")} onRefresh={remote.retry} onError={setActionError} />
    </div>

    <div className="workspace-two-column">
      <Card>
        <div className="card-heading"><div><span className="eyebrow">Credentials</span><h2>API·MCP 연결</h2></div><KeyRound /></div>
        {data.credentials.length === 0 ? <p>발급된 credential이 없습니다.</p> : <div className="compact-list">{data.credentials.map(item => <article key={item.id}><div><strong>{item.name}</strong><small><code>{item.prefix}…</code> · {item.agent_peer_id ? "Agent Peer 연결" : "Human Peer 연결"}</small></div><div><StatusPill state={item.revoked_at ? "inactive" : "active"} /><Button className="secondary compact" disabled={Boolean(item.revoked_at)} onClick={() => run(() => workspaceApi.revokeCredential(scope, item.id), "Credential을 폐기했습니다.")}>폐기</Button></div></article>)}</div>}
      </Card>
      <Card>
        <div className="card-heading"><div><span className="eyebrow">Audited copy</span><h2>기억 복사 요청</h2></div><Files /></div>
        {data.transfer_requests.length === 0 ? <p>대기 중인 기억 복사 요청이 없습니다.</p> : <div className="transfer-list">{data.transfer_requests.map(item => <article key={item.id}><div><strong>{item.source_project_id} → {item.target_project_id}</strong><p>{item.reason}</p><small>{item.record_ids.length}개 원문 · {formatDate(item.created_at)}</small></div><div><StatusPill state={item.status} />{item.status.startsWith("pending") && <><Button className="secondary compact" onClick={() => run(() => workspaceApi.resolveTransferRequest(scope, item.id, "reject"), "기억 복사 요청을 거절했습니다.")}><X size={14} />거절</Button><Button className="primary compact" onClick={() => run(() => workspaceApi.resolveTransferRequest(scope, item.id, "approve"), "기억 복사 요청을 승인했습니다.")}><Check size={14} />승인</Button></>}</div></article>)}</div>}
      </Card>
    </div>

    <section className="project-scope-section" aria-labelledby="project-scope-heading">
      <header className="project-scope-heading"><div><span className="eyebrow">PROJECT SCOPE</span><h2 id="project-scope-heading">Project 연결과 권한</h2><p>아래 작업만 선택한 Project에 적용됩니다. Workspace 공통 정보는 바뀌지 않습니다.</p></div><label><span>관리할 Project</span><select value={scope.projectId} onChange={event => onSelectProject(event.target.value)}>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label></header>
      <ProjectFolderCard key={`${scope.workspaceId}:${scope.projectId}`} scope={scope} />
      <div className="workspace-two-column">
        <CreateCredential scope={scope} agentPeers={data.peer_bindings.flatMap(item => item.agent_peers)} onCreated={created => { setCreatedCredential(created); remote.retry(); }} onError={setActionError} />
        <Card>
          <div className="card-heading"><div><span className="eyebrow">Project access</span><h2>현재 Project 권한</h2></div><ShieldCheck /></div>
          {data.project_grants.length === 0 ? <p>Workspace 역할을 그대로 상속합니다.</p> : <div className="compact-list">{data.project_grants.map(grant => <article key={grant.id}><div><strong>{grant.principal_id || `${grant.role} 역할`}</strong><small>{grant.capabilities.join(" · ")}</small></div><Button className="secondary compact" onClick={() => run(() => workspaceApi.revokeProjectGrant(scope, grant.id), "Project 권한을 회수했습니다.")}>회수</Button></article>)}</div>}
        </Card>
      </div>
    </section>
  </>;
}

function ProjectFolderCard({ scope }: { scope: Scope }) {
  const folder = useRemote(() => workspaceApi.getProjectFolder(scope), [scope.workspaceId, scope.projectId]);
  const [picking, setPicking] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const busy = picking || disconnecting;

  const pick = async () => {
    if (busy) return;
    setPicking(true); setActionError(null);
    try {
      const selected = await workspaceApi.pickProjectFolder(scope);
      if (selected) folder.setData(selected);
    } catch (error) { setActionError(error); }
    finally { setPicking(false); }
  };
  const disconnect = async () => {
    if (busy) return;
    setDisconnecting(true); setActionError(null);
    try { await workspaceApi.disconnectProjectFolder(scope); folder.setData(null); }
    catch (error) { setActionError(error); }
    finally { setDisconnecting(false); }
  };

  return <Card className="project-folder-card">
    <div className="card-heading"><div><span className="eyebrow">Local source</span><h2>로컬 프로젝트 폴더</h2></div><FolderOpen /></div>
    {folder.loading ? <div className="project-folder-state" aria-live="polite"><strong>연결 상태 확인 중…</strong><p>이 Project에 연결된 로컬 폴더를 확인하고 있습니다.</p></div>
      : folder.error ? <div className="project-folder-state error" role="alert"><strong>폴더 연결을 확인하지 못했습니다.</strong><p>{folder.error instanceof Error ? folder.error.message : "요청을 처리하지 못했습니다."}</p><Button type="button" className="secondary compact" disabled={busy} onClick={folder.retry}>다시 확인</Button></div>
        : folder.data ? <div className="project-folder-state connected"><div className="project-folder-details"><span><strong>{folder.data.display_name}</strong><StatusPill state={folder.data.status} label={folder.data.status === "active" ? "연결됨" : undefined} /></span><code>{folder.data.display_path}</code></div><p>현재는 Project와 폴더의 연결 정보만 저장합니다. 파일 읽기와 자동 수집은 아직 시작되지 않습니다.</p><div className="project-folder-actions"><Button type="button" className="secondary" disabled={busy} onClick={pick}>{picking ? "선택창을 기다리는 중…" : "폴더 변경…"}</Button><Button type="button" className="quiet" disabled={busy} onClick={disconnect}>{disconnecting ? "해제 중…" : "연결 해제"}</Button></div></div>
          : <div className="project-folder-state"><strong>연결된 폴더가 없습니다.</strong><p>이 컴퓨터의 폴더를 선택해 현재 Project에 연결 정보를 저장할 수 있습니다.</p><Button type="button" className="secondary" disabled={busy} onClick={pick}>{picking ? "선택창을 기다리는 중…" : "폴더 선택…"}</Button></div>}
    {picking && <p className="project-folder-pending" role="status">열린 선택창에서 폴더를 선택하거나 취소하세요.</p>}
    {Boolean(actionError) && <p className="project-folder-error" role="alert">{actionError instanceof Error ? actionError.message : "폴더 요청을 처리하지 못했습니다."}</p>}
  </Card>;
}

function ProjectList({ workspaceId, projects, selectedId, onSelect, onCreated }: { workspaceId: string; projects: ProjectOption[]; selectedId: string; onSelect: (id: string) => void; onCreated: (project: ProjectOption) => void }) {
  const [name, setName] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(null); try { const project = await coreApi.createProject(workspaceId, name.trim()); onCreated(project); setName(""); } catch (reason) { setError(reason); } finally { setBusy(false); } };
  return <Card><div className="card-heading"><div><span className="eyebrow">Projects</span><h2>프로젝트</h2></div><FolderKanban /></div><div className="project-management-list">{projects.map(project => <button key={project.id} className={project.id === selectedId ? "selected" : ""} onClick={() => onSelect(project.id)}><span><strong>{project.name}</strong><small>{project.id}</small></span>{project.id === selectedId ? <StatusPill state="active" label="현재 선택" /> : <span>열기</span>}</button>)}</div><form className="project-create-form" onSubmit={submit}><label>새 Project<input value={name} onChange={event => setName(event.target.value)} placeholder="Project 이름" required /></label><Button className="secondary" disabled={busy || !name.trim()}>{busy ? "추가 중…" : "Project 추가"}</Button>{Boolean(error) && <span className="error-copy">{error instanceof Error ? error.message : "Project를 만들지 못했습니다."}</span>}</form></Card>;
}

function CreateWorkspaceCard({ onCreated }: { onCreated: (workspace: WorkspaceOption, project: ProjectOption) => void }) {
  const [workspaceName, setWorkspaceName] = useState(""); const [projectName, setProjectName] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(null); try { const workspace = await coreApi.createWorkspace(workspaceName.trim()); const project = await coreApi.createProject(workspace.id, projectName.trim()); onCreated(workspace, project); setWorkspaceName(""); setProjectName(""); } catch (reason) { setError(reason); } finally { setBusy(false); } };
  return <Card><div className="card-heading"><div><span className="eyebrow">New Workspace</span><h2>Workspace 추가</h2></div><UsersRound /></div><p>같은 Node 안에 독립된 기억 경계를 만듭니다.</p><form className="stack-form" onSubmit={submit}><label>Workspace 이름<input value={workspaceName} onChange={event => setWorkspaceName(event.target.value)} placeholder="새 Workspace" required /></label><label>첫 Project<input value={projectName} onChange={event => setProjectName(event.target.value)} placeholder="General" required /></label>{Boolean(error) && <span className="error-copy">{error instanceof Error ? error.message : "Workspace를 만들지 못했습니다."}</span>}<Button className="secondary" disabled={busy || !workspaceName.trim() || !projectName.trim()}>{busy ? "만드는 중…" : "Workspace 만들기"}</Button></form></Card>;
}

function SharedMemorySection({ workspaceId, shares, projections, run }: { workspaceId: string; shares: WorkspaceShare[]; projections: WorkspaceProjection[]; run: (action: () => Promise<unknown>, success: string) => Promise<void> }) {
  const visibleWorkspaces = projections.filter(item => item.display_mode === "workspace");
  const visibleProjects = projections.filter(item => item.display_mode === "projects").flatMap(item => item.project_refs.map(project => ({ projection: item, project })));
  const requests = shares.filter(item => ["proposed", "active"].includes(item.status) && (item.status !== "active" || item.owner_workspace_id === workspaceId));

  return <Card className="shared-memory-card">
    <div className="card-heading"><div><span className="eyebrow">External memory</span><h2>연결된 외부 기억</h2></div><Link2 /></div>
    <p>Workspace는 기본적으로 격리됩니다. 아래에는 양쪽 소유자가 승인한 Workspace 또는 Project만 표시됩니다.</p>
    {!projections.length ? <EmptyState icon={<Link2 />} title="표시 중인 외부 기억이 없습니다.">공유 요청이 양쪽에서 승인되면 여기에 나타납니다.</EmptyState> : <div className="external-memory-layout">
      {visibleWorkspaces.map(projection => <article key={projection.share_id} className="external-workspace"><header><div><span className="eyebrow">EXTERNAL WORKSPACE</span><strong>{projection.owner_workspace_name || projection.owner_workspace_id}</strong></div><StatusPill state="active" label="공유 중" /></header><div>{projection.project_refs.map(project => <span key={project.id}><FolderKanban size={14} />{project.name}</span>)}</div></article>)}
      {visibleProjects.length > 0 && <section className="external-projects"><span className="eyebrow">EXTERNAL PROJECTS</span>{visibleProjects.map(({ projection, project }) => <article key={`${projection.share_id}:${project.id}`}><FolderKanban /><div><strong>{project.name}</strong><small>{projection.owner_workspace_name || projection.owner_workspace_id}</small></div><StatusPill state="active" label="외부" /></article>)}</section>}
    </div>}
    {requests.length > 0 && <div className="share-request-list"><h3>공유 합의와 관리</h3>{requests.map(share => {
      const incoming = share.recipient_workspace_id === workspaceId;
      const other = incoming ? share.owner_workspace_name || share.owner_workspace_id : share.recipient_workspace_name || share.recipient_workspace_id;
      const remove = incoming && share.status === "proposed" ? () => workspaceApi.rejectShare(workspaceId, share.id) : () => workspaceApi.revokeShare(workspaceId, share.id);
      return <article key={share.id}><div><strong>{incoming ? `${other}에서 보낸 요청` : `${other}에게 보낸 요청`}</strong><small>{share.display_mode === "workspace" ? "Workspace로 표시" : "Project만 표시"} · {share.project_refs.map(item => item.name).join(", ")}</small></div><div><StatusPill state={share.status} />{incoming && share.status === "proposed" && <Button className="primary compact" onClick={() => run(() => workspaceApi.approveShare(workspaceId, share.id), "공유를 승인했습니다.")}><Check size={14} />승인</Button>}<Button className="secondary compact" onClick={() => run(remove, share.status === "active" ? "공유 연결을 해제했습니다." : incoming ? "공유 요청을 거절했습니다." : "공유 요청을 취소했습니다.")}><X size={14} />{share.status === "active" ? "연결 해제" : incoming ? "거절" : "취소"}</Button></div></article>;
    })}</div>}
  </Card>;
}

function ShareProposal({ workspaceId, projects, onCreated, onRefresh, onError }: { workspaceId: string; projects: ProjectOption[]; onCreated: () => void; onRefresh: () => void; onError: (error: unknown) => void }) {
  const [recipientId, setRecipientId] = useState("");
  const [displayMode, setDisplayMode] = useState<WorkspaceShareDisplayMode>("workspace");
  const [projectIds, setProjectIds] = useState<string[]>(projects.map(item => item.id));
  const [busy, setBusy] = useState(false);
  const selectedIds = displayMode === "workspace" ? [] : projectIds;
  const toggle = (id: string) => setProjectIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); onError(null);
    try { await workspaceApi.proposeShare(workspaceId, { recipient_workspace_id: recipientId.trim(), display_mode: displayMode, project_ids: selectedIds }); setRecipientId(""); onCreated(); onRefresh(); }
    catch (error) { onError(error); } finally { setBusy(false); }
  };
  return <Card><div className="card-heading"><div><span className="eyebrow">Share agreement</span><h2>외부 공유 요청</h2></div><Link2 /></div><p>상대 Workspace 소유자가 승인해야 기억이 표시됩니다.</p><form className="stack-form share-form" onSubmit={submit}><label>상대 Workspace ID<input value={recipientId} onChange={event => setRecipientId(event.target.value)} placeholder="workspace-id" required /></label><label>상대 화면 표시 방식<select value={displayMode} onChange={event => setDisplayMode(event.target.value as WorkspaceShareDisplayMode)}><option value="workspace">Workspace로 묶어서 표시</option><option value="projects">선택한 Project만 표시</option></select></label>{displayMode === "workspace" ? <small className="share-mode-help">현재와 이후의 활성 Project가 외부 Workspace 묶음 안에 표시됩니다.</small> : <fieldset><legend>공유할 Project</legend>{projects.map(project => <label key={project.id}><input type="checkbox" checked={projectIds.includes(project.id)} onChange={() => toggle(project.id)} />{project.name}</label>)}</fieldset>}<Button className="primary" disabled={busy || !recipientId.trim() || (displayMode === "projects" && selectedIds.length === 0)}>{busy ? "요청 중…" : "소유자 승인 요청"}</Button></form></Card>;
}

function InviteMember({ workspaceId, onCreated, onRefresh, onError }: { workspaceId: string; onCreated: () => void; onRefresh: () => void; onError: (error: unknown) => void }) {
  const [email, setEmail] = useState(""); const [role, setRole] = useState<WorkspaceRole>("contributor"); const [busy, setBusy] = useState(false); const [inviteUrl, setInviteUrl] = useState("");
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); onError(null); try { const result = await workspaceApi.inviteMember(workspaceId, { email: email.trim(), role }); setInviteUrl(result.invite_url || "초대가 생성되었습니다."); setEmail(""); onCreated(); onRefresh(); } catch (error) { onError(error); } finally { setBusy(false); } };
  return <Card><div className="card-heading"><div><span className="eyebrow">Invite</span><h2>멤버 초대</h2></div><UserPlus /></div><form className="stack-form" onSubmit={submit}><label>이메일<input type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="member@example.com" required /></label><label>역할<select value={role} onChange={event => setRole(event.target.value as WorkspaceRole)}><option value="admin">admin</option><option value="contributor">contributor</option><option value="viewer">viewer</option></select></label><Button className="primary" disabled={busy || !email.trim()}>{busy ? "생성 중…" : "7일 초대 링크 생성"}</Button>{inviteUrl && <div className="invite-result"><code>{inviteUrl}</code></div>}</form></Card>;
}

function CreateCredential({ scope, agentPeers, onCreated, onError }: { scope: Scope; agentPeers: Array<{ id: string; client: string; name?: string }>; onCreated: (value: CreatedCredential) => void; onError: (error: unknown) => void }) {
  const [name, setName] = useState(""); const [client, setClient] = useState<"codex" | "claude" | "custom">("codex"); const [agentPeerId, setAgentPeerId] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); onError(null); try { const created = await workspaceApi.createCredential({ workspace_id: scope.workspaceId, project_id: scope.projectId, name: name.trim(), client, agent_peer_id: agentPeerId || undefined, capabilities: DEFAULT_CAPABILITIES }); onCreated(created); setName(""); } catch (error) { onError(error); } finally { setBusy(false); } };
  return <Card><div className="card-heading"><div><span className="eyebrow">New connection</span><h2>MCP credential 발급</h2></div><KeyRound /></div><form className="stack-form" onSubmit={submit}><label>이름<input value={name} onChange={event => setName(event.target.value)} placeholder="Aram의 Codex" required /></label><label>클라이언트<select value={client} onChange={event => setClient(event.target.value as typeof client)}><option value="codex">Codex</option><option value="claude">Claude</option><option value="custom">Custom</option></select></label><label>Agent Peer<select value={agentPeerId} onChange={event => setAgentPeerId(event.target.value)}><option value="">Human Peer만 사용</option>{agentPeers.map(peer => <option key={peer.id} value={peer.id}>{peer.name || peer.client} · {peer.id}</option>)}</select></label><Button className="primary" disabled={busy || !name.trim()}>{busy ? "발급 중…" : "Credential 발급"}</Button></form></Card>;
}

function CredentialSecret({ created, onClose }: { created: CreatedCredential; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { await navigator.clipboard.writeText(created.secret); setCopied(true); };
  return <div className="credential-secret" role="status"><div><strong>Credential을 지금 저장하세요.</strong><p>보안을 위해 이 secret은 다시 표시되지 않습니다.</p><code>{created.secret}</code></div><div><Button className="secondary" onClick={copy}><Copy size={15} />{copied ? "복사됨" : "복사"}</Button><Button className="secondary" onClick={onClose}>닫기</Button></div></div>;
}
