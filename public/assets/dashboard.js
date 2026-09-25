/* NEVER LOSS dashboard — paper trading + porta de evidência. Sem compras reais. */
(function () {
  "use strict";

  const APP_ID = "34t836m5r3AO3f7xavbvL";
  const API_BASE = "https://api.derivws.com";
  const PUBLIC_WS = "wss://api.derivws.com/trading/v1/options/ws/public";
  const ACCOUNT_KEY = "nl_selected_account_id";

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
    symbol: "cryBTCUSD",
    granularity: 300,
    stake: 1,
    minutes: 60,
    minMultiplier: 100,
    strategySet: "all",
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
    const mode = el("modePill");
    mode.className = "pill mode";
    mode.textContent = "PAPER / SIMULADO";
    const acc = resolveSelectedAccount();
    if (!acc) {
      box.className = "account-context muted";
      box.textContent = "Seleciona DEMO ou REAL abaixo antes de PLAY. Sessão sempre paper / simulado.";
      return;
    }
    const kind = accountKind(acc);
    box.className = "account-context ready";
    box.innerHTML =
      "Contexto <b>" +
      escapeHtml(kind) +
      "</b> · conta <b>" +
      escapeHtml(acc.account_id || "?") +
      "</b> · saldo Deriv <span class=\"bal\">" +
      escapeHtml(accountBalanceText(acc)) +
      '</span> <span class="sim-tag">PAPER / SIMULADO</span><br>' +
      "<small>O saldo acima é real (REST). PnL da sessão é simulado — sem compras reais.</small>";
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
    el("statPnl").textContent = summary ? signed(summary.totalPnl) + " (sim)" : "—";
    el("statTrades").textContent = summary ? String(summary.closed) + " / " + summary.opened : "—";
    el("statDd").textContent = summary ? summary.maxDrawdown.toFixed(2) : "—";
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
    if (state.panel === "crypto") {
      // Todos os cry*USD (lista dinâmica); chips mostram aberto/fechado.
      if (typeof NL.listAllCryptoUsd === "function") return NL.listAllCryptoUsd(state.symbols);
      return NL.filterCryptoUsd(state.symbols);
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
        typeof NL.filterCryptoUsd === "function" && state.panel === "crypto"
          ? NL.filterCryptoUsd(list)
          : list;
      sel.value = (prefer[0] || list[0]).symbol;
    }
    state.symbol = sel.value;
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
        typeof NL.isOptionsFeedOnly === "function" &&
        NL.isOptionsFeedOnly(it.symbol, state.activeCrypto);
      btn.className =
        "chip " +
        (on ? "on" : "off") +
        (feedOnly ? " feed" : "") +
        (it.symbol === state.symbol ? " active" : "");
      btn.textContent = it.symbol;
      btn.title =
        (it.displayName || it.symbol) +
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
    el("panelHint").textContent =
      state.panel === "crypto"
        ? "Cripto Options: " +
          n +
          " pares cry*USD (" +
          activeN +
          " em active_symbols, " +
          feedN +
          " só no feed de velas). " +
          openN +
          " abertos. Paper + CandleGate. Tracejado = feed-only. MT5/CFD: ver secção abaixo (sem API)."
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
    state.strategySet = el("strategySet").value || "all";
  }

  function updateButtons() {
    const hasAccount = !!resolveSelectedAccount();
    const running = state.session && state.session.status === "RUNNING";
    const paused = state.session && state.session.status === "PAUSED";
    const stopped = !state.session || state.session.status === "STOPPED";
    el("btnPlay").disabled = !hasAccount || running;
    el("btnPlay").title = hasAccount
      ? "Iniciar sessão paper / simulado"
      : "Seleciona DEMO ou REAL primeiro";
    el("btnPause").disabled = !running;
    el("btnStop").disabled = stopped && !state.running;
    void paused;
  }


  function resolveStrategies() {
    const raw =
      state.strategySet === "daily" && typeof NL.dailyTrendStrategySet === "function"
        ? NL.dailyTrendStrategySet()
        : NL.strategyLibrary();
    return raw.map((s) =>
      NL.feasible(s, { slAtr: 1.5, maxStopFraction: 1 / state.minMultiplier }),
    );
  }

  function updateStrategyHint() {
    const hint = el("strategyHint");
    if (!hint) return;
    if (state.strategySet === "daily") {
      hint.textContent =
        "Conjunto: tendência diária / breakout-ATR. Ainda exige walk-forward, p-valor e NO TRADE se falhar. Sem martingale.";
    } else {
      const n = typeof NL.strategyLibrary === "function" ? NL.strategyLibrary().length : "?";
      hint.textContent =
        "Biblioteca completa (" +
        n +
        "): a porta escolhe a que passa no teste fora da amostra. Inclui tendência-diária breakout-ATR.";
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

    el("btnPlay").disabled = true;
    const ctx =
      accountKind(state.selectedAccount) +
      " " +
      state.selectedAccount.account_id +
      " | saldo Deriv " +
      accountBalanceText(state.selectedAccount);
    pushHistory("PAPER / SIMULADO · contexto " + ctx, "open");
    pushHistory("A carregar histórico de " + state.symbol + "…", "");
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
      const slAtr = 1.5;
      const tpR = 2;
      const maxBars = 24;
      const strategies = resolveStrategies();
      state.controller = new NL.CandleGateController({
        strategies: strategies,
        gate: {
          slAtr: slAtr,
          tpR: tpR,
          maxBars: maxBars,
          costFraction: costFraction,
          trainSize: trainSize,
          testSize: testSize,
          minLabel: "PRELIMINARY",
        },
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
      pushHistory("PAPER / SIMULADO · contexto " + ctx, "open");
      for (const e of state.session.start(last.epoch * 1000)) {
        pushHistory(NL.formatCandleEvent(e), "open");
      }
      pushHistory(
        "Paper " +
          state.symbol +
          " | " +
          history.length +
          " velas | stake fixa " +
          state.stake +
          " | máx " +
          state.minutes +
          " min | contexto " +
          accountKind(state.selectedAccount) +
          " | " +
          NL.formatCandleGate(state.controller.result),
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
        const fresh = closedOnly(m.candles, state.granularity)
          .filter((c) => c.epoch > state.lastEpoch)
          .sort((a, b) => a.epoch - b.epoch);
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
          }
          setGateUI(state.controller.result, state.controller.isOpen);
          setStats(state.session.summary());
        }
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
    document.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.panel = btn.getAttribute("data-panel");
        renderSymbolSelect();
        renderChips();
      });
    });
    el("symbolSelect").addEventListener("change", () => {
      state.symbol = el("symbolSelect").value;
      renderChips();
    });
    el("strategySet").addEventListener("change", () => {
      state.strategySet = el("strategySet").value || "all";
      updateStrategyHint();
    });
    el("btnPlay").addEventListener("click", () => startSession());
    el("btnPause").addEventListener("click", () => pauseSession());
    el("btnStop").addEventListener("click", () => stopSession());
    el("btnDisconnect").addEventListener("click", () => disconnect());
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
    setGateUI(null, false);
    setStats(null);
    renderHistory();
    renderAccountContext();
    renderMt5Panel();
    updateButtons();
    await loadAccounts();
    try {
      await connectWs();
      await loadSymbols();
      pushHistory(
        "Pronto. Escolhe DEMO ou REAL, depois PLAY. Paper trading apenas — sem compras reais.",
        "",
      );
    } catch (e) {
      pushHistory("Falha WS/símbolos: " + (e.message || String(e)), "stop");
    }
  }

  boot();
})();
