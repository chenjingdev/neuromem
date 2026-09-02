import { Activity, Archive, BrainCircuit, ChevronDown, CircleStop, DatabaseBackup, FileClock, ListRestart, Play, RefreshCw, RotateCw, Server, ShieldCheck, Sparkles, TerminalSquare, TriangleAlert } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, managerApi } from "../api";
import { Button, Card, EmptyState, ErrorState, LoadingState, PageHeading, StatusPill, SuccessMessage, errorMessage, formatBytes, formatDate, formatNumber } from "../components/common";
import { useRemote, type RemoteState } from "../hooks";
import type { ApiGenerationConnectionInput, ApiGenerationSource, Backup, CodexAuthStatus, CodexGenerationSource, GenerationModelSelection, GenerationProbeInput, GenerationSource, ModelProviderStatus, ModelSelectionProvider, ModelSelectionUpdate, NodeHealth, NodeModelSelection, NodeSummary, OperationPlan, OperationResult, ServiceState } from "../types";

export function AdminPage({ onProductUrlResolved }: { onProductUrlResolved?: (nodeEndpoint: string) => void } = {}) {
  const nodes = useRemote(() => managerApi.nodes(), []);
  const node = nodes.data?.[0];

  useEffect(() => {
    if (node?.endpoint) onProductUrlResolved?.(node.endpoint);
  }, [node?.endpoint, onProductUrlResolved]);

  if (nodes.loading) return <LoadingState label="이 기기의 Neuromem Node를 확인하고 있습니다." />;
  if (nodes.error instanceof ApiError && nodes.error.status === 401) return <AdminAuthRequired />;
  if (nodes.error) return <ErrorState title="Node Manager에 연결할 수 없습니다." error={nodes.error} onRetry={nodes.retry} />;

  return <>
    <PageHeading eyebrow="LOCAL NODE OPERATOR" title="Node 관리" description="이 기기에서 실행되는 Neuromem 전체 상태와 안전한 복구 작업만 관리합니다." />
    {!node ? <EmptyState icon={<Server />} title="실행 중인 Node를 찾지 못했습니다.">터미널에서 Node 설정과 실행 상태를 확인한 뒤 이 화면을 다시 열어주세요.</EmptyState> : <NodeDetail nodeId={node.id} summary={node} />}
  </>;
}

export function AdminAuthRequired() {
  return <div className="state-panel auth-required" role="alert"><ShieldCheck /><strong>관리자 링크가 필요합니다.</strong><p>관리자 세션은 주소에 비밀값을 저장하지 않습니다. 이 Node의 터미널에서 아래 명령을 실행해 새 링크를 여세요.</p><code>neuromem node admin open</code></div>;
}

function NodeDetail({ nodeId, summary }: { nodeId: string; summary: NodeSummary }) {
  const health = useRemote(() => managerApi.health(nodeId), [nodeId]);
  const models = useRemote(() => managerApi.models(nodeId), [nodeId]);
  const backlog = useRemote(() => managerApi.backlog(nodeId), [nodeId]);
  const backups = useRemote(() => managerApi.backups(nodeId), [nodeId]);
  const [tab, setTab] = useState<"status" | "recovery">("status");
  const refresh = () => { health.retry(); models.retry(); backlog.retry(); backups.retry(); };
  const state = health.data ? healthState(health.data) : summary.state || "unknown";

  return <section className="node-detail">
    <div className="node-title"><div><span className="eyebrow">{nodeId}</span><h2>{summary.name || nodeId}</h2></div><div><StatusPill state={state} /><button className="icon-button" onClick={refresh} aria-label="Node 상태 새로고침"><RefreshCw /></button></div></div>
    <div className="subtabs" role="tablist"><button role="tab" aria-selected={tab === "status"} onClick={() => setTab("status")}>상태</button><button role="tab" aria-selected={tab === "recovery"} onClick={() => setTab("recovery")}>데이터와 복구</button></div>
    {tab === "status" ? <StatusTab nodeId={nodeId} state={state} health={health} models={models} backlog={backlog} onRefresh={refresh} /> : <RecoveryTab nodeId={nodeId} backups={backups} />}
  </section>;
}

