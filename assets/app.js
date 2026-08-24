"use strict";
/**
 * «Что собираем?» — фронт: хэш-роутер (библиотека / стол), вход через SSO
 * необязателен — гость играет во встроенные пазлы без сохранения (см.
 * README.md, «Идея в двух режимах»). Формы деталей — assets/puzzle-shapes.js,
 * геометрия проверена на пиксель-точное совпадение соседних рёбер (см. план).
 */

let auth = null;
let puzzlesCache = null;
let currentRouteAbort = null;

const $ = (root, sel) => root.querySelector(sel);
const CELL = 100;          // размер ячейки сетки в «мировых» пикселях (масштаб — зумом)
const PAD_FACTOR = 0.32;   // тот же коэффициент, что зашит в buildPiecePath — держим один здесь и там

/* ───────────────────────── хранилище гостя ───────────────────────── */
const localKey = id => `puzzle_progress_${id}`;
function localProgress(id) {
  try { return JSON.parse(localStorage.getItem(localKey(id)) || "null"); } catch { return null; }
}

/* ───────────────────────── общие данные ───────────────────────── */
async function getPuzzles() {
  if (puzzlesCache) return puzzlesCache;
  const res = auth.isAuthenticated() ? await auth.fetch("/api/puzzles") : await fetch("/api/puzzles");
  if (!res.ok) throw new Error("puzzles fetch failed");
  puzzlesCache = await res.json();
  return puzzlesCache;
}

/** Верхний потолок стороны выше, чем у фото Trip (2000 против 1600) —
 *  картинка режется на десятки кусков и разглядывается вблизи при зуме. */
async function shrinkForPuzzle(file) {
  const bitmap = await createImageBitmap(file);
  const MAX_SIDE = 2000;
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.86));
  return { blob, width: w, height: h };
}

async function uploadPuzzlePhoto(file, pieces, title) {
  const { blob, width, height } = await shrinkForPuzzle(file);
  const qs = new URLSearchParams({ pieces: String(pieces), w: String(width), h: String(height), title: title || "Мой пазл" });
  const res = await auth.fetch(`/api/puzzles?${qs}`, {
    method: "POST", headers: { "Content-Type": blob.type || "image/jpeg" }, body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "upload failed");
  puzzlesCache = null; // библиотека изменилась — старый кэш врёт
  return data;
}

async function deletePuzzle(id) {
  const res = await auth.fetch(`/api/puzzles/${encodeURIComponent(id)}`, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || "delete failed");
  puzzlesCache = null;
}

/** Вставляет форму загрузки в контейнер, вызывает onDone(puzzle) при
 *  успехе. Используется и в библиотеке (renderLibrary), и в пикере
 *  комнаты (renderRoom) — с разным onDone: один переходит на #/table/:id,
 *  другой стартует сеанс. */
function mountUploadForm(container, onDone) {
  container.innerHTML = `
    <form class="upload-form" id="uploadForm">
      <input class="text-input" id="uploadTitle" type="text" maxlength="80" placeholder="Название — необязательно">
      <select class="text-input" id="uploadPieces">
        <option value="12">Легко · 12 деталей</option>
        <option value="48" selected>Средне · 48 деталей</option>
        <option value="108">Сложно · 108 деталей</option>
        <option value="216">Эксперт · 216 деталей</option>
      </select>
      <input type="file" id="uploadFile" accept="image/*" required>
      <button class="btn filled" type="submit">Собрать из фото</button>
      <p class="state-note" id="uploadError" hidden></p>
    </form>`;
  const form = $(container, "#uploadForm");
  const errEl = $(container, "#uploadError");
  form.addEventListener("submit", async e => {
    e.preventDefault();
    errEl.hidden = true;
    const file = $(form, "#uploadFile").files[0];
    if (!file) { errEl.textContent = "Выберите файл"; errEl.hidden = false; return; }
    const submitBtn = $(form, "button[type=submit]");
    submitBtn.disabled = true;
    try {
      const pieces = parseInt($(form, "#uploadPieces").value, 10);
      const title = $(form, "#uploadTitle").value.trim();
      const puzzle = await uploadPuzzlePhoto(file, pieces, title);
      onDone(puzzle);
    } catch (err) {
      errEl.textContent = err.message === "not an image" ? "Файл не похож на изображение (JPEG/PNG/WebP)."
        : err.message === "too large" ? "Файл слишком большой даже после сжатия."
        : "Не удалось загрузить — попробуйте ещё раз.";
      errEl.hidden = false;
      submitBtn.disabled = false;
    }
  });
}

/** Прогресс по пазлу для карточки библиотеки: сервер для вошедшего, localStorage для гостя. */
async function progressFor(p) {
  if (auth.isAuthenticated()) {
    try {
      const res = await auth.fetch(`/api/puzzles/${encodeURIComponent(p.id)}/progress`);
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }
  return localProgress(p.id);
}

/* ───────────────────────── шапка: вход/выход ───────────────────────── */
function renderAuthArea() {
  const el = document.getElementById("authArea");
  el.innerHTML = "";
  if (auth.isAuthenticated()) {
    const user = auth.getUser();
    const label = (user && (user.name || user.username)) || "аккаунт";
    const wrap = document.createElement("span");
    wrap.className = "auth-user";
    const name = document.createElement("span");
    name.className = "auth-user-name";
    name.textContent = label;
    const logout = document.createElement("button");
    logout.className = "btn text sm";
    logout.type = "button";
    logout.textContent = "Выйти";
    logout.addEventListener("click", () => auth.logout());
    wrap.appendChild(name);
    el.append(wrap, logout);
  } else {
    const login = document.createElement("button");
    login.className = "btn tonal sm";
    login.type = "button";
    login.textContent = "Войти";
    login.addEventListener("click", () => auth.login());
    el.appendChild(login);
  }
}

/* ───────────────────────── библиотека ───────────────────────── */
function buildCard(p, opts = {}) {
  const tpl = document.getElementById("tplPuzzleCard");
  const node = tpl.content.firstElementChild.cloneNode(true);
  const img = $(node, "img");
  img.src = p.imageUrl;
  img.alt = p.title;
  $(node, ".puzzle-card-title").textContent = p.title;
  $(node, ".puzzle-card-meta").textContent = `${p.gridCols}×${p.gridRows} · ${p.gridCols * p.gridRows} деталей`;
  const mine = p.ownerUserId && auth.isAuthenticated() && auth.getUser()?.id === p.ownerUserId;
  if (mine && opts.allowDelete !== false) {
    const del = document.createElement("button");
    del.className = "btn text sm puzzle-card-delete";
    del.type = "button"; del.textContent = "Удалить";
    del.addEventListener("click", async ev => {
      ev.stopPropagation();
      if (!confirm(`Удалить пазл «${p.title}»?`)) return;
      try { await deletePuzzle(p.id); node.remove(); }
      catch (err) { alert(err.message === "in use" ? "Этим пазлом уже играли в комнате — удалить нельзя." : "Не удалось удалить."); }
    });
    $(node, ".puzzle-card-body").appendChild(del);
  }
  $(node, ".puzzle-card-play").addEventListener("click", () => {
    location.hash = `#/table/${encodeURIComponent(p.id)}`;
  });
  return node;
}

async function applyBadge(node, p) {
  const progress = await progressFor(p).catch(() => null);
  const badge = $(node, ".puzzle-card-badge");
  if (!progress || !progress.pieces) { badge.hidden = true; return; }
  const total = progress.piecesTotal || p.gridRows * p.gridCols;
  const placed = progress.piecesPlaced || 0;
  if (progress.completedAt) {
    badge.textContent = "Готово"; badge.classList.add("done"); badge.hidden = false;
    return;
  }
  if (placed > 0) {
    badge.textContent = `${Math.round((placed / total) * 100)}%`;
    badge.hidden = false;
    return;
  }
  badge.hidden = true;
}

async function renderLibrary(root, signal) {
  root.innerHTML = `
    <div class="library-head">
      <h1>Библиотека пазлов</h1>
      <p>Собирайте встроенные пазлы прямо в браузере — детали фигурные, стол зумится и таскается. Вход нужен только для того, чтобы прогресс сохранялся между заходами.</p>
    </div>
    <div id="guestNoteWrap"></div>
    <div id="uploadWrap"></div>
    <div class="puzzle-grid" id="puzzleGrid"><p class="state-note">Загружаем…</p></div>`;

  if (!auth.isAuthenticated()) {
    const note = document.createElement("div");
    note.className = "guest-note";
    const span = document.createElement("span");
    span.textContent = "Играть можно без входа — прогресс тогда хранится только в этом браузере.";
    const btn = document.createElement("button");
    btn.className = "btn tonal sm"; btn.type = "button";
    btn.textContent = "Войти и сохранять прогресс";
    btn.addEventListener("click", () => auth.login());
    note.append(span, btn);
    $(root, "#guestNoteWrap").appendChild(note);
  } else {
    mountUploadForm($(root, "#uploadWrap"), puzzle => {
      location.hash = `#/table/${encodeURIComponent(puzzle.id)}`;
    });
  }

  let puzzles;
  try {
    puzzles = await getPuzzles();
  } catch {
    if (!signal.aborted) $(root, "#puzzleGrid").innerHTML = '<p class="state-note">Не удалось загрузить пазлы — обновите страницу.</p>';
    return;
  }
  if (signal.aborted) return;

  const grid = $(root, "#puzzleGrid");
  grid.innerHTML = "";
  const cards = puzzles.map(p => { const node = buildCard(p); grid.appendChild(node); return { p, node }; });
  for (const { p, node } of cards) applyBadge(node, p);
}

/* ───────────────────────── стол: раскладка деталей ───────────────────────── */

/**
 * Начальная случайная раскладка вокруг контура доски: сетка ячеек размером
 * с деталь, исключая область самой доски, с лёгким дрожанием (jitter), чтобы
 * детали не стояли идеально ровным строем. Область (margin) при нехватке
 * места под все детали расширяется — так это работает и для 12 деталей, и
 * для 108 без ручной подгонки под каждый пазл.
 */
function scatterLayout(rows, cols, cell, pad) {
  const pieceSize = cell + 2 * pad;
  const boardW = cols * cell, boardH = rows * cell;
  const total = rows * cols;
  let margin = pieceSize * 1.4;
  let cells = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    const worldW = boardW + 2 * margin, worldH = boardH + 2 * margin;
    const step = pieceSize * 1.08;
    const gw = Math.max(1, Math.floor(worldW / step)), gh = Math.max(1, Math.floor(worldH / step));
    const bx0 = margin - pad * 0.3, bx1 = margin + boardW + pad * 0.3;
    const by0 = margin - pad * 0.3, by1 = margin + boardH + pad * 0.3;
    cells = [];
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const cx = gx * step + step / 2, cy = gy * step + step / 2;
        if (cx > bx0 && cx < bx1 && cy > by0 && cy < by1) continue; // область доски — не рассыпаем сюда
        cells.push({ x: gx * step, y: gy * step });
      }
    }
    if (cells.length >= total) break;
    margin *= 1.35;
  }
  shuffleInPlace(cells);
  const jitter = pieceSize * 0.1;
  const picked = cells.slice(0, total).map(p => ({
    x: p.x + (Math.random() * 2 - 1) * jitter,
    y: p.y + (Math.random() * 2 - 1) * jitter,
  }));
  return { margin, worldW: boardW + 2 * margin, worldH: boardH + 2 * margin, cells: picked };
}
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/** Один <div class="piece"> со своим <svg viewBox="0 0 size size">, clipPath и <image>,
 *  все детали одного пазла ссылаются на один и тот же URL картинки. */
