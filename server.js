const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // dataURL ya comprimido en el cliente
const MIN_PIECES = 4;
const MAX_PIECES = 500;
const SNAP_RATIO = 0.3; // distancia de encaje en el tablero relativa al tamaño de pieza
const JOIN_RATIO = 0.25; // distancia para conectar dos piezas entre sí
const EMPTY_ROOM_TTL = 30 * 60 * 1000; // borrar salas vacías tras 30 min

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: MAX_IMAGE_BYTES + 64 * 1024 });

const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4',
  '#f032e6', '#9a6324', '#469990', '#800000', '#808000', '#000075'];

/** @type {Map<string, Room>} */
const rooms = new Map();

function getRoom(name) {
  let room = rooms.get(name);
  if (!room) {
    room = { name, players: new Map(), puzzle: null, zTop: 0, scores: {}, cleanupTimer: null };
    rooms.set(name, room);
  }
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }
  return room;
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function randomEdge() {
  // sign: hacia dónde sale la pestaña; o: desplazamiento del centro; s: escala
  return { sign: Math.random() < 0.5 ? 1 : -1, o: +rand(-0.06, 0.06).toFixed(3), s: +rand(0.9, 1.1).toFixed(3) };
}

function createPuzzle(image, imgW, imgH, requested, uploadedBy) {
  const aspect = imgW / imgH;
  let cols = Math.max(2, Math.round(Math.sqrt(requested * aspect)));
  let rows = Math.max(2, Math.round(requested / cols));
  while (rows * cols > MAX_PIECES) {
    if (cols >= rows) cols--; else rows--;
  }

  // Tablero en unidades de "mundo"
  const boardW = Math.min(1000, 700 * aspect);
  const boardH = boardW / aspect;
  const pw = boardW / cols;
  const ph = boardH / rows;
  const marginX = Math.max(boardW * 0.6, pw * 3);
  const marginY = Math.max(boardH * 0.35, ph * 2);
  const worldW = boardW + marginX * 2;
  const worldH = boardH + marginY * 2;
  const boardX = marginX;
  const boardY = marginY;

  // Bordes internos: h[r][c] entre fila r-1 y r; v[r][c] entre columna c-1 y c
  const h = [];
  for (let r = 0; r <= rows; r++) {
    h.push([]);
    for (let c = 0; c < cols; c++) h[r].push(r === 0 || r === rows ? null : randomEdge());
  }
  const v = [];
  for (let r = 0; r < rows; r++) {
    v.push([]);
    for (let c = 0; c <= cols; c++) v[r].push(c === 0 || c === cols ? null : randomEdge());
  }

  // Esparcir piezas fuera del tablero
  const pieces = [];
  const pad = Math.max(pw, ph) * 0.35;
  let z = 0;
  const order = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) order.push([r, c]);
  order.sort(() => Math.random() - 0.5);
  for (const [r, c] of order) {
    let x, y, tries = 0;
    do {
      x = rand(pad, worldW - pw - pad);
      y = rand(pad, worldH - ph - pad);
      tries++;
    } while (tries < 200 &&
      x + pw + pad > boardX && x - pad < boardX + boardW &&
      y + ph + pad > boardY && y - pad < boardY + boardH);
    pieces.push({ id: r * cols + c, r, c, x: Math.round(x), y: Math.round(y), z: ++z, placed: false, heldBy: null, g: r * cols + c });
  }
  pieces.sort((a, b) => a.id - b.id);

  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    image, rows, cols, boardW, boardH, boardX, boardY, worldW, worldH,
    edges: { h, v }, pieces, uploadedBy,
    startedAt: null, finishedAt: null,
  };
}

function elapsedOf(puzzle) {
  if (!puzzle || !puzzle.startedAt) return 0;
  return (puzzle.finishedAt || Date.now()) - puzzle.startedAt;
}

function timerPayload(puzzle) {
  return {
    running: !!(puzzle && puzzle.startedAt && !puzzle.finishedAt),
    finished: !!(puzzle && puzzle.finishedAt),
    elapsed: elapsedOf(puzzle),
  };
}

function publicPlayers(room) {
  return [...room.players.entries()].map(([id, p]) => ({ id, nick: p.nick, color: p.color, x: p.x, y: p.y }));
}

