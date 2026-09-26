/* NEVER LOSS dashboard — paper por omissão; Cripto = Bybit Linear USDT; REAL atrás de chaves servidor. */
(function () {
  "use strict";

  const APP_ID = "34t836m5r3AO3f7xavbvL";
  const API_BASE = "https://api.derivws.com";
  const PUBLIC_WS = "wss://api.derivws.com/trading/v1/options/ws/public";
  const ACCOUNT_KEY = "nl_selected_account_id";
  const SOURCE_KEY = "nl_market_source";
  const BYBIT_SYMBOLS_URL = "/api/bybit-symbols";
  const BYBIT_KLINES_URL = "/api/bybit-klines";
  const BYBIT_STATUS_URL = "/api/bybit-status";
  // REAL order path (signed server proxy). PAPER never calls this — only placeBybitOrder when isRealTradingMode().
  const BYBIT_ORDER_URL = "/api/bybit-order";
  const TRADING_MODE_KEY = "nl_crypto_trading_mode";
  const JOURNAL_KEY = "nl_trade_journal";
  const JOURNAL_MAX = 400;

  const NL = window.NL;
  if (!NL) {
    document.body.innerHTML = "<p style='padding:24px;color:#f87171'>Falha a carregar nl-core.js</p>";
    return;
  }

  const token = sessionStorage.getItem("nl_access_token");
  if (!token) {
    location.replace("/");
    return;
  }

  const el = (id) => document.getElementById(id);
  const state = {
    accounts: [],
    selectedAccountId: sessionStorage.getItem(ACCOUNT_KEY) || "",
    selectedAccount: null,
    symbols: [],
    activeCrypto: [],
    bybitSymbols: [],
    // Cripto = sempre Bybit Linear USDT; dígitos/forex = Deriv. Fonte segue o painel.
    dataSource: "bybit",
    tradingMode: "PAPER",
    bybitKeysConfigured: false,
    bybitRealAvailable: false,
    /** Last REAL open qty/side for flatten on trade_closed (PAPER ignores). */
    realOpenQty: null,
    realOpenSide: null,
    panel: "crypto",
    ws: null,
    nextId: 1,
    waiting: new Map(),
    running: false,
    paused: false,
    pollTimer: null,
    controller: null,
    session: null,
    lastEpoch: 0,
    historyLines: [],
    tradeJournal: loadJournal(),
    activeView: "operar",
    symbol: "BTCUSDT",
    granularity: 300,
    stake: 1,
    minutes: 60,
    minMultiplier: 100,
    strategySet: "",
    prePlayGate: null,
    prePlayOk: false,
    revalidateEvery: 12,
  };

  function authHeaders() {
    return {
      Authorization: "Bearer " + token,
      "Deriv-App-ID": APP_ID,
      "Content-Type": "application/json",
    };
  }

  function formatApiError(payload, status) {
    if (payload && Array.isArray(payload.errors) && payload.errors[0]) {
      const e = payload.errors[0];
      return (e.code || "error") + " - " + (e.message || status);
    }
    if (payload && (payload.error_description || payload.error)) {
      return (payload.error || "error") + " - " + (payload.error_description || status);
    }
    return "HTTP " + status;
  }

  function pushHistory(text, cls) {
    state.historyLines.unshift({ text, cls: cls || "" });
    if (state.historyLines.length > 200) state.historyLines.length = 200;
    renderHistory();
  }

  function renderHistory() {
    const box = el("history");
    if (!state.historyLines.length) {
      box.innerHTML =
        '<div class="empty">Sem eventos ainda. Só eventos reais da sessão paper / simulado.</div>';
      return;
    }
    box.innerHTML = state.historyLines
      .map((l) => '<div class="line ' + l.cls + '">' + escapeHtml(l.text) + "</div>")
      .join("");
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function loadJournal() {
    try {
      const raw = localStorage.getItem(JOURNAL_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_e) {
      return [];
    }
  }

  function saveJournal() {
    try {
      localStorage.setItem(JOURNAL_KEY, JSON.stringify(state.tradeJournal.slice(0, JOURNAL_MAX)));
    } catch (_e) {
      /* quota / private mode — ignore */
    }
  }

  function clockLocal(ms) {
    try {
      return new Date(ms).toLocaleString("pt-PT", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
    } catch (_e) {
      return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
    }
  }

  function recordJournalFromEvent(e) {
    if (!e || (e.type !== "trade_opened" && e.type !== "trade_closed")) return;
    const mode = isRealTradingMode() ? "REAL" : "PAPER";
    const row = {
      id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
      at: typeof e.at === "number" ? e.at : Date.now(),
      kind: e.type === "trade_opened" ? "open" : "close",
      symbol: state.symbol || "—",
      direction: e.direction === 1 ? "COMPRA" : e.direction === -1 ? "VENDA" : "—",
      mode: mode,
      stake: state.stake,
      entry: e.entry,
      exit: e.type === "trade_closed" ? e.exit : null,
      reason: e.type === "trade_closed" ? e.reason || "" : "",
      r: e.type === "trade_closed" && typeof e.r === "number" ? e.r : null,
      pnl: e.type === "trade_closed" && typeof e.pnl === "number" ? e.pnl : null,
      source: typeof sourceLabel === "function" ? sourceLabel() : state.dataSource || "",
      strategy: (e.strategy && e.strategy.name) || e.strategy || state.strategySet || "",
    };
    state.tradeJournal.unshift(row);
    if (state.tradeJournal.length > JOURNAL_MAX) state.tradeJournal.length = JOURNAL_MAX;
    saveJournal();
    renderTradeJournal();
    renderPerfas();
  }

  function renderTradeJournal() {
    const box = el("tradeJournal");
    if (!box) return;
    if (!state.tradeJournal.length) {
      box.innerHTML =
        '<div class="empty">Sem operações no diário. Aberturas e fechos aparecem aqui após PLAY (dados reais da sessão).</div>';
      return;
    }
    const rows = state.tradeJournal
      .map(function (t) {
        const modeCls = t.mode === "REAL" ? "real" : "paper";
        const kindLabel = t.kind === "open" ? "ABRE" : "FECHA";
        let kindCls = "kind-open";
        if (t.kind === "close") kindCls = t.pnl != null && t.pnl >= 0 ? "kind-close-win" : "kind-close-loss";
        const pnlCell =
          t.pnl == null
            ? "—"
            : '<span class="' + (t.pnl >= 0 ? "pnl-pos" : "pnl-neg") + '">' + escapeHtml(signed(t.pnl)) + "</span>";
        const rCell = t.r == null ? "—" : escapeHtml(signed(t.r) + "R");
        const exitCell = t.exit == null ? "—" : escapeHtml(String(Number(Number(t.exit).toPrecision(8))));
        const entryCell = t.entry == null ? "—" : escapeHtml(String(Number(Number(t.entry).toPrecision(8))));
        const reason = t.reason === "sl" ? "stop" : t.reason === "tp" ? "alvo" : t.reason === "time" ? "tempo" : t.reason || "—";
        return (
          "<tr>" +
          "<td>" + escapeHtml(clockLocal(t.at)) + "</td>" +
          '<td><span class="mode-tag ' + modeCls + '">' + escapeHtml(t.mode) + "</span></td>" +
          '<td class="' + kindCls + '">' + kindLabel + "</td>" +
          "<td>" + escapeHtml(t.symbol) + "</td>" +
          "<td>" + escapeHtml(t.direction) + "</td>" +
          "<td>" + escapeHtml(String(t.stake)) + "</td>" +
          "<td>" + entryCell + "</td>" +
          "<td>" + exitCell + "</td>" +
          "<td>" + escapeHtml(reason) + "</td>" +
          "<td>" + rCell + "</td>" +
          "<td>" + pnlCell + "</td>" +
          "</tr>"
        );
      })
      .join("");
    box.innerHTML =
      '<table class="journal-table"><thead><tr>' +
      "<th>Quando</th><th>Modo</th><th>Tipo</th><th>Símbolo</th><th>Dir.</th><th>Stake</th>" +
      "<th>Entrada</th><th>Saída</th><th>Motivo</th><th>R</th><th>Resultado</th>" +
      "</tr></thead><tbody>" +
      rows +
      "</tbody></table>";
  }

  function renderPerfas() {
    const summary = state.session ? state.session.summary() : null;
    const pfStatus = el("pfStatus");
    if (!pfStatus) return;

    if (!summary) {
      pfStatus.textContent = "—";
      el("pfWins").textContent = "—";
      el("pfLosses").textContent = "—";
      el("pfWinRate").textContent = "—";
      el("pfPnl").textContent = "—";
      el("pfMeanR").textContent = "—";
      el("pfTrades").textContent = "—";
      el("pfDd").textContent = "—";
      el("pfSessionNote").textContent = "Sem sessão activa. Arranca PLAY em Operar para ver números reais.";
    } else {
      const m = summary.metrics || {};
      const closed = summary.closed || 0;
      const wins = typeof m.wins === "number" ? m.wins : 0;
      const losses = closed > 0 ? closed - wins : 0;
      pfStatus.textContent = summary.status + (summary.stopReason ? " (" + summary.stopReason + ")" : "");
      el("pfWins").textContent = closed ? String(wins) : "0";
      el("pfLosses").textContent = closed ? String(losses) : "0";
      el("pfWinRate").textContent =
        closed && typeof m.winRate === "number" ? (m.winRate * 100).toFixed(1) + "%" : closed ? "0%" : "—";
      el("pfPnl").textContent = signed(summary.totalPnl) + (isRealTradingMode() ? " (REAL)" : " (sim)");
      el("pfMeanR").textContent =
        closed && typeof m.meanR === "number" ? signed(m.meanR) + "R" : "—";
      el("pfTrades").textContent = String(summary.closed) + " / " + summary.opened;
      el("pfDd").textContent = typeof summary.maxDrawdown === "number" ? summary.maxDrawdown.toFixed(2) : "—";
      el("pfSessionNote").textContent = closed
        ? "Sessão com " + closed + " fecho(s) · stake fixa " + summary.stake + "."
        : "Sessão sem fechos ainda (NO TRADE ou só abertas).";
    }

    const closes = state.tradeJournal.filter(function (t) {
      return t.kind === "close" && typeof t.pnl === "number";
    });
    if (!closes.length) {
      el("pjClosed").textContent = "—";
      el("pjWins").textContent = "—";
      el("pjLosses").textContent = "—";
      el("pjWinRate").textContent = "—";
      el("pjPnl").textContent = "—";
      el("pjModes").textContent = "—";
      el("pjNote").textContent = "Sem fechos no diário ainda. Os números só aparecem após operações reais da sessão.";
      return;
    }
    let winsJ = 0;
    let pnlJ = 0;
    let paperN = 0;
    let realN = 0;
    for (const t of closes) {
      pnlJ += t.pnl;
      if (t.pnl >= 0) winsJ += 1;
      if (t.mode === "REAL") realN += 1;
      else paperN += 1;
    }
    const n = closes.length;
    const lossesJ = n - winsJ;
    el("pjClosed").textContent = String(n);
    el("pjWins").textContent = String(winsJ);
    el("pjLosses").textContent = String(lossesJ);
    el("pjWinRate").textContent = ((winsJ / n) * 100).toFixed(1) + "%";
    el("pjPnl").textContent = signed(pnlJ);
    el("pjModes").textContent = paperN + " PAPER / " + realN + " REAL";
    el("pjNote").textContent =
      "Agregado de " + n + " fecho(s) guardados neste browser. Não inventa saldos.";
  }

  function setActiveView(view) {
    const allowed = { analise: 1, operar: 1, livros: 1, perfas: 1 };
    if (!allowed[view]) view = "operar";
    state.activeView = view;
    ["analise", "operar", "livros", "perfas"].forEach(function (v) {
      const pane = el("view-" + v);
      if (pane) pane.hidden = v !== view;
    });
    document.querySelectorAll(".view-tab").forEach(function (btn) {
      const on = btn.getAttribute("data-view") === view;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    if (view === "analise") {
      syncFormToAnalise();
      updateAnaliseButtons();
    }
    if (view === "livros") renderTradeJournal();
    if (view === "perfas") renderPerfas();
  }

  function clearTradeJournal() {
    if (!state.tradeJournal.length) return;
    if (!confirm("Apagar o diário neste aparelho? A sessão actual não pára.")) return;
    state.tradeJournal = [];
    saveJournal();
    renderTradeJournal();
    renderPerfas();
  }

  function updateNextStep() {
    const box = el("nextStepText");
    if (!box) return;
    const hasAccount = !!resolveSelectedAccount();
    const hasStrategy = !!(el("strategySet") && el("strategySet").value);
    const running = state.session && state.session.status === "RUNNING";
    const paused = state.session && state.session.status === "PAUSED";
    if (running) {
      box.textContent = "Sessão a correr · usa PAUSE ou STOP quando quiseres";
      return;
    }
    if (paused) {
      box.textContent = "Em pausa · PLAY para continuar ou STOP para terminar";
      return;
    }
    if (!hasAccount) {
      box.textContent = "1 Conta · 2 Estratégia · 3 Analisar · 4 PLAY";
      return;
    }
    if (!hasStrategy) {
      box.textContent = "2 Escolhe a estratégia · 3 Analisar · 4 PLAY";
      return;
    }
    if (!state.prePlayOk) {
      box.textContent = "3 Analisar (aba Análise ou Operar) · 4 PLAY se a porta abrir";
      return;
    }
    box.textContent = "4 Pronto — clica PLAY";
  }

  function updateModeBanner() {
    const banner = el("modeBanner");
    const sub = el("sessionHeroSub");
    const real = isRealTradingMode();
    if (banner) {
      banner.textContent = real ? "REAL" : "PAPER";
      banner.classList.toggle("paper", !real);
      banner.classList.toggle("real", real);
    }
    if (sub) {
      sub.textContent = real
        ? "ATENÇÃO: modo REAL — ordens com dinheiro."
        : "Modo simulado — sem dinheiro real.";
    }
  }

  function toggleGateDetails() {
    const metrics = el("gateMetrics");
    const btn = el("btnGateToggle");
    if (!metrics || !btn) return;
    const open = metrics.hasAttribute("hidden");
    if (open) metrics.removeAttribute("hidden");
    else metrics.setAttribute("hidden", "");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.textContent = open ? "Ocultar" : "Detalhes";
  }

  function accountKind(acc) {
    return acc && acc.account_type === "demo" ? "DEMO" : "REAL";
  }

  function accountBalanceText(acc) {
    if (!acc) return "—";
    return (acc.balance != null ? acc.balance : "—") + " " + (acc.currency || "");
  }

  function resolveSelectedAccount() {
    if (!state.selectedAccountId) {
      state.selectedAccount = null;
      return null;
    }
    const found = state.accounts.find((a) => a.account_id === state.selectedAccountId);
    state.selectedAccount = found || null;
    if (!found) {
      state.selectedAccountId = "";
      sessionStorage.removeItem(ACCOUNT_KEY);
    }
    return state.selectedAccount;
  }

  function renderAccountContext() {
    const box = el("accountContext");
    // modePill / banner reflect Cripto PAPER|REAL — não forçar PAPER aqui
    if (typeof updateModeBanner === "function") updateModeBanner();
    if (typeof updateSourceUI === "function") {
      /* pill text owned by updateSourceUI when available */
    }
    const acc = resolveSelectedAccount();
    if (!acc) {
      box.className = "account-context muted";
      box.textContent = "Escolhe DEMO ou REAL abaixo. Depois estratégia → Analisar → PLAY.";
      return;
    }
    const kind = accountKind(acc);
    box.className = "account-context ready";
    box.innerHTML =
      "<b>" +
      escapeHtml(kind) +
      "</b> · " +
      escapeHtml(acc.account_id || "?") +
      ' · <span class="bal">' +
      escapeHtml(accountBalanceText(acc)) +
      '</span> <span class="sim-tag">contexto</span><br>' +
      "<small>Saldo Deriv (REST). O modo Cripto PAPER/REAL está no banner acima.</small>";
  }

  function selectAccount(accountId) {
    state.selectedAccountId = accountId || "";
    if (state.selectedAccountId) {
      sessionStorage.setItem(ACCOUNT_KEY, state.selectedAccountId);
    } else {
      sessionStorage.removeItem(ACCOUNT_KEY);
    }
    resolveSelectedAccount();
    renderAccounts();
    renderAccountContext();
    updateButtons();
    if (state.selectedAccount) {
      pushHistory(
        "Conta selecionada: " +
          accountKind(state.selectedAccount) +
          " " +
          state.selectedAccount.account_id +
          " (contexto; sessão paper)",
        "open",
      );
    }
  }

  function renderAccounts() {
    const box = el("accounts");
    if (!state.accounts.length) {
      box.innerHTML =
        '<div class="loading">Nenhuma conta Options nesta sessão. Cria uma conta demo na Deriv.</div>';
      return;
    }
    box.innerHTML = "";
    for (const acc of state.accounts) {
      const kind = accountKind(acc);
      const selected = acc.account_id === state.selectedAccountId;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "account-card" + (selected ? " selected" : "");
      btn.setAttribute("data-account-id", acc.account_id || "");
      btn.innerHTML =
        '<span class="kind-badge ' +
        (kind === "DEMO" ? "demo" : "real") +
        '">' +
        kind +
        "</span>" +
        "<b>" +
        escapeHtml(acc.account_id || "?") +
        "</b>" +
        "Moeda: " +
        escapeHtml(acc.currency || "—") +
        '<br>Saldo Deriv: <span class="bal">' +
        escapeHtml(accountBalanceText(acc)) +
        "</span><br>Estado: " +
        escapeHtml(acc.status || "—") +
        '<div class="hint">' +
        (selected
          ? "✓ Selecionada — PLAY usa este contexto (paper)"
          : "Clica para trabalhar com este saldo (paper)") +
        "</div>";
      btn.addEventListener("click", () => selectAccount(acc.account_id));
      box.appendChild(btn);
    }
  }

  function setGateUI(result, isOpen) {
    const box = el("gateBox");
    const allowed = !!(result && result.allowed && isOpen);
    box.classList.toggle("open", allowed);
    box.classList.toggle("closed", !allowed);
    el("gateState").textContent = allowed ? "PORTA ABERTA" : "NO TRADE";
    el("gateReason").textContent = result
      ? NL.formatCandleGate(result)
      : "A aguardar dados de mercado…";

    el("gateLabel").textContent = result && result.label ? result.label : "—";
    el("gateOos").textContent =
      result && typeof result.oosTrades === "number" ? String(result.oosTrades) : "—";
    el("gateMeanR").textContent =
      result && typeof result.meanR === "number"
        ? (result.meanR >= 0 ? "+" : "") + result.meanR.toFixed(3) + "R"
        : "—";
    el("gateP").textContent =
      result && result.pValue != null && Number.isFinite(result.pValue)
        ? result.pValue.toFixed(4)
        : "—";
    el("gateStrat").textContent =
      result && result.strategy && result.strategy.name ? result.strategy.name : "—";
  }

  function setStats(summary) {
    el("statStatus").textContent = summary ? summary.status : "—";
    el("statPnl").textContent = summary
      ? signed(summary.totalPnl) + (isRealTradingMode() ? " (REAL)" : " (sim)")
      : "—";
    el("statTrades").textContent = summary ? String(summary.closed) + " / " + summary.opened : "—";
    el("statDd").textContent = summary ? summary.maxDrawdown.toFixed(2) : "—";
    renderPerfas();
  }

  function signed(x) {
    return (x >= 0 ? "+" : "") + x.toFixed(2);
  }

  async function loadAccounts() {
    el("accounts").innerHTML = '<div class="loading">A carregar contas…</div>';
    try {
      const resp = await fetch(API_BASE + "/trading/v1/options/accounts", {
        method: "GET",
        headers: authHeaders(),
      });
      const payload = await resp.json().catch(() => ({}));
      if (resp.status === 401) {
        sessionStorage.removeItem("nl_access_token");
        el("authPill").className = "pill bad";
        el("authPill").textContent = "Sessão expirada";
        el("accounts").innerHTML =
          '<div class="err">Sessão expirada. <a href="/" style="color:#38bdf8">Voltar a ligar</a><br>' +
          escapeHtml(formatApiError(payload, resp.status)) +
          "</div>";
        return;
      }
      if (!resp.ok) {
        el("accounts").innerHTML =
          '<div class="err">' + escapeHtml(formatApiError(payload, resp.status)) + "</div>";
        return;
      }
      const accounts = Array.isArray(payload.data) ? payload.data : [];
      state.accounts = accounts;
      el("authPill").className = "pill ok";
      el("authPill").textContent = "Ligado à Deriv";
      resolveSelectedAccount();
      renderAccounts();
      renderAccountContext();
      updateButtons();
    } catch (e) {
      el("accounts").innerHTML = '<div class="err">Erro: ' + escapeHtml(e.message || String(e)) + "</div>";
    }
  }

  function connectWs() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(PUBLIC_WS);
      state.ws = ws;
      ws.onopen = () => {
        el("wsPill").className = "pill ok";
        el("wsPill").textContent = "WS público";
        resolve();
      };
      ws.onerror = () => {
        el("wsPill").className = "pill bad";
        el("wsPill").textContent = "WS falhou";
        reject(new Error("Erro de ligação ao WebSocket público"));
      };
      ws.onclose = () => {
        el("wsPill").className = "pill warn";
        el("wsPill").textContent = "WS fechado";
      };
      ws.onmessage = (event) => {
        const raw = String(event.data);
        try {
          const id = JSON.parse(raw).req_id;
          if (typeof id === "number" && state.waiting.has(id)) {
            const done = state.waiting.get(id);
            state.waiting.delete(id);
            done(raw);
          }
        } catch (_) {
          /* ignore */
        }
      };
    });
  }

  function requestRaw(payload) {
    const id = state.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.waiting.delete(id);
        reject(new Error("Sem resposta da Deriv em 30 s"));
      }, 30_000);
      state.waiting.set(id, (raw) => {
        clearTimeout(timer);
        resolve(raw);
      });
      state.ws.send(JSON.stringify(Object.assign({}, payload, { req_id: id })));
    });
  }

  function isBybitSource() {
    return state.dataSource === "bybit" || state.dataSource === "binance";
  }

  function sourceLabel() {
    return isBybitSource()
      ? ("Bybit Linear USDT · " + (state.tradingMode === "REAL" ? "REAL" : "PAPER / SIMULADO"))
      : "Deriv Options";
  }

  function isRealTradingMode() {
    return isBybitSource() && state.tradingMode === "REAL" && state.bybitKeysConfigured && state.bybitRealAvailable;
  }

  function updateTradingModeUI() {
    const toggle = el("tradingModeToggle");
    const hint = el("tradingModeHint");
    const paperBtn = el("modePaper");
    const realBtn = el("modeReal");
    const onBybit = isBybitSource();
    if (toggle) toggle.hidden = !onBybit;
    if (hint) hint.hidden = !onBybit;
    if (!onBybit) return;
    if (paperBtn) {
      paperBtn.classList.toggle("active", state.tradingMode !== "REAL");
      paperBtn.setAttribute("aria-pressed", state.tradingMode !== "REAL" ? "true" : "false");
    }
    if (realBtn) {
      const canReal = state.bybitKeysConfigured && state.bybitRealAvailable;
      realBtn.disabled = !canReal;
      realBtn.title = canReal
        ? "REAL: ordens Bybit Linear via servidor (porta de evidência + stake fixa + máx 3 h)"
        : "Indisponível: faltam BYBIT_API_KEY + BYBIT_API_SECRET no servidor (nunca no chat)";
      realBtn.classList.toggle("active", state.tradingMode === "REAL" && canReal);
      realBtn.setAttribute("aria-pressed", state.tradingMode === "REAL" && canReal ? "true" : "false");
    }
    if (hint) {
      hint.textContent = state.bybitRealAvailable && state.bybitKeysConfigured
        ? (state.tradingMode === "REAL"
          ? "REAL ligado — dinheiro de verdade. Porta + stake fixa + máx. 3 h."
          : "PAPER (seguro). Chaves OK no servidor — podes mudar para REAL (pede confirmação).")
        : "PAPER (seguro). REAL bloqueado: faltam chaves no servidor.";
    }
  }

  async function loadBybitTradingStatus() {
    try {
      const res = await fetch(BYBIT_STATUS_URL);
      const payload = await res.json().catch(function () { return null; });
      state.bybitKeysConfigured = !!(payload && payload.keysConfigured);
      state.bybitRealAvailable = !!(payload && payload.realAvailable);
      if (!(state.bybitKeysConfigured && state.bybitRealAvailable) && state.tradingMode === "REAL") {
        state.tradingMode = "PAPER";
        sessionStorage.setItem(TRADING_MODE_KEY, "PAPER");
      }
    } catch (_e) {
      state.bybitKeysConfigured = false;
      state.bybitRealAvailable = false;
      if (state.tradingMode === "REAL") {
        state.tradingMode = "PAPER";
        sessionStorage.setItem(TRADING_MODE_KEY, "PAPER");
      }
    }
    updateTradingModeUI();
  }

  function setTradingMode(next, opts) {
    const mode = String(next || "").toUpperCase() === "REAL" ? "REAL" : "PAPER";
    const skipConfirm = opts && opts.skipConfirm;
    if (mode === "REAL" && !(state.bybitKeysConfigured && state.bybitRealAvailable)) {
      pushHistory("REAL indisponível: falta BYBIT_API_KEY + BYBIT_API_SECRET no servidor.", "stop");
      return false;
    }
    if (state.running) {
      pushHistory("Para a sessão antes de mudar PAPER/REAL.", "stop");
      return false;
    }
    if (mode === "REAL" && !skipConfirm) {
      const ok = confirm(
        "Ativar modo REAL?\n\n" +
          "As próximas operações Cripto enviam ordens reais na Bybit.\n" +
          "Só continua se tiveres a certeza.\n\n" +
          "OK = REAL · Cancelar = ficar em PAPER",
      );
      if (!ok) return false;
    }
    state.tradingMode = mode;
    sessionStorage.setItem(TRADING_MODE_KEY, mode);
    updateSourceUI();
    updateModeBanner();
    pushHistory("Modo Cripto = " + mode + (mode === "PAPER" ? " / SIMULADO" : " (ordens via servidor)"), mode === "REAL" ? "open" : "");
    return true;
  }

  function updateSourceUI() {
    const d = el("srcDeriv");
    const b = el("srcBinance");
    const hint = el("sourceHint");
    const pill = el("modePill");
    const onBybit = isBybitSource();
    // Cripto: só Bybit (sem toggle Deriv). Dígitos/Forex: só Deriv (sem Bybit).
    if (d) {
      d.hidden = onBybit;
      d.disabled = true;
      d.classList.toggle("active", !onBybit);
      d.setAttribute("aria-pressed", onBybit ? "false" : "true");
    }
    if (b) {
      b.hidden = !onBybit;
      b.disabled = true;
      b.classList.toggle("active", onBybit);
      b.classList.toggle("binance-active", onBybit);
      b.setAttribute("aria-pressed", onBybit ? "true" : "false");
    }
    if (hint) {
      hint.textContent = onBybit
        ? "Cripto = Bybit USDT. Começa em PAPER. REAL só com chaves no servidor."
        : "Dígitos / Forex = Deriv. Sessão paper. Cripto usa Bybit.";
    }
    if (pill) {
      const realOn =
        onBybit &&
        state.tradingMode === "REAL" &&
        state.bybitKeysConfigured &&
        state.bybitRealAvailable;
      if (onBybit) {
        pill.textContent = realOn ? "REAL · Bybit" : "PAPER · Bybit";
        pill.classList.toggle("warn", !realOn);
        pill.classList.toggle("ok", false);
        pill.classList.toggle("real-live", realOn);
      } else {
        pill.textContent = "PAPER · Deriv";
        pill.classList.add("warn");
        pill.classList.remove("ok");
        pill.classList.remove("real-live");
      }
      pill.classList.toggle("binance", onBybit);
      updateTradingModeUI();
      updateModeBanner();
    }
    const tabs = el("marketTabs");
    if (tabs) {
      tabs.style.opacity = "1";
      tabs.querySelectorAll(".tab").forEach(function (btn) {
        btn.disabled = false;
      });
    }
  }

  function sourceForPanel(panel) {
    return panel === "crypto" ? "bybit" : "deriv";
  }

  async function loadBybitSymbols() {
    const res = await fetch(BYBIT_SYMBOLS_URL);
    const payload = await res.json().catch(function () { return null; });
    if (!res.ok) {
      const why = (payload && (payload.error_description || payload.error)) || ("HTTP " + res.status);
      throw new Error("Bybit símbolos: " + why);
    }
    if (!payload || !Array.isArray(payload.items)) {
      throw new Error("Bybit símbolos: resposta inválida");
    }
    state.bybitSymbols = payload.items;
    if (typeof NL.sortBybitUsdtPreferred === "function") {
      state.bybitSymbols = NL.sortBybitUsdtPreferred(state.bybitSymbols);
    }
  }

  async function setDataSource(next) {
    if (next !== "deriv" && next !== "bybit" && next !== "binance") return;
    if (state.running) {
      pushHistory("Para de sessão paper antes de mudar a fonte.", "stop");
      return false;
    }
    if (next === "binance") next = "bybit";
    state.dataSource = next;
    sessionStorage.setItem(SOURCE_KEY, next);
    state.prePlayOk = false;
    state.prePlayGate = null;
    setPrePlayUI(null);
    updateSourceUI();
    if (isBybitSource()) {
      if (!state.bybitSymbols.length) {
        pushHistory("A carregar pares USDT da Bybit (público)…", "");
        try {
          await loadBybitSymbols();
          pushHistory(
            "Cripto = Bybit Linear USDT: " + state.bybitSymbols.length + " perpetual USDT · " + state.tradingMode + ".",
            "open",
          );
        } catch (e) {
          pushHistory("Falha Bybit símbolos: " + (e.message || String(e)), "stop");
        }
      }
      state.symbol = (state.bybitSymbols[0] && state.bybitSymbols[0].symbol) || "BTCUSDT";
    } else if (state.panel === "forex") {
      state.symbol = "frxEURUSD";
    } else {
      state.symbol = "R_100";
    }
    renderSymbolSelect();
    renderChips();
    updateButtons();
    return true;
  }

  /** Fonte segue o painel: Cripto→Bybit, Dígitos/Forex→Deriv. */
  async function applyPanelSource() {
    const next = sourceForPanel(state.panel);
    if (state.dataSource === next) {
      updateSourceUI();
      if (next === "bybit" && !state.bybitSymbols.length) {
        return setDataSource("bybit");
      }
      renderSymbolSelect();
      renderChips();
      return true;
    }
    return setDataSource(next);
  }

  async function fetchBybitHistory(symbol, granularity, target) {
    if (typeof NL.fetchBybitCandleHistory === "function") {
      const proxyFetch = async function (url) {
        const u = String(url);
        // Reescreve pedidos kline para o proxy Vercel (geo-friendly).
        if (u.indexOf("/v5/market/kline") >= 0) {
          const q = u.split("?")[1] || "";
          return fetch(BYBIT_KLINES_URL + (q ? "?" + q : ""));
        }
        return fetch(u);
      };
      return NL.fetchBybitCandleHistory(symbol, granularity, target, proxyFetch);
    }
    // Fallback manual se nl-core antigo
    const interval =
      typeof NL.granularityToBybitInterval === "function"
        ? NL.granularityToBybitInterval(granularity)
        : null;
    if (!interval) throw new Error("granularity não suportada na Bybit: " + granularity);
    const pages = [];
    let endTime = "";
    let guard = 0;
    while (guard++ < 30) {
      let url =
        BYBIT_KLINES_URL +
        "?symbol=" +
        encodeURIComponent(symbol) +
        "&interval=" +
        encodeURIComponent(interval) +
        "&limit=1000";
      if (endTime) url += "&end=" + endTime;
      const res = await fetch(url);
      const text = await res.text();
      const msg = NL.parseBybitKlines(text);
      if (msg.kind !== "candles" || !msg.candles.length) break;
      pages.push(msg.candles);
      const oldest = msg.candles.reduce(function (m, c) { return Math.min(m, c.epoch); }, Infinity);
      endTime = String(oldest * 1000 - 1);
      const merged = NL.mergeCandlePages(pages);
      if (merged.length >= target || msg.candles.length < 1000) break;
    }
    return closedOnly(NL.mergeCandlePages(pages), granularity).slice(-target);
  }

  async function fetchLatestBybitCandles(symbol, granularity, count) {
    const interval =
      typeof NL.granularityToBybitInterval === "function"
        ? NL.granularityToBybitInterval(granularity)
        : null;
    if (!interval) throw new Error("granularity não suportada na Bybit: " + granularity);
    const url =
      BYBIT_KLINES_URL +
      "?symbol=" +
      encodeURIComponent(symbol) +
      "&interval=" +
      encodeURIComponent(interval) +
      "&limit=" +
      Math.min(1000, Math.max(2, count || 10));
    const res = await fetch(url);
    const text = await res.text();
    const msg = NL.parseBybitKlines(text);
    if (msg.kind !== "candles") {
      const why = msg.kind === "error" ? msg.code + " - " + msg.message : msg.reason || msg.kind;
      throw new Error("Bybit klines: " + why);
    }
    return closedOnly(msg.candles, granularity);
  }

    function classifyPanel(it) {
    const kind = NL.marketOf(it.symbol);
    if (kind === "crypto") return "crypto";
    if (kind === "forex" || kind === "metals") return "forex";
    if (it.market === "synthetic_index" || it.market === "indices") return "digits";
    if (/^(R_|1HZ)/.test(it.symbol)) return "digits";
    return null;
  }

  async function loadSymbols() {
    const msg = NL.parseActiveSymbols(await requestRaw({ active_symbols: "brief" }));
    if (msg.kind !== "symbols") {
      const why = msg.kind === "error" ? msg.code + " - " + msg.message : msg.kind;
      throw new Error("active_symbols: " + why);
    }
    state.symbols = msg.items;
    state.activeCrypto = msg.items.filter(function (it) {
      return typeof NL.isCryptoUsd === "function"
        ? NL.isCryptoUsd(it.symbol)
        : /^cry[A-Z0-9]+USD$/.test(it.symbol);
    });
    renderSymbolSelect();
    renderChips();
    renderMt5Panel();
  }

  function panelSymbols() {
    // Cripto = só Bybit Linear USDT (*USDT perpetual). Sem cry*USD / Deriv Options neste painel.
    if (state.panel === "crypto" || isBybitSource()) {
      return state.bybitSymbols.slice();
    }
    if (state.panel === "forex") {
      return state.symbols
        .filter((it) => {
          const k = NL.marketOf(it.symbol);
          return k === "forex" || k === "metals";
        })
        .sort((a, b) => a.symbol.localeCompare(b.symbol));
    }
    return state.symbols
      .filter((it) => classifyPanel(it) === "digits")
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  function renderSymbolSelect() {
    const list = panelSymbols();
    const sel = el("symbolSelect");
    const prev = state.symbol;
    sel.innerHTML = "";
    if (list.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Nenhum símbolo";
      sel.appendChild(opt);
      state.symbol = "";
      return;
    }
    for (const it of list) {
      const opt = document.createElement("option");
      opt.value = it.symbol;
      const flag = it.open && !it.suspended ? "●" : "○";
      opt.textContent =
        flag +
        " " +
        it.symbol +
        (it.displayName && it.displayName !== it.symbol ? " — " + it.displayName : "");
      sel.appendChild(opt);
    }
    if (list.some((i) => i.symbol === prev)) sel.value = prev;
    else {
      const prefer =
        typeof NL.filterCryptoUsd === "function" && state.panel === "crypto" && !isBybitSource()
          ? NL.filterCryptoUsd(list)
          : list;
      sel.value = (prefer[0] || list[0]).symbol;
    }
    state.symbol = sel.value;
    // Keep Análise tab symbol list in sync (paper preview uses same universe).
    const aSym = el("analiseSymbol");
    if (aSym) {
      const keep = aSym.value || state.symbol;
      aSym.innerHTML = sel.innerHTML;
      if (keep && Array.from(aSym.options).some(function (o) { return o.value === keep; })) {
        aSym.value = keep;
      } else {
        aSym.value = state.symbol;
      }
    }
  }

  function renderChips() {
    const strip = el("symbolChips");
    const list = panelSymbols();
    strip.innerHTML = "";
    for (const it of list) {
      const on = it.open && !it.suspended;
      const btn = document.createElement("button");
      btn.type = "button";
      var feedOnly =
        state.panel === "crypto" &&
        !isBybitSource() &&
        typeof NL.isOptionsFeedOnly === "function" &&
        NL.isOptionsFeedOnly(it.symbol, state.activeCrypto);
      btn.className =
        "chip " +
        (on ? "on" : "off") +
        (feedOnly ? " feed" : "") +
        (it.symbol === state.symbol ? " active" : "");
      btn.textContent = it.symbol;
      btn.title = isBybitSource()
        ? (it.displayName || it.symbol) + " · Bybit Linear USDT · " + state.tradingMode
        : (it.displayName || it.symbol) +
          (on ? " · aberto" : " · fechado/suspenso") +
          (feedOnly ? " · feed Options (não em active_symbols)" : " · Options active");
      btn.addEventListener("click", () => {
        state.symbol = it.symbol;
        el("symbolSelect").value = it.symbol;
        renderChips();
      });
      strip.appendChild(btn);
    }
    const n = list.length;
    const openN = list.filter((i) => i.open && !i.suspended).length;
    var activeN = state.activeCrypto.length;
    var feedN = Math.max(0, n - activeN);
    el("panelHint").textContent = state.panel === "crypto" || isBybitSource()
      ? "Cripto = Bybit Linear USDT: " +
        n +
        " perpetual *USDT (v5). Modo " +
        state.tradingMode +
        (state.tradingMode === "PAPER" ? " / SIMULADO" : "") +
        ". Lucro rápido / Loss zero + porta de evidência + stake fixa + máx 3 h + sem martingale + NO TRADE."
      : state.panel === "forex"
          ? "Forex e metais (frx*). Mercado fecha ao fim de semana."
          : "Índices sintéticos / dígitos. Paper em velas (mesma porta de evidência).";
    updateStrategyHint();
  }

  function closedOnly(candles, granularity) {
    const nowSec = Date.now() / 1000;
    return candles.filter((c) => c.epoch + granularity <= nowSec);
  }

  async function fetchHistory(symbol, granularity, target) {
    if (isBybitSource()) {
      return fetchBybitHistory(symbol, granularity, target);
    }
    const pages = [];
    let end = "latest";
    let total = 0;
    for (let p = 1; p <= 30 && total < target; p++) {
      const m = NL.parseCandlesMessage(
        await requestRaw({
          ticks_history: symbol,
          end: end,
          count: 1000,
          style: "candles",
          granularity: granularity,
        }),
      );
      if (m.kind !== "candles" || m.candles.length === 0) break;
      pages.push(m.candles);
      total = NL.mergeCandlePages(pages).length;
      const next = NL.nextCandleEnd(m.candles);
      if (next === null) break;
      end = next;
    }
    return closedOnly(NL.mergeCandlePages(pages), granularity).slice(-target);
  }

  function readForm() {
    state.symbol = el("symbolSelect").value;
    state.granularity = Number(el("granularity").value) || 300;
    state.stake = Number(el("stake").value) || 1;
    state.minutes = Math.min(180, Math.max(1, Number(el("minutes").value) || 60));
    state.minMultiplier = Number(el("minMultiplier").value) || 100;
    state.strategySet = el("strategySet").value || "";
  }

  function updateButtons() {
    const hasAccount = !!resolveSelectedAccount();
    const hasStrategy = !!(el("strategySet") && el("strategySet").value);
    const running = state.session && state.session.status === "RUNNING";
    const paused = state.session && state.session.status === "PAUSED";
    const stopped = !state.session || state.session.status === "STOPPED";
    el("btnPlay").disabled = !hasAccount || !hasStrategy || running;
    el("btnPlay").title = !hasAccount
      ? "Seleciona DEMO ou REAL primeiro"
      : !hasStrategy
        ? "Escolhe uma estratégia (Lucro rápido / Loss zero / …)"
        : "Iniciar sessão paper / simulado (após análise pré-PLAY)";
    const btnA = el("btnAnalyze");
    if (btnA) {
      btnA.disabled = !hasAccount || !hasStrategy || running;
      btnA.title = !hasAccount
        ? "Seleciona conta primeiro"
        : !hasStrategy
          ? "Escolhe estratégia primeiro"
          : "Correr porta de evidência sem abrir sessão";
    }
    el("btnPause").disabled = !running;
    el("btnStop").disabled = stopped && !state.running;
    void paused;
    updateNextStep();
    updateAnaliseButtons();
  }


  function currentPreset() {
    if (!state.strategySet) return null;
    if (typeof NL.strategyPreset === "function") return NL.strategyPreset(state.strategySet);
    return null;
  }

  function resolveStrategies() {
    if (!state.strategySet) throw new Error("Estratégia obrigatória");
    let raw;
    if (typeof NL.strategiesForPreset === "function") {
      raw = NL.strategiesForPreset(state.strategySet);
    } else if (state.strategySet === "lucro_rapido" && typeof NL.lucroRapidoStrategySet === "function") {
      raw = NL.lucroRapidoStrategySet();
    } else if (state.strategySet === "loss_zero" && typeof NL.lossZeroStrategySet === "function") {
      raw = NL.lossZeroStrategySet();
    } else if (state.strategySet === "tendencia_diaria" || state.strategySet === "daily") {
      raw = NL.dailyTrendStrategySet();
    } else {
      raw = NL.strategyLibrary();
    }
    const preset = currentPreset();
    const slAtr = (preset && preset.preferredGate && preset.preferredGate.slAtr) || 1.5;
    return raw.map((s) =>
      NL.feasible(s, { slAtr: slAtr, maxStopFraction: 1 / state.minMultiplier }),
    );
  }

  function gateOptsForPreset(costFraction, trainSize, testSize) {
    const preset = currentPreset();
    const g = (preset && preset.preferredGate) || {};
    return {
      slAtr: g.slAtr || 1.5,
      tpR: g.tpR || 2,
      maxBars: g.maxBars || 24,
      costFraction: costFraction,
      trainSize: trainSize,
      testSize: testSize,
      minLabel: g.minLabel || "PRELIMINARY",
    };
  }

  function updateStrategyHint() {
    const hint = el("strategyHint");
    if (!hint) return;
    const preset = currentPreset();
    if (!state.strategySet || !preset) {
      hint.textContent =
        "Obrigatório: escolhe Lucro rápido, Loss zero, tendência diária ou biblioteca. Stake fixa · NO TRADE se a porta falhar · sem martingale · paper.";
      return;
    }
    hint.textContent = preset.description;
  }

  function setPrePlayUI(result, statusText) {
    const status = el("prePlayStatus");
    const metrics = el("prePlayMetrics");
    if (!status) return;
    state.prePlayGate = result || null;
    state.prePlayOk = !!(result && result.allowed);
    status.classList.remove("open", "closed", "muted");
    if (!result) {
      status.classList.add("muted");
      status.textContent =
        statusText ||
        "Escolhe conta DEMO/REAL e uma estratégia (ex.: Lucro rápido ou Loss zero), depois Analisar. Sem martingale · stake fixa · paper.";
      if (metrics) metrics.hidden = true;
      setAnaliseUI(null, statusText);
      updateAnaliseButtons();
      return;
    }
    status.classList.add(result.allowed ? "open" : "closed");
    status.textContent =
      statusText ||
      (typeof NL.formatCandleGate === "function"
        ? NL.formatCandleGate(result)
        : result.allowed
          ? "PORTA ABERTA — " + result.reason
          : "NO TRADE — " + result.reason);
    if (metrics) {
      metrics.hidden = false;
      el("prePlayResult").textContent = result.allowed ? "PORTA ABERTA" : "NO TRADE";
      el("prePlayLabel").textContent = result.label || "—";
      el("prePlayOos").textContent = String(result.oosTrades != null ? result.oosTrades : "—");
      el("prePlayMeanR").textContent =
        result.meanR != null ? (result.meanR >= 0 ? "+" : "") + Number(result.meanR).toFixed(3) + "R" : "—";
      el("prePlayP").textContent =
        result.pValue != null ? Number(result.pValue).toFixed(4) : "—";
      el("prePlayStrat").textContent =
        result.strategy && result.strategy.name ? result.strategy.name : "—";
    }
    setAnaliseUI(result, statusText);
    updateAnaliseButtons();
  }

  /** Mirror Operar form → Análise selects (and vice-versa). */
  function syncFormToAnalise() {
    const aSym = el("analiseSymbol");
    const aStrat = el("analiseStrategy");
    const sym = el("symbolSelect");
    const strat = el("strategySet");
    if (aSym && sym && sym.options.length) {
      // Rebuild options if empty or count differs
      if (!aSym.options.length || aSym.options.length !== sym.options.length) {
        aSym.innerHTML = sym.innerHTML;
      }
      if (sym.value) aSym.value = sym.value;
    }
    if (aStrat && strat && strat.value) aStrat.value = strat.value;
  }

  function syncAnaliseToForm() {
    const aSym = el("analiseSymbol");
    const aStrat = el("analiseStrategy");
    const sym = el("symbolSelect");
    const strat = el("strategySet");
    if (aSym && sym && aSym.value) {
      sym.value = aSym.value;
      state.symbol = aSym.value;
    }
    if (aStrat && strat && aStrat.value) {
      strat.value = aStrat.value;
      state.strategySet = aStrat.value;
      updateStrategyHint();
    }
  }

  function setAnaliseUI(result, statusText) {
    const box = el("analiseResultBox");
    const verdict = el("analiseVerdict");
    const reason = el("analiseReason");
    const stratName = el("analiseStratName");
    const metrics = el("analiseMetrics");
    if (!box || !verdict || !reason) return;
    box.classList.remove("open", "closed");
    if (!result) {
      verdict.textContent = "—";
      if (stratName) stratName.textContent = "Estratégia: —";
      reason.textContent =
        statusText || "Escolhe símbolo e estratégia, depois Analisar.";
      if (metrics) metrics.hidden = true;
      return;
    }
    box.classList.add(result.allowed ? "open" : "closed");
    verdict.textContent = result.allowed ? "PODE OPERAR" : "NÃO OPERAR";
    const sName =
      result.strategy && result.strategy.name
        ? result.strategy.name
        : currentPreset()
          ? currentPreset().label
          : state.strategySet || "—";
    if (stratName) stratName.textContent = "Estratégia: " + sName;
    reason.textContent =
      statusText ||
      (result.reason
        ? result.reason
        : result.allowed
          ? "Porta aberta — podes ir a Operar e carregar PLAY."
          : "Porta fechada — não abras PLAY.");
    if (metrics) {
      metrics.hidden = false;
      const lab = el("analiseLabel");
      const oos = el("analiseOos");
      const meanR = el("analiseMeanR");
      const p = el("analiseP");
      if (lab) lab.textContent = result.label || "—";
      if (oos) oos.textContent = String(result.oosTrades != null ? result.oosTrades : "—");
      if (meanR)
        meanR.textContent =
          result.meanR != null
            ? (result.meanR >= 0 ? "+" : "") + Number(result.meanR).toFixed(3) + "R"
            : "—";
      if (p) p.textContent = result.pValue != null ? Number(result.pValue).toFixed(4) : "—";
    }
  }

  function updateAnaliseButtons() {
    const hasAccount = !!resolveSelectedAccount();
    const aStrat = el("analiseStrategy");
    const hasStrategy = !!(aStrat && aStrat.value) || !!(el("strategySet") && el("strategySet").value);
    const running = state.session && state.session.status === "RUNNING";
    const btnRun = el("btnAnaliseRun");
    const btnGo = el("btnAnaliseGoOperar");
    const btnPlay = el("btnAnalisePlay");
    if (btnRun) {
      btnRun.disabled = !hasAccount || !hasStrategy || running;
      btnRun.title = !hasAccount
        ? "Seleciona conta em Operar primeiro"
        : !hasStrategy
          ? "Escolhe estratégia"
          : "Analisar mercado simulado (paper) — sem ordens";
    }
    if (btnGo) {
      btnGo.disabled = !state.prePlayOk;
      btnGo.title = state.prePlayOk
        ? "Leva símbolo/estratégia para Operar — PLAY à mão"
        : "Só depois de Analisar com porta aberta";
    }
    if (btnPlay) {
      // PLAY from Análise only in PAPER — never starts REAL from this tab.
      const paperOk = state.prePlayOk && !isRealTradingMode() && !running && hasAccount && hasStrategy;
      btnPlay.disabled = !paperOk;
      btnPlay.title = isRealTradingMode()
        ? "Modo REAL activo — PLAY só no separador Operar"
        : paperOk
          ? "Iniciar sessão PAPER com esta análise"
          : "Só em PAPER após PODE OPERAR";
    }
  }

  /**
   * Análise tab: always uses public candle history (paper path).
   * Never places orders. Temporarily treats trading as PAPER for the fetch/gate only;
   * does not change the user's saved PAPER/REAL preference on Operar.
   */
  async function runAnaliseFromTab() {
    syncAnaliseToForm();
    const savedMode = state.tradingMode;
    state.tradingMode = "PAPER";
    const btnRun = el("btnAnaliseRun");
    if (btnRun) btnRun.disabled = true;
    setAnaliseUI(null, "A analisar mercado simulado (paper)…");
    try {
      const result = await runPrePlayAnalysis();
      // setPrePlayUI already refreshed Análise UI
      if (!result) {
        setAnaliseUI(null, el("prePlayStatus") ? el("prePlayStatus").textContent : "Análise incompleta.");
      }
      return result;
    } finally {
      state.tradingMode = savedMode;
      updateSourceUI();
      updateModeBanner();
      updateButtons();
      updateAnaliseButtons();
    }
  }

  function goOperarFromAnalise() {
    syncAnaliseToForm();
    renderChips();
    setActiveView("operar");
    updateNextStep();
  }

  async function playFromAnalise() {
    // Hard guard: never start REAL from Análise tab.
    if (isRealTradingMode()) {
      pushHistory("Análise só inicia PLAY em PAPER. Vai a Operar para REAL.", "stop");
      goOperarFromAnalise();
      return;
    }
    syncAnaliseToForm();
    setActiveView("operar");
    await startSession();
  }

  async function runPrePlayAnalysis() {
    resolveSelectedAccount();
    if (!state.selectedAccount) {
      setPrePlayUI(null, "Seleciona DEMO ou REAL antes de analisar.");
      updateButtons();
      return null;
    }
    readForm();
    if (!state.strategySet) {
      setPrePlayUI(null, "Escolhe uma estratégia (Lucro rápido / Loss zero / …) antes de analisar.");
      updateButtons();
      return null;
    }
    if (!state.symbol) {
      setPrePlayUI(null, "Sem símbolo selecionado.");
      return null;
    }
    const btnA = el("btnAnalyze");
    if (btnA) btnA.disabled = true;
    setPrePlayUI(null, "A carregar histórico para análise pré-PLAY de " + state.symbol + "…");
    try {
      const kind = NL.marketOf(state.symbol);
      const costFraction = kind ? NL.MARKETS[kind].assumedCostFraction : 0.001;
      const history = await fetchHistory(state.symbol, state.granularity, 3500);
      if (!history.length || history.length < 1500) {
        const closed = {
          allowed: false,
          reason: "histórico insuficiente (" + history.length + ")",
          label: "INSUFFICIENT",
          oosTrades: 0,
          meanR: 0,
          pValue: null,
          strategy: null,
        };
        setPrePlayUI(closed);
        return closed;
      }
      const n = history.length;
      const trainSize = Math.min(1000, Math.floor(n * 0.4));
      const testSize = Math.min(500, Math.floor(n * 0.2));
      const strategies = resolveStrategies();
      const gate = gateOptsForPreset(costFraction, trainSize, testSize);
      const result = NL.evaluateCandleGate(history, strategies, gate);
      setPrePlayUI(result);
      pushHistory(
        "Análise pré-PLAY · " +
          (currentPreset() ? currentPreset().label : state.strategySet) +
          " · " +
          (result.allowed ? "PORTA ABERTA" : "NO TRADE") +
          " · " +
          result.reason,
        result.allowed ? "open" : "stop",
      );
      return result;
    } catch (e) {
      setPrePlayUI(null, "Falha na análise: " + (e.message || String(e)));
      pushHistory("Falha análise pré-PLAY: " + (e.message || String(e)), "stop");
      return null;
    } finally {
      updateButtons();
    }
  }


  /** Qty from fixed stake / price (no martingale). */
  function qtyFromFixedStake(stake, price) {
    const s = Number(stake);
    const px = Number(price);
    if (!Number.isFinite(s) || s < NL.MIN_STAKE) throw new Error("Stake mínima é " + NL.MIN_STAKE);
    if (!Number.isFinite(px) || px <= 0) throw new Error("Preço inválido para qty");
    let qty = s / px;
    // Avoid scientific notation; trim trailing zeros but keep precision.
    const raw = qty.toFixed(8).replace(/\.?0+$/, "");
    if (!raw || Number(raw) <= 0) throw new Error("quantity resultante ≤ 0");
    return raw;
  }

  /**
   * Envia ordem REAL via proxy assinado.
   * Opens: exige evidence gate + session < 3h.
   * Closes (reduceOnly): pode flatten mesmo com porta fechada.
   * PAPER nunca chama isto (isRealTradingMode guard).
   */
  async function placeBybitOrder(side, quantity, opts) {
    opts = opts || {};
    const reduceOnly = opts.reduceOnly === true;
    if (!isRealTradingMode()) {
      throw new Error("Ordens reais só em modo REAL com chaves no servidor");
    }
    if (!reduceOnly && (!state.controller || !state.controller.isOpen)) {
      throw new Error("Porta de evidência fechada — NO TRADE");
    }
    const started = state.session && state.session.startedAtMs;
    const elapsed = typeof started === "number" ? Date.now() - started : 0;
    const body = {
      mode: "REAL",
      symbol: state.symbol,
      side: side,
      quantity: quantity,
      stake: state.stake,
      evidenceAllowed: true,
      sessionElapsedMs: elapsed,
    };
    if (reduceOnly) body.reduceOnly = true;
    const res = await fetch(BYBIT_ORDER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch (_e) {}
    if (!res.ok) {
      const why = (payload && (payload.error_description || payload.msg || payload.error || payload.retMsg)) || ("HTTP " + res.status);
      throw new Error("Ordem Bybit: " + why);
    }
    return payload || text;
  }

  /** Mirror paper open/close → Bybit MARKET when REAL. PAPER path never enters. */
  async function mirrorRealBybitEvent(e) {
    if (!isRealTradingMode()) return;
    if (e.type === "trade_opened") {
      const side = e.direction === 1 ? "BUY" : "SELL";
      const qty = qtyFromFixedStake(state.stake, e.entry);
      state.realOpenQty = qty;
      state.realOpenSide = side;
      try {
        const resp = await placeBybitOrder(side, qty);
        const oid = resp && (resp.result && resp.result.orderId || resp.orderId);
        pushHistory(
          "REAL Bybit MARKET " + side + " qty=" + qty + (oid ? (" orderId=" + oid) : ""),
          "open",
        );
      } catch (err) {
        pushHistory("REAL Bybit FALHA open: " + (err.message || String(err)), "stop");
      }
      return;
    }
    if (e.type === "trade_closed" && state.realOpenQty && state.realOpenSide) {
      const closeSide = state.realOpenSide === "BUY" ? "SELL" : "BUY";
      const qty = state.realOpenQty;
      try {
        const resp = await placeBybitOrder(closeSide, qty, { reduceOnly: true });
        const oid = resp && (resp.result && resp.result.orderId || resp.orderId);
        pushHistory(
          "REAL Bybit FECHA " + closeSide + " qty=" + qty + " (reduceOnly)" + (oid ? (" orderId=" + oid) : ""),
          e.r >= 0 ? "close-win" : "close-loss",
        );
      } catch (err) {
        pushHistory("REAL Bybit FALHA close: " + (err.message || String(err)), "stop");
      }
      state.realOpenQty = null;
      state.realOpenSide = null;
    }
  }

  async function startSession() {
    resolveSelectedAccount();
    if (!state.selectedAccount) {
      pushHistory("Seleciona uma conta DEMO ou REAL antes de PLAY.", "stop");
      updateButtons();
      return;
    }
    readForm();
    if (!state.strategySet) {
      pushHistory("Escolhe uma estratégia (Lucro rápido / Loss zero / …) antes de PLAY.", "stop");
      updateButtons();
      return;
    }
    if (!state.symbol) {
      pushHistory("Sem símbolo selecionado", "stop");
      return;
    }
    if (state.stake < NL.MIN_STAKE) {
      pushHistory("Stake mínima é " + NL.MIN_STAKE, "stop");
      return;
    }
    if (state.session && state.session.status === "PAUSED") {
      for (const e of state.session.start(Date.now())) {
        pushHistory(NL.formatCandleEvent(e), "open");
      }
      setStats(state.session.summary());
      updateButtons();
      return;
    }
    if (state.running) return;

    state.realOpenQty = null;
    state.realOpenSide = null;
    el("btnPlay").disabled = true;
    const ctx =
      accountKind(state.selectedAccount) +
      " " +
      state.selectedAccount.account_id +
      " | saldo Deriv " +
      accountBalanceText(state.selectedAccount);
    if (isBybitSource() && state.tradingMode === "REAL" && !(state.bybitKeysConfigured && state.bybitRealAvailable)) {
      pushHistory("REAL pediu-se mas chaves em falta — a forçar PAPER.", "stop");
      state.tradingMode = "PAPER";
      sessionStorage.setItem(TRADING_MODE_KEY, "PAPER");
      updateSourceUI();
    }
    pushHistory(
      (isRealTradingMode() ? "REAL · Bybit Linear USDT" : "PAPER / SIMULADO") +
        " · fonte " +
        sourceLabel() +
        " · contexto " +
        ctx,
      "open",
    );
    pushHistory("A carregar histórico de " + state.symbol + " (" + sourceLabel() + ")…", "");
    try {
      const kind = NL.marketOf(state.symbol);
      const costFraction = kind ? NL.MARKETS[kind].assumedCostFraction : 0.001;
      const history = await fetchHistory(state.symbol, state.granularity, 3500);
      const last = history[history.length - 1];
      if (!last || history.length < 1500) {
        pushHistory("Histórico insuficiente (" + history.length + " velas) — NO TRADE", "stop");
        setGateUI(
          { allowed: false, reason: "histórico insuficiente (" + history.length + ")", label: "INSUFFICIENT", oosTrades: 0, meanR: 0, pValue: null, strategy: null },
          false,
        );
        updateButtons();
        return;
      }
      if (kind) {
        const st = NL.marketStatus(kind, last.epoch, Date.now(), state.granularity);
        if (st === "closed") {
          pushHistory("Mercado fechado agora — NO TRADE", "stop");
          setGateUI(
            { allowed: false, reason: "mercado fechado", label: "INSUFFICIENT", oosTrades: 0, meanR: 0, pValue: null, strategy: null },
            false,
          );
          updateButtons();
          return;
        }
      }

      const n = history.length;
      const trainSize = Math.min(1000, Math.floor(n * 0.4));
      const testSize = Math.min(500, Math.floor(n * 0.2));
      const strategies = resolveStrategies();
      const gate = gateOptsForPreset(costFraction, trainSize, testSize);
      const slAtr = gate.slAtr;
      const tpR = gate.tpR;
      const maxBars = gate.maxBars;
      // Análise pré-PLAY explícita (mesmo critério da porta) antes de abrir a sessão paper.
      const pre = NL.evaluateCandleGate(history, strategies, gate);
      setPrePlayUI(pre);
      pushHistory(
        "Análise pré-PLAY · " +
          (currentPreset() ? currentPreset().label : state.strategySet) +
          " · " +
          (pre.allowed ? "PORTA ABERTA" : "NO TRADE") +
          " · paper / simulado",
        pre.allowed ? "open" : "stop",
      );
      state.controller = new NL.CandleGateController({
        strategies: strategies,
        gate: gate,
        revalidateEvery: state.revalidateEvery,
        maxBuffer: 3500,
        initial: history,
      });
      setGateUI(state.controller.result, state.controller.isOpen);

      state.session = new NL.CandlePaperSession({
        strategy: state.controller.asStrategy(),
        stake: state.stake,
        slAtr: slAtr,
        tpR: tpR,
        maxBars: maxBars,
        costFraction: costFraction,
        maxLoss: state.stake * 10,
        maxTrades: 50,
        maxDurationMs: Math.min(state.minutes, 180) * 60_000,
        maxConsecutiveLosses: 6,
        cooldownCandles: 0,
      });
      state.lastEpoch = last.epoch;
      state.running = true;
      state.historyLines = [];
      pushHistory("PAPER / SIMULADO · fonte " + sourceLabel() + " · contexto " + ctx, "open");
      for (const e of state.session.start(last.epoch * 1000)) {
        pushHistory(NL.formatCandleEvent(e), "open");
      }
      pushHistory(
        "Paper " +
          state.symbol +
          " | fonte " +
          sourceLabel() +
          " | " +
          history.length +
          " velas | stake fixa " +
          state.stake +
          " | máx " +
          state.minutes +
          " min | contexto " +
          accountKind(state.selectedAccount) +
          " | " +
          NL.formatCandleGate(state.controller.result) +
          (isBybitSource() ? (isRealTradingMode() ? " | REAL Bybit (gate+stake fixa)" : " | PAPER — sem ordens reais") : ""),
        "",
      );
      setStats(state.session.summary());
      schedulePoll();
    } catch (e) {
      pushHistory("Erro ao iniciar: " + (e.message || String(e)), "stop");
      state.running = false;
    }
    updateButtons();
  }

  function pauseSession() {
    if (!state.session || state.session.status !== "RUNNING") return;
    for (const e of state.session.pause(Date.now())) {
      pushHistory(NL.formatCandleEvent(e), "stop");
    }
    setStats(state.session.summary());
    updateButtons();
  }

  function stopSession() {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
    if (state.session && state.session.status !== "STOPPED") {
      for (const e of state.session.stop(Date.now())) {
        pushHistory(NL.formatCandleEvent(e), "stop");
      }
      pushHistory(NL.formatCandleSummary(state.session.summary()).split("\n")[0], "stop");
    }
    state.running = false;
    setStats(state.session ? state.session.summary() : null);
    updateButtons();
  }

  function schedulePoll() {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(pollOnce, 20_000);
  }

  async function pollOnce() {
    if (!state.running || !state.session) return;
    if (state.session.status === "STOPPED" && !state.session.hasOpenPosition) {
      state.running = false;
      updateButtons();
      return;
    }
    try {
      let fresh = [];
      if (isBybitSource()) {
        const candles = await fetchLatestBybitCandles(state.symbol, state.granularity, 10);
        fresh = candles
          .filter((c) => c.epoch > state.lastEpoch)
          .sort((a, b) => a.epoch - b.epoch);
      } else {
        const m = NL.parseCandlesMessage(
          await requestRaw({
            ticks_history: state.symbol,
            end: "latest",
            count: 10,
            style: "candles",
            granularity: state.granularity,
          }),
        );
        if (m.kind === "candles") {
          fresh = closedOnly(m.candles, state.granularity)
            .filter((c) => c.epoch > state.lastEpoch)
            .sort((a, b) => a.epoch - b.epoch);
        }
      }
      for (const c of fresh) {
        state.lastEpoch = c.epoch;
        const changed = state.controller.push(c);
        if (changed) setGateUI(state.controller.result, state.controller.isOpen);
        for (const e of state.session.onCandle(c)) {
          let cls = "";
          if (e.type === "trade_opened") cls = "open";
          else if (e.type === "trade_closed") cls = e.r >= 0 ? "close-win" : "close-loss";
          else if (e.type === "stopped" || e.type === "paused") cls = "stop";
          pushHistory(NL.formatCandleEvent(e), cls);
          if (e.type === "trade_opened" || e.type === "trade_closed") {
            recordJournalFromEvent(e);
          }
          // REAL: mirror paper opens/closes to signed Bybit MARKET. PAPER never hits /api/bybit-order.
          if (isRealTradingMode() && (e.type === "trade_opened" || e.type === "trade_closed")) {
            await mirrorRealBybitEvent(e);
          }
        }
        setGateUI(state.controller.result, state.controller.isOpen);
        setStats(state.session.summary());
      }
    } catch (e) {
      pushHistory("Aviso poll: " + (e.message || String(e)), "stop");
    }
    if (state.session.status === "STOPPED" && !state.session.hasOpenPosition) {
      state.running = false;
      updateButtons();
      return;
    }
    schedulePoll();
    updateButtons();
  }

  function disconnect() {
    stopSession();
    sessionStorage.removeItem("nl_access_token");
    sessionStorage.removeItem("nl_verifier");
    sessionStorage.removeItem("nl_state");
    sessionStorage.removeItem(ACCOUNT_KEY);
    location.href = "/";
  }

  function bind() {
    document.querySelectorAll(".view-tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const view = btn.getAttribute("data-view");
        if (view) setActiveView(view);
      });
    });
    const btnClearJournal = el("btnClearJournal");
    if (btnClearJournal) btnClearJournal.addEventListener("click", clearTradeJournal);
    const btnGateToggle = el("btnGateToggle");
    if (btnGateToggle) btnGateToggle.addEventListener("click", toggleGateDetails);

    document.querySelectorAll("#marketTabs .tab").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const nextPanel = btn.getAttribute("data-panel");
        if (!nextPanel || nextPanel === state.panel) return;
        if (state.running && sourceForPanel(nextPanel) !== state.dataSource) {
          pushHistory("Para a sessão paper antes de mudar de painel (a fonte segue o painel).", "stop");
          return;
        }
        const prevPanel = state.panel;
        document.querySelectorAll("#marketTabs .tab").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.panel = nextPanel;
        const ok = await applyPanelSource();
        if (ok === false) {
          state.panel = prevPanel;
          document.querySelectorAll("#marketTabs .tab").forEach(function (b) {
            b.classList.toggle("active", b.getAttribute("data-panel") === prevPanel);
          });
          updateSourceUI();
        }
      });
    });
    // Fonte não é escolhível à mão: Cripto=Bybit, Dígitos/Forex=Deriv.
    el("symbolSelect").addEventListener("change", () => {
      state.symbol = el("symbolSelect").value;
      renderChips();
    });
    el("strategySet").addEventListener("change", () => {
      state.strategySet = el("strategySet").value || "";
      state.prePlayOk = false;
      state.prePlayGate = null;
      updateStrategyHint();
      setPrePlayUI(null);
      const aStrat = el("analiseStrategy");
      if (aStrat && state.strategySet) aStrat.value = state.strategySet;
      updateButtons();
    });
    const analiseStrategy = el("analiseStrategy");
    if (analiseStrategy) {
      analiseStrategy.addEventListener("change", function () {
        state.strategySet = analiseStrategy.value || "";
        state.prePlayOk = false;
        state.prePlayGate = null;
        const main = el("strategySet");
        if (main && state.strategySet) main.value = state.strategySet;
        updateStrategyHint();
        setPrePlayUI(null);
        updateButtons();
      });
    }
    const analiseSymbol = el("analiseSymbol");
    if (analiseSymbol) {
      analiseSymbol.addEventListener("change", function () {
        state.symbol = analiseSymbol.value;
        const main = el("symbolSelect");
        if (main && state.symbol) main.value = state.symbol;
        state.prePlayOk = false;
        state.prePlayGate = null;
        setPrePlayUI(null);
        updateAnaliseButtons();
      });
    }
    const btnAnalyze = el("btnAnalyze");
    if (btnAnalyze) btnAnalyze.addEventListener("click", () => runPrePlayAnalysis());
    const btnAnaliseRun = el("btnAnaliseRun");
    if (btnAnaliseRun) btnAnaliseRun.addEventListener("click", () => runAnaliseFromTab());
    const btnAnaliseGo = el("btnAnaliseGoOperar");
    if (btnAnaliseGo) btnAnaliseGo.addEventListener("click", () => goOperarFromAnalise());
    const btnAnalisePlay = el("btnAnalisePlay");
    if (btnAnalisePlay) btnAnalisePlay.addEventListener("click", () => playFromAnalise());
    el("btnPlay").addEventListener("click", () => startSession());
    el("btnPause").addEventListener("click", () => pauseSession());
    el("btnStop").addEventListener("click", () => stopSession());
    el("btnDisconnect").addEventListener("click", () => disconnect());
    const modePaper = el("modePaper");
    const modeReal = el("modeReal");
    if (modePaper) modePaper.addEventListener("click", () => setTradingMode("PAPER"));
    if (modeReal) modeReal.addEventListener("click", () => setTradingMode("REAL"));
  }


  function renderMt5Panel() {
    var info = typeof NL.MT5_CRYPTO_STATUS === "object" ? NL.MT5_CRYPTO_STATUS : null;
    var sum = el("mt5Summary");
    var path = el("mt5OptionsPath");
    var need = el("mt5Needed");
    var ex = el("mt5Examples");
    var docs = el("mt5Docs");
    if (!sum || !info) return;
    sum.textContent = info.summary;
    if (path) path.textContent = info.optionsPath;
    if (need) {
      need.innerHTML = "";
      (info.needed || []).forEach(function (line) {
        var li = document.createElement("li");
        li.textContent = line;
        need.appendChild(li);
      });
    }
    if (ex) ex.textContent = (info.exampleMt5Codes || []).join(", ");
    if (docs) {
      docs.href = info.docsUrl || "https://developers.deriv.com/docs/mt5";
      docs.textContent = info.docsUrl || "Deriv MT5 API";
    }
  }

  async function boot() {
    bind();
    updateStrategyHint();
    updateSourceUI();
    setGateUI(null, false);
    setStats(null);
    renderHistory();
    renderTradeJournal();
    renderPerfas();
    updateModeBanner();
    updateNextStep();
    setActiveView("operar");
    const gm = el("gateMetrics");
    if (gm) gm.setAttribute("hidden", "");
    renderAccountContext();
    renderMt5Panel();
    updateButtons();
    await loadAccounts();
    try {
      await connectWs();
      await loadSymbols();
      // Painel inicial Cripto → Bybit Linear USDT (sem toggle Deriv neste contexto).
      state.panel = "crypto";
      state.dataSource = "bybit";
      sessionStorage.setItem(SOURCE_KEY, "bybit");
      var savedMode = sessionStorage.getItem(TRADING_MODE_KEY);
      state.tradingMode = savedMode === "REAL" ? "REAL" : "PAPER";
      await loadBybitTradingStatus();
      if (state.tradingMode === "REAL" && !(state.bybitKeysConfigured && state.bybitRealAvailable)) state.tradingMode = "PAPER";
      document.querySelectorAll("#marketTabs .tab").forEach(function (b) {
        b.classList.toggle("active", b.getAttribute("data-panel") === "crypto");
      });
      await loadBybitSymbols();
      state.symbol = (state.bybitSymbols[0] && state.bybitSymbols[0].symbol) || "BTCUSDT";
      renderSymbolSelect();
      renderChips();
      pushHistory(
        "Pronto · Cripto = Bybit Linear USDT (" +
          state.bybitSymbols.length +
          " perpetual). Modo " +
          state.tradingMode +
          (state.bybitRealAvailable && state.bybitKeysConfigured
            ? " · chaves servidor OK (REAL disponível)"
            : " · PAPER (sem chaves / REAL off)") +
          ". Dígitos/Forex = Deriv. Escolhe conta + Lucro rápido / Loss zero → Analisar → PLAY.",
        "",
      );
      updateSourceUI();
    } catch (e) {
      pushHistory("Falha WS/símbolos: " + (e.message || String(e)), "stop");
    }
  }

  boot();
})();