function createPieceEl(puzzleId, r, c, rows, cols, cell, pad, edges, imageUrl, boardW, boardH) {
  const size = cell + 2 * pad;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));

  const d = window.PuzzleShapes.buildPiecePath(r, c, rows, cols, cell, edges);
  const clipId = `clip-${puzzleId}-${r}-${c}`;

  const defs = document.createElementNS(NS, "defs");
  const clip = document.createElementNS(NS, "clipPath");
  clip.setAttribute("id", clipId);
  const clipPath = document.createElementNS(NS, "path");
  clipPath.setAttribute("d", d);
  clip.appendChild(clipPath);
  defs.appendChild(clip);
  svg.appendChild(defs);

  // Картинка — целиком, одна и та же на все детали (браузер декодирует раз),
  // сдвинута так, что у детали (r,c) в её локальных координатах видна ровно
  // её часть общей картинки; preserveAspectRatio="none" растягивает картинку
  // строго на boardW×boardH — без этого несовпадение пропорций дало бы поля,
  // одинаковые у всех деталей, но не бесшовные на стыках.
  const img = document.createElementNS(NS, "image");
  img.setAttributeNS("http://www.w3.org/1999/xlink", "href", imageUrl);
  img.setAttribute("href", imageUrl);
  img.setAttribute("x", String(-(c * cell - pad)));
  img.setAttribute("y", String(-(r * cell - pad)));
  img.setAttribute("width", String(boardW));
  img.setAttribute("height", String(boardH));
  img.setAttribute("preserveAspectRatio", "none");
  img.setAttribute("clip-path", `url(#${clipId})`);
  svg.appendChild(img);

  // Тонкая обводка контура поверх картинки — стык виден и на однотонных
  // участках, где иначе фигурная деталь читалась бы как обычный квадрат.
  const outline = document.createElementNS(NS, "path");
  outline.setAttribute("d", d);
  outline.setAttribute("fill", "none");
  outline.setAttribute("stroke", "rgba(0,0,0,.18)");
  outline.setAttribute("stroke-width", "1.2");
  svg.appendChild(outline);

  const wrap = document.createElement("div");
  wrap.className = "piece";
  wrap.style.width = size + "px";
  wrap.style.height = size + "px";
  wrap.dataset.r = String(r);
  wrap.dataset.c = String(c);
  wrap.appendChild(svg);
  return wrap;
}

