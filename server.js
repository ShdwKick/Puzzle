#!/usr/bin/env node
/**
 * Что собираем? — backend соло-сборки пазлов.
 * Чистый Node.js, без внешних зависимостей (SQLite — встроенный node:sqlite,
 * ставить нечего, npm install не требуется — как и во всей экосистеме
 * BurningHouse).
 *
 * Два режима работы, оба полноценные:
 *   - без входа: доступны только встроенные пазлы (манифест ниже), прогресс
 *     живёт целиком в localStorage браузера, сюда не долетает вовсе;
 *   - вошедшему через SSO Auth: прогресс сохраняется в SQLite, один JSON-
 *     документ на пользователя+пазл (puzzle_progress), переживает между
 *     сессиями и устройствами.
 *
 * Комнаты, свои фото, загрузка через Admin, совместная realtime-сборка —
 * сознательно вне объёма этого захода (см. README.md), заведены отдельными
 * задачами позже.
 *
 * Запуск:            node server.js
 *
 * Переменные окружения:
 *   PORT            (по умолчанию 8796)      — порт
 *   HOST            (по умолчанию 127.0.0.1) — интерфейс (за nginx — localhost)
 *   DATA_DIR        (по умолчанию ./data)    — store.db
 *   AUTH_ISSUER     ОБЯЗАТЕЛЬНО — адрес auth-сервиса, напр. https://auth.burninghouse.ru.
 *                   Он же claim iss внутри токенов: сверяется побайтово.
 *   AUTH_CLIENT_ID  (по умолчанию puzzle)    — идентификатор сервиса в auth
 *   AUTH_BASE       (по умолчанию = AUTH_ISSUER) — куда фронт уводит на вход
 *   AUTH_JWKS_URL   (по умолчанию AUTH_ISSUER + /.well-known/jwks.json)
 *   AUTH_CLOCK_SKEW (по умолчанию 30) — допуск на расхождение часов, секунды
 *   ALLOWED_ORIGIN  — источник, которому разрешён доступ к /api/* (CORS).
 *                   Нужен, только если фронтенд отдаётся отдельно (сейчас не так).
 *   ADMIN_INTERNAL_KEY — общий секрет для Admin (/internal/*, см. admin-internal.js).
 *   MAX_PHOTO_BYTES (по умолчанию 4 МиБ) — потолок размера своего фото на пазл.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { checkAdminKey, createAdminLog } = require("./admin-internal");
const ws = require("./ws-server");
const { buildClusters, largestClusterSize, tolerance } = require("./assets/puzzle-clusters.js");

const PORT = parseInt(process.env.PORT || "8796", 10);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "store.db");
const APP_HTML = path.join(__dirname, "index.html");
const ASSETS_DIR = path.join(__dirname, "assets");
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
const PUZZLE_PHOTO_DIR = path.join(DATA_DIR, "puzzle-photos");
const MAX_PHOTO_BYTES = parseInt(process.env.MAX_PHOTO_BYTES || String(4 * 1024 * 1024), 10);
const PIECE_PRESETS = [12, 48, 108, 216, 300, 480];
const CELL = 100; // должно совпадать с CELL в assets/app.js
// Временное послабление (см. план «до 5 параллельных сборок») — потом,
// когда понадобится, ограничим строже; пока просто константа-потолок,
// без претензии на финальный дизайн.
const MAX_ACTIVE_SESSIONS_PER_ROOM = 5;
const SNAP_TOLERANCE = tolerance(CELL);
// Прогресс = размер наибольшего связного кластера деталей (см.
// assets/puzzle-clusters.js), а не поштучный флаг placed из wire-формата —
// клиентскому placed доверять нельзя, только собственному пересчёту.
const clusterProgress = pieces => largestClusterSize(buildClusters(pieces, CELL, SNAP_TOLERANCE).members);

const AUTH_ISSUER = (process.env.AUTH_ISSUER || "").replace(/\/+$/, "");
const AUTH_CLIENT_ID = process.env.AUTH_CLIENT_ID || "puzzle";
const AUTH_BASE = (process.env.AUTH_BASE || AUTH_ISSUER).replace(/\/+$/, "");

// ───────────────────────── хранилище ─────────────────────────
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PUZZLE_PHOTO_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");   // конкурентные чтения не блокируют запись
db.exec("PRAGMA foreign_keys = ON");    // удаление пазла унесёт и прогресс по нему
db.exec(`
  CREATE TABLE IF NOT EXISTS puzzles (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    image_file  TEXT NOT NULL,
    grid_rows   INTEGER NOT NULL,
    grid_cols   INTEGER NOT NULL,
    seed        INTEGER NOT NULL,    -- зашит один раз при вставке, никогда не менять
    sort_order  REAL NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );

  -- Один JSON-документ на пользователя+пазл, а не строка на деталь: иначе
  -- пришлось бы UPSERT-ить на каждый pointermove при сборке.
  CREATE TABLE IF NOT EXISTS puzzle_progress (
    user_id       TEXT NOT NULL,
    puzzle_id     TEXT NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
    pieces        TEXT NOT NULL,     -- JSON: [{r,c,x,y,placed}, ...]
    pieces_placed INTEGER NOT NULL DEFAULT 0,
    pieces_total  INTEGER NOT NULL,
    started_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    completed_at  INTEGER,
    PRIMARY KEY (user_id, puzzle_id)
  );
  CREATE INDEX IF NOT EXISTS idx_progress_user ON puzzle_progress(user_id);

  CREATE TABLE IF NOT EXISTS rooms (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    join_code   TEXT UNIQUE NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  -- Своей таблицы пользователей нет и не будет — ключ user_id из токена,
  -- username/name лежат рядом только для подписи в интерфейсе (тот же
  -- приём, что в Trip/server.js, trip_members).
  CREATE TABLE IF NOT EXISTS room_members (
    room_id   TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL,
    username  TEXT,
    name      TEXT,
    role      TEXT NOT NULL DEFAULT 'member',   -- owner | member
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);

  -- Один сеанс = одна попытка собрать конкретный пазл в этой комнате.
  -- pieces — NULL, пока раскладку не задал первый клиент за столом (см.
  -- WS-протокол, сообщение "init"); формат идентичен puzzle_progress.pieces.
  CREATE TABLE IF NOT EXISTS room_sessions (
    id            TEXT PRIMARY KEY,
    room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    puzzle_id     TEXT NOT NULL REFERENCES puzzles(id),
    pieces        TEXT,
    pieces_placed INTEGER NOT NULL DEFAULT 0,
    pieces_total  INTEGER NOT NULL,
    started_by    TEXT NOT NULL,
    started_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    completed_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_room_sessions_room ON room_sessions(room_id, started_at);
`);

// Раньше — уникальный partial-индекс ("один активный сеанс на комнату" на
// уровне БД). Лимит послаблен до MAX_ACTIVE_SESSIONS_PER_ROOM (см. план «до
// 5 параллельных сборок» — временное послабление, без строгих дальнейших
// гарантий), поэтому UNIQUE снят: дропаем старый индекс на уже развёрнутых
// базах (DROP INDEX IF EXISTS не бросает, если индекса нет — тот же приём,
// что у ALTER TABLE ... ADD COLUMN выше) и создаём заново обычным —
// он всё равно полезен для быстрого подсчёта активных сеансов по комнате.
db.exec("DROP INDEX IF EXISTS idx_room_sessions_active");
db.exec("CREATE INDEX IF NOT EXISTS idx_room_sessions_active ON room_sessions(room_id) WHERE completed_at IS NULL");

// Пост-релизное добавление — таблица puzzles уже существует у всех,
// кто успел развернуть сервис до этой фичи. ALTER TABLE ... ADD COLUMN
// не бывает "IF NOT EXISTS" в SQLite, поэтому try/catch (тот же приём,
// что в Trip/server.js для аналогичных догонов схемы).
try { db.exec("ALTER TABLE puzzles ADD COLUMN owner_user_id TEXT"); } catch {}
db.exec("CREATE INDEX IF NOT EXISTS idx_puzzles_owner ON puzzles(owner_user_id)");

// Лог для Admin (см. admin-internal.js) — своя таблица поверх той же базы.
const adminLog = createAdminLog(db);

const stmt = {
  // Ссылку на базу держим здесь намеренно — иначе V8 вправе выбросить её из
  // контекста модуля, и подготовленные запросы начнут падать с «statement
  // has been finalized» (тот же приём, что в Trip/server.js).
  db,

  puzzles:      db.prepare("SELECT * FROM puzzles ORDER BY sort_order, created_at"),
  puzzle:       db.prepare("SELECT * FROM puzzles WHERE id = ?"),
  insertPuzzle: db.prepare(`INSERT OR IGNORE INTO puzzles
      (id,title,image_file,grid_rows,grid_cols,seed,sort_order,created_at)
      VALUES (?,?,?,?,?,?,?,?)`),

  progress: db.prepare("SELECT * FROM puzzle_progress WHERE user_id = ? AND puzzle_id = ?"),
  upsertProgress: db.prepare(`
    INSERT INTO puzzle_progress (user_id,puzzle_id,pieces,pieces_placed,pieces_total,started_at,updated_at,completed_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id,puzzle_id) DO UPDATE SET
      pieces = excluded.pieces,
      pieces_placed = excluded.pieces_placed,
      pieces_total = excluded.pieces_total,
      updated_at = excluded.updated_at,
      completed_at = excluded.completed_at`),

  puzzlesPublic:  db.prepare("SELECT * FROM puzzles WHERE owner_user_id IS NULL ORDER BY sort_order, created_at"),
  puzzlesVisible: db.prepare("SELECT * FROM puzzles WHERE owner_user_id IS NULL OR owner_user_id = ? ORDER BY sort_order, created_at"),
  insertCustomPuzzle: db.prepare(`INSERT INTO puzzles
      (id,title,image_file,grid_rows,grid_cols,seed,sort_order,created_at,owner_user_id)
      VALUES (?,?,?,?,?,?,?,?,?)`),
  sessionsForPuzzle: db.prepare("SELECT 1 FROM room_sessions WHERE puzzle_id = ? LIMIT 1"),
  deletePuzzle: db.prepare("DELETE FROM puzzles WHERE id = ?"),
  puzzlesByImage: db.prepare("SELECT * FROM puzzles WHERE image_file = ? AND owner_user_id = ?"),
};

Object.assign(stmt, {
  room:         db.prepare("SELECT * FROM rooms WHERE id = ?"),
  roomByCode:   db.prepare("SELECT * FROM rooms WHERE join_code = ?"),
  insertRoom:   db.prepare("INSERT INTO rooms (id,title,join_code,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)"),
  myRooms:      db.prepare(`
    SELECT r.*, m.role, (SELECT COUNT(*) FROM room_members x WHERE x.room_id = r.id) AS members_count
    FROM rooms r JOIN room_members m ON m.room_id = r.id AND m.user_id = ?
    ORDER BY r.updated_at DESC`),

  roomMember:   db.prepare("SELECT * FROM room_members WHERE room_id = ? AND user_id = ?"),
  roomMembers:  db.prepare("SELECT user_id, username, name, role, joined_at FROM room_members WHERE room_id = ? ORDER BY joined_at"),
  addRoomMember: db.prepare(`
    INSERT INTO room_members (room_id,user_id,username,name,role,joined_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(room_id,user_id) DO UPDATE SET username = excluded.username, name = excluded.name`),

  activeSessions: db.prepare("SELECT * FROM room_sessions WHERE room_id = ? AND completed_at IS NULL ORDER BY started_at DESC"),
  session:       db.prepare("SELECT * FROM room_sessions WHERE id = ?"),
  roomSessions:  db.prepare("SELECT * FROM room_sessions WHERE room_id = ? ORDER BY started_at DESC"),
  insertSession: db.prepare(`
    INSERT INTO room_sessions (id,room_id,puzzle_id,pieces,pieces_placed,pieces_total,started_by,started_at,updated_at,completed_at)
    VALUES (?,?,?,NULL,0,?,?,?,?,NULL)`),
  updateSessionPieces: db.prepare(`
    UPDATE room_sessions SET pieces = ?, pieces_placed = ?, updated_at = ?, completed_at = ? WHERE id = ?`),
  deleteSession: db.prepare("DELETE FROM room_sessions WHERE id = ?"),
});

// ───────────────────────── мелкие утилиты ─────────────────────────
const now = () => Date.now();

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("too large"), { tooLarge: true })); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
const readJson = async (req, limit = 512 * 1024) => JSON.parse((await readBody(req, limit)).toString("utf8") || "{}");

// seed выходит за рамки минимального контракта из плана ({id,title,gridRows,
// gridCols,imageUrl}), но без него клиент не сможет детерминированно
// построить те же формы деталей на разных устройствах/сессиях — buildEdges
// в assets/puzzle-shapes.js требует seed на вход. Значение из БД, зашитое
// один раз при вставке (см. BUILTIN_IMAGES ниже и insertCustomPuzzle для
// своих фото) и никогда не меняющееся.
function puzzlePayload(p) {
  return {
    id: p.id, title: p.title, gridRows: p.grid_rows, gridCols: p.grid_cols,
    imageUrl: p.owner_user_id ? `/uploads/${p.image_file}` : `/assets/puzzles/${p.image_file}`,
    seed: p.seed, ownerUserId: p.owner_user_id || null,
  };
}

// Пришедшие с фронта детали — доверенный документ хранится как есть, но
// форма проверяется: чужой сервис/битый клиент не должен положить в базу
// произвольный JSON. rows/cols не пришли явно в body — берём из самого пазла.
function sanitizePieceItem(it, rows, cols) {
  if (!it || typeof it !== "object") return null;
  const r = Number(it.r), c = Number(it.c), x = Number(it.x), y = Number(it.y);
  if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= rows || c < 0 || c >= cols) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { r, c, x, y, placed: !!it.placed };
}
function sanitizePieces(raw, rows, cols) {
  if (!Array.isArray(raw)) return null;
  const total = rows * cols;
  if (raw.length !== total) return null;
  const seen = new Set();
  const out = [];
  for (const it of raw) {
    const p = sanitizePieceItem(it, rows, cols);
    if (!p) return null;
    const key = `${p.r},${p.c}`;
    if (seen.has(key)) return null;
    seen.add(key);
    out.push(p);
  }
  return out;
}
// Частичное обновление (group/shuffle шлют ТОЛЬКО реально изменившиеся
// детали — см. assets/app.js, sendGroup/planShuffle-обработчик комнаты, и
// комментарий у ветки "shuffle"/"group" ниже) — та же форма элемента, что и
// в sanitizePieces, но БЕЗ требования полного покрытия total: от 1 до total
// деталей, без дублей ключей.
function sanitizePiecesPartial(raw, rows, cols) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > rows * cols) return null;
  const seen = new Set();
  const out = [];
  for (const it of raw) {
    const p = sanitizePieceItem(it, rows, cols);
    if (!p) return null;
    const key = `${p.r},${p.c}`;
    if (seen.has(key)) return null;
    seen.add(key);
    out.push(p);
  }
  return out;
}

const PHOTO_MIME = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };

/** Тип файла определяем по сигнатуре, а не по присланному Content-Type. */
function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.toString("latin1", 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (buf.length > 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** cols/rows из целевого числа деталей и соотношения сторон присланной
 *  клиентом картинки — держит детали примерно квадратными вместо того,
 *  чтобы резать любое фото на фиксированную сетку 4:3. */
function gridForPieceTarget(total, width, height) {
  const aspect = (width > 0 && height > 0) ? width / height : 4 / 3;
  const cols = Math.max(2, Math.round(Math.sqrt(total * aspect)));
  const rows = Math.max(2, Math.round(total / cols));
  return { rows, cols };
}

// ───────────────────────── манифест встроенных пазлов ─────────────────────────
// Картинки — SVG-заглушки в assets/puzzles/ (см. README «Картинки для
// встроенных пазлов»): загрузка через Admin — отдельная задача, пока три
// фиксированных изображения, каждое сразу заводит все PIECE_PRESETS уровней
// сложности (тот же приём, что у своих фото — см. POST /api/puzzles ниже),
// накатываются INSERT OR IGNORE при каждом старте.
//
// Раньше (до появления уровней сложности у встроенных пазлов) здесь было
// по одной записи на изображение с rows/cols, подобранными вручную:
// hills 4×3 (12 деталей), forest 8×6 (48), mountains 12×9 (108). Эти три
// числа — ТОЧНЫЙ результат gridForPieceTarget(total, 3, 4) (aspect=3/4=0.75)
// для тех же total — то есть картинки-плейсхолдеры действительно 3:4, и
// исходная сетка была подобрана именно этой формулой. Поэтому недостающие
// уровни (216/300/480 из PIECE_PRESETS) считаем той же функцией с тем же
// aspect, а не подбираем вручную заново.
//
// id/seed трёх «старых» вариантов (12/48/108) — уже сохранённые прогрессы
// существующих пользователей (puzzle_progress завязан на puzzle_id) и
// ссылки вида #/table/hills — их нельзя менять. Новые уровни получают
// новые стабильные id (`hills-216` и т.п.) и новый, но детерминированный на
// каждый рестарт seed (baseSeed + total) — тот же общий file, что и у
// базового изображения, чтобы клиент сгруппировал варианты в одну карточку
// (см. groupPuzzles в assets/app.js, ключ группировки — imageUrl).
const BUILTIN_IMAGES = [
  { key: "hills",     title: "Холмы",  file: "hills.svg",     order: 1, baseSeed: 20260501 },
  { key: "forest",    title: "Лес",    file: "forest.svg",    order: 2, baseSeed: 20260502 },
  { key: "mountains", title: "Горы",   file: "mountains.svg", order: 3, baseSeed: 20260503 },
];
const LEGACY_BUILTIN_TOTALS = { hills: 12, forest: 48, mountains: 108 }; // уже созданы под старыми id, не трогаем
const LEGACY_BUILTIN_SEEDS = { hills: 20260501, forest: 20260502, mountains: 20260503 }; // старые точные значения, не пересчитывать
for (const img of BUILTIN_IMAGES) {
  const legacyTotal = LEGACY_BUILTIN_TOTALS[img.key];
  for (const total of PIECE_PRESETS) {
    const isLegacy = total === legacyTotal;
    const id = isLegacy ? img.key : `${img.key}-${total}`;
    const seed = isLegacy ? LEGACY_BUILTIN_SEEDS[img.key] : img.baseSeed + total;
    const { rows, cols } = gridForPieceTarget(total, 3, 4);
    stmt.insertPuzzle.run(id, img.title, img.file, rows, cols, seed, img.order, Date.now());
  }
}
// Защита от тихой регрессии: если когда-нибудь поменяется aspect в
// gridForPieceTarget, порядок PIECE_PRESETS или что-то ещё в формуле выше,
// три исходные записи (hills/forest/mountains) не должны молча разъехаться
// с уже сохранённым в БД pieces JSON (формы деталей завязаны на rows/cols
// через seed) — падаем сразу при старте вместо того, чтобы визуально
// сломать чей-то уже собранный/начатый пазл.
const EXPECTED_LEGACY_GRID = { hills: [4, 3], forest: [8, 6], mountains: [12, 9] };
for (const [key, [rows, cols]] of Object.entries(EXPECTED_LEGACY_GRID)) {
  const row = stmt.puzzle.get(key);
  if (!row || row.grid_rows !== rows || row.grid_cols !== cols) {
    throw new Error(`Встроенный пазл "${key}": ожидалась сетка ${rows}×${cols}, получено ${row ? `${row.grid_rows}×${row.grid_cols}` : "запись не найдена"}. Останавливаюсь, чтобы не сломать уже сохранённый прогресс.`);
  }
}

function roomPayload(r, role, membersCount) {
  return { id: r.id, title: r.title, joinCode: r.join_code, createdBy: r.created_by,
    createdAt: r.created_at, updatedAt: r.updated_at, role, membersCount };
}
function sessionSummary(s) {
  return { id: s.id, roomId: s.room_id, puzzleId: s.puzzle_id, startedBy: s.started_by,
    piecesPlaced: s.pieces_placed, piecesTotal: s.pieces_total,
    startedAt: s.started_at, updatedAt: s.updated_at, completedAt: s.completed_at,
    puzzle: puzzlePayload(stmt.puzzle.get(s.puzzle_id)) };
}
function str(v, max) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return (t && t.length <= max) ? t : null;
}
function newJoinCode() { // дословно из Trip/server.js
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (const b of crypto.randomBytes(8)) code += alphabet[b % alphabet.length];
  return code;
}

// ───────────────────────── авторизация ─────────────────────────
if (!AUTH_ISSUER) {
  console.error("Не задан AUTH_ISSUER — без него нечем проверять токены. Укажите адрес auth-сервиса, напр. AUTH_ISSUER=https://auth.burninghouse.ru");
  process.exit(1);
}
const auth = require("./auth-client")({
  issuer: AUTH_ISSUER,
  audience: AUTH_CLIENT_ID,
  jwksUrl: process.env.AUTH_JWKS_URL,
  clockSkew: process.env.AUTH_CLOCK_SKEW == null ? undefined : parseInt(process.env.AUTH_CLOCK_SKEW, 10),
});
auth.warmup(); // прогреть кэш ключей, чтобы первый запрос не ждал сеть

// ───────────────────────── HTTP ─────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8",
};
// Отдельные файлы в корне репозитория рядом с index.html: robots.txt и
// sitemap.xml роботы по конвенции ищут именно в корне сайта, а не там, куда
// их реально положили. Каждый добавляется явно сюда И явным COPY в Dockerfile.
const ROOT_FILES = ["robots.txt", "sitemap.xml"];

