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
const { buildClusters, largestClusterSize, connectedPiecesCount, tolerance } = require("./assets/puzzle-clusters.js");

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
// Прогресс = сумма деталей во ВСЕХ кластерах от двух и больше (см.
// assets/puzzle-clusters.js/connectedPiecesCount), а не поштучный флаг
// placed из wire-формата — клиентскому placed доверять нельзя, только
// собственному пересчёту. Раньше здесь был largestClusterSize (размер
// только САМОГО БОЛЬШОГО кластера) — деталь, состыкованная в отдельный от
// основного кусок, в счётчик не попадала, что выглядело как "не
// засчиталось". isSolved ниже — отдельная, более строгая проверка: пазл
// реально СОБРАН только когда все детали — один кластер, не просто у
// каждой есть сосед где-то на борде (используется вместо clusterProgress
// там, где решается "показать ли победу"/completed_at).
const clusterProgress = pieces => connectedPiecesCount(buildClusters(pieces, CELL, SNAP_TOLERANCE).members);
const isSolved = (pieces, total) => largestClusterSize(buildClusters(pieces, CELL, SNAP_TOLERANCE).members) >= total;

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

// Своя картинка была видна владельцу во ВСЕХ его комнатах — баг, не задумка
// (см. README): загруженное в одной комнате протекало в другую просто по
// владению, без всякой привязки к конкретной комнате. room_id — граница
// видимости: NULL у встроенных (видны всем и всегда), заполнен у своих фото
// (видны только за столом ЭТОЙ комнаты). Публикация «для всех» — отдельная,
// сознательно отложенная задача (см. README «Свои фото»); пока опубликовать
// нельзя, значит границы room_id достаточно.
try { db.exec("ALTER TABLE puzzles ADD COLUMN room_id TEXT"); } catch {}
db.exec("CREATE INDEX IF NOT EXISTS idx_puzzles_room ON puzzles(room_id)");

// «Ассиметричная форма» (см. assets/puzzle-shapes.js, buildEdges options.asymmetric)
// — выбор конкретной ПОПЫТКИ сборки, не свойство самого пазла: тот же
// puzzle_id можно переиграть и с обычной, и с ассиметричной формой, поэтому
// флаг живёт на сеансе, а не в puzzles.
try { db.exec("ALTER TABLE room_sessions ADD COLUMN asymmetric_shape INTEGER NOT NULL DEFAULT 0"); } catch {}

