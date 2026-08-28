"use strict";
/**
 * «Что собираем?» — фронт: хэш-роутер (библиотека / стол), вход через SSO
 * необязателен — гость играет во встроенные пазлы без сохранения (см.
 * README.md, «Идея в двух режимах»). Формы деталей — assets/puzzle-shapes.js,
 * геометрия проверена на пиксель-точное совпадение соседних рёбер (см. план).
 */

let auth = null;
let puzzlesCache = new Map(); // ключ — roomId ("" для соло), см. getPuzzles()
let currentRouteAbort = null;

const $ = (root, sel) => root.querySelector(sel);
const CELL = 100;          // размер ячейки сетки в «мировых» пикселях (масштаб — зумом), должно совпадать с CELL в server.js
const PAD_FACTOR = 0.4;    // тот же коэффициент, что зашит в buildPiecePath — держим один здесь и там
const SNAP_TOLERANCE = window.PuzzleClusters.tolerance(CELL); // допуск стыковки — общий модуль с сервером
const MAX_ACTIVE_SESSIONS_PER_ROOM = 5; // только для текста ошибки лимита — сервер решает сам, см. playVariant

/* ───────────────────────── тема приложения ─────────────────────────
 * Общий переключатель светлой/тёмной темы (data-theme на <html>) — тот же
 * приём, что и во всех остальных сервисах BurningHouse (Movies/Trip/
 * Финансы/Brain). НЕ путать с #boardThemeBtn/.light-board на столе ниже —
 * та кнопка переключает ТОЛЬКО фон игрового стола, а не тему всего
 * приложения; обе кнопки остаются, это разные вещи. Puzzle's $ — по
 * селектору внутри корня (см. выше), для элементов шапки, которые вне
 * #app и живут в DOM всегда, используем document.getElementById напрямую. */
const SUN = '<svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg class="icon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("puzzle.theme", theme);
  document.getElementById("themeBtn").innerHTML = theme === "dark" ? SUN : MOON;
}
document.getElementById("themeBtn").onclick = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
applyTheme(localStorage.getItem("puzzle.theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));

/* ───────────────────────── установка как PWA ─────────────────────────
 * Chrome/Edge не показывают системный баннер установки сами — вместо этого
 * шлют beforeinstallprompt и ждут явного вызова .prompt() из интерфейса.
 * Событие приходит только если manifest.json уже валиден (иконки/start_url/
 * display) — до этого кнопка просто остаётся скрытой, никакой отдельной
 * фиче-детекции не нужно. Уже запущенное как приложение окно (display-mode:
 * standalone) событие не получает вовсе — на всякий случай прячем кнопку
 * и в этом случае тоже явно. */
let deferredInstallPrompt = null;
const installBtn = document.getElementById("installBtn");
if (!matchMedia("(display-mode: standalone)").matches) {
  window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installBtn.hidden = false;
  });
}
installBtn.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  installBtn.hidden = true;
  const prompt = deferredInstallPrompt;
  deferredInstallPrompt = null;
  prompt.prompt();
  await prompt.userChoice; // outcome нас не интересует — кнопку в любом случае прячем
});
window.addEventListener("appinstalled", () => { installBtn.hidden = true; deferredInstallPrompt = null; });

/* ───────────────────────── модалки: общий каркас ─────────────────────────
 * Дословно как в Movies (не завязано на специфику сервиса) — подложка на
 * весь экран + карточка по центру, закрытие по крестику/клику по подложке. */
let openModalId = null; // id открытого .modal-backdrop
function openModal(backdropId) {
  document.getElementById(backdropId).classList.remove("hidden");
  document.body.classList.add("modal-open");
  openModalId = backdropId;
}
function closeModal(backdropId) {
  const b = document.getElementById(backdropId);
  if (!b || b.classList.contains("hidden")) return;
  b.classList.add("hidden");
  document.body.classList.remove("modal-open");
  if (openModalId === backdropId) openModalId = null;
}
function bindModal(backdropId, openBtnId, closeBtnId) {
  if (openBtnId) document.getElementById(openBtnId).onclick = () => openModal(backdropId);
  if (closeBtnId) document.getElementById(closeBtnId).onclick = () => closeModal(backdropId);
  document.getElementById(backdropId).addEventListener("click", e => {
    if (e.target === document.getElementById(backdropId)) closeModal(backdropId);
  });
}

/* ───────────────────────── модалка выбора сложности ─────────────────────────
 * Общая на все карточки пазлов (библиотека и комната), не привязана к
 * конкретному рендеру — buildCard() ниже всегда показывает одну кнопку
 * «За стол»; если у пазла больше одного уровня сложности, клик открывает
 * эту модалку с выпадающим списком, выбор происходит ПОСЛЕ клика на «За
 * стол», а не вместо него (раньше — ряд мелких кнопок прямо на карточке). */
let pendingDifficultyChoice = null; // {variants, onPlay} между открытием модалки и подтверждением выбора
function openDifficultyModal(title, variants, onPlay) {
  document.getElementById("difficultyModalTitle").textContent = `Выберите сложность — «${title}»`;
  const select = document.getElementById("difficultySelect");
  select.innerHTML = "";
  variants.forEach((v, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = DIFFICULTY_LABELS[i] || `${v.gridRows * v.gridCols} деталей`;
    select.appendChild(opt);
  });
  document.getElementById("difficultyAsymmetric").checked = false; // не запоминаем между открытиями — осознанный выбор каждый раз
  pendingDifficultyChoice = { variants, onPlay };
  openModal("difficultyModalBackdrop");
}
bindModal("difficultyModalBackdrop", null, "difficultyModalClose");
document.getElementById("difficultyPlayBtn").addEventListener("click", () => {
  if (!pendingDifficultyChoice) return;
  const { variants, onPlay } = pendingDifficultyChoice;
  const idx = Number(document.getElementById("difficultySelect").value);
  const asymmetric = document.getElementById("difficultyAsymmetric").checked;
  closeModal("difficultyModalBackdrop");
  pendingDifficultyChoice = null;
  onPlay(variants[idx], asymmetric);
});

/* ───────────────────────── хранилище гостя ───────────────────────── */
const localKey = id => `puzzle_progress_${id}`;
function localProgress(id) {
  try { return JSON.parse(localStorage.getItem(localKey(id)) || "null"); } catch { return null; }
}

/* ───────────────────────── общие данные ───────────────────────── */
// Кэш по ключу roomId (пустая строка — соло/без комнаты): свои фото видны
// только в комнате, где загружены (см. server.js, ALTER TABLE room_id) —
// общий кэш без ключа отдавал бы список одной комнаты в другую.
async function getPuzzles(roomId) {
  const key = roomId || "";
  if (puzzlesCache.has(key)) return puzzlesCache.get(key);
  const qs = roomId ? `?roomId=${encodeURIComponent(roomId)}` : "";
  const res = await roomFetch(`/api/puzzles${qs}`);
  if (!res.ok) throw new Error("puzzles fetch failed");
  const data = await res.json();
  puzzlesCache.set(key, data);
  return data;
}

// По индексу, не по точному числу деталей: gridForPieceTarget округляет
// rows/cols независимо, поэтому реальный total у пресета «108» иногда
// получается 104 или 112 — сверка по значению иногда промахивалась бы
// мимо ярлыка. variants всегда отсортирован по возрастанию и всегда
// получен из PIECE_PRESETS в этом порядке, так что порядковый номер
// надёжнее самого числа деталей.
const DIFFICULTY_LABELS = ["Легко", "Средне", "Сложно", "Эксперт", "Мастер", "Легенда"];

/** Сводит отдельные строки-варианты одной загрузки (общий imageUrl +
 *  владелец) в одну карточку с массивом .variants, отсортированным от
 *  лёгкого к сложному. У встроенных пазлов (ownerUserId нет) — группа
 *  из одного варианта, там ничего не меняется внешне. */
