/* global window, document */

function qs(sel) {
  return document.querySelector(sel);
}
function el(id) {
  return document.getElementById(id);
}
function show(nodeOrId, on) {
  const n = typeof nodeOrId === "string" ? el(nodeOrId) : nodeOrId;
  if (!n) return;
  n.style.display = on ? "" : "none";
}
function setText(id, text) {
  const n = el(id);
  if (n) n.textContent = text;
}
function setHtml(id, html) {
  const n = el(id);
  if (n) n.innerHTML = html;
}
function escapeHtml(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function formatPhase(p) {
  switch (p) {
    case "lobby": return "Лобби";
    case "round": return "Раунд";
    case "reveal": return "Сравнение";
    case "reflect": return "Рефлексия";
    default: return p || "—";
  }
}
function emptyGrid() {
  return Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => "E"));
}
function toast(msg) {
  const t = el("toast");
  if (!t) return;
  t.textContent = msg;
  t.style.display = "block";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.style.display = "none"; }, 2400);
}
function wsUrl() {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

function renderBoard(container, grid, clickable, onCellClick) {
  if (!container) return;
  const cells = [];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const color = grid?.[r]?.[c] ?? "E";
      cells.push(`<div class="cell" data-r="${r}" data-c="${c}" data-color="${color}"></div>`);
    }
  }
  container.innerHTML = `<div class="board">${cells.join("")}</div>`;
  if (clickable) {
    container.querySelectorAll(".cell").forEach(cell => {
      cell.onclick = () => {
        const r = Number(cell.getAttribute("data-r"));
        const c = Number(cell.getAttribute("data-c"));
        onCellClick?.(r, c);
      };
    });
  }
}

function tickTimer(targetMs, labelId) {
  const n = el(labelId);
  if (!n) return () => {};
  const t = setInterval(() => {
    if (!targetMs) { n.textContent = "—"; return; }
    const left = Math.max(0, Math.ceil((targetMs - Date.now()) / 1000));
    n.textContent = left + "s";
  }, 250);
  return () => clearInterval(t);
}

/**
 * HOST PAGE
 */
