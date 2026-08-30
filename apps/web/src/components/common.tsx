import type { ButtonHTMLAttributes, ReactNode } from "react";
import { AlertCircle, CheckCircle2, Database, LoaderCircle, RefreshCw, WifiOff } from "lucide-react";
import type { ServiceState } from "../types";

export function StatusPill({ state, label }: { state: ServiceState | string; label?: string }) {
  const tone = ["healthy", "ready", "running", "verified"].includes(state)
    ? "good"
    : ["degraded", "starting", "pending", "warning"].includes(state)
      ? "warn"
      : ["stopped", "unavailable", "failed", "invalid"].includes(state)
        ? "bad"
        : "neutral";
  return <span className={`status-pill ${tone}`}><i aria-hidden="true" />{label || statusLabel(state)}</span>;
}

export function statusLabel(state: string) {
  return ({
    healthy: "정상",
    degraded: "일부 지연",
    stopped: "중지됨",
    unavailable: "연결 불가",
    starting: "시작 중",
    unknown: "확인 중",
    ready: "준비됨",
    running: "처리 중",
    verified: "검증됨",
    invalid: "검증 실패",
    active: "사용 중",
    proposed: "제안",
    adopted: "채택",
    disputed: "분쟁",
    rejected: "기각",
    superseded: "대체됨",
  } as Record<string, string>)[state] || state;
}

export function LoadingState({ label = "데이터를 불러오는 중입니다." }: { label?: string }) {
  return <div className="state-panel" aria-live="polite"><LoaderCircle className="spin" aria-hidden="true" /><strong>{label}</strong><p>화면은 준비되는 대로 자동으로 갱신됩니다.</p></div>;
}

export function ErrorState({ title = "데이터를 불러오지 못했습니다.", error, onRetry }: { title?: string; error: unknown; onRetry?: () => void }) {
  return <div className="state-panel error-state" role="alert"><WifiOff aria-hidden="true" /><strong>{title}</strong><p>{errorMessage(error)}</p>{onRetry && <button className="button secondary" onClick={onRetry}><RefreshCw size={16} />다시 확인</button>}</div>;
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="state-panel empty-state">{icon || <Database aria-hidden="true" />}<strong>{title}</strong><div className="state-description">{children}</div>{action}</div>;
}

export function DegradedBanner({ children }: { children: ReactNode }) {
  return <div className="degraded-banner" role="status"><AlertCircle aria-hidden="true" /><div><strong>일부 기능이 지연되고 있습니다.</strong><p>{children}</p></div></div>;
}

export function SuccessMessage({ children }: { children: ReactNode }) {
  return <div className="inline-message success" role="status"><CheckCircle2 size={17} aria-hidden="true" />{children}</div>;
}

export function PageHeading({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description: string; actions?: ReactNode }) {
  return <header className="page-heading"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1><p>{description}</p></div>{actions && <div className="heading-actions">{actions}</div>}</header>;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`.trim()}>{children}</section>;
}

export function Button({ className = "", children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`button ${className}`.trim()} {...props}>{children}</button>;
}

export function formatNumber(value?: number | null) {
  if (value == null) return "—";
  return new Intl.NumberFormat("ko-KR").format(value);
}

export function formatBytes(value?: number | null) {
  if (value == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unit = 0;
  let amount = value;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

export function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
}