function applyPieceTransform(piece) {
  piece.el.style.transform = `translate(${piece.x}px, ${piece.y}px)`;
}

async function renderTable(root, puzzleId, signal) {
  root.innerHTML = `
    <div class="table-screen">
      <div class="table-toolbar">
        <a class="btn text sm" href="#/">← Библиотека</a>
        <strong id="tableTitle"></strong>
        <div class="spacer"></div>
        <span class="table-progress" id="tableProgress"></span>
      </div>
      <div class="table-stage" id="stage">
        <div class="table-world" id="world"></div>
        <div class="zoom-controls">
          <button class="btn outlined icon" id="zoomInBtn" type="button" title="Приблизить" aria-label="Приблизить">+</button>
          <button class="btn outlined icon" id="zoomResetBtn" type="button" title="Показать всё" aria-label="Показать всё">⤢</button>
          <button class="btn outlined icon" id="zoomOutBtn" type="button" title="Отдалить" aria-label="Отдалить">−</button>
        </div>
      </div>
    </div>`;
  const stage = $(root, "#stage");

  let puzzles;
  try { puzzles = await getPuzzles(); } catch { stage.innerHTML = '<p class="state-note">Не удалось загрузить пазл — обновите страницу.</p>'; return; }
  if (signal.aborted) return;
  const puzzle = puzzles.find(p => p.id === puzzleId);
  if (!puzzle) { stage.innerHTML = '<p class="state-note">Такого пазла нет.</p>'; return; }
  $(root, "#tableTitle").textContent = puzzle.title;

  const rows = puzzle.gridRows, cols = puzzle.gridCols;
  const pad = CELL * PAD_FACTOR;
  const boardW = cols * CELL, boardH = rows * CELL;
  const edges = window.PuzzleShapes.buildEdges(puzzle.seed, rows, cols);

  // ── прогресс: сервер для вошедшего, localStorage для гостя ──
  let saved = null;
  if (auth.isAuthenticated()) {
    try {
      const res = await auth.fetch(`/api/puzzles/${encodeURIComponent(puzzle.id)}/progress`);
      if (res.ok) saved = await res.json();
    } catch { /* сессия истекла или сети нет — начинаем как в этой сессии, сохранить не выйдет */ }
  } else {
    saved = localProgress(puzzle.id);
  }
  if (signal.aborted) return;

  const world = $(root, "#world");
  const progressEl = $(root, "#tableProgress");
  const scatter = scatterLayout(rows, cols, CELL, pad);
  const BOARD_X = scatter.margin, BOARD_Y = scatter.margin;

  world.style.width = scatter.worldW + "px";
  world.style.height = scatter.worldH + "px";

  const outline = document.createElement("div");
  outline.className = "board-outline";
  outline.style.left = BOARD_X + "px";
  outline.style.top = BOARD_Y + "px";
  outline.style.width = boardW + "px";
  outline.style.height = boardH + "px";
  world.appendChild(outline);

  const pieces = new Map();
  let scatterIdx = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const target = { x: BOARD_X + c * CELL - pad, y: BOARD_Y + r * CELL - pad };
      const savedPiece = saved && Array.isArray(saved.pieces) && saved.pieces.find(pc => pc.r === r && pc.c === c);
      let x, y, placed;
      if (savedPiece) { x = savedPiece.x; y = savedPiece.y; placed = !!savedPiece.placed; }
      else { const cell = scatter.cells[scatterIdx++]; x = cell.x; y = cell.y; placed = false; }
      pieces.set(`${r},${c}`, { r, c, x, y, placed, target });
    }
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const piece = pieces.get(`${r},${c}`);
      const el = createPieceEl(puzzle.id, r, c, rows, cols, CELL, pad, edges, puzzle.imageUrl, boardW, boardH);
      piece.el = el;
      applyPieceTransform(piece);
      if (piece.placed) el.classList.add("placed");
      world.appendChild(el);
      bindPieceDrag(el, piece);
    }
  }

  /* ── zoom/pan мирового контейнера ── */
  let zoom = 1, panX = 0, panY = 0;
  const ZOOM_MIN = 0.12, ZOOM_MAX = 3.2;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  function applyWorldTransform() { world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`; }
  function fitView() {
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const scale = Math.min(rect.width / scatter.worldW, rect.height / scatter.worldH) * 0.94;
    zoom = clamp(scale, ZOOM_MIN, ZOOM_MAX);
    panX = (rect.width - scatter.worldW * zoom) / 2;
    panY = (rect.height - scatter.worldH * zoom) / 2;
    applyWorldTransform();
  }
  function zoomAt(clientX, clientY, factor) {
    const rect = stage.getBoundingClientRect();
    const cx = clientX - rect.left, cy = clientY - rect.top;
    const wx = (cx - panX) / zoom, wy = (cy - panY) / zoom;
    zoom = clamp(zoom * factor, ZOOM_MIN, ZOOM_MAX);
    panX = cx - wx * zoom;
    panY = cy - wy * zoom;
    applyWorldTransform();
  }
  fitView();

  stage.addEventListener("wheel", e => {
    e.preventDefault();
    const factor = Math.pow(1.0016, -e.deltaY);
    zoomAt(e.clientX, e.clientY, factor);
  }, { passive: false, signal });

  // Пинч на тач — по активным Pointer ID: деталь останавливает всплытие
  // pointerdown (см. bindPieceDrag), поэтому сюда долетают только жесты по фону.
  const active = new Map();
  let panState = null, pinchState = null;
  const midOf = m => { const p = [...m.values()]; return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 }; };
  const distOf = m => { const p = [...m.values()]; return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); };

  stage.addEventListener("pointerdown", e => {
    if (e.target.closest(".piece")) return;
    stage.setPointerCapture(e.pointerId);
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (active.size === 1) {
      panState = { startX: e.clientX, startY: e.clientY, originX: panX, originY: panY };
      stage.classList.add("panning");
    } else if (active.size === 2) {
      panState = null;
      pinchState = { lastDist: distOf(active), lastMid: midOf(active) };
    }
  }, { signal });

  stage.addEventListener("pointermove", e => {
    if (!active.has(e.pointerId)) return;
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (active.size === 2) {
      const mid = midOf(active), dist = distOf(active);
      if (pinchState) {
        const rect = stage.getBoundingClientRect();
        const oldCx = pinchState.lastMid.x - rect.left, oldCy = pinchState.lastMid.y - rect.top;
        const wx = (oldCx - panX) / zoom, wy = (oldCy - panY) / zoom;
        zoom = clamp(zoom * (dist / pinchState.lastDist), ZOOM_MIN, ZOOM_MAX);
        const newCx = mid.x - rect.left, newCy = mid.y - rect.top;
        panX = newCx - wx * zoom;
        panY = newCy - wy * zoom;
        applyWorldTransform();
      }
      pinchState = { lastDist: dist, lastMid: mid };
    } else if (active.size === 1 && panState) {
      panX = panState.originX + (e.clientX - panState.startX);
      panY = panState.originY + (e.clientY - panState.startY);
      applyWorldTransform();
    }
  }, { signal });

  function endPointer(e) {
    active.delete(e.pointerId);
    if (active.size === 1) {
      const [, p] = [...active.entries()][0];
      panState = { startX: p.x, startY: p.y, originX: panX, originY: panY };
      pinchState = null;
    } else if (active.size === 0) {
      panState = null; pinchState = null;
      stage.classList.remove("panning");
    }
  }
  stage.addEventListener("pointerup", endPointer, { signal });
  stage.addEventListener("pointercancel", endPointer, { signal });

  $(root, "#zoomInBtn").addEventListener("click", () => {
    const r = stage.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25);
  }, { signal });
  $(root, "#zoomOutBtn").addEventListener("click", () => {
    const r = stage.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 0.8);
  }, { signal });
  $(root, "#zoomResetBtn").addEventListener("click", fitView, { signal });
  window.addEventListener("resize", fitView, { signal });

  /* ── перетаскивание детали ── */
  function bindPieceDrag(el, piece) {
    let dragging = null;
    el.addEventListener("pointerdown", e => {
      if (piece.placed) return;
      e.stopPropagation(); // не даём фону начать панораму
      el.setPointerCapture(e.pointerId);
      dragging = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, originX: piece.x, originY: piece.y };
      el.classList.add("dragging");
    }, { signal });

    el.addEventListener("pointermove", e => {
      if (!dragging || e.pointerId !== dragging.pointerId) return;
      piece.x = dragging.originX + (e.clientX - dragging.startX) / zoom;
      piece.y = dragging.originY + (e.clientY - dragging.startY) / zoom;
      applyPieceTransform(piece);
    }, { signal });

    function finish(e) {
      if (!dragging || e.pointerId !== dragging.pointerId) return;
      dragging = null;
      el.classList.remove("dragging");
      const dist = Math.hypot(piece.x - piece.target.x, piece.y - piece.target.y);
      if (dist < CELL * 0.28) {
        piece.x = piece.target.x; piece.y = piece.target.y; piece.placed = true;
        applyPieceTransform(piece);
        el.classList.add("placed", "just-snapped");
        setTimeout(() => el.classList.remove("just-snapped"), 600);
      }
      scheduleSave();
    }
    el.addEventListener("pointerup", finish, { signal });
    el.addEventListener("pointercancel", finish, { signal });
  }

  /* ── сохранение прогресса ── */
  let saveTimer = null;
  let announced = !!(saved && saved.completedAt);
  function updateProgressLabel(placed, total) {
    progressEl.innerHTML = "";
    const b = document.createElement("b");
    b.textContent = `${placed}/${total}`;
    progressEl.append(b, document.createTextNode(" деталей собрано"));
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveProgress(); }, 500);
  }
  async function saveProgress() {
    const total = rows * cols;
    const arr = [...pieces.values()].map(p => ({ r: p.r, c: p.c, x: p.x, y: p.y, placed: p.placed }));
    const placed = arr.filter(p => p.placed).length;
    updateProgressLabel(placed, total);
    const payload = { pieces: arr, piecesPlaced: placed, piecesTotal: total };

    if (auth.isAuthenticated()) {
      try {
        const res = await auth.fetch(`/api/puzzles/${encodeURIComponent(puzzle.id)}/progress`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), keepalive: true,
        });
        if (res.ok) {
          const data = await res.json();
          if (data.completedAt && !announced) { announced = true; showWin(); }
        }
      } catch { /* AuthRequiredError и подобное — просто не сохранилось на этот раз */ }
    } else {
      const prev = localProgress(puzzle.id);
      const completedAt = placed >= total ? ((prev && prev.completedAt) || Date.now()) : null;
      localStorage.setItem(localKey(puzzle.id), JSON.stringify({ ...payload, completedAt }));
      if (completedAt && !announced) { announced = true; showWin(); }
    }
  }
  updateProgressLabel([...pieces.values()].filter(p => p.placed).length, rows * cols);
  if (announced) {
    // Уже был собран раньше (пришли на готовый пазл заново) — витрину «Готово»
    // не выскакиваем сразу поверх стола, достаточно бейджа в тулбаре/библиотеке.
  }

  function showWin() {
    const overlay = document.createElement("div");
    overlay.className = "win-overlay";
    const card = document.createElement("div");
    card.className = "win-card";
    const h2 = document.createElement("h2"); h2.textContent = "Готово!";
    const p = document.createElement("p"); p.textContent = `Пазл «${puzzle.title}» собран.`;
    const btn = document.createElement("button");
    btn.className = "btn filled"; btn.type = "button"; btn.textContent = "Отлично";
    btn.addEventListener("click", () => overlay.remove());
    card.append(h2, p, btn);
    overlay.appendChild(card);
    stage.appendChild(overlay);
  }

  // Флаш сохранения при уходе со стола (смена маршрута), сворачивании вкладки
  // или закрытии страницы — иначе последние секунды сборки потерялись бы.
  signal.addEventListener("abort", () => { clearTimeout(saveTimer); saveProgress(); });
  window.addEventListener("visibilitychange", () => { if (document.hidden) { clearTimeout(saveTimer); saveProgress(); } }, { signal });
  window.addEventListener("pagehide", () => { clearTimeout(saveTimer); saveProgress(); }, { signal });
}

/* ───────────────────────── комнаты: сокет-обвязка ───────────────────────── */

function wsUrlFor(path) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}`;
}

