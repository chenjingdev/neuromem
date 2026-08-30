import { FileSearch, Search, Sparkles } from "lucide-react";
import { FormEvent, useState } from "react";
import { coreApi } from "../api";
import type { RecallResult, Scope } from "../types";
import { Card, EmptyState, ErrorState, LoadingState, PageHeading, StatusPill, formatNumber } from "../components/common";

export function RecallPage({ scope }: { scope: Scope }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RecallResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const clean = query.trim();
    if (!clean) return;
    setLoading(true);
    setError(null);
    try { setResults((await coreApi.recall(scope, clean)).items || []); }
    catch (reason) { setError(reason); }
    finally { setLoading(false); }
  };

  return <>
    <PageHeading title="기억 찾기" description="현재 프로젝트의 기록과 채택된 주장에서 근거를 찾습니다." />
    <Card className="search-card">
      <form className="search-form" onSubmit={search} role="search">
        <Search aria-hidden="true" />
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="예: 임베딩 차원을 2560으로 정한 근거" aria-label="기억 검색어" />
        <button className="button primary" disabled={loading || !query.trim()}>{loading ? "찾는 중" : "검색"}</button>
      </form>
      <p><Sparkles size={15} />질문에 답을 만들어내지 않고, 에이전트가 판단할 수 있는 기억과 출처를 반환합니다.</p>
    </Card>
    {loading && <LoadingState label="관련 기억과 근거를 찾고 있습니다." />}
    {error && <ErrorState error={error} />}
    {!loading && !error && results === null && <EmptyState icon={<FileSearch />} title="무엇을 기억했는지 찾아보세요.">짧은 키워드보다 찾으려는 상황을 문장으로 적으면 더 정확합니다.</EmptyState>}
    {!loading && !error && results?.length === 0 && <EmptyState icon={<FileSearch />} title="관련 기억을 찾지 못했습니다.">표현을 바꾸거나 다른 프로젝트에서 검색해보세요.</EmptyState>}
    {!loading && !error && Boolean(results?.length) && <div className="result-stack" aria-label={`검색 결과 ${results?.length}개`}>
      {results?.map((result, index) => <Card key={result.id} className="result-card">
        <div className="result-meta"><span>#{index + 1}</span><StatusPill state={result.kind} label={result.kind === "claim" ? "주장" : "원본 기록"} />{result.score != null && <small>관련도 {formatNumber(Math.round(result.score * 100))}%</small>}</div>
        {result.title && <h2>{result.title}</h2>}<p>{result.content}</p>
        {Boolean(result.citations?.length) && <div className="citation-chips">{result.citations?.map(citation => <span key={citation.record_id}>{citation.label || citation.source || citation.record_id}</span>)}</div>}
      </Card>)}
    </div>}
  </>;
}