function StatusTab({ nodeId, state, health, models, backlog, onRefresh }: { nodeId: string; state: ServiceState; health: RemoteState<NodeHealth>; models: RemoteState<NodeModelSelection>; backlog: RemoteState<Awaited<ReturnType<typeof managerApi.backlog>>>; onRefresh: () => void }) {
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
    {data?.models && <ModelStatusCard key={nodeId} nodeId={nodeId} nodeState={state} models={data.models} selection={models} onRefresh={onRefresh} />}
    {endpoints.length > 0 && <Card><div className="card-heading"><div><span className="eyebrow">ENDPOINTS</span><h3>서비스 주소</h3></div></div><div className="endpoint-list">{endpoints.map(([name, value]) => <div key={name}><span>{name}</span><code>{value}</code></div>)}</div></Card>}
    <details className="disclosure"><summary><span><TerminalSquare />최근 로그</span><ChevronDown /></summary><Logs nodeId={nodeId} /></details>
    <details className="disclosure node-controls"><summary><span><RotateCw />Node 제어</span><ChevronDown /></summary><div><p>정상 상태에서는 제어가 필요하지 않습니다. 재시작과 중지는 Node 전체에 적용됩니다.</p><Button className="secondary" disabled={busy || state === "stopped"} onClick={() => setConfirmAction("restart")}><RotateCw size={16} />재시작</Button><Button className="quiet danger-text" disabled={busy || state === "stopped"} onClick={() => setConfirmAction("stop")}><CircleStop size={16} />중지</Button></div></details>
    {confirmAction && <ConfirmDialog title={confirmAction === "stop" ? "Node를 중지할까요?" : "Node를 재시작할까요?"} description={confirmAction === "stop" ? "기억 데이터는 보존되지만 에이전트 연결이 끊깁니다." : "전체 구성요소를 안전한 순서로 다시 시작합니다."} confirmLabel={confirmAction === "stop" ? "Node 중지" : "재시작"} onCancel={() => setConfirmAction(null)} onConfirm={() => control(confirmAction)} />}
  </div>;
}

type GenerationProbeState = "idle" | "probing" | "ready" | "error";

