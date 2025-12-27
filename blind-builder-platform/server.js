import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, "public");

/**
 * Game content
 * 5x5 grid; E = empty
 */
const TARGETS = [
  { id: "T1", name: "Мост", grid: [["E","E","B","E","E"],["E","B","B","B","E"],["B","B","Y","B","B"],["E","B","B","B","E"],["E","E","B","E","E"]] },
  { id: "T2", name: "Диалог", grid: [["E","G","G","E","E"],["G","E","G","E","E"],["G","G","G","E","E"],["E","E","E","R","R"],["E","E","E","R","E"]] },
  { id: "T3", name: "Команда", grid: [["Y","E","Y","E","Y"],["E","Y","E","Y","E"],["Y","E","Y","E","Y"],["E","Y","E","Y","E"],["Y","E","Y","E","Y"]] },
  { id: "T4", name: "Башня", grid: [["E","E","R","E","E"],["E","R","R","R","E"],["R","R","R","R","R"],["E","E","R","E","E"],["E","E","R","E","E"]] },
  { id: "T5", name: "Сигнал", grid: [["E","E","E","G","E"],["E","E","G","G","E"],["E","G","G","G","E"],["G","G","G","G","E"],["E","E","E","E","E"]] },
  { id: "T6", name: "Воронка", grid: [["B","E","E","E","B"],["E","B","E","B","E"],["E","E","Y","E","E"],["E","G","E","G","E"],["R","E","E","E","R"]] },
  { id: "T7", name: "Сетка", grid: [["G","E","G","E","G"],["E","E","E","E","E"],["G","E","Y","E","G"],["E","E","E","E","E"],["G","E","G","E","G"]] },
  { id: "T8", name: "Петля", grid: [["E","B","B","B","E"],["B","E","E","E","B"],["B","E","Y","E","B"],["B","E","E","E","B"],["E","B","B","B","E"]] },
];

function emptyGrid() {
  return Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => "E"));
}

function scoreGrid(targetGrid, grid) {
  let ok = 0;
  let total = 25;
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      if (targetGrid[r][c] === grid[r][c]) ok++;
    }
  }
  return Math.round((ok / total) * 100);
}

function diffStats(targetGrid, grid) {
  let wrongColor = 0;
  let wrongEmpty = 0;
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const t = targetGrid[r][c];
      const g = grid[r][c];
      if (t === g) continue;
      if (t === "E" && g !== "E") wrongEmpty++;
      else if (t !== "E" && g === "E") wrongEmpty++;
      else wrongColor++;
    }
  }
  return { wrongColor, wrongEmpty };
}