/** Отдаём только index.html, assets/ и uploads/ (свои фото). store.db и
 *  server.js снаружи недоступны. */
function serveStatic(res, pathname) {
  // Некоторые краулеры/тулы запрашивают /favicon.ico напрямую с корня,
  // игнорируя <link rel="icon"> в index.html — отдаём тот же файл, что и
  // из assets/, без отдельного правила ниже.
  if (pathname === "/favicon.ico") pathname = "/assets/favicon.ico";
  if (ROOT_FILES.includes(pathname.replace(/^\//, ""))) {
    const file = path.join(__dirname, pathname.replace(/^\//, ""));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
    return true;
  }
  if (pathname.startsWith("/uploads/")) {
    const name = path.basename(pathname);
    if (!/^[\w-]+\.(jpg|png|webp)$/i.test(name)) return false;
    const file = path.join(PUZZLE_PHOTO_DIR, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    fs.createReadStream(file).pipe(res);
    return true;
  }
  if (pathname !== "/index.html" && !pathname.startsWith("/assets/")) return false;
  const file = path.join(__dirname, path.normalize(pathname).replace(/^([\\/])+/, ""));
  if (file !== APP_HTML && !file.startsWith(ASSETS_DIR + path.sep)) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
  return true;
}
function serveApp(res) {
  try {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(APP_HTML));
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("index.html не найден рядом с server.js");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (ALLOWED_ORIGIN && p.startsWith("/api/")) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  }

  try {
    if (p === "/api/health") return json(res, 200, { ok: true });

    // Для Admin: server-to-server по общему ключу (см. admin-internal.js), не SSO.
    // Загрузка своих пазлов через Admin — отдельная задача (см. README.md),
    // пока только чтение статистики и лога, по образцу остальных сервисов.
    if (p === "/internal/stats" && req.method === "GET") {
      if (!checkAdminKey(req)) return json(res, 403, { error: "forbidden" });
      const since7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
      return json(res, 200, {
        ok: true,
        puzzles: db.prepare("SELECT COUNT(*) AS n FROM puzzles").get().n,
        progressRows: db.prepare("SELECT COUNT(*) AS n FROM puzzle_progress").get().n,
        completed: db.prepare("SELECT COUNT(*) AS n FROM puzzle_progress WHERE completed_at IS NOT NULL").get().n,
        progressUpdated7d: db.prepare("SELECT COUNT(*) AS n FROM puzzle_progress WHERE updated_at > ?").get(since7d).n,
      });
    }
    if (p === "/internal/logs" && req.method === "GET") {
      if (!checkAdminKey(req)) return json(res, 403, { error: "forbidden" });
      const since = url.searchParams.get("since");
      const limit = url.searchParams.get("limit");
      return json(res, 200, {
        logs: adminLog.recent({ since: since ? Number(since) : undefined, limit: limit ? Number(limit) : undefined }),
      });
    }

    // Адрес auth отдаём с сервера, чтобы он не был зашит в статику.
    if (p === "/api/config") return json(res, 200, {
      authBase: AUTH_BASE, clientId: AUTH_CLIENT_ID,
      maxPhotoBytes: MAX_PHOTO_BYTES, piecePresets: PIECE_PRESETS,
    });

    if (p.startsWith("/api/")) {
      // Анонимный доступ к /api/* — нормальный режим (гость играет без
      // сохранения), не ошибка. 401 возвращают только сами progress-роуты,
      // если пользователя нет — см. api() ниже.
      const user = await auth.userFromRequest(req).catch(() => null);
      return await api(req, res, url, user);
    }

    if (req.method === "GET") {
      if (p !== "/" && serveStatic(res, p)) return;
      return serveApp(res);   // остальное — SPA с маршрутизацией по хэшу
    }
    res.writeHead(404); res.end();
  } catch (e) {
    if (e && e.tooLarge) return json(res, 413, { error: "too large" });
    console.error("Ошибка обработки запроса:", e);
    adminLog.error("Ошибка обработки запроса", { path: p, method: req.method, message: e.message });
    if (!res.headersSent) json(res, 500, { error: "server error" });
    else res.end();
  }
});

async function api(req, res, url, user) {
  const seg = url.pathname.split("/").filter(Boolean); // ["api", "puzzles", ":id", "progress"]
  const m = req.method;

  // Библиотека пазлов: без входа — только встроенные (гость играет без
  // сохранения, это нормальный режим сервиса, не урезанный), вошедшему —
  // ещё и свои приватные (см. «Ключевые решения»: видимость приватная).
  if (seg[1] === "puzzles" && seg.length === 2 && m === "GET") {
    const rows = user ? stmt.puzzlesVisible.all(user.id) : stmt.puzzlesPublic.all();
    return json(res, 200, rows.map(puzzlePayload));
  }

  // Загрузка своего фото и генерация пазла из него — см. README «Свои фото».
  // Один аплоад сразу заводит все варианты сложности (PIECE_PRESETS) —
  // свой id/сетка/seed на каждый, но общий файл картинки и владелец, чтобы
  // клиент мог собрать их в одну карточку (groupPuzzles в app.js).
  if (seg[1] === "puzzles" && seg.length === 2 && m === "POST") {
    if (!user) return json(res, 401, { error: "unauthorized" });

    const width = parseInt(url.searchParams.get("w"), 10) || 0;
    const height = parseInt(url.searchParams.get("h"), 10) || 0;
    const title = str(url.searchParams.get("title"), 80) || "Мой пазл";

    let buf;
    try { buf = await readBody(req, MAX_PHOTO_BYTES); }
    catch (e) { if (e.tooLarge) return json(res, 413, { error: "too large" }); throw e; }
    const mime = sniffImage(buf);
    if (!mime) return json(res, 415, { error: "not an image" });

    const groupId = crypto.randomUUID();
    const file = groupId + PHOTO_MIME[mime];
    fs.writeFileSync(path.join(PUZZLE_PHOTO_DIR, file), buf);
    const ts = now();
    const variants = PIECE_PRESETS.map(total => {
      const { rows, cols } = gridForPieceTarget(total, width, height);
      const id = crypto.randomUUID();
      const seed = crypto.randomInt(1, 2 ** 31 - 1);
      stmt.insertCustomPuzzle.run(id, title, file, rows, cols, seed, ts, ts, user.id);
      return puzzlePayload(stmt.puzzle.get(id));
    });
    return json(res, 200, { title, variants });
  }

  // Удаление своего пазла — целой группой (все варианты сложности одной
  // загрузки, см. «Ключевые решения»), заблокировано, если хоть один вариант
  // уже засветился в комнате (room_sessions.puzzle_id без ON DELETE CASCADE).
  if (seg[1] === "puzzles" && seg[2] && seg.length === 3 && m === "DELETE") {
    if (!user) return json(res, 401, { error: "unauthorized" });
    const puzzle = stmt.puzzle.get(seg[2]);
    if (!puzzle) return json(res, 404, { error: "not found" });
    if (puzzle.owner_user_id !== user.id) return json(res, 403, { error: "not yours" });
    const group = stmt.puzzlesByImage.all(puzzle.image_file, user.id);
    if (group.some(p => stmt.sessionsForPuzzle.get(p.id))) {
      return json(res, 409, { error: "in use", message: "Этим пазлом уже играли в комнате — удалить нельзя." });
    }
    for (const p of group) stmt.deletePuzzle.run(p.id);
    try { fs.unlinkSync(path.join(PUZZLE_PHOTO_DIR, puzzle.image_file)); } catch {}
    return json(res, 200, { ok: true });
  }

  // ── прогресс по конкретному пазлу: единственное, что требует входа ──
  if (seg[1] === "puzzles" && seg[2] && seg[3] === "progress" && seg.length === 4) {
    const puzzle = stmt.puzzle.get(seg[2]);
    if (!puzzle) return json(res, 404, { error: "not found" });

    if (!user) return json(res, 401, { error: "unauthorized" });

    if (m === "GET") {
      const row = stmt.progress.get(user.id, puzzle.id);
      if (!row) return json(res, 200, { pieces: null });
      return json(res, 200, {
        pieces: JSON.parse(row.pieces),
        piecesPlaced: row.pieces_placed,
        piecesTotal: row.pieces_total,
        completedAt: row.completed_at,
      });
    }
    if (m === "PUT") {
      const body = await readJson(req);
      const pieces = sanitizePieces(body.pieces, puzzle.grid_rows, puzzle.grid_cols);
      if (!pieces) return json(res, 400, { error: "bad pieces" });
      const total = puzzle.grid_rows * puzzle.grid_cols;
      const placed = clusterProgress(pieces);
      const existing = stmt.progress.get(user.id, puzzle.id);
      const ts = now();
      // Отметка "Готово" стойкая: однажды выставленный completed_at не
      // затирается обратно в null, даже если сейчас собранных деталей меньше
      // total (например, после «Перемешать») — пазл когда-то был собран, и
      // бейдж в библиотеке не должен пропадать из-за этого.
      const completedAt = existing?.completed_at || (placed >= total ? ts : null);
      stmt.upsertProgress.run(
        user.id, puzzle.id, JSON.stringify(pieces), placed, total,
        existing?.started_at || ts, ts, completedAt,
      );
      return json(res, 200, { ok: true, piecesPlaced: placed, piecesTotal: total, completedAt });
    }
    return json(res, 405, { error: "method not allowed" });
  }

  if (seg[1] === "rooms") {
    if (!user) return json(res, 401, { error: "unauthorized" });

    if (seg.length === 2 && m === "POST") {
      const body = await readJson(req);
      const title = str(body.title, 120);
      if (!title) return json(res, 400, { error: "bad title" });
      const id = crypto.randomUUID(), ts = now(), code = newJoinCode();
      stmt.insertRoom.run(id, title, code, user.id, ts, ts);
      stmt.addRoomMember.run(id, user.id, user.username || null, user.name || null, "owner", ts);
      return json(res, 200, roomPayload(stmt.room.get(id), "owner", 1));
    }

    if (seg.length === 2 && m === "GET") {
      return json(res, 200, stmt.myRooms.all(user.id).map(r => roomPayload(r, r.role, r.members_count)));
    }

    if (seg[2] === "join" && seg[3] && seg.length === 4) {
      const code = String(seg[3]).toUpperCase().slice(0, 16);
      const room = stmt.roomByCode.get(code);
      if (!room) return json(res, 404, { error: "no such invite" });
      const already = stmt.roomMember.get(room.id, user.id);
      if (m === "GET") {
        return json(res, 200, {
          roomId: room.id, title: room.title, alreadyMember: !!already,
          members: stmt.roomMembers.all(room.id).map(x => x.name || x.username).filter(Boolean),
        });
      }
      if (m === "POST") {
        if (!already) stmt.addRoomMember.run(room.id, user.id, user.username || null, user.name || null, "member", now());
        return json(res, 200, { roomId: room.id, joined: !already });
      }
      return json(res, 405, { error: "method not allowed" });
    }

    if (seg[2]) {
      const roomId = seg[2];
      const room = stmt.room.get(roomId);
      if (!room) return json(res, 404, { error: "not found" });
      const member = stmt.roomMember.get(roomId, user.id);
      if (!member) return json(res, 403, { error: "not a member" });

      if (seg.length === 3 && m === "GET") {
        return json(res, 200, {
          ...roomPayload(room, member.role),
          members: stmt.roomMembers.all(roomId),
          activeSessions: stmt.activeSessions.all(roomId).map(sessionSummary),
        });
      }

      if (seg[3] === "sessions" && seg.length === 4 && m === "GET") {
        return json(res, 200, stmt.roomSessions.all(roomId).map(sessionSummary));
      }

      if (seg[3] === "sessions" && seg.length === 4 && m === "POST") {
        const activeCount = stmt.activeSessions.all(roomId).length;
        if (activeCount >= MAX_ACTIVE_SESSIONS_PER_ROOM) {
          return json(res, 409, { error: "room session limit reached", limit: MAX_ACTIVE_SESSIONS_PER_ROOM });
        }
        const body = await readJson(req);
        const puzzle = stmt.puzzle.get(body.puzzleId);
        if (!puzzle) return json(res, 400, { error: "bad puzzle" });
        const id = crypto.randomUUID(), ts = now();
        stmt.insertSession.run(id, roomId, puzzle.id, puzzle.grid_rows * puzzle.grid_cols, user.id, ts, ts);
        return json(res, 200, sessionSummary(stmt.session.get(id)));
      }

      if (seg[3] === "sessions" && seg[4] && seg.length === 5 && m === "GET") {
        const session = stmt.session.get(seg[4]);
        if (!session || session.room_id !== roomId) return json(res, 404, { error: "not found" });
        return json(res, 200, sessionSummary(session));
      }

      // Удаление сеанса — освобождает слот из MAX_ACTIVE_SESSIONS_PER_ROOM
      // (см. константу выше), если кто-то по ошибке начал лишнюю сборку и
      // ушёл. Членство в комнате уже проверено выше (member). Нельзя удалить
      // сеанс, за которым сейчас реально кто-то сидит за столом — только
      // "активный, но пустой" или уже завершённый.
      if (seg[3] === "sessions" && seg[4] && seg.length === 5 && m === "DELETE") {
        const session = stmt.session.get(seg[4]);
        if (!session || session.room_id !== roomId) return json(res, 404, { error: "not found" });
        const live = liveSessions.get(session.id);
        if (!session.completed_at && live && live.conns.size > 0) {
          return json(res, 409, { error: "table not empty" });
        }
        stmt.deleteSession.run(session.id);
        // Объект RoomState мог остаться в карте с нулём подключений (сеанс
        // был активным, но никто не сидел за столом) — убираем ссылку на
        // теперь уже удалённую строку БД, чтобы persistSession/schedulePersist
        // не воскресили её обратно записью в никуда.
        if (live) liveSessions.delete(session.id);
        return json(res, 200, { ok: true });
      }
    }

    return json(res, 404, { error: "not found" });
  }

  return json(res, 404, { error: "not found" });
}

// ───────────────────────── комнаты: in-memory реестр столов ─────────────────────────
// Раскладка деталей не дублируется на сервере при старте сеанса (pieces —
// NULL в БД, см. схему) — первый подключившийся клиент считает её локально
// тем же кодом, что и в соло (scatterLayout), и шлёт "init"; сервер
// принимает первый валидный init как каноническую раскладку. Живое
// состояние стола держим тут, в памяти процесса, персист в SQLite —
// дебаунсом, чтобы не писать на диск на каждый pointermove.
const liveSessions = new Map(); // sessionId -> RoomState

function loadSessionState(sessionId) {
  const row = stmt.session.get(sessionId);
  if (!row || row.completed_at) return null;
  const puzzle = stmt.puzzle.get(row.puzzle_id);
  if (!puzzle) return null;
  return {
    sessionId, roomId: row.room_id,
    rows: puzzle.grid_rows, cols: puzzle.grid_cols,
    piecesTotal: puzzle.grid_rows * puzzle.grid_cols,
    pieces: row.pieces ? JSON.parse(row.pieces) : null,
    conns: new Set(),
    dirty: false, saveTimer: null,
  };
}

function persistSession(state) {
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  if (!state.dirty || !state.pieces) return;
  state.dirty = false;
  const placed = clusterProgress(state.pieces);
  const ts = now();
  const completedAt = placed >= state.piecesTotal ? ts : null;
  stmt.updateSessionPieces.run(JSON.stringify(state.pieces), placed, ts, completedAt, state.sessionId);
}

// Дебаунс ~1.5с при активности; финальный снап и уход последнего
// участника флашатся немедленно.
function schedulePersist(state) {
  state.dirty = true;
  if (state.saveTimer) return;
  state.saveTimer = setTimeout(() => persistSession(state), 1500);
}

function broadcast(state, msg, exceptConn) {
  const raw = JSON.stringify(msg);
  for (const c of state.conns) {
    if (exceptConn && c === exceptConn) continue;
    c.ws.send(raw);
  }
}
function presenceList(state) {
  return [...state.conns].map(c => ({ id: c.user.id, name: c.user.name || c.user.username }));
}
function broadcastPresence(state) {
  broadcast(state, { type: "presence", members: presenceList(state) }, null);
}

function attachRoomConnection(sessionId, user, wsConn) {
  let state = liveSessions.get(sessionId);
  if (!state) {
    state = loadSessionState(sessionId);
    if (!state) { wsConn.close(); return; }
    liveSessions.set(sessionId, state);
  }
  const conn = { ws: wsConn, user };
  state.conns.add(conn);

  wsConn.send(JSON.stringify({
    type: "sync", pieces: state.pieces, piecesTotal: state.piecesTotal,
    piecesPlaced: state.pieces ? clusterProgress(state.pieces) : 0,
    members: presenceList(state),
  }));
  broadcastPresence(state);

  wsConn.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "init") {
      if (state.pieces) return;
      const pieces = sanitizePieces(msg.pieces, state.rows, state.cols);
      if (!pieces) return;
      state.pieces = pieces;
      schedulePersist(state);
      broadcast(state, {
        type: "sync", pieces: state.pieces, piecesTotal: state.piecesTotal,
        piecesPlaced: clusterProgress(pieces), members: presenceList(state),
      }, null);
      return;
    }

    // Перемешать может только уже раскрытая раскладка (state.pieces есть) —
    // и только активный сеанс: attachRoomConnection в принципе недостижим для
    // уже completed_at-сеанса (loadSessionState/handleUpgrade отсекают раньше),
    // так что отдельно проверять завершённость здесь нечего.
    // `group` — то же самое сообщение с другим именем, для группового
    // перетаскивания деталей (см. assets/app.js, bindRoomPieceDrag), не
    // только для кнопки «Перемешать».
    //
    // ВАЖНО: msg.pieces несёт ТОЛЬКО те детали, которые отправитель реально
    // подвинул за этот жест/перемешивание (см. sendGroup/shuffleBtn в
    // assets/app.js) — не весь борд. Раньше это был полный снимок ЛОКАЛЬНОГО
    // pieces отправителя на момент finish(), и сервер слепо заменял им
    // state.pieces целиком (state.pieces = pieces). При одновременном
    // перетаскивании РАЗНЫМИ участниками это была настоящая гонка: если A
    // стыкует деталь ровно в тот момент, когда локальный снимок B ещё не
    // получил через sync этот ход A, а B чуть позже шлёт СВОЙ group/shuffle,
    // полный массив B (устаревший в части хода A) полностью перезаписывал
    // state.pieces — стыковка A пропадала/откатывалась, прогресс "прыгал
    // назад". Теперь сообщение частичное и мержится по ключу (r,c) поверх
    // текущего state.pieces — сервер трогает только те детали, которые
    // отправитель реально подтверждает, не откатывая то, чего он не касался
    // (регресс — test/e2e-rooms.mjs, «конкурентные ходы двух участников»).
    if (msg.type === "shuffle" || msg.type === "group") {
      if (!state.pieces) return;
      const incoming = sanitizePiecesPartial(msg.pieces, state.rows, state.cols);
      if (!incoming) return;
      const byKey = new Map(incoming.map(p => [`${p.r},${p.c}`, p]));
      state.pieces = state.pieces.map(p => byKey.get(`${p.r},${p.c}`) || p);
      const placedNow = clusterProgress(state.pieces);
      schedulePersist(state);
      if (placedNow >= state.piecesTotal) persistSession(state);
      broadcast(state, {
        type: "sync", pieces: state.pieces, piecesTotal: state.piecesTotal,
        piecesPlaced: placedNow, members: presenceList(state),
      }, null); // всем, включая отправителя — тот же приём, что у init
      return;
    }

    if (!state.pieces) return;
    if (msg.type !== "move") return;

    const r = Number(msg.r), c = Number(msg.c), x = Number(msg.x), y = Number(msg.y);
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= state.rows || c < 0 || c >= state.cols) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const piece = state.pieces.find(p => p.r === r && p.c === c);
    if (!piece) return;

    piece.x = x; piece.y = y;
    schedulePersist(state);
    broadcast(state, { type: "move", r, c, x, y, by: user.id }, conn);
  });

  wsConn.on("close", () => {
    state.conns.delete(conn);
    if (state.conns.size === 0) {
      persistSession(state);
      liveSessions.delete(sessionId);
    } else {
      broadcastPresence(state);
    }
  });
}

