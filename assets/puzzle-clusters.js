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

/**
 * Стыкует перетаскиваемую группу draggingKeys (Set<"r,c">) с её соседями
 * по сетке. Мутирует x/y ТОЛЬКО у деталей из draggingKeys (через
 * pieces: Map<"r,c",{r,c,x,y,...}>), соседей не трогает. Цепная реакция:
 * после каждой успешной стыковки координаты группы изменились — скан
 * перезапускается, что ловит стыковку сразу с нескольких сторон за один
 * жест. Завершается не более чем за (число рёбер сетки) итераций —
 * resolved только растёт, бесконечный цикл невозможен.
 */
function stitchGroup(pieces, draggingKeys, cell, tol) {
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
}

const PuzzleClusters = { tolerance, buildClusters, largestClusterSize, stitchGroup };
if (typeof module !== "undefined") module.exports = PuzzleClusters;
if (typeof window !== "undefined") window.PuzzleClusters = PuzzleClusters;