function hostPage() {
  const socket = new WebSocket(wsUrl());

  let hostKey = null;
  let state = null;
  let stopTimer = () => {};

  function send(type, payload) {
    socket.send(JSON.stringify({ type, payload }));
  }

  function hostAction(action, extra = {}) {
    send("host_action", { hostKey, action, ...extra });
  }

  function render() {
    if (!state) return;
    setText("h_room", state.code);
    setText("h_phase", formatPhase(state.phase));
    setText("h_round", String((state.roundIndex ?? 0) + 1));
    setText("h_target_name", state.target?.name || "—");

    stopTimer();
    stopTimer = tickTimer(state.phase === "round" ? state.roundEndsAt : null, "h_timer");

    // constraints
    const chips = [];
    if (state.constraints?.noCoordinates) chips.push(`<span class="chip warn">без координат</span>`);
    if (state.constraints?.bannedWords?.length) chips.push(`<span class="chip warn">запрет: ${escapeHtml(state.constraints.bannedWords.join(", "))}</span>`);
    setHtml("h_constraints", chips.join("") || `<span class="chip ok">без ограничений</span>`);

    // players list
    const lines = (state.participants || []).map(p => {
      const roleChip = p.role === "host"
        ? `<span class="chip brand">host</span>`
        : p.isArchitect ? `<span class="chip brand">архитектор</span>` : `<span class="chip">сборщик</span>`;
      const subChip = state.phase === "round"
        ? (p.hasSubmitted ? `<span class="chip ok">сдал</span>` : `<span class="chip warn">в процессе</span>`)
        : "";
      return `<div class="row spread">
        <div><b>${escapeHtml(p.name)}</b> <span class="muted">#${escapeHtml(p.id)}</span></div>
        <div class="chips">${roleChip}${subChip}</div>
      </div>`;
    });
    setHtml("h_players", lines.join("") || `<div class="muted">Пока никого нет.</div>`);

    // reveal panel
    show("h_panel_reveal", state.phase === "reveal");
    if (state.phase === "reveal") {
      const best = state.scores?.best;
      const avg = state.scores?.avg;
      const count = state.scores?.count ?? 0;
      const scoreLine = count
        ? `Сдано: <b>${count}</b>. Лучший: <b>${best?.score ?? "—"}%</b>. Средний: <b>${avg ?? "—"}%</b>.`
        : "Пока нет отправленных результатов.";
      setHtml("h_scoreline", scoreLine);

      renderBoard(el("h_target_board"), state.target?.grid || emptyGrid(), false);
      renderBoard(el("h_best_board"), state.scores?.bestGrid || emptyGrid(), false);
    }

    // reflect panel
    show("h_panel_reflect", state.phase === "reflect");
    if (state.phase === "reflect") {
      const rules = state.reflection?.rules || [];
      setHtml("h_rules_list", rules.length
        ? rules.map((r, i) => `<li><b>${i + 1}.</b> ${escapeHtml(r)}</li>`).join("")
        : `<li class="muted">Пока пусто.</li>`
      );
    }

    // control enablement
    el("h_start_round").disabled = !(state.architectId);
    el("h_to_reveal").disabled = state.phase === "reveal";
    el("h_to_reflect").disabled = state.phase === "reflect";
  }

  function buildReportMarkdown() {
    if (!state) return "";
    const dt = new Date().toLocaleString();
    const participants = (state.participants || []).map(p => `- ${p.name}${p.isArchitect ? " (архитектор)" : ""}${p.role === "host" ? " (host)" : ""}`).join("\n");
    const rules = (state.reflection?.rules || []).map((r, i) => `${i + 1}. ${r}`).join("\n");
    const best = state.scores?.best?.score ?? "—";
    const avg = state.scores?.avg ?? "—";
    return [
      `# Отчёт по игре «Слепой сборщик»`,
      ``,
      `- Дата: ${dt}`,
      `- Комната: ${state.code}`,
      `- Раунд: ${(state.roundIndex ?? 0) + 1}`,
      `- Образец: ${state.target?.name ?? "—"}`,
      `- Лучший результат: ${best}%`,
      `- Средний результат: ${avg}%`,
      ``,
      `## Участники`,
      participants || "- —",
      ``,
      `## Правила команды (что забираем в работу)`,
      rules || "—",
      ``,
    ].join("\n");
  }

  // UI
  el("h_btn_create").onclick = () => {
    const name = el("h_name").value.trim() || "Host";
    send("create_room", { name });
  };
  el("h_copy_link").onclick = async () => {
    const a = el("h_join_link");
    if (!a?.href) return;
    await navigator.clipboard.writeText(a.href);
    toast("Ссылка скопирована");
  };
  el("h_assign_arch").onclick = () => hostAction("assign_architect");
  el("h_start_round").onclick = () => hostAction("start_round");
  el("h_to_reveal").onclick = () => hostAction("set_phase", { phase: "reveal" });
  el("h_to_reflect").onclick = () => hostAction("set_phase", { phase: "reflect" });
  el("h_next_round").onclick = () => hostAction("next_round");
  el("h_add_rule").onclick = () => {
    const v = el("h_rule_input").value.trim();
    el("h_rule_input").value = "";
    if (!v) return;
    hostAction("add_rule", { text: v });
  };
  el("h_clear_rules").onclick = () => hostAction("clear_rules");
  el("h_export_md").onclick = () => {
    const md = buildReportMarkdown();
    const box = el("h_md_preview");
    if (box) {
      box.textContent = md;
      show("h_md_preview", true);
    }
    toast("Отчёт сформирован ниже");
  };
  el("h_copy_md").onclick = async () => {
    const md = buildReportMarkdown();
    if (!md) return;
    await navigator.clipboard.writeText(md);
    toast("Отчёт скопирован");
  };

  socket.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "room_created") {
      hostKey = msg.payload.hostKey;
      const code = msg.payload.code;
      setText("h_room", code);
      // show controls
      show("h_create", false);
      show("h_controls", true);

      const link = `${window.location.origin}/room/${code}`;
      const a = el("h_join_link");
      a.href = link;
      a.textContent = link;

      toast(`Комната создана: ${code}`);
      return;
    }
    if (msg.type === "room_state") {
      state = msg.payload;
      render();
      return;
    }
    if (msg.type === "error") {
      toast(msg.payload?.message || "Ошибка");
    }
  };

  socket.onopen = () => toast("Соединение установлено");
  socket.onerror = () => toast("Ошибка соединения");
}

/**
 * ROOM / PLAYER PAGE
 */
