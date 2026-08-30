import { Activity, ArrowRight, BrainCircuit, Check, Clipboard, Database, FileText, Radio, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { coreApi } from "../api";
import { useRemote } from "../hooks";
import type { Scope } from "../types";
import { Card, DegradedBanner, EmptyState, ErrorState, LoadingState, PageHeading, StatusPill, formatNumber } from "../components/common";

export function OverviewPage({ scope, navigate }: { scope: Scope; navigate: (path: string) => void }) {
  const { data, error, loading, retry } = useRemote(() => coreApi.overview(scope), [scope.workspaceId, scope.projectId]);
  const recent = useRemote(() => coreApi.claims(scope), [scope.workspaceId, scope.projectId]);
  const [copied, setCopied] = useState(false);
  const [retryingFailed, setRetryingFailed] = useState(false);
  const [retryResult, setRetryResult] = useState<string | null>(null);

  if (loading) return <><PageHeading title="프로젝트 기억" description="현재 기록과 처리 상태를 확인합니다." /><LoadingState /></>;
  if (error || !data) return <><PageHeading title="프로젝트 기억" description="현재 기록과 처리 상태를 확인합니다." /><ErrorState error={error} onRetry={retry} /></>;

  const copyMcp = async () => {
    await navigator.clipboard.writeText(data.mcp.url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };
  const retryFailed = async () => {
    setRetryingFailed(true);
    try {
      const result = await coreApi.retryFailedJobs(scope);
      setRetryResult(`${result.retried}개 작업을 다시 대기열에 넣었습니다.`);
      retry();
    } catch (reason) {
      setRetryResult(reason instanceof Error ? reason.message : "재처리 요청에 실패했습니다.");
    } finally {
      setRetryingFailed(false);
    }
  };

  return <>
    <PageHeading
      eyebrow={`${data.workspace.name} / ${data.project.name}`}
      title="기억의 현재 상태"
      description="설정 단계 없이 이 프로젝트에 들어온 기록과 처리 상태를 바로 보여줍니다."
      actions={<StatusPill state={data.state} />}
    />

    {data.state === "degraded" && <DegradedBanner>{data.message || "새 기록은 안전하게 대기 중이며 처리 속도가 평소보다 느립니다."}</DegradedBanner>}

    <div className="metric-grid">
      <Card className="metric-card"><span><Database size={17} />기록</span><strong>{formatNumber(data.counts.records)}</strong><small>보존된 원본</small></Card>
      <Card className="metric-card"><span><BrainCircuit size={17} />주장</span><strong>{formatNumber(data.counts.claims)}</strong><small>검색 가능한 기억</small></Card>
      <Card className="metric-card"><span><Activity size={17} />처리 대기</span><strong>{formatNumber(data.processing.pending)}</strong><small>{data.processing.running ? `${formatNumber(data.processing.running)}건 처리 중` : "대기열 안정"}</small></Card>
      <Card className={`metric-card ${data.processing.failed ? "attention" : ""}`}><span><TriangleAlert size={17} />실패</span><strong>{formatNumber(data.processing.failed)}</strong><small>{data.processing.failed ? "검토가 필요합니다" : "최근 실패 없음"}</small></Card>
    </div>

    <div className="overview-layout">
      <Card className="connection-card">
        <div className="card-heading"><div><span className="eyebrow">AGENT CONNECTION</span><h2>에이전트 연결</h2></div><StatusPill state={data.mcp.state} /></div>
        <p>아래 주소를 에이전트의 MCP 설정에 붙여 넣으면 됩니다. 별도의 연결 단계는 없습니다.</p>
        <div className="copy-field"><code>{data.mcp.url}</code><button className="icon-text-button" onClick={copyMcp} aria-label="MCP 주소 복사">{copied ? <Check size={17} /> : <Clipboard size={17} />}{copied ? "복사됨" : "복사"}</button></div>
        <div className="connection-note"><Radio size={16} /><span>주소가 보이고 상태가 정상이라면 바로 사용할 수 있습니다.</span></div>
      </Card>

      <Card className="queue-card">
        <div className="card-heading"><div><span className="eyebrow">PROCESSING</span><h2>기억 처리</h2></div><StatusPill state={data.processing.failed ? "degraded" : data.processing.pending || data.processing.running ? "starting" : "healthy"} label={data.processing.failed ? "확인 필요" : data.processing.pending || data.processing.running ? "처리 중" : "정상"} /></div>
        <div className="queue-bars" aria-label="기억 처리 대기열">
          <QueueValue label="대기" value={data.processing.pending} />
          <QueueValue label="처리 중" value={data.processing.running} />
          <QueueValue label="실패" value={data.processing.failed} tone="bad" />
        </div>
        {data.processing.failed > 0 && <button className="text-link" disabled={retryingFailed} onClick={retryFailed}>{retryingFailed ? "요청 중…" : "실패 작업 재시도"}</button>}
        {retryResult && <p className="muted-copy" aria-live="polite">{retryResult}</p>}
      </Card>
    </div>

    <Card>
      <div className="card-heading"><div><span className="eyebrow">RECENT CLAIMS</span><h2>최근 정리된 주장</h2></div><button className="text-link" onClick={() => navigate("/app/claims")}>전체 보기 <ArrowRight size={15} /></button></div>
      {!(data.recent_claims?.length || recent.data?.items.length)
        ? <EmptyState icon={<FileText />} title="아직 정리된 주장이 없습니다.">에이전트가 기록을 보내면 근거와 함께 이곳에 나타납니다.</EmptyState>
        : <div className="claim-list compact">{(data.recent_claims || recent.data?.items || []).slice(0, 5).map(claim => <article key={claim.id} className="claim-row"><div><p>{claim.text}</p><small>{claim.derivation_method || "기록에서 추출"}</small></div><StatusPill state={claim.status} /></article>)}</div>}
    </Card>
  </>;
}

function QueueValue({ label, value, tone = "" }: { label: string; value: number; tone?: string }) {
  return <div className={tone}><span>{label}</span><strong>{formatNumber(value)}</strong></div>;
}