function groupPuzzles(list) {
  const groups = new Map();
  for (const p of list) {
    // imageUrl всегда, не p.id: у встроенных пазлов (Холмы/Лес/Горы) теперь
    // тоже несколько уровней сложности (см. server.js, BUILTIN_IMAGES), у
    // каждого свой уникальный id, но общий imageUrl — тот же общий ключ
    // группировки, что уже работал для своих фото.
    const key = p.ownerUserId ? `${p.ownerUserId}:${p.imageUrl}` : p.imageUrl;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return [...groups.values()].map(variants => {
    variants.sort((a, b) => a.gridRows * a.gridCols - b.gridRows * b.gridCols);
    return { ...variants[0], variants };
  });
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

/** Комнаты работают и без входа (см. server.js/getOrCreateAnonIdentity) —
 *  anonymous identity живёт в HttpOnly cookie, не в JWT, поэтому
 *  auth.fetch (бросает AuthRequiredError без токена, assets/auth-client.js)
 *  для комнатных запросов не годится анониму. Обычный fetch на
 *  same-origin сам шлёт cookies, ничего дополнительно прокидывать не
 *  нужно. НЕ использовать для того, что реально требует входа (загрузка
 *  своих фото — uploadPuzzlePhoto ниже остаётся на auth.fetch). */
function roomFetch(url, opts) {
  return auth.isAuthenticated() ? auth.fetch(url, opts) : fetch(url, opts);
}

async function uploadPuzzlePhoto(file, title, roomId) {
  const { blob, width, height } = await shrinkForPuzzle(file);
  const qs = new URLSearchParams({ w: String(width), h: String(height), title: title || "Мой пазл", roomId });
  const res = await auth.fetch(`/api/puzzles?${qs}`, {
    method: "POST", headers: { "Content-Type": blob.type || "image/jpeg" }, body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "upload failed");
  puzzlesCache.clear(); // библиотека изменилась — старый кэш врёт
  return data;
}

/** POST /api/rooms/:id/sessions с готовой обработкой гонки (кто-то уже
 *  начал сеанс раньше) — редиректит на уже существующий вместо ошибки.
 *  Общий код для пикера, формы загрузки, экрана «уже собран» и истории. */
async function startRoomSession(roomId, puzzleId, asymmetric) {
  const res = await roomFetch(`/api/rooms/${encodeURIComponent(roomId)}/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ puzzleId, asymmetric: !!asymmetric }),
  });
  const data = await res.json();
  if (res.status === 409 && data.session) return data.session.id;
  if (!res.ok) {
    const err = new Error(data.error || "start session failed");
    if (typeof data.limit === "number") err.limit = data.limit;
    throw err;
  }
  return data.id;
}

async function deletePuzzle(id) {
  const res = await auth.fetch(`/api/puzzles/${encodeURIComponent(id)}`, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || "delete failed");
  puzzlesCache.clear();
}

/** Скрывает встроенный пазл (все уровни сложности сразу — variants) ИМЕННО
 *  в этой комнате — не удаляет его самого, он остаётся видимым во всех
 *  остальных комнатах и в соло-библиотеке (см. server.js, room_hidden_puzzles).
 *  Своих фото это не касается — для них есть настоящее удаление, deletePuzzle
 *  выше. */
async function hidePuzzleInRoom(roomId, variants) {
  await Promise.all(variants.map(v => roomFetch(
    `/api/rooms/${encodeURIComponent(roomId)}/hidden-puzzles`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ puzzleId: v.id }) },
  )));
  puzzlesCache.clear();
}

/** DELETE /api/rooms/:id/sessions/:sessionId — освобождает слот из лимита
 *  MAX_ACTIVE_SESSIONS_PER_ROOM (активный, но пустой сеанс) или убирает
 *  завершённый сеанс из истории. Сервер отбивает 409-м, если сеанс сейчас
 *  активный и за столом реально кто-то есть — тогда бросаем понятную ошибку,
 *  вызывающий код (renderRoom) ловит её текстом. */
async function deleteRoomSession(roomId, sessionId) {
  const res = await roomFetch(`/api/rooms/${encodeURIComponent(roomId)}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  if (res.status === 409) throw new Error("table not empty");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "delete session failed");
}

/** DELETE /api/rooms/:id/members/:userId — только владелец комнаты (сервер
 *  сам это проверяет по member.role, здесь только пробрасываем ошибку). */
async function removeRoomMember(roomId, userId) {
  const res = await roomFetch(`/api/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "remove member failed");
}

/** Вставляет форму загрузки в контейнер, вызывает onDone({title, variants})
 *  при успехе — один аплоад сразу заводит все 4 уровня сложности (см.
 *  README «Свои фото»), выбора числа деталей тут больше нет. Используется
 *  только в пикере комнаты (renderRoom) — своих фото в соло-библиотеке
 *  больше нет (см. renderLibrary). roomId — граница видимости результата
 *  (см. server.js, room_id): фото доступно только за столом ЭТОЙ комнаты. */
function mountUploadForm(container, roomId, onDone) {
  container.innerHTML = `
    <form class="upload-form" id="uploadForm">
      <input class="text-input" id="uploadTitle" type="text" maxlength="80" placeholder="Название — необязательно">
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
      const title = $(form, "#uploadTitle").value.trim();
      const result = await uploadPuzzlePhoto(file, title, roomId);
      onDone(result);
      form.reset();
      submitBtn.disabled = false;
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

/* ───────────────────────── шапка: аккаунт ─────────────────────────
 * Модалка #accountModalBackdrop вместо голого "имя + Выйти" — см. index.html
 * и openModal/closeModal/bindModal выше. Гость видит #headerLoginBtn вместо
 * иконки-человечка (#accountMenuWrap) — видимость переключает эта функция. */
function renderAuthArea() {
  const authed = auth.isAuthenticated();
  document.getElementById("headerLoginBtn").hidden = authed;
  document.getElementById("accountMenuWrap").hidden = !authed;
  if (authed) {
    const user = auth.getUser();
    const label = (user && (user.name || user.username)) || "аккаунт";
    document.getElementById("accountBtn").title = "Аккаунт — " + label;
  }
}
document.getElementById("headerLoginBtn").addEventListener("click", () => auth.login());
document.getElementById("accountBtn").addEventListener("click", () => {
  const user = auth.getUser();
  document.getElementById("accountModalName").textContent = (user && (user.name || user.username)) || "аккаунт";
  document.getElementById("accountModalMeta").textContent = (user && user.email) || "";
  openModal("accountModalBackdrop");
});
bindModal("accountModalBackdrop", null, "accountModalClose");
document.getElementById("accountModalManage").addEventListener("click", () => {
  closeModal("accountModalBackdrop");
  window.open(auth.accountUrl(), "_blank", "noopener");
});
document.getElementById("accountModalLogout").addEventListener("click", () => {
  closeModal("accountModalBackdrop");
  auth.logout();
});

/* ───────────────────────── библиотека ───────────────────────── */
function buildCard(p, opts = {}) {
  const tpl = document.getElementById("tplPuzzleCard");
  const node = tpl.content.firstElementChild.cloneNode(true);
  const img = $(node, "img");
  img.src = p.imageUrl;
  img.alt = p.title;
  $(node, ".puzzle-card-title").textContent = p.title;
  const variants = p.variants || [p];
  $(node, ".puzzle-card-meta").textContent = variants.length > 1
    ? `${variants.length} ${plural(variants.length, "уровень", "уровня", "уровней")} сложности`
    : `${p.gridCols}×${p.gridRows} · ${p.gridCols * p.gridRows} деталей`;
  const mine = p.ownerUserId && auth.isAuthenticated() && auth.getUser()?.id === p.ownerUserId;
  // Встроенный пазл (ownerUserId===null) внутри комнаты (opts.roomId задан
  // только в renderRoom) — можно скрыть из ЭТОЙ комнаты, доступно любому
  // участнику, не только владельцу комнаты (это общая настройка комнаты, не
  // личная вещь). В соло-библиотеке (opts.roomId нет) встроенные пазлы
  // по-прежнему не удаляются никак — крестика там для них не будет.
  const canHideDefault = !p.ownerUserId && opts.roomId && auth.isAuthenticated();
  if ((mine || canHideDefault) && opts.allowDelete !== false) {
    const del = document.createElement("button");
    del.className = "icon-btn xs puzzle-card-delete";
    del.type = "button"; del.title = mine ? "Удалить" : "Скрыть из этой комнаты";
    del.setAttribute("aria-label", del.title);
    del.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    del.addEventListener("click", async ev => {
      ev.stopPropagation();
      if (mine) {
        if (!confirm(`Удалить пазл «${p.title}»?`)) return;
        try { await deletePuzzle(p.id); node.remove(); }
        catch (err) { alert(err.message === "in use" ? "Этим пазлом уже играли в комнате — удалить нельзя." : "Не удалось удалить."); }
      } else {
        if (!confirm(`Скрыть пазл «${p.title}» из этой комнаты? Он останется доступен во всех остальных комнатах и в соло-библиотеке.`)) return;
        try { await hidePuzzleInRoom(opts.roomId, variants); node.remove(); }
        catch { alert("Не удалось скрыть."); }
      }
    });
    const thumb = $(node, ".puzzle-card-thumb");
    thumb.classList.add("has-delete");
    thumb.appendChild(del);
  }
  const playBtn = $(node, ".puzzle-card-play");
  const onPlay = opts.onPlay || ((v, asymmetric) => {
    location.hash = `#/table/${encodeURIComponent(v.id)}${asymmetric ? "?shape=asym" : "?shape=normal"}`;
  });
  // Всегда одна кнопка «За стол» — выбор сложности (если вариантов больше
  // одного) происходит ПОСЛЕ клика, в общей модалке (см. openDifficultyModal
  // выше), не рядом мелких кнопок прямо на карточке.
  playBtn.addEventListener("click", () => {
    if (variants.length > 1) openDifficultyModal(p.title, variants, onPlay);
    else onPlay(variants[0]);
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
  }

  let puzzles;
  try {
    puzzles = await getPuzzles();
  } catch {
    if (!signal.aborted) $(root, "#puzzleGrid").innerHTML = '<p class="state-note">Не удалось загрузить пазлы — обновите страницу.</p>';
    return;
  }
  if (signal.aborted) return;

  // Свои фото — только в комнатах (см. README «Свои фото»), соло-библиотека
  // видит исключительно встроенные пазлы. groupPuzzles сводит все уровни
  // сложности одного изображения (общий imageUrl) в одну карточку — иначе
  // Холмы/Лес/Горы показались бы по 6 раз каждый (см. server.js, BUILTIN_IMAGES).
  const grid = $(root, "#puzzleGrid");
  grid.innerHTML = "";
  const cards = groupPuzzles(puzzles.filter(p => !p.ownerUserId))
    .map(p => { const node = buildCard(p); grid.appendChild(node); return { p, node }; });
  for (const { p, node } of cards) applyBadge(node, p);
}

/* ───────────────────────── стол: раскладка деталей ───────────────────────── */

/**
 * Начальная случайная раскладка вокруг контура доски: сетка ячеек размером
 * с деталь, исключая область самой доски, с лёгким дрожанием (jitter), чтобы
 * детали не стояли идеально ровным строем. Область (margin) при нехватке
 * места под все детали расширяется — так это работает и для 12 деталей, и
 * для 108 без ручной подгонки под каждый пазл.
 *
 * count — сколько ячеек реально нужно (по умолчанию rows*cols, как при
 * начальной раскладке всех деталей). planShuffle передаёт сюда РЕАЛЬНОЕ
 * число одиночных деталей, а не rows*cols — margin растёт, только пока не
 * наберётся нужное количество ячеек именно под них, поэтому при решаффле
 * (когда большая часть уже состыкована и трогать её не нужно) россыпь
 * получается заметно теснее к рамке доски, а не растянутой на весь запас
 * под полный пазл.
 *
 * origin — где РЕАЛЬНО стоит доска в мировых координатах ({x,y}, обычно
 * BOARD_X/BOARD_Y из renderTable/renderRoomTable). Без него (начальная
 * раскладка) доска считается стоящей в (margin,margin) — так было и раньше,
 * margin растёт вместе с "миром", который тогда ещё не существует. С явным
 * origin (решафл: доска давно стоит на месте, мир уже фиксированного
 * размера) сетка кандидатов строится ТЕСНЫМ кольцом вокруг РЕАЛЬНОЙ позиции
 * доски, а не от нуля мировых координат — без этого при меньшем margin
 * (см. выше) кольцо кандидатов оставалось привязано к margin=0 в углу
 * мира, а не к настоящей доске, и россыпь после решафла оказывалась не
 * вокруг доски, а смещённой к краю мира (баг: "решафл собирает левее
 * рамки").
 */
function scatterLayout(rows, cols, cell, pad, count = rows * cols, origin = null) {
  const pieceSize = cell + 2 * pad;
  const boardW = cols * cell, boardH = rows * cell;
  const total = count;
  let margin = pieceSize * 1.4;
  let cells = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    const step = pieceSize * 1.08;
    const originX = origin ? origin.x : margin, originY = origin ? origin.y : margin;
    const bx0 = originX - pad * 0.3, bx1 = originX + boardW + pad * 0.3;
    const by0 = originY - pad * 0.3, by1 = originY + boardH + pad * 0.3;
    const gx0 = origin ? Math.max(0, Math.floor((originX - margin) / step)) : 0;
    const gy0 = origin ? Math.max(0, Math.floor((originY - margin) / step)) : 0;
    const gx1 = origin ? Math.ceil((originX + boardW + margin) / step) : Math.max(1, Math.floor((boardW + 2 * margin) / step));
    const gy1 = origin ? Math.ceil((originY + boardH + margin) / step) : Math.max(1, Math.floor((boardH + 2 * margin) / step));
    cells = [];
    for (let gy = gy0; gy < gy1; gy++) {
      for (let gx = gx0; gx < gx1; gx++) {
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
  const originX = origin ? origin.x : margin, originY = origin ? origin.y : margin;
  return { margin, worldW: originX + boardW + margin, worldH: originY + boardH + margin, cells: picked };
}
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/* ───────────────────────── стол: кластеры (связи вместо фиксированного места) ─────────────────────────
 * Кластер нигде не хранится явно — выводится заново из raw {r,c,x,y} через
 * assets/puzzle-clusters.js (общий модуль с сервером) на каждое значимое
 * событие. Счётчик "собрано" = сумма деталей во ВСЕХ кластерах от двух и
 * больше (connectedPiecesCount) — деталь, состыкованная хоть с кем-то,
 * засчитывается сразу, не только когда её кусок дорастёт до самого
 * большого сегмента. "Пазл решён целиком" — отдельная, более строгая
 * проверка (largestClusterSize === total, см. isPuzzleSolved ниже), не
 * путать с этим счётчиком. */

/** Счётчик "собрано" для интерфейса — заменяет старое
 *  [...pieces.values()].filter(p=>p.placed).length. */
function computePiecesPlaced(pieces, cell, tol) {
  return window.PuzzleClusters.connectedPiecesCount(window.PuzzleClusters.buildClusters(pieces.values(), cell, tol).members);
}

/** "Пазл целиком собран" — ВСЕ детали в одном кластере, а не просто у
 *  каждой есть сосед где-то на борде (это отдельно, см. computePiecesPlaced
 *  выше). Используется там, где решается "показать ли победу". */
function isPuzzleSolved(pieces, cell, tol, total) {
  return window.PuzzleClusters.largestClusterSize(window.PuzzleClusters.buildClusters(pieces.values(), cell, tol).members) >= total;
}

function edgeId(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }
function clusterEdgeIds(edges) {
  const set = new Set();
  for (const [a, b] of edges) set.add(edgeId(a, b));
  return set;
}
/** Вспышка "just-snapped" на КАЖДОЕ новое ребро кластерного графа — сравнение
 *  с набором id рёбер от прошлого пересчёта (prevIds), не поштучная проверка
 *  расстояния до target (target у детали больше нет). Возвращает новый набор
 *  id (для следующего сравнения) и число добавившихся рёбер — по нему
 *  bindRoomPieceDrag решает, слать move или group (см. план). */
function flashClusterEdges(pieces, prevIds, edges) {
  const nextIds = clusterEdgeIds(edges);
  let newCount = 0;
  for (const [a, b] of edges) {
    const id = edgeId(a, b);
    if (prevIds.has(id)) continue;
    newCount++;
    for (const k of [a, b]) {
      const p = pieces.get(k);
      if (!p || !p.el) continue;
      p.el.classList.add("just-snapped");
      setTimeout(() => p.el.classList.remove("just-snapped"), 600);
    }
  }
  return { nextIds, newCount };
}

/** Ключи всей связанной группы, в которую входит key (см. buildClusters) —
 *  клик по одной детали выделяет весь уже собранный сегмент целиком, а не
 *  только саму деталь: тащить всё равно будет весь кластер (см. groupSet в
 *  pointerdown), выделение теперь просто отражает это заранее, а не только
 *  во время самого драга. */
function clusterMembersOf(pieces, key) {
  const { clusterOf, members } = window.PuzzleClusters.buildClusters(pieces.values(), CELL, SNAP_TOLERANCE);
  return members.get(clusterOf.get(key));
}

/** «Перемешать» с учётом кластеров: ЛЮБОЙ уже состыкованный кластер (от двух
 *  деталей — это уже прогресс, не только самый большой) не трогаем,
 *  расшвыриваем только одиночные, ещё ни с кем не соединённые детали.
 *  Раскладка под них считается по их реальному числу (scatterLayout(...,
 *  count)), не по rows*cols — россыпь ложится плотнее к рамке доски, а не
 *  на весь запас места под полный пазл. boardX/boardY — РЕАЛЬНАЯ позиция
 *  доски в мировых координатах (BOARD_X/BOARD_Y у вызывающего) — без неё
 *  scatterLayout считала бы, что доска стоит в (margin,margin) с НОВЫМ,
 *  обычно куда меньшим margin, чем настоящий — россыпь оказывалась смещена
 *  относительно реальной доски (баг «решафл собирает левее рамки»).
 *  Возвращает Map "r,c" -> {x,y} новых позиций или null, если мешать
 *  нечего (все детали уже хоть с кем-то состыкованы). */
function planShuffle(pieces, rows, cols, cell, pad, tol, boardX, boardY) {
  const { members } = window.PuzzleClusters.buildClusters(pieces.values(), cell, tol);
  const toScatter = [...members.values()].filter(keys => keys.size <= 1);
  if (!toScatter.length) return null;

  const fresh = scatterLayout(rows, cols, cell, pad, toScatter.length, { x: boardX, y: boardY });
  const next = new Map();
  toScatter.forEach((keys, i) => {
    const [key] = keys;
    const anchor = fresh.cells[Math.min(i, fresh.cells.length - 1)];
    next.set(key, { x: anchor.x, y: anchor.y });
  });
  return next;
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

  const wrap = document.createElement("div");
  wrap.className = "piece";
  wrap.style.width = size + "px";
  wrap.style.height = size + "px";
  wrap.dataset.r = String(r);
  wrap.dataset.c = String(c);
  wrap.appendChild(svg);
  // <image> внутри — по умолчанию нативно перетаскиваемый браузером элемент
  // (как обычная картинка): при достаточно долгом/дальнем драге (особенно
  // заметно у групп — жест длиннее) браузер может перехватить его в СВОЙ
  // HTML5 drag-and-drop поверх нашего pointer-based — курсор "нельзя"
  // означает именно это, а не что-то в bindPieceDrag. dragstart тут не
  // связан с Pointer Events вообще, глушим его отдельно.
  wrap.addEventListener("dragstart", e => e.preventDefault());
  return wrap;
}

function applyPieceTransform(piece) {
  piece.el.style.transform = `translate(${piece.x}px, ${piece.y}px)`;
}

/** Превью-картинка «как должно получиться» на столе — раньше была чисто
 *  декоративной подсказкой (pointer-events:none, фиксированные место и
 *  размер в углу), теперь плавающая панель: можно оттащить с дороги и
 *  подрастянуть, если мелко видно детали. Общая для соло и комнаты — это
 *  чисто локальный UI, сети не касается (в отличие от bindPieceDrag/
 *  bindRoomPieceDrag, которые из-за этого разделены). Живёт прямо в
 *  .table-stage, а не в #world — панорама/зум доски (translate+scale на
 *  #world) на неё не действует, поэтому дельты драга/резайза берутся в
 *  чистых экранных пикселях, без деления на zoom. */
function bindPreviewThumb(stage, panel, img, handle, toggleBtn, imageUrl, title, signal) {
  img.src = imageUrl;
  img.alt = `Как должно получиться: ${title}`;

  const MIN_W = 96;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  toggleBtn.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
  }, { signal });

  let drag = null;
  img.addEventListener("pointerdown", e => {
    e.stopPropagation(); // не даём фону начать панораму стола
    img.setPointerCapture(e.pointerId);
    const box = panel.getBoundingClientRect(), sBox = stage.getBoundingClientRect();
    drag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, startLeft: box.left - sBox.left, startTop: box.top - sBox.top };
  }, { signal });
  img.addEventListener("pointermove", e => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const sBox = stage.getBoundingClientRect(), box = panel.getBoundingClientRect();
    panel.style.left = `${clamp(drag.startLeft + (e.clientX - drag.startX), 0, sBox.width - box.width)}px`;
    panel.style.top = `${clamp(drag.startTop + (e.clientY - drag.startY), 0, sBox.height - box.height)}px`;
  }, { signal });
  function finishDrag(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag = null;
  }
  img.addEventListener("pointerup", finishDrag, { signal });
  img.addEventListener("pointercancel", finishDrag, { signal });
  img.addEventListener("lostpointercapture", finishDrag, { signal });

  let resize = null;
  handle.addEventListener("pointerdown", e => {
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    resize = { pointerId: e.pointerId, startX: e.clientX, startWidth: panel.getBoundingClientRect().width };
  }, { signal });
  handle.addEventListener("pointermove", e => {
    if (!resize || e.pointerId !== resize.pointerId) return;
    const maxW = stage.getBoundingClientRect().width * 0.9;
    panel.style.width = `${clamp(resize.startWidth + (e.clientX - resize.startX), MIN_W, maxW)}px`;
  }, { signal });
  function finishResize(e) {
    if (!resize || e.pointerId !== resize.pointerId) return;
    resize = null;
  }
  handle.addEventListener("pointerup", finishResize, { signal });
  handle.addEventListener("pointercancel", finishResize, { signal });
  handle.addEventListener("lostpointercapture", finishResize, { signal });
}

async function renderTable(root, puzzleId, signal, queryString) {
  root.innerHTML = `
    <div class="table-screen">
      <div class="table-toolbar">
        <strong id="tableTitle"></strong>
        <div class="spacer"></div>
        <span class="table-progress" id="tableProgress"></span>
      </div>
      <div class="table-stage" id="stage">
        <div class="table-world" id="world"></div>
        <div class="marquee-select" id="marqueeSelect" hidden></div>
        <div class="preview-panel" id="previewPanel" hidden>
          <img class="preview-thumb" id="previewThumb" alt="">
          <div class="preview-resize-handle" id="previewResizeHandle" title="Изменить размер" aria-hidden="true"></div>
        </div>
        <!-- «Назад» — была текстовой ссылкой «← Библиотека» в .table-toolbar,
             теперь иконка в левом верхнем углу доски (не в .board-tools внизу
             — выход со стола не инструмент сборки). -->
        <div class="board-back">
          <a class="btn outlined icon" href="#/" title="Библиотека" aria-label="Библиотека">
            <svg class="icon" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>
          </a>
        </div>
        <!-- Кнопки действий стола — всегда иконками (не только на мобильном,
             см. план п.4), в своей плашке в стиле .zoom-controls, но в другом
             углу, чтобы не пересекаться ни с ним, ни с .preview-thumb. -->
        <div class="board-tools">
          <button class="btn outlined icon" id="shuffleBtn" type="button" title="Перемешать" aria-label="Перемешать">
            <svg class="icon" viewBox="0 0 24 24"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>
          </button>
          <button class="btn outlined icon" id="previewBtn" type="button" title="Показать картинку" aria-label="Показать картинку">
            <svg class="icon" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
          </button>
          <button class="btn outlined icon" id="boardThemeBtn" type="button" title="Светлый фон" aria-label="Светлый фон">
            <svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 1 0 20z" fill="currentColor" stroke="none"/></svg>
          </button>
          <!-- На тач-устройствах нет Shift — этот тоггл даёт тот же жест
               (тянуть рамку по пустому месту вместо панорамы), пока включён,
               одним пальцем. На десктопе Shift+тяни работает и без него —
               кнопка просто альтернативный способ включить то же самое. -->
          <button class="btn outlined icon" id="selectModeBtn" type="button" title="Режим выделения" aria-label="Режим выделения" aria-pressed="false">
            <svg class="icon" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="4 3"/></svg>
          </button>
        </div>
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
  if (puzzle.ownerUserId) {
    stage.innerHTML = '<p class="state-note">Пазлы из своих фото собираются только в комнатах. <a class="btn text sm" href="#/rooms">К комнатам</a></p>';
    return;
  }
  $(root, "#tableTitle").textContent = puzzle.title;

  const rows = puzzle.gridRows, cols = puzzle.gridCols;
  const pad = CELL * PAD_FACTOR;
  const boardW = cols * CELL, boardH = rows * CELL;
  // Форма — чисто визуальный выбор конкретной попытки (см. index.html,
  // difficultyAsymmetric), не хранится на сервере для соло — держим в
  // localStorage по puzzleId, чтобы при возврате на уже начатый пазл форма
  // не «прыгала» между обычной и ассиметричной от захода к заходу.
  const shapeKey = `puzzle_shape_${puzzleId}`;
  const asymmetric = queryString
    ? new URLSearchParams(queryString).get("shape") === "asym"
    : localStorage.getItem(shapeKey) === "asym";
  localStorage.setItem(shapeKey, asymmetric ? "asym" : "normal");
  const edges = window.PuzzleShapes.buildEdges(puzzle.seed, rows, cols, { asymmetric });

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
      const savedPiece = saved && Array.isArray(saved.pieces) && saved.pieces.find(pc => pc.r === r && pc.c === c);
      let x, y;
      if (savedPiece) { x = savedPiece.x; y = savedPiece.y; }
      else { const cell = scatter.cells[scatterIdx++]; x = cell.x; y = cell.y; }
      pieces.set(`${r},${c}`, { r, c, x, y });
    }
  }

  const selected = new Set(); // ключи "r,c" — текущее ручное выделение (клик/shift-клик)
  function setSelected(keys) {
    selected.clear();
    for (const k of keys) selected.add(k);
    for (const [k, p] of pieces) p.el.classList.toggle("selected", selected.has(k));
  }

  let lastClusterEdgeIds = new Set(); // "r,c|r,c" — вспышка только на НОВЫХ стыковках

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const piece = pieces.get(`${r},${c}`);
      const el = createPieceEl(puzzle.id, r, c, rows, cols, CELL, pad, edges, puzzle.imageUrl, boardW, boardH);
      piece.el = el;
      applyPieceTransform(piece);
      world.appendChild(el);
      bindPieceDrag(el, piece);
    }
  }
  lastClusterEdgeIds = clusterEdgeIds(window.PuzzleClusters.buildClusters(pieces.values(), CELL, SNAP_TOLERANCE).edges);

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

  /* ── авто-панорама к краю доски во время драга детали ──
     bindPieceDrag ниже двигает деталь только по факту pointermove — если
     курсор/палец замерли у самого края stage, новых событий не будет, а
     доска должна продолжать ехать сама. Поэтому отдельный rAF-тик: пока
     activeDrag не пуст и курсор в приграничной полосе, каждый кадр сам
     двигает panX/panY и пересчитывает мировую позицию детали под
     ПОСЛЕДНИМ известным курсором (screenToWorld) — деталь остаётся
     приклеенной к курсору, а не едет вместе с панорамой (простое "накопить
     дельту от старта драга", как было раньше, не учитывало бы смену panX
     во время автоскролла — деталь укатилась бы мимо курсора). */
  const EDGE_MARGIN = 56, EDGE_MAX_SPEED = 16;
  function screenToWorld(clientX, clientY) {
    const r = stage.getBoundingClientRect();
    return { x: (clientX - r.left - panX) / zoom, y: (clientY - r.top - panY) / zoom };
  }
  let activeDrag = null;
  function applyActiveDragPositions() {
    const w = screenToWorld(activeDrag.lastClientX, activeDrag.lastClientY);
    for (const [k, ox, oy] of activeDrag.offsets) {
      const p = pieces.get(k);
      p.x = w.x + ox; p.y = w.y + oy;
      applyPieceTransform(p);
    }
  }
  let edgePanRAF = null;
  function edgePanTick() {
    if (!activeDrag) { edgePanRAF = null; return; }
    const r = stage.getBoundingClientRect();
    const x = activeDrag.lastClientX - r.left, y = activeDrag.lastClientY - r.top;
    const push = (pos, size) => pos < EDGE_MARGIN ? clamp(1 - pos / EDGE_MARGIN, 0, 1)
      : pos > size - EDGE_MARGIN ? -clamp(1 - (size - pos) / EDGE_MARGIN, 0, 1) : 0;
    const vx = push(x, r.width) * EDGE_MAX_SPEED, vy = push(y, r.height) * EDGE_MAX_SPEED;
    if (vx || vy) {
      panX += vx; panY += vy;
      applyWorldTransform();
      applyActiveDragPositions();
    }
    edgePanRAF = requestAnimationFrame(edgePanTick);
  }
  signal.addEventListener("abort", () => {
    activeDrag = null;
    if (edgePanRAF !== null) { cancelAnimationFrame(edgePanRAF); edgePanRAF = null; }
  });

  stage.addEventListener("wheel", e => {
    e.preventDefault();
    const factor = Math.pow(1.0016, -e.deltaY);
    zoomAt(e.clientX, e.clientY, factor);
  }, { passive: false, signal });

  // Пинч на тач — по активным Pointer ID: деталь останавливает всплытие
  // pointerdown (см. bindPieceDrag), поэтому сюда долетают только жесты по фону.
  const active = new Map();
  let panState = null, pinchState = null, clickCandidate = null;
  const midOf = m => { const p = [...m.values()]; return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 }; };
  const distOf = m => { const p = [...m.values()]; return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); };

  /* ── массовое выделение рамкой (Shift+тяни по пустому месту доски, или
     тоггл #selectModeBtn для тач — там нет Shift) ──
     Обычный (без Shift/тоггла) драг по фону — панорама, как и был; Shift
     или включённый selectMode меняют смысл жеста на «выделить рамкой», по
     аналогии с тем, что Shift+клик по детали уже означает «добавить к
     выделению» (bindPieceDrag/finish) — тут та же клавиша и то же
     значение, просто для множества деталей сразу. Рамка — в экранных
     координатах (пиксели относительно stage), проверка пересечения с
     деталями — в мировых (screenToWorld), поэтому работает корректно на
     любом zoom/pan. */
  let selectMode = false;
  let marqueeState = null; // { pointerId, startX, startY, baseSelected }
  const marqueeEl = $(root, "#marqueeSelect");
  function updateMarqueeRect(x0, y0, x1, y1) {
    const r = stage.getBoundingClientRect();
    marqueeEl.style.left = `${Math.min(x0, x1) - r.left}px`;
    marqueeEl.style.top = `${Math.min(y0, y1) - r.top}px`;
    marqueeEl.style.width = `${Math.abs(x1 - x0)}px`;
    marqueeEl.style.height = `${Math.abs(y1 - y0)}px`;
  }
  function updateMarqueeSelection(x0, y0, x1, y1) {
    const w0 = screenToWorld(Math.min(x0, x1), Math.min(y0, y1));
    const w1 = screenToWorld(Math.max(x0, x1), Math.max(y0, y1));
    const size = CELL + 2 * pad; // полный размер SVG детали (с запасом под выступы), см. createPieceEl
    const next = new Set(marqueeState.baseSelected);
    for (const [k, p] of pieces) {
      if (p.x < w1.x && p.x + size > w0.x && p.y < w1.y && p.y + size > w0.y) next.add(k);
    }
    setSelected(next);
  }

  stage.addEventListener("pointerdown", e => {
    // .zoom-controls (а теперь и .board-tools/.board-back/.win-overlay/
    // .table-give-up) тоже исключаем: иначе setPointerCapture ниже
    // перехватывает указатель на #stage раньше, чем браузер успевает
    // синтезировать click на кнопке — колесо мыши работало (свой отдельный
    // wheel-хендлер), а кнопки +/−/⤢ (и, отдельно найденный тот же баг,
    // кнопки в окне победы) не реагировали на клик вовсе.
    if (e.target.closest(".piece") || e.target.closest(".zoom-controls") || e.target.closest(".board-tools")
      || e.target.closest(".board-back") || e.target.closest(".presence-widget") || e.target.closest(".preview-panel")
      || e.target.closest(".win-overlay") || e.target.closest(".table-give-up")) return;
    stage.setPointerCapture(e.pointerId);
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (active.size === 1) {
      if (e.shiftKey || selectMode) {
        marqueeState = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, baseSelected: new Set(selected) };
        marqueeEl.hidden = false;
        updateMarqueeRect(e.clientX, e.clientY, e.clientX, e.clientY);
        clickCandidate = null;
      } else {
        panState = { startX: e.clientX, startY: e.clientY, originX: panX, originY: panY };
        stage.classList.add("panning");
        clickCandidate = { x: e.clientX, y: e.clientY };
      }
    } else if (active.size === 2) {
      panState = null;
      marqueeState = null;
      marqueeEl.hidden = true;
      pinchState = { lastDist: distOf(active), lastMid: midOf(active) };
      clickCandidate = null;
    }
  }, { signal });

  stage.addEventListener("pointermove", e => {
    if (clickCandidate && Math.hypot(e.clientX - clickCandidate.x, e.clientY - clickCandidate.y) > 4) clickCandidate = null;
    if (!active.has(e.pointerId)) return;
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (marqueeState && e.pointerId === marqueeState.pointerId) {
      updateMarqueeRect(marqueeState.startX, marqueeState.startY, e.clientX, e.clientY);
      updateMarqueeSelection(marqueeState.startX, marqueeState.startY, e.clientX, e.clientY);
      return;
    }
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
    if (marqueeState && e.pointerId === marqueeState.pointerId) {
      marqueeState = null;
      marqueeEl.hidden = true;
      clickCandidate = null;
      return;
    }
    if (active.size === 1) {
      const [, p] = [...active.entries()][0];
      panState = { startX: p.x, startY: p.y, originX: panX, originY: panY };
      pinchState = null;
    } else if (active.size === 0) {
      panState = null; pinchState = null;
      stage.classList.remove("panning");
    }
    if (clickCandidate && selected.size) setSelected([]);
    clickCandidate = null;
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

  bindPreviewThumb(stage, $(root, "#previewPanel"), $(root, "#previewThumb"), $(root, "#previewResizeHandle"), $(root, "#previewBtn"), puzzle.imageUrl, puzzle.title, signal);

  // Светлый фон стола — постоянно фиксированные светлые тона, не тема
  // сайта: тёмная деталь на тёмной (в тёмной теме) доске почти не видна
  // по краям, пока не собрана — переключатель никак не зависит от того,
  // светлая сейчас тема интерфейса или нет.
  $(root, "#boardThemeBtn").addEventListener("click", () => {
    stage.classList.toggle("light-board");
  }, { signal });

  // Тач-замена Shift для рамки выделения — см. комментарий у marqueeState
  // выше. На десктопе не нужна (там уже работает Shift+тяни), но не мешает
  // ей — оба способа включают одно и то же условие в pointerdown.
  $(root, "#selectModeBtn").addEventListener("click", e => {
    selectMode = !selectMode;
    e.currentTarget.setAttribute("aria-pressed", String(selectMode));
  }, { signal });

  $(root, "#shuffleBtn").addEventListener("click", () => {
    // Любую уже состыкованную пару/кластер (не только самый большой) не
    // трогаем — «встряхнуть оставшуюся кучу», а не собрать заново с нуля.
    // Риска потерять прогресс нет, подтверждение (confirm) не нужно.
    const next = planShuffle(pieces, rows, cols, CELL, pad, SNAP_TOLERANCE, BOARD_X, BOARD_Y);
    if (!next) return; // всё уже в одном кластере — мешать нечего
    for (const [k, pos] of next) {
      const p = pieces.get(k);
      p.x = pos.x; p.y = pos.y;
      applyPieceTransform(p);
    }
    scheduleSave();
  }, { signal });

  /* ── перетаскивание детали: группа = объединение кластеров текущего выделения ──
     activeDrag — общее (не per-piece) состояние, см. блок авто-панорамы
     выше: rAF-тику edgePanTick нужно знать о текущем драге независимо от
     того, какая именно деталь его начала. */
  function bindPieceDrag(el, piece) {
    let moved = false;
    const key = `${piece.r},${piece.c}`;

    el.addEventListener("pointerdown", e => {
      e.stopPropagation(); // не даём фону начать панораму
      el.setPointerCapture(e.pointerId);
      moved = false;
      // Клик по детали выделяет весь уже собранный сегмент, в который она
      // входит (не только саму деталь) — тащить всё равно будет весь
      // кластер целиком (groupSet ниже строится тем же buildClusters),
      // выделение теперь отражает это сразу, а не только во время драга.
      const { clusterOf, members } = window.PuzzleClusters.buildClusters(pieces.values(), CELL, SNAP_TOLERANCE);
      if (!(selected.has(key) && selected.size > 1)) setSelected(members.get(clusterOf.get(key)));
      const groupSet = new Set();
      for (const k of selected) for (const m of members.get(clusterOf.get(k))) groupSet.add(m);
      // Смещение каждой детали от мировой точки под курсором в момент
      // начала драга (не от абсолютной позиции детали) — так деталь
      // остаётся под курсором даже если panX/panY поменяются во время
      // драга без единого pointermove (см. edgePanTick).
      const w0 = screenToWorld(e.clientX, e.clientY);
      const offsets = [...groupSet].map(k => {
        const p = pieces.get(k);
        p.el.classList.add("dragging");
        return [k, p.x - w0.x, p.y - w0.y];
      });
      activeDrag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, offsets, draggingKeys: groupSet, lastClientX: e.clientX, lastClientY: e.clientY };
      if (edgePanRAF === null) edgePanRAF = requestAnimationFrame(edgePanTick);
    }, { signal });

    el.addEventListener("pointermove", e => {
      if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
      const dx0 = e.clientX - activeDrag.startX, dy0 = e.clientY - activeDrag.startY;
      if (!moved && Math.hypot(dx0, dy0) > 4) moved = true;
      activeDrag.lastClientX = e.clientX; activeDrag.lastClientY = e.clientY;
      applyActiveDragPositions();
    }, { signal });

    function finish(e) {
      if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
      const { offsets, draggingKeys } = activeDrag;
      activeDrag = null;
      // Отменяем ещё не сработавший кадр авто-панорамы явно, а не ждём,
      // пока edgePanTick сам себя погасит увидев activeDrag===null — иначе
      // при очень быстром повторном драге (новый pointerdown раньше, чем
      // успел прийти предыдущий rAF) сработает "if (edgePanRAF === null)"
      // в pointerdown и НЕ запустит новый цикл, решив, что старый ещё жив.
      if (edgePanRAF !== null) { cancelAnimationFrame(edgePanRAF); edgePanRAF = null; }
      for (const [k] of offsets) pieces.get(k).el.classList.remove("dragging");
      if (!moved) {
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        if (additive) {
          const next = new Set(selected);
          if (next.has(key)) next.delete(key); else next.add(key);
          setSelected(next);
        } else {
          setSelected(clusterMembersOf(pieces, key));
        }
        return;
      }
      window.PuzzleClusters.stitchGroup(pieces, draggingKeys, CELL, SNAP_TOLERANCE);
      for (const k of draggingKeys) applyPieceTransform(pieces.get(k));
      const { members, edges } = window.PuzzleClusters.buildClusters(pieces.values(), CELL, SNAP_TOLERANCE);
      const { nextIds } = flashClusterEdges(pieces, lastClusterEdgeIds, edges);
      lastClusterEdgeIds = nextIds;
      updateProgressLabel(window.PuzzleClusters.connectedPiecesCount(members), rows * cols);
      setSelected([]);
      scheduleSave();
    }
    el.addEventListener("pointerup", finish, { signal });
    el.addEventListener("pointercancel", finish, { signal });
    // Подстраховка от «вечно тащим» (см. расследование бага с прогрессом):
    // pointerup/pointercancel не гарантированно долетают при нештатном
    // завершении жеста (потеря фокуса окна, вкладка свёрнута, ОС перехватила
    // жест) — lostpointercapture по спецификации срабатывает ВСЕГДА, когда
    // элемент теряет захват указателя, каким бы ни был повод, поэтому это
    // надёжная точка для финального finish() и очистки activeDrag.
    el.addEventListener("lostpointercapture", finish, { signal });
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
    // placed:false — wire-формат остаётся для совместимости со старой БД,
    // но клиент нигде не читает это поле обратно, только пишет заглушку.
    const arr = [...pieces.values()].map(p => ({ r: p.r, c: p.c, x: p.x, y: p.y, placed: false }));
    const placed = computePiecesPlaced(pieces, CELL, SNAP_TOLERANCE);
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
      const completedAt = isPuzzleSolved(pieces, CELL, SNAP_TOLERANCE, total) ? ((prev && prev.completedAt) || Date.now()) : null;
      localStorage.setItem(localKey(puzzle.id), JSON.stringify({ ...payload, completedAt }));
      if (completedAt && !announced) { announced = true; showWin(); }
    }
  }
  updateProgressLabel(computePiecesPlaced(pieces, CELL, SNAP_TOLERANCE), rows * cols);
  if (announced) {
    // Уже был собран раньше (пришли на готовый пазл заново) — витрину «Готово»
    // не выскакиваем сразу поверх стола, достаточно бейджа в тулбаре/библиотеке.
  }

  function showWin() {
    const overlay = document.createElement("div");
    overlay.className = "win-overlay";
    const card = document.createElement("div");
    card.className = "win-card";
    const img = document.createElement("img");
    img.className = "win-image"; img.src = puzzle.imageUrl; img.alt = puzzle.title;
    const h2 = document.createElement("h2"); h2.textContent = "Готово!";
    const p = document.createElement("p"); p.textContent = `Пазл «${puzzle.title}» собран.`;
    const actions = document.createElement("div");
    actions.className = "win-actions";
    const stayBtn = document.createElement("button");
    stayBtn.className = "btn outlined"; stayBtn.type = "button"; stayBtn.textContent = "Остаться";
    stayBtn.addEventListener("click", () => overlay.remove());
    const homeBtn = document.createElement("button");
    homeBtn.className = "btn filled"; homeBtn.type = "button"; homeBtn.textContent = "На главную";
    homeBtn.addEventListener("click", () => { location.hash = "#/"; });
    actions.append(stayBtn, homeBtn);
    card.append(img, h2, p, actions);
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
 *  обновит.
 *
 *  Браузерный WebSocket не доносит до JS причину отказа при провале
 *  хэндшейка (403/404/410 от сервера видны как обычный close без кода) —
 *  раньше это значило бесконечный тихий ретрай с вечным "переподключение…"
 *  на экране, даже когда причина никогда не исчезнет сама (не тот сеанс,
 *  доступ отозван и т.п.). MAX_ATTEMPTS — потолок, после которого перестаём
 *  долбиться и явно сообщаем через onGiveUp, а не тонем в ретраях молча. */
function connectRoomSocket({ roomId, sessionId, signal, onMessage, onOpen, onClose, onGiveUp }) {
  let socket = null, attempt = 0, stopped = false;
  const MAX_ATTEMPTS = 8;

  function scheduleRetry() {
    if (stopped || signal.aborted) return;
    attempt++;
    if (attempt > MAX_ATTEMPTS) { onGiveUp && onGiveUp(); return; }
    setTimeout(open, Math.min(10000, 500 * 2 ** attempt));
  }

  async function open() {
    if (stopped || signal.aborted) return;
    // Аноним подключается вообще без токена (auth.getAccessToken() у него
    // всегда пуст — раньше это уводило сюда в бесконечный ретрай) — сервер
    // сам разберётся по cookie puzzle_anon, которую браузер шлёт на
    // апгрейд-запрос сам (см. план «анонимные комнаты»).
    let tokenParam = "";
    if (auth.isAuthenticated()) {
      const token = await auth.getAccessToken();
      if (!token) { scheduleRetry(); return; }
      tokenParam = `?token=${encodeURIComponent(token)}`;
    }
    const url = wsUrlFor(`/ws/rooms/${encodeURIComponent(roomId)}/sessions/${encodeURIComponent(sessionId)}${tokenParam}`);
    socket = new WebSocket(url);
    socket.addEventListener("open", () => { attempt = 0; onOpen && onOpen(); });
    socket.addEventListener("message", e => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      onMessage(msg);
    });
    socket.addEventListener("close", () => {
      onClose && onClose();
      scheduleRetry();
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

/** Ярлыки участников комнаты для списка/presence — анонимным (id с
 *  префиксом "anon:", см. server.js/getOrCreateAnonIdentity) присваиваем
 *  "Гость"/"Гость 2"/… по порядку появления в переданном списке, у
 *  настоящих — имя/логин, как раньше. idKey — поле с идентификатором:
 *  "user_id" у списка участников комнаты (room.members, сырые поля из
 *  SQLite), "id" у presence из WS (см. server.js presenceList). */
function roomMemberLabels(members, idKey) {
  let guestN = 0;
  return members.map(m => {
    if (typeof m[idKey] === "string" && m[idKey].startsWith("anon:")) {
      guestN++;
      return guestN === 1 ? "Гость" : `Гость ${guestN}`;
    }
    return m.name || m.username || "участник";
  });
}

/** Русское склонение по числу — дословно как в Movies (plural). */
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  return b === 1 ? one : many;
}

const ROOMS_PAGE_SIZE = 5;

// Модалки создания/присоединения — статическая разметка в index.html (вне
// #app, как и accountModalBackdrop выше, живёт постоянно) — привязываем
// один раз здесь; кнопки, которые их ОТКРЫВАЮТ (#createRoomOpenBtn/
// #joinRoomOpenBtn), рендерятся заново при каждом заходе на #/rooms — их
// обработчики вешаются внутри renderRoomsList со своим { signal }.
bindModal("createRoomModalBackdrop", null, "createRoomModalClose");
bindModal("joinRoomModalBackdrop", null, "joinRoomModalClose");
// Открывающая кнопка (#addPuzzleBtn) рендерится внутри renderRoom при каждом
// заходе в комнату — та же схема, что у createRoomOpenBtn/joinRoomOpenBtn
// выше: сама модалка статична в index.html и привязывается один раз здесь.
bindModal("uploadPuzzleModalBackdrop", null, "uploadPuzzleModalClose");
document.getElementById("createRoomBtn").addEventListener("click", async () => {
  const input = document.getElementById("newRoomTitle");
  const title = input.value.trim();
  if (!title) return;
  try {
    const res = await roomFetch("/api/rooms", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }),
    });
    if (!res.ok) throw new Error("create room failed");
    const room = await res.json();
    input.value = "";
    closeModal("createRoomModalBackdrop");
    location.hash = `#/room/${encodeURIComponent(room.id)}`;
  } catch { /* останемся на месте, поле не очистится — можно повторить */ }
});
document.getElementById("newRoomTitle").addEventListener("keydown", e => {
  if (e.key === "Enter") document.getElementById("createRoomBtn").click();
});
function goToRoomCode(raw) {
  const code = raw.trim().toUpperCase();
  if (!code) return;
  closeModal("joinRoomModalBackdrop");
  // Переиспользует уже существующий маршрут/экран (см. renderRoomJoin ниже).
  location.hash = `#/rooms/join/${encodeURIComponent(code)}`;
}
document.getElementById("joinCodeBtn").addEventListener("click", () => {
  goToRoomCode(document.getElementById("joinCodeInput").value);
});
document.getElementById("joinCodeInput").addEventListener("keydown", e => {
  if (e.key === "Enter") goToRoomCode(e.target.value);
});

async function renderRoomsList(root, signal) {
  root.innerHTML = `
    <div class="library-head">
      <h1>Комнаты</h1>
      <p>Соберите пазл вместе с друзьями — детали двигаются в реальном времени для всех, кто за столом.</p>
    </div>
    <div class="room-actions-row" id="roomActionsRow">
      <button class="btn filled" id="createRoomOpenBtn" type="button">Создать комнату</button>
      <button class="btn outlined" id="joinRoomOpenBtn" type="button">Присоединиться к комнате</button>
    </div>
    <div class="room-list" id="roomList"><p class="state-note">Загружаем…</p></div>
    <div class="pager" id="roomsPager" hidden>
      <button class="btn outlined sm" id="roomsPrevBtn" type="button">← Назад</button>
      <span class="muted" id="roomsPagerLabel"></span>
      <button class="btn outlined sm" id="roomsNextBtn" type="button">Вперёд →</button>
    </div>`;

  // Комнаты теперь доступны и без входа (см. server.js/
  // getOrCreateAnonIdentity) — список анонимных комнат этого браузера
  // работает так же, как «мои комнаты» у вошедшего, просто ключом служит
  // cookie вместо JWT. Единственное, чего анониму не хватает — списка
  // комнат виден только на ЭТОМ устройстве (cookie не переносится), для
  // этого мягкая подсказка ниже, не блокирующая экран.
  if (!auth.isAuthenticated()) {
    const note = document.createElement("div");
    note.className = "guest-note";
    const span = document.createElement("span");
    span.textContent = "Войдите, чтобы комната была видна и с других устройств.";
    const btn = document.createElement("button");
    btn.className = "btn tonal sm"; btn.type = "button";
    btn.textContent = "Войти";
    btn.addEventListener("click", () => auth.login());
    note.append(span, btn);
    $(root, "#roomList").before(note);
  }

  // Пагинация — целиком на фронте, список уже загружен целиком (см.
  // loadRooms) — на масштабе личного проекта заводить свой лимит/оффсет на
  // бэке незачем (тот же приём, что в Movies).
  let rooms = [];
  let roomsPage = 0;

  function renderPage() {
    const list = $(root, "#roomList");
    const pagerEl = $(root, "#roomsPager");
    if (!rooms.length) {
      list.innerHTML = '<p class="state-note">Пока нет ни одной комнаты — создайте первую.</p>';
      pagerEl.hidden = true;
      return;
    }
    const pages = Math.max(1, Math.ceil(rooms.length / ROOMS_PAGE_SIZE));
    roomsPage = Math.min(roomsPage, pages - 1);
    const start = roomsPage * ROOMS_PAGE_SIZE;
    const pageRooms = rooms.slice(start, start + ROOMS_PAGE_SIZE);

    list.innerHTML = "";
    for (const r of pageRooms) {
      const card = document.createElement("article");
      card.className = "room-card";
      card.innerHTML = `
        <h3 class="room-card-title"></h3>
        <p class="room-card-meta"></p>`;
      $(card, ".room-card-title").textContent = r.title;
      $(card, ".room-card-meta").textContent =
        `${r.membersCount} ${plural(r.membersCount, "участник", "участника", "участников")}`
        + (r.role === "owner" ? " · вы владелец" : "")
        + ` · обновлено ${fmtDate(r.updatedAt)}`;
      card.addEventListener("click", () => { location.hash = `#/room/${encodeURIComponent(r.id)}`; });
      list.appendChild(card);
    }

    const showPager = rooms.length > ROOMS_PAGE_SIZE;
    pagerEl.hidden = !showPager;
    if (showPager) {
      $(root, "#roomsPagerLabel").textContent = `Стр. ${roomsPage + 1} из ${pages}`;
      $(root, "#roomsPrevBtn").disabled = roomsPage <= 0;
      $(root, "#roomsNextBtn").disabled = roomsPage >= pages - 1;
    }
  }

  async function loadRooms() {
    const list = $(root, "#roomList");
    try {
      const res = await roomFetch("/api/rooms");
      if (!res.ok) throw new Error("rooms fetch failed");
      rooms = await res.json();
    } catch {
      if (!signal.aborted) list.innerHTML = '<p class="state-note">Не удалось загрузить комнаты — обновите страницу.</p>';
      return;
    }
    if (signal.aborted) return;
    renderPage();
  }

  $(root, "#roomsPrevBtn").addEventListener("click", () => { roomsPage = Math.max(0, roomsPage - 1); renderPage(); }, { signal });
  $(root, "#roomsNextBtn").addEventListener("click", () => { roomsPage += 1; renderPage(); }, { signal });
  $(root, "#createRoomOpenBtn").addEventListener("click", () => openModal("createRoomModalBackdrop"), { signal });
  $(root, "#joinRoomOpenBtn").addEventListener("click", () => openModal("joinRoomModalBackdrop"), { signal });

  await loadRooms();
}

/* ───────────────────────── комнаты: экран комнаты ───────────────────────── */

async function renderRoom(root, roomId, signal) {
  root.innerHTML = `
    <div class="library-head"><h1>Комната</h1></div>
    <div id="roomBody"><p class="state-note">Загружаем…</p></div>`;
  const body = $(root, "#roomBody");

  let room, sessions;
  try {
    const [roomRes, sessionsRes] = await Promise.all([
      roomFetch(`/api/rooms/${encodeURIComponent(roomId)}`),
      roomFetch(`/api/rooms/${encodeURIComponent(roomId)}/sessions`),
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
    </div>
    <!-- Крупный пунктирный блок с кодом комнаты — тот же паттерн, что в
         Movies (.code-box, renderCodeArea): код кликабелен и копируется
         сам по себе, кнопка рядом — для полной ссылки. Без «Перевыпустить
         код» — этого эндпоинта у Puzzle нет. -->
    <div class="code-box">
      <code id="roomCode" title="Скопировать код"></code>
      <button class="btn tonal sm" id="copyInviteLinkBtn" type="button">Скопировать ссылку</button>
      <span class="code-box-hint muted" id="roomCodeHint" aria-live="polite" hidden></span>
    </div>
    <div class="room-members" id="roomMembers"></div>
    <div class="room-active" id="roomActive"></div>
    <h3 class="room-section-title">История сборок</h3>
    <div class="room-history" id="roomHistory"></div>`;

  $(root, ".room-head-title").textContent = room.title;
  const roomCodeEl = $(root, "#roomCode");
  const roomCodeHint = $(root, "#roomCodeHint");
  roomCodeEl.textContent = room.joinCode;
  let hintTimer = null;
  function flashCopied() {
    clearTimeout(hintTimer);
    roomCodeHint.textContent = "Скопировано";
    roomCodeHint.hidden = false;
    hintTimer = setTimeout(() => { roomCodeHint.hidden = true; }, 1800);
  }
  roomCodeEl.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(room.joinCode); flashCopied(); } catch { /* буфер недоступен — код и так виден */ }
  }, { signal });
  $(root, "#copyInviteLinkBtn").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(inviteUrl); flashCopied(); } catch { /* буфер недоступен — ссылка есть в приглашении */ }
  }, { signal });

  const membersEl = $(root, "#roomMembers");
  membersEl.innerHTML = "";
  const memberLabels = roomMemberLabels(room.members, "user_id");
  // Убрать участника может только владелец комнаты, и не самого себя —
  // owner всегда один, менять роль тут негде и незачем (см. правку
  // «возможность удалять пользователей владельцем комнаты»).
  const canRemoveMembers = room.role === "owner";
  room.members.forEach((m, i) => {
    const chip = document.createElement("span");
    chip.className = "member-chip" + (m.role === "owner" ? " owner" : "");
    const label = document.createElement("span");
    label.textContent = memberLabels[i];
    chip.appendChild(label);
    if (canRemoveMembers && m.role !== "owner") {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "member-chip-remove";
      removeBtn.title = `Убрать «${memberLabels[i]}» из комнаты`;
      removeBtn.setAttribute("aria-label", removeBtn.title);
      removeBtn.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      removeBtn.addEventListener("click", async () => {
        if (!confirm(`Убрать «${memberLabels[i]}» из комнаты?`)) return;
        removeBtn.disabled = true;
        try {
          await removeRoomMember(roomId, m.user_id);
          chip.remove();
        } catch {
          removeBtn.disabled = false;
          alert("Не удалось убрать участника.");
        }
      }, { signal });
      chip.appendChild(removeBtn);
    }
    membersEl.appendChild(chip);
  });

  // До MAX_ACTIVE_SESSIONS_PER_ROOM параллельных активных сборок в комнате
  // (временное послабление, см. план) — список карточек 0..5 вместо жёсткого
  // if/else «одна активная ИЛИ пикер». Пикер показывается ВСЕГДА ниже,
  // независимо от числа активных: если лимит достигнут, сервер отобьёт
  // попытку старта 409-м, сообщение поймает playVariant.
  const activeEl = $(root, "#roomActive");
  const activeSessions = room.activeSessions || [];
  activeEl.innerHTML = activeSessions.map(s => `
    <div class="room-active-card">
      <p>Сейчас за столом собирают пазл «${s.puzzle.title}» — ${s.piecesPlaced}/${s.piecesTotal} деталей.</p>
      <button class="btn filled join-table-btn" type="button" data-session="${s.id}">За стол</button>
      <button class="icon-btn xs delete-session-btn" type="button" data-session="${s.id}" data-title="${s.puzzle.title}" title="Удалить" aria-label="Удалить">
        <svg class="icon" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>`).join("")
    + '<div class="room-section-head"><h3 class="room-section-title">Начать сборку</h3>'
    + '<button class="icon-btn tonal" id="addPuzzleBtn" type="button" title="Добавить пазл" aria-label="Добавить пазл">'
    + '<svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button></div>'
    + '<div class="puzzle-grid" id="roomPuzzleGrid"><p class="state-note">Загружаем пазлы…</p></div><p class="state-note" id="sessionLimitNote" hidden></p>';
  for (const btn of activeEl.querySelectorAll(".join-table-btn")) {
    btn.addEventListener("click", () => {
      location.hash = `#/room/${encodeURIComponent(roomId)}/table/${encodeURIComponent(btn.dataset.session)}`;
    }, { signal });
  }
  // «Лишний» сеанс, начатый по ошибке — освобождает слот из лимита
  // MAX_ACTIVE_SESSIONS_PER_ROOM. Сервер отобьёт 409-м, если за столом
  // сейчас реально кто-то сидит (см. deleteRoomSession) — в этом случае
  // просто сообщаем и оставляем карточку на месте.
  for (const btn of activeEl.querySelectorAll(".delete-session-btn")) {
    btn.addEventListener("click", async () => {
      const { session: sid, title } = btn.dataset;
      if (!confirm(`Удалить сеанс сборки «${title}»?`)) return;
      btn.disabled = true;
      try {
        await deleteRoomSession(roomId, sid);
        btn.closest(".room-active-card").remove();
      } catch (e) {
        btn.disabled = false;
        alert(e.message === "table not empty" ? "За этим столом сейчас кто-то сидит — сначала все должны выйти." : "Не удалось удалить.");
      }
    }, { signal });
  }

  let puzzles;
  try { puzzles = await getPuzzles(roomId); } catch { $(activeEl, "#roomPuzzleGrid").innerHTML = '<p class="state-note">Не удалось загрузить пазлы.</p>'; puzzles = []; }
  if (signal.aborted) return;
  const grid = $(activeEl, "#roomPuzzleGrid");
  grid.innerHTML = "";

  async function playVariant(variant, asymmetric) {
    try {
      const sessionId = await startRoomSession(roomId, variant.id, asymmetric);
      location.hash = `#/room/${encodeURIComponent(roomId)}/table/${encodeURIComponent(sessionId)}`;
    } catch (e) {
      if (e.message === "room session limit reached") {
        const note = $(activeEl, "#sessionLimitNote");
        note.hidden = false;
        const limit = typeof e.limit === "number" ? e.limit : MAX_ACTIVE_SESSIONS_PER_ROOM;
        note.textContent = `Достигнут лимит одновременных сборок в комнате (${limit}) — заверши одну, чтобы начать новую.`;
      }
      /* иначе — ошибка сети, пользователь просто попробует кнопку ещё раз */
    }
  }

  // allowDelete НЕ передан (по умолчанию разрешено) — buildCard сам решает,
  // кому показать крестик: владельцу своего фото — «удалить», любому
  // участнику комнаты (roomId передан) на встроенном пазле — «скрыть из
  // этой комнаты» (см. canHideDefault в buildCard).
  for (const group of groupPuzzles(puzzles)) {
    grid.appendChild(buildCard(group, { onPlay: playVariant, roomId }));
  }

  $(activeEl, "#addPuzzleBtn").addEventListener("click", () => openModal("uploadPuzzleModalBackdrop"), { signal });
  // Форма — внутри статичной модалки (index.html, вне #app), не под сеткой:
  // раньше висела постоянно открытой, теперь только по клику на «+» (см. кнопку
  // выше). Монтируем один раз на каждый заход в комнату — mountUploadForm сам
  // перезаписывает innerHTML контейнера, повторный вызов при новом рендере не
  // накапливает старые формы/обработчики. Загрузка своего фото по-прежнему
  // требует настоящего входа (POST /api/puzzles и так уже проверяет это на
  // сервере, см. план «анонимные комнаты») — анониму вместо формы подсказка,
  // чтобы не показывать то, что всё равно откажет.
  const uploadMount = document.getElementById("uploadPuzzleFormMount");
  if (auth.isAuthenticated()) {
    mountUploadForm(uploadMount, roomId, result => {
      grid.appendChild(buildCard({ ...result.variants[0], variants: result.variants }, { onPlay: playVariant, roomId }));
      closeModal("uploadPuzzleModalBackdrop");
    });
  } else {
    uploadMount.innerHTML = '<p class="state-note">Войдите, чтобы добавить своё фото.</p><button class="btn tonal sm" id="uploadLoginBtn" type="button">Войти</button>';
    $(uploadMount, "#uploadLoginBtn").addEventListener("click", () => auth.login(), { signal });
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
      row.innerHTML = `
        <div class="history-info">
          <span class="history-puzzle"></span>
          <span class="history-meta"></span>
        </div>
        <div class="history-actions">
          <button class="btn outlined sm history-replay" type="button">Собрать ещё раз</button>
          <button class="icon-btn xs history-delete" type="button" title="Удалить" aria-label="Удалить">
            <svg class="icon" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>`;
      $(row, ".history-puzzle").textContent = s.puzzle.title;
      $(row, ".history-meta").textContent = `${s.piecesTotal} деталей · собран ${fmtDate(s.completedAt)}`;
      // Доступна и когда сейчас уже идёт другой активный сеанс —
      // startRoomSession в этом случае просто перекинет на него (409-ветка).
      $(row, ".history-replay").addEventListener("click", async e => {
        e.target.disabled = true;
        try {
          const newId = await startRoomSession(roomId, s.puzzle.id);
          location.hash = `#/room/${encodeURIComponent(roomId)}/table/${encodeURIComponent(newId)}`;
        } catch { e.target.disabled = false; }
      }, { signal });
      // Завершённый сеанс — за столом никого уже нет (completedAt выставлен),
      // 409 здесь в норме не встречается, но deleteRoomSession всё равно
      // корректно её обработает, если что-то поменялось между рендером и кликом.
      $(row, ".history-delete").addEventListener("click", async e => {
        if (!confirm(`Удалить сеанс сборки «${s.puzzle.title}»?`)) return;
        // currentTarget, не target: клик может попасть на вложенный <svg>/<path>
        // иконки крестика — у них нет свойства disabled, а нужно отключить
        // саму кнопку.
        e.currentTarget.disabled = true;
        try { await deleteRoomSession(roomId, s.id); row.remove(); }
        catch (err) {
          e.currentTarget.disabled = false;
          alert(err.message === "table not empty" ? "За этим столом сейчас кто-то сидит — сначала все должны выйти." : "Не удалось удалить.");
        }
      }, { signal });
      historyEl.appendChild(row);
    }
  }
}

/* ───────────────────────── комнаты: вступление по ссылке ───────────────────────── */

async function renderRoomJoin(root, code, signal) {
  root.innerHTML = `<div id="joinBody"><p class="state-note">Секунду…</p></div>`;
  const body = $(root, "#joinBody");

  // Вступление по ссылке теперь работает и без входа (см. план
  // «анонимные комнаты») — roomFetch сам разберётся, JWT это или
  // анонимный cookie.
  try {
    const res = await roomFetch(`/api/rooms/join/${encodeURIComponent(code)}`, { method: "POST" });
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
        <strong id="tableTitle"></strong>
        <div class="spacer"></div>
        <span class="table-progress" id="tableProgress"></span>
      </div>
      <div class="table-stage" id="stage">
        <div class="table-world" id="world"></div>
        <div class="marquee-select" id="marqueeSelect" hidden></div>
        <div class="preview-panel" id="previewPanel" hidden>
          <img class="preview-thumb" id="previewThumb" alt="">
          <div class="preview-resize-handle" id="previewResizeHandle" title="Изменить размер" aria-hidden="true"></div>
        </div>
        <!-- «Назад» — была текстовой ссылкой «← Комната» в .table-toolbar,
             теперь иконка в левом верхнем углу доски (не в .board-tools внизу
             — выход со стола не инструмент сборки). -->
        <div class="board-back">
          <a class="btn outlined icon" href="#/room/${encodeURIComponent(roomId)}" title="Комната" aria-label="Комната">
            <svg class="icon" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>
          </a>
        </div>
        <!-- Кнопки действий стола — всегда иконками (не только на мобильном,
             см. план п.4), в своей плашке в стиле .zoom-controls, но в другом
             углу, чтобы не пересекаться ни с ним, ни с .preview-thumb, ни с
             кнопкой присутствия ниже. -->
        <div class="board-tools">
          <button class="btn outlined icon" id="shuffleBtn" type="button" title="Перемешать" aria-label="Перемешать">
            <svg class="icon" viewBox="0 0 24 24"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>
          </button>
          <button class="btn outlined icon" id="previewBtn" type="button" title="Показать картинку" aria-label="Показать картинку">
            <svg class="icon" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
          </button>
          <button class="btn outlined icon" id="boardThemeBtn" type="button" title="Светлый фон" aria-label="Светлый фон">
            <svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 1 0 20z" fill="currentColor" stroke="none"/></svg>
          </button>
          <!-- На тач-устройствах нет Shift — этот тоггл даёт тот же жест
               (тянуть рамку по пустому месту вместо панорамы), пока включён,
               одним пальцем. На десктопе Shift+тяни работает и без него —
               кнопка просто альтернативный способ включить то же самое. -->
          <button class="btn outlined icon" id="selectModeBtn" type="button" title="Режим выделения" aria-label="Режим выделения" aria-pressed="false">
            <svg class="icon" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="4 3"/></svg>
          </button>
        </div>
        <!-- Присутствующие за столом — раньше постоянно видимая строка чипов
             в тулбаре (занимала место), теперь кнопка-иконка с бейджем-числом
             и всплывающая панель со списком (см. updatePresence ниже), а не
             полноэкранная модалка — это лёгкий быстрый список, не диалог. -->
        <div class="presence-widget">
          <button class="btn outlined icon presence-btn" id="presenceBtn" type="button"
            title="Участники за столом" aria-label="Участники за столом" aria-haspopup="true" aria-expanded="false">
            👥<span class="presence-count" id="presenceCount" hidden>0</span>
          </button>
          <div class="presence-popover hidden" id="presencePopover">
            <p class="presence-popover-title">За столом</p>
            <div class="presence-popover-list" id="presenceList"></div>
          </div>
        </div>
        <div class="zoom-controls">
          <button class="btn outlined icon" id="zoomInBtn" type="button" title="Приблизить" aria-label="Приблизить">+</button>
          <button class="btn outlined icon" id="zoomResetBtn" type="button" title="Показать всё" aria-label="Показать всё">⤢</button>
          <button class="btn outlined icon" id="zoomOutBtn" type="button" title="Отдалить" aria-label="Отдалить">−</button>
        </div>
      </div>
    </div>`;
  const stage = $(root, "#stage");

  let session;
  try {
    const sessionRes = await roomFetch(`/api/rooms/${encodeURIComponent(roomId)}/sessions/${encodeURIComponent(sessionId)}`);
    if (!sessionRes.ok) throw new Error("session fetch failed");
    session = await sessionRes.json();
  } catch {
    if (!signal.aborted) stage.innerHTML = '<p class="state-note">Не удалось открыть стол — обновите страницу.</p>';
    return;
  }
  if (signal.aborted) return;
  // Сеанс уже завершён — сервер отклонит апгрейд сокета 410-м, а браузерный
  // WebSocket не умеет донести код HTTP-отказа до JS (close без вменяемой
  // причины), поэтому клиент раньше уходил в вечный "переподключение…".
  // Проверяем то же поле, что уже пришло в session, до попытки подключения.
  if (session.completedAt) {
    // Не тупик: «мы не вправе ограничивать этим пользователя» — вместо
    // возврата в комнату без вариантов даём стартовать новый сеанс тем же
    // пазлом (см. «Ключевые решения» в плане — старый сеанс остаётся в
    // истории с тем же completedAt, его физически не трогаем).
    stage.innerHTML = `
      <div class="state-note">
        <p>Этот пазл уже собран.</p>
        <button class="btn filled sm" id="replayBtn" type="button">Собрать ещё раз</button>
        <a class="btn text sm" href="#/room/${encodeURIComponent(roomId)}">Вернуться в комнату</a>
      </div>`;
    $(stage, "#replayBtn").addEventListener("click", async e => {
      e.target.disabled = true;
      try {
        const newId = await startRoomSession(roomId, session.puzzle.id);
        location.hash = `#/room/${encodeURIComponent(roomId)}/table/${encodeURIComponent(newId)}`;
      } catch { e.target.disabled = false; }
    }, { signal });
    return;
  }
  const puzzle = session.puzzle;
  $(root, "#tableTitle").textContent = puzzle.title;

  const rows = puzzle.gridRows, cols = puzzle.gridCols;
  const pad = CELL * PAD_FACTOR;
  const boardW = cols * CELL, boardH = rows * CELL;
  // Форма зафиксирована на СЕАНСЕ (см. server.js, asymmetric_shape) — общая
  // для всех участников комнаты, а не выбор каждого зрителя по отдельности.
  const edges = window.PuzzleShapes.buildEdges(puzzle.seed, rows, cols, { asymmetric: session.asymmetricShape });

  const world = $(root, "#world");
  const progressEl = $(root, "#tableProgress");
  const presenceBtn = $(root, "#presenceBtn");
  const presenceCount = $(root, "#presenceCount");
  const presencePopover = $(root, "#presencePopover");
  const presenceListEl = $(root, "#presenceList");
  function setPresencePopoverOpen(open) {
    presencePopover.classList.toggle("hidden", !open);
    presenceBtn.setAttribute("aria-expanded", String(open));
  }
  presenceBtn.addEventListener("click", e => {
    e.stopPropagation();
    setPresencePopoverOpen(presencePopover.classList.contains("hidden"));
  }, { signal });
  // Клик снаружи закрывает поповер — тот же паттерн, что у модалок
  // (клик по подложке), но без подложки: поповер компактный, не блокирует
  // остальной интерфейс.
  document.addEventListener("click", e => {
    if (presencePopover.classList.contains("hidden")) return;
    if (e.target.closest(".presence-widget")) return;
    setPresencePopoverOpen(false);
  }, { signal });
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

  /* ── авто-панорама к краю доски во время драга детали — см. подробный
     комментарий в renderTable, механика идентична. Тут дополнительно на
     каждый тик (не только на реальный pointermove) шлём move/group —
     иначе для остальных участников деталь «телепортировалась» бы только
     в момент отпускания, а не ехала бы плавно вместе с автоскроллом. ── */
  const EDGE_MARGIN = 56, EDGE_MAX_SPEED = 16;
  function screenToWorld(clientX, clientY) {
    const r = stage.getBoundingClientRect();
    return { x: (clientX - r.left - panX) / zoom, y: (clientY - r.top - panY) / zoom };
  }
  let activeDrag = null;
  function applyActiveDragPositions() {
    const w = screenToWorld(activeDrag.lastClientX, activeDrag.lastClientY);
    for (const [k, ox, oy] of activeDrag.offsets) {
      const p = pieces.get(k);
      p.x = w.x + ox; p.y = w.y + oy;
      applyPieceTransform(p);
    }
    if (activeDrag.offsets.length > 1) activeDrag.sendGroup(activeDrag.draggingKeys);
    else activeDrag.sendMove(activeDrag.piece);
  }
  let edgePanRAF = null;
  function edgePanTick() {
    if (!activeDrag) { edgePanRAF = null; return; }
    const r = stage.getBoundingClientRect();
    const x = activeDrag.lastClientX - r.left, y = activeDrag.lastClientY - r.top;
    const push = (pos, size) => pos < EDGE_MARGIN ? clamp(1 - pos / EDGE_MARGIN, 0, 1)
      : pos > size - EDGE_MARGIN ? -clamp(1 - (size - pos) / EDGE_MARGIN, 0, 1) : 0;
    const vx = push(x, r.width) * EDGE_MAX_SPEED, vy = push(y, r.height) * EDGE_MAX_SPEED;
    if (vx || vy) {
      panX += vx; panY += vy;
      applyWorldTransform();
      applyActiveDragPositions();
    }
    edgePanRAF = requestAnimationFrame(edgePanTick);
  }
  signal.addEventListener("abort", () => {
    activeDrag = null;
    if (edgePanRAF !== null) { cancelAnimationFrame(edgePanRAF); edgePanRAF = null; }
  });

  stage.addEventListener("wheel", e => {
    e.preventDefault();
    const factor = Math.pow(1.0016, -e.deltaY);
    zoomAt(e.clientX, e.clientY, factor);
  }, { passive: false, signal });

  const active = new Map();
  let panState = null, pinchState = null, clickCandidate = null;
  const midOf = m => { const p = [...m.values()]; return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 }; };
  const distOf = m => { const p = [...m.values()]; return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); };

  /* ── массовое выделение рамкой (Shift+тяни по пустому месту доски, или
     тоггл #selectModeBtn для тач) — см. подробный комментарий в
     renderTable, механика идентична. ── */
  let selectMode = false;
  let marqueeState = null; // { pointerId, startX, startY, baseSelected }
  const marqueeEl = $(root, "#marqueeSelect");
  function updateMarqueeRect(x0, y0, x1, y1) {
    const r = stage.getBoundingClientRect();
    marqueeEl.style.left = `${Math.min(x0, x1) - r.left}px`;
    marqueeEl.style.top = `${Math.min(y0, y1) - r.top}px`;
    marqueeEl.style.width = `${Math.abs(x1 - x0)}px`;
    marqueeEl.style.height = `${Math.abs(y1 - y0)}px`;
  }
  function updateMarqueeSelection(x0, y0, x1, y1) {
    const w0 = screenToWorld(Math.min(x0, x1), Math.min(y0, y1));
    const w1 = screenToWorld(Math.max(x0, x1), Math.max(y0, y1));
    const size = CELL + 2 * pad; // полный размер SVG детали (с запасом под выступы), см. createPieceEl
    const next = new Set(marqueeState.baseSelected);
    for (const [k, p] of pieces) {
      if (p.x < w1.x && p.x + size > w0.x && p.y < w1.y && p.y + size > w0.y) next.add(k);
    }
    setSelected(next);
  }

  stage.addEventListener("pointerdown", e => {
    // .zoom-controls (а теперь и .board-tools/.board-back/.win-overlay/
    // .table-give-up) тоже исключаем: иначе setPointerCapture ниже
    // перехватывает указатель на #stage раньше, чем браузер успевает
    // синтезировать click на кнопке — колесо мыши работало (свой отдельный
    // wheel-хендлер), а кнопки +/−/⤢ (и, отдельно найденный тот же баг,
    // кнопки в окне победы) не реагировали на клик вовсе.
    if (e.target.closest(".piece") || e.target.closest(".zoom-controls") || e.target.closest(".board-tools")
      || e.target.closest(".board-back") || e.target.closest(".presence-widget") || e.target.closest(".preview-panel")
      || e.target.closest(".win-overlay") || e.target.closest(".table-give-up")) return;
    stage.setPointerCapture(e.pointerId);
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (active.size === 1) {
      if (e.shiftKey || selectMode) {
        marqueeState = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, baseSelected: new Set(selected) };
        marqueeEl.hidden = false;
        updateMarqueeRect(e.clientX, e.clientY, e.clientX, e.clientY);
        clickCandidate = null;
      } else {
        panState = { startX: e.clientX, startY: e.clientY, originX: panX, originY: panY };
        stage.classList.add("panning");
        clickCandidate = { x: e.clientX, y: e.clientY };
      }
    } else if (active.size === 2) {
      panState = null;
      marqueeState = null;
      marqueeEl.hidden = true;
      pinchState = { lastDist: distOf(active), lastMid: midOf(active) };
      clickCandidate = null;
    }
  }, { signal });

  stage.addEventListener("pointermove", e => {
    if (clickCandidate && Math.hypot(e.clientX - clickCandidate.x, e.clientY - clickCandidate.y) > 4) clickCandidate = null;
    if (!active.has(e.pointerId)) return;
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (marqueeState && e.pointerId === marqueeState.pointerId) {
      updateMarqueeRect(marqueeState.startX, marqueeState.startY, e.clientX, e.clientY);
      updateMarqueeSelection(marqueeState.startX, marqueeState.startY, e.clientX, e.clientY);
      return;
    }
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
    if (marqueeState && e.pointerId === marqueeState.pointerId) {
      marqueeState = null;
      marqueeEl.hidden = true;
      clickCandidate = null;
      return;
    }
    if (active.size === 1) {
      const [, p] = [...active.entries()][0];
      panState = { startX: p.x, startY: p.y, originX: panX, originY: panY };
      pinchState = null;
    } else if (active.size === 0) {
      panState = null; pinchState = null;
      stage.classList.remove("panning");
    }
    if (clickCandidate && selected.size) setSelected([]);
    clickCandidate = null;
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

  bindPreviewThumb(stage, $(root, "#previewPanel"), $(root, "#previewThumb"), $(root, "#previewResizeHandle"), $(root, "#previewBtn"), puzzle.imageUrl, puzzle.title, signal);

  // Светлый фон стола — постоянно фиксированные светлые тона, не тема
  // сайта: тёмная деталь на тёмной (в тёмной теме) доске почти не видна
  // по краям, пока не собрана — переключатель никак не зависит от того,
  // светлая сейчас тема интерфейса или нет.
  $(root, "#boardThemeBtn").addEventListener("click", () => {
    stage.classList.toggle("light-board");
  }, { signal });

  // Тач-замена Shift для рамки выделения — см. комментарий у marqueeState
  // выше. На десктопе не нужна (там уже работает Shift+тяни), но не мешает
  // ей — оба способа включают одно и то же условие в pointerdown.
  $(root, "#selectModeBtn").addEventListener("click", e => {
    selectMode = !selectMode;
    e.currentTarget.setAttribute("aria-pressed", String(selectMode));
  }, { signal });

  $(root, "#shuffleBtn").addEventListener("click", () => {
    // pieces строится асинхронно в buildBoard() по первому sync — до этого
    // момента стол ещё не собран, перемешивать нечего.
    if (!pieces) return;
    // Та же поправка, что и в соло: любая уже состыкованная пара/кластер не
    // трогается — переставляются только ещё не соединённые одиночки. Риска
    // потерять прогресс нет, confirm не нужен.
    const next = planShuffle(pieces, rows, cols, CELL, pad, SNAP_TOLERANCE, BOARD_X, BOARD_Y);
    if (!next) return;
    // Шлём только реально переставленные детали (ключи next), а не весь
    // борд — см. разбор гонки group/shuffle в server.js: полный снимок
    // ЛОКАЛЬНОГО pieces отправителя мог быть устаревшим для деталей, которых
    // «Перемешать» не касалось (их мог только что подвинуть кто-то другой),
    // и слепая замена state.pieces целиком откатывала бы этот чужой ход.
    const arr = [...next.entries()].map(([k, pos]) => {
      const piece = pieces.get(k);
      return { r: piece.r, c: piece.c, x: pos.x, y: pos.y, placed: false };
    });
    socket.send({ type: "shuffle", pieces: arr });
  }, { signal });

  function updateProgressLabel(placed, total) {
    progressEl.innerHTML = "";
    const b = document.createElement("b");
    b.textContent = `${placed}/${total}`;
    progressEl.append(b, document.createTextNode(" деталей собрано"));
  }
  function updatePresence(members) {
    const list = members || [];
    presenceCount.textContent = String(list.length);
    presenceCount.hidden = list.length === 0;
    presenceListEl.innerHTML = "";
    const labels = roomMemberLabels(list, "id");
    list.forEach((m, i) => {
      const chip = document.createElement("span");
      chip.className = "presence-chip";
      chip.textContent = labels[i];
      presenceListEl.appendChild(chip);
    });
  }
  function showWin() {
    const overlay = document.createElement("div");
    overlay.className = "win-overlay";
    const card = document.createElement("div");
    card.className = "win-card";
    const img = document.createElement("img");
    img.className = "win-image"; img.src = puzzle.imageUrl; img.alt = puzzle.title;
    const h2 = document.createElement("h2"); h2.textContent = "Готово!";
    const p = document.createElement("p"); p.textContent = `Пазл «${puzzle.title}» собран вместе с друзьями.`;
    const actions = document.createElement("div");
    actions.className = "win-actions";
    const stayBtn = document.createElement("button");
    stayBtn.className = "btn outlined"; stayBtn.type = "button"; stayBtn.textContent = "Остаться";
    stayBtn.addEventListener("click", () => overlay.remove());
    const homeBtn = document.createElement("button");
    homeBtn.className = "btn filled"; homeBtn.type = "button"; homeBtn.textContent = "В комнату";
    homeBtn.addEventListener("click", () => { location.hash = `#/room/${encodeURIComponent(roomId)}`; });
    actions.append(stayBtn, homeBtn);
    card.append(img, h2, p, actions);
    overlay.appendChild(card);
    stage.appendChild(overlay);
  }

  /* ── перетаскивание детали: локально сразу, серверу — троттлингом ── */
  const draggingKeys = new Set(); // детали, которые СЕЙЧАС тащит локальный пользователь — resync их не трогает
  let pieces; // Map "r,c" -> piece, строится в buildBoard() по первому sync
  let announced = false; // защита от повторного showWin() при нескольких sync подряд (троттлинг group)
  let lastClusterEdgeIds = new Set(); // "r,c|r,c" — вспышка только на НОВЫХ стыковках (свой драг и чужой sync)

  const selected = new Set(); // ключи "r,c" — текущее ручное выделение (клик/shift-клик)
  function setSelected(keys) {
    selected.clear();
    for (const k of keys) selected.add(k);
    for (const [k, p] of pieces) p.el.classList.toggle("selected", selected.has(k));
  }

  /* activeDrag — общее (не per-piece) состояние, см. блок авто-панорамы
     выше: rAF-тику edgePanTick нужно знать о текущем драге независимо от
     того, какая именно деталь его начала. Не путать с draggingKeys —
     тот отдельный набор живёт снаружи (см. выше) и защищает от resync
     поверх ещё не подтверждённого сервером локального хода. */
  function bindRoomPieceDrag(el, piece, sendMove, sendGroup) {
    let moved = false;
    const key = `${piece.r},${piece.c}`;

    el.addEventListener("pointerdown", e => {
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      moved = false;
      // Клик по детали выделяет весь уже собранный сегмент, в который она
      // входит (не только саму деталь) — тащить всё равно будет весь
      // кластер целиком (groupSet ниже строится тем же buildClusters),
      // выделение теперь отражает это сразу, а не только во время драга.
      const { clusterOf, members } = window.PuzzleClusters.buildClusters(pieces.values(), CELL, SNAP_TOLERANCE);
      if (!(selected.has(key) && selected.size > 1)) setSelected(members.get(clusterOf.get(key)));
      const groupSet = new Set();
      for (const k of selected) for (const m of members.get(clusterOf.get(k))) groupSet.add(m);
      // Смещение каждой детали от мировой точки под курсором в момент
      // начала драга (не от абсолютной позиции детали) — так деталь
      // остаётся под курсором даже если panX/panY поменяются во время
      // драга без единого pointermove (см. edgePanTick).
      const w0 = screenToWorld(e.clientX, e.clientY);
      const offsets = [...groupSet].map(k => {
        const p = pieces.get(k);
        p.el.classList.add("dragging");
        draggingKeys.add(k);
        return [k, p.x - w0.x, p.y - w0.y];
      });
      activeDrag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, offsets, draggingKeys: groupSet, lastClientX: e.clientX, lastClientY: e.clientY, piece, sendMove, sendGroup };
      if (edgePanRAF === null) edgePanRAF = requestAnimationFrame(edgePanTick);
    }, { signal });

    el.addEventListener("pointermove", e => {
      if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
      const dx0 = e.clientX - activeDrag.startX, dy0 = e.clientY - activeDrag.startY;
      if (!moved && Math.hypot(dx0, dy0) > 4) moved = true;
      activeDrag.lastClientX = e.clientX; activeDrag.lastClientY = e.clientY;
      applyActiveDragPositions();
    }, { signal });

    function finish(e) {
      if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
      const { offsets, draggingKeys: groupKeys } = activeDrag;
      activeDrag = null;
      // См. комментарий у аналогичной строки в renderTable/bindPieceDrag —
      // отменяем ещё не сработавший кадр авто-панорамы явно.
      if (edgePanRAF !== null) { cancelAnimationFrame(edgePanRAF); edgePanRAF = null; }
      for (const [k] of offsets) pieces.get(k).el.classList.remove("dragging");
      if (!moved) {
        for (const [k] of offsets) draggingKeys.delete(k);
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        if (additive) {
          const next = new Set(selected);
          if (next.has(key)) next.delete(key); else next.add(key);
          setSelected(next);
        } else {
          setSelected(clusterMembersOf(pieces, key));
        }
        return;
      }
      window.PuzzleClusters.stitchGroup(pieces, groupKeys, CELL, SNAP_TOLERANCE);
      for (const k of groupKeys) { applyPieceTransform(pieces.get(k)); draggingKeys.delete(k); }
      const { members, edges } = window.PuzzleClusters.buildClusters(pieces.values(), CELL, SNAP_TOLERANCE);
      const { nextIds, newCount } = flashClusterEdges(pieces, lastClusterEdgeIds, edges);
      lastClusterEdgeIds = nextIds;
      updateProgressLabel(window.PuzzleClusters.connectedPiecesCount(members), rows * cols);
      setSelected([]);
      // >1 детали тащили или стыковка образовала новое ребро — шлём группой
      // ТОЛЬКО те детали, которых коснулся этот жест (groupKeys — тащенная
      // группа, включая стыковку соседей внутри неё; сами соседи, к которым
      // пристыковались, не входят в groupKeys и не пересылаются — их
      // координаты не менялись), иначе — компактный move одной детали. Не
      // весь борд: см. разбор гонки group/shuffle в server.js.
      if (offsets.length > 1 || newCount > 0) sendGroup(groupKeys);
      else sendMove(piece);
    }
    el.addEventListener("pointerup", finish, { signal });
    el.addEventListener("pointercancel", finish, { signal });
    // Подстраховка от «вечно тащим» (см. расследование бага с прогрессом):
    // pointerup/pointercancel не гарантированно долетают при нештатном
    // завершении жеста (потеря фокуса окна, вкладка свёрнута, ОС перехватила
    // жест) — lostpointercapture по спецификации срабатывает ВСЕГДА, когда
    // элемент теряет захват указателя, каким бы ни был повод, поэтому это
    // надёжная точка для финального finish() и очистки draggingKeys/activeDrag.
    el.addEventListener("lostpointercapture", finish, { signal });
  }

  function reconcilePiece(r, c, x, y) {
    const key = `${r},${c}`;
    if (draggingKeys.has(key)) return;
    const piece = pieces.get(key);
    if (!piece) return;
    piece.x = x; piece.y = y;
    applyPieceTransform(piece);
  }

  function buildBoard(initialPieces) {
    pieces = new Map();
    let scatterIdx = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const known = initialPieces && initialPieces.find(p => p.r === r && p.c === c);
        let x, y;
        if (known) { x = known.x; y = known.y; }
        else { const cell = scatter.cells[scatterIdx++]; x = cell.x; y = cell.y; }
        pieces.set(`${r},${c}`, { r, c, x, y });
      }
    }

    const sendMove = throttle(p => socket.send({ type: "move", r: p.r, c: p.c, x: p.x, y: p.y }), 70);
    // keys — только детали ЭТОГО жеста (см. bindRoomPieceDrag), не весь
    // борд: сервер мержит group/shuffle по ключу поверх своего состояния
    // (см. server.js), полный локальный снимок отправителя мог быть
    // устаревшим для деталей, которых этот жест не касался, и раньше слепо
    // затирал чужой параллельный ход (гонка при одновременном перетаскивании
    // разными участниками — регресс test/e2e-rooms.mjs).
    const sendGroup = throttle(keys => {
      const arr = [...keys].map(k => { const p = pieces.get(k); return { r: p.r, c: p.c, x: p.x, y: p.y, placed: false }; });
      socket.send({ type: "group", pieces: arr });
    }, 70);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const piece = pieces.get(`${r},${c}`);
        const el = createPieceEl(puzzle.id, r, c, rows, cols, CELL, pad, edges, puzzle.imageUrl, boardW, boardH);
        piece.el = el;
        applyPieceTransform(piece);
        world.appendChild(el);
        bindRoomPieceDrag(el, piece, sendMove, sendGroup);
      }
    }
    const built = window.PuzzleClusters.buildClusters(pieces.values(), CELL, SNAP_TOLERANCE);
    lastClusterEdgeIds = clusterEdgeIds(built.edges);
    updateProgressLabel(window.PuzzleClusters.connectedPiecesCount(built.members), rows * cols);

    // Раскладку никто не задал — эту раскладку и предлагаем как каноническую
    // (см. план: "первый валидный init побеждает", гонка самоисцеляется).
    if (!initialPieces) {
      socket.send({ type: "init", pieces: [...pieces.values()].map(p => ({ r: p.r, c: p.c, x: p.x, y: p.y, placed: false })) });
    }
  }

  function handleSocketMessage(msg) {
    if (msg.type === "sync") {
      if (!pieces) return void buildBoard(msg.pieces);
      if (msg.pieces) for (const p of msg.pieces) reconcilePiece(p.r, p.c, p.x, p.y);
      // Кластеры/вспышка/прогресс пересчитываются здесь целиком — это ловит
      // и стыковку своим драгом (эхо своего же group/shuffle), и стыковку
      // чужим драгом (пришедшую только через sync), одним и тем же путём.
      const built = window.PuzzleClusters.buildClusters(pieces.values(), CELL, SNAP_TOLERANCE);
      const { nextIds } = flashClusterEdges(pieces, lastClusterEdgeIds, built.edges);
      lastClusterEdgeIds = nextIds;
      const placedNow = window.PuzzleClusters.connectedPiecesCount(built.members);
      updateProgressLabel(placedNow, msg.piecesTotal);
      updatePresence(msg.members);
      // "Собрано" (placedNow, счётчик выше) и "решено целиком" — разные
      // вещи (см. комментарий у computePiecesPlaced/isPuzzleSolved) —
      // победу показываем только когда все детали — один кластер.
      const largest = window.PuzzleClusters.largestClusterSize(built.members);
      if (largest >= msg.piecesTotal && !announced) { announced = true; showWin(); }
      return;
    }
    if (msg.type === "presence") return updatePresence(msg.members);
    if (msg.type === "move") return reconcilePiece(msg.r, msg.c, msg.x, msg.y);
  }

  const socket = connectRoomSocket({
    roomId, sessionId, signal,
    onMessage: handleSocketMessage,
    onOpen: () => { progressEl.classList.remove("offline"); },
    onClose: () => { progressEl.classList.add("offline"); },
    onGiveUp: () => {
      progressEl.classList.remove("offline");
      stage.insertAdjacentHTML("beforeend", `<p class="state-note table-give-up">Не удаётся подключиться к столу. <a class="btn text sm" href="#/room/${encodeURIComponent(roomId)}">Вернуться в комнату</a> или обновите страницу.</p>`);
    },
  });
}