function groupOf(pz, piece) {
  return pz.pieces.filter((p) => p.g === piece.g);
}

function pieceState(p) {
  return { id: p.id, x: p.x, y: p.y, g: p.g, placed: p.placed };
}

function releaseHeld(room, socketId) {
  if (!room.puzzle) return;
  const released = room.puzzle.pieces.filter((p) => p.heldBy === socketId);
  if (!released.length) return;
  for (const p of released) p.heldBy = null;
  io.to(room.name).emit('piecesDropped', { pieces: released.map(pieceState), joins: 0, placed: false });
}

function addPoints(room, nick, n) {
  room.scores[nick] = (room.scores[nick] || 0) + n;
  io.to(room.name).emit('scores', room.scores);
}

// Mueve un grupo completo desde la posición de una de sus piezas
function moveGroupTo(pz, piece, x, y) {
  x = Math.max(-200, Math.min(pz.worldW + 200, x));
  y = Math.max(-200, Math.min(pz.worldH + 200, y));
  const dx = x - piece.x, dy = y - piece.y;
  for (const p of groupOf(pz, piece)) {
    p.x += dx;
    p.y += dy;
  }
}

// Intenta conectar el grupo con piezas vecinas sueltas. Devuelve cuántos grupos se unieron.
function tryJoin(pz, piece) {
  const pw = pz.boardW / pz.cols;
  const ph = pz.boardH / pz.rows;
  const tol = Math.min(pw, ph) * JOIN_RATIO;
  let joins = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of groupOf(pz, piece)) {
      const neighbors = [[m.r - 1, m.c], [m.r + 1, m.c], [m.r, m.c - 1], [m.r, m.c + 1]];
      for (const [r, c] of neighbors) {
        if (r < 0 || c < 0 || r >= pz.rows || c >= pz.cols) continue;
        const n = pz.pieces[r * pz.cols + c];
        if (n.g === m.g || n.placed || n.heldBy) continue;
        const ex = m.x + (c - m.c) * pw;
        const ey = m.y + (r - m.r) * ph;
        if (Math.hypot(n.x - ex, n.y - ey) > tol) continue;
        // Alinear el grupo vecino y fusionarlo
        const dx = ex - n.x, dy = ey - n.y;
        const oldG = n.g;
        for (const p of pz.pieces) {
          if (p.g !== oldG) continue;
          p.x += dx;
          p.y += dy;
          p.g = m.g;
          p.z = m.z;
          p.heldBy = null;
        }
        joins++;
        changed = true;
      }
    }
  }
  return joins;
}

// Si el grupo está cerca de su lugar en el tablero, lo fija. Devuelve true si encajó.
function trySnapToBoard(pz, piece) {
  const pw = pz.boardW / pz.cols;
  const ph = pz.boardH / pz.rows;
  const tx = pz.boardX + piece.c * pw;
  const ty = pz.boardY + piece.r * ph;
  if (Math.hypot(piece.x - tx, piece.y - ty) >= Math.min(pw, ph) * SNAP_RATIO) return false;
  for (const p of groupOf(pz, piece)) {
    p.x = pz.boardX + p.c * pw;
    p.y = pz.boardY + p.r * ph;
    p.placed = true;
    p.z = 0;
  }
  return true;
}

function isNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

