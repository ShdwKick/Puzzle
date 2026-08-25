"use strict";
/**
 * Форма деталей пазла — чистые функции, без DOM.
 *
 * Идея: не прямоугольная сетка, а SVG-контур с закруглённым «пегом»
 * (выступом/пазом) на каждой внутренней грани — 2 кривые Безье на грань,
 * детерминированный по seed пазла (mulberry32). Ключевое свойство: у
 * соседних деталей общее ребро строится из ОДНИХ И ТЕХ ЖЕ чисел (тот же
 * edge-объект — sign/neck/knob), только обходится в противоположном
 * порядке и с противоположной нормалью — контуры совпадают пиксель-в-
 * пиксель без какой-либо дополнительной синхронизации.
 *
 * buildEdges(seed, rows, cols) вызывается один раз на пазл (детерминирован
 * seed'ом, зашитым в БД/манифест — см. server.js), результат передаётся в
 * buildPiecePath для каждой детали.
 */

/** Детерминированный ГПСЧ. Один и тот же seed → одна и та же последовательность
 *  чисел везде — в этом и есть весь фокус синхронизации формы деталей. */
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t |= 0; t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Случайные параметры каждой внутренней грани сетки rows×cols:
 *   sign — в какую сторону смотрит выступ (случайно, «пег» или «паз»),
 *   neck — доля длины грани под «шейку» выступа,
 *   knob — доля длины грани под высоту/глубину выступа.
 *
 * options.asymmetric — «экстремальный» уровень (см. README): те же sign/
 * neck/knob (шире диапазон), плюс четыре доп. параметра, делающих сам
 * выступ несимметричным (не по центру грани, разной ширины шейки и наклона
 * плеч с каждой стороны) — см. edgeCommand про то, почему стыковка соседей
 * при этом остаётся пиксель-в-пиксель точной.
 *
 * Порядок вызовов rnd() фиксирован раз и навсегда — сначала все vEdges по
 * строкам, потом все hEdges по строкам. Менять порядок нельзя: это изменит
 * форму уже сохранённых у пользователей пазлов (seed тот же, но иначе
 * разберётся последовательность чисел).
 */
function buildEdges(seed, rows, cols, options = {}) {
  const rnd = mulberry32(seed);
  const asymmetric = !!options.asymmetric;
  const mkEdge = () => {
    const sign = rnd() < 0.5 ? -1 : 1;
    if (!asymmetric) {
      return { sign, neck: 0.15 + (rnd() - 0.5) * 0.04, knob: 0.20 + (rnd() - 0.5) * 0.05 };
    }
    return {
      sign,
      neck: 0.10 + rnd() * 0.13,          // [0.10, 0.23] — ещё шире, чем в обычном режиме
      knob: 0.13 + rnd() * 0.13,          // [0.13, 0.26] — выступы крупнее и разнообразнее
      offset: (rnd() - 0.5) * 0.34,       // [-0.17, 0.17] — вершина выступа заметно не по центру грани
      neckL: 0.6 + rnd() * 0.8,           // [0.6, 1.4] — своя ширина шейки на каждом плече, разница крупнее
      neckR: 0.6 + rnd() * 0.8,
      armL: 0.62 + rnd() * 0.66,          // [0.62, 1.28] — свой наклон кривой на каждом плече, разница крупнее
      armR: 0.62 + rnd() * 0.66,
    };
  };
  const vEdges = Array.from({ length: rows }, () => Array.from({ length: cols - 1 }, mkEdge));
  const hEdges = Array.from({ length: rows - 1 }, () => Array.from({ length: cols }, mkEdge));

  // Ассиметричный режим — до сих пор менялись только пазы на рёбрах, сама
  // деталь оставалась ровным квадратом. Добавляем смещение самих УГЛОВ:
  // каждая ВНУТРЕННЯЯ вершина сетки (rows+1)×(cols+1) сдвинута со своего
  // идеального места — внешняя рамка пазла НЕ трогается (иначе итоговая
  // картинка перестала бы быть прямоугольником, совпадающим с фото). Вершина
  // генерируется РОВНО ОДИН РАЗ и используется ОБЩЕЙ для всех (до четырёх)
  // деталей, которые её касаются, — тем же приёмом, что уже есть у рёбер
  // (общий edge-объект на двух соседей): buildPiecePath берёт эту же ячейку
  // vertices[vr][vc] независимо от того, какая деталь спрашивает, поэтому
  // общий угол у соседних деталей совпадает пиксель-в-пиксель без зазоров.
  let vertices = null;
  if (asymmetric) {
    vertices = Array.from({ length: rows + 1 }, (_, vr) =>
      Array.from({ length: cols + 1 }, (_, vc) => {
        const interior = vr > 0 && vr < rows && vc > 0 && vc < cols;
        if (!interior) return { dx: 0, dy: 0 };
        return { dx: (rnd() - 0.5) * VERTEX_JITTER, dy: (rnd() - 0.5) * VERTEX_JITTER };
      }));
  }
  return { vEdges, hEdges, vertices };
}
const VERTEX_JITTER = 0.15; // доля cell — см. buildPiecePath/localCorner, подобрано стресс-тестом на PAD

