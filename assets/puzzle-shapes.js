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
 * Порядок вызовов rnd() фиксирован раз и навсегда — сначала все vEdges по
 * строкам, потом все hEdges по строкам. Менять порядок нельзя: это изменит
 * форму уже сохранённых у пользователей пазлов (seed тот же, но иначе
 * разберётся последовательность чисел).
 */
function buildEdges(seed, rows, cols) {
  const rnd = mulberry32(seed);
  const mkEdge = () => ({
    sign: rnd() < 0.5 ? -1 : 1,
    neck: 0.15 + (rnd() - 0.5) * 0.04,
    knob: 0.20 + (rnd() - 0.5) * 0.05,
  });
  const vEdges = Array.from({ length: rows }, () => Array.from({ length: cols - 1 }, mkEdge));
  const hEdges = Array.from({ length: rows - 1 }, () => Array.from({ length: cols }, mkEdge));
  return { vEdges, hEdges };
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
 * buildPiecePath передаёт сюда top/left уже с sign: -...sign — это и есть
 * инверсия для стороны, читающей чужое ребро.
 */
function edgeCommand(A, B, n, edge) {
  if (!edge) return `L ${B.x} ${B.y}`;
  const L = Math.hypot(B.x - A.x, B.y - A.y);
  const ux = (B.x - A.x) / L, uy = (B.y - A.y) / L;
  const h = edge.neck * L;
  const r = edge.knob * L * edge.sign;
  const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
  const N1 = { x: mid.x - ux * h, y: mid.y - uy * h };
  const N2 = { x: mid.x + ux * h, y: mid.y + uy * h };
  const Bc = { x: mid.x + n.x * r, y: mid.y + n.y * r };
  const C1 = { x: N1.x + n.x * r * 0.9 - ux * h * 0.3, y: N1.y + n.y * r * 0.9 - uy * h * 0.3 };
  const C2 = { x: Bc.x - ux * h * 0.9, y: Bc.y - uy * h * 0.9 };
  const C3 = { x: Bc.x + ux * h * 0.9, y: Bc.y + uy * h * 0.9 };
  const C4 = { x: N2.x + n.x * r * 0.9 + ux * h * 0.3, y: N2.y + n.y * r * 0.9 + uy * h * 0.3 };
  return `L ${N1.x} ${N1.y} C ${C1.x} ${C1.y} ${C2.x} ${C2.y} ${Bc.x} ${Bc.y} `
       + `C ${C3.x} ${C3.y} ${C4.x} ${C4.y} ${N2.x} ${N2.y} L ${B.x} ${B.y}`;
}

/**
 * Контур одной детали (r,c) сетки rows×cols, ячейка cell×cell.
 * PAD — запас вокруг ячейки под выступы соседей: у каждой детали свой
 * <svg viewBox="0 0 {cell+2*PAD} {cell+2*PAD}">, картинка внутри показана
 * через <clipPath> со сдвигом на -(c*cell-PAD), -(r*cell-PAD) — так деталь
 * остаётся квадратным SVG-элементом, а не растёт вместе с сеткой.
 */
function buildPiecePath(r, c, rows, cols, cell, edges) {
  const PAD = cell * 0.32; // запас под выступы соседей
  const TL = { x: PAD, y: PAD }, TR = { x: PAD + cell, y: PAD };
  const BR = { x: PAD + cell, y: PAD + cell }, BL = { x: PAD, y: PAD + cell };
  const top = r === 0 ? null : { ...edges.hEdges[r - 1][c], sign: -edges.hEdges[r - 1][c].sign };
  const right = c === cols - 1 ? null : edges.vEdges[r][c];
  const bottom = r === rows - 1 ? null : edges.hEdges[r][c];
  const left = c === 0 ? null : { ...edges.vEdges[r][c - 1], sign: -edges.vEdges[r][c - 1].sign };
  let d = `M ${TL.x} ${TL.y} `;
  d += edgeCommand(TL, TR, { x: 0, y: -1 }, top) + " ";
  d += edgeCommand(TR, BR, { x: 1, y: 0 }, right) + " ";
  d += edgeCommand(BR, BL, { x: 0, y: 1 }, bottom) + " ";
  d += edgeCommand(BL, TL, { x: -1, y: 0 }, left) + " Z";
  return d;
}

const PuzzleShapes = { mulberry32, buildEdges, edgeCommand, buildPiecePath };
if (typeof module !== "undefined") module.exports = PuzzleShapes;
if (typeof window !== "undefined") window.PuzzleShapes = PuzzleShapes;