/** WebSocket-обёртка с автопереподключением (экспоненциальная задержка,
 *  максимум 10с) и троттлингом на вызывающей стороне (см. throttle ниже).
 *  Токен запрашивается заново при каждой попытке подключения — уже
 *  просроченный к моменту переподключения токен getAccessToken() сам
 *  обновит. */
function connectRoomSocket({ roomId, sessionId, signal, onMessage, onOpen, onClose }) {
  let socket = null, attempt = 0, stopped = false;

  async function open() {
    if (stopped || signal.aborted) return;
    const token = await auth.getAccessToken();
    if (!token) return;
    const url = wsUrlFor(`/ws/rooms/${encodeURIComponent(roomId)}/sessions/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(token)}`);
    socket = new WebSocket(url);
    socket.addEventListener("open", () => { attempt = 0; onOpen && onOpen(); });
    socket.addEventListener("message", e => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      onMessage(msg);
    });
    socket.addEventListener("close", () => {
      onClose && onClose();
      if (stopped || signal.aborted) return;
      attempt++;
      setTimeout(open, Math.min(10000, 500 * 2 ** attempt));
    });
    socket.addEventListener("error", () => socket.close());
  }
  open();
  signal.addEventListener("abort", () => { stopped = true; if (socket) socket.close(); });

  return { send(obj) { if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj)); } };
}

