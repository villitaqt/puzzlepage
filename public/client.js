(() => {
  'use strict';

  // ---------- Utilidades DOM ----------
  const $ = (id) => document.getElementById(id);
  const canvas = $('board');
  const ctx = canvas.getContext('2d');
  const hitCtx = document.createElement('canvas').getContext('2d');

  // ---------- Cifrado de imágenes (AES-GCM, clave derivada de la contraseña) ----------
  const KDF_SALT = new TextEncoder().encode('puzzle-coop/imagenes/v1');
  const KDF_ITERATIONS = 200000;
  let encKey = null;

  async function deriveKey(password) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: KDF_SALT, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function encryptBlob(blob) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encKey, await blob.arrayBuffer());
    return { iv, data };
  }

  async function decryptToUrl({ iv, data }) {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, encKey, data);
    return URL.createObjectURL(new Blob([plain], { type: 'image/jpeg' }));
  }

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
  let password = null;
  const players = new Map(); // id -> {nick,color,x,y,lastSeen}
  let scores = {};           // nick -> puntos

  let puzzle = null;   // datos del servidor
  let pieces = [];     // piezas con path/canvas locales
  let drawOrder = [];  // piezas ordenadas por z
  let orderDirty = true;
  let img = null;
  let imgUrl = null; // object URL de la imagen descifrada
  let pw = 0, ph = 0, pad = 0;
  let showGhost = false;
  let showPreview = false;
  let thinBorders = false;
  try { thinBorders = localStorage.getItem('puzzle-thin') === '1'; } catch (_) {}

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
    if (thinBorders) {
      g.restore();
      g.lineWidth = 0.3;
      g.strokeStyle = 'rgba(0,0,0,0.3)';
      g.stroke(piece.path);
      return cv;
    }
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
    let newImg = img;
    let newUrl = null;
    if (!sameImage) {
      try {
        newUrl = await decryptToUrl(pz.image);
        newImg = await loadImage(newUrl);
      } catch (_) {
        if (newUrl) URL.revokeObjectURL(newUrl);
        if (token === buildToken) toast('⚠️ No se pudo descifrar la imagen', 4000);
        return;
      }
    }
    if (token !== buildToken) {
      if (newUrl) URL.revokeObjectURL(newUrl);
      return;
    }
    if (newUrl) {
      if (imgUrl) URL.revokeObjectURL(imgUrl);
      imgUrl = newUrl;
    }

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

  function rerenderPieces() {
    if (!puzzle || !img) return;
    for (const p of pieces) p.canvas = renderPieceCanvas(p);
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

  // ---------- Layout móvil / modo horizontal ----------
  // En modo horizontal forzado (solo móvil) toda la interfaz se rota 90° con CSS.
  // "Vista" = coordenadas ya des-rotadas, que es lo que usa el canvas.
  const isTouch = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  let landscapePref = false;
  try { landscapePref = localStorage.getItem('puzzle-landscape') === '1'; } catch (_) {}
  let rotated = false;

  function viewW() { return rotated ? window.innerHeight : window.innerWidth; }
  function viewH() { return rotated ? window.innerWidth : window.innerHeight; }

  // Coordenadas de pantalla (clientX/Y) -> coordenadas de la vista
  function toView(cx, cy) {
    return rotated ? [cy, window.innerWidth - cx] : [cx, cy];
  }

  function applyLayout() {
    rotated = isTouch && landscapePref && window.innerHeight > window.innerWidth;
    const app = $('app');
    app.style.width = viewW() + 'px';
    app.style.height = viewH() + 'px';
    document.body.classList.toggle('rotated', rotated);
    document.body.classList.toggle('touch', isTouch);
    document.body.classList.toggle('compact', isTouch || viewW() < 900);
  }

  function closeMenu() {
    document.body.classList.remove('menu-open');
  }

  // ---------- Cámara ----------
  function topbarHeight() {
    const tb = $('topbar');
    return tb.classList.contains('hidden') ? 0 : tb.offsetHeight;
  }

  function fitView() {
    if (!puzzle) return;
    const top = topbarHeight();
    const vw = viewW();
    const vh = viewH() - top;
    let s = Math.min(vw / puzzle.worldW, vh / puzzle.worldH) * 0.97;
    if (isTouch) {
      // En el celular, que las piezas tengan un tamaño cómodo para el dedo (~34px),
      // sin que el tablero deje de entrar en pantalla. El resto se alcanza deslizando.
      const comfy = 34 / Math.max(pw, ph);
      const boardFit = Math.min(vw / puzzle.boardW, vh / puzzle.boardH) * 0.95;
      s = Math.max(s, Math.min(comfy, boardFit));
    }
    cam.scale = s;
    // Centrar en el tablero (si todo el mundo entra, esto equivale a centrar todo)
    const cx = puzzle.worldW * s <= vw ? puzzle.worldW / 2 : puzzle.boardX + puzzle.boardW / 2;
    const cy = puzzle.worldH * s <= vh ? puzzle.worldH / 2 : puzzle.boardY + puzzle.boardH / 2;
    cam.ox = vw / 2 - cx * s;
    cam.oy = top + vh / 2 - cy * s;
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
    applyLayout();
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(viewW() * dpr);
    canvas.height = Math.round(viewH() * dpr);
    fitView();
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 150));

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
          if (p.heldBy === selfId && drag) {
            // Se agranda un poco alrededor del dedo, como si se levantara de la mesa
            const lift = 1 + 0.06 * Math.min(1, (now - drag.t0) / 120);
            ctx.translate(drag.wx, drag.wy);
            ctx.scale(lift, lift);
            ctx.translate(-drag.wx, -drag.wy);
          }
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

      // Preview: imagen completa encima del tablero mientras se mantiene el botón
      if (showPreview) {
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.6)';
        ctx.shadowBlur = 30 * cam.scale * dpr;
        ctx.drawImage(img, bx, by, bw, bh);
        ctx.restore();
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 2 / cam.scale;
        ctx.strokeRect(bx, by, bw, bh);
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
    const H = viewH();
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
    const W = viewW();
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

  // ---------- Vibración (respuesta táctil) ----------
  function haptic(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_) { /* no soportado */ }
  }

  // ---------- Entrada (mouse / touch) ----------
  // Reglas:
  // - 1 dedo sobre una pieza: se agarra desde el punto tocado y se arrastra; al soltar, se suelta.
  // - 1 dedo sobre el fondo: mueve la vista.
  // - 2 dedos: zoom + desplazamiento (pinch). Nunca se agarra más de una pieza a la vez.
  const pointers = new Map(); // pointerId -> {x, y} en coordenadas de la vista
  let drag = null;   // {id, offX, offY, pointerId, t0, sx, sy, startX, startY}
  let pan = null;    // {pointerId, sx, sy, ox, oy}
  let pinch = null;  // {dist, mx, my}
  let lastMoveSent = 0;
  let lastCursorSent = 0;

  const TOUCH_SLOP_PX = 18;   // tolerancia para tocar piezas con el dedo
  const MOUSE_SLOP_PX = 3;
  const PINCH_CANCEL_MS = 250; // si el 2º dedo llega tan rápido, era un pinch y no un agarre

  function hitTest(wx, wy, slopPx) {
    // 1) Acierto exacto sobre la forma de la pieza (incluidas pestañas)
    for (let i = drawOrder.length - 1; i >= 0; i--) {
      const p = drawOrder[i];
      if (p.placed) continue;
      const lx = wx - p.x, ly = wy - p.y;
      if (lx < -pad || ly < -pad || lx > pw + pad || ly > ph + pad) continue;
      if (hitCtx.isPointInPath(p.path, lx, ly)) return p;
    }
    // 2) Tolerancia para dedos: la pieza más cercana dentro de unos píxeles
    const tol = slopPx / cam.scale;
    let best = null, bestD = Infinity;
    for (let i = drawOrder.length - 1; i >= 0; i--) {
      const p = drawOrder[i];
      if (p.placed) continue;
      const dx = Math.max(p.x - wx, 0, wx - (p.x + pw));
      const dy = Math.max(p.y - wy, 0, wy - (p.y + ph));
      const d = Math.hypot(dx, dy);
      if (d <= tol && d < bestD) { best = p; bestD = d; }
    }
    return best;
  }

  function sendCursor(wx, wy, force) {
    const now = performance.now();
    if (!socket || (!force && now - lastCursorSent < 50)) return;
    lastCursorSent = now;
    socket.emit('cursor', { x: Math.round(wx), y: Math.round(wy) });
  }

  function startPinch() {
    const [a, b] = [...pointers.values()];
    pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    pan = null;
  }

  function releaseDrag(backToStart) {
    if (!drag) return;
    const p = pieces[drag.id];
    if (p) {
      if (backToStart) moveGroup(p, drag.startX, drag.startY);
      socket.emit('drop', { id: p.id, x: p.x, y: p.y });
    }
    drag = null;
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* sin captura */ }
    const [sx, sy] = toView(e.clientX, e.clientY);
    pointers.set(e.pointerId, { x: sx, y: sy });
    closeMenu();

    if (pointers.size >= 2) {
      if (drag) {
        // 2º dedo justo después de tocar una pieza: era un pinch, se devuelve la pieza
        const first = pointers.get(drag.pointerId) || { x: drag.sx, y: drag.sy };
        const moved = Math.hypot(first.x - drag.sx, first.y - drag.sy) > 12;
        const quick = performance.now() - drag.t0 < PINCH_CANCEL_MS;
        if (quick && !moved) releaseDrag(true);
        else return; // ya está llevando una pieza: se ignoran los otros dedos
      }
      if (pointers.size === 2) startPinch();
      return;
    }

    const [wx, wy] = toWorld(sx, sy);
    const slop = e.pointerType === 'mouse' ? MOUSE_SLOP_PX : TOUCH_SLOP_PX;
    const p = puzzle && !timer.finished ? hitTest(wx, wy, slop) : null;
    const group = p ? groupMembers(p) : [];
    if (p && group.every((m) => !m.heldBy || m.heldBy === selfId)) {
      drag = {
        id: p.id, offX: wx - p.x, offY: wy - p.y, pointerId: e.pointerId,
        t0: performance.now(), sx, sy, startX: p.x, startY: p.y, wx, wy,
      };
      for (const m of group) {
        m.heldBy = selfId;
        m.z = Number.MAX_SAFE_INTEGER; // arriba hasta que el servidor confirme
      }
      orderDirty = true;
      socket.emit('grab', { id: p.id });
      if (e.pointerType !== 'mouse') haptic(8);
    } else {
      if (p && e.pointerType !== 'mouse') haptic([6, 40, 6]); // la tiene otro jugador
      pan = { pointerId: e.pointerId, sx, sy, ox: cam.ox, oy: cam.oy };
    }
    canvas.classList.add('dragging');
    sendCursor(wx, wy, true);
  });

  canvas.addEventListener('pointermove', (e) => {
    const [sx, sy] = toView(e.clientX, e.clientY);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: sx, y: sy });

    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      cam.ox += mx - pinch.mx;
      cam.oy += my - pinch.my;
      if (pinch.dist > 0) zoomAt(mx, my, dist / pinch.dist);
      pinch = { dist, mx, my };
      return;
    }

    const [wx, wy] = toWorld(sx, sy);
    if (drag && drag.pointerId === e.pointerId) {
      const p = pieces[drag.id];
      moveGroup(p, wx - drag.offX, wy - drag.offY);
      drag.wx = wx;
      drag.wy = wy;
      const now = performance.now();
      if (now - lastMoveSent > 33) {
        lastMoveSent = now;
        socket.emit('move', { id: p.id, x: p.x, y: p.y });
      }
    } else if (pan && pan.pointerId === e.pointerId) {
      cam.ox = pan.ox + (sx - pan.sx);
      cam.oy = pan.oy + (sy - pan.sy);
    }
    if (puzzle && (e.pointerType === 'mouse' || pointers.has(e.pointerId))) sendCursor(wx, wy, false);
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (drag && drag.pointerId === e.pointerId) releaseDrag(false);
    if (pan && pan.pointerId === e.pointerId) pan = null;
    if (pinch && pointers.size < 2) {
      pinch = null;
      // El dedo que queda sigue moviendo la vista sin saltos
      const [id, pt] = [...pointers.entries()][0] || [];
      if (id !== undefined && !drag) pan = { pointerId: id, sx: pt.x, sy: pt.y, ox: cam.ox, oy: cam.oy };
    }
    if (!drag && !pan && !pinch) canvas.classList.remove('dragging');
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [sx, sy] = toView(e.clientX, e.clientY);
    zoomAt(sx, sy, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  // Evitar el zoom de página de iOS (pellizco sobre la interfaz)
  ['gesturestart', 'gesturechange'].forEach((ev) =>
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));

  // ---------- Red ----------
  function showLogin(error) {
    $('login').classList.remove('hidden');
    $('topbar').classList.add('hidden');
    $('empty').classList.add('hidden');
    $('loginError').textContent = error || '';
    $('loginError').classList.toggle('hidden', !error);
    $('loginBtn').disabled = false;
  }

  function connect() {
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
    }
    socket = io({ transports: ['websocket', 'polling'], auth: { password } });

    socket.on('connect', () => {
      $('login').classList.add('hidden');
      $('topbar').classList.remove('hidden');
      resize();
      socket.emit('join', { nick });
    });

    socket.on('connect_error', (err) => {
      const msg = {
        unauthorized: 'Contraseña incorrecta.',
        blocked: 'Demasiados intentos fallidos. Esperá 15 minutos.',
        'no-password': 'El servidor no tiene contraseña configurada (PUZZLE_PASSWORD).',
      }[err.message];
      if (!msg) return; // error de red: Socket.IO reintenta solo
      socket.disconnect();
      try { sessionStorage.removeItem('puzzle-pass'); } catch (_) {}
      showLogin(msg);
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

    socket.on('arranged', ({ by, boardX, boardY, worldW, worldH, pieces: list }) => {
      if (!puzzle) return;
      Object.assign(puzzle, { boardX, boardY, worldW, worldH });
      drag = null;
      canvas.classList.remove('dragging');
      for (const s of list) {
        const p = pieces[s.id];
        if (!p) continue;
        p.x = s.x;
        p.y = s.y;
        p.g = s.g;
        p.placed = s.placed;
        p.heldBy = null;
      }
      orderDirty = true;
      fitView();
      toast(`${by} ordenó las piezas`);
    });

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
        haptic(placed ? [14, 50, 24] : 18);
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
  try {
    $('nickInput').value = localStorage.getItem('puzzle-nick') || '';
    $('passInput').value = sessionStorage.getItem('puzzle-pass') || '';
  } catch (_) {}

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    nick = $('nickInput').value.trim().slice(0, 20);
    password = $('passInput').value;
    if (!nick || !password) return;
    if (!window.crypto || !crypto.subtle) {
      return showLogin('Este navegador no soporta cifrado (se necesita HTTPS).');
    }
    try {
      localStorage.setItem('puzzle-nick', nick);
      sessionStorage.setItem('puzzle-pass', password);
    } catch (_) {}
    $('loginBtn').disabled = true;
    $('loginError').classList.add('hidden');
    encKey = await deriveKey(password);
    connect();
  });

  // ---------- Subida de imagen ----------
  let pending = null; // {blob, url, width, height}

  function canvasToBlob(cv, q) {
    return new Promise((resolve) => cv.toBlob(resolve, 'image/jpeg', q));
  }

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
      let blob = await canvasToBlob(cv, q);
      while (blob.size > 3.5 * 1024 * 1024 && q > 0.4) {
        q -= 0.1;
        blob = await canvasToBlob(cv, q);
      }
      if (pending) URL.revokeObjectURL(pending.url);
      pending = { blob, url: URL.createObjectURL(blob), width: w, height: h };
      $('preview').src = pending.url;
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

  $('uploadForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!pending || !socket || !encKey) return;
    $('uploadModal').classList.add('hidden');
    toast('Cifrando y generando puzzle…');
    const { iv, data } = await encryptBlob(pending.blob);
    socket.emit('upload', {
      iv, data, width: pending.width, height: pending.height,
      count: +$('countInput').value,
    });
  });

  $('ghostToggle').addEventListener('change', (e) => { showGhost = e.target.checked; });

  $('thinToggle').checked = thinBorders;
  $('thinToggle').addEventListener('change', (e) => {
    thinBorders = e.target.checked;
    try { localStorage.setItem('puzzle-thin', thinBorders ? '1' : '0'); } catch (_) {}
    rerenderPieces();
  });

  const previewBtn = $('previewBtn');
  const setPreview = (on) => {
    showPreview = on;
    previewBtn.classList.toggle('active', on);
  };
  previewBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    setPreview(true);
    try { previewBtn.setPointerCapture(e.pointerId); } catch (_) { /* sin captura, igual funciona */ }
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) =>
    previewBtn.addEventListener(ev, () => setPreview(false)));
  previewBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('blur', () => setPreview(false));

  $('menuBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    document.body.classList.toggle('menu-open');
  });
  // Las acciones del menú lo cierran; las casillas no
  document.querySelectorAll('#tools button').forEach((b) => b.addEventListener('click', closeMenu));

  $('landscapeToggle').checked = landscapePref;
  $('landscapeToggle').addEventListener('change', (e) => {
    landscapePref = e.target.checked;
    try { localStorage.setItem('puzzle-landscape', landscapePref ? '1' : '0'); } catch (_) {}
    closeMenu();
    resize();
  });

  $('arrangeBtn').addEventListener('click', () => {
    if (socket && puzzle && !timer.finished) socket.emit('arrange');
  });
  $('fitBtn').addEventListener('click', fitView);

  resize();
  render();
})();
