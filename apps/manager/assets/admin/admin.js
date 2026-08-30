const statusElement = document.querySelector("#status");
const nodesElement = document.querySelector("#nodes");

function setStatus(message, error = false) {
  statusElement.textContent = message;
  statusElement.className = error ? "error" : "muted";
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: "include",
    ...options,
    headers: { accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function exchangeBootstrap() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get("neuromem-admin");
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  if (!token) return;
  await request("/v1/admin/session", { method: "POST", body: JSON.stringify({ token }) });
}

function button(label, action) {
  const element = document.createElement("button");
  element.textContent = label;
  element.addEventListener("click", async () => {
    element.disabled = true;
    try { await action(); } catch (error) { setStatus(error.message, true); }
    finally { element.disabled = false; }
  });
  return element;
}

async function render() {
  const { nodes } = await request("/v1/nodes");
  nodesElement.replaceChildren();
  for (const node of nodes) {
    const health = await request(`/v1/nodes/${encodeURIComponent(node.node_id)}/health`);
    const article = document.createElement("article");
    article.className = "node";
    const title = document.createElement("h2");
    title.textContent = node.alias;
    const summary = document.createElement("p");
    summary.className = "phase";
    summary.textContent = `${health.phase} · API ${node.ports.api} · Dashboard ${node.ports.dashboard} · MCP ${node.ports.mcp}`;
    const controls = document.createElement("div");
    controls.className = "row";
    for (const action of ["start", "stop", "restart"]) {
      controls.append(button(action, async () => {
        const operation = await request(`/v1/nodes/${encodeURIComponent(node.node_id)}/${action}`, { method: "POST", body: "{}" });
        if (operation.state !== "succeeded") throw new Error(operation.error || `${action} failed`);
        await render();
      }));
    }
    controls.append(button("backup", async () => {
      const operation = await request(`/v1/nodes/${encodeURIComponent(node.node_id)}/backups`, { method: "POST", body: JSON.stringify({ label: "admin" }) });
      if (operation.state !== "succeeded") throw new Error(operation.error || "backup failed");
      setStatus("백업 생성과 검증이 완료됐습니다.");
    }));
    const logs = document.createElement("pre");
    logs.hidden = true;
    controls.append(button("logs", async () => {
      const payload = await request(`/v1/nodes/${encodeURIComponent(node.node_id)}/logs?service=api&tail=200`);
      logs.textContent = payload.logs || "로그가 없습니다.";
      logs.hidden = !logs.hidden;
    }));
    article.append(title, summary, controls, logs);
    nodesElement.append(article);
  }
  setStatus(nodes.length ? "Node Manager는 PostgreSQL·Memory API와 독립적으로 실행 중입니다." : "등록된 Node가 없습니다.");
}

try {
  await exchangeBootstrap();
  await render();
} catch (error) {
  setStatus(error.message === "Admin session is required" ? "터미널에서 `neuromem admin open`을 실행하세요." : error.message, true);
}