function throttle(fn, ms) {
  let last = 0, pending = null;
  return (...args) => {
    const t = performance.now();
    if (t - last >= ms) { last = t; clearTimeout(pending); fn(...args); }
    else { clearTimeout(pending); pending = setTimeout(() => { last = performance.now(); fn(...args); }, ms - (t - last)); }
  };
}

/* ───────────────────────── комнаты: список ───────────────────────── */

function fmtDate(ts) {
  try { return new Date(ts).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
}

async function renderRoomsList(root, signal) {
  root.innerHTML = `
    <div class="library-head">
      <h1>Комнаты</h1>
      <p>Соберите пазл вместе с друзьями — детали двигаются в реальном времени для всех, кто за столом.</p>
    </div>
    <form class="create-room-form" id="createRoomForm">
      <input class="text-input" id="roomTitleInput" type="text" maxlength="120" placeholder="Название комнаты, например «Пятничный вечер»" required>
      <button class="btn filled" type="submit">Создать комнату</button>
    </form>
    <div class="room-list" id="roomList"><p class="state-note">Загружаем…</p></div>`;

  if (!auth.isAuthenticated()) {
    $(root, "#roomList").innerHTML = "";
    const note = document.createElement("div");
    note.className = "guest-note";
    const span = document.createElement("span");
    span.textContent = "Комнаты доступны только вошедшим — без входа некому подписать ваши действия за столом.";
    const btn = document.createElement("button");
    btn.className = "btn tonal sm"; btn.type = "button";
    btn.textContent = "Войти";
    btn.addEventListener("click", () => auth.login());
    note.append(span, btn);
    $(root, "#roomList").appendChild(note);
    $(root, "#createRoomForm").hidden = true;
    return;
  }

  async function loadRooms() {
    const list = $(root, "#roomList");
    let rooms;
    try {
      const res = await auth.fetch("/api/rooms");
      if (!res.ok) throw new Error("rooms fetch failed");
      rooms = await res.json();
    } catch {
      if (!signal.aborted) list.innerHTML = '<p class="state-note">Не удалось загрузить комнаты — обновите страницу.</p>';
      return;
    }
    if (signal.aborted) return;
    if (!rooms.length) { list.innerHTML = '<p class="state-note">Пока нет ни одной комнаты — создайте первую.</p>'; return; }
    list.innerHTML = "";
    for (const r of rooms) {
      const card = document.createElement("article");
      card.className = "room-card";
      card.innerHTML = `
        <h3 class="room-card-title"></h3>
        <p class="room-card-meta"></p>`;
      $(card, ".room-card-title").textContent = r.title;
      $(card, ".room-card-meta").textContent = `${r.membersCount} участник(ов) · обновлено ${fmtDate(r.updatedAt)}`;
      card.addEventListener("click", () => { location.hash = `#/room/${encodeURIComponent(r.id)}`; });
      list.appendChild(card);
    }
  }

  $(root, "#createRoomForm").addEventListener("submit", async e => {
    e.preventDefault();
    const input = $(root, "#roomTitleInput");
    const title = input.value.trim();
    if (!title) return;
    try {
      const res = await auth.fetch("/api/rooms", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error("create room failed");
      const room = await res.json();
      location.hash = `#/room/${encodeURIComponent(room.id)}`;
    } catch { /* останемся на месте, форма не очистится — можно повторить */ }
  }, { signal });

  await loadRooms();
}

/* ───────────────────────── комнаты: экран комнаты ───────────────────────── */

async function renderRoom(root, roomId, signal) {
  root.innerHTML = `
    <div class="library-head"><h1>Комната</h1></div>
    <div id="roomBody"><p class="state-note">Загружаем…</p></div>`;
  const body = $(root, "#roomBody");

  if (!auth.isAuthenticated()) {
    body.innerHTML = '<p class="state-note">Войдите, чтобы увидеть комнату.</p>';
    return;
  }

  let room, sessions;
  try {
    const [roomRes, sessionsRes] = await Promise.all([
      auth.fetch(`/api/rooms/${encodeURIComponent(roomId)}`),
      auth.fetch(`/api/rooms/${encodeURIComponent(roomId)}/sessions`),
    ]);
    if (roomRes.status === 403) { body.innerHTML = '<p class="state-note">Вы не участник этой комнаты.</p>'; return; }
    if (!roomRes.ok) throw new Error("room fetch failed");
    room = await roomRes.json();
    sessions = sessionsRes.ok ? await sessionsRes.json() : [];
  } catch {
    if (!signal.aborted) body.innerHTML = '<p class="state-note">Не удалось загрузить комнату — обновите страницу.</p>';
    return;
  }
  if (signal.aborted) return;

  const inviteUrl = `${location.origin}${location.pathname}#/rooms/join/${room.joinCode}`;

  body.innerHTML = `
    <div class="room-head">
      <h2 class="room-head-title"></h2>
      <div class="invite-box">
        <span>Приглашение:</span>
        <input class="text-input" id="inviteInput" type="text" readonly>
        <button class="btn outlined sm" id="copyInviteBtn" type="button">Скопировать</button>
      </div>
    </div>
    <div class="room-members" id="roomMembers"></div>
    <div class="room-active" id="roomActive"></div>
    <h3 class="room-section-title">История сборок</h3>
    <div class="room-history" id="roomHistory"></div>`;

  $(root, ".room-head-title").textContent = room.title;
  $(root, "#inviteInput").value = inviteUrl;
  $(root, "#copyInviteBtn").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(inviteUrl); } catch { /* буфер недоступен — ссылка и так видна в поле */ }
  }, { signal });

  const membersEl = $(root, "#roomMembers");
  membersEl.innerHTML = "";
  for (const m of room.members) {
    const chip = document.createElement("span");
    chip.className = "member-chip" + (m.role === "owner" ? " owner" : "");
    chip.textContent = m.name || m.username || "участник";
    membersEl.appendChild(chip);
  }

  const activeEl = $(root, "#roomActive");
  if (room.activeSession) {
    activeEl.innerHTML = `
      <div class="room-active-card">
        <p>Сейчас за столом собирают пазл «${room.activeSession.puzzle.title}» — ${room.activeSession.piecesPlaced}/${room.activeSession.piecesTotal} деталей.</p>
        <button class="btn filled" id="joinTableBtn" type="button">За стол</button>
      </div>`;
    $(activeEl, "#joinTableBtn").addEventListener("click", () => {
      location.hash = `#/room/${encodeURIComponent(roomId)}/table/${encodeURIComponent(room.activeSession.id)}`;
    }, { signal });
  } else {
    activeEl.innerHTML = '<h3 class="room-section-title">Начать сборку</h3><div class="puzzle-grid" id="roomPuzzleGrid"><p class="state-note">Загружаем пазлы…</p></div><div id="roomUploadWrap"></div>';
    let puzzles;
    try { puzzles = await getPuzzles(); } catch { $(activeEl, "#roomPuzzleGrid").innerHTML = '<p class="state-note">Не удалось загрузить пазлы.</p>'; puzzles = []; }
    if (signal.aborted) return;
    const grid = $(activeEl, "#roomPuzzleGrid");
    grid.innerHTML = "";
    for (const p of puzzles) {
      const node = buildCard(p, { allowDelete: false });
      // Внутри комнаты клик по карточке стартует общий сеанс, а не сольный
      // стол — заменяем обработчик, повесленный buildCard на "#/table/:id".
      const playBtn = $(node, ".puzzle-card-play");
      const clone = playBtn.cloneNode(true);
      playBtn.replaceWith(clone);
      clone.addEventListener("click", async () => {
        clone.disabled = true;
        try {
          const res = await auth.fetch(`/api/rooms/${encodeURIComponent(roomId)}/sessions`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ puzzleId: p.id }),
          });
          const data = await res.json();
          if (res.status === 409 && data.session) {
            location.hash = `#/room/${encodeURIComponent(roomId)}/table/${encodeURIComponent(data.session.id)}`;
            return;
          }
          if (!res.ok) throw new Error("start session failed");
          location.hash = `#/room/${encodeURIComponent(roomId)}/table/${encodeURIComponent(data.id)}`;
        } catch {
          clone.disabled = false;
        }
      }, { signal });
      grid.appendChild(node);
    }

    mountUploadForm($(activeEl, "#roomUploadWrap"), async puzzle => {
      const res = await auth.fetch(`/api/rooms/${encodeURIComponent(roomId)}/sessions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ puzzleId: puzzle.id }),
      });
      const data = await res.json();
      if (res.ok) location.hash = `#/room/${encodeURIComponent(roomId)}/table/${encodeURIComponent(data.id)}`;
    });
  }

  const historyEl = $(root, "#roomHistory");
  const past = sessions.filter(s => s.completedAt);
  if (!past.length) {
    historyEl.innerHTML = '<p class="state-note">Ещё ничего не собрано.</p>';
  } else {
    historyEl.innerHTML = "";
    for (const s of past) {
      const row = document.createElement("div");
      row.className = "history-row";
      row.innerHTML = `<span class="history-puzzle"></span><span class="history-meta"></span>`;
      $(row, ".history-puzzle").textContent = s.puzzle.title;
      $(row, ".history-meta").textContent = `${s.piecesTotal} деталей · собран ${fmtDate(s.completedAt)}`;
      historyEl.appendChild(row);
    }
  }
}

