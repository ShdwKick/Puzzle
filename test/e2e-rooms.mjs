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
// Буфер stdout+stderr по имени процесса — нужен, чтобы проверить письма
// мейлера (см. план «Разделение модерации... + письма»): без RESEND_API_KEY
// mailer.js логирует "письмо не отправлено" через console.log (stdout),
// который раньше тут просто отбрасывался (пустой обработчик). stderr
// по-прежнему дублируется в вывод теста с префиксом, как раньше.
const logs = new Map();
function start(name, cwd, env) {
  const p = spawn("node", [...NODE_ARGS, "server.js"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  logs.set(name, "");
  const append = d => logs.set(name, logs.get(name) + d.toString());
  p.stdout.on("data", append);
  p.stderr.on("data", d => { process.stderr.write(`[${name}] ${d}`); append(d); });
  procs.push(p);
}
async function waitForLog(name, substring, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((logs.get(name) || "").includes(substring)) return true;
    await sleep(100);
  }
  return false;
}
const ADMIN_KEY = "test-admin-key";
start("auth", AUTH_DIR, { ...authEnv, DEV: "1", ISSUER: AUTH, PORT: String(AUTH_PORT), HOST: "127.0.0.1", ADMIN_INTERNAL_KEY: ADMIN_KEY });
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
// "you" — личная (не broadcast) часть первого sync (см. server.js,
// attachRoomConnection) — клиент только так узнаёт свою же личность, чтобы
// отличать свои сообщения чата от чужих (см. ниже, «сообщение несёт...»).
const jwtSubA = JSON.parse(Buffer.from(tokenA.split(".")[1], "base64url").toString()).sub;
ok("первый sync несёт «you» — личность самого подключившегося", firstSyncA.you && firstSyncA.you.id === jwtSubA, JSON.stringify(firstSyncA.you));

const wsB = new WebSocket(wsUrl(tokenB));
await waitOpen(wsB);
const firstSyncB = await waitMessage(wsB, m => m.type === "sync");
ok("у B своё «you», отличное от A", firstSyncB.you && firstSyncB.you.id !== jwtSubA, JSON.stringify(firstSyncB.you));

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

// ───────── чат за столом (см. план «Чат на доску») — эфемерный транзит
// через broadcast, ничего не хранится ни в БД, ни в state сессии ─────────
const chatOnB = waitMessage(wsB, m => m.type === "chat");
const chatEchoOnA = waitMessage(wsA, m => m.type === "chat");
wsA.send(JSON.stringify({ type: "chat", text: "  Привет из теста!  " }));
const [chatMsgB, chatMsgA] = await Promise.all([chatOnB, chatEchoOnA]);
ok("B получил сообщение чата от A", chatMsgB.text === "Привет из теста!", JSON.stringify(chatMsgB));
ok("текст обрезан от пробелов по краям (str())", chatMsgB.text === chatMsgB.text.trim());
ok("A тоже получил своё сообщение (эхо, не оптимистичный рендер на клиенте)",
  chatMsgA.text === "Привет из теста!", JSON.stringify(chatMsgA));
ok("сообщение несёт отправителя (id/name/username, см. presenceList-подобную форму)",
  chatMsgB.from && chatMsgB.from.id === jwtSubA, JSON.stringify(chatMsgB.from));
ok("и это тот же id, что «you» у A из первого sync — так клиент узнаёт свои сообщения",
  chatMsgA.from.id === firstSyncA.you.id, JSON.stringify({ from: chatMsgA.from, you: firstSyncA.you }));
ok("сообщение несёт метку времени", typeof chatMsgB.at === "number" && chatMsgB.at > 0);

wsA.send(JSON.stringify({ type: "chat", text: "   " }));
wsA.send(JSON.stringify({ type: "chat", text: "второе" }));
const chatMsg2 = await waitMessage(wsB, m => m.type === "chat" && m.text === "второе");
ok("пустое/пробельное сообщение не рассылается — B сразу получил следующее непустое", !!chatMsg2);

// str() (см. server.js) не обрезает длинные строки, а целиком отбивает —
// тот же принцип, что и у остальных полей в этом файле (bad category и
// т.п.), тут просто молча не долетает: следующее нормальное сообщение
// приходит без него.
const longText = "д".repeat(600);
wsA.send(JSON.stringify({ type: "chat", text: longText }));
wsA.send(JSON.stringify({ type: "chat", text: "третье" }));
const chatMsg3 = await waitMessage(wsB, m => m.type === "chat" && m.text === "третье");
ok("сообщение длиннее 500 символов молча отбито (str() не обрезает, а отклоняет целиком)", !!chatMsg3);

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

// Согласие обязательно (см. план «Модерация загруженных фото») — без
// consent=1 сервер отбивает 400 ещё до чтения тела картинки.
let ur = await callRaw(tokenA, `/puzzles?roomId=${roomId}&w=300&h=400`, fakePng, "image/png");
ok("загрузка без consent=1 отбита 400", ur.status === 400 && (await ur.json()).error === "consent required", String(ur.status));

ur = await callRaw(tokenA, `/puzzles?roomId=${roomId}&w=300&h=400&consent=1&title=${encodeURIComponent("Тестовое фото")}`, fakePng, "image/png");
const upload = { status: ur.status, body: await ur.json().catch(() => ({})) };
ok("загрузка фото в комнату прошла", upload.status === 200 && Array.isArray(upload.body.variants) && upload.body.variants.length === 6, JSON.stringify(upload.body).slice(0, 200));
const uploadedId = upload.body.variants[0].id;
ok("moderationStatus пуст сразу после загрузки (никогда не публиковалось)", upload.body.variants[0].moderationStatus === null, JSON.stringify(upload.body.variants[0]));

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

// ───────── библиотека в комнате — по добавлению, не по умолчанию (см. план
// «Библиотека в комнате — по добавлению, не по умолчанию») ─────────
// roomId — тут состоят оба (tokenA и tokenB), значит подходит проверить, что
// добавленное одним видно и другому (общая настройка комнаты, не личная).
r = await asJson(tokenA, `/puzzles?roomId=${roomId}`);
ok("встроенный пазл по умолчанию НЕ виден в свежей комнате (библиотека — по добавлению)",
  r.status === 200 && !r.body.some(p => p.id === "hills"), JSON.stringify(r.body.map(p => p.id)));

r = await asJson(tokenA, `/rooms/${roomId}/added-puzzles`, { method: "POST", body: { puzzleId: "hills" } });
ok("добавление встроенного пазла в комнату прошло", r.status === 200 && r.body.ok === true, JSON.stringify(r.body));

r = await asJson(tokenA, `/puzzles?roomId=${roomId}`);
ok("добавленный пазл виден добавившему в этой комнате", r.status === 200 && r.body.some(p => p.id === "hills"), JSON.stringify(r.body.map(p => p.id)));

r = await asJson(tokenB, `/puzzles?roomId=${roomId}`);
ok("добавленный пазл виден и другому участнику той же комнаты", r.status === 200 && r.body.some(p => p.id === "hills"), JSON.stringify(r.body.map(p => p.id)));

r = await asJson(tokenA, "/puzzles");
ok("добавление в комнату не задевает соло-библиотеку — пазл виден и там (он и так всегда виден)",
  r.status === 200 && r.body.some(p => p.id === "hills"), JSON.stringify(r.body.map(p => p.id)));

r = await asJson(tokenA, `/puzzles?roomId=${roomId2}`);
ok("добавление в одну комнату не задевает другую — там пазл по-прежнему не виден",
  r.status === 200 && !r.body.some(p => p.id === "hills"), JSON.stringify(r.body.map(p => p.id)));

// Повторное добавление уже добавленного — идемпотентно, не падает.
r = await asJson(tokenA, `/rooms/${roomId}/added-puzzles`, { method: "POST", body: { puzzleId: "hills" } });
ok("повторное добавление того же пазла не падает", r.status === 200 && r.body.ok === true, JSON.stringify(r.body));

r = await asJson(tokenA, `/rooms/${roomId}/added-puzzles/hills`, { method: "DELETE" });
ok("удаление добавленного пазла из комнаты проходит", r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
r = await asJson(tokenA, `/puzzles?roomId=${roomId}`);
ok("после удаления пазл снова не виден в комнате", r.status === 200 && !r.body.some(p => p.id === "hills"), JSON.stringify(r.body.map(p => p.id)));

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

// ───────── публикация в общую библиотеку + бан устройства (см. план
// «Модерация загруженных фото») ─────────
const authInternalCall = (key, p, init = {}) => fetch(AUTH + p, {
  ...init,
  headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...(key ? { "X-Admin-Key": key } : {}), ...init.headers },
  body: init.body ? JSON.stringify(init.body) : undefined,
});

// Свежая загрузка для публикации — uploadedId (выше по файлу) уже удалён
// тестом self-service DELETE, publish на несуществующий id даст 404, а не
// то, что тут реально проверяется.
ur = await callRaw(tokenA, `/puzzles?roomId=${roomId}&w=300&h=400&consent=1&title=${encodeURIComponent("Фото на публикацию")}`, fakePng, "image/png");
const uploadForPublish = await ur.json();
const publishId = uploadForPublish.variants[0].id;

r = await asJson(tokenA, `/puzzles/${publishId}/publish`, { method: "POST", body: {} });
ok("публикация без consent — 400", r.status === 400 && r.body.error === "consent required", JSON.stringify(r.body));

r = await asJson(tokenA, `/puzzles/${publishId}/publish`, { method: "POST", body: { consent: true } });
ok("публикация с consent — 200, pending", r.status === 200 && r.body.moderationStatus === "pending", JSON.stringify(r.body));

r = await asJson(tokenA, `/puzzles/${publishId}/publish`, { method: "POST", body: { consent: true } });
ok("повторная публикация уже pending — 409", r.status === 409, String(r.status));

r = await asJson(tokenB, `/puzzles/${publishId}/publish`, { method: "POST", body: { consent: true } });
ok("публикация чужого фото — 403", r.status === 403, String(r.status));

ir = await internalCall(ADMIN_KEY, `/internal/moderation/photos/${publishId}/approve`, { method: "POST" });
ok("Admin одобрил публикацию — 200", ir.status === 200 && (await ir.json()).ok === true, String(ir.status));

ir = await fetch(PUZZLE + "/api/puzzles");
ok("одобренное фото видно в соло-библиотеке без входа", (await ir.json()).some(x => x.id === publishId));

r = await asJson(tokenA, `/puzzles?roomId=${roomId}`);
const approvedRow = r.body.find(x => x.id === publishId);
ok("статус на карточке — approved", approvedRow && approvedRow.moderationStatus === "approved", JSON.stringify(approvedRow));
// approve публикации сам добавляет пазл в комнату, откуда его загрузили
// (см. план «Библиотека в комнате — по добавлению, не по умолчанию», сервер
// делает это автоматически при одобрении) — иначе он молча пропал бы из-под
// ног у того, кто его туда изначально загрузил и с ним играл.
ok("одобрение публикации САМО добавило пазл в комнату, откуда его загрузили", !!approvedRow, JSON.stringify(approvedRow));
r = await asJson(tokenA, `/puzzles?roomId=${roomId2}`);
ok("но НЕ добавило его в другую комнату того же владельца — автодобавление только в комнату-источник",
  !r.body.some(x => x.id === publishId), JSON.stringify(r.body.map(p => p.id)));

// Второе фото — на отклонение с причиной, потом переотправку.
ur = await callRaw(tokenA, `/puzzles?roomId=${roomId}&w=300&h=400&consent=1&title=${encodeURIComponent("Фото на отклонение")}`, fakePng, "image/png");
const upload2 = await ur.json();
const rejectId = upload2.variants[0].id;
await asJson(tokenA, `/puzzles/${rejectId}/publish`, { method: "POST", body: { consent: true } });

ir = await internalCall(ADMIN_KEY, `/internal/moderation/photos/${rejectId}/reject`, { method: "POST", body: { reason: "замажьте номер машины на фоне" } });
ok("Admin отклонил публикацию — 200", ir.status === 200, String(ir.status));

r = await asJson(tokenA, `/puzzles?roomId=${roomId}`);
const rejectedRow = r.body.find(x => x.id === rejectId);
ok("отклонённое фото несёт причину и остаётся приватным", rejectedRow && rejectedRow.moderationStatus === "rejected" && rejectedRow.moderationReason.includes("номер"), JSON.stringify(rejectedRow));

r = await asJson(tokenA, `/puzzles/${rejectId}/publish`, { method: "POST", body: { consent: true } });
ok("переотправка после отклонения разрешена — снова pending", r.status === 200 && r.body.moderationStatus === "pending", JSON.stringify(r.body));

// Модерационное удаление — форсирует, даже если пазлом уже играли (в
// отличие от self-service DELETE /api/puzzles/:id). Своя свежая комната —
// roomId к этому моменту файла мог уже упереться в лимит активных сеансов
// из более ранних тестов, а тут это не то, что проверяется.
r = await asJson(tokenA, "/rooms", { method: "POST", body: { title: "Комната для форс-удаления" } });
const forceDeleteRoomId = r.body.id;
r = await asJson(tokenA, `/rooms/${forceDeleteRoomId}/sessions`, { method: "POST", body: { puzzleId: rejectId } });
ok("сеанс с этим фото стартовал (готовим 'уже играли')", r.status === 200, JSON.stringify(r.body));

ir = await internalCall(ADMIN_KEY, `/internal/moderation/photos/${rejectId}`, { method: "DELETE" });
ok("модерационное удаление проходит, даже если пазлом уже играли — 200", ir.status === 200, String(ir.status));

ir = await internalCall(ADMIN_KEY, "/internal/moderation/photos");
const modList = await ir.json();
ok("удалённое фото пропало из списка модерации", !modList.photos.some(x => x.id === rejectId), JSON.stringify(modList.photos.map(x => x.id)));

// Бан устройства — куём собственный device-id (не тот, что реально выдал
// бы сервер) и баним его напрямую в Auth, чтобы не гонять полноценный вход
// ради одной cookie. Дальше используем как реальный bh_device — сервер не
// отличает, откуда взялось значение, лишь бы прошёл формат UUID.
const testDeviceId = crypto.randomUUID();
const deviceCookie = `bh_device=${testDeviceId}`;

const deviceUploadCall = () => fetch(PUZZLE + `/api/puzzles?roomId=${roomId}&w=300&h=400&consent=1`, {
  method: "POST", headers: { Authorization: "Bearer " + tokenA, "Content-Type": "image/png", Cookie: deviceCookie }, body: fakePng,
});

ur = await deviceUploadCall();
ok("загрузка с ещё не забаненного устройства проходит", ur.status === 200, String(ur.status));

ir = await authInternalCall(ADMIN_KEY, `/internal/devices/${testDeviceId}/banned`, { method: "POST", body: { on: true, reason: "тестовый бан" } });
ok("бан устройства в Auth — 200", ir.status === 200, String(ir.status));

ur = await deviceUploadCall();
const bannedUploadBody = await ur.json().catch(() => ({}));
ok("после бана устройства загрузка отбита 403 ещё до записи в БД", ur.status === 403 && bannedUploadBody.error === "device banned", JSON.stringify(bannedUploadBody));

// ───────── категории many-to-many (см. план «Категории many-to-many,
// автор карточки, профиль») ─────────
const USER_CATEGORY_ID = "user-published"; // тот же фиксированный id, что и в server.js

ir = await fetch(PUZZLE + "/api/categories"); // публичный роут, без ключа и без входа
const initialCategories = await ir.json();
ok("GET /api/categories видит только системную «Пользовательские» изначально",
  ir.status === 200 && initialCategories.length === 1 && initialCategories[0].id === USER_CATEGORY_ID, JSON.stringify(initialCategories));

ir = await internalCall("wrong-key", "/internal/categories", { method: "POST", body: { name: "Природа" } });
ok("POST /internal/categories без верного ключа — 403", ir.status === 403, String(ir.status));

ir = await internalCall(ADMIN_KEY, "/internal/categories", { method: "POST", body: { name: "Природа" } });
const categoryA = await ir.json();
ok("категория создана — 200", ir.status === 200 && categoryA.id && categoryA.name === "Природа", JSON.stringify(categoryA));

ir = await internalCall(ADMIN_KEY, "/internal/categories", { method: "POST", body: { name: "Город" } });
const categoryB = await ir.json();
ok("вторая категория создана", ir.status === 200 && categoryB.id, JSON.stringify(categoryB));

ir = await fetch(PUZZLE + "/api/categories");
const publicCategories = await ir.json();
ok("все approved категории видны в публичном списке (системная + 2 новые)",
  publicCategories.length === 3 && publicCategories.some(c => c.id === categoryA.id) && publicCategories.some(c => c.id === categoryB.id),
  JSON.stringify(publicCategories));

// ───────── алиас и публичное название категории (см. план «Алиас и
// публичное название категории») — name видят люди на странице, slug идёт
// в путь и может задаваться явно, независимо от name ─────────
ir = await internalCall(ADMIN_KEY, "/internal/categories", { method: "POST", body: { name: "Кошки", slug: "cats" } });
const categoryCats = await ir.json();
ok("категория с явным алиасом — slug именно 'cats', не производный от «Кошки»",
  ir.status === 200 && categoryCats.id && categoryCats.name === "Кошки" && categoryCats.slug === "cats", JSON.stringify(categoryCats));

ir = await internalCall(ADMIN_KEY, "/internal/categories", { method: "POST", body: { name: "Котики", slug: "cats" } });
ok("повторный явный алиас 'cats' — 400 slug taken (не подбирается тихо cats-2)",
  ir.status === 400 && (await ir.json()).error === "slug taken", String(ir.status));

ir = await internalCall(ADMIN_KEY, `/internal/categories/${categoryCats.id}`, { method: "PATCH", body: { name: "Котята" } });
const catsRenamed = await ir.json();
ok("PATCH — переименование (name) не трогает alias (slug)",
  ir.status === 200 && catsRenamed.name === "Котята" && catsRenamed.slug === "cats", JSON.stringify(catsRenamed));

ir = await internalCall(ADMIN_KEY, `/internal/categories/${categoryCats.id}`, { method: "PATCH", body: { slug: "kittens" } });
const catsResluged = await ir.json();
ok("PATCH — смена алиаса (slug) не трогает имя (name)",
  ir.status === 200 && catsResluged.slug === "kittens" && catsResluged.name === "Котята", JSON.stringify(catsResluged));

ir = await internalCall(ADMIN_KEY, `/internal/categories/${categoryB.id}`, { method: "PATCH", body: { slug: "kittens" } });
ok("PATCH — чужой уже занятый алиас отбит 400 (id себя самого не считается конфликтом)",
  ir.status === 400 && (await ir.json()).error === "slug taken", String(ir.status));

ir = await internalCall(ADMIN_KEY, "/internal/categories/no-such-id", { method: "PATCH", body: { name: "x" } });
ok("PATCH несуществующей категории — 404", ir.status === 404, String(ir.status));

ir = await internalCall("wrong-key", `/internal/categories/${categoryCats.id}`, { method: "PATCH", body: { name: "x" } });
ok("PATCH без верного ключа — 403", ir.status === 403, String(ir.status));

ir = await internalCall(ADMIN_KEY, "/internal/categories");
const adminCategoriesList = (await ir.json()).categories;
ok("GET /internal/categories отдаёт slug у каждой категории",
  adminCategoriesList.every(c => typeof c.slug === "string" && c.slug.length > 0), JSON.stringify(adminCategoriesList.map(c => c.slug)));

// ───────── nameEn (см. план «Английский язык в интерфейсе») — необязательное
// английское название категории для клиента, никак не влияет на slug ─────────
ir = await internalCall(ADMIN_KEY, "/internal/categories", { method: "POST", body: { name: "Птицы", nameEn: "Birds" } });
const categoryBirds = await ir.json();
ok("создание категории с nameEn — отдаёт его в ответе",
  ir.status === 200 && categoryBirds.name === "Птицы" && categoryBirds.nameEn === "Birds", JSON.stringify(categoryBirds));

ir = await internalCall(ADMIN_KEY, "/internal/categories", { method: "POST", body: { name: "Рыбы" } });
const categoryFish = await ir.json();
ok("создание категории без nameEn — nameEn === null",
  ir.status === 200 && categoryFish.nameEn === null, JSON.stringify(categoryFish));

ir = await internalCall(ADMIN_KEY, `/internal/categories/${categoryFish.id}`, { method: "PATCH", body: { nameEn: "Fish" } });
const fishPatched = await ir.json();
ok("PATCH — установка nameEn у категории, где его не было",
  ir.status === 200 && fishPatched.nameEn === "Fish" && fishPatched.name === "Рыбы", JSON.stringify(fishPatched));

ir = await internalCall(ADMIN_KEY, `/internal/categories/${categoryBirds.id}`, { method: "PATCH", body: { nameEn: "" } });
const birdsCleared = await ir.json();
ok("PATCH — очистка nameEn пустой строкой возвращает null",
  ir.status === 200 && birdsCleared.nameEn === null, JSON.stringify(birdsCleared));

ir = await internalCall(ADMIN_KEY, "/internal/categories");
const listWithNameEn = (await ir.json()).categories;
ok("GET /internal/categories отдаёт nameEn (null или строка) у каждой категории",
  listWithNameEn.find(c => c.id === categoryFish.id)?.nameEn === "Fish" && listWithNameEn.find(c => c.id === categoryBirds.id)?.nameEn === null,
  JSON.stringify(listWithNameEn.map(c => [c.name, c.nameEn])));

ir = await fetch(PUZZLE + "/api/categories");
const publicWithNameEn = await ir.json();
ok("публичный GET /api/categories тоже отдаёт nameEn",
  publicWithNameEn.find(c => c.id === categoryFish.id)?.nameEn === "Fish", JSON.stringify(publicWithNameEn.find(c => c.id === categoryFish.id)));

ir = await internalCall(ADMIN_KEY, `/internal/categories/${categoryFish.id}`, { method: "DELETE" });
ok("уборка: тестовая категория «Рыбы»/Fish удалена", ir.status === 200, String(ir.status));
ir = await internalCall(ADMIN_KEY, `/internal/categories/${categoryBirds.id}`, { method: "DELETE" });
ok("уборка: тестовая категория «Птицы» удалена", ir.status === 200, String(ir.status));

ir = await internalCall(ADMIN_KEY, `/internal/categories/${categoryCats.id}`, { method: "DELETE" });
ok("уборка: тестовая категория «Котята» (cats/kittens) удалена", ir.status === 200, String(ir.status));

// ───────── слаги категорий, sitemap.xml, SEO-заглушка serveApp (см. план
// «Прямые ссылки вместо #/ + страница категорий») ─────────
// Публичный /api/categories отдаёт то же поле slug (кроме name), что и
// /internal/categories теперь тоже отдаёт (см. блок с алиасом выше).
const categoryASlug = publicCategories.find(c => c.id === categoryA.id)?.slug;
const categoryBSlug = publicCategories.find(c => c.id === categoryB.id)?.slug;
ok("слаг категории «Природа» — «природа», без транслитерации", categoryASlug === "природа", String(categoryASlug));
ok("слаг категории «Город» — «город»", categoryBSlug === "город", String(categoryBSlug));

ir = await internalCall(ADMIN_KEY, "/internal/categories", { method: "POST", body: { name: "Природа" } });
const categoryADup = await ir.json();
ir = await fetch(PUZZLE + "/api/categories");
const categoriesAfterDup = await ir.json();
const categoryADupSlug = categoriesAfterDup.find(c => c.id === categoryADup.id)?.slug;
ok("повторное имя категории получает уникальный слаг («природа-2»)",
  ir.status === 200 && categoryADupSlug === "природа-2", String(categoryADupSlug));
ir = await internalCall(ADMIN_KEY, `/internal/categories/${categoryADup.id}`, { method: "DELETE" });
ok("уборка: дубль-категория «Природа» (2) удалена", ir.status === 200, String(ir.status));

// Пустые категории (0 пазлов) не попадают в sitemap.xml (см. план «Не
// показываем категорию, если в ней 0 пазлов») — обе, А и Б, пока пусты.
ir = await fetch(PUZZLE + "/sitemap.xml");
let sitemapXml = await ir.text();
ok("sitemap.xml — content-type application/xml", (ir.headers.get("content-type") || "").includes("application/xml"), ir.headers.get("content-type"));
ok("sitemap.xml содержит главную", sitemapXml.includes("<loc>https://puzzle.burninghouse.ru/</loc>"), "");
ok("sitemap.xml содержит /categories", sitemapXml.includes("<loc>https://puzzle.burninghouse.ru/categories</loc>"), "");
ok("sitemap.xml НЕ содержит пустую категорию «Природа» (0 пазлов)",
  !sitemapXml.includes(`/category/${encodeURIComponent(categoryASlug)}`), "");

// Прикрепляем тестовый пазл к категории А — теперь она непустая и должна
// появиться и в sitemap.xml, и в GET /api/categories (после cleanup — уже
// проверено ниже сразу, отдельным запросом, до удаления).
ir = await internalCall(ADMIN_KEY, "/internal/puzzles", {
  method: "POST", body: { title: "Для проверки sitemap", imageBase64: fakePng.toString("base64"), width: 300, height: 400, categoryId: categoryA.id },
});
const sitemapSeedUpload = await ir.json();

ir = await fetch(PUZZLE + "/sitemap.xml");
sitemapXml = await ir.text();
ok("sitemap.xml содержит /category/природа, как только в ней появился пазл",
  sitemapXml.includes(`<loc>https://puzzle.burninghouse.ru/category/${encodeURIComponent(categoryASlug)}</loc>`), "");

ir = await internalCall(ADMIN_KEY, `/internal/puzzles/${sitemapSeedUpload.variants[0].id}`, { method: "DELETE" });
ok("уборка: тестовый пазл для проверки sitemap удалён", ir.status === 200, String(ir.status));

const titleOf = html => (html.match(/<title>([^<]*)<\/title>/) || [])[1];
const canonicalOf = html => (html.match(/<link rel="canonical" href="([^"]*)">/) || [])[1];

const homeHtml = await (await fetch(PUZZLE + "/")).text();
const categoriesHtml = await (await fetch(PUZZLE + "/categories")).text();
const categoryHtml = await (await fetch(PUZZLE + `/category/${encodeURIComponent(categoryASlug)}`)).text();
const missingCategoryHtml = await (await fetch(PUZZLE + "/category/нет-такой-категории")).text();

ok("/categories отдаёт свой <title>, отличный от главной",
  titleOf(categoriesHtml) && titleOf(categoriesHtml) !== titleOf(homeHtml), titleOf(categoriesHtml));
ok("/category/природа отдаёт <title> с названием категории",
  (titleOf(categoryHtml) || "").includes("Природа"), titleOf(categoryHtml));
ok("/category/природа — canonical указывает именно на эту страницу, не на главную",
  canonicalOf(categoryHtml) === `https://puzzle.burninghouse.ru/category/${encodeURIComponent(categoryASlug)}`, canonicalOf(categoryHtml));
ok("/categories — canonical указывает на /categories",
  canonicalOf(categoriesHtml) === "https://puzzle.burninghouse.ru/categories", canonicalOf(categoriesHtml));
ok("несуществующий слаг — просто дефолтная страница (тот же <title>, что и главная), без 404",
  titleOf(missingCategoryHtml) === titleOf(homeHtml), titleOf(missingCategoryHtml));

// ───────── публичная ссылка на конкретный пазл (см. план «Публичная ссылка
// на пазл») — /table/:id отдаёт свои title/description/canonical/og:image,
// но только для БИБЛИОТЕЧНЫХ (owner_user_id IS NULL) — приватная/чужая
// загрузка по угаданному id не должна течь в превью/индексацию ─────────
const ogImageOf = html => (html.match(/<meta property="og:image" content="([^"]*)">/) || [])[1];
const hillsHtml = await (await fetch(PUZZLE + "/table/hills")).text();
ok("/table/hills отдаёт свой <title> с названием пазла", (titleOf(hillsHtml) || "").includes("Холмы"), titleOf(hillsHtml));
ok("/table/hills — canonical указывает именно на эту страницу", canonicalOf(hillsHtml) === "https://puzzle.burninghouse.ru/table/hills", canonicalOf(hillsHtml));
ok("/table/hills — og:image указывает на картинку самого пазла, не на общий баннер",
  (ogImageOf(hillsHtml) || "").includes("hills.svg"), ogImageOf(hillsHtml));

const missingTableHtml = await (await fetch(PUZZLE + "/table/нет-такого-пазла")).text();
ok("несуществующий id пазла — дефолтная страница, без 404", titleOf(missingTableHtml) === titleOf(homeHtml), titleOf(missingTableHtml));

r = await asJson(tokenA, "/rooms", { method: "POST", body: { title: "Комната для проверки приватной ссылки" } });
const linkTestRoomId = r.body.id;
ur = await callRaw(tokenA, `/puzzles?roomId=${linkTestRoomId}&w=300&h=400&consent=1&title=${encodeURIComponent("Приватное фото для проверки ссылки")}`, fakePng, "image/png");
const privateUploadForLinkTest = await ur.json();
const privateTableHtml = await (await fetch(PUZZLE + `/table/${privateUploadForLinkTest.variants[0].id}`)).text();
ok("приватная (ещё не опубликованная) загрузка — дефолтная страница по угаданному id, не своя SEO-подмена",
  titleOf(privateTableHtml) === titleOf(homeHtml), titleOf(privateTableHtml));

ir = await fetch(PUZZLE + "/sitemap.xml");
sitemapXml = await ir.text();
ok("sitemap.xml содержит /table/hills — по одному URL на группу, самый лёгкий вариант",
  sitemapXml.includes("<loc>https://puzzle.burninghouse.ru/table/hills</loc>"), "");
ok("sitemap.xml НЕ содержит вариантов посложнее той же группы (hills-48 и т.п.)",
  !sitemapXml.includes("/table/hills-48<"), "");

// ───────── обновлённые пресеты сложности (см. план «Обновить пресеты
// сложности») — два самых сложных уровня стали больше (300→600, 480→1000) ─────────
ir = await fetch(PUZZLE + "/api/config");
const config = await ir.json();
ok("GET /api/config отдаёт обновлённые пресеты — 300/480 заменены на 600/1000",
  JSON.stringify(config.piecePresets) === JSON.stringify([12, 48, 108, 216, 600, 1000]), JSON.stringify(config.piecePresets));

ir = await fetch(PUZZLE + "/api/puzzles");
const libAfterPresetChange = await ir.json();
const hills600 = libAfterPresetChange.find(p => p.id === "hills-600");
const hills1000 = libAfterPresetChange.find(p => p.id === "hills-1000");
// gridForPieceTarget округляет rows/cols НЕЗАВИСИМО (см. server.js) — точное
// произведение не гарантировано, тот же эффект уже виден у старых пресетов
// (216→221, 480→475 деталей по факту), поэтому сверяем близость, не равенство.
const closeTo = (actual, target, tolerancePct = 5) => Math.abs(actual - target) / target * 100 <= tolerancePct;
ok("новый уровень «hills-600» создан — около 600 деталей", hills600 && closeTo(hills600.gridRows * hills600.gridCols, 600),
  JSON.stringify(hills600 && { rows: hills600.gridRows, cols: hills600.gridCols, total: hills600.gridRows * hills600.gridCols }));
ok("новый уровень «hills-1000» создан — около 1000 деталей", hills1000 && closeTo(hills1000.gridRows * hills1000.gridCols, 1000),
  JSON.stringify(hills1000 && { rows: hills1000.gridRows, cols: hills1000.gridCols, total: hills1000.gridRows * hills1000.gridCols }));
ok("старые «hills-300»/«hills-480» пропали (одноразовая уборка при старте, см. server.js)",
  !libAfterPresetChange.some(p => p.id === "hills-300" || p.id === "hills-480"), "");
ok("группа «Холмы» содержит ровно 6 вариантов, не 8", libAfterPresetChange.filter(p => p.imageUrl === hills600.imageUrl).length === 6,
  String(libAfterPresetChange.filter(p => p.imageUrl === hills600.imageUrl).length));

ir = await internalCall(ADMIN_KEY, "/internal/puzzles", {
  method: "POST", body: { title: "С категорией", imageBase64: fakePng.toString("base64"), width: 300, height: 400, categoryId: categoryA.id },
});
const categorizedUpload = await ir.json();
ok("загрузка через Admin с categoryId — 200, все варианты несут категорию",
  ir.status === 200 && categorizedUpload.variants.length === 6, JSON.stringify(categorizedUpload).slice(0, 200));
const categorizedPuzzleId = categorizedUpload.variants[0].id;

ir = await fetch(PUZZLE + "/api/puzzles");
const libAfterCategoryUpload = await ir.json();
const categorizedVariants = libAfterCategoryUpload.filter(p => p.imageUrl === categorizedUpload.variants[0].imageUrl);
ok("все 6 вариантов несут одну и ту же категорию",
  categorizedVariants.length === 6 && categorizedVariants.every(p => p.categoryId === categoryA.id),
  JSON.stringify(categorizedVariants.map(p => p.categoryId)));

// Обложка категории (см. план «Обложка категории») — серверная заглушка
// /categories (categoriesListHtml, до отработки JS) несёт <img> с адресом
// первого пазла категории; тот же адрес отдаёт /api/puzzles.
ir = await fetch(PUZZLE + "/categories");
const categoriesPageHtml = await ir.text();
ok("серверная заглушка /categories несёт обложку — src первого пазла категории",
  categoriesPageHtml.includes(`<img src="${categorizedUpload.variants[0].imageUrl}"`), "");

ir = await internalCall(ADMIN_KEY, "/internal/puzzles", {
  method: "POST", body: { title: "С неверной категорией", imageBase64: fakePng.toString("base64"), width: 300, height: 400, categoryId: "no-such-category" },
});
ok("загрузка с несуществующей categoryId — 400", ir.status === 400, String(ir.status));

ir = await internalCall(ADMIN_KEY, `/internal/puzzles/${categorizedPuzzleId}/category`, { method: "POST", body: { categoryId: categoryB.id } });
ok("замена категории (единственное число) — 200", ir.status === 200 && (await ir.json()).ok === true, String(ir.status));

ir = await fetch(PUZZLE + "/api/puzzles");
const afterCategoryChange = (await ir.json()).filter(p => categorizedVariants.some(v => v.id === p.id));
ok("после замены — только новая категория, старой уже нет",
  afterCategoryChange.every(p => p.categoryId === categoryB.id),
  JSON.stringify(afterCategoryChange.map(p => p.categoryId)));

ir = await internalCall(null, `/internal/categories/${categoryB.id}`, { method: "DELETE" });
ok("DELETE /internal/categories/:id без ключа — 403", ir.status === 403, String(ir.status));

ir = await internalCall(ADMIN_KEY, `/internal/categories/${USER_CATEGORY_ID}`, { method: "DELETE" });
ok("удалить системную категорию «Пользовательские» нельзя — 400",
  ir.status === 400 && (await ir.json()).error === "protected category", String(ir.status));

ir = await internalCall(ADMIN_KEY, `/internal/categories/${categoryB.id}`, { method: "DELETE" });
ok("удаление обычной категории — 200", ir.status === 200 && (await ir.json()).ok === true, String(ir.status));

ir = await fetch(PUZZLE + "/api/puzzles");
const afterCategoryDelete = (await ir.json()).find(p => p.id === categorizedPuzzleId);
ok("пазл пережил удаление своей категории — остался, но без категории (ON DELETE SET NULL на puzzles.category_id)",
  afterCategoryDelete && afterCategoryDelete.categoryId === null, JSON.stringify(afterCategoryDelete));

ir = await fetch(PUZZLE + "/api/categories");
const categoriesAfterDelete = await ir.json();
ok("удалённой категории больше нет в публичном списке, категория A осталась",
  !categoriesAfterDelete.some(c => c.id === categoryB.id) && categoriesAfterDelete.some(c => c.id === categoryA.id), JSON.stringify(categoriesAfterDelete));

ir = await internalCall(ADMIN_KEY, `/internal/puzzles/${categorizedPuzzleId}`, { method: "DELETE" });
ok("уборка: тестовая картинка с категорией удалена", ir.status === 200, String(ir.status));

// ───────── публикация и категория: одна на пазл (см. план «Один пазл —
// одна категория») — три ветки: выбрана существующая, предложена новая,
// не выбрано ничего (дефолт «Пользовательские») ─────────
r = await asJson(tokenA, "/rooms", { method: "POST", body: { title: "Комната для категорий при публикации" } });
const catPublishRoomId = r.body.id;

// Ветка 1 — выбрана существующая категория.
ur = await callRaw(tokenA, `/puzzles?roomId=${catPublishRoomId}&w=300&h=400&consent=1&title=${encodeURIComponent("Фото с выбранной категорией")}`, fakePng, "image/png");
const uploadForExistingCatPublish = await ur.json();
const existingCatPublishId = uploadForExistingCatPublish.variants[0].id;
r = await asJson(tokenA, `/puzzles/${existingCatPublishId}/publish`, { method: "POST", body: { consent: true, categoryId: categoryA.id } });
ok("публикация с выбранной существующей категорией — 200, pending", r.status === 200 && r.body.moderationStatus === "pending", JSON.stringify(r.body));
r = await asJson(tokenA, `/puzzles?roomId=${catPublishRoomId}`);
const existingCatPublishRow = r.body.find(x => x.id === existingCatPublishId);
ok("на пазле именно выбранная категория, без автодобавления «Пользовательские»",
  existingCatPublishRow && existingCatPublishRow.categoryId === categoryA.id, JSON.stringify(existingCatPublishRow && existingCatPublishRow.categoryId));
ir = await internalCall(ADMIN_KEY, `/internal/moderation/photos/${existingCatPublishId}`, { method: "DELETE" });
ok("уборка: пазл с выбранной категорией удалён", ir.status === 200, String(ir.status));

// Ветка 3 — ни categoryId, ни newCategoryName: дефолт «Пользовательские».
ur = await callRaw(tokenA, `/puzzles?roomId=${catPublishRoomId}&w=300&h=400&consent=1&title=${encodeURIComponent("Фото без категории")}`, fakePng, "image/png");
const uploadForDefaultCatPublish = await ur.json();
const defaultCatPublishId = uploadForDefaultCatPublish.variants[0].id;
r = await asJson(tokenA, `/puzzles/${defaultCatPublishId}/publish`, { method: "POST", body: { consent: true } });
ok("публикация без выбора — 200, pending", r.status === 200 && r.body.moderationStatus === "pending", JSON.stringify(r.body));
r = await asJson(tokenA, `/puzzles?roomId=${catPublishRoomId}`);
const defaultCatPublishRow = r.body.find(x => x.id === defaultCatPublishId);
ok("без выбора — категория по умолчанию, системная «Пользовательские»",
  defaultCatPublishRow && defaultCatPublishRow.categoryId === USER_CATEGORY_ID, JSON.stringify(defaultCatPublishRow && defaultCatPublishRow.categoryId));
ir = await internalCall(ADMIN_KEY, `/internal/moderation/photos/${defaultCatPublishId}`, { method: "DELETE" });
ok("уборка: пазл без выбранной категории удалён", ir.status === 200, String(ir.status));

// Ветка 2 — предложена новая категория (newCategoryName побеждает, даже
// если бы был прислан и categoryId — тут не присылаем специально, чтобы не
// путать с веткой 1). Атрибуция переживает approve, новая категория уходит
// на модерацию отдельно от самого фото (см. план «Категории many-to-many,
// автор карточки, профиль» — эта часть не менялась).
ur = await callRaw(tokenA, `/puzzles?roomId=${catPublishRoomId}&w=300&h=400&consent=1&title=${encodeURIComponent("Фото с категориями")}`, fakePng, "image/png");
const uploadForCatPublish = await ur.json();
const catPublishId = uploadForCatPublish.variants[0].id;

r = await asJson(tokenA, `/puzzles/${catPublishId}/publish`, {
  method: "POST", body: { consent: true, newCategoryName: "Экспериментальная (тест)" },
});
ok("публикация с предложенной новой категорией — 200, pending", r.status === 200 && r.body.moderationStatus === "pending", JSON.stringify(r.body));

ir = await internalCall(ADMIN_KEY, "/internal/categories");
const newPendingCategory = (await ir.json()).categories.find(c => c.name === "Экспериментальная (тест)");
ok("новая категория из публикации создана как pending", newPendingCategory && newPendingCategory.status === "pending", JSON.stringify(newPendingCategory));

ir = await fetch(PUZZLE + "/api/categories");
ok("новая pending категория ещё не видна в публичном списке", !(await ir.json()).some(c => c.id === newPendingCategory.id));

r = await asJson(tokenA, `/puzzles?roomId=${catPublishRoomId}`);
const catPublishRow = r.body.find(x => x.id === catPublishId);
ok("категория пазла — сразу новая (ещё pending), не системная «Пользовательские»",
  catPublishRow && catPublishRow.categoryId === newPendingCategory.id,
  JSON.stringify(catPublishRow && catPublishRow.categoryId));

ir = await internalCall(ADMIN_KEY, `/internal/moderation/photos/${catPublishId}/approve`, { method: "POST" });
ok("Admin одобрил фото с категориями — 200", ir.status === 200, String(ir.status));

ir = await fetch(PUZZLE + "/api/puzzles");
const approvedCatRow = (await ir.json()).find(x => x.id === catPublishId);
ok("после approve: ownerUserId обнулён, но uploaderUsername ОСТАЛСЯ — ключевая проверка всего дизайна атрибуции",
  approvedCatRow && approvedCatRow.ownerUserId === null && approvedCatRow.uploaderUsername === "danil" && approvedCatRow.uploaderUserId === userIdA,
  JSON.stringify(approvedCatRow));

ir = await fetch(PUZZLE + `/api/users/${userIdA}/puzzles`);
const profileData = await ir.json();
ok("профиль danil показывает username и опубликованный пазл",
  ir.status === 200 && profileData.username === "danil" && profileData.puzzles.some(x => x.id === catPublishId),
  JSON.stringify({ username: profileData.username, count: profileData.puzzles.length }));

ir = await fetch(PUZZLE + `/api/users/${userIdB}/puzzles`);
const emptyProfileData = await ir.json();
ok("профиль без публикаций — 200 с пустым списком, а не 404",
  ir.status === 200 && emptyProfileData.username === null && Array.isArray(emptyProfileData.puzzles) && emptyProfileData.puzzles.length === 0,
  JSON.stringify(emptyProfileData));

ir = await internalCall(ADMIN_KEY, `/internal/moderation/categories/${newPendingCategory.id}/approve`, { method: "POST" });
ok("Admin одобрил новую категорию — 200", ir.status === 200, String(ir.status));

ir = await fetch(PUZZLE + "/api/categories");
ok("одобренная категория теперь в публичном списке", (await ir.json()).some(c => c.id === newPendingCategory.id));

// Отклонение категории — вторая заявка, никогда не появляется в публичном списке.
ur = await callRaw(tokenA, `/puzzles?roomId=${catPublishRoomId}&w=300&h=400&consent=1&title=${encodeURIComponent("Фото с отклонённой категорией")}`, fakePng, "image/png");
const uploadForRejectCat = await ur.json();
const rejectCatPuzzleId = uploadForRejectCat.variants[0].id;
r = await asJson(tokenA, `/puzzles/${rejectCatPuzzleId}/publish`, { method: "POST", body: { consent: true, newCategoryName: "Отклоняемая (тест)" } });
ok("публикация с заявкой на категорию, которую потом отклонят — 200", r.status === 200, JSON.stringify(r.body));

ir = await internalCall(ADMIN_KEY, "/internal/categories");
const rejectCategory = (await ir.json()).categories.find(c => c.name === "Отклоняемая (тест)");
ok("категория на отклонение создана как pending", rejectCategory && rejectCategory.status === "pending", JSON.stringify(rejectCategory));

ir = await internalCall(ADMIN_KEY, `/internal/moderation/categories/${rejectCategory.id}/reject`, { method: "POST", body: { reason: "дубликат" } });
ok("Admin отклонил категорию — 200", ir.status === 200, String(ir.status));

ir = await internalCall(ADMIN_KEY, "/internal/moderation/categories");
ok("отклонённая категория пропала из очереди на модерацию", !(await ir.json()).categories.some(c => c.id === rejectCategory.id));

ir = await fetch(PUZZLE + "/api/categories");
ok("отклонённая категория никогда не появится в публичном списке", !(await ir.json()).some(c => c.id === rejectCategory.id));

// уборка
ir = await internalCall(ADMIN_KEY, `/internal/moderation/photos/${catPublishId}`, { method: "DELETE" });
ok("уборка: пазл с категориями удалён", ir.status === 200, String(ir.status));
ir = await internalCall(ADMIN_KEY, `/internal/categories/${categoryA.id}`, { method: "DELETE" });
ok("уборка: категория A удалена", ir.status === 200, String(ir.status));
ir = await internalCall(ADMIN_KEY, `/internal/categories/${newPendingCategory.id}`, { method: "DELETE" });
ok("уборка: одобренная новая категория удалена", ir.status === 200, String(ir.status));

// ───────── разделение модерации: загрузка в комнату vs публикация + письма
// (см. план «Разделение модерации: загрузка в комнату vs публикация +
// письма») ─────────
r = await asJson(tokenA, "/rooms", { method: "POST", body: { title: "Комната для фоновой модерации" } });
const reviewRoomId = r.body.id;

ur = await callRaw(tokenA, `/puzzles?roomId=${reviewRoomId}&w=300&h=400&consent=1&title=${encodeURIComponent("Фото на фоновую проверку")}`, fakePng, "image/png");
const uploadForReview = await ur.json();
const reviewPuzzleId = uploadForReview.variants[0].id;

ir = await internalCall("wrong-key", "/internal/moderation/room-uploads");
ok("GET /internal/moderation/room-uploads без ключа — 403", ir.status === 403, String(ir.status));

ir = await internalCall(ADMIN_KEY, "/internal/moderation/room-uploads");
const roomQueueAfterUpload = await ir.json();
ok("свежая загрузка в комнату сразу попадает в очередь фоновой модерации",
  roomQueueAfterUpload.photos.some(x => x.id === reviewPuzzleId), JSON.stringify(roomQueueAfterUpload.photos.map(x => x.id)));

ir = await internalCall(ADMIN_KEY, "/internal/moderation/photos");
const publishQueueBeforePublish = await ir.json();
ok("КЛЮЧЕВАЯ ПРОВЕРКА разделения: фото, которое никогда не публиковалось, НЕ видно в очереди заявок на публикацию",
  !publishQueueBeforePublish.photos.some(x => x.id === reviewPuzzleId), JSON.stringify(publishQueueBeforePublish.photos.map(x => x.id)));

r = await asJson(tokenA, `/puzzles?roomId=${reviewRoomId}`);
ok("фото уже доступно в комнате МГНОВЕННО, не дожидаясь фоновой модерации",
  r.body.some(x => x.id === reviewPuzzleId), JSON.stringify(r.body.map(x => x.id)));

ir = await internalCall(ADMIN_KEY, `/internal/moderation/room-uploads/${reviewPuzzleId}/approve`, { method: "POST" });
ok("Admin одобрил загрузку в комнату — 200", ir.status === 200, String(ir.status));

ir = await internalCall(ADMIN_KEY, "/internal/moderation/room-uploads");
ok("одобренная загрузка пропала из очереди фоновой модерации", !(await ir.json()).photos.some(x => x.id === reviewPuzzleId));

r = await asJson(tokenA, `/puzzles?roomId=${reviewRoomId}`);
ok("после одобрения фото по-прежнему в комнате (одобрение ничего не меняет для пользователя)",
  r.body.some(x => x.id === reviewPuzzleId));

// Отклонение — вторая загрузка, фоновая модерация находит нарушение и форс-удаляет.
ur = await callRaw(tokenA, `/puzzles?roomId=${reviewRoomId}&w=300&h=400&consent=1&title=${encodeURIComponent("Фото, которое отклонят")}`, fakePng, "image/png");
const uploadToReject = await ur.json();
const rejectReviewPuzzleId = uploadToReject.variants[0].id;

ir = await internalCall(ADMIN_KEY, `/internal/moderation/room-uploads/${rejectReviewPuzzleId}/reject`, {
  method: "POST", body: { reason: "нарушает правила загрузки" },
});
ok("Admin отклонил загрузку в комнату — 200", ir.status === 200, String(ir.status));

r = await asJson(tokenA, `/puzzles?roomId=${reviewRoomId}`);
ok("отклонённое фото форс-удалено — пропало из комнаты (в отличие от отклонения ПУБЛИКАЦИИ, тут не остаётся приватным)",
  !r.body.some(x => x.id === rejectReviewPuzzleId), JSON.stringify(r.body.map(x => x.id)));

ir = await internalCall(ADMIN_KEY, "/internal/moderation/room-uploads");
ok("отклонённая загрузка пропала из очереди", !(await ir.json()).photos.some(x => x.id === rejectReviewPuzzleId));

// ───────── письма о результате публикации ─────────
// Отдельный пользователь С почтой — danil/sputnik заведены без неё
// (authCli adduser без третьего аргумента), а без puzzle.uploader_email
// notifyPublishOutcome молча не отправляет письмо вовсе (см. server.js) —
// для проверки самой отправки нужен аккаунт, где есть что положить в это
// поле при self-upload.
authCli("adduser", "mailtest", "ПочтаДляТеста-2026", "mailtest@example.com");
const tokenMail = await login("mailtest", "ПочтаДляТеста-2026");
r = await asJson(tokenMail, "/rooms", { method: "POST", body: { title: "Комната для проверки писем" } });
const mailRoomId = r.body.id;

ur = await callRaw(tokenMail, `/puzzles?roomId=${mailRoomId}&w=300&h=400&consent=1&title=${encodeURIComponent("Фото для письма-одобрения")}`, fakePng, "image/png");
const uploadForMailApprove = await ur.json();
const mailApproveId = uploadForMailApprove.variants[0].id;
await asJson(tokenMail, `/puzzles/${mailApproveId}/publish`, { method: "POST", body: { consent: true } });
ir = await internalCall(ADMIN_KEY, `/internal/moderation/photos/${mailApproveId}/approve`, { method: "POST" });
ok("Admin одобрил публикацию (для проверки письма) — 200", ir.status === 200, String(ir.status));
ok("письмо-одобрение залогировано мейлером (нет RESEND_API_KEY в тестовом окружении — лог вместо отправки)",
  await waitForLog("puzzle", "опубликовано в библиотеке"), "тема письма-одобрения не найдена в логе puzzle");
ok("письмо ушло именно на mailtest@example.com", await waitForLog("puzzle", "mailtest@example.com"), "");

ur = await callRaw(tokenMail, `/puzzles?roomId=${mailRoomId}&w=300&h=400&consent=1&title=${encodeURIComponent("Фото для письма-отказа")}`, fakePng, "image/png");
const uploadForMailReject = await ur.json();
const mailRejectId = uploadForMailReject.variants[0].id;
await asJson(tokenMail, `/puzzles/${mailRejectId}/publish`, { method: "POST", body: { consent: true } });
ir = await internalCall(ADMIN_KEY, `/internal/moderation/photos/${mailRejectId}/reject`, { method: "POST", body: { reason: "тестовая причина отказа" } });
ok("Admin отклонил публикацию (для проверки письма) — 200", ir.status === 200, String(ir.status));
ok("письмо-отказ залогировано мейлером", await waitForLog("puzzle", `«Фото для письма-отказа» отклонено`), "тема письма-отказа не найдена в логе puzzle");

// ───────── прогресс: bulk-список для «Продолжить сборку» над библиотекой
// (см. план «Продолжить сборку») ─────────
r = await asJson(tokenA, "/puzzles/progress");
ok("bulk-прогресс пуст, пока danil ничего не собирал", r.status === 200 && Array.isArray(r.body) && r.body.length === 0, JSON.stringify(r.body));

const progressNoAuth = await fetch(PUZZLE + "/api/puzzles/progress");
ok("bulk-прогресс без входа — 401", progressNoAuth.status === 401, String(progressNoAuth.status));

r = await asJson(tokenA, "/puzzles");
const hillsPuzzle = r.body.find(p => p.id === "hills");
const { gridRows: hillsRows, gridCols: hillsCols } = hillsPuzzle;

// Полная раскладка деталей — все врозь (далеко друг от друга по x/y, без
// случайных совпадений), КРОМЕ (0,0)-(0,1): расставлены вплотную по X
// (разница ровно CELL=100, см. server.js) — та же механика стыковки, что
// уже проверена в test/unit-clusters.mjs (stitchGroup), тут только чтобы
// piecesPlaced получился не нулевым.
function fullPiecesWithOnePair(rows, cols) {
  const arr = [];
  let n = 1;
  for (let rr = 0; rr < rows; rr++) for (let cc = 0; cc < cols; cc++) { arr.push({ r: rr, c: cc, x: n * 10000, y: n * 10000 }); n++; }
  const a = arr.find(p => p.r === 0 && p.c === 0), b = arr.find(p => p.r === 0 && p.c === 1);
  a.x = 0; a.y = 0; b.x = 100; b.y = 0;
  return arr;
}

r = await asJson(tokenA, `/puzzles/${hillsPuzzle.id}/progress`, {
  method: "PUT", body: { pieces: fullPiecesWithOnePair(hillsRows, hillsCols) },
});
ok("PUT прогресса hills — 2 состыкованные детали посчитаны", r.status === 200 && r.body.piecesPlaced === 2, JSON.stringify(r.body));

r = await asJson(tokenA, "/puzzles/progress");
ok("bulk-прогресс теперь содержит hills с 2/N деталей",
  r.status === 200 && r.body.some(x => x.puzzleId === hillsPuzzle.id && x.piecesPlaced === 2 && x.piecesTotal === hillsRows * hillsCols),
  JSON.stringify(r.body));

r = await asJson(tokenB, "/puzzles/progress");
ok("bulk-прогресс — только свой, у sputnik пусто (danil его не трогал)", r.status === 200 && r.body.length === 0, JSON.stringify(r.body));

r = await asJson(tokenA, `/puzzles/${hillsPuzzle.id}/progress`, { method: "DELETE" });
ok("DELETE прогресса hills — 200", r.status === 200 && r.body.ok === true, JSON.stringify(r.body));

r = await asJson(tokenA, "/puzzles/progress");
ok("после DELETE hills пропал из bulk-списка", r.status === 200 && !r.body.some(x => x.puzzleId === hillsPuzzle.id), JSON.stringify(r.body));

// ───────── оценка пазла на окне победы (см. план «Оценка пазла на окне
// победы») — 5-балльная шкала, upsert, доступна и без входа ─────────
r = await asJson(tokenA, `/puzzles/${hillsPuzzle.id}/rating`);
ok("рейтинга ещё нет — average/count/mine пусты", r.status === 200 && r.body.average === null && r.body.count === 0 && r.body.mine === null, JSON.stringify(r.body));

r = await asJson(tokenA, `/puzzles/${hillsPuzzle.id}/rating`, { method: "PUT", body: { rating: 0 } });
ok("оценка 0 — вне диапазона, отбита 400", r.status === 400, String(r.status));
r = await asJson(tokenA, `/puzzles/${hillsPuzzle.id}/rating`, { method: "PUT", body: { rating: 6 } });
ok("оценка 6 — вне диапазона, отбита 400", r.status === 400, String(r.status));

r = await asJson(tokenA, `/puzzles/${hillsPuzzle.id}/rating`, { method: "PUT", body: { rating: 4 } });
ok("danil поставил 4 — 200", r.status === 200 && r.body.ok === true && r.body.count === 1, JSON.stringify(r.body));

r = await asJson(tokenA, `/puzzles/${hillsPuzzle.id}/rating`);
ok("danil видит свою оценку — mine===4", r.status === 200 && r.body.mine === 4 && r.body.average === 4, JSON.stringify(r.body));

r = await asJson(tokenA, `/puzzles/${hillsPuzzle.id}/rating`, { method: "PUT", body: { rating: 2 } });
ok("повторная оценка тем же человеком — заменяет прежнюю (upsert), count не растёт", r.status === 200 && r.body.count === 1 && r.body.average === 2, JSON.stringify(r.body));

r = await asJson(tokenB, `/puzzles/${hillsPuzzle.id}/rating`, { method: "PUT", body: { rating: 5 } });
ok("sputnik поставил 5 — второй голос, count===2, average===(2+5)/2", r.status === 200 && r.body.count === 2 && r.body.average === 3.5, JSON.stringify(r.body));

r = await asJson(tokenB, `/puzzles/${hillsPuzzle.id}/rating`);
ok("sputnik видит именно СВОЮ оценку (5), не чужую", r.status === 200 && r.body.mine === 5, JSON.stringify(r.body));

// Другой уровень сложности ТОГО ЖЕ пазла (общий image_file с hillsPuzzle,
// см. план — оценка на группу, не на конкретный вариант) — должен видеть
// тот же средний рейтинг.
ar = await anonCall(anonCookie, `/puzzles/hills-48/rating`);
ok("другой уровень сложности того же пазла (hills-48) — общий рейтинг, не свой", ar.status === 200 && (await ar.json()).count === 2, "");

ar = await anonCall(anonCookie, `/puzzles/hills-48/rating`, { method: "PUT", body: { rating: 3 } });
ok("аноним тоже может оценить (без входа) — count===3", ar.status === 200 && (await ar.json()).count === 3, "");
ar = await anonCall(anonCookie, `/puzzles/hills-48/rating`);
ok("аноним видит свою оценку по своей cookie", ar.status === 200 && (await ar.json()).mine === 3, "");

r = await asJson(tokenA, `/puzzles/no-such-puzzle/rating`);
ok("несуществующий пазл — 404", r.status === 404, String(r.status));

for (const p of procs) p.kill();
process.exit(failures ? 1 : 0);