function randCode(len = 4) {
  // readable, no 0/O/1/I
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function nowMs() {
  return Date.now();
}

function mimeType(p) {
  if (p.endsWith(".html")) return "text/html; charset=utf-8";
  if (p.endsWith(".css")) return "text/css; charset=utf-8";
  if (p.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (p.endsWith(".json")) return "application/json; charset=utf-8";
  if (p.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

/**
 * Rooms (in-memory MVP)
 * For production: persist to DB + add auth + billing.
 */
const rooms = new Map(); // roomCode -> roomState
const sockets = new Map(); // ws -> { roomCode, participantId }

function createRoom() {
  let code = randCode(4);
  while (rooms.has(code)) code = randCode(4);

  const hostKey = crypto.randomBytes(16).toString("hex");
  const createdAt = nowMs();
  const state = {
    code,
    hostKey,
    createdAt,
    phase: "lobby", // lobby | round | reveal | reflect
    roundIndex: 0,
    roundEndsAt: null,
    roundDurationSec: 180,
    constraints: { bannedWords: [], noCoordinates: false },
    targetIndex: Math.floor(Math.random() * TARGETS.length),
    participants: new Map(), // id -> {id,name,role,joinedAt}
    architectId: null,
    submissions: new Map(), // participantId -> { roundIndex, grid, score, stats, submittedAt }
    reflection: { rules: [] },
  };

  rooms.set(code, state);
  return state;
}

function getRoom(code) {
  return rooms.get(code);
}

function publicRoomSnapshot(room, viewerId) {
  const viewer = viewerId ? room.participants.get(viewerId) : null;
  const isHost = viewer?.role === "host";
  const isArchitect = viewerId && room.architectId === viewerId;
  const canSeeTarget = room.phase !== "round" || isHost || isArchitect;

  // participants list (safe)
  const participants = Array.from(room.participants.values()).map(p => ({
    id: p.id,
    name: p.name,
    role: p.role,
    isArchitect: p.id === room.architectId,
    hasSubmitted: room.phase === "round" ? room.submissions.has(p.id) : false,
  }));

  // submissions summary
  const roundSubs = Array.from(room.submissions.entries())
    .filter(([, s]) => s.roundIndex === room.roundIndex)
    .map(([pid, s]) => ({ participantId: pid, score: s.score, stats: s.stats, submittedAt: s.submittedAt }))
    .sort((a, b) => b.score - a.score);

  const best = roundSubs[0] || null;
  const avg = roundSubs.length ? Math.round(roundSubs.reduce((acc, s) => acc + s.score, 0) / roundSubs.length) : null;

  // Host can see the best grid on reveal/reflect to facilitate discussion
  let bestGrid = null;
  if (isHost && (room.phase === "reveal" || room.phase === "reflect") && best?.participantId) {
    const full = room.submissions.get(best.participantId);
    if (full?.grid) bestGrid = full.grid;
  }

  return {
    code: room.code,
    phase: room.phase,
    roundIndex: room.roundIndex,
    roundEndsAt: room.roundEndsAt,
    roundDurationSec: room.roundDurationSec,
    constraints: room.constraints,
    target: canSeeTarget ? TARGETS[room.targetIndex] : { id: "HIDDEN", name: "Скрыто", grid: null },
    participants,
    architectId: room.architectId,
    scores: {
      count: roundSubs.length,
      best,
      bestGrid,
      avg,
      top: roundSubs.slice(0, 5),
    },
    reflection: room.reflection,
  };
}

function broadcastRoom(room) {
  for (const [ws, meta] of sockets.entries()) {
    if (meta.roomCode !== room.code) continue;
    if (ws.readyState !== ws.OPEN) continue;
    const snap = publicRoomSnapshot(room, meta.participantId);
    ws.send(JSON.stringify({ type: "room_state", payload: snap }));
  }
}

function setPhase(room, phase) {
  room.phase = phase;
  if (phase !== "round") room.roundEndsAt = null;
  broadcastRoom(room);
}

function applyRoundDefaults(room) {
  // round 0 => base, round 1 => constraints, then repeat pattern
  if (room.roundIndex % 2 === 0) {
    room.constraints = { bannedWords: [], noCoordinates: false };
    room.roundDurationSec = 180;
  } else {
    room.constraints = { bannedWords: ["лево", "право", "верх", "низ"], noCoordinates: true };
    room.roundDurationSec = 150;
  }
}

function startRound(room) {
  room.submissions.clear();
  room.phase = "round";
  applyRoundDefaults(room);
  room.roundEndsAt = nowMs() + room.roundDurationSec * 1000;
  broadcastRoom(room);
}

function nextRound(room) {
  room.roundIndex += 1;
  room.targetIndex = (room.targetIndex + 1) % TARGETS.length;
  room.submissions.clear();
  room.phase = "lobby";
  room.roundEndsAt = null;
  applyRoundDefaults(room);
  broadcastRoom(room);
}

// Timer loop
setInterval(() => {
  const t = nowMs();
  for (const room of rooms.values()) {
    if (room.phase === "round" && room.roundEndsAt && t >= room.roundEndsAt) {
      room.phase = "reveal";
      room.roundEndsAt = null;
      broadcastRoom(room);
    }
  }
}, 250);

/**
 * HTTP server (serves platform pages)
 */
const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url || "/", `http://${req.headers.host}`);
    const pathname = decodeURIComponent(u.pathname);

    // Simple routes
    if (pathname === "/") return sendFile(res, path.join(PUBLIC_DIR, "index.html"));
    if (pathname === "/games") return sendFile(res, path.join(PUBLIC_DIR, "games.html"));
    if (pathname === "/host") return sendFile(res, path.join(PUBLIC_DIR, "host.html"));
    if (pathname.startsWith("/room/")) return sendFile(res, path.join(PUBLIC_DIR, "room.html"));
    if (pathname === "/assets/styles.css") return sendFile(res, path.join(PUBLIC_DIR, "styles.css"));
    if (pathname === "/assets/client.js") return sendFile(res, path.join(PUBLIC_DIR, "client.js"));

    // Fallback: static file if exists (limited)
    const filePath = path.join(PUBLIC_DIR, pathname);
    if (filePath.startsWith(PUBLIC_DIR) && existsSync(filePath) && !filePath.endsWith(path.sep)) {
      return sendFile(res, filePath);
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Server error");
  }
});

function sendFile(res, filePath) {
  const buf = readFileSync(filePath);
  res.writeHead(200, { "content-type": mimeType(filePath) });
  res.end(buf);
}

/**
 * WebSocket: authoritative room state + per-viewer redaction.
 */
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg?.type) return;

    if (msg.type === "create_room") {
      const room = createRoom();
      // create host participant
      const hostId = randCode(6);
      room.participants.set(hostId, { id: hostId, name: msg.payload?.name?.slice(0, 24) || "Host", role: "host", joinedAt: nowMs() });
      sockets.set(ws, { roomCode: room.code, participantId: hostId });
      ws.send(JSON.stringify({ type: "room_created", payload: { code: room.code, hostKey: room.hostKey, participantId: hostId } }));
      broadcastRoom(room);
      return;
    }

    if (msg.type === "join_room") {
      const code = String(msg.payload?.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
      const room = getRoom(code);
      if (!room) {
        ws.send(JSON.stringify({ type: "error", payload: { message: "Комната не найдена" } }));
        return;
      }

      const name = String(msg.payload?.name || "Игрок").trim().slice(0, 24) || "Игрок";
      const participantId = randCode(6);
      room.participants.set(participantId, { id: participantId, name, role: "player", joinedAt: nowMs() });
      sockets.set(ws, { roomCode: room.code, participantId });

      ws.send(JSON.stringify({ type: "joined", payload: { participantId, code: room.code } }));
      broadcastRoom(room);
      return;
    }

    const meta = sockets.get(ws);
    if (!meta) {
      ws.send(JSON.stringify({ type: "error", payload: { message: "Не в комнате" } }));
      return;
    }

    const room = getRoom(meta.roomCode);
    if (!room) return;

    const me = room.participants.get(meta.participantId);
    if (!me) return;

    if (msg.type === "host_action") {
      const hostKey = String(msg.payload?.hostKey || "");
      if (me.role !== "host" || hostKey !== room.hostKey) {
        ws.send(JSON.stringify({ type: "error", payload: { message: "Нет прав ведущего" } }));
        return;
      }

      const action = msg.payload?.action;
      if (action === "assign_architect") {
        const ids = Array.from(room.participants.values()).filter(p => p.role === "player").map(p => p.id);
        if (!ids.length) return;
        const idx = Math.max(0, ids.findIndex(id => id === room.architectId));
        room.architectId = ids[(idx + 1) % ids.length];
        broadcastRoom(room);
        return;
      }

      if (action === "start_round") {
        if (!room.architectId) {
          ws.send(JSON.stringify({ type: "error", payload: { message: "Сначала назначьте архитектора" } }));
          return;
        }
        startRound(room);
        return;
      }

      if (action === "set_phase") {
        const phase = msg.payload?.phase;
        if (!["lobby", "round", "reveal", "reflect"].includes(phase)) return;
        if (phase === "round") startRound(room);
        else setPhase(room, phase);
        return;
      }

      if (action === "next_round") {
        nextRound(room);
        return;
      }

      if (action === "add_rule") {
        const text = String(msg.payload?.text || "").trim();
        if (!text) return;
        room.reflection.rules.push(text);
        broadcastRoom(room);
        return;
      }

      if (action === "clear_rules") {
        room.reflection.rules = [];
        broadcastRoom(room);
        return;
      }

      return;
    }

    if (msg.type === "submit_grid") {
      if (room.phase !== "round") return;
      const grid = msg.payload?.grid;
      if (!Array.isArray(grid) || grid.length !== 5) return;
      const score = scoreGrid(TARGETS[room.targetIndex].grid, grid);
      const stats = diffStats(TARGETS[room.targetIndex].grid, grid);
      room.submissions.set(meta.participantId, { roundIndex: room.roundIndex, grid, score, stats, submittedAt: nowMs() });
      broadcastRoom(room);
      return;
    }

    if (msg.type === "ping_state") {
      ws.send(JSON.stringify({ type: "room_state", payload: publicRoomSnapshot(room, meta.participantId) }));
      return;
    }
  });

  ws.on("close", () => {
    const meta = sockets.get(ws);
    sockets.delete(ws);
    if (!meta) return;
    const room = getRoom(meta.roomCode);
    if (!room) return;
    room.participants.delete(meta.participantId);
    room.submissions.delete(meta.participantId);
    if (room.architectId === meta.participantId) room.architectId = null;
    broadcastRoom(room);
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Blind Builder Platform listening on http://localhost:${PORT}`);
});

