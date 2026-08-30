import { Filter, Network, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { coreApi } from "../api";
import { Card, EmptyState, ErrorState, LoadingState, PageHeading, StatusPill, formatDate } from "../components/common";
import { EvidencePanel } from "../components/EvidencePanel";
import { useRemote } from "../hooks";
import type { Scope } from "../types";

export function ClaimsPage({ scope }: { scope: Scope }) {
  const claims = useRemote(() => coreApi.claims(scope), [scope.workspaceId, scope.projectId]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("active");
  const [selected, setSelected] = useState<string | null>(null);
  const filtered = useMemo(() => (claims.data?.items || []).filter(claim => {
    const active = status === "all" || (status === "active" ? !["rejected", "superseded"].includes(claim.status) : claim.status === status);
    return active && claim.text.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  }), [claims.data, query, status]);

  return <>
    <PageHeading title="주장" description="기록에서 정리된 기억과 현재 채택 상태를 근거까지 따라가며 확인합니다." />
    <Card className="toolbar-card"><label className="filter-input"><Search /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="주장 내용 검색" /></label><label className="select-control"><Filter /><span>상태</span><select value={status} onChange={event => setStatus(event.target.value)}><option value="active">현재 사용</option><option value="adopted">채택</option><option value="proposed">제안</option><option value="disputed">분쟁</option><option value="all">전체</option></select></label></Card>
    {claims.loading && <LoadingState label="주장을 불러오는 중입니다." />}
    {claims.error && <ErrorState error={claims.error} onRetry={claims.retry} />}
    {!claims.loading && !claims.error && !filtered.length && <EmptyState icon={<Network />} title="조건에 맞는 주장이 없습니다.">새 기록이 처리되면 출처와 함께 이곳에 나타납니다.</EmptyState>}
    {!claims.loading && !claims.error && Boolean(filtered.length) && <div className={`drilldown-layout ${selected ? "open" : ""}`}><div className="claim-list">
      {filtered.map(claim => <button key={claim.id} className={`claim-row interactive ${selected === claim.id ? "selected" : ""}`} onClick={() => setSelected(claim.id)}>
        <div><p>{claim.text}</p><small>{claim.derivation_method || "기록에서 추출"} · {formatDate(claim.updated_at)}</small></div><StatusPill state={claim.status} />
      </button>)}
    </div>{selected && <EvidencePanel scope={scope} claimId={selected} onClose={() => setSelected(null)} />}</div>}
  </>;
}
