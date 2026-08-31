import { Check, Copy, KeyRound, Link2, ShieldCheck, UserPlus, UsersRound, X } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { teamApi } from "../api";
import { Button, Card, EmptyState, ErrorState, formatDate, LoadingState, PageHeading, StatusPill, SuccessMessage } from "../components/common";
import { useRemote } from "../hooks";
import type { CreatedCredential, Scope, WorkspaceRole } from "../types";

const DEFAULT_CAPABILITIES = ["project.read", "project.write", "wiki.read", "wiki.write", "transfer.manage"];

export function TeamPage({ scope }: { scope: Scope }) {
  const remote = useRemote(() => teamApi.dashboard(scope), [scope.workspaceId, scope.projectId]);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState<unknown>(null);
  const [createdCredential, setCreatedCredential] = useState<CreatedCredential | null>(null);

  const bindings = useMemo(() => new Map(remote.data?.peer_bindings.map(item => [item.principal_id, item]) || []), [remote.data]);
  const run = async (action: () => Promise<unknown>, success: string) => {
    setActionError(null); setNotice("");
    try { await action(); setNotice(success); remote.retry(); }
    catch (error) { setActionError(error); }
  };

  if (remote.loading) return <LoadingState label="팀과 Peer 구성을 불러오는 중입니다." />;
  if (remote.error || !remote.data) return <ErrorState title="팀 관리 정보를 불러오지 못했습니다." error={remote.error} onRetry={remote.retry} />;
  const data = remote.data;

  return <>
    <PageHeading eyebrow="Workspace control plane" title="팀 관리" description="사람의 권한과 기억 속 Peer 정체성을 분리해 관리합니다. 이 화면은 제품 Workspace 전용이며 호스트 운영자 권한과 연결되지 않습니다." />
    {notice && <SuccessMessage>{notice}</SuccessMessage>}
    {actionError && <div className="inline-message error" role="alert">{actionError instanceof Error ? actionError.message : "요청을 처리하지 못했습니다."}</div>}
    {createdCredential && <CredentialSecret created={createdCredential} onClose={() => setCreatedCredential(null)} />}

    <div className="team-summary-grid">
      <Card><span className="eyebrow">Members</span><strong className="team-metric">{data.members.length}</strong><p>Workspace에 속한 사람과 역할</p></Card>
      <Card><span className="eyebrow">Human peers</span><strong className="team-metric">{data.peer_bindings.length}</strong><p>Workspace별로 격리된 기억 정체성</p></Card>
      <Card><span className="eyebrow">Agent peers</span><strong className="team-metric">{data.peer_bindings.reduce((sum, item) => sum + item.agent_peers.length, 0)}</strong><p>Codex·Claude·공용 에이전트</p></Card>
      <Card><span className="eyebrow">Transfer inbox</span><strong className="team-metric">{data.transfer_requests.filter(item => item.status.startsWith("pending")).length}</strong><p>양쪽 승인을 기다리는 기억 이관</p></Card>
    </div>

    <div className="team-two-column">
      <Card>
        <div className="card-heading"><div><span className="eyebrow">Membership</span><h2>멤버와 Peer</h2></div><UsersRound /></div>
        <div className="team-list">
          {data.members.map(member => {
            const binding = bindings.get(member.principal_id);
            const humanPeerId = binding?.human_peer_id || member.human_peer_id;
            const agentPeers = binding?.agent_peers || member.agent_peers;
            return <article key={member.id} className="team-member">
              <header><div><strong>{member.display_name}</strong><small>{member.email || member.principal_id}</small></div><div><span className="role-badge">{member.role}</span><StatusPill state={member.status} /></div></header>
              <div className="peer-binding"><span>Human Peer</span><code>{humanPeerId}</code><StatusPill state={binding?.human_peer_status || member.human_peer_status || "active"} /></div>
              {agentPeers.length > 0 ? <div className="agent-peer-list">{agentPeers.map(peer => <div key={peer.id}><span className={`agent-mark ${peer.client}`}>{peer.client}</span><strong>{peer.name || `${peer.client} Agent`}</strong><code>{peer.id}</code><StatusPill state={peer.status} /></div>)}</div> : <small className="muted-copy">연결된 Agent Peer가 없습니다.</small>}
            </article>;
          })}
          {data.peer_bindings.filter(binding => !data.members.some(member => member.principal_id === binding.principal_id)).map(binding => <article key={binding.principal_id} className="team-member">
            <header><div><strong>{binding.display_name || "Workspace 공용 Agent"}</strong><small>Workspace-owned Peer</small></div><StatusPill state="active" /></header>
            <div className="agent-peer-list">{binding.agent_peers.map(peer => <div key={peer.id}><span className={`agent-mark ${peer.client}`}>{peer.client}</span><strong>{peer.name || `${peer.client} Agent`}</strong><code>{peer.id}</code><StatusPill state={peer.status} /></div>)}</div>
          </article>)}
        </div>
      </Card>
      <InviteMember workspaceId={scope.workspaceId} onCreated={() => run(async () => undefined, "초대 링크를 생성했습니다.")} onRefresh={remote.retry} onError={setActionError} />
    </div>

    <div className="team-two-column">
      <Card>
        <div className="card-heading"><div><span className="eyebrow">Credentials</span><h2>API·MCP 연결</h2></div><KeyRound /></div>
        {data.credentials.length === 0 ? <p>발급된 credential이 없습니다.</p> : <div className="compact-list">{data.credentials.map(item => <article key={item.id}><div><strong>{item.name}</strong><small><code>{item.prefix}…</code> · {item.agent_peer_id ? "Agent Peer 연결" : "Human Peer 연결"}</small></div><div><StatusPill state={item.revoked_at ? "inactive" : "active"} /><Button className="secondary compact" disabled={Boolean(item.revoked_at)} onClick={() => run(() => teamApi.revokeCredential(scope, item.id), "Credential을 폐기했습니다.")}>폐기</Button></div></article>)}</div>}
      </Card>
      <CreateCredential scope={scope} agentPeers={data.peer_bindings.flatMap(item => item.agent_peers)} onCreated={created => { setCreatedCredential(created); remote.retry(); }} onError={setActionError} />
    </div>

    <div className="team-two-column">
      <Card>
        <div className="card-heading"><div><span className="eyebrow">Project access</span><h2>현재 Project 권한</h2></div><ShieldCheck /></div>
        {data.project_grants.length === 0 ? <p>Workspace 역할을 그대로 상속합니다.</p> : <div className="compact-list">{data.project_grants.map(grant => <article key={grant.id}><div><strong>{grant.principal_id || `${grant.role} 역할`}</strong><small>{grant.capabilities.join(" · ")}</small></div><Button className="secondary compact" onClick={() => run(() => teamApi.revokeProjectGrant(scope, grant.id), "Project grant를 회수했습니다.")}>회수</Button></article>)}</div>}
      </Card>
      <Card>
        <div className="card-heading"><div><span className="eyebrow">Federation</span><h2>Workspace 연결</h2></div><Link2 /></div>
        {data.workspace_links.length === 0 ? <p>연결된 외부 Workspace가 없습니다. 연결만으로는 기억 접근권이 생기지 않습니다.</p> : <div className="compact-list">{data.workspace_links.map(link => <article key={link.id}><div><strong>{link.target_workspace_name || link.target_workspace_id}</strong><small>{link.id}</small></div><StatusPill state={link.status} /></article>)}</div>}
        {data.federated_grants.length > 0 && <div className="federated-grants"><h3>읽기 Grant</h3>{data.federated_grants.map(grant => <div key={grant.id}><span>{grant.source_project_name || grant.source_project_id}</span><small>{grant.capabilities.join(" · ")}</small><StatusPill state={grant.status} /></div>)}</div>}
      </Card>
    </div>

    <Card>
      <div className="card-heading"><div><span className="eyebrow">Audited transfer</span><h2>기억 이관함</h2></div><ShieldCheck /></div>
      {data.transfer_requests.length === 0 ? <EmptyState title="대기 중인 기억 이관이 없습니다.">외부 검색 결과는 자동 저장되지 않으며 양쪽 Workspace Admin 승인을 받아야 합니다.</EmptyState> : <div className="transfer-list">{data.transfer_requests.map(item => <article key={item.id}><div><strong>{item.source_project_id} → {item.target_project_id}</strong><p>{item.reason}</p><small>{item.record_ids.length}개 원문 · {formatDate(item.created_at)}</small></div><div><StatusPill state={item.status} />{item.status.startsWith("pending") && <><Button className="secondary compact" onClick={() => run(() => teamApi.resolveTransferRequest(scope, item.id, "reject"), "이관 요청을 거절했습니다.")}><X size={14} />거절</Button><Button className="primary compact" onClick={() => run(() => teamApi.resolveTransferRequest(scope, item.id, "approve"), "이관 요청을 승인했습니다.")}><Check size={14} />승인</Button></>}</div></article>)}</div>}
    </Card>
  </>;
}

