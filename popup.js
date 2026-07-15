const sessionStatus = document.getElementById("sessionStatus");
const managerStatus = document.getElementById("managerStatus");
const output = document.getElementById("output");
const companySelect = document.getElementById("companySelect");

function setOutput(value) {
  output.textContent =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

async function refreshSession() {
  sessionStatus.textContent = "Verificando…";
  sessionStatus.className = "muted";
  const res = await send("GET_SESSION");
  if (!res?.ok) {
    sessionStatus.textContent = res?.error || "Erro";
    sessionStatus.className = "err";
    return;
  }
  if (!res.session) {
    sessionStatus.textContent = "Sem sessão — abra o HR TotalPass logado";
    sessionStatus.className = "err";
    return;
  }
  const when = new Date(res.session.capturedAt).toLocaleString("pt-BR");
  sessionStatus.innerHTML = `<span class="ok">Sessão OK</span><br>${res.session.email}<br>token ${res.session.tokenPreview}<br><span class="muted">${when}</span>`;
}

async function refreshManager() {
  const res = await send("GET_SETTINGS");
  if (!res?.ok) {
    managerStatus.textContent = "Erro ao ler opções";
    managerStatus.className = "err";
    return;
  }
  managerStatus.innerHTML = `<span class="ok">${res.managerUrl}</span><br><span class="muted">segredo: ${
    res.hasBridgeSecret ? "configurado" : "não configurado"
  }</span>`;
}

async function run(label, fn) {
  setOutput(`Executando: ${label}…`);
  try {
    const res = await fn();
    if (!res?.ok) throw new Error(res?.error || "Falha");
    setOutput(res);
  } catch (err) {
    setOutput({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function fillCompanies(res) {
  if (!res?.ok || !Array.isArray(res.companies)) return;
  companySelect.innerHTML = "";
  if (!res.companies.length) {
    companySelect.innerHTML = `<option value="">Nenhuma empresa</option>`;
    return;
  }
  for (const c of res.companies) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = `${c.name}${c.main ? " (principal)" : ""}`;
    companySelect.appendChild(opt);
  }
  companySelect.disabled = false;
}

document.getElementById("btnRefreshSession").addEventListener("click", () => {
  refreshSession();
});

document.getElementById("btnOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("btnCompanies").addEventListener("click", async () => {
  await run("listar empresas", async () => {
    const res = await send("GET_COMPANIES");
    await fillCompanies(res);
    return res;
  });
});

document.getElementById("btnInsights").addEventListener("click", () => {
  run("insights", () => send("TEST_INSIGHTS"));
});

document.getElementById("btnHolders").addEventListener("click", () => {
  run("titulares", () => send("SEARCH_HOLDERS"));
});

document.getElementById("btnDependents").addEventListener("click", () => {
  run("dependentes", () => send("SEARCH_DEPENDENTS"));
});

document.getElementById("btnExport").addEventListener("click", () => {
  const companyId = companySelect.value || null;
  run("export CSV", () => send("EXPORT_CSV", { companyId }));
});

document.getElementById("btnSync").addEventListener("click", () => {
  const companyId = companySelect.value || null;
  run("sincronizar Manager", () => send("SYNC_TO_MANAGER", { companyId }));
});

document.getElementById("btnSnapshot").addEventListener("click", () => {
  run("salvar snapshot", () => send("SAVE_DEBUG_SNAPSHOT"));
});

document.getElementById("btnClear").addEventListener("click", () => {
  run("limpar dados", async () => {
    const res = await send("CLEAR_DEBUG");
    companySelect.innerHTML = `<option value="">Carregar empresas…</option>`;
    companySelect.disabled = true;
    await refreshSession();
    return res;
  });
});

async function bootstrap() {
  await refreshSession();
  await refreshManager();
  try {
    const res = await send("GET_COMPANIES");
    await fillCompanies(res);
  } catch {
    // sessão ainda não capturada
  }
}

bootstrap();
