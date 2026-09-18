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

/** Возвращает {ok:true} либо {ok:false, reason, detail}. reason —
 *  машиночитаемая причина отказа, чтобы вызывающая сторона могла написать в
 *  ЖУРНАЛ (adminLog, вкладка «Логи» в Admin) не общее «письмо не ушло», а
 *  конкретное: нет ключа / Resend ответил ошибкой / сеть. Раньше все три
 *  сливались в один {ok:false} и различались только по stdout контейнера,
 *  куда админ не ходит — на этом и застряло разбирательство «уведомление в
 *  аккаунте есть, письма нет». Никогда не бросает. */
async function send({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY || "";
  const from = process.env.MAIL_FROM || "BurningHouse <noreply@burninghouse.ru>";
  if (!apiKey) {
    console.log(`[mailer] RESEND_API_KEY не задан — письмо не отправлено. Кому: ${to}, тема: «${subject}»\n${text || ""}`);
    return { ok: false, reason: "no_api_key" };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[mailer] Resend ответил ${res.status}: ${body}`);
      // detail обрезаем: в журнал уходит ответ чужого сервиса, целиком он
      // там не нужен, а первой строки хватает, чтобы понять (частый случай —
      // домен в MAIL_FROM не подтверждён в Resend).
      return { ok: false, reason: "http", status: res.status, detail: body.slice(0, 200) };
    }
    return { ok: true };
  } catch (e) {
    console.error("[mailer] Не удалось отправить письмо:", e.message);
    return { ok: false, reason: "network", detail: e.message };
  }
}

module.exports = { send };