function roomPage() {
  const socket = new WebSocket(wsUrl());

  const code = window.location.pathname.split("/").pop().toUpperCase();
  let participantId = null;
  let state = null;
  let myGrid = emptyGrid();
  let selected = "B";
  let stopTimer = () => {};

  function send(type, payload) {
    socket.send(JSON.stringify({ type, payload }));
  }

  function renderPalette() {
    const colors = ["R", "G", "B", "Y", "E"];
    const wrap = el("p_palette");
    if (!wrap) return;
    wrap.innerHTML = colors.map(c => {
      const cls = c === selected ? "swatch selected" : "swatch";
      const title = c === "E" ? "стереть" : c;
      return `<div class="${cls}" data-color="${c}" title="${title}"></div>`;
    }).join("");
    wrap.querySelectorAll(".swatch").forEach(sw => {
      sw.onclick = () => {
        selected = sw.getAttribute("data-color");
        renderPalette();
      };
    });
  }

  function renderBoards() {
    renderBoard(el("p_board"), myGrid, true, (r, c) => {
      myGrid[r][c] = selected;
      renderBoards();
    });
    renderBoard(el("p_board_arch"), myGrid, true, (r, c) => {
      myGrid[r][c] = selected;
      renderBoards();
    });
  }

  function renderRoom() {
    if (!state) return;
    setText("p_room_live", state.code);
    setText("p_room", state.code);
    setText("p_phase", formatPhase(state.phase));
    setText("p_round", String((state.roundIndex ?? 0) + 1));

    stopTimer();
    stopTimer = tickTimer(state.phase === "round" ? state.roundEndsAt : null, "p_timer");

    // role
    const isArchitect = participantId && state.architectId === participantId;
    setHtml("p_role", isArchitect
      ? `<span class="chip brand">Вы — Архитектор</span> <span class="chip">видите образец</span>`
      : `<span class="chip">Вы — Сборщик</span> <span class="chip">образца нет</span>`
    );
    show("p_architect_view", isArchitect);
    show("p_builder_view", !isArchitect);

    // constraints
    const constraints = [];
    if (state.constraints?.noCoordinates) constraints.push("не используем координаты (A1, «вверху слева», «третья справа» и т.п.)");
    if (state.constraints?.bannedWords?.length) constraints.push(`не используем слова: ${state.constraints.bannedWords.join(", ")}`);
    setHtml("p_constraints", constraints.length ? constraints.map(x => `<li>${escapeHtml(x)}</li>`).join("") : `<li class="muted">ограничений нет</li>`);

    // hints
    let hint = "";
    if (state.phase === "lobby") hint = "Ждём ведущего. Как начнётся раунд — появится таймер.";
    if (state.phase === "round") hint = isArchitect ? "Давайте инструкции. Сборщики собирают и отправляют результат." : "Соберите по инструкциям Архитектора и нажмите «Отправить результат».";
    if (state.phase === "reveal") hint = "Сравнение: сфокусируйтесь на том, что помогало/мешало договариваться.";
    if (state.phase === "reflect") hint = "Рефлексия: сформулируйте 1 правило коммуникации, которое стоит забрать в работу.";
    setText("p_hint", hint);

    // architect target
    if (isArchitect && state.target?.grid) {
      setText("p_target_name", state.target.name);
      renderBoard(el("p_target_board"), state.target.grid, false);
    }

    // score teaser
    const best = state.scores?.best?.score;
    const avg = state.scores?.avg;
    const count = state.scores?.count ?? 0;
    const teaser = count ? `Сдано: ${count}. Лучший: ${best ?? "—"}%. Средний: ${avg ?? "—"}%.` : "Пока никто не отправил результат.";
    setText("p_score_teaser", teaser);

    // buttons
    el("p_btn_submit").disabled = state.phase !== "round";
    el("p_btn_clear").disabled = state.phase !== "round";
  }

  // UI
  show("p_shell", true);
  renderPalette();
  renderBoards();
  setText("p_room", code);

  el("p_btn_join").onclick = () => {
    const name = el("p_name").value.trim();
    if (!name) return;
    send("join_room", { code, name });
  };
  el("p_btn_submit").onclick = () => {
    if (!state || state.phase !== "round") return;
    send("submit_grid", { grid: myGrid });
    setText("p_submit_status", "Отправлено. Можно продолжать править и отправить ещё раз.");
    toast("Результат отправлен");
  };
  el("p_btn_clear").onclick = () => {
    myGrid = emptyGrid();
    renderBoards();
    setText("p_submit_status", "");
  };

  socket.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "joined") {
      participantId = msg.payload.participantId;
      show("p_join_panel", false);
      show("p_info_panel", true);
      toast("Вы в игре");
      // request state
      send("ping_state", {});
      return;
    }
    if (msg.type === "room_state") {
      state = msg.payload;
      renderRoom();
      return;
    }
    if (msg.type === "error") {
      toast(msg.payload?.message || "Ошибка");
    }
  };

  socket.onopen = () => {
    toast("Соединение установлено");
    // keep in sync for spectators or if already joined
    setInterval(() => send("ping_state", {}), 2500);
  };
  socket.onerror = () => toast("Ошибка соединения");
}

window.BBPlatform = { hostPage, roomPage };