function ModelStatusCard({ nodeId, nodeState, models, selection, onRefresh }: { nodeId: string; nodeState: ServiceState; models: NonNullable<NodeHealth["models"]>; selection: RemoteState<NodeModelSelection>; onRefresh: () => void }) {
  const states = [modelVisualState(models.embedding), modelVisualState(models.extraction)];
  const overall = states.includes("unavailable") ? "unavailable" : states.every(state => state === "healthy") ? "healthy" : "degraded";
  const overallLabel = overall === "healthy" ? "정상" : overall === "unavailable" ? "설정 필요" : "확인 필요";
  const mismatchedNode = Boolean(selection.data && selection.data.node_id !== nodeId);
  const configuration = selection.data?.node_id === nodeId ? selection.data : null;
  const codexSource = configuration?.generation.sources?.codex_session || emptyCodexSource();
  const apiSource = configuration?.generation.sources?.openai_compatible || emptyApiSource();
  const initialized = useRef(false);
  const probeEpoch = useRef(0);
  const [savedModels, setSavedModels] = useState({ embedding: models.embedding.model || "", generation: models.extraction.model || "" });
  const [savedGenerationSource, setSavedGenerationSource] = useState<GenerationSource | null>(null);
  const [savedApiBaseUrl, setSavedApiBaseUrl] = useState("");
  const [savedApiKeyConfigured, setSavedApiKeyConfigured] = useState(false);
  const [embeddingModel, setEmbeddingModel] = useState(models.embedding.model || "");
  const [generationSource, setGenerationSource] = useState<GenerationSource | null>(null);
  const [generationModels, setGenerationModels] = useState<Record<GenerationSource, string>>({ codex_session: "", openai_compatible: "" });
  const [probedModels, setProbedModels] = useState<Partial<Record<GenerationSource, string[]>>>({});
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearStoredApiKey, setClearStoredApiKey] = useState(false);
  const [probeState, setProbeState] = useState<GenerationProbeState>("idle");
  const [probeSource, setProbeSource] = useState<GenerationSource | null>(null);
  const [probeCompatible, setProbeCompatible] = useState(false);
  const [probeMessage, setProbeMessage] = useState<string | null>(null);
  const [probeError, setProbeError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<unknown>(null);

  useEffect(() => {
    if (!configuration || initialized.current) return;
    const activeSource = inferredGenerationSource(configuration.generation);
    const generationModel = configuration.generation.model || "";
    const nextModels = {
      codex_session: activeSource === "codex_session" ? generationModel : "",
      openai_compatible: apiSource.model || (activeSource === "openai_compatible" ? generationModel : ""),
    };
    setSavedModels({ embedding: configuration.embedding.model || "", generation: generationModel });
    setSavedGenerationSource(activeSource);
    setSavedApiBaseUrl(apiSource.display_base_url || "");
    setSavedApiKeyConfigured(apiSource.api_key_configured);
    setEmbeddingModel(configuration.embedding.model || "");
    setGenerationSource(activeSource);
    setGenerationModels(nextModels);
    setApiBaseUrl(apiSource.display_base_url || "");
    initialized.current = true;
  }, [configuration, apiSource.api_key_configured, apiSource.display_base_url, apiSource.model]);

  useEffect(() => () => { probeEpoch.current += 1; }, []);

  useEffect(() => {
    if (nodeState === "stopped") setEmbeddingModel(savedModels.embedding);
  }, [nodeState, savedModels.embedding]);

  const generationModel = generationSource ? generationModels[generationSource] : "";
  const availableGenerationModels = generationSource === "codex_session"
    ? probedModels.codex_session || codexSource.available_models
    : generationSource === "openai_compatible"
      ? probedModels.openai_compatible || apiSource.available_models || configuration?.generation.available_models || []
      : [];
  const normalizedApiBaseUrl = apiBaseUrl.trim();
  const apiBaseUrlChanged = normalizedApiBaseUrl !== savedApiBaseUrl;
  const apiKeyAction = apiKey
    ? "replace"
    : clearStoredApiKey || apiBaseUrlChanged || !savedApiKeyConfigured
      ? "clear"
      : "keep";
  const apiConnection = generationSource === "openai_compatible"
    ? generationApiConnection(normalizedApiBaseUrl, apiKeyAction, apiKey)
    : null;
  const generationChanged = generationSource !== savedGenerationSource
    || generationModel.trim() !== savedModels.generation
    || (generationSource === "openai_compatible" && (apiBaseUrlChanged || Boolean(apiKey) || clearStoredApiKey));
  const updates: ModelSelectionUpdate = {};
  if (configuration && nodeState !== "stopped" && embeddingModel && embeddingModel !== savedModels.embedding) updates.embedding_model = embeddingModel;
  if (generationChanged && generationSource && validGenerationModel(generationModel.trim())) {
    updates.generation = generationSource === "codex_session"
      ? { source: generationSource, model: generationModel.trim() }
      : { source: generationSource, model: generationModel.trim(), connection: apiConnection! };
  }
  const hasChanges = Boolean(updates.embedding_model || generationChanged);
  const formDisabled = busy || selection.loading || Boolean(selection.error) || mismatchedNode || !configuration;
  const generationProbeReady = probeState === "ready" && probeSource === generationSource && probeCompatible;
  const codexReady = generationSource !== "codex_session" || (codexSource.available && codexSource.auth_status === "signed_in");
  const apiReady = generationSource !== "openai_compatible" || validApiBaseUrl(normalizedApiBaseUrl);
  const generationReady = !generationChanged || Boolean(updates.generation && generationProbeReady && codexReady && apiReady);
  const canSubmit = hasChanges && !formDisabled && generationReady;
  const changeDescriptions = [
    updates.embedding_model ? `임베딩: ${modelName(savedModels.embedding)} → ${updates.embedding_model}` : null,
    generationChanged && generationSource !== savedGenerationSource ? `생성 연결: ${generationSourceName(savedGenerationSource)} → ${generationSourceName(generationSource)}` : null,
    generationChanged && generationModel.trim() !== savedModels.generation ? `생성 모델: ${modelName(savedModels.generation)} → ${modelName(generationModel.trim())}` : null,
    generationChanged && generationSource === "openai_compatible" && apiBaseUrlChanged ? "API 주소: 변경됨" : null,
    generationChanged && generationSource === "openai_compatible" && apiKeyAction === "replace" ? "API 키: 새 키로 교체" : null,
    generationChanged && generationSource === "openai_compatible" && apiKeyAction === "clear" && savedApiKeyConfigured ? "API 키: 저장된 키 삭제" : null,
  ].filter((value): value is string => Boolean(value));

  const invalidateProbe = (clearCatalog?: GenerationSource) => {
    probeEpoch.current += 1;
    setProbeState("idle");
    setProbeSource(null);
    setProbeCompatible(false);
    setProbeMessage(null);
    setProbeError(null);
    if (clearCatalog) setProbedModels(current => ({ ...current, [clearCatalog]: undefined }));
    setMessage(null);
    setApplyError(null);
  };

  const changeGenerationSource = (next: GenerationSource) => {
    setGenerationSource(next);
    invalidateProbe();
  };

  const changeGenerationModel = (value: string) => {
    if (!generationSource) return;
    setGenerationModels(current => ({ ...current, [generationSource]: value }));
    invalidateProbe();
  };

  const probeGeneration = async () => {
    if (!generationSource) return;
    const model = generationModel.trim();
    let input: GenerationProbeInput;
    if (generationSource === "codex_session") {
      if (!codexSource.available || codexSource.auth_status !== "signed_in") return;
      input = { source: generationSource, ...(model ? { model } : {}) };
    } else {
      if (!validApiBaseUrl(normalizedApiBaseUrl) || !apiConnection) return;
      input = { source: generationSource, connection: apiConnection, ...(model ? { model } : {}) };
    }
    const requestId = ++probeEpoch.current;
    const expectedSource = generationSource;
    setProbeState("probing");
    setProbeSource(expectedSource);
    setProbeCompatible(false);
    setProbeMessage(null);
    setProbeError(null);
    setMessage(null);
    setApplyError(null);
    try {
      const result = await managerApi.probeGeneration(nodeId, input);
      if (probeEpoch.current !== requestId) return;
      if (result.source !== expectedSource) throw new Error("현재 생성 연결과 다른 검사 결과를 받았습니다. 다시 확인해 주세요.");
      setProbedModels(current => ({ ...current, [expectedSource]: uniqueModels(result.available_models) }));
      setProbeState("ready");
      setProbeCompatible(Boolean(model && result.model_compatible));
      setProbeMessage(result.diagnostic
        ? localizedModelDiagnostic(result.diagnostic)
        : model && result.model_compatible
          ? "연결과 생성 모델의 JSON 호환성을 확인했습니다."
          : model
            ? "연결은 확인했지만 선택한 모델의 JSON 호환성을 확인하지 못했습니다."
            : "연결을 확인했습니다. 모델을 선택한 뒤 다시 확인하세요.");
    } catch (error) {
      if (probeEpoch.current !== requestId) return;
      setProbeState("error");
      setProbeCompatible(false);
      setProbeError(error);
    }
  };

  const refreshCodexStatus = () => {
    invalidateProbe("codex_session");
    selection.retry();
  };

  const requestConfirmation = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit) setConfirming(true);
  };

  const applyModels = async () => {
    const pendingUpdates: ModelSelectionUpdate = { ...updates };
    if (!pendingUpdates.embedding_model && !pendingUpdates.generation) return;
    setConfirming(false);
    setBusy(true);
    setMessage(null);
    setApplyError(null);
    try {
      const operation = await managerApi.configureModels(nodeId, pendingUpdates);
      const restarted = operationRestarted(operation, nodeState !== "stopped");
      const pendingGeneration = pendingUpdates.generation;
      setSavedModels(current => ({
        embedding: pendingUpdates.embedding_model || current.embedding,
        generation: pendingGeneration?.model || current.generation,
      }));
      if (pendingGeneration) {
        setSavedGenerationSource(pendingGeneration.source);
        if (pendingGeneration.source === "openai_compatible") {
          setSavedApiBaseUrl(pendingGeneration.connection.base_url);
          setSavedApiKeyConfigured(pendingGeneration.connection.api_key_action === "replace"
            ? true
            : pendingGeneration.connection.api_key_action === "clear"
              ? false
              : savedApiKeyConfigured);
        }
      }
      setApiKey("");
      setClearStoredApiKey(false);
      setProbeState("idle");
      setProbeSource(null);
      setProbeCompatible(false);
      setMessage(restarted ? "모델 설정을 저장하고 Node를 재시작했습니다." : "모델 설정을 저장했습니다. 다음 Node 시작부터 적용됩니다.");
      onRefresh();
    } catch (error) {
      setApplyError(error);
    } finally {
      setBusy(false);
    }
  };

  return <Card className="model-status-card">
    <div className="card-heading"><div><span className="eyebrow">NODE COMPUTE</span><h3>컴퓨팅 소스</h3></div><StatusPill state={overall} label={overallLabel} /></div>
    <p>이 Node에서 모든 Workspace가 사용하는 임베딩·생성 모델의 연결 방식, 설정, 실제 확인 기록입니다.</p>
    {selection.loading && !configuration && <div className="inline-message" role="status">모델 연결 정보를 확인하고 있습니다.</div>}
    {Boolean(selection.error) && <div className="inline-message error model-selection-error" role="alert"><TriangleAlert /> <span>{errorMessage(selection.error)}</span><Button type="button" className="quiet" onClick={selection.retry}>다시 확인</Button></div>}
    {mismatchedNode && <div className="inline-message error model-selection-error" role="alert"><TriangleAlert /> <span>현재 Node의 모델 목록을 확인하지 못했습니다. 다시 확인해 주세요.</span><Button type="button" className="quiet" onClick={selection.retry}>다시 확인</Button></div>}
    {message && <SuccessMessage>{message}</SuccessMessage>}
    {Boolean(applyError) && <div className="inline-message error" role="alert"><TriangleAlert />{errorMessage(applyError)}</div>}
    <form className="model-selection-form" aria-busy={busy} onSubmit={requestConfirmation}>
      <div className="model-status-grid generation-provider-grid">
        <ModelStatusItem id={`embedding-model-${nodeId}`} icon={<BrainCircuit />} title="임베딩 모델" description="검색 · 유사도" label="임베딩 모델 선택" provider={models.embedding} selection={configuration?.embedding || null} value={embeddingModel} disabled={formDisabled || nodeState === "stopped"} loading={selection.loading} choicesReady={Boolean(configuration)} additionalDiagnostic={nodeState === "stopped" ? "임베딩 모델 변경은 Node를 먼저 시작해야 합니다." : null} onChange={value => { setEmbeddingModel(value); setMessage(null); setApplyError(null); }} />
        <article className={`model-status-item generation-provider-item ${modelVisualState(models.extraction)}`}>
          <div className="model-status-item-head"><div><Sparkles /><span><strong>생성 모델</strong><small>주장 · Wiki · 그래프</small></span></div><StatusPill state={modelVisualState(models.extraction)} label={modelStatusLabel(models.extraction)} /></div>
          <p>{modelStatusDescription(models.extraction)}</p>
          <small className="model-probe-time">{models.extraction.last_probe_at ? `Core 마지막 확인 ${formatDate(models.extraction.last_probe_at)}` : "Core 확인 기록 없음"}</small>
          <fieldset className="generation-source-fieldset" aria-describedby={`generation-source-help-${nodeId}`}>
            <legend>생성 모델 연결 방식</legend>
            <div className="generation-source-options">
              <label className={generationSource === "codex_session" ? "selected" : ""}>
                <input type="radio" name={`generation-source-${nodeId}`} value="codex_session" aria-label="Codex 로그인 사용" checked={generationSource === "codex_session"} disabled={formDisabled || (!codexSource.available && savedGenerationSource !== "codex_session")} onChange={() => changeGenerationSource("codex_session")} />
                <span><strong>Codex 로그인 사용</strong><small>이 Mac의 기존 Codex 로그인 세션</small></span>
              </label>
              <label className={generationSource === "openai_compatible" ? "selected" : ""}>
                <input type="radio" name={`generation-source-${nodeId}`} value="openai_compatible" aria-label="API 직접 연결 (OpenAI 호환)" checked={generationSource === "openai_compatible"} disabled={formDisabled} onChange={() => changeGenerationSource("openai_compatible")} />
                <span><strong>API 직접 연결 (OpenAI 호환)</strong><small>Ollama · LM Studio · OpenAI API</small></span>
              </label>
            </div>
            <small id={`generation-source-help-${nodeId}`}>연결 방식 변경은 적용 전까지 현재 Node에 영향을 주지 않습니다.</small>
          </fieldset>

          {!generationSource && <div className="generation-empty-state"><strong>생성 모델 연결 방식을 선택하세요.</strong><span>Codex 로그인 또는 OpenAI 호환 API를 사용할 수 있습니다.</span></div>}

          {generationSource === "codex_session" && <div className="generation-connection-panel">
            <div className="generation-connection-status"><span><strong>Codex 로그인</strong><small>{codexStatusDescription(codexSource.auth_status, codexSource.plan_type)}</small></span><StatusPill state={codexStatusState(codexSource.auth_status)} label={codexStatusLabel(codexSource.auth_status)} /></div>
            {codexSource.auth_status !== "signed_in" && <div className="generation-login-help"><p>{codexSource.auth_status === "unavailable" ? "이 Mac에서 Codex를 사용할 수 없습니다." : "터미널에서 codex login을 실행한 뒤 다시 확인하세요."}</p><code>codex login</code><Button type="button" className="quiet" disabled={selection.loading} onClick={refreshCodexStatus}>새로 확인</Button></div>}
            {codexSource.diagnostic && <small className="model-selection-diagnostic">{localizedModelDiagnostic(codexSource.diagnostic)}</small>}
            <GenerationModelInput id={`generation-model-${nodeId}`} value={generationModel} available={availableGenerationModels} current={savedGenerationSource === "codex_session" ? savedModels.generation : ""} disabled={formDisabled || codexSource.auth_status !== "signed_in"} onChange={changeGenerationModel} />
            {codexSource.auth_status === "signed_in" && <Button type="button" className="secondary generation-probe-button" disabled={formDisabled || probeState === "probing" || Boolean(generationModel && !validGenerationModel(generationModel.trim()))} onClick={probeGeneration}>{probeState === "probing" && probeSource === "codex_session" ? "연결 확인 중…" : "연결 확인"}</Button>}
          </div>}

          {generationSource === "openai_compatible" && <div className="generation-connection-panel api-generation-panel">
            <div className="generation-connection-status"><span><strong>{apiSource.configured ? "저장된 API 연결" : "새 API 연결"}</strong><small>{apiConnectionOriginDescription(apiSource.connection_origin)}</small></span><span className={`credential-state ${savedApiKeyConfigured ? "configured" : ""}`}>{savedApiKeyConfigured ? "저장된 API 키 있음" : "저장된 API 키 없음"}</span></div>
            <label className="generation-field" htmlFor={`generation-api-url-${nodeId}`}><span>API 기본 주소</span><input id={`generation-api-url-${nodeId}`} type="url" inputMode="url" autoComplete="url" placeholder="http://127.0.0.1:11434/v1" value={apiBaseUrl} disabled={formDisabled} aria-invalid={Boolean(apiBaseUrl && !validApiBaseUrl(normalizedApiBaseUrl))} onChange={event => { setApiBaseUrl(event.target.value); setClearStoredApiKey(false); invalidateProbe("openai_compatible"); }} /></label>
            {apiBaseUrl && !validApiBaseUrl(normalizedApiBaseUrl) && <small className="model-selection-diagnostic">사용자 정보가 없는 HTTP 또는 HTTPS 주소를 입력하세요.</small>}
            <label className="generation-field" htmlFor={`generation-api-key-${nodeId}`}><span>API 키 <small>선택</small></span><input id={`generation-api-key-${nodeId}`} type="password" autoComplete="new-password" spellCheck={false} placeholder={savedApiKeyConfigured && !apiBaseUrlChanged && !clearStoredApiKey ? "비워 두면 저장된 키 유지" : "키가 없는 로컬 서버는 비워 두세요"} value={apiKey} disabled={formDisabled} onChange={event => { setApiKey(event.target.value); if (event.target.value) setClearStoredApiKey(false); invalidateProbe("openai_compatible"); }} /></label>
            {savedApiKeyConfigured && !apiBaseUrlChanged && <label className="generation-key-clear"><input type="checkbox" checked={clearStoredApiKey} disabled={formDisabled || Boolean(apiKey)} onChange={event => { setClearStoredApiKey(event.target.checked); invalidateProbe("openai_compatible"); }} />저장된 API 키 삭제</label>}
            <small className="generation-key-action">{apiKeyAction === "replace" ? "적용하면 새 API 키로 교체합니다." : apiKeyAction === "keep" ? "저장된 API 키를 다시 표시하지 않고 그대로 사용합니다." : apiBaseUrlChanged && savedApiKeyConfigured ? "주소가 바뀌어 기존 키를 전달하지 않습니다. 필요한 경우 새 키를 입력하세요." : "API 키 없이 연결합니다."}</small>
            <GenerationModelInput id={`generation-model-${nodeId}`} value={generationModel} available={availableGenerationModels} current={savedGenerationSource === "openai_compatible" ? savedModels.generation : apiSource.model || ""} disabled={formDisabled} onChange={changeGenerationModel} />
            <Button type="button" className="secondary generation-probe-button" disabled={formDisabled || probeState === "probing" || !validApiBaseUrl(normalizedApiBaseUrl) || Boolean(generationModel && !validGenerationModel(generationModel.trim()))} onClick={probeGeneration}>{probeState === "probing" && probeSource === "openai_compatible" ? "연결 확인 중…" : "연결 확인"}</Button>
          </div>}

          {probeState === "probing" && <div className="generation-probe-result" role="status">짧은 생성 요청으로 연결을 확인하고 있습니다.</div>}
          {probeState === "ready" && probeMessage && <div className={`generation-probe-result ${probeCompatible ? "success" : "warning"}`} role="status">{probeMessage}</div>}
          {probeState === "error" && <div className="inline-message error generation-probe-result" role="alert"><TriangleAlert />{errorMessage(probeError)}</div>}
          {generationChanged && !generationProbeReady && generationSource && <small className="generation-apply-hint">변경한 생성 연결과 모델을 적용하기 전에 호환성을 확인하세요.</small>}
          <p className="generation-usage-notice">연결 확인 1회와 변경 적용 시 안전 확인 1회가 각각 짧은 생성 요청을 보내므로 Codex 또는 API 사용량이 발생할 수 있습니다.</p>
        </article>
      </div>
      <div className="model-config-footer"><span>API 키는 저장 후 다시 표시하지 않습니다.</span><Button className="primary" disabled={!canSubmit}>{busy ? "모델 적용 중…" : "변경 적용"}</Button></div>
    </form>
    {confirming && <ConfirmDialog title="모델 변경을 적용할까요?" description={`${changeDescriptions.join(" · ")}. ${nodeState === "stopped" ? "설정은 다음 Node 시작부터 적용됩니다." : "실행 중인 Node 전체가 재시작되어 잠시 연결이 끊깁니다."} ${generationSource === "codex_session" ? "Codex 로그인 정보는 Neuromem에 복사하지 않습니다." : "API 키 값은 이 확인 화면이나 저장 후 화면에 표시하지 않습니다."}`} confirmLabel={nodeState === "stopped" ? "변경 저장" : "적용하고 재시작"} confirmClassName="primary" onCancel={() => setConfirming(false)} onConfirm={applyModels} />}
  </Card>;
}

