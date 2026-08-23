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
const PUZZLE_PORT = parseInt(process.env.PUZZLE_PORT || "8792", 10);
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

r = await asJson(tokenA, `/rooms/${roomId}/sessions`, { method: "POST", body: { puzzleId: "hills" } });
ok("повторный старт отбит 409", r.status === 409, JSON.stringify(r.body));

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

const pieces = [];
for (let rr = 0; rr < 4; rr++) for (let cc = 0; cc < 3; cc++) pieces.push({ r: rr, c: cc, x: 0, y: 0, placed: false });
const bSyncPromise = waitMessage(wsB, m => m.type === "sync" && m.pieces);
wsA.send(JSON.stringify({ type: "init", pieces }));
const bSync = await bSyncPromise;
ok("B получил каноническую раскладку от A", Array.isArray(bSync.pieces) && bSync.pieces.length === piecesTotal);

let echoOnA = false;
wsA.addEventListener("message", function guard(e) { if (JSON.parse(e.data).type === "move") echoOnA = true; });
const moveOnB = waitMessage(wsB, m => m.type === "move" && m.r === 0 && m.c === 0);
wsA.send(JSON.stringify({ type: "move", r: 0, c: 0, x: 123, y: 45 }));
const move = await moveOnB;
ok("B увидел движение детали", move.x === 123 && move.y === 45);
await sleep(200);
ok("A не получил эхо своего же move", !echoOnA);

let lastPlace;
for (const p of pieces) {
  const placePromise = waitMessage(wsB, m => m.type === "place" && m.r === p.r && m.c === p.c);
  wsA.send(JSON.stringify({ type: "place", r: p.r, c: p.c, x: 1, y: 1 }));
  lastPlace = await placePromise;
}
ok("последняя деталь помечена completed", lastPlace.completed === true && lastPlace.piecesPlaced === piecesTotal);

await sleep(300);
r = await asJson(tokenA, `/rooms/${roomId}/sessions/${sessionId}`);
ok("сеанс сохранён завершённым в БД", r.status === 200 && !!r.body.completedAt, JSON.stringify(r.body));

wsA.close(); wsB.close();
for (const p of procs) p.kill();
process.exit(failures ? 1 : 0);
