"use strict";
/**
 * HTML/текст писем о результате ПУБЛИКАЦИИ (см. план «Разделение
 * модерации: загрузка в комнату vs публикация + письма»). Копия каркаса
 * Auth/lib/emailTemplates.js — та же табличная разметка (почтовые клиенты
 * не браузеры, Outlook не понимает flex/grid, инлайн-стили — многие
 * клиенты вырезают <style>), только полоска сверху в цвет Puzzle
 * (--flame-base: #3f6212, см. assets/styles.css), не общий оранжевый Auth.
 * Тёмной темы у писем сознательно нет — см. обоснование в оригинале.
 */

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Общий каркас — карточка с полосой пламени, вордмарком, заголовком, кнопкой
 *  и сноской. Конкретные письма только подставляют текст и ссылку. */
function shell({ preheader, heading, intro, buttonLabel, link, footNote }) {
  const safeLink = escapeHtml(link);
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#fff6ec;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff6ec;">
<tr><td align="center" style="padding:32px 16px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:20px;border:1px solid #ece5d8;">
<tr><td style="height:4px;line-height:4px;font-size:0;background:#3f6212;border-radius:20px 20px 0 0;">&nbsp;</td></tr>
<tr><td style="padding:32px 36px 4px;">
  <div style="font-size:16px;font-weight:700;letter-spacing:-.01em;color:#1c1b20;">Что собираем? — BurningHouse</div>
</td></tr>
<tr><td style="padding:22px 36px 0;">
  <h1 style="margin:0;font-size:22px;line-height:1.3;font-weight:600;color:#1c1b20;">${escapeHtml(heading)}</h1>
  <p style="margin:12px 0 0;font-size:15px;line-height:1.6;color:#46464f;">${intro}</p>
</td></tr>
<tr><td style="padding:28px 36px 4px;">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="border-radius:9999px;background:#3f6212;">
      <a href="${safeLink}" style="display:inline-block;padding:14px 34px;font-size:15px;font-weight:600;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#ffffff;text-decoration:none;border-radius:9999px;">${escapeHtml(buttonLabel)}</a>
    </td>
  </tr></table>
</td></tr>
<tr><td style="padding:18px 36px 0;">
  <p style="margin:0;font-size:13px;line-height:1.5;color:#918f9a;">
    Если кнопка не открывается, скопируйте ссылку целиком:<br>
    <a href="${safeLink}" style="color:#3f6212;word-break:break-all;">${safeLink}</a>
  </p>
</td></tr>
<tr><td style="padding:28px 36px 32px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid #ece5d8;padding-top:18px;">
    <p style="margin:0;font-size:13px;line-height:1.5;color:#918f9a;">${escapeHtml(footNote)}</p>
  </td></tr></table>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function publishApproved({ title, link }) {
  const html = shell({
    preheader: `«${title}» теперь доступно всем в общей библиотеке.`,
    heading: "Фото одобрено и опубликовано",
    intro: `Ваше фото «${escapeHtml(title)}» прошло модерацию и теперь доступно всем в общей библиотеке «Что собираем?» — без входа, как встроенные пазлы.`,
    buttonLabel: "Открыть библиотеку",
    link,
    footNote: "Это письмо отправлено, потому что вы отправляли это фото на публикацию в «Что собираем?».",
  });

  const text = `Фото одобрено и опубликовано — Что собираем?

Ваше фото «${title}» прошло модерацию и теперь доступно всем в общей библиотеке — без входа, как встроенные пазлы.

${link}`;

  return { subject: `«${title}» опубликовано в библиотеке — Что собираем?`, html, text };
}

function publishRejected({ title, reason, link }) {
  const html = shell({
    preheader: `«${title}» отклонено при модерации.`,
    heading: "Публикация отклонена",
    intro: `Ваше фото «${escapeHtml(title)}» не прошло модерацию для публикации в общую библиотеку.${reason ? ` Причина: ${escapeHtml(reason)}.` : ""} Фото остаётся доступно в комнате, где было загружено — можно отправить на публикацию ещё раз.`,
    buttonLabel: "Открыть комнату",
    link,
    footNote: "Это письмо отправлено, потому что вы отправляли это фото на публикацию в «Что собираем?».",
  });

  const text = `Публикация отклонена — Что собираем?

Ваше фото «${title}» не прошло модерацию для публикации в общую библиотеку.${reason ? ` Причина: ${reason}.` : ""}
Фото остаётся доступно в комнате, где было загружено — можно отправить на публикацию ещё раз.

${link}`;

  return { subject: `«${title}» отклонено — Что собираем?`, html, text };
}

module.exports = { publishApproved, publishRejected };
