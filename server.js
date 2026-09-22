const path = require('path');
const crypto = require('crypto');
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

const PASSWORD = process.env.PUZZLE_PASSWORD || '';
const MAX_FAILS = 5;
const FAIL_WINDOW = 10 * 60 * 1000;
const BLOCK_TIME = 15 * 60 * 1000;
const ROOM_NAME = 'principal';

if (!PASSWORD) {
  console.warn('⚠️  PUZZLE_PASSWORD no está configurada: se rechazarán todas las conexiones.');
}

const app = express();
app.use((_req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: MAX_IMAGE_BYTES + 64 * 1024 });

// ---------- Acceso con contraseña ----------
const failures = new Map(); // ip -> { count, first, blockedUntil }

function clientIp(socket) {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  // La última IP la agrega el proxy de Render; las anteriores las puede inventar el cliente
  return (typeof fwd === 'string' && fwd.split(',').pop().trim()) || socket.handshake.address;
}

function passwordOk(given) {
  if (!PASSWORD || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

io.use((socket, next) => {
  const ip = clientIp(socket);
  const now = Date.now();
  const f = failures.get(ip);
  if (f && f.blockedUntil > now) return next(new Error('blocked'));
  if (!PASSWORD) return next(new Error('no-password'));

  if (passwordOk(socket.handshake.auth && socket.handshake.auth.password)) {
    failures.delete(ip);
    return next();
  }
  const rec = f && now - f.first < FAIL_WINDOW ? f : { count: 0, first: now, blockedUntil: 0 };
  rec.count++;
  if (rec.count >= MAX_FAILS) rec.blockedUntil = now + BLOCK_TIME;
  failures.set(ip, rec);
  next(new Error(rec.blockedUntil ? 'blocked' : 'unauthorized'));
});

setInterval(() => {
  const now = Date.now();
  for (const [ip, f] of failures) {
    if (f.blockedUntil < now && now - f.first > FAIL_WINDOW) failures.delete(ip);
  }
}, 60 * 1000).unref();

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

// Reacomoda todos los grupos sueltos alrededor del tablero sin que se superpongan.
// Usa una grilla de celdas (con lugar para las pestañas) y ubica primero los grupos
// más grandes en las celdas libres más cercanas al tablero.
function arrangePieces(pz) {
  const pw = pz.boardW / pz.cols;
  const ph = pz.boardH / pz.rows;
  const tab = 0.36; // cuánto sobresale una pestaña, relativo a la pieza
  const uw = pw * (1 + tab * 2) + pw * 0.1;
  const uh = ph * (1 + tab * 2) + ph * 0.1;

  // Celda (i, j) -> esquina superior izquierda en el mundo, centrada en el tablero
  const cx = pz.boardX + pz.boardW / 2 - uw / 2;
  const cy = pz.boardY + pz.boardH / 2 - uh / 2;
  const cellX = (i) => cx + i * uw;
  const cellY = (j) => cy + j * uh;
  const margin = Math.max(pw, ph) * 0.25;
  const blocked = (i, j) =>
    cellX(i) < pz.boardX + pz.boardW + margin && cellX(i) + uw > pz.boardX - margin &&
    cellY(j) < pz.boardY + pz.boardH + margin && cellY(j) + uh > pz.boardY - margin;

  // Agrupar piezas sueltas
  const groups = new Map();
  for (const p of pz.pieces) {
    p.heldBy = null;
    if (p.placed) continue;
    if (!groups.has(p.g)) groups.set(p.g, []);
    groups.get(p.g).push(p);
  }
  const list = [...groups.values()].map((members) => {
    const minR = Math.min(...members.map((p) => p.r));
    const minC = Math.min(...members.map((p) => p.c));
    const spanR = Math.max(...members.map((p) => p.r)) - minR + 1;
    const spanC = Math.max(...members.map((p) => p.c)) - minC + 1;
    return {
      members, minR, minC,
      cw: Math.ceil((spanC * pw + pw * tab * 2) / uw),
      ch: Math.ceil((spanR * ph + ph * tab * 2) / uh),
    };
  }).sort((a, b) => b.cw * b.ch - a.cw * a.ch);

  // Candidatos ordenados por cercanía "elíptica" al tablero
  const radius = Math.ceil(Math.sqrt(pz.pieces.length)) + Math.max(pz.cols, pz.rows) + 4;
  const candidates = [];
  for (let j = -radius; j <= radius; j++) {
    for (let i = -radius; i <= radius; i++) {
      const dx = (cellX(i) + uw / 2 - (pz.boardX + pz.boardW / 2)) / pz.boardW;
      const dy = (cellY(j) + uh / 2 - (pz.boardY + pz.boardH / 2)) / pz.boardH;
      candidates.push({ i, j, d: dx * dx * 0.6 + dy * dy });
    }
  }
  candidates.sort((a, b) => a.d - b.d);

  const used = new Set();
  const key = (i, j) => i + ',' + j;
  const fits = (i0, j0, cw, ch) => {
    for (let j = j0; j < j0 + ch; j++) {
      for (let i = i0; i < i0 + cw; i++) {
        if (used.has(key(i, j)) || blocked(i, j)) return false;
      }
    }
    return true;
  };

  for (const g of list) {
    const spot = candidates.find(({ i, j }) => fits(i, j, g.cw, g.ch));
    if (!spot) continue; // no debería pasar
    for (let j = spot.j; j < spot.j + g.ch; j++) for (let i = spot.i; i < spot.i + g.cw; i++) used.add(key(i, j));
    const baseX = cellX(spot.i) + pw * tab;
    const baseY = cellY(spot.j) + ph * tab;
    for (const p of g.members) {
      p.x = baseX + (p.c - g.minC) * pw;
      p.y = baseY + (p.r - g.minR) * ph;
    }
  }

  // Ajustar el mundo para que todo quede con coordenadas positivas
  const pad = Math.max(pw, ph);
  let minX = pz.boardX, minY = pz.boardY;
  let maxX = pz.boardX + pz.boardW, maxY = pz.boardY + pz.boardH;
  for (const p of pz.pieces) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + pw); maxY = Math.max(maxY, p.y + ph);
  }
  const sx = pad - minX, sy = pad - minY;
  pz.boardX += sx;
  pz.boardY += sy;
  for (const p of pz.pieces) {
    p.x = Math.round((p.x + sx) * 100) / 100;
    p.y = Math.round((p.y + sy) * 100) / 100;
  }
  pz.worldW = maxX + sx + pad;
  pz.worldH = maxY + sy + pad;
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

  socket.on('join', ({ nick } = {}) => {
    if (room) return;
    nick = String(nick || '').trim().slice(0, 20) || 'Anónimo';
    const roomName = ROOM_NAME;
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

  // La imagen llega cifrada (AES-GCM en el navegador): el servidor solo guarda bytes opacos
  socket.on('upload', ({ iv, data, width, height, count } = {}) => {
    if (!room) return;
    if (!Buffer.isBuffer(iv) || iv.length !== 12 || !Buffer.isBuffer(data) || data.length < 32) {
      return socket.emit('errorMsg', 'Imagen no válida.');
    }
    if (data.length > MAX_IMAGE_BYTES) return socket.emit('errorMsg', 'La imagen es demasiado grande.');
    const image = { iv, data };
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

  socket.on('arrange', () => {
    const pz = room && room.puzzle;
    if (!pz || pz.finishedAt) return;
    arrangePieces(pz);
    const player = room.players.get(socket.id);
    io.to(room.name).emit('arranged', {
      by: player ? player.nick : '?',
      boardX: pz.boardX, boardY: pz.boardY, worldW: pz.worldW, worldH: pz.worldH,
      pieces: pz.pieces.map(pieceState),
    });
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
