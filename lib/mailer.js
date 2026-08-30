"use strict";
/**
 * Отправка почты через Resend (https://resend.com/docs/api-reference/emails/send-email).
 * Копия Auth/lib/mailer.js (см. план «Разделение модерации: загрузка в
 * комнату vs публикация + письма») — тот же HTTP API, без npm-зависимостей,
 * та же конвенция репозитория «копировать маленькую утилиту на сервис»,
 * что уже применялась к getOrCreateDeviceId. Puzzle не заводит отдельный
 * lib/config.js ради одного модуля — читает env напрямую, в отличие от
 * Auth.
 *
 * Без RESEND_API_KEY письма просто не уходят (и это пишется в консоль вместо
 * ошибки) — иначе локальная разработка/тесты без живого аккаунта Resend
 * были бы невозможны.
 */

async function send({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY || "";
  const from = process.env.MAIL_FROM || "BurningHouse <noreply@burninghouse.ru>";
  if (!apiKey) {
    console.log(`[mailer] RESEND_API_KEY не задан — письмо не отправлено. Кому: ${to}, тема: «${subject}»\n${text || ""}`);
    return { ok: false };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html, text }),
    });
    if (!res.ok) {
      console.error(`[mailer] Resend ответил ${res.status}: ${await res.text().catch(() => "")}`);
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.error("[mailer] Не удалось отправить письмо:", e.message);
    return { ok: false };
  }
}

module.exports = { send };
