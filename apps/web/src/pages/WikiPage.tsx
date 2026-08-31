import { BookOpen, LockKeyhole } from "lucide-react";
import { coreApi } from "../api";
import { Card, EmptyState, ErrorState, LoadingState, PageHeading, formatDate } from "../components/common";
import { useRemote } from "../hooks";
import type { Scope } from "../types";

export function WikiPage({ scope }: { scope: Scope }) {
  const wiki = useRemote(() => coreApi.wiki(scope), [scope.workspaceId, scope.projectId]);
  return <>
    <PageHeading title="프로젝트 Wiki" description="현재 채택된 주장으로 구성된 읽기 전용 문서입니다." actions={<span className="read-only-badge"><LockKeyhole size={14} />읽기 전용</span>} />
    {wiki.loading && <LoadingState label="Wiki를 구성하는 중입니다." />}
    {wiki.error && <ErrorState error={wiki.error} onRetry={wiki.retry} />}
    {!wiki.loading && !wiki.error && !wiki.data?.sections?.length && <EmptyState icon={<BookOpen />} title="아직 Wiki 내용이 없습니다.">채택된 주장이 쌓이면 출처가 연결된 문서가 자동으로 나타납니다.</EmptyState>}
    {wiki.data && Boolean(wiki.data.sections.length) && <div className="wiki-layout"><Card className="wiki-document"><header><span className="eyebrow">PROJECT WIKI</span><h2>{wiki.data.title}</h2><small>최근 구성 {formatDate(wiki.data.updated_at)}</small></header>
      <nav aria-label="Wiki 목차">{wiki.data.sections.map(section => <a key={section.id} href={`#wiki-${section.id}`}>{section.heading}</a>)}</nav>
      {wiki.data.sections.map(section => <section id={`wiki-${section.id}`} key={section.id}><h3>{section.heading}</h3><p>{section.body}</p>{Boolean(section.claim_ids?.length) && <div className="citation-chips"><span>출처 ID</span>{section.claim_ids?.map(id => <code key={id}>{id}</code>)}</div>}</section>)}
    </Card></div>}
  </>;
}