function emptyCodexSource(): CodexGenerationSource {
  return { available: false, auth_status: "unknown", plan_type: null, available_models: [], diagnostic: null, last_checked_at: null };
}

function emptyApiSource(): ApiGenerationSource {
  return { configured: false, connection_origin: null, display_base_url: null, api_key_configured: false, model: null, available_models: [], diagnostic: null, last_checked_at: null };
}

function inferredGenerationSource(generation: GenerationModelSelection): GenerationSource | null {
  if (generation.active_source === "codex_session" || generation.active_source === "openai_compatible") return generation.active_source;
  // Older Managers returned only one generation catalog. Treat that catalog as
  // the existing OpenAI-compatible path while the Manager and UI are upgraded.
  return generation.model || generation.available_models?.length ? "openai_compatible" : null;
}

function generationApiConnection(baseUrl: string, action: ApiGenerationConnectionInput["api_key_action"], apiKey: string): ApiGenerationConnectionInput {
  return { base_url: baseUrl, api_key_action: action, ...(action === "replace" ? { api_key: apiKey } : {}) };
}

function validApiBaseUrl(value: string) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function validGenerationModel(value: string) {
  return value.length > 0 && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(value);
}

function uniqueModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && validGenerationModel(item)))];
}

function GenerationModelInput({ id, value, available, current, disabled, onChange }: { id: string; value: string; available: string[]; current: string; disabled: boolean; onChange: (value: string) => void }) {
  const models = uniqueModels(available);
  const currentNotDiscovered = Boolean(current && !models.includes(current));
  const invalid = Boolean(value && !validGenerationModel(value.trim()));
  const diagnosticId = `${id}-generation-diagnostic`;
  return <div className="generation-model-field">
    <label className="model-select-label" htmlFor={id}>생성 모델 선택 또는 입력</label>
    <input id={id} list={`${id}-options`} value={value} disabled={disabled} autoComplete="off" spellCheck={false} aria-invalid={invalid} aria-describedby={diagnosticId} placeholder={models.length ? "목록에서 선택하거나 모델 ID 입력" : "모델 ID를 직접 입력"} onChange={event => onChange(event.target.value)} />
    <datalist id={`${id}-options`}>{models.map(model => <option key={model} value={model} />)}</datalist>
    <small id={diagnosticId} className={invalid || currentNotDiscovered ? "model-selection-diagnostic" : "generation-model-help"}>{invalid ? "모델 ID는 영문·숫자로 시작하고 공백 없이 입력하세요." : currentNotDiscovered ? "현재 설정 모델은 제공 서비스의 최신 목록에서 감지되지 않았습니다." : models.length ? `${models.length}개 모델을 목록에서 선택하거나 직접 입력할 수 있습니다.` : "모델 목록이 없어도 정확한 모델 ID를 직접 입력할 수 있습니다."}</small>
  </div>;
}

