/**
 * Сквозная проверка комнат «Что собираем?»: auth + puzzle, два «браузера»
 * без браузера — вход через /api/authorize/login (как в Trip/test/e2e.mjs),
 * синхронизация стола — через настоящий WebSocket-клиент.
 *
 * Запуск: node test/e2e-rooms.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";

const PUZZLE_DIR = path.resolve(fileURLToPath(import.meta.url), "../..");
const AUTH_DIR = process.env.AUTH_DIR || path.join(PUZZLE_DIR, "..", "Auth");
const WORK = path.join(PUZZLE_DIR, "test", ".work");
const AUTH_PORT = parseInt(process.env.AUTH_PORT || "8788", 10);
const PUZZLE_PORT = parseInt(process.env.PUZZLE_PORT || "8796", 10);
const AUTH = `http://localhost:${AUTH_PORT}`;
const PUZZLE = `http://localhost:${PUZZLE_PORT}`;
const NODE_ARGS = process.version.startsWith("v22") ? ["--experimental-sqlite"] : [];

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK + "/auth", { recursive: true });
fs.mkdirSync(WORK + "/puzzle", { recursive: true });

let failures = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "  OK  " : " FAIL "} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64u = b => Buffer.from(b).toString("base64url");

const authEnv = { ...process.env, DATA_DIR: WORK + "/auth" };
const authCli = (...a) => execFileSync("node", [...NODE_ARGS, "server.js", ...a], { cwd: AUTH_DIR, env: authEnv, encoding: "utf8" });
authCli("client-add", "puzzle", "Что собираем?", PUZZLE + "/");
authCli("adduser", "danil", "ПарольДляТеста-2026");
authCli("adduser", "sputnik", "ПарольПопутчика-2026");

const procs = [];
function start(name, cwd, env) {
  const p = spawn("node", [...NODE_ARGS, "server.js"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", () => {}); p.stderr.on("data", d => process.stderr.write(`[${name}] ${d}`));
  procs.push(p);
}
start("auth", AUTH_DIR, { ...authEnv, DEV: "1", ISSUER: AUTH, PORT: String(AUTH_PORT), HOST: "127.0.0.1" });
start("puzzle", PUZZLE_DIR, {
  ...process.env, DATA_DIR: WORK + "/puzzle", PORT: String(PUZZLE_PORT), HOST: "127.0.0.1",
  AUTH_ISSUER: AUTH, AUTH_CLIENT_ID: "puzzle",
});

async function waitUp(url) {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(url + "/api/health")).ok) return true; } catch {} await sleep(200); }
  return false;
}
ok("auth поднялся", await waitUp(AUTH));
ok("puzzle поднялся", await waitUp(PUZZLE));

async function login(username, password) {
  const verifier = b64u(crypto.randomBytes(32));
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const redirect = PUZZLE + "/";
  const r = await fetch(`${AUTH}/api/authorize/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, client_id: "puzzle", redirect_uri: redirect, state: "s",
      code_challenge: challenge, code_challenge_method: "S256" }),
  });
  const data = await r.json();
  if (!data.redirect) throw new Error(`вход не удался: ${JSON.stringify(data)}`);
  const code = new URL(data.redirect).searchParams.get("code");
  return (await (await fetch(`${AUTH}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", client_id: "puzzle", redirect_uri: redirect, code, code_verifier: verifier }),
  })).json()).access_token;
}
const tokenA = await login("danil", "ПарольДляТеста-2026");
const tokenB = await login("sputnik", "ПарольПопутчика-2026");
ok("оба вошли", !!tokenA && !!tokenB);

const call = (token, p, init = {}) => fetch(PUZZLE + "/api" + p, {
  ...init, headers: { Authorization: "Bearer " + token, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  body: init.body ? JSON.stringify(init.body) : undefined,
});
const asJson = async (...a) => { const r = await call(...a); return { status: r.status, body: await r.json().catch(() => ({})) }; };

let r = await asJson(tokenA, "/rooms", { method: "POST", body: { title: "Пятничный вечер" } });
ok("комната создана", r.status === 200, JSON.stringify(r.body));
const roomId = r.body.id, joinCode = r.body.joinCode;

r = await asJson(tokenB, `/rooms/join/${joinCode}`, { method: "POST" });
ok("второй вошёл по ссылке", r.status === 200 && r.body.joined === true, JSON.stringify(r.body));

r = await asJson(tokenA, `/rooms/${roomId}/sessions`, { method: "POST", body: { puzzleId: "hills" } });
ok("сеанс стартовал", r.status === 200, JSON.stringify(r.body));
const sessionId = r.body.id, piecesTotal = r.body.piecesTotal;

// До 5 параллельных активных сборок в комнате (временное послабление, см.
// план п.3) — тот же puzzleId на разные сеансы допустим, схема этого не
// запрещает. Стартуем ещё 4 (итого 5 активных), все должны создаться
// успешно, 6-й должен быть отбит лимитом.
const extraSessionIds = []; // к ним никто по WS не подключался — пригодятся для теста DELETE
for (let i = 2; i <= 5; i++) {
  r = await asJson(tokenA, `/rooms/${roomId}/sessions`, { method: "POST", body: { puzzleId: "hills" } });
  ok(`сеанс №${i} стартовал`, r.status === 200, JSON.stringify(r.body));
  if (r.body.id) extraSessionIds.push(r.body.id);
}
r = await asJson(tokenA, `/rooms/${roomId}/sessions`, { method: "POST", body: { puzzleId: "hills" } });
ok("6-й сеанс отбит лимитом", r.status === 409 && r.body.error === "room session limit reached", JSON.stringify(r.body));

const wsUrl = token => `ws://localhost:${PUZZLE_PORT}/ws/rooms/${roomId}/sessions/${sessionId}?token=${encodeURIComponent(token)}`;

function waitMessage(ws, pred, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for " + pred)), ms);
    ws.addEventListener("message", function onMsg(e) {
      const msg = JSON.parse(e.data);
      if (pred(msg)) { clearTimeout(t); ws.removeEventListener("message", onMsg); resolve(msg); }
    });
  });
}
function waitOpen(ws) { return new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); }); }

const wsBad = new WebSocket(wsUrl("не-токен"));
// Отклонение примечание: Node 22 global WebSocket на отказ хэндшейка (сервер
// пишет обычный HTTP-ответ и рвёт сокет ДО 101) в этой среде эмитит только
// "error" — "close" не приходит вовсе (проверено отдельно даже на голом
// http.Server без нашего framing). Поэтому ждём оба события как признак
// отказа, а решающая проверка — что соединение НИКОГДА не доходит до OPEN.
let badRejected = false;
await new Promise(res => {
  wsBad.addEventListener("close", () => { badRejected = true; res(); });
  wsBad.addEventListener("error", () => { badRejected = true; res(); });
  wsBad.addEventListener("open", res);
  setTimeout(res, 1500);
});
ok("невалидный токен не даёт OPEN", badRejected && wsBad.readyState !== WebSocket.OPEN);

const wsA = new WebSocket(wsUrl(tokenA));
await waitOpen(wsA);
const firstSyncA = await waitMessage(wsA, m => m.type === "sync");
ok("A получил sync с пустой раскладкой", firstSyncA.pieces === null);

const wsB = new WebSocket(wsUrl(tokenB));
await waitOpen(wsB);
await waitMessage(wsB, m => m.type === "sync");

// Механика «связей»: у детали нет фиксированного места, прогресс = размер
// наибольшего связного кластера (см. assets/puzzle-clusters.js, CELL=100
// там же и в server.js). Тип "place" убран из протокола целиком — клиент
// стыкует детали только через геометрию, сервер отдельно её пересчитывает.
const ROWS = 4, COLS = 3, PUZZLE_CELL = 100; // «hills» — 4×3 (12 деталей), см. BUILTIN_IMAGES в server.js
// Шаг 500, не CELL=100 — заведомо несмежная раскладка: каждая деталь сама
// себе кластер размера 1, largest === 1 независимо от общего числа деталей.
function scatteredPieces() {
  const arr = [];
  for (let rr = 0; rr < ROWS; rr++) for (let cc = 0; cc < COLS; cc++) arr.push({ r: rr, c: cc, x: cc * 500, y: rr * 500, placed: false });
  return arr;
}
function gridAlignedPieces() {
  const arr = [];
  for (let rr = 0; rr < ROWS; rr++) for (let cc = 0; cc < COLS; cc++) arr.push({ r: rr, c: cc, x: cc * PUZZLE_CELL, y: rr * PUZZLE_CELL, placed: false });
  return arr;
}

const bSyncPromise = waitMessage(wsB, m => m.type === "sync" && m.pieces);
wsA.send(JSON.stringify({ type: "init", pieces: scatteredPieces() }));
const bSync = await bSyncPromise;
ok("B получил каноническую раскладку от A", Array.isArray(bSync.pieces) && bSync.pieces.length === piecesTotal);
ok("несмежная раскладка после init — piecesPlaced===1 (каждая деталь свой кластер)", bSync.piecesPlaced === 1, JSON.stringify({ piecesPlaced: bSync.piecesPlaced }));

let echoOnA = false;
wsA.addEventListener("message", function guard(e) { if (JSON.parse(e.data).type === "move") echoOnA = true; });
const moveOnB = waitMessage(wsB, m => m.type === "move" && m.r === 0 && m.c === 0);
wsA.send(JSON.stringify({ type: "move", r: 0, c: 0, x: 123, y: 45 }));
const move = await moveOnB;
ok("B увидел движение детали", move.x === 123 && move.y === 45);
await sleep(200);
ok("A не получил эхо своего же move", !echoOnA);

// Первый "group" стыкует ровно пару (0,0)+(0,1) на идеальную сетку —
// остальные 10 деталей остаются несмежными (та же раскладка шагом 500).
const pairPieces = scatteredPieces();
Object.assign(pairPieces.find(p => p.r === 0 && p.c === 0), { x: 0, y: 0 });
Object.assign(pairPieces.find(p => p.r === 0 && p.c === 1), { x: PUZZLE_CELL, y: 0 });
const pairSyncPromise = waitMessage(wsB, m => m.type === "sync" && m.pieces);
wsA.send(JSON.stringify({ type: "group", pieces: pairPieces }));
const pairSync = await pairSyncPromise;
ok("group стыкует пару деталей — piecesPlaced===2", pairSync.piecesPlaced === 2, JSON.stringify({ piecesPlaced: pairSync.piecesPlaced }));

// Второй "group" достраивает всю раскладку на идеальную сетку — весь пазл
// становится одним кластером, сеанс должен немедленно зафиксироваться завершённым.
const fullSyncPromise = waitMessage(wsB, m => m.type === "sync" && m.pieces);
wsA.send(JSON.stringify({ type: "group", pieces: gridAlignedPieces() }));
const fullSync = await fullSyncPromise;
ok("второй group достраивает всю раскладку — piecesPlaced===piecesTotal", fullSync.piecesPlaced === piecesTotal, JSON.stringify({ piecesPlaced: fullSync.piecesPlaced, piecesTotal }));

await sleep(300);
r = await asJson(tokenA, `/rooms/${roomId}/sessions/${sessionId}`);
ok("сеанс сохранён завершённым в БД", r.status === 200 && !!r.body.completedAt, JSON.stringify(r.body));

// ───────── регресс: гонка group/shuffle при конкурентных ходах двух участников ─────────
// Раньше group/shuffle несли ПОЛНЫЙ локальный снимок pieces отправителя, и
// сервер заменял state.pieces им целиком (state.pieces = pieces). Если C
// стыкует одну пару деталей ровно в момент, когда D (независимо, ещё не
// получив через sync ход C) стыкует СВОЮ, другую пару и шлёт свой group,
// массив D — устаревший в части хода C — полностью перезаписывал
// state.pieces: стыковка C пропадала/откатывалась, хотя D её вообще не
// касался. Починка — group/shuffle несут ТОЛЬКО реально изменившиеся детали
// и мержатся по ключу (r,c) поверх текущего state.pieces (см. server.js,
// ветка "shuffle"/"group"), поэтому ходы по непересекающимся ключам больше
// не могут затереть друг друга независимо от порядка доставки по сети.
// Сеанс — новый (первый уже завершён строкой выше), сессий активно меньше
// лимита (см. «до 5 параллельных сборок»), можно стартовать ещё один.
r = await asJson(tokenA, `/rooms/${roomId}/sessions`, { method: "POST", body: { puzzleId: "hills" } });
ok("сеанс для регресса гонки group/shuffle стартовал", r.status === 200, JSON.stringify(r.body));
const raceSessionId = r.body.id;
const raceWsUrl = token => `ws://localhost:${PUZZLE_PORT}/ws/rooms/${roomId}/sessions/${raceSessionId}?token=${encodeURIComponent(token)}`;

// Открываем и ждём первый sync СТРОГО последовательно (не Promise.all) —
// тот же порядок, что у wsA/wsB выше: у нативного WebSocket нет буфера
// событий для ещё не навешанных обработчиков, и если ждать открытия сразу
// двух сокетов параллельно, начальный "sync" одного из них может прийти и
// потеряться, пока JS всё ещё ждёт открытия второго.
const wsC = new WebSocket(raceWsUrl(tokenA));
await waitOpen(wsC);
await waitMessage(wsC, m => m.type === "sync");

const wsD = new WebSocket(raceWsUrl(tokenB));
await waitOpen(wsD);
await waitMessage(wsD, m => m.type === "sync");

const dInitSyncPromise = waitMessage(wsD, m => m.type === "sync" && m.pieces);
wsC.send(JSON.stringify({ type: "init", pieces: scatteredPieces() }));
await dInitSyncPromise;

// Конкурентно, БЕЗ ожидания sync друг от друга между отправками: C стыкует
// пару (0,0)+(0,1) частичным group (шлёт только эти два ключа), D —
// независимую пару (2,0)+(2,1) (тоже только свои два ключа). Ключи
// непересекающиеся, порядок доставки серверу не важен для итога.
const bothStitched = m => {
  if (m.type !== "sync" || !Array.isArray(m.pieces)) return false;
  const at = (r, c) => m.pieces.find(p => p.r === r && p.c === c);
  const a = at(0, 0), b = at(0, 1), x = at(2, 0), y = at(2, 1);
  return !!a && !!b && !!x && !!y
    && a.x === 0 && a.y === 0 && b.x === PUZZLE_CELL && b.y === 0
    && x.x === 2000 && x.y === 2000 && y.x === 2000 + PUZZLE_CELL && y.y === 2000;
};
const raceSyncPromise = waitMessage(wsC, bothStitched, 4000);
wsC.send(JSON.stringify({ type: "group", pieces: [
  { r: 0, c: 0, x: 0, y: 0, placed: false },
  { r: 0, c: 1, x: PUZZLE_CELL, y: 0, placed: false },
] }));
wsD.send(JSON.stringify({ type: "group", pieces: [
  { r: 2, c: 0, x: 2000, y: 2000, placed: false },
  { r: 2, c: 1, x: 2000 + PUZZLE_CELL, y: 2000, placed: false },
] }));
const raceSync = await raceSyncPromise;
ok("конкурентные partial-group от двух участников не затёрли друг друга", bothStitched(raceSync));
ok("итог гонки — два независимых кластера по 2 детали, piecesPlaced===2", raceSync.piecesPlaced === 2, JSON.stringify({ piecesPlaced: raceSync.piecesPlaced }));
ok("длина pieces не меняется при частичном group", raceSync.pieces.length === piecesTotal, String(raceSync.pieces.length));

// ───────── удаление сеанса (DELETE /api/rooms/:id/sessions/:sessionId) ─────────
// Активный сеанс без живых подключений — extraSessionIds[0], к которому
// никто ни разу не подключался по WS (см. цикл создания 5 параллельных
// сборок выше) — удаление должно пройти, и GET /sessions больше не должен
// его возвращать.
const deletableId = extraSessionIds[0];
r = await asJson(tokenA, `/rooms/${roomId}/sessions/${deletableId}`, { method: "DELETE" });
ok("активный сеанс без живых подключений удаляется", r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
r = await asJson(tokenA, `/rooms/${roomId}/sessions`);
ok("удалённый сеанс больше не в списке", r.status === 200 && !r.body.some(s => s.id === deletableId), JSON.stringify(r.body.map(s => s.id)));

// Активный сеанс, за столом которого сейчас реально кто-то есть (wsC/wsD
// ещё подключены к raceSessionId) — удалять нельзя, 409.
r = await asJson(tokenA, `/rooms/${roomId}/sessions/${raceSessionId}`, { method: "DELETE" });
ok("активный сеанс с живым подключением НЕЛЬЗЯ удалить — 409", r.status === 409, JSON.stringify(r.body));

wsC.close(); wsD.close();
wsA.close(); wsB.close();
await sleep(300); // дать серверу обработать close (state.conns.delete → liveSessions.delete)

// После ухода последнего участника со стола (пустой активный сеанс) —
// удаление снова разрешено.
r = await asJson(tokenA, `/rooms/${roomId}/sessions/${raceSessionId}`, { method: "DELETE" });
ok("после ухода всех со стола сеанс снова можно удалить", r.status === 200 && r.body.ok === true, JSON.stringify(r.body));

for (const p of procs) p.kill();
process.exit(failures ? 1 : 0);
