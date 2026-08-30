import { ArrowLeft, FileText, Link2, Quote, X } from "lucide-react";
import { useState } from "react";
import { coreApi } from "../api";
import { useRemote } from "../hooks";
import type { Scope } from "../types";
import { ErrorState, LoadingState, StatusPill, formatDate } from "./common";

export function EvidencePanel({ scope, claimId, onClose }: { scope: Scope; claimId: string; onClose: () => void }) {
  const evidence = useRemote(() => coreApi.claimEvidence(scope, claimId), [scope.workspaceId, scope.projectId, claimId]);
  const [recordId, setRecordId] = useState<string | null>(null);

  return <aside className="evidence-panel" aria-label="주장과 출처 상세">
    <header><div><span className="eyebrow">CLAIM → RECORD</span><h2>근거 추적</h2></div><button className="icon-button" onClick={onClose} aria-label="상세 닫기"><X /></button></header>
    {recordId
      ? <RecordDetail scope={scope} recordId={recordId} onBack={() => setRecordId(null)} />
      : evidence.loading ? <LoadingState label="주장과 근거를 불러오는 중입니다." />
        : evidence.error || !evidence.data ? <ErrorState error={evidence.error} onRetry={evidence.retry} />
          : <div className="evidence-content">
            <div className="claim-focus"><StatusPill state={evidence.data.claim.status} /><p>{evidence.data.claim.text}</p><small>{evidence.data.claim.derivation_method || "기록에서 추출"}</small></div>
            <div className="evidence-list"><h3><Link2 size={17} />연결된 원본 {evidence.data.citations.length}개</h3>
              {!evidence.data.citations.length && <p className="muted-copy">연결된 원본을 찾지 못했습니다.</p>}
              {evidence.data.citations.map(citation => <button key={citation.record_id} className="citation-card" onClick={() => setRecordId(citation.record_id)}>
                <FileText aria-hidden="true" /><span><strong>{citation.label || citation.source || "원본 기록"}</strong>{citation.excerpt && <small>{citation.excerpt}</small>}<code>{citation.record_id}</code></span>
              </button>)}
            </div>
          </div>}
  </aside>;
}

function RecordDetail({ scope, recordId, onBack }: { scope: Scope; recordId: string; onBack: () => void }) {
  const record = useRemote(() => coreApi.recordContext(scope, recordId), [scope.workspaceId, scope.projectId, recordId]);
  return <div className="record-detail">
    <button className="text-link" onClick={onBack}><ArrowLeft size={15} />주장으로 돌아가기</button>
    {record.loading ? <LoadingState label="원본 기록을 불러오는 중입니다." />
      : record.error || !record.data ? <ErrorState error={record.error} onRetry={record.retry} />
        : <>
          <div className="record-meta"><span>{record.data.kind || "record"}</span><span>{record.data.source || "Neuromem"}</span><span>{formatDate(record.data.occurred_at)}</span></div>
          <h3>{record.data.title || "원본 기록"}</h3>
          {record.data.before && <div className="context-fragment"><small>앞 문맥</small><p>{record.data.before}</p></div>}
          <blockquote><Quote aria-hidden="true" />{record.data.content}</blockquote>
          {record.data.after && <div className="context-fragment"><small>뒤 문맥</small><p>{record.data.after}</p></div>}
          <code className="record-id">{record.data.id}</code>
        </>}
  </div>;
}
