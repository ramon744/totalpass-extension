const TP_ORIGIN = "https://hr.totalpass.com";
const API = `${TP_ORIGIN}/company_app/v1`;
const DEBUG_FILENAME = "tp-bridge-debug.json";
const DEFAULT_MANAGER_URL = "http://localhost:3000";

/** @typedef {{ email: string, token: string, capturedAt: string }} Session */

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const headers = details.requestHeaders || [];
    let email = "";
    let token = "";

    for (const h of headers) {
      const name = (h.name || "").toLowerCase();
      if (name === "x-company-user-email") email = h.value || "";
      if (name === "x-company-user-token") token = h.value || "";
    }

    if (email && token) {
      chrome.storage.session.set({
        session: {
          email,
          token,
          capturedAt: new Date().toISOString(),
        },
      });
    }
  },
  { urls: ["https://hr.totalpass.com/company_app/*"] },
  ["requestHeaders"]
);

async function getSettings() {
  const data = await chrome.storage.local.get(["managerUrl", "bridgeSecret"]);
  return {
    managerUrl: String(data.managerUrl || DEFAULT_MANAGER_URL).replace(/\/$/, ""),
    bridgeSecret: String(data.bridgeSecret || "").trim(),
  };
}

async function getSession() {
  const { session } = await chrome.storage.session.get("session");
  if (!session?.email || !session?.token) {
    throw new Error(
      "Sessão TotalPass não capturada. Abra hr.totalpass.com logado e navegue (Beneficiários)."
    );
  }
  return session;
}