function generationSourceName(source: GenerationSource | null) {
  if (source === "codex_session") return "Codex 로그인";
  if (source === "openai_compatible") return "API 직접 연결";
  return "설정 없음";
}

function codexStatusState(status: CodexAuthStatus): ServiceState {
  if (status === "signed_in") return "healthy";
  if (status === "unavailable") return "unavailable";
  return "degraded";
}

function codexStatusLabel(status: CodexAuthStatus) {
  return ({ signed_in: "로그인됨", signed_out: "로그인 필요", unavailable: "사용 불가", unknown: "확인 필요" } as Record<CodexAuthStatus, string>)[status];
}

function codexStatusDescription(status: CodexAuthStatus, planType: string | null) {
  if (status === "signed_in") return `현재 Codex 세션 사용${planType ? ` · ${planType}` : ""}`;
  if (status === "signed_out") return "Codex 로그인이 필요합니다.";
  if (status === "unavailable") return "Codex 실행 파일이나 App Server를 찾지 못했습니다.";
  return "Codex 로그인 상태를 아직 확인하지 못했습니다.";
}

function apiConnectionOriginDescription(origin: string | null) {
  if (origin === "embedding_fallback" || origin === "embedding") return "임베딩 API 연결을 함께 사용 중";
  if (origin === "generation") return "생성 모델 전용 API 연결";
  return "Ollama 같은 무키 로컬 서버도 지원";
}