io.on('connection', (socket) => {
  let room = null;

  socket.on('join', ({ nick, room: roomName } = {}) => {
    if (room) return;
    nick = String(nick || '').trim().slice(0, 20) || 'Anónimo';
    roomName = String(roomName || 'principal').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30) || 'principal';
    room = getRoom(roomName);
    socket.join(roomName);

    const used = new Set([...room.players.values()].map((p) => p.color));
    const color = COLORS.find((c) => !used.has(c)) || COLORS[Math.floor(Math.random() * COLORS.length)];
    room.players.set(socket.id, { nick, color, x: null, y: null });

    socket.emit('welcome', {
      selfId: socket.id,
      room: roomName,
      players: publicPlayers(room),
      puzzle: room.puzzle,
      timer: timerPayload(room.puzzle),
      scores: room.scores,
    });
    socket.to(roomName).emit('playerJoined', { id: socket.id, nick, color });
  });

  socket.on('upload', ({ image, width, height, count } = {}) => {
    if (!room) return;
    if (typeof image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(image)) {
      return socket.emit('errorMsg', 'Formato de imagen no válido.');
    }
    if (image.length > MAX_IMAGE_BYTES) return socket.emit('errorMsg', 'La imagen es demasiado grande.');
    if (!isNum(width) || !isNum(height) || width < 50 || height < 50) {
      return socket.emit('errorMsg', 'Dimensiones de imagen no válidas.');
    }
    const n = Math.min(MAX_PIECES, Math.max(MIN_PIECES, Math.round(Number(count) || 48)));
    const player = room.players.get(socket.id);
    room.puzzle = createPuzzle(image, width, height, n, player ? player.nick : '?');
    room.scores = {};
    io.to(room.name).emit('newPuzzle', { puzzle: room.puzzle, timer: timerPayload(room.puzzle), scores: room.scores });
  });

  socket.on('grab', ({ id } = {}) => {
    const pz = room && room.puzzle;
    const piece = pz && pz.pieces[id];
    const group = piece ? groupOf(pz, piece) : [];
    if (!piece || piece.placed || group.some((p) => p.heldBy && p.heldBy !== socket.id)) {
      return socket.emit('grabDenied', { id });
    }
    // Solo un grupo por jugador
    for (const p of pz.pieces) if (p.heldBy === socket.id && p.g !== piece.g) p.heldBy = null;
    const z = ++room.zTop + pz.pieces.length;
    for (const p of group) {
      p.heldBy = socket.id;
      p.z = z;
    }

    if (!pz.startedAt) {
      pz.startedAt = Date.now();
      io.to(room.name).emit('timer', timerPayload(pz));
    }
    io.to(room.name).emit('pieceGrabbed', { id: piece.id, by: socket.id, z });
  });

  socket.on('move', ({ id, x, y } = {}) => {
    const pz = room && room.puzzle;
    const piece = pz && pz.pieces[id];
    if (!piece || piece.heldBy !== socket.id || !isNum(x) || !isNum(y)) return;
    moveGroupTo(pz, piece, x, y);
    socket.to(room.name).volatile.emit('pieceMoved', { id, x: piece.x, y: piece.y });
  });

  socket.on('drop', ({ id, x, y } = {}) => {
    const pz = room && room.puzzle;
    const piece = pz && pz.pieces[id];
    if (!piece || piece.heldBy !== socket.id) return;
    if (isNum(x) && isNum(y)) moveGroupTo(pz, piece, x, y);
    for (const p of groupOf(pz, piece)) p.heldBy = null;

    let joins = 0;
    let placed = trySnapToBoard(pz, piece);
    if (!placed) {
      joins = tryJoin(pz, piece);
      if (joins) placed = trySnapToBoard(pz, piece);
    }
    const points = joins + (placed ? 1 : 0);
    const player = room.players.get(socket.id);
    if (points && player) addPoints(room, player.nick, points);

    io.to(room.name).emit('piecesDropped', {
      pieces: groupOf(pz, piece).map(pieceState), joins, placed, by: socket.id, points,
    });

    if (placed && !pz.finishedAt && pz.pieces.every((p) => p.placed)) {
      pz.finishedAt = Date.now();
      io.to(room.name).emit('timer', timerPayload(pz));
      io.to(room.name).emit('completed', { elapsed: elapsedOf(pz), players: publicPlayers(room).map((p) => p.nick), scores: room.scores });
    }
  });

  socket.on('cursor', ({ x, y } = {}) => {
    if (!room || !isNum(x) || !isNum(y)) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    player.x = x;
    player.y = y;
    socket.to(room.name).volatile.emit('cursor', { id: socket.id, x, y });
  });

  socket.on('disconnect', () => {
    if (!room) return;
    releaseHeld(room, socket.id);
    room.players.delete(socket.id);
    io.to(room.name).emit('playerLeft', { id: socket.id });
    if (room.players.size === 0) {
      const r = room;
      r.cleanupTimer = setTimeout(() => {
        if (r.players.size === 0) rooms.delete(r.name);
      }, EMPTY_ROOM_TTL);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Puzzle cooperativo escuchando en http://localhost:${PORT}`);
});
