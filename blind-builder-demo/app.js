/**
 * Blind Builder demo: minimal realtime via BroadcastChannel (same browser).
 * Host is authoritative: it broadcasts roomState; players send intents.
 */

const COLORS = ["R", "G", "B", "Y", "E"]; // E = empty/eraser

const TARGETS = [
  // 5x5 grids; "E" = empty. K is unused in demo but reserved.
  {
    id: "T1",
    name: "Мост",
    grid: [
      ["E","E","B","E","E"],
      ["E","B","B","B","E"],
      ["B","B","Y","B","B"],
      ["E","B","B","B","E"],
      ["E","E","B","E","E"],
    ],
  },
  {
    id: "T2",
    name: "Диалог",
    grid: [
      ["E","G","G","E","E"],
      ["G","E","G","E","E"],
      ["G","G","G","E","E"],
      ["E","E","E","R","R"],
      ["E","E","E","R","E"],
    ],
  },
  {
    id: "T3",
    name: "Команда",
    grid: [
      ["Y","E","Y","E","Y"],
      ["E","Y","E","Y","E"],
      ["Y","E","Y","E","Y"],
      ["E","Y","E","Y","E"],
      ["Y","E","Y","E","Y"],
    ],
  },
];

function qs(name) {
  const u = new URL(window.location.href);
  return u.searchParams.get(name);
}

function rid() {
  return Math.random().toString(36).slice(2, 9).toUpperCase();
}

function nowMs() {
  return Date.now();
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function emptyGrid() {
  return Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => "E"));
}

function gridEquals(a, b) {
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      if (a[r][c] !== b[r][c]) return false;
    }
  }
  return true;
}

function scoreGrid(target, grid) {
  let ok = 0;
  let total = 25;
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      if (target[r][c] === grid[r][c]) ok++;
    }
  }
  return Math.round((ok / total) * 100);
}

function el(id) {
  return document.getElementById(id);
}

function setText(id, text) {
  const e = el(id);
  if (e) e.textContent = text;
}

function setHtml(id, html) {
  const e = el(id);
  if (e) e.innerHTML = html;
}

