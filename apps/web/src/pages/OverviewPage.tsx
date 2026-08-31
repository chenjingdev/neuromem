import { ArrowRight, BrainCircuit, Check, Clipboard, FileText, Radio, UsersRound } from "lucide-react";
import { useState } from "react";
import { coreApi } from "../api";
import { useRemote } from "../hooks";
import type { Scope } from "../types";
import { Card, EmptyState, ErrorState, LoadingState, PageHeading, StatusPill, formatNumber } from "../components/common";

export function OverviewPage({ scope, navigate }: { scope: Scope; navigate: (path: string) => void }) {
  const { data, error, loading, retry } = useRemote(() => coreApi.overview(scope), [scope.workspaceId, scope.projectId]);
  const [copied, setCopied] = useState(false);

  if (loading) return <><PageHeading title="프로젝트 기억" description="현재 팀 기억을 확인합니다." /><LoadingState /></>;
  if (error || !data) return <><PageHeading title="프로젝트 기억" description="현재 팀 기억을 확인합니다." /><ErrorState error={error} onRetry={retry} /></>;

  const copyMcp = async () => {
    await navigator.clipboard.writeText(data.mcp.url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return <>
    <PageHeading eyebrow={`${data.workspace.name} / ${data.project.name}`} title="기억의 현재 상태" description="General과 현재 Project 문맥을 팀 권한 경계 안에서 사용합니다." actions={<StatusPill state={data.state} />} />
    <div className="metric-grid team-product-metrics">
      <Card className="metric-card"><span><BrainCircuit size={17} />주장</span><strong>{formatNumber(data.counts.claims)}</strong><small>General + 현재 Project</small></Card>
      <Card className="metric-card"><span><UsersRound size={17} />Workspace</span><strong className="scope-metric">{data.workspace.name}</strong><small>권한과 Peer 경계</small></Card>
      <Card className="metric-card"><span><FileText size={17} />Project</span><strong className="scope-metric">{data.project.name}</strong><small>기억과 Wiki 문맥</small></Card>
    </div>
    <div className="overview-layout">
      <Card className="connection-card">
        <div className="card-heading"><div><span className="eyebrow">AGENT CONNECTION</span><h2>에이전트 연결</h2></div><StatusPill state={data.mcp.state} /></div>
        <p>팀 관리에서 발급한 MCP credential과 아래 주소를 Codex·Claude에 연결하세요.</p>
        <div className="copy-field"><code>{data.mcp.url}</code><button className="icon-text-button" onClick={copyMcp} aria-label="MCP 주소 복사">{copied ? <Check size={17} /> : <Clipboard size={17} />}{copied ? "복사됨" : "복사"}</button></div>
        <div className="connection-note"><Radio size={16} /><span>Credential에 묶인 Workspace·Project·Human/Agent Peer만 사용됩니다.</span></div>
      </Card>
      <Card className="queue-card"><div className="card-heading"><div><span className="eyebrow">SECURITY BOUNDARY</span><h2>팀 Gateway</h2></div><StatusPill state="healthy" /></div><p>브라우저와 에이전트 요청은 Control에서 권한을 다시 검증한 뒤 Memory Core로 전달됩니다.</p></Card>
    </div>
    <Card>
      <div className="card-heading"><div><span className="eyebrow">RECENT CONCLUSIONS</span><h2>최근 정리된 주장</h2></div><button className="text-link" onClick={() => navigate("/app/claims")}>전체 보기 <ArrowRight size={15} /></button></div>
      {!data.recent_claims?.length
        ? <EmptyState icon={<FileText />} title="아직 정리된 주장이 없습니다.">에이전트가 기록을 보내면 이곳에 나타납니다.</EmptyState>
        : <div className="claim-list compact">{data.recent_claims.slice(0, 5).map(claim => <article key={claim.id} className="claim-row"><div><p>{claim.text}</p><small>{claim.derivation_method || "기록에서 추출"}</small></div><StatusPill state={claim.status} /></article>)}</div>}
    </Card>
  </>;
}
