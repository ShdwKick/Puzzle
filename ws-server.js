"use strict";
/**
 * Голый RFC 6455 сервер поверх http.Server 'upgrade' — в экосистеме
 * BurningHouse нет ни одного npm-пакета, Node 22 своего серверного
 * WebSocket не даёт, поэтому handshake и framing написаны руками.
 *
 * Поддержаны только текстовые фреймы (opcode 0x1) БЕЗ фрагментации на
 * приём: браузерный WebSocket API сам не дробит короткие сообщения, а
 * протокол этого сервиса и так ограничен маленькими JSON-пакетами.
 */

const crypto = require("crypto");
const EventEmitter = require("events");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME = 64 * 1024;
const HEARTBEAT_MS = 25000;

function acceptKey(key) {
  return crypto.createHash("sha1").update(key + GUID).digest("base64");
}

function encodeFrame(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

/** null — данных не хватает (ждём). false — протокольная ошибка (рвать). иначе — фрейм. */
function tryParseFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset); offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    const hi = buf.readUInt32BE(offset), lo = buf.readUInt32BE(offset + 4);
    if (hi !== 0) return false;
    len = lo; offset += 8;
  }
  if (len > MAX_FRAME) return false;
  if (opcode >= 0x8 && len > 125) return false;
  if (!masked) return false; // клиент обязан маскировать (RFC 6455 §5.1)

  if (buf.length < offset + 4) return null;
  const maskKey = buf.subarray(offset, offset + 4);
  offset += 4;
  if (buf.length < offset + len) return null;

  const maskedPayload = buf.subarray(offset, offset + len);
  const payload = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) payload[i] = maskedPayload[i] ^ maskKey[i & 3];

  if (!fin) return false; // фрагментация не поддержана — см. шапку файла

  return { opcode, payload, consumed: offset + len };
}

function wrapSocket(socket, head) {
  const emitter = new EventEmitter();
  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let closed = false;
  let awaitingPong = false;

  const heartbeat = setInterval(() => {
    if (closed) return;
    if (awaitingPong) { destroy(); return; }
    awaitingPong = true;
    try { socket.write(encodeFrame(Buffer.alloc(0), 0x9)); } catch { destroy(); }
  }, HEARTBEAT_MS);

  function destroy() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try { socket.end(); } catch {}
    emitter.emit("close");
  }

  function protocolError() {
    try { socket.write(encodeFrame(Buffer.alloc(0), 0x8)); } catch {}
    destroy();
  }

  function handleFrame(frame) {
    if (frame.opcode === 0x8) {
      const payload = frame.payload.length >= 2 ? frame.payload.subarray(0, 2) : Buffer.alloc(0);
      try { socket.write(encodeFrame(payload, 0x8)); } catch {}
      destroy();
      return;
    }
    if (frame.opcode === 0x9) {
      try { socket.write(encodeFrame(frame.payload, 0xA)); } catch {}
      return;
    }
    if (frame.opcode === 0xA) { awaitingPong = false; return; }
    if (frame.opcode === 0x1) {
      let text;
      try { text = frame.payload.toString("utf8"); } catch { protocolError(); return; }
      emitter.emit("message", text);
      return;
    }
    protocolError(); // 0x2 binary, 0x0 continuation — не поддержаны
  }

  socket.on("data", chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const frame = tryParseFrame(buf);
      if (frame === null) break;
      if (frame === false) { protocolError(); return; }
      buf = buf.subarray(frame.consumed);
      handleFrame(frame);
    }
  });
  socket.on("error", destroy);
  socket.on("close", destroy);

  return {
    send(text) {
      if (closed) return;
      try { socket.write(encodeFrame(Buffer.from(String(text), "utf8"), 0x1)); }
      catch { destroy(); }
    },
    close() { if (closed) return; try { socket.write(encodeFrame(Buffer.alloc(0), 0x8)); } catch {} destroy(); },
    on: (ev, cb) => emitter.on(ev, cb),
  };
}

/**
 * Принимает HTTP Upgrade. Возвращает null, если хэндшейк кривой (сама
 * ответила 400 и закрыла сокет) — вызывающий код просто возвращается.
 */
function acceptUpgrade(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  const upgradeHeader = (req.headers.upgrade || "").toLowerCase();
  if (upgradeHeader !== "websocket" || !key || (req.headers["sec-websocket-version"] || "") !== "13") {
    try { socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); } catch {}
    socket.destroy();
    return null;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  );
  socket.setNoDelay(true);
  return wrapSocket(socket, head);
}

module.exports = { acceptUpgrade };