/* ───────────────────────── комнаты: вступление по ссылке ───────────────────────── */

async function renderRoomJoin(root, code, signal) {
  root.innerHTML = `<div id="joinBody"><p class="state-note">Секунду…</p></div>`;
  const body = $(root, "#joinBody");

  if (!auth.isAuthenticated()) {
    sessionStorage.setItem("bh_puzzle_pending_join", code);
    body.innerHTML = `
      <div class="room-join-screen">
        <h2>Приглашение в комнату</h2>
        <p>Войдите, чтобы принять приглашение и присоединиться к сборке.</p>
        <button class="btn filled" id="joinLoginBtn" type="button">Войти</button>
      </div>`;
    $(body, "#joinLoginBtn").addEventListener("click", () => auth.login(), { signal });
    return;
  }

  try {
    const res = await auth.fetch(`/api/rooms/join/${encodeURIComponent(code)}`, { method: "POST" });
    if (!res.ok) throw new Error("join failed");
    const data = await res.json();
    if (signal.aborted) return;
    location.hash = `#/room/${encodeURIComponent(data.roomId)}`;
  } catch {
    if (!signal.aborted) body.innerHTML = '<p class="state-note">Приглашение не найдено или больше не действует.</p>';
  }
}

/* ───────────────────────── комнаты: стол ───────────────────────── */

/** Структурная копия renderTable (см. выше) — тот же scatterLayout,
 *  createPieceEl, applyPieceTransform, zoom/pan/pinch — БЕЗ ИЗМЕНЕНИЙ
 *  (камера — локальное состояние каждого клиента, синхронизации не
 *  требует). Отличия: раскладка и прогресс приходят по сокету, а не из
 *  фетча сохранённого прогресса; перетаскивание детали шлёт move/place. */