function ModelStatusItem({ id, icon, title, description, label, provider, selection, value, disabled, loading, choicesReady, additionalDiagnostic, onChange }: { id: string; icon: React.ReactNode; title: string; description: string; label: string; provider: ModelProviderStatus; selection: ModelSelectionProvider | null; value: string; disabled: boolean; loading: boolean; choicesReady: boolean; additionalDiagnostic?: string | null; onChange: (value: string) => void }) {
  const state = modelVisualState(provider);
  const current = selection ? selection.model : provider.model || null;
  const available = [...new Set((selection?.available_models || []).filter(Boolean))];
  const currentNotDiscovered = Boolean(current && !available.includes(current));
  const diagnostics = [...new Set([
    localizedModelDiagnostic(selection?.diagnostic),
    additionalDiagnostic,
    choicesReady && currentNotDiscovered ? "현재 설정 모델은 제공 서비스에서 감지되지 않았습니다." : null,
    choicesReady && available.length === 0 ? "선택 가능한 호환 모델이 없습니다." : null,
  ].filter((item): item is string => Boolean(item)))];
  const describedBy = [`${id}-status`, diagnostics.length ? `${id}-diagnostic` : null].filter(Boolean).join(" ");

  return <article className={`model-status-item ${state}`}>
    <div className="model-status-item-head"><div>{icon}<span><strong>{title}</strong><small>{description}</small></span></div><StatusPill state={state} label={modelStatusLabel(provider)} /></div>
    <p id={`${id}-status`}>{modelStatusDescription(provider)}</p>
    <small className="model-probe-time">{provider.last_probe_at ? `Core 마지막 확인 ${formatDate(provider.last_probe_at)}` : "Core 확인 기록 없음"}</small>
    <label className="model-select-label" htmlFor={id}>{label}</label>
    <select id={id} value={value} disabled={disabled || available.length === 0} aria-describedby={describedBy} onChange={event => onChange(event.target.value)}>
      {!current && <option value="">{loading ? "모델 목록 확인 중…" : choicesReady ? available.length ? "모델을 선택하세요" : "선택 가능한 모델 없음" : "모델 목록을 확인할 수 없음"}</option>}
      {currentNotDiscovered && <option value={current || ""}>{current} ({choicesReady ? "현재 설정 · 감지되지 않음" : "현재 설정"})</option>}
      {available.map(model => <option key={model} value={model}>{model}</option>)}
    </select>
    {diagnostics.length > 0 && <small id={`${id}-diagnostic`} className="model-selection-diagnostic">{diagnostics.join(" ")}</small>}
  </article>;
}