/**
 * Ребро, прочитанное с ОБРАТНОЙ стороны (сосед, для которого это же
 * физическое ребро — top/left, а не bottom/right, см. buildPiecePath). Кроме
 * sign (было и раньше) для ассиметричного режима нужно ЕЩЁ: offset — тоже
 * инвертировать (та же вершина выступа — общая физическая точка, см. вывод
 * в комментарии buildEdges/edgeCommand), а neckL/neckR и armL/armR —
 * поменять местами (то, что было «левым плечом» с одной стороны грани,
 * становится «правым» при обходе с другой). Без этого свёрнутая формула
 * даёт РАЗНЫЕ кривые у двух соседей — деталь с ассиметричным швом визуально
 * «разъезжается» ровно там, где стыкуется с другой.
 */
function reverseEdge(edge) {
  if (edge.offset === undefined) return { ...edge, sign: -edge.sign };
  return {
    ...edge, sign: -edge.sign, offset: -edge.offset,
    neckL: edge.neckR, neckR: edge.neckL, armL: edge.armR, armR: edge.armL,
  };
}

/**
 * SVG-команда одной грани детали от точки A до точки B с нормалью n
 * (единичный вектор, куда смотрит «наружу» этой грани для ЭТОЙ детали).
 * edge === null — прямая грань (край пазла, без выступа).
 *
 * Почему рёбра совпадают у соседей: сосед обходит то же физическое ребро в
 * обратном порядке — замена (A,B,n,sign) → (B,A,-n,-sign). Середина mid и
 * вершина выступа Bc инвариантны при этой подстановке, а N1↔N2, C1↔C4,
 * C2↔C3 меняются местами — та же кривая, пройденная в обратную сторону.
 * buildPiecePath передаёт сюда top/left уже прошедшими через reverseEdge()
 * (sign, а в ассиметричном режиме — ещё offset/neckL·R/armL·R) — это и есть
 * инверсия для стороны, читающей чужое ребро.
 *
 * Ассиметричный режим (edge.offset !== undefined) — те же 4 подстановки
 * плюс независимые neckL/neckR (ширина шейки на каждом плече) и armL/armR
 * (наклон кривой на каждом плече); mid сдвинут на offset вдоль грани.
 * Проверено алгебраически (см. коммит): при подстановке выше N1↔N2, C1↔C4,
 * C2↔C3 по-прежнему меняются местами ТОЧНО, если офсет меняет знак, а
 * neckL/R и armL/R переставляются местами — reverseEdge() делает это.
 */
