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
const ADMIN_KEY = "test-admin-key";
start("puzzle", PUZZLE_DIR, {
  ...process.env, DATA_DIR: WORK + "/puzzle", PORT: String(PUZZLE_PORT), HOST: "127.0.0.1",
  AUTH_ISSUER: AUTH, AUTH_CLIENT_ID: "puzzle", ADMIN_INTERNAL_KEY: ADMIN_KEY,
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
// piecesPlaced теперь = сумма деталей во ВСЕХ кластерах от 2 (не только
// самом большом, см. connectedPiecesCount) — ни одна деталь тут ни с кем
// не состыкована (каждая сама по себе), значит счётчик 0, а не 1 (как
// было бы для largestClusterSize, где кластер-одиночка считался за 1).
ok("несмежная раскладка после init — piecesPlaced===0 (никто ни с кем не состыкован)", bSync.piecesPlaced === 0, JSON.stringify({ piecesPlaced: bSync.piecesPlaced }));

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
// Два независимых кластера по 2 детали каждый — считаем ОБА (2+2=4), не
// только больший (тут оба одного размера, но правило то же самое).
ok("итог гонки — два независимых кластера по 2 детали, piecesPlaced===4 (считаются оба)", raceSync.piecesPlaced === 4, JSON.stringify({ piecesPlaced: raceSync.piecesPlaced }));
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

// ───────── свои фото — граница видимости по комнате (не по владельцу) ─────────
// Раньше загруженное в ОДНОЙ комнате владельца было видно и в ДРУГОЙ его же
// комнате — баг (см. ALTER TABLE room_id в server.js). Проверяем, что фото,
// загруженное в roomId, видно ИМЕННО там и нигде больше — ни во второй
// комнате того же владельца, ни в соло-библиотеке (без ?roomId=).
const callRaw = (token, p, body, contentType) => fetch(PUZZLE + "/api" + p, {
  method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": contentType }, body,
});
const PNG_MAGIC = Buffer.from("\x89PNG\r\n\x1a\n", "latin1");
const fakePng = Buffer.concat([PNG_MAGIC, Buffer.alloc(64)]);

r = await asJson(tokenA, "/rooms", { method: "POST", body: { title: "Вторая комната того же владельца" } });
ok("вторая комната создана", r.status === 200, JSON.stringify(r.body));
const roomId2 = r.body.id;

let ur = await callRaw(tokenA, `/puzzles?roomId=${roomId}&w=300&h=400&title=${encodeURIComponent("Тестовое фото")}`, fakePng, "image/png");
const upload = { status: ur.status, body: await ur.json().catch(() => ({})) };
ok("загрузка фото в комнату прошла", upload.status === 200 && Array.isArray(upload.body.variants) && upload.body.variants.length === 6, JSON.stringify(upload.body).slice(0, 200));
const uploadedId = upload.body.variants[0].id;

r = await asJson(tokenA, `/puzzles?roomId=${roomId}`);
ok("фото видно в комнате, где загружено", r.status === 200 && r.body.some(p => p.id === uploadedId), JSON.stringify(r.body.map(p => p.id)));

r = await asJson(tokenA, `/puzzles?roomId=${roomId2}`);
ok("фото НЕ видно в другой комнате того же владельца", r.status === 200 && !r.body.some(p => p.id === uploadedId), JSON.stringify(r.body.map(p => p.id)));

r = await asJson(tokenA, "/puzzles");
ok("фото НЕ видно в соло-библиотеке (без roomId)", r.status === 200 && !r.body.some(p => p.id === uploadedId), JSON.stringify(r.body.map(p => p.id)));

// Загрузка в комнату, где не состоишь — 403 (иначе можно было бы подсунуть
// фото в чужую комнату).
ur = await callRaw(tokenB, `/puzzles?roomId=${roomId2}&w=300&h=400`, fakePng, "image/png");
ok("загрузка в чужую комнату отбита 403", ur.status === 403, String(ur.status));

// Удаление — доступно из комнаты (buildCard теперь показывает крестик
// владельцу), проверяем сам эндпоинт: после удаления фото пропадает и там,
// где было видно.
r = await asJson(tokenA, `/puzzles/${uploadedId}`, { method: "DELETE" });
ok("удаление своего фото проходит", r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
r = await asJson(tokenA, `/puzzles?roomId=${roomId}`);
ok("после удаления фото пропало из комнаты", r.status === 200 && !r.body.some(p => p.id === uploadedId), JSON.stringify(r.body.map(p => p.id)));

// ───────── ассиметричная форма — флаг сеанса, не пазла ─────────
// Выбор в модалке сложности (assets/app.js, difficultyAsymmetric) должен
// дойти до всех участников комнаты через сам сеанс (см. sessionSummary,
// asymmetricShape), а не потеряться/остаться локальным для того, кто
// нажал «Играть».
r = await asJson(tokenA, `/rooms/${roomId2}/sessions`, { method: "POST", body: { puzzleId: "hills", asymmetric: true } });
ok("сеанс с ассиметричной формой стартовал", r.status === 200 && r.body.asymmetricShape === true, JSON.stringify(r.body));
const asymSessionId = r.body.id;
r = await asJson(tokenA, `/rooms/${roomId2}/sessions/${asymSessionId}`);
ok("флаг формы виден через GET сеанса (как увидят остальные участники)", r.status === 200 && r.body.asymmetricShape === true, JSON.stringify(r.body));

r = await asJson(tokenA, `/rooms/${roomId2}/sessions/${asymSessionId}`, { method: "DELETE" });
r = await asJson(tokenA, `/rooms/${roomId2}/sessions`, { method: "POST", body: { puzzleId: "hills" } });
ok("сеанс без флага — asymmetricShape===false", r.status === 200 && r.body.asymmetricShape === false, JSON.stringify(r.body));

// ───────── скрытие встроенного пазла ИМЕННО в комнате (не удаление) ─────────
// roomId — тут состоят оба (tokenA и tokenB), значит подходит проверить, что
// скрытое одним видно скрытым и другому (общая настройка комнаты, не личная).
r = await asJson(tokenA, `/rooms/${roomId}/hidden-puzzles`, { method: "POST", body: { puzzleId: "hills" } });
ok("скрытие встроенного пазла в комнате прошло", r.status === 200 && r.body.ok === true, JSON.stringify(r.body));

r = await asJson(tokenA, `/puzzles?roomId=${roomId}`);
ok("скрытый пазл не виден владельцу скрытия в этой комнате", r.status === 200 && !r.body.some(p => p.id === "hills"), JSON.stringify(r.body.map(p => p.id)));

r = await asJson(tokenB, `/puzzles?roomId=${roomId}`);
ok("скрытый пазл не виден и другому участнику той же комнаты", r.status === 200 && !r.body.some(p => p.id === "hills"), JSON.stringify(r.body.map(p => p.id)));

r = await asJson(tokenA, "/puzzles");
ok("скрытие не задело соло-библиотеку — пазл там виден", r.status === 200 && r.body.some(p => p.id === "hills"), JSON.stringify(r.body.map(p => p.id)));

r = await asJson(tokenA, `/puzzles?roomId=${roomId2}`);
ok("скрытие не задело другую комнату — пазл там виден", r.status === 200 && r.body.some(p => p.id === "hills"), JSON.stringify(r.body.map(p => p.id)));

// Повторное скрытие уже скрытого — идемпотентно, не падает.
r = await asJson(tokenA, `/rooms/${roomId}/hidden-puzzles`, { method: "POST", body: { puzzleId: "hills" } });
ok("повторное скрытие того же пазла не падает", r.status === 200 && r.body.ok === true, JSON.stringify(r.body));

r = await asJson(tokenA, `/rooms/${roomId}/hidden-puzzles/hills`, { method: "DELETE" });
ok("восстановление скрытого пазла проходит", r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
r = await asJson(tokenA, `/puzzles?roomId=${roomId}`);
ok("после восстановления пазл снова виден в комнате", r.status === 200 && r.body.some(p => p.id === "hills"), JSON.stringify(r.body.map(p => p.id)));

// ───────── анонимные комнаты — совсем без входа (см. план) ─────────
// node's fetch не хранит cookies сам — вытаскиваем Set-Cookie из ответа и
// прокидываем дальше вручную как обычный браузер бы сделал автоматически.
function parseSetCookie(res) {
  const raw = res.headers.get("set-cookie");
  return raw ? raw.split(";")[0] : null; // "puzzle_anon=<uuid>"
}
const anonCall = (cookie, p, init = {}) => fetch(PUZZLE + "/api" + p, {
  ...init,
  headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...init.headers },
  body: init.body ? JSON.stringify(init.body) : undefined,
});

let ar = await anonCall(null, "/rooms", { method: "POST", body: { title: "Комната без входа" } });
ok("анонимная комната создаётся без токена вообще", ar.status === 200, String(ar.status));
const anonCookie = parseSetCookie(ar);
ok("сервер выдал cookie puzzle_anon", !!anonCookie && anonCookie.startsWith("puzzle_anon="), String(anonCookie));
const anonRoom = await ar.json();

ar = await anonCall(anonCookie, "/rooms");
const anonRoomsList = await ar.json();
ok("анонимная комната видна в /rooms по той же cookie («мои комнаты» анонима)",
  ar.status === 200 && anonRoomsList.some(x => x.id === anonRoom.id), JSON.stringify(anonRoomsList.map(x => x.id)));

ar = await anonCall(anonCookie, `/rooms/${anonRoom.id}/sessions`, { method: "POST", body: { puzzleId: "hills" } });
const anonSession1 = await ar.json();
ok("первый анонимный сеанс стартовал", ar.status === 200, JSON.stringify(anonSession1));

ar = await anonCall(anonCookie, `/rooms/${anonRoom.id}/sessions`, { method: "POST", body: { puzzleId: "hills" } });
const anonSession2Body = await ar.json();
ok("2-й сеанс в анонимной комнате отбит лимитом 1 (не 5)",
  ar.status === 409 && anonSession2Body.limit === 1, JSON.stringify(anonSession2Body));

ar = await fetch(PUZZLE + `/api/puzzles?roomId=${anonRoom.id}&w=300&h=400`, {
  method: "POST", headers: { "Content-Type": "image/png", Cookie: anonCookie }, body: fakePng,
});
ok("загрузка своего фото в анонимную комнату без входа отбита 401 — как и должно", ar.status === 401, String(ar.status));

// Тот же браузер (та же cookie) теперь входит в аккаунт и открывает СВОЮ
// анонимную комнату — клейм членства должен перенести его строку на
// настоящий user.id и сохранить role="owner" (создавал её анонимно).
ar = await fetch(PUZZLE + `/api/rooms/${anonRoom.id}`, { headers: { Authorization: "Bearer " + tokenA, Cookie: anonCookie } });
const claimedRoom = await ar.json();
ok("после входа доступ к своей анонимной комнате есть и role=owner сохранилась (клейм)",
  ar.status === 200 && claimedRoom.role === "owner", JSON.stringify(claimedRoom));

// Лимит снят сразу — вторая (уже настоящая) сессия стартует без 409.
r = await asJson(tokenA, `/rooms/${anonRoom.id}/sessions`, { method: "POST", body: { puzzleId: "hills" } });
ok("после входа лимит снят сразу — 2-й сеанс стартует без новой комнаты", r.status === 200, JSON.stringify(r.body));

// ───────── лимит поднимается ТОЛЬКО от входа создателя (owner), не любого
// авторизованного участника — см. правку «лимиты поднимаются, только если
// авторизован создатель комнаты» ─────────
ar = await anonCall(null, "/rooms", { method: "POST", body: { title: "Комната без входа — не владелец" } });
const ownerCookie = parseSetCookie(ar);
const ownerRoom = await ar.json();
ok("вторая анонимная комната (для проверки owner-only лимита) создана", ar.status === 200, String(ar.status));

ar = await anonCall(null, `/rooms/join/${encodeURIComponent(ownerRoom.joinCode)}`, { method: "POST" });
const memberCookie = parseSetCookie(ar);
ok("второй аноним присоединился по коду", ar.status === 200, String(ar.status));

// Не-владелец входит в аккаунт (клеймит свою member-строку, не owner) —
// лимит НЕ должен подняться, пока владелец остаётся анонимным.
ar = await fetch(PUZZLE + `/api/rooms/${ownerRoom.id}`, { headers: { Authorization: "Bearer " + tokenB, Cookie: memberCookie } });
const claimedMemberRoom = await ar.json();
ok("не-владелец вошёл и клеймится role=member (не owner)",
  ar.status === 200 && claimedMemberRoom.role === "member", JSON.stringify(claimedMemberRoom));

r = await asJson(tokenB, `/rooms/${ownerRoom.id}/sessions`, { method: "POST", body: { puzzleId: "hills" } });
ok("1-й сеанс от вошедшего не-владельца стартует (лимит 1 ещё не исчерпан)", r.status === 200, JSON.stringify(r.body));

r = await asJson(tokenB, `/rooms/${ownerRoom.id}/sessions`, { method: "POST", body: { puzzleId: "hills" } });
ok("2-й сеанс всё ещё отбит лимитом 1 — авторизован не владелец, а рядовой участник",
  r.status === 409 && r.body.limit === 1, JSON.stringify(r.body));

// Теперь владелец (та же анонимная cookie, которой создавали комнату) входит
// в аккаунт — вот теперь лимит должен подняться.
ar = await fetch(PUZZLE + `/api/rooms/${ownerRoom.id}`, { headers: { Authorization: "Bearer " + tokenA, Cookie: ownerCookie } });
const claimedOwnerRoom = await ar.json();
ok("владелец вошёл и клеймится role=owner",
  ar.status === 200 && claimedOwnerRoom.role === "owner", JSON.stringify(claimedOwnerRoom));

r = await asJson(tokenA, `/rooms/${ownerRoom.id}/sessions`, { method: "POST", body: { puzzleId: "hills" } });
ok("лимит снят сразу после входа ИМЕННО владельца — 2-й активный сеанс в комнате возможен",
  r.status === 200, JSON.stringify(r.body));

// ───────── владелец комнаты может убрать участника ─────────
r = await asJson(tokenA, "/rooms", { method: "POST", body: { title: "Комната для проверки кика" } });
const kickRoomId = r.body.id;
const userIdA = r.body.createdBy;
ok("комната для проверки кика создана", r.status === 200, JSON.stringify(r.body));

r = await asJson(tokenB, "/rooms/join/" + r.body.joinCode, { method: "POST" });
ok("B присоединился к комнате для кика", r.status === 200 && r.body.joined === true, JSON.stringify(r.body));

r = await asJson(tokenA, `/rooms/${kickRoomId}`);
const userIdB = r.body.members.find(x => x.role !== "owner").user_id;

r = await asJson(tokenB, `/rooms/${kickRoomId}/members/${userIdA}`, { method: "DELETE" });
ok("не-владелец не может кикнуть — 403", r.status === 403 && r.body.error === "not the owner", JSON.stringify(r.body));

r = await asJson(tokenA, `/rooms/${kickRoomId}/members/${userIdA}`, { method: "DELETE" });
ok("владелец не может выгнать сам себя — 400", r.status === 400 && r.body.error === "cannot remove yourself", JSON.stringify(r.body));

// Анонимный гость (id вида "anon:<uuid>", с двоеточием) — отдельная
// проверка на регресс: seg приходит из url.pathname.split("/") БЕЗ
// decodeURIComponent, клиент шлёт id как encodeURIComponent ("anon%3A..."),
// и без decodeURIComponent на сервере эта ветка ложно бьёт 404 "not a
// member" даже для реально существующего анонимного участника.
ar = await anonCall(null, `/rooms/join/${(await asJson(tokenA, `/rooms/${kickRoomId}`)).body.joinCode}`, { method: "POST" });
ok("анонимный гость присоединился к комнате для кика", ar.status === 200, String(ar.status));
r = await asJson(tokenA, `/rooms/${kickRoomId}`);
const anonGuestId = r.body.members.find(x => x.user_id.startsWith("anon:")).user_id;

r = await asJson(tokenA, `/rooms/${kickRoomId}/members/${encodeURIComponent(anonGuestId)}`, { method: "DELETE" });
ok("владелец убрал анонимного гостя (id с двоеточием) — 200, не 404", r.status === 200 && r.body.ok === true, JSON.stringify(r.body));

r = await asJson(tokenA, `/rooms/${kickRoomId}/sessions`, { method: "POST", body: { puzzleId: "hills" } });
const kickSessionId = r.body.id;
ok("сеанс в комнате для кика стартовал", r.status === 200, JSON.stringify(r.body));

const kickWsUrl = token => `ws://localhost:${PUZZLE_PORT}/ws/rooms/${kickRoomId}/sessions/${kickSessionId}?token=${encodeURIComponent(token)}`;
const wsKickB = new WebSocket(kickWsUrl(tokenB));
await waitOpen(wsKickB);
await waitMessage(wsKickB, msg => msg.type === "sync");
const bClosed = new Promise(res => wsKickB.addEventListener("close", () => res(true)));

r = await asJson(tokenA, `/rooms/${kickRoomId}/members/${userIdB}`, { method: "DELETE" });
ok("владелец убрал участника B — 200", r.status === 200 && r.body.ok === true, JSON.stringify(r.body));

ok("живое WS-подключение выгнанного B разорвано сервером", await Promise.race([bClosed, new Promise(res => setTimeout(() => res(false), 3000))]));

r = await asJson(tokenB, `/rooms/${kickRoomId}`);
ok("выгнанный B больше не член комнаты — 403", r.status === 403 && r.body.error === "not a member", JSON.stringify(r.body));

r = await asJson(tokenA, `/rooms/${kickRoomId}/members/${userIdB}`, { method: "DELETE" });
ok("повторный кик уже убранного участника — 404", r.status === 404 && r.body.error === "not a member", JSON.stringify(r.body));

// ───────── загрузка картинок в библиотеку через Admin (/internal/puzzles) ─────────
const internalCall = (key, p, init = {}) => fetch(PUZZLE + p, {
  ...init,
  headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...(key ? { "X-Admin-Key": key } : {}), ...init.headers },
  body: init.body ? JSON.stringify(init.body) : undefined,
});

let ir = await internalCall("wrong-key", "/internal/puzzles", { method: "POST", body: { title: "x", imageBase64: fakePng.toString("base64") } });
ok("POST /internal/puzzles без верного ключа — 403", ir.status === 403, String(ir.status));

ir = await internalCall(ADMIN_KEY, "/internal/puzzles", {
  method: "POST", body: { title: "Из Admin", imageBase64: fakePng.toString("base64"), width: 300, height: 400 },
});
const adminUpload = await ir.json();
ok("Admin добавил картинку — 200, все PIECE_PRESETS вариантов",
  ir.status === 200 && Array.isArray(adminUpload.variants) && adminUpload.variants.length === 6, JSON.stringify(adminUpload).slice(0, 200));
const adminPuzzleId = adminUpload.variants[0].id;

ir = await fetch(PUZZLE + "/api/puzzles"); // без roomId и без токена — соло-библиотека, гость
const soloLib = await ir.json();
ok("добавленная через Admin картинка видна в соло-библиотеке без входа",
  soloLib.some(x => x.id === adminPuzzleId), JSON.stringify(soloLib.map(x => x.id)));

ir = await internalCall(ADMIN_KEY, "/internal/puzzles");
const adminList = await ir.json();
ok("GET /internal/puzzles видит добавленную группу",
  ir.status === 200 && adminList.puzzles.some(g => g.id === adminPuzzleId && g.variants === 6), JSON.stringify(adminList));

ir = await internalCall(ADMIN_KEY, "/internal/puzzles/hills", { method: "DELETE" });
ok("удалить одну из трёх стартовых картинок через /internal/puzzles нельзя — 400",
  ir.status === 400 && (await ir.json()).error === "not an admin-uploaded puzzle", String(ir.status));

ir = await internalCall(null, `/internal/puzzles/${adminPuzzleId}`, { method: "DELETE" });
ok("DELETE /internal/puzzles/:id без ключа — 403", ir.status === 403, String(ir.status));

ir = await internalCall(ADMIN_KEY, `/internal/puzzles/${adminPuzzleId}`, { method: "DELETE" });
ok("Admin удалил картинку — 200", ir.status === 200 && (await ir.json()).ok === true, String(ir.status));

ir = await internalCall(ADMIN_KEY, "/internal/puzzles");
ok("удалённая группа больше не в /internal/puzzles", !(await ir.json()).puzzles.some(g => g.id === adminPuzzleId));

ir = await fetch(PUZZLE + "/api/puzzles");
ok("удалённая картинка пропала из соло-библиотеки", !(await ir.json()).some(x => x.id === adminPuzzleId));

for (const p of procs) p.kill();
process.exit(failures ? 1 : 0);