/* ───────────────────────── Яндекс.Метрика: переходы внутри SPA ─────────────────────────
 * Счётчик считает автоматически только самый первый заход (обычная загрузка
 * страницы) — переходы между комнатами/столом идут через hashchange без
 * перезагрузки, поэтому на каждую смену hash шлём hit вручную, тем же
 * приёмом, что и в Brain (assets/app.js). Puzzle, в отличие от Brain,
 * document.title по маршрутам не меняет — везде статичный «Что собираем? —
 * BurningHouse» (см. index.html), так что title в hit будет одинаковым для
 * всех страниц; различает их сам url (location.href, hash — часть адреса). */
const METRIKA_ID = 112035178;
function trackPageview() {
  if (typeof ym === "function") ym(METRIKA_ID, "hit", location.href, { title: document.title, referer: document.referrer });
}

/* ───────────────────────── роутер ───────────────────────── */
function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  // ([^?]+) — id отдельно от необязательного ?shape=asym (см. buildCard,
  // клетка «Ассиметричная форма» в модалке выбора сложности): жадный (.+)
  // раньше забирал бы весь query в сам id.
  const tableMatch = hash.match(/^\/table\/([^?]+)(?:\?(.*))?$/);
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
    : tableMatch ? renderTable(root, decodeURIComponent(tableMatch[1]), signal, tableMatch[2])
    : renderLibrary(root, signal);
  run.catch(e => {
    if (signal.aborted) return;
    console.error(e);
    root.innerHTML = '<p class="state-note">Что-то пошло не так — обновите страницу.</p>';
  });
}
window.addEventListener("hashchange", () => { route(); trackPageview(); });

/* ───────────────────────── старт ───────────────────────── */
async function init() {
  const cfg = await (await fetch("/api/config")).json();
  auth = createAuthClient({ authBase: cfg.authBase, clientId: cfg.clientId, storagePrefix: "bh_puzzle" });
  // Обязательно ДО первого запроса к своему API: обменивает ?code=… на токены.
  // Принудительного редиректа на вход НЕТ — гостевой режим полноценный
  // (см. README «Идея в двух режимах»).
  await auth.handleRedirect();
  renderAuthArea();
  route();
}
init().catch(e => {
  console.error(e);
  document.getElementById("app").innerHTML = '<p class="state-note">Не удалось запуститься — обновите страницу.</p>';
});
