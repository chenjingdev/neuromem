import { Activity, Archive, ChevronDown, CircleStop, DatabaseBackup, FileClock, HardDrive, ListRestart, Play, RefreshCw, RotateCw, Server, ShieldCheck, TerminalSquare, TriangleAlert } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { ApiError, managerApi } from "../api";
import { Button, Card, EmptyState, ErrorState, LoadingState, PageHeading, StatusPill, SuccessMessage, errorMessage, formatBytes, formatDate, formatNumber } from "../components/common";
import { useRemote, type RemoteState } from "../hooks";
import type { Backup, NodeHealth, NodeSummary, OperationPlan, OperationResult, ServiceState } from "../types";

export function AdminPage({ productUrl }: { productUrl: string }) {
  const nodes = useRemote(() => managerApi.nodes(), []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const activeId = selectedId || nodes.data?.[0]?.id || null;

  if (nodes.loading) return <AdminFrame productUrl={productUrl}><LoadingState label="이 기기의 Neuromem Node를 확인하고 있습니다." /></AdminFrame>;
  if (nodes.error instanceof ApiError && nodes.error.status === 401) return <AdminFrame productUrl={productUrl}><AdminAuthRequired /></AdminFrame>;
  if (nodes.error) return <AdminFrame productUrl={productUrl}><ErrorState title="Node Manager에 연결할 수 없습니다." error={nodes.error} onRetry={nodes.retry} /></AdminFrame>;

  return <AdminFrame productUrl={productUrl}>
    <PageHeading eyebrow="LOCAL NODE OPERATOR" title="Node 관리" description="이 기기에서 실행되는 Neuromem 전체 상태와 안전한 복구 작업만 관리합니다." />
    {!nodes.data?.length ? <EmptyState icon={<Server />} title="등록된 Node가 없습니다.">터미널에서 Node를 한 번 등록한 뒤 이 화면을 다시 열어주세요.</EmptyState> : <div className="admin-layout">
      <aside className="node-list" aria-label="Node 목록"><span className="eyebrow">NODES</span>{nodes.data.map(node => <button key={node.id} className={activeId === node.id ? "selected" : ""} onClick={() => setSelectedId(node.id)}><Server /><span><strong>{node.name || node.id}</strong><small>{node.endpoint || node.version || node.id}</small></span><StatusPill state={node.state || "unknown"} /></button>)}</aside>
      {activeId && <NodeDetail nodeId={activeId} summary={nodes.data.find(node => node.id === activeId) || nodes.data[0]} />}
    </div>}
  </AdminFrame>;
}

function AdminFrame({ productUrl, children }: { productUrl: string; children: React.ReactNode }) {
  return <div className="admin-page"><header className="admin-topbar"><a className="wordmark" href={productUrl}><span className="brand-mark">N</span><span>Neuromem</span></a><div><span className="local-badge"><ShieldCheck size={14} />이 기기 전용</span><a href={productUrl}>기억 화면으로</a></div></header><main className="admin-content">{children}</main></div>;
}

export function AdminAuthRequired() {
  return <div className="state-panel auth-required" role="alert"><ShieldCheck /><strong>관리자 링크가 필요합니다.</strong><p>관리자 세션은 주소에 비밀값을 저장하지 않습니다. 이 기기의 터미널에서 아래 명령을 실행해 새 링크를 여세요.</p><code>neuromem admin open</code></div>;
}

function NodeDetail({ nodeId, summary }: { nodeId: string; summary: NodeSummary }) {
  const health = useRemote(() => managerApi.health(nodeId), [nodeId]);
  const backlog = useRemote(() => managerApi.backlog(nodeId), [nodeId]);
  const backups = useRemote(() => managerApi.backups(nodeId), [nodeId]);
  const [tab, setTab] = useState<"status" | "recovery">("status");
  const refresh = () => { health.retry(); backlog.retry(); backups.retry(); };
  const state = health.data ? healthState(health.data) : summary.state || "unknown";

  return <section className="node-detail">
    <div className="node-title"><div><span className="eyebrow">{nodeId}</span><h2>{summary.name || nodeId}</h2></div><div><StatusPill state={state} /><button className="icon-button" onClick={refresh} aria-label="Node 상태 새로고침"><RefreshCw /></button></div></div>
    <div className="subtabs" role="tablist"><button role="tab" aria-selected={tab === "status"} onClick={() => setTab("status")}>상태</button><button role="tab" aria-selected={tab === "recovery"} onClick={() => setTab("recovery")}>데이터와 복구</button></div>
    {tab === "status" ? <StatusTab nodeId={nodeId} state={state} health={health} backlog={backlog} onRefresh={refresh} /> : <RecoveryTab nodeId={nodeId} backups={backups} />}
  </section>;
}

function StatusTab({ nodeId, state, health, backlog, onRefresh }: { nodeId: string; state: ServiceState; health: RemoteState<NodeHealth>; backlog: RemoteState<Awaited<ReturnType<typeof managerApi.backlog>>>; onRefresh: () => void }) {
  const [operation, setOperation] = useState<OperationResult | null>(null);
  const [operationError, setOperationError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"restart" | "stop" | null>(null);

  const control = async (action: "start" | "stop" | "restart") => {
    setConfirmAction(null); setBusy(true); setOperationError(null);
    try { setOperation(await managerApi.control(nodeId, action)); window.setTimeout(onRefresh, 900); }
    catch (error) { setOperationError(error); }
    finally { setBusy(false); }
  };

  if (health.loading && !health.data) return <LoadingState label="Node 상태와 서비스를 확인하고 있습니다." />;
  if (health.error && !health.data) return <ErrorState title="Node 상태를 확인하지 못했습니다." error={health.error} onRetry={health.retry} />;
  const data = health.data;
  const components = data?.components || data?.checks || [];
  const endpoints = Object.entries(data?.endpoints || {});

  return <div className="admin-tab-content">
    {state === "degraded" || data?.error ? <div className="degraded-banner"><TriangleAlert /><div><strong>Node가 완전히 정상은 아닙니다.</strong><p>{data?.error || data?.message || "아래 구성요소와 로그를 확인한 뒤 전체 Node를 재시작할 수 있습니다."}</p></div></div> : null}
    <div className="node-control-row"><div><strong>{state === "healthy" ? "모든 핵심 구성요소가 정상입니다." : state === "stopped" ? "Node가 중지되어 있습니다." : "Node 복구가 필요합니다."}</strong><p>개별 컨테이너 대신 Node 전체를 안전한 순서로 제어합니다.</p></div>
      {state === "stopped" ? <Button className="primary" disabled={busy} onClick={() => control("start")}><Play size={17} />Node 시작</Button>
        : state === "degraded" || state === "unavailable" ? <Button className="primary" disabled={busy} onClick={() => setConfirmAction("restart")}><ListRestart size={17} />전체 복구</Button>
          : null}
    </div>
    {operation && <SuccessMessage>{operation.phase || operation.message || `${operation.kind || "Node 작업"} 요청을 보냈습니다.`}</SuccessMessage>}
    {Boolean(operationError) && <div className="inline-message error"><TriangleAlert />{errorMessage(operationError)}</div>}
    <div className="admin-summary-grid">
      <Card><div className="card-heading"><div><span className="eyebrow">HEALTH</span><h3>구성요소</h3></div><StatusPill state={state} /></div><div className="health-list">{components.length ? components.map(component => <div key={component.name}><span><i className={`health-dot ${healthStateFromValue(componentHealth(component))}`} />{component.name}</span><strong>{component.detail || componentHealth(component) || component.state}</strong></div>) : <p className="muted-copy">구성요소 정보가 없습니다.</p>}</div></Card>
      <Card><div className="card-heading"><div><span className="eyebrow">BACKLOG</span><h3>처리 대기열</h3></div><Activity /></div>{backlog.loading ? <p className="muted-copy">확인 중…</p> : backlog.error ? <p className="error-copy">{errorMessage(backlog.error)}</p> : <div className="backlog-grid"><div><span>대기</span><strong>{formatNumber(backlog.data?.pending)}</strong></div><div><span>처리 중</span><strong>{formatNumber(backlog.data?.running)}</strong></div><div><span>실패</span><strong>{formatNumber(backlog.data?.failed)}</strong></div></div>}</Card>
    </div>
    {endpoints.length > 0 && <Card><div className="card-heading"><div><span className="eyebrow">ENDPOINTS</span><h3>서비스 주소</h3></div></div><div className="endpoint-list">{endpoints.map(([name, value]) => <div key={name}><span>{name}</span><code>{value}</code></div>)}</div></Card>}
    <details className="disclosure"><summary><span><TerminalSquare />최근 로그</span><ChevronDown /></summary><Logs nodeId={nodeId} /></details>
    <details className="disclosure node-controls"><summary><span><RotateCw />Node 제어</span><ChevronDown /></summary><div><p>정상 상태에서는 제어가 필요하지 않습니다. 재시작과 중지는 Node 전체에 적용됩니다.</p><Button className="secondary" disabled={busy || state === "stopped"} onClick={() => setConfirmAction("restart")}><RotateCw size={16} />재시작</Button><Button className="quiet danger-text" disabled={busy || state === "stopped"} onClick={() => setConfirmAction("stop")}><CircleStop size={16} />중지</Button></div></details>
    {confirmAction && <ConfirmDialog title={confirmAction === "stop" ? "Node를 중지할까요?" : "Node를 재시작할까요?"} description={confirmAction === "stop" ? "기억 데이터는 보존되지만 에이전트 연결이 끊깁니다." : "전체 구성요소를 안전한 순서로 다시 시작합니다."} confirmLabel={confirmAction === "stop" ? "Node 중지" : "재시작"} onCancel={() => setConfirmAction(null)} onConfirm={() => control(confirmAction)} />}
  </div>;
}

function Logs({ nodeId }: { nodeId: string }) {
  const logs = useRemote(() => managerApi.logs(nodeId, 200), [nodeId]);
  if (logs.loading) return <p className="muted-copy">로그를 불러오는 중…</p>;
  if (logs.error) return <ErrorState error={logs.error} onRetry={logs.retry} />;
  return <pre className="log-view" tabIndex={0}>{logs.data?.length ? logs.data.map(log => `${log.timestamp ? `[${log.timestamp}] ` : ""}${log.level ? `${log.level.toUpperCase()} ` : ""}${log.service ? `${log.service}: ` : ""}${log.message}`).join("\n") : "최근 로그가 없습니다."}</pre>;
}

function RecoveryTab({ nodeId, backups }: { nodeId: string; backups: RemoteState<Backup[]> }) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [selectedBackup, setSelectedBackup] = useState("");
  const [plan, setPlan] = useState<OperationPlan | null>(null);

  const createBackup = async (event: FormEvent) => {
    event.preventDefault(); setBusy("backup"); setError(null); setMessage(null);
    try { await managerApi.createBackup(nodeId, label.trim()); setLabel(""); setMessage("백업을 만들고 무결성 검증을 완료했습니다."); backups.retry(); }
    catch (reason) { setError(reason); }
    finally { setBusy(null); }
  };
  const verify = async (backupId: string) => {
    setBusy(`verify:${backupId}`); setError(null); setMessage(null);
    try { await managerApi.verifyBackup(nodeId, backupId); setMessage("백업 무결성 검증을 완료했습니다."); backups.retry(); }
    catch (reason) { setError(reason); }
    finally { setBusy(null); }
  };
  const makePlan = async (kind: "restore" | "migrate") => {
    setBusy(kind); setError(null); setMessage(null); setPlan(null);
    try { setPlan(kind === "restore" ? await managerApi.restorePlan(nodeId, selectedBackup) : await managerApi.migratePlan(nodeId)); }
    catch (reason) { setError(reason); }
    finally { setBusy(null); }
  };

  return <div className="admin-tab-content recovery-content">
    <div className="notice-card"><ShieldCheck /><div><strong>이 화면은 계획과 검증까지만 수행합니다.</strong><p>복원이나 마이그레이션을 실제로 적용하는 위험 버튼은 제공하지 않습니다.</p></div></div>
    {message && <SuccessMessage>{message}</SuccessMessage>}{Boolean(error) && <div className="inline-message error"><TriangleAlert />{errorMessage(error)}</div>}
    <div className="recovery-grid">
      <Card><div className="card-heading"><div><span className="eyebrow">BACKUP</span><h3>백업 만들기</h3></div><DatabaseBackup /></div><p>현재 Node 데이터를 일관된 스냅샷으로 보관합니다.</p><form className="stack-form" onSubmit={createBackup}><label>백업 이름 <span>선택 사항</span><input value={label} maxLength={80} onChange={event => setLabel(event.target.value)} placeholder="before-update" /></label><Button className="primary" disabled={busy === "backup"}>{busy === "backup" ? "시작 중…" : "백업 만들기"}</Button></form></Card>
      <Card><div className="card-heading"><div><span className="eyebrow">PLANS</span><h3>변경 전 확인</h3></div><FileClock /></div><p>데이터를 바꾸지 않고 복원 또는 스키마 이관 과정을 미리 검사합니다.</p><label className="stack-label">복원할 백업<select value={selectedBackup} onChange={event => setSelectedBackup(event.target.value)}><option value="">백업 선택</option>{backups.data?.map(backup => <option key={backup.id} value={backup.id}>{backup.label || backup.id} · {formatDate(backup.created_at)}</option>)}</select></label><div className="button-row"><Button className="secondary" disabled={!selectedBackup || busy === "restore"} onClick={() => makePlan("restore")}>복원 계획 보기</Button><Button className="secondary" disabled={busy === "migrate"} onClick={() => makePlan("migrate")}>이관 계획 보기</Button></div></Card>
    </div>
    <Card><div className="card-heading"><div><span className="eyebrow">ARCHIVE</span><h3>보관된 백업</h3></div><Archive /></div>{backups.loading ? <p className="muted-copy">백업 목록을 불러오는 중…</p> : backups.error ? <ErrorState error={backups.error} onRetry={backups.retry} /> : !backups.data?.length ? <p className="muted-copy">아직 만든 백업이 없습니다.</p> : <div className="backup-list">{backups.data.map(backup => <article key={backup.id}><div><strong>{backup.label || "이름 없는 백업"}</strong><small>{formatDate(backup.created_at)} · {formatBytes(backup.size_bytes)}</small><code>{backup.id}</code></div><div><StatusPill state={backup.state || "ready"} /> <Button className="quiet" disabled={busy === `verify:${backup.id}`} onClick={() => verify(backup.id)}>검증</Button></div></article>)}</div>}</Card>
    {plan && <PlanView plan={plan} />}
  </div>;
}

function PlanView({ plan }: { plan: OperationPlan }) {
  return <Card className="plan-card"><div className="card-heading"><div><span className="eyebrow">READ-ONLY PLAN</span><h3>{plan.title}</h3></div><StatusPill state={plan.allowed ? "ready" : "degraded"} label={plan.allowed ? "실행 가능" : "확인 필요"} /></div>{plan.summary && <p>{plan.summary}</p>}{plan.estimated_downtime_seconds != null && <div className="plan-fact"><span>예상 중단 시간</span><strong>약 {formatNumber(plan.estimated_downtime_seconds)}초</strong></div>}{Boolean(plan.warnings?.length) && <ul className="warning-list">{plan.warnings?.map(warning => <li key={warning}>{warning}</li>)}</ul>}<ol className="plan-steps">{plan.steps?.map((step, index) => <li key={`${index}-${step.title}`}><span>{index + 1}</span><div><strong>{step.title}</strong>{step.detail && <p>{step.detail}</p>}</div>{step.state && <StatusPill state={step.state} />}</li>)}</ol><p className="plan-footer">이 화면에서는 계획만 생성하며 실제 데이터는 변경하지 않습니다.</p></Card>;
}

function ConfirmDialog({ title, description, confirmLabel, onCancel, onConfirm }: { title: string; description: string; confirmLabel: string; onCancel: () => void; onConfirm: () => void }) {
  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}><div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title"><h2 id="confirm-title">{title}</h2><p>{description}</p><div><Button className="secondary" autoFocus onClick={onCancel}>취소</Button><Button className="danger" onClick={onConfirm}>{confirmLabel}</Button></div></div></div>;
}

function healthState(health: NodeHealth): ServiceState {
  if (health.state) return health.state;
  if (health.error || health.docker_available === false) return "unavailable";
  const values = (health.components || health.checks || []).map(item => healthStateFromValue(componentHealth(item)));
  if (!values.length) return health.phase === "stopped" ? "stopped" : "unknown";
  if (values.every(value => value === "healthy")) return "healthy";
  if (values.every(value => value === "stopped")) return "stopped";
  return "degraded";
}

function componentHealth(component: { state: string; health?: string }) {
  return component.health || component.state;
}

function healthStateFromValue(value?: string): ServiceState {
  const normalized = String(value || "unknown").toLowerCase();
  if (["healthy", "ready", "running", "ok"].includes(normalized)) return "healthy";
  if (["stopped", "exited", "disabled"].includes(normalized)) return "stopped";
  if (["failed", "unhealthy", "unavailable", "error"].includes(normalized)) return "unavailable";
  if (["starting", "pending"].includes(normalized)) return "starting";
  return "degraded";
}
