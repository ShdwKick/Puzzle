#!/usr/bin/env node
"use strict";
/**
 * Разовая (но безопасно повторно запускаемая) чистка названий пазлов,
 * импортированных с Pexels без короткого alt-текста — Admin в этом случае
 * подставляет длинную AI-подпись с фотостока целиком (см. правку «Короткие
 * названия пазлов»). Она видна не на самой странице пазла (там уже чистый
 * «Категория #N», см. puzzleDisplayTitle в assets/app.js), а в <title>
 * страницы/сниппете поиска — ровно то, что показал отчёт Яндекс.Метрики
 * «Заголовки страниц», с которого всё началось.
 *
 * Что делает:
 *   1. Тянет /api/puzzles с указанного сервера, группирует по картинке
 *      (imageUrl) — один пазл, одна группа вариантов сложности, у всех
 *      общий title.
 *   2. Отбирает группы с ДЛИННЫМ title (> 40 символов) — тот же признак,
 *      которым отличили 249 проблемных фото на живом сайте при разведке.
 *      Короткие, уже нормальные названия (включая те, что уже поправлены
 *      этим же скриптом при повторном запуске) сюда не попадают — скрипт
 *      идемпотентен сам по себе, отдельного стейта "уже сделано" не нужно.
 *   3. На каждую группу — gigachat.titleFromText(oldTitle, categoryName):
 *      дешевле и точнее, чем смотреть на саму фотографию (см. правку —
 *      старый текст с фотостока уже содержит место съёмки и т.п., а по
 *      одной картинке модель этого не знает и выдаёт общие названия).
 *   4. POST /internal/puzzles/:id/title с новыми title+titleEn — тот же
 *      эндпоинт, что и у ручного переименования в Admin, обновляет ВСЕ
 *      варианты сложности группы разом (WHERE image_file = ...).
 *
 * Запуск (пример на ~5 фото — сначала так, посмотреть на результат):
 *   NODE_EXTRA_CA_CERTS=/путь/russian_trusted_root_ca.pem \
 *   PUZZLE_BASE=https://puzzle.burninghouse.ru \
 *   ADMIN_INTERNAL_KEY=... GIGACHAT_AUTH_KEY=... \
 *   node scripts/rename-pexels-titles.mjs --dry-run --limit=5
 *
 * Без --dry-run — правда пишет в базу. Без --limit — все подходящие группы.
 * Между запросами есть пауза (см. DELAY_MS) — это не гонка, торопиться некуда.
 */

import createGigaChat from "../gigachat.js";

const PUZZLE_BASE = (process.env.PUZZLE_BASE || "").replace(/\/+$/, "");
const ADMIN_KEY = process.env.ADMIN_INTERNAL_KEY || "";
const DELAY_MS = 300;
const TITLE_LEN_THRESHOLD = 40;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitArg = args.find(a => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;

if (!PUZZLE_BASE) { console.error("Нужен PUZZLE_BASE (напр. https://puzzle.burninghouse.ru)"); process.exit(1); }
if (!ADMIN_KEY && !dryRun) { console.error("Нужен ADMIN_INTERNAL_KEY (без --dry-run он обязателен — им пишем title)"); process.exit(1); }

const gigachat = createGigaChat({
  authKey: process.env.GIGACHAT_AUTH_KEY,
  scope: process.env.GIGACHAT_SCOPE,
  model: process.env.GIGACHAT_MODEL,
});
if (!gigachat.enabled) { console.error("Нужен GIGACHAT_AUTH_KEY"); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const [puzzles, categories] = await Promise.all([
    fetch(PUZZLE_BASE + "/api/puzzles?limit=5000").then(r => r.json()),
    fetch(PUZZLE_BASE + "/api/categories").then(r => r.json()),
  ]);
  const catById = new Map(categories.map(c => [c.id, c.name]));

  const byImage = new Map(); // imageUrl -> { id, title, categoryId }
  for (const p of puzzles) {
    if (!byImage.has(p.imageUrl)) byImage.set(p.imageUrl, p);
  }
  const targets = [...byImage.values()].filter(p => p.title && p.title.length > TITLE_LEN_THRESHOLD).slice(0, limit);

  console.log(`Найдено групп с длинным названием: ${targets.length}${dryRun ? " (dry-run — в базу ничего не пишем)" : ""}`);

  let ok = 0, failed = 0;
  for (const [i, p] of targets.entries()) {
    const categoryName = p.categoryId ? catById.get(p.categoryId) || null : null;
    process.stdout.write(`[${i + 1}/${targets.length}] "${p.title}" → `);
    try {
      const { ru, en } = await gigachat.titleFromText(p.title, categoryName);
      console.log(`"${ru}" / "${en}"`);
      if (!dryRun) {
        const res = await fetch(`${PUZZLE_BASE}/internal/puzzles/${encodeURIComponent(p.id)}/title`, {
          method: "POST",
          headers: { "X-Admin-Key": ADMIN_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ title: ru, titleEn: en }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      ok++;
    } catch (e) {
      console.log(`ОШИБКА — ${e.message}`);
      failed++;
    }
    await sleep(DELAY_MS);
  }

  console.log(`\nГотово: ${ok} успешно, ${failed} с ошибкой из ${targets.length}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