function InviteMember({ workspaceId, onCreated, onRefresh, onError }: { workspaceId: string; onCreated: () => void; onRefresh: () => void; onError: (error: unknown) => void }) {
  const [email, setEmail] = useState(""); const [role, setRole] = useState<WorkspaceRole>("contributor"); const [busy, setBusy] = useState(false); const [inviteUrl, setInviteUrl] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); onError(null);
    try { const result = await teamApi.inviteMember(workspaceId, { email: email.trim(), role }); setInviteUrl(result.invite_url || "초대가 생성되었습니다."); setEmail(""); onCreated(); onRefresh(); }
    catch (error) { onError(error); } finally { setBusy(false); }
  };
  return <Card><div className="card-heading"><div><span className="eyebrow">Invite</span><h2>팀원 초대</h2></div><UserPlus /></div><form className="stack-form" onSubmit={submit}><label>이메일<input type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="member@example.com" required /></label><label>역할<select value={role} onChange={event => setRole(event.target.value as WorkspaceRole)}><option value="admin">admin</option><option value="contributor">contributor</option><option value="viewer">viewer</option></select></label><Button className="primary" disabled={busy || !email.trim()}>{busy ? "생성 중…" : "7일 초대 링크 생성"}</Button>{inviteUrl && <div className="invite-result"><code>{inviteUrl}</code></div>}</form></Card>;
}