async function tpFetch(path, options = {}) {
  const session = options.session || (await getSession());
  const { session: _s, ...init } = options;
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-company-user-email": session.email,
      "x-company-user-token": session.token,
      ...(init.headers || {}),
    },
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 500) };
  }

  if (!res.ok) {
    const msg =
      data?.message || data?.error || data?.errors || `HTTP ${res.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function summarizeCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const low = lines[i].toLowerCase();
    if (low.includes("nome") && (low.includes("documento") || low.includes("cpf"))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    return {
      totalLines: lines.length,
      dataRows: Math.max(0, lines.length - 1),
      header: lines[0]?.slice(0, 120) || "",
      preview: lines.slice(0, 5).map((l) => l.slice(0, 100)),
    };
  }
  return {
    totalLines: lines.length,
    headerIdx,
    header: lines[headerIdx].slice(0, 200),
    dataRows: lines.length - headerIdx - 1,
    preview: lines.slice(headerIdx, headerIdx + 4).map((l) => l.slice(0, 120)),
  };
}

function sanitizePreview(preview) {
  return (preview || []).map((line) =>
    String(line)
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
      .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[cpf]")
      .replace(/\(?\d{2}\)?\s?\d{4,5}-?\d{4}/g, "[tel]")
      .slice(0, 160)
  );
}

async function rememberLast(key, value) {
  const { lastResults = {} } = await chrome.storage.session.get("lastResults");
  lastResults[key] = { at: new Date().toISOString(), ...value };
  await chrome.storage.session.set({ lastResults });
}

/**
 * Exporta CSV na TotalPass e devolve texto + meta.
 * @param {{ companyId?: string|null }} opts
 */
async function exportCsvFromTotalPass(opts = {}) {
  const companyId = opts.companyId ? String(opts.companyId) : null;
  const createBody = {
    report_type: "employee",
    file_extension: "csv",
    status: ["active", "eligible", "inactive"],
    company: companyId ? [companyId] : [],
  };

  const created = await tpFetch("/exports", {
    method: "POST",
    body: JSON.stringify(createBody),
  });

  const exportId = created?.data?.id;
  if (!exportId) throw new Error("Export criado sem id");

  let finished = null;
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const cur = await tpFetch(`/exports/${exportId}`);
    const state = cur?.data?.attributes?.aasm_state;
    if (state === "finished") {
      finished = cur;
      break;
    }
    if (state === "failed" || state === "error") {
      throw new Error(`Export falhou: ${state}`);
    }
  }
  if (!finished) throw new Error("Timeout aguardando exportação");

  const link = finished.data.attributes.link;
  const metaCount = finished.data.attributes.metadata?.count;
  if (!link) throw new Error("Export finished sem link S3");

  const fileRes = await fetch(link);
  if (!fileRes.ok) throw new Error(`Download S3 HTTP ${fileRes.status}`);
  const csvText = await fileRes.text();
  const summary = summarizeCsv(csvText);
  const fileName =
    link.split("/").pop()?.split("?")[0] ||
    `Exportacao_de_Beneficiarios_${exportId}.csv`;

  const lastExport = {
    id: exportId,
    at: new Date().toISOString(),
    metaCount,
    summary: {
      ...summary,
      preview: sanitizePreview(summary.preview),
    },
    fileNameHint: fileName,
  };
  await chrome.storage.session.set({ lastExport });
  await rememberLast("export", {
    ok: true,
    exportId,
    metaCount,
    dataRows: summary.dataRows,
  });

  return { csvText, fileName, exportId, metaCount, summary: lastExport.summary };
}

async function removeOldDebugDownloads() {
  const items = await chrome.downloads.search({
    filenameRegex: "tp-bridge-debug\\.json$",
    orderBy: ["-startTime"],
    limit: 20,
  });
  for (const item of items) {
    try {
      if (item.id != null) {
        await chrome.downloads.removeFile(item.id).catch(() => {});
        await chrome.downloads.erase({ id: item.id }).catch(() => {});
      }
    } catch {
      // ignore
    }
  }
}

async function downloadSnapshot(snapshot) {
  await removeOldDebugDownloads();
  const json = JSON.stringify(snapshot, null, 2);
  const dataUrl =
    "data:application/json;charset=utf-8," + encodeURIComponent(json);
  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename: DEBUG_FILENAME,
    saveAs: false,
    conflictAction: "overwrite",
  });

  let filename = DEBUG_FILENAME;
  for (let i = 0; i < 15; i++) {
    await sleep(200);
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item?.filename) {
      filename = item.filename;
      if (item.state === "complete") break;
    }
  }

  await chrome.storage.local.set({
    debugMeta: {
      downloadId,
      filename,
      savedAt: new Date().toISOString(),
    },
  });

  return { downloadId, filename };
}

async function buildSnapshot(options = {}) {
  const includeLive = options.includeLive !== false;
  const store = await chrome.storage.session.get([
    "session",
    "lastExport",
    "lastResults",
  ]);
  const session = store.session;
  const diagnostics = {
    hasSession: Boolean(session?.email && session?.token),
    extensionVersion: chrome.runtime.getManifest().version,
  };
  const live = {};

  if (includeLive && diagnostics.hasSession) {
    try {
      live.insights = await tpFetch("/company_groups/employee_insights");
      diagnostics.insightsOk = true;
    } catch (e) {
      diagnostics.insightsOk = false;
      live.insightsError = e instanceof Error ? e.message : String(e);
    }

    try {
      const companiesRaw = await tpFetch("/company_groups/companies");
      const list = Array.isArray(companiesRaw)
        ? companiesRaw
        : companiesRaw?.data || [];
      live.companies = list.map((c) => ({
        id: String(c.id ?? c.attributes?.id ?? ""),
        name: c.name || c.company_name || c.attributes?.name || "(sem nome)",
        main: Boolean(c.main),
      }));
      diagnostics.companiesOk = true;
      diagnostics.companiesCount = live.companies.length;
    } catch (e) {
      diagnostics.companiesOk = false;
      live.companiesError = e instanceof Error ? e.message : String(e);
    }

    try {
      const holders = await tpFetch("/employees/search", {
        method: "POST",
        body: JSON.stringify({
          status: ["active", "eligible"],
          per: "10",
          type: "holder",
          page: "1",
          search_term: "",
          company: [],
        }),
      });
      live.holders = {
        meta: holders?.meta || null,
        pageCount: (holders?.data || []).length,
        sampleStatuses: (holders?.data || []).slice(0, 5).map((r) => ({
          id: r.id,
          status: r.attributes?.status,
          type: r.attributes?.type,
          plan: r.attributes?.company_plan_name,
        })),
      };
      diagnostics.holdersOk = true;
    } catch (e) {
      diagnostics.holdersOk = false;
      live.holdersError = e instanceof Error ? e.message : String(e);
    }
  }

  const lastExport = store.lastExport
    ? {
        ...store.lastExport,
        summary: store.lastExport.summary
          ? {
              ...store.lastExport.summary,
              preview: sanitizePreview(store.lastExport.summary.preview),
            }
          : null,
      }
    : null;

  const working =
    diagnostics.hasSession &&
    (diagnostics.insightsOk === true ||
      diagnostics.holdersOk === true ||
      Boolean(lastExport));

  return {
    kind: "totalpass-bridge-debug",
    version: 1,
    createdAt: new Date().toISOString(),
    working,
    diagnostics,
    session: session
      ? {
          email: session.email,
          tokenPreview: `${String(session.token).slice(0, 4)}…${String(session.token).slice(-4)}`,
          tokenLength: String(session.token).length,
          capturedAt: session.capturedAt,
        }
      : null,
    lastExport,
    lastResults: store.lastResults || null,
    live,
    note: "Snapshot de debug. Use Limpar dados depois.",
    expectedPathHint: "Downloads/tp-bridge-debug.json",
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "GET_SETTINGS": {
        const settings = await getSettings();
        return {
          ok: true,
          managerUrl: settings.managerUrl,
          hasBridgeSecret: Boolean(settings.bridgeSecret),
        };
      }

      case "SAVE_SETTINGS": {
        const managerUrl = String(message.managerUrl || DEFAULT_MANAGER_URL)
          .trim()
          .replace(/\/$/, "");
        const bridgeSecret = String(message.bridgeSecret || "").trim();
        await chrome.storage.local.set({ managerUrl, bridgeSecret });
        return { ok: true, managerUrl, hasBridgeSecret: Boolean(bridgeSecret) };
      }

      case "GET_SESSION": {
        const { session } = await chrome.storage.session.get("session");
        return {
          ok: true,
          session: session
            ? {
                email: session.email,
                tokenPreview: `${session.token.slice(0, 4)}…${session.token.slice(-4)}`,
                capturedAt: session.capturedAt,
              }
            : null,
        };
      }

      case "TEST_INSIGHTS": {
        const data = await tpFetch("/company_groups/employee_insights");
        const result = { ok: true, data };
        await rememberLast("insights", result);
        return result;
      }

      case "SEARCH_HOLDERS": {
        const data = await tpFetch("/employees/search", {
          method: "POST",
          body: JSON.stringify({
            status: ["active", "eligible"],
            per: "10",
            type: "holder",
            page: "1",
            search_term: "",
            company: [],
          }),
        });
        const items = data?.data || [];
        const result = {
          ok: true,
          meta: data?.meta || null,
          count: items.length,
          sample: items.slice(0, 3).map((row) => ({
            id: row.id,
            status: row.attributes?.status,
            plan: row.attributes?.company_plan_name,
            type: row.attributes?.type,
          })),
        };
        await rememberLast("holders", result);
        return result;
      }

      case "SEARCH_DEPENDENTS": {
        const data = await tpFetch("/employees/search", {
          method: "POST",
          body: JSON.stringify({
            status: ["active", "eligible"],
            per: "10",
            type: "dependent",
            page: "1",
            search_term: "",
            company: [],
          }),
        });
        const result = {
          ok: true,
          meta: data?.meta || null,
          count: (data?.data || []).length,
        };
        await rememberLast("dependents", result);
        return result;
      }

      case "EXPORT_CSV": {
        const exported = await exportCsvFromTotalPass({
          companyId: message.companyId,
        });
        return {
          ok: true,
          exportId: exported.exportId,
          metaCount: exported.metaCount,
          summary: exported.summary,
          fileName: exported.fileName,
        };
      }

      case "SYNC_TO_MANAGER": {
        const settings = await getSettings();
        if (!settings.managerUrl) {
          throw new Error("Configure a URL do Manager nas opções da extensão");
        }

        const exported = await exportCsvFromTotalPass({
          companyId: message.companyId,
        });

        const form = new FormData();
        const blob = new Blob([exported.csvText], {
          type: "text/csv;charset=utf-8",
        });
        form.append("file", blob, exported.fileName);
        if (message.provedorId) {
          form.append("provedorId", String(message.provedorId));
        }

        const headers = {};
        if (settings.bridgeSecret) {
          headers["x-tp-bridge-secret"] = settings.bridgeSecret;
        }

        const syncUrl = `${settings.managerUrl}/api/totalpass/sync`;
        const res = await fetch(syncUrl, {
          method: "POST",
          body: form,
          headers,
          credentials: "include",
        });

        const text = await res.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = { raw: text.slice(0, 400) };
        }

        if (!res.ok) {
          throw new Error(
            data?.error ||
              `Manager HTTP ${res.status}. Confira se o app está no ar, o segredo da ponte e/ou se você está logado no Manager.`
          );
        }

        const result = {
          ok: true,
          synced: true,
          managerUrl: settings.managerUrl,
          exportId: exported.exportId,
          fileName: exported.fileName,
          metaCount: exported.metaCount,
          import: data,
        };
        await rememberLast("sync", {
          ok: true,
          exportId: exported.exportId,
          totals: {
            processados: data?.total_processados,
            criados: data?.total_criados,
            atualizados: data?.total_atualizados,
            inativados: data?.total_inativados,
            erros: data?.total_erros,
          },
        });
        return result;
      }

      case "GET_COMPANIES": {
        const data = await tpFetch("/company_groups/companies");
        const list = Array.isArray(data) ? data : data?.data || [];
        const result = {
          ok: true,
          companies: list.map((c) => ({
            id: String(c.id ?? c.attributes?.id ?? ""),
            name: c.name || c.company_name || c.attributes?.name || "(sem nome)",
            main: Boolean(c.main),
          })),
        };
        await rememberLast("companies", result);
        return result;
      }

      case "SAVE_DEBUG_SNAPSHOT": {
        const snapshot = await buildSnapshot({ includeLive: true });
        const saved = await downloadSnapshot(snapshot);
        return {
          ok: true,
          working: snapshot.working,
          diagnostics: snapshot.diagnostics,
          filename: saved.filename,
          downloadId: saved.downloadId,
        };
      }

      case "CLEAR_DEBUG": {
        await chrome.storage.session.clear();
        const { debugMeta } = await chrome.storage.local.get("debugMeta");
        await removeOldDebugDownloads();
        await chrome.storage.local.remove("debugMeta");
        return {
          ok: true,
          cleared: true,
          previousFile: debugMeta?.filename || null,
          message: "Memória limpa e debug JSON removido.",
        };
      }

      case "GET_DEBUG_META": {
        const { debugMeta } = await chrome.storage.local.get("debugMeta");
        return { ok: true, debugMeta: debugMeta || null };
      }

      default:
        return { ok: false, error: "Comando desconhecido" };
    }
  })()
    .then(sendResponse)
    .catch((err) =>
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    );

  return true;
});
