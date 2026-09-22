(() => {
  'use strict';

  // ---------- Utilidades DOM ----------
  const $ = (id) => document.getElementById(id);
  const canvas = $('board');
  const ctx = canvas.getContext('2d');
  const hitCtx = document.createElement('canvas').getContext('2d');

  const params = new URLSearchParams(location.search);
  const roomName = (params.get('sala') || 'principal').toLowerCase();

  function toast(msg, ms = 2500) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), ms);
  }

  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
  }

  // ---------- Estado ----------
  let socket = null;
  let selfId = null;
  let nick = null;
  const players = new Map(); // id -> {nick,color,x,y,lastSeen}
  let scores = {};           // nick -> puntos

  let puzzle = null;   // datos del servidor
  let pieces = [];     // piezas con path/canvas locales
  let drawOrder = [];  // piezas ordenadas por z
  let orderDirty = true;
  let img = null;
  let pw = 0, ph = 0, pad = 0;
  let showGhost = false;

  const timer = { running: false, finished: false, elapsed: 0, base: 0 };
  const flashes = new Map(); // pieceId -> timestamp de encaje
  let confetti = [];

  // Cámara: pantalla = mundo * scale + (ox, oy)   (en px CSS)
  const cam = { scale: 1, ox: 0, oy: 0 };
  let dpr = window.devicePixelRatio || 1;

  // ---------- Geometría de las piezas ----------
  // Curva de la pestaña normalizada: x a lo largo del borde (0..1), y hacia afuera
  const TAB = [
    [0.30, 0.00], [0.44, 0.02], [0.41, 0.10],
    [0.30, 0.18], [0.36, 0.30], [0.50, 0.30],
    [0.64, 0.30], [0.70, 0.18], [0.59, 0.10],
    [0.56, 0.02], [0.70, 0.00], [1.00, 0.00],
  ];

  // Devuelve los puntos [P0, c1, c2, P1, c1, c2, P2 ...] del borde canónico A->B
  function edgePoints(edge, ax, ay, bx, by, ux, uy) {
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    const pts = [[ax, ay]];
    TAB.forEach(([t, y], i) => {
      const isEnd = i === TAB.length - 1;
      const tt = isEnd ? t : t + edge.o;
      const off = y * len * edge.s * edge.sign;
      pts.push([ax + dx * tt + ux * off, ay + dy * tt + uy * off]);
    });
    return pts;
  }

  function traceEdge(path, pts, reverse) {
    const p = reverse ? pts.slice().reverse() : pts;
    for (let i = 1; i < p.length; i += 3) {
      path.bezierCurveTo(p[i][0], p[i][1], p[i + 1][0], p[i + 1][1], p[i + 2][0], p[i + 2][1]);
    }
  }

  function piecePath(r, c) {
    const { h, v } = puzzle.edges;
    const path = new Path2D();
    path.moveTo(0, 0);
    // arriba (izq -> der)
    if (r === 0) path.lineTo(pw, 0);
    else traceEdge(path, edgePoints(h[r][c], 0, 0, pw, 0, 0, 1), false);
    // derecha (arriba -> abajo)
    if (c === puzzle.cols - 1) path.lineTo(pw, ph);
    else traceEdge(path, edgePoints(v[r][c + 1], pw, 0, pw, ph, 1, 0), false);
    // abajo (der -> izq)
    if (r === puzzle.rows - 1) path.lineTo(0, ph);
    else traceEdge(path, edgePoints(h[r + 1][c], 0, ph, pw, ph, 0, 1), true);
    // izquierda (abajo -> arriba)
    if (c !== 0) traceEdge(path, edgePoints(v[r][c], 0, 0, 0, ph, 1, 0), true);
    path.closePath();
    return path;
  }

  function renderPieceCanvas(piece) {
    const res = Math.max(1, Math.min(2.5, (img.naturalWidth / puzzle.boardW) * 1.2));
    const w = Math.ceil((pw + pad * 2) * res);
    const hgt = Math.ceil((ph + pad * 2) * res);
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = hgt;
    const g = cv.getContext('2d');
    g.scale(res, res);
    g.translate(pad, pad);

    g.save();
    g.clip(piece.path);
    g.drawImage(img, -piece.c * pw, -piece.r * ph, puzzle.boardW, puzzle.boardH);
    // Relieve: luz arriba-izquierda, sombra abajo-derecha
    g.lineWidth = 2.5 / res + 1;
    g.translate(0.8, 0.8);
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.stroke(piece.path);
    g.translate(-1.6, -1.6);
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.stroke(piece.path);
    g.restore();

    g.lineWidth = 0.8;
    g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.stroke(piece.path);
    return cv;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = src;
    });
  }

  let buildToken = 0;
  async function setPuzzle(pz, timerData) {
    const token = ++buildToken;
    if (timerData) setTimer(timerData);
    if (!pz) {
      puzzle = null;
      pieces = [];
      drawOrder = [];
      img = null;
      updateHud();
      return;
    }
    const sameImage = puzzle && puzzle.id === pz.id && img;
    const newImg = sameImage ? img : await loadImage(pz.image);
    if (token !== buildToken) return;

    const oldPieces = sameImage ? pieces : null;
    puzzle = pz;
    img = newImg;
    pw = pz.boardW / pz.cols;
    ph = pz.boardH / pz.rows;
    pad = Math.max(pw, ph) * 0.36;

    pieces = pz.pieces.map((sp, i) => {
      const reuse = oldPieces && oldPieces[i];
      const p = { ...sp };
      p.path = reuse ? reuse.path : piecePath(sp.r, sp.c);
      p.canvas = reuse ? reuse.canvas : null;
      return p;
    });
    if (!sameImage) for (const p of pieces) p.canvas = renderPieceCanvas(p);

    orderDirty = true;
    flashes.clear();
    if (!sameImage) fitView();
    updateHud();
  }

  function groupMembers(piece) {
    return pieces.filter((p) => p.g === piece.g);
  }

  function moveGroup(piece, x, y) {
    const dx = x - piece.x, dy = y - piece.y;
    for (const p of groupMembers(piece)) {
      p.x += dx;
      p.y += dy;
    }
  }

  // ---------- Cámara ----------
  function topbarHeight() {
    const tb = $('topbar');
    return tb.classList.contains('hidden') ? 0 : tb.offsetHeight;
  }

  function fitView() {
    if (!puzzle) return;
    const top = topbarHeight();
    const vw = window.innerWidth;
    const vh = window.innerHeight - top;
    const s = Math.min(vw / puzzle.worldW, vh / puzzle.worldH) * 0.97;
    cam.scale = s;
    cam.ox = (vw - puzzle.worldW * s) / 2;
    cam.oy = top + (vh - puzzle.worldH * s) / 2;
  }

  function toWorld(sx, sy) {
    return [(sx - cam.ox) / cam.scale, (sy - cam.oy) / cam.scale];
  }

  function zoomAt(sx, sy, factor) {
    const ns = Math.max(0.1, Math.min(8, cam.scale * factor));
    const [wx, wy] = toWorld(sx, sy);
    cam.scale = ns;
    cam.ox = sx - wx * ns;
    cam.oy = sy - wy * ns;
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    fitView();
  }
  window.addEventListener('resize', resize);

  // ---------- Render ----------
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function render() {
    requestAnimationFrame(render);
    const now = performance.now();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1d2330';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (puzzle && img) {
      ctx.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.ox, dpr * cam.oy);

      // Mesa
      ctx.fillStyle = '#262d3d';
      roundRect(ctx, 0, 0, puzzle.worldW, puzzle.worldH, 24);
      ctx.fill();

      // Sombra/silueta del puzzle
      const { boardX: bx, boardY: by, boardW: bw, boardH: bh } = puzzle;
      ctx.fillStyle = '#141925';
      ctx.fillRect(bx, by, bw, bh);
      if (showGhost) {
        ctx.globalAlpha = 0.22;
        ctx.drawImage(img, bx, by, bw, bh);
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 2 / cam.scale;
      ctx.strokeRect(bx, by, bw, bh);

      if (orderDirty) {
        drawOrder = pieces.slice().sort((a, b) => a.z - b.z);
        orderDirty = false;
      }

      for (const p of drawOrder) {
        const x = p.x - pad, y = p.y - pad, w = pw + pad * 2, h = ph + pad * 2;
        if (p.heldBy) {
          ctx.save();
          ctx.shadowColor = 'rgba(0,0,0,0.55)';
          ctx.shadowBlur = 18 * cam.scale * dpr;
          ctx.shadowOffsetY = 6 * cam.scale * dpr;
          ctx.drawImage(p.canvas, x, y, w, h);
          ctx.restore();
          if (p.heldBy !== selfId) {
            const pl = players.get(p.heldBy);
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.strokeStyle = pl ? pl.color : '#fff';
            ctx.lineWidth = 3 / cam.scale;
            ctx.stroke(p.path);
            ctx.restore();
          }
        } else {
          ctx.drawImage(p.canvas, x, y, w, h);
        }

        const f = flashes.get(p.id);
        if (f !== undefined) {
          const t = (now - f) / 600;
          if (t >= 1) flashes.delete(p.id);
          else {
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.globalAlpha = 1 - t;
            ctx.strokeStyle = '#fff6a0';
            ctx.lineWidth = (4 + t * 6) / cam.scale;
            ctx.stroke(p.path);
            ctx.restore();
          }
        }
      }

      // Manitos de los demás (tamaño fijo en pantalla)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const nowMs = Date.now();
      for (const [id, pl] of players) {
        if (id === selfId || pl.x == null) continue;
        if (nowMs - (pl.lastSeen || 0) > 15000) continue; // inactivo
        const sx = pl.x * cam.scale + cam.ox;
        const sy = pl.y * cam.scale + cam.oy;
        const holding = pieces.some((p) => p.heldBy === id);
        ctx.font = '26px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(holding ? '✊' : '✋', sx, sy);
        ctx.font = 'bold 12px system-ui, sans-serif';
        const tw = ctx.measureText(pl.nick).width;
        ctx.fillStyle = pl.color;
        roundRect(ctx, sx + 12, sy + 10, tw + 12, 18, 9);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'left';
        ctx.fillText(pl.nick, sx + 18, sy + 19.5);
      }
    }

    drawConfetti();
    drawTimer();
  }

  function drawConfetti() {
    if (!confetti.length) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const H = window.innerHeight;
    confetti = confetti.filter((c) => c.y < H + 20);
    for (const c of confetti) {
      c.vy += 0.12;
      c.x += c.vx;
      c.y += c.vy;
      c.rot += c.vr;
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      ctx.fillStyle = c.color;
      ctx.fillRect(-4, -2, 8, 4);
      ctx.restore();
    }
  }

  function launchConfetti() {
    const W = window.innerWidth;
    const colors = ['#ff5c5c', '#ffd35c', '#5cff8a', '#5cc8ff', '#c55cff', '#ff9d5c'];
    for (let i = 0; i < 220; i++) {
      confetti.push({
        x: Math.random() * W, y: -20 - Math.random() * 300,
        vx: (Math.random() - 0.5) * 3, vy: Math.random() * 2,
        rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
        color: colors[i % colors.length],
      });
    }
  }

  // ---------- Timer / HUD ----------
  function setTimer(t) {
    timer.running = t.running;
    timer.finished = t.finished;
    timer.elapsed = t.elapsed;
    timer.base = Date.now();
  }

  function currentElapsed() {
    return timer.elapsed + (timer.running ? Date.now() - timer.base : 0);
  }

  function drawTimer() {
    const el = $('timer');
    const txt = fmtTime(currentElapsed());
    if (el.textContent !== txt) el.textContent = txt;
    el.classList.toggle('running', timer.running);
    el.classList.toggle('finished', timer.finished);
  }

  function updateHud() {
    $('empty').classList.toggle('hidden', !!puzzle || !selfId);
    if (puzzle) {
      const placed = pieces.filter((p) => p.placed).length;
      $('progress').textContent = `${placed} / ${pieces.length} piezas`;
    } else {
      $('progress').textContent = '';
    }
  }

  function renderPlayers() {
    const box = $('players');
    box.innerHTML = '';
    for (const [id, pl] of players) {
      const chip = document.createElement('span');
      chip.className = 'player-chip' + (id === selfId ? ' me' : '');
      chip.style.background = pl.color;
      chip.textContent = `${pl.nick}${id === selfId ? ' (vos)' : ''} · ${scores[pl.nick] || 0}`;
      box.appendChild(chip);
    }
  }

  // ---------- Sonido ----------
  let audioCtx = null;
  function clickSound() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(900, audioCtx.currentTime);
      o.frequency.exponentialRampToValueAtTime(300, audioCtx.currentTime + 0.08);
      g.gain.setValueAtTime(0.15, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.1);
      o.connect(g).connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + 0.1);
    } catch (_) { /* sin audio */ }
  }

  // ---------- Entrada (mouse / touch) ----------
  const pointers = new Map(); // pointerId -> {x,y}
  let drag = null;   // {id, offX, offY, pointerId}
  let pan = null;    // {pointerId, sx, sy, ox, oy}
  let pinch = null;  // {dist, midX, midY}
  let lastMoveSent = 0;
  let lastCursorSent = 0;

  function hitTest(wx, wy) {
    for (let i = drawOrder.length - 1; i >= 0; i--) {
      const p = drawOrder[i];
      if (p.placed) continue;
      const lx = wx - p.x, ly = wy - p.y;
      if (lx < -pad || ly < -pad || lx > pw + pad || ly > ph + pad) continue;
      if (hitCtx.isPointInPath(p.path, lx, ly)) return p;
    }
    return null;
  }

  function sendCursor(wx, wy, force) {
    const now = performance.now();
    if (!socket || (!force && now - lastCursorSent < 50)) return;
    lastCursorSent = now;
    socket.emit('cursor', { x: Math.round(wx), y: Math.round(wy) });
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2) {
      // Empieza pinch: cancelar pan (el drag de pieza se mantiene)
      pan = null;
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
      return;
    }
    if (pointers.size > 2) return;

    const [wx, wy] = toWorld(e.clientX, e.clientY);
    const p = puzzle && !timer.finished ? hitTest(wx, wy) : null;
    const group = p ? groupMembers(p) : [];
    if (p && group.every((m) => !m.heldBy || m.heldBy === selfId)) {
      drag = { id: p.id, offX: wx - p.x, offY: wy - p.y, pointerId: e.pointerId };
      for (const m of group) {
        m.heldBy = selfId;
        m.z = Number.MAX_SAFE_INTEGER; // arriba hasta que el servidor confirme
      }
      orderDirty = true;
      socket.emit('grab', { id: p.id });
      canvas.classList.add('dragging');
    } else {
      pan = { pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, ox: cam.ox, oy: cam.oy };
      canvas.classList.add('dragging');
    }
    sendCursor(wx, wy, true);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.dist > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, dist / pinch.dist);
      pinch.dist = dist;
      return;
    }

    const [wx, wy] = toWorld(e.clientX, e.clientY);
    if (drag && drag.pointerId === e.pointerId) {
      const p = pieces[drag.id];
      moveGroup(p, wx - drag.offX, wy - drag.offY);
      const now = performance.now();
      if (now - lastMoveSent > 33) {
        lastMoveSent = now;
        socket.emit('move', { id: p.id, x: p.x, y: p.y });
      }
    } else if (pan && pan.pointerId === e.pointerId) {
      cam.ox = pan.ox + (e.clientX - pan.sx);
      cam.oy = pan.oy + (e.clientY - pan.sy);
    }
    if (puzzle) sendCursor(wx, wy, false);
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag && drag.pointerId === e.pointerId) {
      const p = pieces[drag.id];
      if (p) socket.emit('drop', { id: p.id, x: p.x, y: p.y });
      drag = null;
    }
    if (pan && pan.pointerId === e.pointerId) pan = null;
    if (!drag && !pan) canvas.classList.remove('dragging');
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  // ---------- Red ----------
  function connect() {
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      socket.emit('join', { nick, room: roomName });
    });

    socket.on('disconnect', () => {
      toast('Conexión perdida, reconectando…', 4000);
      drag = null;
    });

    socket.on('welcome', (data) => {
      selfId = data.selfId;
      players.clear();
      for (const p of data.players) players.set(p.id, { ...p, lastSeen: Date.now() });
      renderPlayers();
      scores = data.scores || {};
      renderPlayers();
      setPuzzle(data.puzzle, data.timer);
      updateHud();
    });

    socket.on('scores', (s) => {
      scores = s || {};
      renderPlayers();
    });

    socket.on('playerJoined', (p) => {
      players.set(p.id, { ...p, x: null, y: null, lastSeen: Date.now() });
      renderPlayers();
      toast(`${p.nick} se unió`);
    });

    socket.on('playerLeft', ({ id }) => {
      const p = players.get(id);
      players.delete(id);
      renderPlayers();
      if (p) toast(`${p.nick} salió`);
    });

    socket.on('cursor', ({ id, x, y }) => {
      const p = players.get(id);
      if (p) { p.x = x; p.y = y; p.lastSeen = Date.now(); }
    });

    socket.on('newPuzzle', ({ puzzle: pz, timer: t }) => {
      $('doneModal').classList.add('hidden');
      confetti = [];
      drag = null;
      puzzle = null; // forzar reconstrucción
      scores = {};
      renderPlayers();
      setPuzzle(pz, t);
      toast(`Nuevo puzzle de ${pz.uploadedBy}: ${pz.rows * pz.cols} piezas`);
    });

    socket.on('timer', setTimer);

    socket.on('pieceGrabbed', ({ id, by, z }) => {
      const p = pieces[id];
      if (!p) return;
      for (const m of groupMembers(p)) {
        m.heldBy = by;
        m.z = z;
      }
      orderDirty = true;
      if (by !== selfId && drag && pieces[drag.id].g === p.g) drag = null;
    });

    socket.on('grabDenied', ({ id }) => {
      if (drag && drag.id === id) drag = null;
      const p = pieces[id];
      if (p) for (const m of groupMembers(p)) if (m.heldBy === selfId) m.heldBy = null;
      orderDirty = true;
    });

    socket.on('pieceMoved', ({ id, x, y }) => {
      const p = pieces[id];
      if (!p || (drag && pieces[drag.id].g === p.g)) return;
      moveGroup(p, x, y);
    });

    socket.on('piecesDropped', ({ pieces: list, joins, placed, by, points }) => {
      const now = performance.now();
      for (const s of list) {
        const p = pieces[s.id];
        if (!p) continue;
        if (drag && drag.id === s.id) drag = null;
        p.x = s.x;
        p.y = s.y;
        p.g = s.g;
        p.placed = s.placed;
        p.heldBy = null;
        if (s.placed) p.z = 0;
        if (joins || placed) flashes.set(p.id, now);
      }
      // Todas las piezas del grupo comparten la z más alta
      if (list.length) {
        const zTop = Math.max(...list.map((s) => pieces[s.id].z));
        for (const s of list) if (!pieces[s.id].placed) pieces[s.id].z = zTop;
      }
      orderDirty = true;
      if ((joins || placed) && by === selfId) {
        clickSound();
        if (points) toast(`+${points} punto${points > 1 ? 's' : ''}`, 1200);
      }
      updateHud();
    });

    socket.on('completed', ({ elapsed, players: names, scores: final }) => {
      $('doneTime').textContent = fmtTime(elapsed);
      const ranking = Object.entries(final || {}).sort((a, b) => b[1] - a[1]);
      $('donePlayers').textContent = 'Armado por: ' + names.join(', ');
      const list = $('doneScores');
      list.innerHTML = '';
      ranking.forEach(([n, pts], i) => {
        const li = document.createElement('li');
        li.textContent = `${['🥇', '🥈', '🥉'][i] || '•'} ${n}: ${pts} pts`;
        list.appendChild(li);
      });
      $('doneModal').classList.remove('hidden');
      launchConfetti();
    });

    socket.on('errorMsg', (msg) => toast('⚠️ ' + msg, 4000));
  }

  // ---------- Login ----------
  $('roomHint').textContent = roomName === 'principal'
    ? 'Tip: agregá ?sala=nombre a la URL para una partida privada.'
    : `Sala: ${roomName}`;
  try { $('nickInput').value = localStorage.getItem('puzzle-nick') || ''; } catch (_) {}

  $('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    nick = $('nickInput').value.trim().slice(0, 20);
    if (!nick) return;
    try { localStorage.setItem('puzzle-nick', nick); } catch (_) {}
    $('login').classList.add('hidden');
    $('topbar').classList.remove('hidden');
    resize();
    connect();
  });

  // ---------- Subida de imagen ----------
  let pending = null; // {dataUrl, width, height}

  function estimateGrid(n, aspect) {
    let cols = Math.max(2, Math.round(Math.sqrt(n * aspect)));
    let rows = Math.max(2, Math.round(n / cols));
    while (rows * cols > 500) { if (cols >= rows) cols--; else rows--; }
    return [cols, rows];
  }

  function updateCountLabel() {
    const n = +$('countInput').value;
    if (pending) {
      const [c, r] = estimateGrid(n, pending.width / pending.height);
      $('countLabel').textContent = `${c * r} (${c}×${r})`;
    } else {
      $('countLabel').textContent = n;
    }
  }

  function openUpload() {
    $('replaceWarn').classList.toggle('hidden', !(puzzle && !timer.finished));
    $('uploadModal').classList.remove('hidden');
  }

  async function handleFile(file) {
    if (!file || !file.type.startsWith('image/')) return toast('Elegí un archivo de imagen');
    const url = URL.createObjectURL(file);
    try {
      const im = await loadImage(url);
      const MAX = 1600;
      const s = Math.min(1, MAX / Math.max(im.naturalWidth, im.naturalHeight));
      const w = Math.round(im.naturalWidth * s);
      const h = Math.round(im.naturalHeight * s);
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      cv.getContext('2d').drawImage(im, 0, 0, w, h);
      let q = 0.85;
      let dataUrl = cv.toDataURL('image/jpeg', q);
      while (dataUrl.length > 3.5 * 1024 * 1024 && q > 0.4) {
        q -= 0.1;
        dataUrl = cv.toDataURL('image/jpeg', q);
      }
      pending = { dataUrl, width: w, height: h };
      $('preview').src = dataUrl;
      $('preview').classList.remove('hidden');
      $('dropText').classList.add('hidden');
      $('submitUpload').disabled = false;
      updateCountLabel();
    } catch (_) {
      toast('No se pudo leer la imagen');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  $('newBtn').addEventListener('click', openUpload);
  $('doneNew').addEventListener('click', () => { $('doneModal').classList.add('hidden'); openUpload(); });
  $('closeDone').addEventListener('click', () => $('doneModal').classList.add('hidden'));
  $('cancelUpload').addEventListener('click', () => $('uploadModal').classList.add('hidden'));
  $('fileInput').addEventListener('change', (e) => handleFile(e.target.files[0]));
  $('countInput').addEventListener('input', updateCountLabel);
  document.querySelectorAll('.presets button').forEach((b) =>
    b.addEventListener('click', () => { $('countInput').value = b.dataset.n; updateCountLabel(); }));

  const dz = $('dropZone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    handleFile(e.dataTransfer.files[0]);
  });

  $('uploadForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!pending || !socket) return;
    socket.emit('upload', {
      image: pending.dataUrl, width: pending.width, height: pending.height,
      count: +$('countInput').value,
    });
    $('uploadModal').classList.add('hidden');
    toast('Generando puzzle…');
  });

  $('ghostToggle').addEventListener('change', (e) => { showGhost = e.target.checked; });
  $('fitBtn').addEventListener('click', fitView);

  resize();
  render();
})();