// Встроенные пазлы (Холмы/Лес/Горы) видны во ВСЕХ комнатах сразу (owner_user_id
// IS NULL — см. puzzlesForRoom) — не всем участникам конкретной комнаты они
// нужны. Скрытие ЛОКАЛЬНО для комнаты (не удаление самого пазла: он остаётся
// глобально доступным везде ещё) — новая таблица, не колонка на puzzles,
// потому что это отношение many-to-many (один и тот же встроенный пазл можно
// скрыть в одной комнате и оставить видимым в другой). ON DELETE CASCADE у
// обоих внешних ключей — запись сама уберётся, если комнату или пазл когда-
// нибудь удалят.
db.exec(`
  CREATE TABLE IF NOT EXISTS room_hidden_puzzles (
    room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    puzzle_id  TEXT NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
    hidden_by  TEXT NOT NULL,
    hidden_at  INTEGER NOT NULL,
    PRIMARY KEY (room_id, puzzle_id)
  );
`);

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
  // Встроенные (кроме скрытых ИМЕННО в этой комнате — см. room_hidden_puzzles)
  // + СВОИ ФОТО ИМЕННО ЭТОЙ КОМНАТЫ (room_id) — не все фото владельца по всем
  // его комнатам (см. комментарий у ALTER TABLE room_id выше). Публикация
  // «для всех» пока не реализована. roomId передаётся дважды — раз на свою
  // область видимости (room_id = ?), раз на фильтр скрытых.
  puzzlesForRoom: db.prepare(`
    SELECT * FROM puzzles
    WHERE (owner_user_id IS NULL OR room_id = ?)
      AND id NOT IN (SELECT puzzle_id FROM room_hidden_puzzles WHERE room_id = ?)
    ORDER BY sort_order, created_at`),
  insertCustomPuzzle: db.prepare(`INSERT INTO puzzles
      (id,title,image_file,grid_rows,grid_cols,seed,sort_order,created_at,owner_user_id,room_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`),
  sessionsForPuzzle: db.prepare("SELECT 1 FROM room_sessions WHERE puzzle_id = ? LIMIT 1"),
  deletePuzzle: db.prepare("DELETE FROM puzzles WHERE id = ?"),
  puzzlesByImage: db.prepare("SELECT * FROM puzzles WHERE image_file = ? AND owner_user_id = ?"),
  // Группа встроенных пазлов, добавленных Admin (owner_user_id IS NULL —
  // "= ?" тут не сработал бы, NULL с ним никогда не совпадает). Отличаем от
  // трёх стартовых картинок (BUILTIN_IMAGES, всегда .svg) расширением файла
  // в JS-коде — см. isAdminUploadedFile ниже, не тут.
  puzzlesByImagePublic: db.prepare("SELECT * FROM puzzles WHERE image_file = ? AND owner_user_id IS NULL"),
  // Скрытие встроенного пазла в конкретной комнате (не удаление — см. схему
  // room_hidden_puzzles) — доступно любому участнику комнаты, не только
  // владельцу: это общая настройка «что показываем в ЭТОЙ комнате», не личная
  // вещь одного участника. DO NOTHING — повторное скрытие уже скрытого не
  // должно падать ошибкой (идемпотентно).
  hidePuzzleInRoom: db.prepare(`
    INSERT INTO room_hidden_puzzles (room_id,puzzle_id,hidden_by,hidden_at) VALUES (?,?,?,?)
    ON CONFLICT(room_id,puzzle_id) DO NOTHING`),
  unhidePuzzleInRoom: db.prepare("DELETE FROM room_hidden_puzzles WHERE room_id = ? AND puzzle_id = ?"),
  hiddenPuzzlesForRoom: db.prepare("SELECT puzzle_id FROM room_hidden_puzzles WHERE room_id = ?"),
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
  // Лимит сессий снимается не от ЛЮБОГО вошедшего участника, а только от
  // создателя комнаты (role='owner') — см. правку «лимиты поднимаются,
  // только если авторизован создатель». Считается на лету по факту
  // авторизации владельца, не хранится отдельным полем, чтобы не могло
  // рассинхрониться со строками room_members (тот же приём, что раньше).
  roomOwnerAuthed: db.prepare("SELECT 1 FROM room_members WHERE room_id = ? AND role = 'owner' AND user_id NOT LIKE 'anon:%' LIMIT 1"),
  // Клейм анонимного членства настоящим аккаунтом при входе (см. план) —
  // сохраняет role (в т.ч. owner, если анонимно создал именно эту комнату)
  // вместо того, чтобы завести отдельную новую строку и потерять её.
  claimAnonMembership: db.prepare(`
    UPDATE room_members SET user_id = ?, username = ?, name = ? WHERE room_id = ? AND user_id = ?`),
  deleteRoomMember: db.prepare("DELETE FROM room_members WHERE room_id = ? AND user_id = ?"),

  activeSessions: db.prepare("SELECT * FROM room_sessions WHERE room_id = ? AND completed_at IS NULL ORDER BY started_at DESC"),
  session:       db.prepare("SELECT * FROM room_sessions WHERE id = ?"),
  roomSessions:  db.prepare("SELECT * FROM room_sessions WHERE room_id = ? ORDER BY started_at DESC"),
  insertSession: db.prepare(`
    INSERT INTO room_sessions (id,room_id,puzzle_id,pieces,pieces_placed,pieces_total,started_by,started_at,updated_at,completed_at,asymmetric_shape)
    VALUES (?,?,?,NULL,0,?,?,?,?,NULL,?)`),
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