function show(id, on) {
  const e = el(id);
  if (!e) return;
  e.style.display = on ? "" : "none";
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatPhase(phase) {
  switch (phase) {
    case "lobby": return "Лобби";
    case "round": return "Раунд";
    case "reveal": return "Сравнение";
    case "reflect": return "Рефлексия";
    default: return phase;
  }
}

function roomChannel(room) {
  return new BroadcastChannel(`blind-builder-${room}`);
}

function initRoomState(room) {
  return {
    room,
    version: 1,
    phase: "lobby",
    createdAt: nowMs(),
    roundIndex: 0,
    roundStartedAt: null,
    roundDurationSec: 180,
    constraints: {
      bannedWords: [], // informational only in demo
      noCoordinates: false,
    },
    target: TARGETS[0],
    players: [],
    architectId: null,
    submissions: {}, // playerId -> { grid, submittedAt }
    reflection: {
      rules: [],
    },
  };
}

function persistRoomState(room, state) {
  try {
    localStorage.setItem(`bb_room_${room}`, JSON.stringify(state));
  } catch {}
}

function loadRoomState(room) {
  try {
    const raw = localStorage.getItem(`bb_room_${room}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * HOST
 */
function hostMain() {
  const defaultRoom = (qs("room") || "DEMO" + Math.floor(Math.random() * 90 + 10)).toUpperCase();
  const room = defaultRoom.replace(/[^A-Z0-9]/g, "").slice(0, 10) || "DEMO42";
  const ch = roomChannel(room);

  let state = loadRoomState(room) || initRoomState(room);
  let hostTick = null;

  function broadcastState() {
    state.version++;
    persistRoomState(room, state);
    ch.postMessage({ type: "state", state });
    render();
  }

  function ensureTick() {
    if (hostTick) return;
    hostTick = setInterval(() => {
      if (state.phase !== "round" || !state.roundStartedAt) return;
      const elapsed = Math.floor((nowMs() - state.roundStartedAt) / 1000);
      const left = Math.max(0, state.roundDurationSec - elapsed);
      setText("host_timer", left + "s");
      if (left <= 0) {
        // auto stop
        state.phase = "reveal";
        broadcastState();
      }
    }, 250);
  }

  function setPhase(next) {
    state.phase = next;
    if (next !== "round") state.roundStartedAt = null;
    broadcastState();
  }

  function addPlayer(p) {
    const exists = state.players.some(x => x.id === p.id);
    if (!exists) {
      state.players.push(p);
      broadcastState();
    }
  }

  function removePlayer(playerId) {
    state.players = state.players.filter(p => p.id !== playerId);
    delete state.submissions[playerId];
    if (state.architectId === playerId) state.architectId = null;
    broadcastState();
  }

  function assignArchitect() {
    if (state.players.length === 0) return;
    // pick first non-architect or rotate
    const idx = Math.max(0, state.players.findIndex(p => p.id === state.architectId));
    const next = state.players[(idx + 1) % state.players.length];
    state.architectId = next.id;
    broadcastState();
  }

  function resetRound() {
    state.submissions = {};
    broadcastState();
  }

  function startRound() {
    state.phase = "round";
    state.roundStartedAt = nowMs();
    state.submissions = {};
    broadcastState();
    ensureTick();
  }

  function nextRound() {
    state.roundIndex++;
    state.target = TARGETS[state.roundIndex % TARGETS.length];
    // add mild constraint on round 2+
    if (state.roundIndex % 2 === 1) {
      state.constraints = { bannedWords: ["лево", "право", "верх", "низ"], noCoordinates: true };
      state.roundDurationSec = 150;
    } else {
      state.constraints = { bannedWords: [], noCoordinates: false };
      state.roundDurationSec = 180;
    }
    state.phase = "lobby";
    state.roundStartedAt = null;
    state.submissions = {};
    broadcastState();
  }

  function addRule(ruleText) {
    const t = ruleText.trim();
    if (!t) return;
    state.reflection.rules.push(t);
    broadcastState();
  }

  function clearRules() {
    state.reflection.rules = [];
    broadcastState();
  }

  ch.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg || !msg.type) return;

    if (msg.type === "join") {
      addPlayer(msg.player);
      // host immediately sends state to new joiner
      ch.postMessage({ type: "state", state });
      return;
    }

    if (msg.type === "leave") {
      removePlayer(msg.playerId);
      return;
    }

    if (msg.type === "submit") {
      // accept submission
      state.submissions[msg.playerId] = { grid: msg.grid, submittedAt: nowMs() };
      broadcastState();
      return;
    }

    if (msg.type === "request_state") {
      ch.postMessage({ type: "state", state });
      return;
    }
  };

  // UI wiring
  setText("host_room", room);
  el("host_link_players").href = `./player.html?room=${encodeURIComponent(room)}`;
  el("host_link_players").textContent = `player.html?room=${room}`;

  el("btn_assign_architect").onclick = assignArchitect;
  el("btn_start_round").onclick = startRound;
  el("btn_show_reveal").onclick = () => setPhase("reveal");
  el("btn_show_reflect").onclick = () => setPhase("reflect");
  el("btn_back_lobby").onclick = () => setPhase("lobby");
  el("btn_reset_round").onclick = resetRound;
  el("btn_next_round").onclick = nextRound;

  el("btn_add_rule").onclick = () => {
    const v = el("rule_input").value;
    el("rule_input").value = "";
    addRule(v);
  };
  el("btn_clear_rules").onclick = clearRules;

  function renderPlayerList() {
    const lines = state.players.map(p => {
      const isArch = p.id === state.architectId;
      const submitted = !!state.submissions[p.id];
      const statusChip = submitted ? `<span class="chip ok">сдал</span>` : `<span class="chip warn">в процессе</span>`;
      const archChip = isArch ? `<span class="chip brand">архитектор</span>` : `<span class="chip">сборщик</span>`;
      return `<div class="row spread">
        <div><b>${escapeHtml(p.name)}</b> <span class="muted">#${escapeHtml(p.id)}</span></div>
        <div class="chips">${archChip}${state.phase === "round" ? statusChip : ""}</div>
      </div>`;
    });
    setHtml("host_players", lines.join("") || `<div class="muted">Пока никого нет. Откройте вкладку Player и подключитесь.</div>`);
  }

  function renderRevealBoards() {
    // pick best submission (highest score) among builders (architect may also submit; ok in demo)
    let best = null;
    for (const [pid, sub] of Object.entries(state.submissions)) {
      const sc = scoreGrid(state.target.grid, sub.grid);
      if (!best || sc > best.score) best = { pid, score: sc, grid: sub.grid };
    }
    const bestText = best
      ? `Лучший результат: <b>${best.score}%</b> (игрок #${escapeHtml(best.pid)})`
      : `Нет результатов — никто не нажал “Отправить”.`;
    setHtml("host_best_score", bestText);

    renderBoard("host_target_board", state.target.grid, false);
    renderBoard("host_best_board", best ? best.grid : emptyGrid(), false);
  }

  function renderRules() {
    const items = state.reflection.rules.map((r, i) => `<li><b>${i + 1}.</b> ${escapeHtml(r)}</li>`);
    setHtml("host_rules_list", items.join("") || `<li class="muted">Пока пусто. Добавьте 3–5 правил команды по итогам игры.</li>`);
  }

  function renderConstraints() {
    const chips = [];
    if (state.constraints.noCoordinates) chips.push(`<span class="chip warn">без координат</span>`);
    if (state.constraints.bannedWords.length) chips.push(`<span class="chip warn">запрет слов: ${escapeHtml(state.constraints.bannedWords.join(", "))}</span>`);
    setHtml("host_constraints", chips.join("") || `<span class="chip ok">без ограничений</span>`);
  }

  function render() {
    setText("host_phase", formatPhase(state.phase));
    setText("host_round", String(state.roundIndex + 1));
    setText("host_target_name", state.target.name);
    setText("host_timer", state.phase === "round" && state.roundStartedAt ? "…" : "—");
    renderConstraints();
    renderPlayerList();

    show("panel_lobby", state.phase === "lobby");
    show("panel_round", state.phase === "round");
    show("panel_reveal", state.phase === "reveal");
    show("panel_reflect", state.phase === "reflect");

    // buttons enablement
    el("btn_start_round").disabled = state.players.length < 2 || !state.architectId;
    el("btn_assign_architect").disabled = state.players.length === 0;
    el("btn_show_reveal").disabled = state.phase === "reveal";
    el("btn_show_reflect").disabled = state.phase === "reflect";

    if (state.phase === "reveal") renderRevealBoards();
    if (state.phase === "reflect") renderRules();

    // persist and keep players in sync
    persistRoomState(room, state);
    ch.postMessage({ type: "state", state });
    ensureTick();
  }

  // first render and state broadcast
  broadcastState();
}

/**
 * PLAYER
 */
function playerMain() {
  const room = (qs("room") || "").toUpperCase();
  const roomSafe = room.replace(/[^A-Z0-9]/g, "").slice(0, 10);

  if (!roomSafe) {
    setText("p_error", "Нужен room код. Откройте ссылку вида player.html?room=DEMO42");
    show("player_shell", false);
    show("p_error", true);
    return;
  }

  const ch = roomChannel(roomSafe);
  const playerId = rid();
  let state = null;
  let me = { id: playerId, name: null };
  let selectedColor = "B";
  let myGrid = emptyGrid();

  function send(msg) {
    ch.postMessage(msg);
  }

  function join(name) {
    me.name = name.trim().slice(0, 24) || "Игрок";
    send({ type: "join", player: me });
    send({ type: "request_state" });
  }

  function leave() {
    send({ type: "leave", playerId });
  }

  window.addEventListener("beforeunload", leave);

  ch.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg || msg.type !== "state") return;
    state = msg.state;
    render();
  };

  // UI: join
  setText("p_room", roomSafe);
  el("btn_join").onclick = () => {
    const name = el("p_name").value;
    if (!name.trim()) return;
    show("panel_join", false);
    show("panel_player", true);
    join(name);
  };

  // palette
  function renderPalette() {
    const nodes = COLORS.map(c => {
      const cls = c === selectedColor ? "swatch selected" : "swatch";
      const label = c === "E" ? "стереть" : c;
      return `<div class="${cls}" data-color="${c}" title="${label}"></div>`;
    }).join("");
    setHtml("p_palette", nodes);
    document.querySelectorAll("#p_palette .swatch").forEach(sw => {
      sw.onclick = () => {
        selectedColor = sw.getAttribute("data-color");
        renderPalette();
      };
    });
  }

  function setCell(r, c, color) {
    myGrid[r][c] = color;
    renderBoardForPlayer();
  }

  function renderBoardForPlayer() {
    // In builder mode we render into p_board; in architect mode we render into p_board_arch.
    if (document.getElementById("p_board")) {
      renderBoard("p_board", myGrid, true, (r, c) => setCell(r, c, selectedColor));
    }
    if (document.getElementById("p_board_arch")) {
      renderBoard("p_board_arch", myGrid, true, (r, c) => setCell(r, c, selectedColor));
    }
  }

  el("btn_submit").onclick = () => {
    if (!state || state.phase !== "round") return;
    send({ type: "submit", playerId, grid: myGrid });
    setText("p_submit_status", "Отправлено. Можно продолжать править и отправить ещё раз.");
  };

  el("btn_clear").onclick = () => {
    myGrid = emptyGrid();
    renderBoardForPlayer();
    setText("p_submit_status", "");
  };

  function renderRoleBlock() {
    const isArchitect = state && state.architectId === playerId;
    setHtml("p_role", isArchitect
      ? `<span class="chip brand">Вы — Архитектор</span> <span class="chip">видите образец</span>`
      : `<span class="chip">Вы — Сборщик</span> <span class="chip">образца нет</span>`
    );

    show("p_architect_view", isArchitect && !!state);
    show("p_builder_view", !isArchitect && !!state);

    if (isArchitect && state) {
      setText("p_target_name", state.target.name);
      renderBoard("p_target_board", state.target.grid, false);
      // Architect builds on their own board container.
      renderBoardForPlayer();
    }
  }

  function renderInstructions() {
    if (!state) return;
    const isArchitect = state.architectId === playerId;
    setText("p_phase", formatPhase(state.phase));
    setText("p_round", String(state.roundIndex + 1));

    const constraints = [];
    if (state.constraints.noCoordinates) constraints.push("не используем координаты (A1, 3‑я клетка справа и т.п.)");
    if (state.constraints.bannedWords?.length) constraints.push(`не используем слова: ${state.constraints.bannedWords.join(", ")}`);
    setHtml("p_constraints", constraints.length
      ? constraints.map(x => `<li>${escapeHtml(x)}</li>`).join("")
      : `<li class="muted">ограничений нет</li>`
    );

    // phase hints
    let hint = "";
    if (state.phase === "lobby") {
      hint = "Ждём ведущего. Когда начнётся раунд — появится таймер.";
    } else if (state.phase === "round") {
      hint = isArchitect
        ? "Ваша задача: дать понятные инструкции. Сборщики собирают на своих экранах."
        : "Соберите фигуру по инструкциям Архитектора и нажмите «Отправить результат».";
    } else if (state.phase === "reveal") {
      hint = "Ведущий показывает сравнение. Сфокусируйтесь на том, что помогало/мешало договариваться.";
    } else if (state.phase === "reflect") {
      hint = "Коротко сформулируйте 1 правило коммуникации, которое стоит забрать в работу.";
    }
    setText("p_hint", hint);
  }

  function render() {
    if (!state) return;
    setText("p_room_live", state.room);
    renderRoleBlock();
    renderInstructions();

    // show/hide board actions
    const inRound = state.phase === "round";
    el("btn_submit").disabled = !inRound;
    el("btn_clear").disabled = !inRound;
  }

  // initial UI
  renderPalette();
  renderBoardForPlayer();
  show("panel_player", false);
  show("panel_join", true);
  show("player_shell", true);
}

/**
 * Board renderer (reusable)
 */
function renderBoard(containerId, grid, clickable, onCellClick) {
  const container = el(containerId);
  if (!container) return;
  const cells = [];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const color = grid[r][c];
      cells.push(`<div class="cell" data-r="${r}" data-c="${c}" data-color="${color}"></div>`);
    }
  }
  container.innerHTML = `<div class="board">${cells.join("")}</div>`;
  if (clickable && typeof onCellClick === "function") {
    container.querySelectorAll(".cell").forEach(cell => {
      cell.onclick = () => {
        const r = Number(cell.getAttribute("data-r"));
        const c = Number(cell.getAttribute("data-c"));
        onCellClick(r, c);
      };
    });
  }
}

/**
 * Page router
 */
window.BB = {
  hostMain,
  playerMain,
};