async function renderRoomTable(root, roomId, sessionId, signal) {
  root.innerHTML = `
    <div class="table-screen">
      <div class="table-toolbar">
        <a class="btn text sm" href="#/room/${encodeURIComponent(roomId)}">← Комната</a>
        <strong id="tableTitle"></strong>
        <div class="spacer"></div>
        <div class="presence-bar" id="presenceBar"></div>
        <span class="table-progress" id="tableProgress"></span>
      </div>
      <div class="table-stage" id="stage">
        <div class="table-world" id="world"></div>
        <div class="zoom-controls">
          <button class="btn outlined icon" id="zoomInBtn" type="button" title="Приблизить" aria-label="Приблизить">+</button>
          <button class="btn outlined icon" id="zoomResetBtn" type="button" title="Показать всё" aria-label="Показать всё">⤢</button>
          <button class="btn outlined icon" id="zoomOutBtn" type="button" title="Отдалить" aria-label="Отдалить">−</button>
        </div>
      </div>
    </div>`;
  const stage = $(root, "#stage");

  if (!auth.isAuthenticated()) { stage.innerHTML = '<p class="state-note">Войдите, чтобы сесть за стол комнаты.</p>'; return; }

  let session;
  try {
    const sessionRes = await auth.fetch(`/api/rooms/${encodeURIComponent(roomId)}/sessions/${encodeURIComponent(sessionId)}`);
    if (!sessionRes.ok) throw new Error("session fetch failed");
    session = await sessionRes.json();
  } catch {
    if (!signal.aborted) stage.innerHTML = '<p class="state-note">Не удалось открыть стол — обновите страницу.</p>';
    return;
  }
  if (signal.aborted) return;
  const puzzle = session.puzzle;
  $(root, "#tableTitle").textContent = puzzle.title;

  const rows = puzzle.gridRows, cols = puzzle.gridCols;
  const pad = CELL * PAD_FACTOR;
  const boardW = cols * CELL, boardH = rows * CELL;
  const edges = window.PuzzleShapes.buildEdges(puzzle.seed, rows, cols);

  const world = $(root, "#world");
  const progressEl = $(root, "#tableProgress");
  const presenceEl = $(root, "#presenceBar");
  const scatter = scatterLayout(rows, cols, CELL, pad);
  const BOARD_X = scatter.margin, BOARD_Y = scatter.margin;

  world.style.width = scatter.worldW + "px";
  world.style.height = scatter.worldH + "px";

  const outline = document.createElement("div");
  outline.className = "board-outline";
  outline.style.left = BOARD_X + "px";
  outline.style.top = BOARD_Y + "px";
  outline.style.width = boardW + "px";
  outline.style.height = boardH + "px";
  world.appendChild(outline);

  /* ── zoom/pan мирового контейнера — идентично renderTable ── */
  let zoom = 1, panX = 0, panY = 0;
  const ZOOM_MIN = 0.12, ZOOM_MAX = 3.2;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  function applyWorldTransform() { world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`; }
  function fitView() {
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const scale = Math.min(rect.width / scatter.worldW, rect.height / scatter.worldH) * 0.94;
    zoom = clamp(scale, ZOOM_MIN, ZOOM_MAX);
    panX = (rect.width - scatter.worldW * zoom) / 2;
    panY = (rect.height - scatter.worldH * zoom) / 2;
    applyWorldTransform();
  }
  function zoomAt(clientX, clientY, factor) {
    const rect = stage.getBoundingClientRect();
    const cx = clientX - rect.left, cy = clientY - rect.top;
    const wx = (cx - panX) / zoom, wy = (cy - panY) / zoom;
    zoom = clamp(zoom * factor, ZOOM_MIN, ZOOM_MAX);
    panX = cx - wx * zoom;
    panY = cy - wy * zoom;
    applyWorldTransform();
  }
  fitView();

  stage.addEventListener("wheel", e => {
    e.preventDefault();
    const factor = Math.pow(1.0016, -e.deltaY);
    zoomAt(e.clientX, e.clientY, factor);
  }, { passive: false, signal });

  const active = new Map();
  let panState = null, pinchState = null;
  const midOf = m => { const p = [...m.values()]; return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 }; };
  const distOf = m => { const p = [...m.values()]; return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); };

  stage.addEventListener("pointerdown", e => {
    if (e.target.closest(".piece")) return;
    stage.setPointerCapture(e.pointerId);
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (active.size === 1) {
      panState = { startX: e.clientX, startY: e.clientY, originX: panX, originY: panY };
      stage.classList.add("panning");
    } else if (active.size === 2) {
      panState = null;
      pinchState = { lastDist: distOf(active), lastMid: midOf(active) };
    }
  }, { signal });

  stage.addEventListener("pointermove", e => {
    if (!active.has(e.pointerId)) return;
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (active.size === 2) {
      const mid = midOf(active), dist = distOf(active);
      if (pinchState) {
        const rect = stage.getBoundingClientRect();
        const oldCx = pinchState.lastMid.x - rect.left, oldCy = pinchState.lastMid.y - rect.top;
        const wx = (oldCx - panX) / zoom, wy = (oldCy - panY) / zoom;
        zoom = clamp(zoom * (dist / pinchState.lastDist), ZOOM_MIN, ZOOM_MAX);
        const newCx = mid.x - rect.left, newCy = mid.y - rect.top;
        panX = newCx - wx * zoom;
        panY = newCy - wy * zoom;
        applyWorldTransform();
      }
      pinchState = { lastDist: dist, lastMid: mid };
    } else if (active.size === 1 && panState) {
      panX = panState.originX + (e.clientX - panState.startX);
      panY = panState.originY + (e.clientY - panState.startY);
      applyWorldTransform();
    }
  }, { signal });

  function endPointer(e) {
    active.delete(e.pointerId);
    if (active.size === 1) {
      const [, p] = [...active.entries()][0];
      panState = { startX: p.x, startY: p.y, originX: panX, originY: panY };
      pinchState = null;
    } else if (active.size === 0) {
      panState = null; pinchState = null;
      stage.classList.remove("panning");
    }
  }
  stage.addEventListener("pointerup", endPointer, { signal });
  stage.addEventListener("pointercancel", endPointer, { signal });

  $(root, "#zoomInBtn").addEventListener("click", () => {
    const r = stage.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25);
  }, { signal });
  $(root, "#zoomOutBtn").addEventListener("click", () => {
    const r = stage.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 0.8);
  }, { signal });
  $(root, "#zoomResetBtn").addEventListener("click", fitView, { signal });
  window.addEventListener("resize", fitView, { signal });

  function updateProgressLabel(placed, total) {
    progressEl.innerHTML = "";
    const b = document.createElement("b");
    b.textContent = `${placed}/${total}`;
    progressEl.append(b, document.createTextNode(" деталей собрано"));
  }
  function updatePresence(members) {
    presenceEl.innerHTML = "";
    for (const m of members || []) {
      const chip = document.createElement("span");
      chip.className = "presence-chip";
      chip.textContent = m.name || "участник";
      presenceEl.appendChild(chip);
    }
  }
  function showWin() {
    const overlay = document.createElement("div");
    overlay.className = "win-overlay";
    const card = document.createElement("div");
    card.className = "win-card";
    const h2 = document.createElement("h2"); h2.textContent = "Готово!";
    const p = document.createElement("p"); p.textContent = `Пазл «${puzzle.title}» собран вместе с друзьями.`;
    const btn = document.createElement("button");
    btn.className = "btn filled"; btn.type = "button"; btn.textContent = "Отлично";
    btn.addEventListener("click", () => overlay.remove());
    card.append(h2, p, btn);
    overlay.appendChild(card);
    stage.appendChild(overlay);
  }

  /* ── перетаскивание детали: локально сразу, серверу — троттлингом ── */
  const draggingKeys = new Set(); // детали, которые СЕЙЧАС тащит локальный пользователь — resync их не трогает
  let pieces; // Map "r,c" -> piece, строится в buildBoard() по первому sync

  function bindRoomPieceDrag(el, piece, sendMove, sendPlace) {
    let dragging = null;
    const key = `${piece.r},${piece.c}`;

    el.addEventListener("pointerdown", e => {
      if (piece.placed) return;
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      dragging = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, originX: piece.x, originY: piece.y };
      draggingKeys.add(key);
      el.classList.add("dragging");
    }, { signal });

    el.addEventListener("pointermove", e => {
      if (!dragging || e.pointerId !== dragging.pointerId) return;
      piece.x = dragging.originX + (e.clientX - dragging.startX) / zoom;
      piece.y = dragging.originY + (e.clientY - dragging.startY) / zoom;
      applyPieceTransform(piece);
      sendMove(piece);
    }, { signal });

    function finish(e) {
      if (!dragging || e.pointerId !== dragging.pointerId) return;
      dragging = null;
      el.classList.remove("dragging");
      const dist = Math.hypot(piece.x - piece.target.x, piece.y - piece.target.y);
      if (dist < CELL * 0.28) {
        piece.x = piece.target.x; piece.y = piece.target.y; piece.placed = true;
        applyPieceTransform(piece);
        el.classList.add("placed", "just-snapped");
        setTimeout(() => el.classList.remove("just-snapped"), 600);
        sendPlace(piece);
      } else {
        sendMove(piece);
      }
      draggingKeys.delete(key);
    }
    el.addEventListener("pointerup", finish, { signal });
    el.addEventListener("pointercancel", finish, { signal });
  }

  function reconcilePiece(r, c, x, y, placed) {
    const key = `${r},${c}`;
    if (draggingKeys.has(key)) return;
    const piece = pieces.get(key);
    if (!piece) return;
    piece.x = x; piece.y = y;
    if (placed !== undefined) piece.placed = placed;
    applyPieceTransform(piece);
    piece.el.classList.toggle("placed", !!piece.placed);
  }

  function buildBoard(initialPieces) {
    pieces = new Map();
    let scatterIdx = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const target = { x: BOARD_X + c * CELL - pad, y: BOARD_Y + r * CELL - pad };
        const known = initialPieces && initialPieces.find(p => p.r === r && p.c === c);
        let x, y, placed;
        if (known) { x = known.x; y = known.y; placed = !!known.placed; }
        else { const cell = scatter.cells[scatterIdx++]; x = cell.x; y = cell.y; placed = false; }
        pieces.set(`${r},${c}`, { r, c, x, y, placed, target });
      }
    }

    const sendMove = throttle(p => socket.send({ type: "move", r: p.r, c: p.c, x: p.x, y: p.y }), 70);
    const sendPlace = p => socket.send({ type: "place", r: p.r, c: p.c, x: p.x, y: p.y });

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const piece = pieces.get(`${r},${c}`);
        const el = createPieceEl(puzzle.id, r, c, rows, cols, CELL, pad, edges, puzzle.imageUrl, boardW, boardH);
        piece.el = el;
        applyPieceTransform(piece);
        if (piece.placed) el.classList.add("placed");
        world.appendChild(el);
        bindRoomPieceDrag(el, piece, sendMove, sendPlace);
      }
    }
    updateProgressLabel([...pieces.values()].filter(p => p.placed).length, rows * cols);

    // Раскладку никто не задал — эту раскладку и предлагаем как каноническую
    // (см. план: "первый валидный init побеждает", гонка самоисцеляется).
    if (!initialPieces) {
      socket.send({ type: "init", pieces: [...pieces.values()].map(p => ({ r: p.r, c: p.c, x: p.x, y: p.y, placed: p.placed })) });
    }
  }

  function handleSocketMessage(msg) {
    if (msg.type === "sync") {
      if (!pieces) return void buildBoard(msg.pieces);
      if (msg.pieces) for (const p of msg.pieces) reconcilePiece(p.r, p.c, p.x, p.y, p.placed);
      updateProgressLabel(msg.piecesPlaced, msg.piecesTotal);
      updatePresence(msg.members);
      return;
    }
    if (msg.type === "presence") return updatePresence(msg.members);
    if (msg.type === "move") return reconcilePiece(msg.r, msg.c, msg.x, msg.y, undefined);
    if (msg.type === "place") {
      reconcilePiece(msg.r, msg.c, msg.x, msg.y, true);
      const p = pieces.get(`${msg.r},${msg.c}`);
      if (p && p.el) { p.el.classList.add("just-snapped"); setTimeout(() => p.el.classList.remove("just-snapped"), 600); }
      updateProgressLabel(msg.piecesPlaced, msg.piecesTotal);
      if (msg.completed) showWin();
    }
  }

  const socket = connectRoomSocket({
    roomId, sessionId, signal,
    onMessage: handleSocketMessage,
    onOpen: () => { progressEl.classList.remove("offline"); },
    onClose: () => { progressEl.classList.add("offline"); },
  });
}

/* ───────────────────────── роутер ───────────────────────── */
function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const tableMatch = hash.match(/^\/table\/(.+)$/);
  const roomTableMatch = hash.match(/^\/room\/([^/]+)\/table\/([^/]+)$/);
  const roomJoinMatch = hash.match(/^\/rooms\/join\/([^/]+)$/);
  const roomMatch = hash.match(/^\/room\/([^/]+)$/);
  const root = document.getElementById("app");

  if (currentRouteAbort) currentRouteAbort.abort();
  currentRouteAbort = new AbortController();
  const signal = currentRouteAbort.signal;

  const run = roomTableMatch
    ? renderRoomTable(root, decodeURIComponent(roomTableMatch[1]), decodeURIComponent(roomTableMatch[2]), signal)
    : roomJoinMatch ? renderRoomJoin(root, decodeURIComponent(roomJoinMatch[1]), signal)
    : roomMatch ? renderRoom(root, decodeURIComponent(roomMatch[1]), signal)
    : hash === "/rooms" ? renderRoomsList(root, signal)
    : tableMatch ? renderTable(root, decodeURIComponent(tableMatch[1]), signal)
    : renderLibrary(root, signal);
  run.catch(e => {
    if (signal.aborted) return;
    console.error(e);
    root.innerHTML = '<p class="state-note">Что-то пошло не так — обновите страницу.</p>';
  });
}
window.addEventListener("hashchange", route);

/* ───────────────────────── старт ───────────────────────── */
async function init() {
  const cfg = await (await fetch("/api/config")).json();
  auth = createAuthClient({ authBase: cfg.authBase, clientId: cfg.clientId, storagePrefix: "bh_puzzle" });
  // Обязательно ДО первого запроса к своему API: обменивает ?code=… на токены.
  // Принудительного редиректа на вход НЕТ — гостевой режим полноценный
  // (см. README «Идея в двух режимах»).
  await auth.handleRedirect();
  renderAuthArea();
  // Код приглашения, отложенный при уходе на вход из renderRoomJoin
  // (см. там же) — редирект в auth теряет хэш, поэтому переносим отдельно
  // через sessionStorage и после возврата уводим на экран вступления заново.
  const pendingJoin = sessionStorage.getItem("bh_puzzle_pending_join");
  if (pendingJoin && auth.isAuthenticated()) {
    sessionStorage.removeItem("bh_puzzle_pending_join");
    location.hash = `#/rooms/join/${pendingJoin}`;
  }
  route();
}
init().catch(e => {
  console.error(e);
  document.getElementById("app").innerHTML = '<p class="state-note">Не удалось запуститься — обновите страницу.</p>';
});