// ── анонимные комнаты: своя личность через cookie, без Auth/JWT ──
// У Auth и остальных сервисов BurningHouse нет понятия анонимной сессии
// вообще (см. план) — это целиком локальный примитив Puzzle. Префикс
// "anon:" гарантирует, что псевдо-id никогда не совпадёт с настоящим JWT
// sub (тоже UUID) — по этому же префиксу остальной код отличает
// анонимного участника комнаты от настоящего (лимит сессий, клейм
// членства при входе — см. ниже). НИКОГДА не подставлять эту личность
// туда, где нужен настоящий вход (загрузка своих фото — /api/puzzles
// POST уже проверяет user отдельно и эту проверку не трогаем).
const ANON_COOKIE = "puzzle_anon";
const ANON_MAX_AGE = 60 * 60 * 24 * 180; // 180 дней
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Достаёт анонимную личность из cookie, при необходимости заводит новую
 *  (Set-Cookie на res — должно быть вызвано ДО json()/res.writeHead, иначе
 *  заголовок не долетит до ответа). */
function getOrCreateAnonIdentity(req, res) {
  const cookies = parseCookies(req);
  let id = cookies[ANON_COOKIE];
  if (!id || !UUID_RE.test(id)) {
    id = crypto.randomUUID();
    const secure = AUTH_ISSUER.startsWith("https://") ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${ANON_COOKIE}=${id}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${ANON_MAX_AGE}${secure}`);
  }
  return { id: "anon:" + id, username: null, name: null };
}

/** Тот же cookie, но без побочного эффекта (никогда не заводит новый) —
 *  нужен там, где важно только УЗНАТЬ, была ли эта личность недавно
 *  анонимом в конкретной комнате (клейм членства при входе), а не всегда
 *  гарантированно иметь какую-то анонимную личность. */
function readAnonId(req) {
  const id = parseCookies(req)[ANON_COOKIE];
  return id && UUID_RE.test(id) ? "anon:" + id : null;
}

// seed выходит за рамки минимального контракта из плана ({id,title,gridRows,
// gridCols,imageUrl}), но без него клиент не сможет детерминированно
// построить те же формы деталей на разных устройствах/сессиях — buildEdges
// в assets/puzzle-shapes.js требует seed на вход. Значение из БД, зашитое
// один раз при вставке (см. BUILTIN_IMAGES ниже и insertCustomPuzzle для
// своих фото) и никогда не меняющееся.
//
// imageUrl раньше решался по owner_user_id (NULL → /assets/puzzles/, иначе
// → /uploads/) — это совпадало с "где физически лежит файл" ровно пока
// единственным источником owner_user_id IS NULL были три стартовые картинки
// (BUILTIN_IMAGES, .svg в статике). С добавлением загрузки через Admin
// (см. POST /internal/puzzles) появились НЕ-.svg пазлы с owner_user_id
// IS NULL: они физически лежат в PUZZLE_PHOTO_DIR/uploads, как и свои
// фото пользователей. .svg бывает только у трёх стартовых картинок —
// sniffImage вообще не пропускает SVG на вход POST /api/puzzles и
// POST /internal/puzzles, так что путаницы файл↔расширение тут не бывает.
function puzzlePayload(p) {
  return {
    id: p.id, title: p.title, gridRows: p.grid_rows, gridCols: p.grid_cols,
    imageUrl: p.image_file.endsWith(".svg") ? `/assets/puzzles/${p.image_file}` : `/uploads/${p.image_file}`,
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
    asymmetricShape: !!s.asymmetric_shape,
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
    // Набор полей — по образцу Movies/server.js (rooms/roomsCreated7d и т.п.):
    // комнаты появились в Puzzle позже первой версии /internal/stats, эти
    // счётчики раньше сюда просто не попали.
    if (p === "/internal/stats" && req.method === "GET") {
      if (!checkAdminKey(req)) return json(res, 403, { error: "forbidden" });
      const since7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
      return json(res, 200, {
        ok: true,
        puzzles: db.prepare("SELECT COUNT(*) AS n FROM puzzles").get().n,
        customPuzzles: db.prepare("SELECT COUNT(*) AS n FROM puzzles WHERE owner_user_id IS NOT NULL").get().n,
        progressRows: db.prepare("SELECT COUNT(*) AS n FROM puzzle_progress").get().n,
        completed: db.prepare("SELECT COUNT(*) AS n FROM puzzle_progress WHERE completed_at IS NOT NULL").get().n,
        progressUpdated7d: db.prepare("SELECT COUNT(*) AS n FROM puzzle_progress WHERE updated_at > ?").get(since7d).n,
        rooms: db.prepare("SELECT COUNT(*) AS n FROM rooms").get().n,
        roomsCreated7d: db.prepare("SELECT COUNT(*) AS n FROM rooms WHERE created_at > ?").get(since7d).n,
        roomSessions: db.prepare("SELECT COUNT(*) AS n FROM room_sessions").get().n,
        roomSessionsCompleted: db.prepare("SELECT COUNT(*) AS n FROM room_sessions WHERE completed_at IS NOT NULL").get().n,
        roomSessionsStarted7d: db.prepare("SELECT COUNT(*) AS n FROM room_sessions WHERE started_at > ?").get(since7d).n,
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

    // Вкладка «Комнаты» в Admin — общий формат "групп с кодом приглашения"
    // (см. Admin/assets/app.js loadRooms, дословно как /internal/rooms у
    // Trip). У Puzzle нет своих полей destination/status (это понятия из
    // путешествий) — шлём null, шаблон Admin уже рисует их как "—".
    // placesCount там подписан "Мест" (места в поездке) — для Puzzle туда
    // кладём число сеансов сборки в комнате (всего, не только активных):
    // не идеальное совпадение по смыслу подписи, но живая и полезная
    // владельцу комнаты цифра, а не пустая заглушка.
    if (p === "/internal/rooms" && req.method === "GET") {
      if (!checkAdminKey(req)) return json(res, 403, { error: "forbidden" });
      const rows = db.prepare(`
        SELECT r.id, r.title, r.join_code, r.created_at,
               (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS members,
               (SELECT COUNT(*) FROM room_sessions s WHERE s.room_id = r.id) AS sessions
        FROM rooms r
        ORDER BY r.created_at DESC
        LIMIT 200
      `).all();
      return json(res, 200, {
        rooms: rows.map(r => ({
          id: r.id, title: r.title, destination: null, status: null,
          joinCode: r.join_code || null, membersCount: r.members, placesCount: r.sessions, createdAt: r.created_at,
        })),
      });
    }

    // Загрузка картинок в библиотеку через Admin (см. README «Загрузка через
    // Admin») — новые дефолтные пазлы, доступные без входа, наравне с тремя
    // стартовыми (BUILTIN_IMAGES). Тот же приём, что у своих фото (POST
    // /api/puzzles ниже): один аплоад сразу заводит все PIECE_PRESETS
    // вариантов сложности. Отличия от своего фото — owner_user_id/room_id
    // оба NULL (видно всем и без входа, не только автору/в одной комнате) и
    // тело запроса — JSON с base64 картинкой, а не сырые байты: Admin ходит
    // сюда server-to-server через callService, который всегда шлёт JSON
    // (см. Admin/server.js), поднимать под этот один вызов бинарный проброс
    // там не стали.
    if (p === "/internal/puzzles" && req.method === "GET") {
      if (!checkAdminKey(req)) return json(res, 403, { error: "forbidden" });
      // Публичные пазлы минус три стартовые (.svg) — только то, что реально
      // добавлено через этот же эндпоинт, сгруппированное по файлу (та же
      // идея, что у groupPuzzles в assets/app.js, но на сервере — тут не
      // нужна дедупликация по нескольким полям, только по image_file).
      const rows = stmt.puzzlesPublic.all().filter(row => !row.image_file.endsWith(".svg"));
      const groups = new Map();
      for (const row of rows) {
        if (!groups.has(row.image_file)) {
          groups.set(row.image_file, { id: row.id, title: row.title, imageUrl: `/uploads/${row.image_file}`, variants: 0, createdAt: row.created_at });
        }
        groups.get(row.image_file).variants++;
      }
      return json(res, 200, { puzzles: [...groups.values()] });
    }
    if (p === "/internal/puzzles" && req.method === "POST") {
      if (!checkAdminKey(req)) return json(res, 403, { error: "forbidden" });
      // base64 раздувает байты примерно на треть — лимит readJson должен
      // это учитывать, иначе картинка ровно на границе MAX_PHOTO_BYTES
      // ложно словит "тело слишком большое" ещё до проверки buf.length ниже.
      const body = await readJson(req, Math.ceil(MAX_PHOTO_BYTES * 1.4) + 4096);
      const title = str(body.title, 80) || "Библиотека";
      const buf = Buffer.from(String(body.imageBase64 || ""), "base64");
      if (!buf.length) return json(res, 400, { error: "missing image" });
      if (buf.length > MAX_PHOTO_BYTES) return json(res, 413, { error: "too large" });
      const mime = sniffImage(buf);
      if (!mime) return json(res, 415, { error: "not an image" });
      const width = parseInt(body.width, 10) || 0;
      const height = parseInt(body.height, 10) || 0;

      const groupId = crypto.randomUUID();
      const file = groupId + PHOTO_MIME[mime];
      fs.writeFileSync(path.join(PUZZLE_PHOTO_DIR, file), buf);
      const ts = now();
      const variants = PIECE_PRESETS.map(total => {
        const { rows, cols } = gridForPieceTarget(total, width, height);
        const id = crypto.randomUUID();
        const seed = crypto.randomInt(1, 2 ** 31 - 1);
        stmt.insertCustomPuzzle.run(id, title, file, rows, cols, seed, ts, ts, null, null);
        return puzzlePayload(stmt.puzzle.get(id));
      });
      adminLog.info("Admin добавил картинку в библиотеку", { title, variants: variants.length });
      return json(res, 200, { title, variants });
    }
    const puzzleDeleteMatch = p.match(/^\/internal\/puzzles\/([\w-]+)$/);
    if (puzzleDeleteMatch && req.method === "DELETE") {
      if (!checkAdminKey(req)) return json(res, 403, { error: "forbidden" });
      const puzzle = stmt.puzzle.get(puzzleDeleteMatch[1]);
      if (!puzzle) return json(res, 404, { error: "not found" });
      // Три стартовые картинки (BUILTIN_IMAGES, всегда .svg) этим путём не
      // трогаем — их удаление уронит #/table/hills и т.п. ссылки и чужой уже
      // сохранённый прогресс. Своё фото пользователя (owner_user_id не NULL)
      // сюда тоже не должно попасть — у него свой DELETE /api/puzzles/:id.
      if (puzzle.owner_user_id !== null || puzzle.image_file.endsWith(".svg")) {
        return json(res, 400, { error: "not an admin-uploaded puzzle" });
      }
      const group = stmt.puzzlesByImagePublic.all(puzzle.image_file);
      if (group.some(gp => stmt.sessionsForPuzzle.get(gp.id))) {
        return json(res, 409, { error: "in use", message: "Этим пазлом уже играли в комнате — удалить нельзя." });
      }
      for (const gp of group) stmt.deletePuzzle.run(gp.id);
      try { fs.unlinkSync(path.join(PUZZLE_PHOTO_DIR, puzzle.image_file)); } catch {}
      adminLog.info("Admin удалил картинку из библиотеки", { puzzleId: puzzle.id, title: puzzle.title });
      return json(res, 200, { ok: true });
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

  // Библиотека пазлов: без входа или без ?roomId= — только встроенные
  // (гость играет без сохранения, это нормальный режим сервиса, не
  // урезанный; своих фото соло-библиотека не показывает вовсе — см.
  // README «Свои фото»). С ?roomId= — ещё и свои фото ИМЕННО этой комнаты,
  // при условии членства в ней (иначе можно было бы подглядеть чужие).
  if (seg[1] === "puzzles" && seg.length === 2 && m === "GET") {
    const roomId = url.searchParams.get("roomId");
    if (roomId) {
      // Та же анонимная личность, что и в /api/rooms/* (см. план) —
      // список пазлов комнаты (пикер стола) должен открываться и без
      // входа, если это твоя комната.
      const identity = user || getOrCreateAnonIdentity(req, res);
      if (!stmt.roomMember.get(roomId, identity.id)) return json(res, 403, { error: "not a member" });
      return json(res, 200, stmt.puzzlesForRoom.all(roomId, roomId).map(puzzlePayload));
    }
    return json(res, 200, stmt.puzzlesPublic.all().map(puzzlePayload));
  }

  // Загрузка своего фото и генерация пазла из него — см. README «Свои фото».
  // Один аплоад сразу заводит все варианты сложности (PIECE_PRESETS) —
  // свой id/сетка/seed на каждый, но общий файл картинки, владелец И комната
  // (room_id — граница видимости, не протекает в другие комнаты того же
  // владельца), чтобы клиент мог собрать их в одну карточку (groupPuzzles
  // в app.js) и показать только за столом этой комнаты.
  if (seg[1] === "puzzles" && seg.length === 2 && m === "POST") {
    if (!user) return json(res, 401, { error: "unauthorized" });

    const roomId = str(url.searchParams.get("roomId"), 64);
    if (!roomId) return json(res, 400, { error: "roomId required" });
    if (!stmt.roomMember.get(roomId, user.id)) return json(res, 403, { error: "not a member" });

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
      stmt.insertCustomPuzzle.run(id, title, file, rows, cols, seed, ts, ts, user.id, roomId);
      return puzzlePayload(stmt.puzzle.get(id));
    });
    adminLog.info("Загружено своё фото", { userId: user.id, roomId, title, variants: variants.length });
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
    adminLog.info("Своё фото удалено", { userId: user.id, puzzleId: puzzle.id, title: puzzle.title, variants: group.length });
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
      const completedAt = existing?.completed_at || (isSolved(pieces, total) ? ts : null);
      stmt.upsertProgress.run(
        user.id, puzzle.id, JSON.stringify(pieces), placed, total,
        existing?.started_at || ts, ts, completedAt,
      );
      return json(res, 200, { ok: true, piecesPlaced: placed, piecesTotal: total, completedAt });
    }
    return json(res, 405, { error: "method not allowed" });
  }

  if (seg[1] === "rooms") {
    // Комнату можно создать/открыть и без входа — см. план «анонимные
    // комнаты». identity — настоящий user, если он есть, иначе анонимная
    // личность из cookie (заводится при первом обращении). НЕ путать со
    // строгим "!user" — он остаётся отдельно там, где нужен настоящий
    // вход (см. POST /api/puzzles, не в этом блоке).
    const identity = user || getOrCreateAnonIdentity(req, res);

    if (seg.length === 2 && m === "POST") {
      const body = await readJson(req);
      const title = str(body.title, 120);
      if (!title) return json(res, 400, { error: "bad title" });
      const id = crypto.randomUUID(), ts = now(), code = newJoinCode();
      stmt.insertRoom.run(id, title, code, identity.id, ts, ts);
      stmt.addRoomMember.run(id, identity.id, identity.username || null, identity.name || null, "owner", ts);
      adminLog.info("Комната создана", { roomId: id, title, anonymous: identity.id.startsWith("anon:") });
      return json(res, 200, roomPayload(stmt.room.get(id), "owner", 1));
    }

    if (seg.length === 2 && m === "GET") {
      return json(res, 200, stmt.myRooms.all(identity.id).map(r => roomPayload(r, r.role, r.members_count)));
    }

    if (seg[2] === "join" && seg[3] && seg.length === 4) {
      const code = String(seg[3]).toUpperCase().slice(0, 16);
      const room = stmt.roomByCode.get(code);
      if (!room) return json(res, 404, { error: "no such invite" });
      const already = stmt.roomMember.get(room.id, identity.id);
      if (m === "GET") {
        return json(res, 200, {
          roomId: room.id, title: room.title, alreadyMember: !!already,
          members: stmt.roomMembers.all(room.id).map(x => x.name || x.username).filter(Boolean),
        });
      }
      if (m === "POST") {
        if (!already) stmt.addRoomMember.run(room.id, identity.id, identity.username || null, identity.name || null, "member", now());
        return json(res, 200, { roomId: room.id, joined: !already });
      }
      return json(res, 405, { error: "method not allowed" });
    }

    if (seg[2]) {
      const roomId = seg[2];
      const room = stmt.room.get(roomId);
      if (!room) return json(res, 404, { error: "not found" });

      // Клейм анонимного членства настоящим аккаунтом: тот же браузер (тот
      // же cookie) был анонимом в ЭТОЙ комнате, а теперь вошёл — переносим
      // его строку в room_members на настоящий user.id вместо того, чтобы
      // завести отдельную и потерять role (в т.ч. owner). Не трогаем,
      // если под настоящим user.id уже и так есть строка — иначе UPDATE
      // столкнулся бы с PRIMARY KEY (room_id, user_id).
      if (user) {
        const anonId = readAnonId(req);
        if (anonId && anonId !== user.id && !stmt.roomMember.get(roomId, user.id)) {
          const anonRow = stmt.roomMember.get(roomId, anonId);
          if (anonRow) stmt.claimAnonMembership.run(user.id, user.username || null, user.name || null, roomId, anonId);
        }
      }

      const member = stmt.roomMember.get(roomId, identity.id);
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
        // Пока создатель комнаты не вошёл в аккаунт — только 1 активная
        // доска (не MAX_ACTIVE_SESSIONS_PER_ROOM), даже если другие
        // участники уже авторизованы — см. правку «лимиты поднимаются,
        // только если авторизован создатель». Снимается само собой, как
        // только владелец входит (roomOwnerAuthed начинает видеть его
        // строку — либо клеймом анонимной owner-строки, либо потому что
        // комната изначально создана вошедшим пользователем).
        const limit = stmt.roomOwnerAuthed.get(roomId) ? MAX_ACTIVE_SESSIONS_PER_ROOM : 1;
        const activeCount = stmt.activeSessions.all(roomId).length;
        if (activeCount >= limit) {
          return json(res, 409, { error: "room session limit reached", limit });
        }
        const body = await readJson(req);
        const puzzle = stmt.puzzle.get(body.puzzleId);
        if (!puzzle) return json(res, 400, { error: "bad puzzle" });
        const id = crypto.randomUUID(), ts = now();
        stmt.insertSession.run(id, roomId, puzzle.id, puzzle.grid_rows * puzzle.grid_cols, identity.id, ts, ts, body.asymmetric ? 1 : 0);
        return json(res, 200, sessionSummary(stmt.session.get(id)));
      }

      if (seg[3] === "sessions" && seg[4] && seg.length === 5 && m === "GET") {
        const session = stmt.session.get(seg[4]);
        if (!session || session.room_id !== roomId) return json(res, 404, { error: "not found" });
        return json(res, 200, sessionSummary(session));
      }

      // Удаление сеанса — освобождает слот из лимита (см. выше), если
      // кто-то по ошибке начал лишнюю сборку и ушёл. Членство в комнате
      // уже проверено выше (member). Нельзя удалить сеанс, за которым
      // сейчас реально кто-то сидит за столом — только "активный, но
      // пустой" или уже завершённый.
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

      // Скрыть встроенный пазл ИМЕННО в этой комнате (не удалить сам пазл —
      // он остаётся видимым во всех остальных комнатах и в соло-библиотеке,
      // см. room_hidden_puzzles). Доступно любому участнику (member уже
      // проверен выше) — это общая настройка комнаты, не личная. Своё фото
      // сюда не годится — для него уже есть настоящее удаление (DELETE
      // /api/puzzles/:id, только владельцем).
      if (seg[3] === "hidden-puzzles" && seg.length === 4 && m === "POST") {
        const body = await readJson(req);
        const puzzle = stmt.puzzle.get(body.puzzleId);
        if (!puzzle) return json(res, 404, { error: "not found" });
        if (puzzle.owner_user_id !== null) return json(res, 400, { error: "not a default puzzle" });
        stmt.hidePuzzleInRoom.run(roomId, puzzle.id, identity.id, now());
        return json(res, 200, { ok: true });
      }

      if (seg[3] === "hidden-puzzles" && seg[4] && seg.length === 5 && m === "DELETE") {
        stmt.unhidePuzzleInRoom.run(roomId, seg[4]);
        return json(res, 200, { ok: true });
      }

      // Владелец комнаты может убрать участника, включая анонимного гостя —
      // роль в room_members при этом не спрашиваем у цели (owner ровно один,
      // назначается только при создании комнаты, seg[4] === identity.id ниже
      // отсекает попытку выгнать самого себя этим путём — это не «удалить
      // комнату», для владельца тут просто нет такого сценария).
      if (seg[3] === "members" && seg[4] && seg.length === 5 && m === "DELETE") {
        // seg приходит из url.pathname.split("/") без decodeURIComponent
        // (см. объявление seg выше) — для всех остальных id в путях это
        // не имело значения (UUID/join-код без спецсимволов), но анонимные
        // id содержат ":" (anon:<uuid>), клиент шлёт его как encodeURIComponent
        // ("anon%3A..."), поэтому именно здесь декодируем сами.
        const targetId = decodeURIComponent(seg[4]);
        if (member.role !== "owner") return json(res, 403, { error: "not the owner" });
        if (targetId === identity.id) return json(res, 400, { error: "cannot remove yourself" });
        if (!stmt.roomMember.get(roomId, targetId)) return json(res, 404, { error: "not a member" });
        stmt.deleteRoomMember.run(roomId, targetId);
        // Живые WS-подключения выгнанного в этой комнате рвём сразу — иначе
        // он продолжал бы двигать детали за столом ещё какое-то время, хотя
        // членства в room_members уже нет (переподключиться он всё равно не
        // сможет — roomMember.get вернёт пусто на следующем апгрейде).
        kickFromRoom(roomId, targetId);
        adminLog.info("Участник удалён владельцем комнаты", { roomId, removedUserId: targetId, byUserId: identity.id });
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
  const completedAt = isSolved(state.pieces, state.piecesTotal) ? ts : null;
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

// Разрывает живые WS-подключения userId во ВСЕХ активных столах этой
// комнаты сразу (не только в одном сеансе) — используется при удалении
// участника владельцем (см. DELETE /api/rooms/:id/members/:userId).
function kickFromRoom(roomId, userId) {
  for (const state of liveSessions.values()) {
    if (state.roomId !== roomId) continue;
    let changed = false;
    for (const conn of state.conns) {
      if (conn.user.id !== userId) continue;
      state.conns.delete(conn);
      changed = true;
      try { conn.ws.close(); } catch {}
    }
    if (changed) broadcastPresence(state);
  }
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
      if (isSolved(state.pieces, state.piecesTotal)) persistSession(state);
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

  // Анонимные комнаты (см. план): нет token — пробуем cookie puzzle_anon
  // вместо JWT. Cookie на апгрейд-запрос браузер шлёт сам (это ещё обычный
  // HTTP-запрос до переключения протокола) — новую тут НЕ заводим (нечему
  // отдать Set-Cookie на этом пути с пользой): к моменту, когда клиент
  // подключается к WS сессии, он уже создавал/открывал комнату через REST
  // (см. /api/rooms/* — там cookie уже выставлена).
  const token = url.searchParams.get("token");
  const payload = token ? await auth.verify(token) : null;
  let identity;
  if (payload) {
    identity = { id: payload.sub, username: payload.preferred_username || null, name: payload.name || null };
  } else {
    const anonId = readAnonId(req);
    if (!anonId) return rejectUpgrade(socket, 401, "Unauthorized");
    identity = { id: anonId, username: null, name: null };
  }

  const member = stmt.roomMember.get(roomId, identity.id);
  if (!member) return rejectUpgrade(socket, 403, "Forbidden");

  const session = stmt.session.get(sessionId);
  if (!session || session.room_id !== roomId) return rejectUpgrade(socket, 404, "Not Found");
  if (session.completed_at) return rejectUpgrade(socket, 410, "Gone");

  const conn = ws.acceptUpgrade(req, socket, head);
  if (!conn) return;

  attachRoomConnection(sessionId, identity, conn);
}

server.listen(PORT, HOST, () => {
  console.log(`Что собираем? слушает http://${HOST}:${PORT}`);
  console.log(`Авторизация: ${AUTH_ISSUER} (клиент «${AUTH_CLIENT_ID}»)`);
});