function modelName(value: string) {
  return value || "설정 없음";
}

function localizedModelDiagnostic(value?: string | null) {
  if (!value) return null;
  const exact: Record<string, string> = {
    "Model provider is not configured": "모델 제공 서비스가 설정되지 않았습니다.",
    "Configured model provider URL is invalid": "설정된 모델 제공 서비스 주소가 올바르지 않습니다.",
    "Model provider returned an invalid model catalog": "모델 제공 서비스가 올바른 모델 목록을 반환하지 않았습니다.",
    "Could not reach the configured model provider": "설정된 모델 제공 서비스에 연결하지 못했습니다.",
    "No embedding-compatible models were found": "호환 가능한 임베딩 모델을 찾지 못했습니다.",
    "No generation-compatible models were found": "호환 가능한 생성 모델을 찾지 못했습니다.",
    "Codex is not signed in with ChatGPT": "Codex 로그인이 필요합니다.",
    "Selected Codex model is unavailable": "현재 Codex 로그인에서 선택한 모델을 사용할 수 없습니다.",
  };
  const http = value.match(/^Model provider returned HTTP (\d{3})$/);
  return http ? `모델 제공 서비스가 HTTP ${http[1]} 오류를 반환했습니다.` : exact[value] || value;
}

function operationRestarted(operation: OperationResult, fallback: boolean) {
  if (!operation.result || typeof operation.result !== "object") return fallback;
  const restarted = (operation.result as { restarted?: unknown }).restarted;
  return typeof restarted === "boolean" ? restarted : fallback;
}

