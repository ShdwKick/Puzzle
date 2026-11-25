#!/usr/bin/env node
"use strict";
/**
 * Прогрев миниатюр для уже загруженных обложек (см. lib/thumbs.js и правку
 * «Миниатюры картинок»).
 *
 * Сервис умеет делать миниатюру лениво, на первый запрос — то есть без
 * этого скрипта всё тоже заработает само. Но тогда первое пережатие каждой
 * из ~480 обложек попадёт в ответ живому посетителю или краулеру, причём
 * залпом: Яндекс обходит страницы категорий подряд, и на каждой по два
 * десятка картинок, которых ещё нет. Разумнее прогреть один раз руками
 * сразу после деплоя.
 *
 * Запуск в проде (образ уже содержит и vips, и этот файл):
 *
 *     docker compose exec puzzle node scripts/backfill-thumbs.mjs
 *
 * Локально — из каталога сервиса, DATA_DIR по умолчанию ./data:
 *
 *     node scripts/backfill-thumbs.mjs
 *     DATA_DIR=/path/to/data node scripts/backfill-thumbs.mjs --force
 *
 * Идемпотентен: уже готовые миниатюры пропускает (ensure сам возвращает
 * существующий файл, не пережимая заново). --force удаляет имеющиеся и
 * делает заново — нужно, если поменялись размеры или качество; в обычной
 * жизни не нужно.
 *
 * Базу не трогает вовсе — идём по файлам в каталоге оригиналов, а не по
 * строкам puzzles. Так скрипт не зависит ни от схемы, ни от того, занята
 * ли БД, и попутно прогревает картинки, на которые строки уже нет (пазл
 * удалён, файл остался) — лишняя работа на единицы файлов, зато ни одного
 * SQL-запроса и ни одной возможности что-то испортить.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// lib/thumbs.js — CommonJS (как и весь server.js), этот скрипт — ESM, как
// остальные в scripts/. createRequire — штатный мост между ними, иначе
// пришлось бы либо дублировать логику пережатия, либо переводить модуль на
// ESM и ломать require в server.js.
const require = createRequire(import.meta.url);
const thumbs = require("../lib/thumbs.js");

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const PHOTO_DIR = path.join(DATA_DIR, "puzzle-photos");
const THUMB_DIR = path.join(DATA_DIR, "puzzle-thumbs");
const force = process.argv.includes("--force");

if (!thumbs.available()) {
  console.error("Нечем пережимать: не найдены ни vips, ни magick, ни sips.");
  console.error("В проде vips ставится в образ (apk add vips-tools, см. Dockerfile) — возможно, запущен старый образ.");
  process.exit(1);
}
if (!fs.existsSync(PHOTO_DIR)) {
  console.error(`Нет каталога с обложками: ${PHOTO_DIR}`);
  console.error("Проверьте DATA_DIR — в контейнере это /app/data, локально ./data.");
  process.exit(1);
}

console.log(`Пережимаем через ${thumbs.toolName()}; размеры: ${thumbs.SIZES.join(", ")}px`);
console.log(`Оригиналы: ${PHOTO_DIR}`);
console.log(`Миниатюры: ${THUMB_DIR}`);

// .svg (три стартовые картинки) миниатюр не получают — вектор на единицы
// килобайт, растр был бы и тяжелее, и хуже (см. thumbUrlFor в server.js).
const bases = [...new Set(fs.readdirSync(PHOTO_DIR)
  .filter(f => /\.(jpg|png|webp)$/i.test(f))
  .map(f => f.replace(/\.[^.]+$/, "")))].sort();

console.log(`Обложек найдено: ${bases.length}\n`);

let made = 0, skipped = 0, failed = 0, savedFrom = 0, savedTo = 0;
const t0 = Date.now();

for (const [i, base] of bases.entries()) {
  if (force) thumbs.remove(THUMB_DIR, base);
  const src = thumbs.sourceFor(PHOTO_DIR, base);
  const srcBytes = src ? fs.statSync(src).size : 0;
  for (const size of thumbs.SIZES) {
    const had = !force && thumbs.existing(THUMB_DIR, size, base);
    const file = thumbs.ensure(PHOTO_DIR, THUMB_DIR, size, base);
    if (!file) { failed++; continue; }
    if (had) { skipped++; continue; }
    made++;
    // Экономию считаем только по 400px — это тот размер, который реально
    // уходит в карточку сетки, и именно с ним сравнение «было/стало»
    // что-то значит. 800px — добавка для retina, её в экономию не пишем.
    if (size === 400) { savedFrom += srcBytes; savedTo += fs.statSync(file).size; }
  }
  // Прогресс каждые 50 — чтобы в проде было видно, что скрипт жив: на
  // пятистах обложках он идёт десятки секунд.
  if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${bases.length}…`);
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
const mb = b => (b / 1024 / 1024).toFixed(1);
console.log(`\nГотово за ${secs}с: сделано ${made}, уже было ${skipped}, не вышло ${failed}`);
if (savedFrom > 0) {
  const ratio = (savedFrom / Math.max(1, savedTo)).toFixed(1);
  console.log(`Карточки (400px): ${mb(savedFrom)} МБ оригиналов → ${mb(savedTo)} МБ миниатюр, в ${ratio} раза легче`);
}
if (failed > 0) {
  console.log("\nНе вышло — скорее всего битые или нечитаемые файлы; имена смотрите выше в строках [thumbs].");
  process.exit(1);
}