// ───────────────────────── комнаты: WS upgrade ─────────────────────────
function rejectUpgrade(socket, code, message) {
  try { socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\n\r\n`); } catch {}
  socket.destroy();
}

server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => {});
  handleUpgrade(req, socket, head).catch(e => {
    console.error("Ошибка WS upgrade:", e);
    try { socket.destroy(); } catch {}
  });
});

async function handleUpgrade(req, socket, head) {
  let url;
  try { url = new URL(req.url, "http://x"); } catch { return rejectUpgrade(socket, 400, "Bad Request"); }

  if (ALLOWED_ORIGIN) {
    const origin = req.headers.origin || "";
    if (origin && origin !== ALLOWED_ORIGIN) return rejectUpgrade(socket, 403, "Forbidden");
  }

  const seg = url.pathname.split("/").filter(Boolean); // ["ws","rooms",":id","sessions",":sid"]
  if (seg[0] !== "ws" || seg[1] !== "rooms" || !seg[2] || seg[3] !== "sessions" || !seg[4] || seg.length !== 5) {
    return rejectUpgrade(socket, 404, "Not Found");
  }
  const roomId = decodeURIComponent(seg[2]);
  const sessionId = decodeURIComponent(seg[4]);

  const token = url.searchParams.get("token");
  const payload = token ? await auth.verify(token) : null;
  if (!payload) return rejectUpgrade(socket, 401, "Unauthorized");

  const member = stmt.roomMember.get(roomId, payload.sub);
  if (!member) return rejectUpgrade(socket, 403, "Forbidden");

  const session = stmt.session.get(sessionId);
  if (!session || session.room_id !== roomId) return rejectUpgrade(socket, 404, "Not Found");
  if (session.completed_at) return rejectUpgrade(socket, 410, "Gone");

  const conn = ws.acceptUpgrade(req, socket, head);
  if (!conn) return;

  attachRoomConnection(sessionId, {
    id: payload.sub, username: payload.preferred_username || null, name: payload.name || null,
  }, conn);
}

server.listen(PORT, HOST, () => {
  console.log(`Что собираем? слушает http://${HOST}:${PORT}`);
  console.log(`Авторизация: ${AUTH_ISSUER} (клиент «${AUTH_CLIENT_ID}»)`);
});