function CreateCredential({ scope, agentPeers, onCreated, onError }: { scope: Scope; agentPeers: Array<{ id: string; client: string; name?: string }>; onCreated: (value: CreatedCredential) => void; onError: (error: unknown) => void }) {
  const [name, setName] = useState(""); const [client, setClient] = useState<"codex" | "claude" | "custom">("codex"); const [agentPeerId, setAgentPeerId] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); onError(null);
    try { const created = await teamApi.createCredential({ workspace_id: scope.workspaceId, project_id: scope.projectId, name: name.trim(), client, agent_peer_id: agentPeerId || undefined, capabilities: DEFAULT_CAPABILITIES }); onCreated(created); setName(""); }
    catch (error) { onError(error); } finally { setBusy(false); }
  };
  return <Card><div className="card-heading"><div><span className="eyebrow">New connection</span><h2>MCP credential 발급</h2></div><KeyRound /></div><form className="stack-form" onSubmit={submit}><label>이름<input value={name} onChange={event => setName(event.target.value)} placeholder="Aram의 Codex" required /></label><label>클라이언트<select value={client} onChange={event => setClient(event.target.value as typeof client)}><option value="codex">Codex</option><option value="claude">Claude</option><option value="custom">Custom</option></select></label><label>Agent Peer<select value={agentPeerId} onChange={event => setAgentPeerId(event.target.value)}><option value="">Human Peer만 사용</option>{agentPeers.map(peer => <option key={peer.id} value={peer.id}>{peer.name || peer.client} · {peer.id}</option>)}</select></label><Button className="primary" disabled={busy || !name.trim()}>{busy ? "발급 중…" : "Credential 발급"}</Button></form></Card>;
}

function CredentialSecret({ created, onClose }: { created: CreatedCredential; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { await navigator.clipboard.writeText(created.secret); setCopied(true); };
  return <div className="credential-secret" role="status"><div><strong>Credential을 지금 저장하세요.</strong><p>보안을 위해 이 secret은 다시 표시되지 않습니다.</p><code>{created.secret}</code></div><div><Button className="secondary" onClick={copy}><Copy size={15} />{copied ? "복사됨" : "복사"}</Button><Button className="secondary" onClick={onClose}>닫기</Button></div></div>;
}