function edgeCommand(A, B, n, edge) {
  if (!edge) return `L ${B.x} ${B.y}`;
  const L = Math.hypot(B.x - A.x, B.y - A.y);
  const ux = (B.x - A.x) / L, uy = (B.y - A.y) / L;
  const offset = (edge.offset || 0) * L;
  const neckL = edge.neckL !== undefined ? edge.neckL : 1;
  const neckR = edge.neckR !== undefined ? edge.neckR : 1;
  const armL = edge.armL !== undefined ? edge.armL : 1;
  const armR = edge.armR !== undefined ? edge.armR : 1;
  const hL = edge.neck * L * neckL;
  const hR = edge.neck * L * neckR;
  const r = edge.knob * L * edge.sign;
  const mid = { x: (A.x + B.x) / 2 + ux * offset, y: (A.y + B.y) / 2 + uy * offset };
  const N1 = { x: mid.x - ux * hL, y: mid.y - uy * hL };
  const N2 = { x: mid.x + ux * hR, y: mid.y + uy * hR };
  const Bc = { x: mid.x + n.x * r, y: mid.y + n.y * r };
  const C1 = { x: N1.x + n.x * r * 0.9 * armL - ux * hL * 0.3, y: N1.y + n.y * r * 0.9 * armL - uy * hL * 0.3 };
  const C2 = { x: Bc.x - ux * hL * 0.9, y: Bc.y - uy * hL * 0.9 };
  const C3 = { x: Bc.x + ux * hR * 0.9, y: Bc.y + uy * hR * 0.9 };
  const C4 = { x: N2.x + n.x * r * 0.9 * armR + ux * hR * 0.3, y: N2.y + n.y * r * 0.9 * armR + uy * hR * 0.3 };
  return `L ${N1.x} ${N1.y} C ${C1.x} ${C1.y} ${C2.x} ${C2.y} ${Bc.x} ${Bc.y} `
       + `C ${C3.x} ${C3.y} ${C4.x} ${C4.y} ${N2.x} ${N2.y} L ${B.x} ${B.y}`;
}

/**
 * Локальный угол детали (r,c) для глобальной вершины сетки (vr,vc) — обычно
 * один из четырёх непосредственных углов самой детали, но эта же функция
 * годится для ЛЮБОЙ вершины: локальные координаты — это просто (vr,vc)
 * relative к (r,c) в клетках, плюс отступ PAD. Если vertices не задан
 * (обычный режим) или вершина внешняя (edges.vertices[vr][vc] — {0,0}),
 * возвращает идеальный угол квадрата — ровно как было раньше.
 */
function localCorner(vr, vc, r, c, cell, PAD, vertices) {
  const x = PAD + (vc - c) * cell, y = PAD + (vr - r) * cell;
  if (!vertices) return { x, y };
  const j = vertices[vr][vc];
  return { x: x + j.dx * cell, y: y + j.dy * cell };
}

/**
 * Контур одной детали (r,c) сетки rows×cols, ячейка cell×cell.
 * PAD — запас вокруг ячейки под выступы соседей: у каждой детали свой
 * <svg viewBox="0 0 {cell+2*PAD} {cell+2*PAD}">, картинка внутри показана
 * через <clipPath> со сдвигом на -(c*cell-PAD), -(r*cell-PAD) — так деталь
 * остаётся квадратным SVG-элементом, а не растёт вместе с сеткой.
 *
 * В ассиметричном режиме (edges.vertices задан) углы — НЕ идеальный квадрат
 * (см. buildEdges/localCorner) — каждый угол берётся из общей на соседей
 * сетки вершин, поэтому у соседних деталей общий угол совпадает без правок.
 */
function buildPiecePath(r, c, rows, cols, cell, edges) {
  const PAD = cell * 0.4; // запас под выступы соседей и (в ассиметричном режиме) сдвиг углов — тот же коэффициент, что PAD_FACTOR в assets/app.js
  const V = edges.vertices;
  const TL = localCorner(r, c, r, c, cell, PAD, V), TR = localCorner(r, c + 1, r, c, cell, PAD, V);
  const BR = localCorner(r + 1, c + 1, r, c, cell, PAD, V), BL = localCorner(r + 1, c, r, c, cell, PAD, V);
  const top = r === 0 ? null : reverseEdge(edges.hEdges[r - 1][c]);
  const right = c === cols - 1 ? null : edges.vEdges[r][c];
  const bottom = r === rows - 1 ? null : edges.hEdges[r][c];
  const left = c === 0 ? null : reverseEdge(edges.vEdges[r][c - 1]);
  let d = `M ${TL.x} ${TL.y} `;
  d += edgeCommand(TL, TR, { x: 0, y: -1 }, top) + " ";
  d += edgeCommand(TR, BR, { x: 1, y: 0 }, right) + " ";
  d += edgeCommand(BR, BL, { x: 0, y: 1 }, bottom) + " ";
  d += edgeCommand(BL, TL, { x: -1, y: 0 }, left) + " Z";
  return d;
}

const PuzzleShapes = { mulberry32, buildEdges, reverseEdge, edgeCommand, buildPiecePath };
if (typeof module !== "undefined") module.exports = PuzzleShapes;
if (typeof window !== "undefined") window.PuzzleShapes = PuzzleShapes;