function modelVisualState(provider: ModelProviderStatus): ServiceState {
  if (!provider.configured || provider.provider_status === "unconfigured") return "unavailable";
  if (provider.provider_status === "error") return "unavailable";
  if (provider.provider_status === "ready") return "healthy";
  if (provider.provider_status === "unknown") return "unknown";
  return "degraded";
}

function modelStatusLabel(provider: ModelProviderStatus) {
  if (!provider.configured || provider.provider_status === "unconfigured") return "미설정";
  return ({ ready: "정상", configured: "연결 확인 전", error: "오류", unknown: "확인 전" } as Record<string, string>)[provider.provider_status] || "확인 전";
}

function modelStatusDescription(provider: ModelProviderStatus) {
  if (!provider.configured || provider.provider_status === "unconfigured") return "모델 주소와 이름이 설정되지 않았습니다.";
  if (provider.provider_status === "ready") return "Core에서 최근 모델 연결을 정상 확인했습니다.";
  if (provider.provider_status === "configured") return "설정은 완료됐지만 Core의 연결 확인 기록이 없습니다.";
  if (provider.provider_status === "error") return provider.provider_detail || "Core의 최근 모델 연결 확인에 실패했습니다.";
  return provider.provider_detail || "Core에서 모델 연결 상태를 아직 확인하지 못했습니다.";
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

function ConfirmDialog({ title, description, confirmLabel, confirmClassName = "danger", onCancel, onConfirm }: { title: string; description: string; confirmLabel: string; confirmClassName?: string; onCancel: () => void; onConfirm: () => void }) {
  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}><div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description"><h2 id="confirm-title">{title}</h2><p id="confirm-description">{description}</p><div><Button type="button" className="secondary" autoFocus onClick={onCancel}>취소</Button><Button type="button" className={confirmClassName} onClick={onConfirm}>{confirmLabel}</Button></div></div></div>;
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
