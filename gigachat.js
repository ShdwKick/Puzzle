"use strict";
/**
 * Короткие названия пазлов через GigaChat (см. правку «Короткие названия
 * пазлов») — та же механика (OAuth, загрузка файла, chat/completions), что
 * у Trip/gigachat.js для чеков, только свой промпт и без специфичной для
 * чеков арифметики сверки. Не вынесено в Shared — там лежит то, что
 * ОДИНАКОВО у сервисов (см. Shared/README.md), а тут другой промпт и
 * другая пара методов; при этом низкоуровневая часть (токен, загрузка
 * файла, сам запрос) продублирована почти дословно — так и должно быть
 * согласно тому же README (по одной копии на сервис, не тянуть по сети).
 *
 *   const giga = require("./gigachat")({ authKey, scope, model });
 *   const { ru, en } = await giga.titleFromText(oldTitle, categoryName);
 *   const { ru, en } = await giga.titleFromImage(buffer, "image/jpeg");
 *
 * Дешевле и точнее оказался текстовый путь (см. правку) — по фото модель не
 * знает места съёмки и придумывает общее «Mountain landscape» вместо
 * «Kyrgyz Mountain Range», да и картинка — это лишних ~2000 токенов на
 * запрос против ~150 у текста. titleFromImage — фолбэк на случай, когда
 * старого текста для пересказа вообще нет (свежий импорт с Pexels без alt).
 *
 * Ключ живёт только в окружении сервера, в браузер не попадает никогда —
 * ходит в GigaChat сам сервис.
 */

const crypto = require("crypto");

const OAUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const API_BASE = "https://gigachat.devices.sberbank.ru/api/v1";

const TEXT_PROMPT = (oldTitle, category) => `Сейчас у пазла в каталоге вот такое старое название (это подпись с фотостока, длинная и по-английски): "${oldTitle}"
Категория пазла: "${category || "не указана"}"
Придумай по смыслу этого текста короткое новое название — на русском и на английском.
Верни СТРОГО JSON без пояснений, без markdown: {"ru":"","en":""}
Правила: 2-4 слова каждое, как подпись к картинке в каталоге (например "Рыжий кот на подоконнике", "Горы на закате"). Английское — с большой буквы у каждого слова (Title Case). Без кавычек внутри строк, без точки в конце, без слов вроде "пазл"/"puzzle".`;

const VISION_PROMPT = `Придумай короткое название для пазла по этой фотографии — на русском и на английском.
Верни СТРОГО JSON без пояснений, без markdown: {"ru":"","en":""}
Правила: 2-4 слова каждое, как подпись к картинке в каталоге (например "Рыжий кот на подоконнике", "Горы на закате"). Английское — с большой буквы у каждого слова (Title Case). Без кавычек внутри строк, без точки в конце, без слов вроде "пазл"/"puzzle".`;

module.exports = function createGigaChat(options = {}) {
  const authKey = options.authKey || "";
  const scope = options.scope || "GIGACHAT_API_PERS";
  const model = options.model || "GigaChat-2-Pro";
  const timeout = options.timeout || 30000;

  // Сертификат Минцифры — переменной окружения NODE_EXTRA_CA_CERTS, Node сам
  // подхватывает её при старте (см. Trip/README.md, «Расход и сертификат»).
  // Своего TLS-агента не заводим — тот же приём, что у Trip.
  const enabled = !!authKey;
  let token = null, tokenExpires = 0;

  async function call(url, init = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      return await fetch(url, { ...init, signal: ac.signal });
    } catch (e) {
      const cause = e?.cause;
      const detail = [cause?.code, cause?.message].filter(Boolean).join(": ");
      const hint = cause?.code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
          || cause?.code === "SELF_SIGNED_CERT_IN_CHAIN"
          || /unable to (get|verify)/i.test(cause?.message || "")
        ? " Похоже, не подключён корневой сертификат Минцифры — проверьте NODE_EXTRA_CA_CERTS."
        : "";
      throw new Error(`GigaChat: ${new URL(url).host} недоступен (${detail || e.message}).${hint}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function accessToken() {
    if (token && Date.now() < tokenExpires - 60000) return token;
    const res = await call(OAUTH_URL, {
      method: "POST",
      headers: {
        Authorization: "Basic " + authKey,
        RqUID: crypto.randomUUID(),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "scope=" + encodeURIComponent(scope),
    });
    if (!res.ok) throw new Error(`GigaChat: не выдал токен (${res.status})`);
    const data = await res.json();
    token = data.access_token;
    tokenExpires = data.expires_at || (Date.now() + 25 * 60000);
    return token;
  }

  async function uploadImage(buffer, mime) {
    const boundary = "----puzzle" + crypto.randomBytes(12).toString("hex");
    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\ngeneral\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.${ext}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`, "utf8");
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const res = await call(API_BASE + "/files", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + await accessToken(),
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: Buffer.concat([head, buffer, tail]),
    });
    if (!res.ok) throw new Error(`GigaChat: не принял файл (${res.status})`);
    const data = await res.json();
    if (!data.id) throw new Error("GigaChat: ответ без идентификатора файла");
    return data.id;
  }

  function extractJson(text) {
    const raw = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    try { return JSON.parse(raw); } catch { /* попробуем найти объект внутри */ }
    const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("GigaChat: ответ не похож на JSON");
    return JSON.parse(raw.slice(start, end + 1));
  }

  async function ask(messages) {
    const res = await call(API_BASE + "/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + await accessToken(), "Content-Type": "application/json" },
      body: JSON.stringify({ model, temperature: 0, messages }),
    });
    if (!res.ok) throw new Error(`GigaChat: отказал (${res.status})`);
    const data = await res.json();
    return { text: data.choices?.[0]?.message?.content || "", usage: data.usage || null };
  }

  /** Название по СТАРОМУ тексту (обычно — alt с Pexels) — дешёвый и более
   *  точный путь, см. шапку файла. */
  async function titleFromText(oldTitle, category) {
    if (!enabled) throw new Error("GigaChat не настроен");
    const { text } = await ask([{ role: "user", content: TEXT_PROMPT(oldTitle, category) }]);
    return normalizeTitle(extractJson(text));
  }

  /** Название по самой фотографии — только когда текста для пересказа нет
   *  вообще (свежий импорт с Pexels без alt). */
  async function titleFromImage(buffer, mime) {
    if (!enabled) throw new Error("GigaChat не настроен");
    const fileId = await uploadImage(buffer, mime);
    const { text } = await ask([{ role: "user", content: VISION_PROMPT, attachments: [fileId] }]);
    return normalizeTitle(extractJson(text));
  }

  return { enabled, titleFromText, titleFromImage };
};

/** ru/en — обязательные непустые строки, до 80 символов (лимит title у
 *  Puzzle, см. str() в server.js) — модель иногда может вернуть не совсем
 *  то, что просили, лучше упасть тут явной ошибкой, чем записать мусор. */
function normalizeTitle(parsed) {
  const ru = String(parsed?.ru || "").trim().slice(0, 80);
  const en = String(parsed?.en || "").trim().slice(0, 80);
  if (!ru || !en) throw new Error("GigaChat: пустой ru или en в ответе");
  return { ru, en };
}
