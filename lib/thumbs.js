"use strict";
/**
 * Миниатюры обложек (см. правку «Миниатюры картинок»).
 *
 * Зачем: обложки в сетке библиотеки и в списках категорий отдавались в
 * исходном разрешении — 1880×1253 в слот 318×238 (.puzzle-card-thumb,
 * aspect-ratio 4/3). Главная тянула 3.5 МБ, страница категории — 3.9 МБ
 * на 21 картинку. Слот фиксированный, так что вёрстку это не ломало —
 * ломало скорость и, через неё, поведенческие: с телефона человек уходил
 * раньше, чем видел сетку.
 *
 * Почему внешней утилитой, а не в Node: декодировать и пережать JPEG
 * средствами стандартной библиотеки нечем, а npm-зависимость сломала бы
 * главное свойство сервиса — ни одной (ни package.json, ни node_modules,
 * см. Dockerfile). Системный бинарник этого свойства не трогает: это не
 * зависимость кода, а зависимость образа, одна строка `apk add`. В проде
 * это vips (vips-tools в alpine), локально на macOS — встроенный sips, и
 * ни там, ни там ставить ничего руками не нужно.
 *
 * Инструмент ищется один раз на старте. Если не нашёлся вообще (чужая
 * машина, урезанный образ) — модуль честно говорит об этом, а server.js
 * отдаёт по адресу миниатюры исходный файл: страница остаётся рабочей,
 * просто тяжёлой, как была до этой правки. Отсутствие vips не должно
 * ронять сервис — картинки это украшение библиотеки, а не её суть.
 *
 * Формат. vips пишет WebP (меньше JPEG примерно на треть), sips WebP не
 * умеет вовсе («Can't write format: org.webmproject.webp») и пишет JPEG.
 * Поэтому расширение миниатюры — то, которое реально получилось, а в URL
 * его нет вовсе: /uploads/thumb/400/<uuid>. Формат браузеру сообщает
 * Content-Type, он и так главнее расширения, а URL от этого не зависит от
 * того, какой инструмент оказался на машине — и остаётся одним и тем же
 * после переезда с dev на прод, где миниатюра перегенерируется в WebP.
 *
 * EXIF-поворот при этом получается сам: и vips, и браузер по умолчанию
 * применяют orientation (vips к пикселям и снимает тег, браузер — к
 * показу по тегу), так что повёрнутое фото и в миниатюре, и в полном
 * размере видно одинаково. У ImageMagick это НЕ по умолчанию — поэтому в
 * его команде ниже стоит явный -auto-orient.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

/** Размеры — белый список, не произвольное число из URL: иначе любой
 *  желающий мог бы попросить /uploads/thumb/<что угодно>/<uuid> и заставить
 *  сервис пережимать одну и ту же картинку сколько влезет. 400 — карточка
 *  в сетке (слот 318 CSS-пикселей), 800 — она же на retina и превью в
 *  модалках/на странице пазла. */
const SIZES = [400, 800];

/** Расширения, которые вообще бывают у оригиналов (см. PHOTO_MIME в
 *  server.js) — в этом же порядке ищем исходник по базовому имени, когда
 *  из URL миниатюры известен только uuid. */
const SOURCE_EXTS = [".jpg", ".png", ".webp"];

/** Есть ли бинарник в PATH. Без spawn — часть кандидатов (sips) не знает
 *  ни --version, ни -h и на проверку версией ответила бы ошибкой. */
function hasBin(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      const file = path.join(dir, name);
      if (fs.statSync(file).isFile()) return true;
    } catch { /* нет такого — следующий каталог */ }
  }
  return false;
}

/** Кандидаты по убыванию предпочтения. ext — что инструмент пишет, args —
 *  как его позвать. Каждый вписывает картинку В КВАДРАТ size×size с
 *  сохранением пропорций (не обрезает и не растягивает): слот в вёрстке
 *  обрезает сам, через object-fit:cover, а горизонтальные и вертикальные
 *  фото в библиотеке есть и те, и те (1880×1253 рядом с 867×1300). */
const TOOLS = [
  {
    bin: "vips", ext: ".webp",
    // Кавычки вокруг [Q=78] не нужны и были бы ошибкой: argv передаётся
    // напрямую, без шелла, и скобки для vips — часть имени выходного файла
    // (его синтаксис опций сохранения), а не глоб.
    args: (src, dest, size) => ["thumbnail", src, `${dest}[Q=78,strip]`, String(size), "--height", String(size)],
  },
  {
    bin: "vipsthumbnail", ext: ".webp",
    args: (src, dest, size) => [src, "--size", `${size}x${size}`, "-o", `${dest}[Q=78,strip]`],
  },
  {
    bin: "magick", ext: ".webp",
    // «400x400>» со знаком больше — только уменьшать: картинка меньше
    // миниатюры не должна раздуваться до неё.
    args: (src, dest, size) => [src, "-auto-orient", "-strip", "-resize", `${size}x${size}>`, "-quality", "78", dest],
  },
  {
    bin: "sips", ext: ".jpg",
    // -Z — «вписать в квадрат», ровно та же семантика, что у двух выше.
    args: (src, dest, size) => ["-Z", String(size), "--out", dest, src],
  },
];

