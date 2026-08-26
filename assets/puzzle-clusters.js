"use strict";
/**
 * Геометрия «кластеров» — общая для клиента (assets/app.js) и сервера
 * (server.js require'ит этот файл напрямую — чистые функции, без DOM).
 * Совместимость со старыми сохранёнными данными: у любых двух собранных
 * по старой механике соседей разница координат всегда ровно (dc*CELL,
 * dr*CELL), т.к. общие BOARD_X/pad взаимно сокращаются в разности —
 * поэтому старые pieces:[{r,c,x,y,placed}] реконструируют кластеры
 * корректно без миграции БД/протокола.
 */

const DEFAULT_TOLERANCE_FACTOR = 0.28;
function tolerance(cell) { return cell * DEFAULT_TOLERANCE_FACTOR; }

function buildClusters(piecesIterable, cell, tol) {
  const list = Array.isArray(piecesIterable) ? piecesIterable : [...piecesIterable];
  const byKey = new Map(list.map(p => [`${p.r},${p.c}`, p]));
  const parent = new Map();
  for (const k of byKey.keys()) parent.set(k, k);
  function find(k) {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(k) !== root) { const next = parent.get(k); parent.set(k, root); k = next; }
    return root;
  }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); }

  const edges = [];
  for (const p of list) {
    const key = `${p.r},${p.c}`;
    for (const [dr, dc] of [[0, 1], [1, 0]]) { // только вправо/вниз — каждое ребро сетки проверяется ровно раз
      const nKey = `${p.r + dr},${p.c + dc}`;
      const n = byKey.get(nKey);
      if (!n) continue;
      const dx = n.x - p.x, dy = n.y - p.y;
      if (Math.hypot(dx - dc * cell, dy - dr * cell) <= tol) {
        union(key, nKey);
        edges.push([key, nKey]);
      }
    }
  }

  const clusterOf = new Map();
  const members = new Map();
  for (const k of byKey.keys()) {
    const root = find(k);
    clusterOf.set(k, root);
    if (!members.has(root)) members.set(root, new Set());
    members.get(root).add(k);
  }
  return { clusterOf, members, edges };
}

function largestClusterSize(members) {
  let max = 0;
  for (const set of members.values()) if (set.size > max) max = set.size;
  return max;
}

/** Сумма размеров ВСЕХ кластеров от двух деталей — то есть каждая деталь,
 *  у которой есть хоть один живой сосед, засчитывается сразу, а не только
 *  когда её кусок дорастёт до самого большого сегмента. Одиночки (кластер
 *  размера 1 — ни с кем не состыкована) в сумму не входят. Это счётчик
 *  "собрано" в интерфейсе — НЕ мера "пазл решён целиком": для неё по-прежнему
 *  largestClusterSize (побеждаем только когда все детали — один кластер, а
 *  не просто у каждой есть сосед где-то на борде). */
function connectedPiecesCount(members) {
  let sum = 0;
  for (const set of members.values()) if (set.size > 1) sum += set.size;
  return sum;
}

/**
 * Стыкует перетаскиваемую группу draggingKeys (Set<"r,c">) с её соседями
 * по сетке. Мутирует x/y ТОЛЬКО у деталей из draggingKeys (через
 * pieces: Map<"r,c",{r,c,x,y,...}>), соседей не трогает. Цепная реакция:
 * после каждой успешной стыковки координаты группы изменились — скан
 * перезапускается, что ловит стыковку сразу с нескольких сторон за один
 * жест. Завершается не более чем за (число рёбер сетки) итераций —
 * resolved только растёт, бесконечный цикл невозможен.
 *
 * Перед стыковкой с внешними соседями группа приводится к СТРОГО жёсткой
 * форме относительно одной опорной детали (см. баг: деталь может попасть
 * в draggingKeys через buildClusters — допуск делает её "частью кластера"
 * лишь по случайной близости, без того, чтобы когда-либо явно стыковаться
 * именно этим швом; следующий стык с ЭТОЙ группой видит её как ВНУТРЕННЮЮ
 * пару, `draggingKeys.has(nKey)` пропускает её без проверки — и до ±tol
 * неточности "приклеиваются" к кластеру навсегда, что при последующем
 * жёстком слиянии с другим кластером выглядит как перекос части группы).
 * r/c однозначно задают положение внутри идеального кластера, поэтому
 * ректификация не требует обхода рёбер — просто пересчитываем всех
 * участников группы от произвольной опорной детали.
 *
 * ВАЖНО: draggingKeys должна быть уже РЕАЛЬНО состыкованной группой (или
 * содержать только уже правильно стоящих друг относительно друга соседей) —
 * функция слепо расставляет всех по r/c от анкера, ничего не проверяя. Если
 * позвать её на произвольный набор физически НЕ связанных деталей (с
 * появлением выделения рамкой — см. bindPieceDrag — таскать теперь можно и
 * несколько случайных одиночек разом), их раскидает по "правильным" местам
 * сетки относительно анкера — визуально телепорт при отпускании. Вызывающий
 * код (stitchGroup ниже) поэтому ректифицирует не весь draggingKeys целиком,
 * а только его настоящие связные подгруппы.
 */
