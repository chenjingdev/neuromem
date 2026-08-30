import { GitFork, Info, MousePointer2 } from "lucide-react";
import { KeyboardEvent, useMemo, useState } from "react";
import { coreApi } from "../api";
import { Card, EmptyState, ErrorState, LoadingState, PageHeading } from "../components/common";
import { EvidencePanel } from "../components/EvidencePanel";
import { useRemote } from "../hooks";
import type { GraphEdge, GraphNode, Scope } from "../types";

type Selection = { kind: "node"; item: GraphNode } | { kind: "edge"; item: GraphEdge };

export function GraphPage({ scope }: { scope: Scope }) {
  const graph = useRemote(() => coreApi.graph(scope), [scope.workspaceId, scope.projectId]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const claimId = selection?.item.claim_id || null;

  return <>
    <PageHeading title="관계 그래프" description="사람·프로젝트·결정·산출물의 관계를 보고, 각 연결을 원본 기록까지 추적합니다." />
    {graph.loading && <LoadingState label="관계를 불러오는 중입니다." />}
    {graph.error && <ErrorState error={graph.error} onRetry={graph.retry} />}
    {!graph.loading && !graph.error && !graph.data?.nodes.length && <EmptyState icon={<GitFork />} title="아직 표시할 관계가 없습니다.">구조화된 주장이 생기면 관계와 출처가 이곳에 나타납니다.</EmptyState>}
    {graph.data && Boolean(graph.data.nodes.length) && <div className={`graph-drilldown ${claimId ? "open" : ""}`}>
      <div className="graph-main">
        <Card className="graph-card"><div className="graph-help"><MousePointer2 size={16} /><span>점이나 관계를 선택하면 연결된 주장과 원본 기록을 확인할 수 있습니다.</span></div><KnowledgeSvg nodes={graph.data.nodes} edges={graph.data.edges} selection={selection} onSelect={setSelection} /></Card>
        <Card className="relation-list"><div className="card-heading"><div><span className="eyebrow">RELATIONSHIPS</span><h2>관계 목록</h2></div><span>{graph.data.edges.length}개</span></div>
          {!graph.data.edges.length ? <p className="muted-copy">연결된 관계가 없습니다.</p> : graph.data.edges.map(edge => {
            const source = graph.data?.nodes.find(node => node.id === edge.source)?.label || edge.source;
            const target = graph.data?.nodes.find(node => node.id === edge.target)?.label || edge.target;
            return <button key={edge.id} className={selection?.kind === "edge" && selection.item.id === edge.id ? "selected" : ""} onClick={() => setSelection({ kind: "edge", item: edge })}><span>{source}</span><strong>{edge.label}</strong><span>{target}</span></button>;
          })}
        </Card>
        {selection && !claimId && <div className="inline-message"><Info size={17} />이 항목에는 아직 추적 가능한 주장이 연결되지 않았습니다.</div>}
      </div>
      {claimId && <EvidencePanel scope={scope} claimId={claimId} onClose={() => setSelection(null)} />}
    </div>}
  </>;
}

function KnowledgeSvg({ nodes, edges, selection, onSelect }: { nodes: GraphNode[]; edges: GraphEdge[]; selection: Selection | null; onSelect: (selection: Selection) => void }) {
  const positions = useMemo(() => layout(nodes), [nodes]);
  const activate = (event: KeyboardEvent<SVGGElement>, action: () => void) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); action(); }
  };
  return <div className="graph-canvas">
    <svg viewBox="0 0 720 460" role="img" aria-labelledby="graph-title" aria-describedby="graph-description">
      <title id="graph-title">프로젝트 기억 관계 그래프</title>
      <desc id="graph-description">{nodes.length}개의 항목과 {edges.length}개의 관계가 있습니다. 아래 관계 목록에서도 같은 내용을 탐색할 수 있습니다.</desc>
      <defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
      <g className="edges">
        {edges.map(edge => {
          const from = positions.get(edge.source), to = positions.get(edge.target);
          if (!from || !to) return null;
          const selected = selection?.kind === "edge" && selection.item.id === edge.id;
          const midX = (from.x + to.x) / 2, midY = (from.y + to.y) / 2;
          return <g key={edge.id} className={selected ? "selected" : ""} role="button" tabIndex={0} aria-label={`${edge.label} 관계. 근거 보기`} onClick={() => onSelect({ kind: "edge", item: edge })} onKeyDown={event => activate(event, () => onSelect({ kind: "edge", item: edge }))}>
            <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} markerEnd="url(#arrow)" />
            <text x={midX} y={midY - 7} textAnchor="middle">{shorten(edge.label, 18)}</text>
          </g>;
        })}
      </g>
      <g className="nodes">
        {nodes.map(node => {
          const point = positions.get(node.id)!;
          const selected = selection?.kind === "node" && selection.item.id === node.id;
          return <g key={node.id} transform={`translate(${point.x} ${point.y})`} className={`${node.type} ${selected ? "selected" : ""}`} role="button" tabIndex={0} aria-label={`${node.type} ${node.label}. 근거 보기`} onClick={() => onSelect({ kind: "node", item: node })} onKeyDown={event => activate(event, () => onSelect({ kind: "node", item: node }))}>
            <circle r="38" /><text textAnchor="middle" dominantBaseline="middle"><tspan x="0" y="-5">{shorten(node.label, 12)}</tspan><tspan className="node-type" x="0" y="14">{node.type}</tspan></text>
          </g>;
        })}
      </g>
    </svg>
  </div>;
}

function layout(nodes: GraphNode[]) {
  const map = new Map<string, { x: number; y: number }>();
  if (nodes.length === 1) { map.set(nodes[0].id, { x: 360, y: 230 }); return map; }
  const rings = nodes.length > 8 ? 2 : 1;
  nodes.forEach((node, index) => {
    const ring = rings === 2 && index >= Math.ceil(nodes.length / 2) ? 1 : 0;
    const ringNodes = rings === 1 ? nodes.length : ring ? nodes.length - Math.ceil(nodes.length / 2) : Math.ceil(nodes.length / 2);
    const ringIndex = ring ? index - Math.ceil(nodes.length / 2) : index;
    const radiusX = ring ? 160 : 285, radiusY = ring ? 120 : 175;
    const angle = (ringIndex / ringNodes) * Math.PI * 2 - Math.PI / 2;
    map.set(node.id, { x: 360 + Math.cos(angle) * radiusX, y: 230 + Math.sin(angle) * radiusY });
  });
  return map;
}

function shorten(value: string, length: number) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}