const tool = TOOLS.find(t => hasBin(t.bin)) || null;

/** Базы, на которых инструмент уже спотыкался (битый файл, не та картинка,
 *  нет места) — чтобы не звать его на каждый запрос одной и той же
 *  обложки. Живёт до перезапуска: после починки причины достаточно
 *  рестарта, отдельной инвалидации для такого ради не завожу. */
const failed = new Set();

const available = () => !!tool;
const toolName = () => (tool ? tool.bin : null);

/** Файл миниатюры, если он уже лежит на диске: оба возможных расширения,
 *  в том же порядке предпочтения, что и инструменты. Возвращает
 *  абсолютный путь или null. */
function existing(thumbsDir, size, base) {
  for (const ext of [".webp", ".jpg"]) {
    const file = path.join(thumbsDir, String(size), base + ext);
    try { if (fs.statSync(file).isFile()) return file; } catch { /* нет — следующее расширение */ }
  }
  return null;
}

/** Оригинал по базовому имени (uuid без расширения) — в URL миниатюры
 *  расширения нет, а на диске оно есть. Возвращает абсолютный путь или
 *  null. */
function sourceFor(photosDir, base) {
  for (const ext of SOURCE_EXTS) {
    const file = path.join(photosDir, base + ext);
    try { if (fs.statSync(file).isFile()) return file; } catch { /* нет — следующее расширение */ }
  }
  return null;
}

/** Делает одну миниатюру. Возвращает путь к готовому файлу, или null, если
 *  инструмента нет, оригинал не нашёлся или пережать не удалось. Никогда
 *  не бросает: вызывающая сторона (отдача картинки, загрузка фото) должна
 *  продолжать работать и без миниатюр.
 *
 *  Синхронно (spawnSync) намеренно: сервис и так синхронный в работе с
 *  диском и БД (node:sqlite DatabaseSync), а генерация одной миниатюры —
 *  десятки миллисекунд и случается один раз на картинку за всё время.
 *  Асинхронность тут дала бы только гонку двух запросов на один файл. */
function ensure(photosDir, thumbsDir, size, base) {
  if (!SIZES.includes(size)) return null;
  const ready = existing(thumbsDir, size, base);
  if (ready) return ready;
  if (!tool) return null;
  const key = `${size}/${base}`;
  if (failed.has(key)) return null;
  const src = sourceFor(photosDir, base);
  if (!src) return null;
  const outDir = path.join(thumbsDir, String(size));
  const dest = path.join(outDir, base + tool.ext);
  // .part — пишем во временное имя и переименовываем: иначе второй запрос,
  // пришедший пока первый ещё пережимает, увидел бы на диске готовый с
  // виду, но дописанный до половины файл и отдал бы его браузеру.
  // Переименование в пределах одного каталога атомарно.
  const part = `${dest}.${process.pid}.part`;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const r = spawnSync(tool.bin, tool.args(src, part, size), { timeout: 20000, stdio: "ignore" });
    if (r.status !== 0 || !fs.existsSync(part)) throw new Error(`${tool.bin} вернул ${r.status}${r.error ? ` (${r.error.message})` : ""}`);
    fs.renameSync(part, dest);
    return dest;
  } catch (e) {
    try { fs.unlinkSync(part); } catch { /* мог и не создаться */ }
    failed.add(key);
    console.log(`[thumbs] не удалось сделать миниатюру ${size}px для ${base}: ${e.message}`);
    return null;
  }
}

/** Все размеры сразу — после загрузки фото (оба входа: POST /api/puzzles и
 *  POST /internal/puzzles). Возвращает число реально сделанных. */
function ensureAll(photosDir, thumbsDir, base) {
  let n = 0;
  for (const size of SIZES) if (ensure(photosDir, thumbsDir, size, base)) n++;
  return n;
}

/** Убрать миниатюры удалённой картинки — чтобы они не оставались мусором
 *  в томе после удаления пазла (см. fs.unlinkSync на image_file). */
function remove(thumbsDir, base) {
  for (const size of SIZES) {
    for (const ext of [".webp", ".jpg"]) {
      try { fs.unlinkSync(path.join(thumbsDir, String(size), base + ext)); } catch { /* не было — и не надо */ }
    }
  }
}

module.exports = { SIZES, available, toolName, existing, sourceFor, ensure, ensureAll, remove };