function rectifyGroup(pieces, draggingKeys, cell) {
  let anchor = null;
  for (const key of draggingKeys) {
    const p = pieces.get(key);
    if (!anchor) { anchor = p; continue; }
    p.x = anchor.x + (p.c - anchor.c) * cell;
    p.y = anchor.y + (p.r - anchor.r) * cell;
  }
}

/**
 * Стыковка ОДНОЙ настоящей связной группы (см. stitchGroup ниже, который
 * разбивает произвольную draggingKeys на такие группы и гоняет это для
 * каждой независимо). Сама логика — как раньше, один в один.
 */
function stitchOneGroup(pieces, draggingKeys, cell, tol) {
  rectifyGroup(pieces, draggingKeys, cell);
  const DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  const resolved = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    outer:
    for (const key of draggingKeys) {
      const piece = pieces.get(key);
      for (const [dr, dc] of DIRS) {
        const nKey = `${piece.r + dr},${piece.c + dc}`;
        if (draggingKeys.has(nKey)) continue;
        const neighbor = pieces.get(nKey);
        if (!neighbor) continue;
        const pairId = `${key}>${nKey}`;
        if (resolved.has(pairId)) continue;
        const idealDx = dc * cell, idealDy = dr * cell;
        // Сдвиг всей группы, чтобы neighbor.x - piece.x_new === idealDx (симметрично
        // для Y): piece.x_new = piece.x + errX, значит errX = (neighbor.x - piece.x) -
        // idealDx. Не idealDx - (neighbor.x - piece.x) — та форма двигает группу в
        // противоположную сторону и УВЕЛИЧИВАЕТ рассогласование вместо стыковки.
        const errX = (neighbor.x - piece.x) - idealDx;
        const errY = (neighbor.y - piece.y) - idealDy;
        if (Math.hypot(errX, errY) > tol) continue;
        for (const k of draggingKeys) { const p = pieces.get(k); p.x += errX; p.y += errY; }
        resolved.add(pairId);
        changed = true;
        break outer;
      }
    }
  }
  // Довыравнивание после стыковки: rectifyGroup выше чистит только
  // draggingKeys (перетаскиваемую сторону) — но та же "приклейка по допуску
  // без явной стыковки" может накопиться и на НЕПОДВИЖНОЙ стороне (например,
  // деталь вошла в чужой кластер через входящий sync в комнате, без личного
  // участия в стыковке именно этого шва — см. баг в rectifyGroup выше, он
  // симметричен для любой из двух сторон). Если стыковка сейчас реально
  // произошла (resolved непусто) — пересчитываем ВЕСЬ получившийся кластер
  // (не только draggingKeys) от одной опорной детали, а не только
  // перетаскиваемую группу: гарантирует, что скрытая неточность неподвижной
  // стороны тоже не "просочится" в интерфейс криво прицепленным куском.
  // Если стыковки не было (соседей в допуске не нашлось) — трогать нечего.
  if (resolved.size > 0) {
    const { clusterOf, members } = buildClusters(pieces.values(), cell, tol);
    const anchorKey = draggingKeys.values().next().value;
    rectifyGroup(pieces, members.get(clusterOf.get(anchorKey)), cell);
  }
}

/**
 * Стыкует перетаскиваемую группу draggingKeys с её соседями по сетке.
 * draggingKeys БОЛЬШЕ НЕ обязана быть одной настоящей связной группой — с
 * выделением рамкой (см. bindPieceDrag) одним жестом можно тащить сразу
 * несколько физически НЕ связанных друг с другом деталей/кластеров.
 * Поэтому сперва разбиваем draggingKeys на настоящие связные подгруппы
 * (buildClusters по самим перетаскиваемым деталям, без остального борда —
 * иначе можно случайно склеить с посторонним куском ДО стыковки) и гоняем
 * stitchOneGroup для КАЖДОЙ НЕЗАВИСИМО. Это принципиально — если стыковку
 * гонять по всей draggingKeys разом, срабатывание стыковки для ОДНОЙ
 * подгруппы (через `for (const k of draggingKeys) p.x += errX...` внутри
 * stitchOneGroup) сдвинуло бы вообще ВСЕ перетаскиваемые детали, включая
 * те, что к этому шву отношения не имеют, — снаружи это выглядит как
 * телепорт всей группы в момент отпускания.
 */
function stitchGroup(pieces, draggingKeys, cell, tol) {
  const draggingPieces = [...draggingKeys].map(k => pieces.get(k));
  const { members: subgroups } = buildClusters(draggingPieces, cell, tol);
  for (const subKeys of subgroups.values()) stitchOneGroup(pieces, subKeys, cell, tol);
}

const PuzzleClusters = { tolerance, buildClusters, largestClusterSize, connectedPiecesCount, stitchGroup };
if (typeof module !== "undefined") module.exports = PuzzleClusters;
if (typeof window !== "undefined") window.PuzzleClusters = PuzzleClusters;
