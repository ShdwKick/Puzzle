/**
 * Юнит-тест геометрии формы деталей: assets/puzzle-shapes.js, без DOM.
 * Главное, что проверяется — инвариант стыковки соседей: любые два соседних
 * detail читают ОДНО физическое ребро с противоположных сторон
 * (A,B,n,edge) → (B,A,-n,reverseEdge(edge)), и результирующая кривая должна
 * быть той же самой, только пройденной в обратном порядке — иначе контуры
 * соседних деталей разъезжаются на стыке. Обычный режим уже был устроен
 * так; ассиметричный (offset/neckL·R/armL·R) добавлен в этом заходе и
 * специально проверяется отдельно, т.к. это самое рискованное место.
 *
 * Запуск: node test/unit-shapes.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { buildEdges, reverseEdge, edgeCommand, buildPiecePath } = require("../assets/puzzle-shapes.js");

let failures = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "  OK  " : " FAIL "} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/** Разбирает "L x y C x y x y x y C x y x y x y L x y" на 8 точек
 *  [N1,C1,C2,Bc,C3,C4,N2,B] — B в проверке не участвует, это уже
 *  следующая прямая сторона, не часть самой кривой выступа. */
function parsePoints(d) {
  const nums = d.match(/-?\d+(\.\d+)?/g).map(Number);
  const pts = [];
  for (let i = 0; i < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
  return pts;
}

/** Проверяет, что прямой и обратный обход одного и того же физического
 *  ребра дают одну кривую, пройденную в противоположных направлениях. */
function checkReversalSymmetry(name, A, B, n, edge) {
  const forward = parsePoints(edgeCommand(A, B, n, edge)).slice(0, 7); // N1..N2, без B
  const reversed = parsePoints(edgeCommand(B, A, { x: -n.x, y: -n.y }, reverseEdge(edge))).slice(0, 7).reverse();
  let maxErr = 0;
  for (let i = 0; i < 7; i++) {
    maxErr = Math.max(maxErr, Math.abs(forward[i].x - reversed[i].x), Math.abs(forward[i].y - reversed[i].y));
  }
  ok(name, maxErr < 1e-6, `maxErr=${maxErr.toExponential(2)}`);
}

const A = { x: 32, y: 32 }, B = { x: 132, y: 32 }; // горизонтальное ребро, L=100 — как в buildPiecePath
const n = { x: 0, y: -1 };

// ── обычный режим (регресс — не должен был сломаться правкой) ──
{
  const { hEdges } = buildEdges(20260501, 2, 2);
  checkReversalSymmetry("обычный режим: прямой/обратный обход дают одну кривую", A, B, n, hEdges[0][0]);
}

// ── ассиметричный режим — самое рискованное место этого захода ──
{
  const { hEdges, vEdges } = buildEdges(777, 4, 4, { asymmetric: true });
  ok("ассиметричный режим: у ребра есть offset/neckL/neckR/armL/armR", hEdges[0][0].offset !== undefined && hEdges[0][0].neckL !== undefined);
  // Проверяем на нескольких разных рёбрах (разные случайные offset/neckL·R/armL·R) —
  // одного недостаточно, т.к. при offset≈0 или neckL≈neckR ассиметрия могла бы
  // случайно не проявиться и симметрию было бы легко подделать багом.
  let checked = 0;
  for (let i = 0; i < hEdges.length; i++) {
    for (let j = 0; j < hEdges[i].length; j++) {
      checkReversalSymmetry(`ассиметричный режим: hEdges[${i}][${j}] прямой/обратный обход совпадают`, A, B, n, hEdges[i][j]);
      checked++;
    }
  }
  for (let i = 0; i < vEdges.length; i++) {
    for (let j = 0; j < vEdges[i].length; j++) {
      checkReversalSymmetry(`ассиметричный режим: vEdges[${i}][${j}] прямой/обратный обход совпадают`, A, B, n, vEdges[i][j]);
      checked++;
    }
  }
  ok("ассиметричный режим: проверено больше одного ребра", checked > 5, String(checked));
}

// ── ассиметрия реально проявляется (offset/neckL≠neckR где-то на сетке) —
// иначе «ассиметричный режим» тихо выродился бы обратно в симметричный. ──
{
  const { hEdges } = buildEdges(42, 6, 6, { asymmetric: true });
  const hasVisibleAsymmetry = hEdges.some(row => row.some(e => Math.abs(e.offset) > 0.02 || Math.abs(e.neckL - e.neckR) > 0.05));
  ok("ассиметричный режим: смещение/разница плеч реально встречается на сетке", hasVisibleAsymmetry);
}

// ── обычный режим не задет — offset/neckL и т.п. отсутствуют ──
{
  const { hEdges } = buildEdges(20260501, 2, 2);
  ok("обычный режим: без новых полей (offset и т.п.)", hEdges[0][0].offset === undefined);
}

/* ── углы деталей (не только пазы на рёбрах) — тоже ассиметричные ──
 * До этого захода менялись только выступы на гранях, сама деталь оставалась
 * идеальным квадратом. Теперь ВНУТРЕННИЕ вершины сетки смещены — проверяем
 * три вещи: (1) внешняя рамка пазла НЕ тронута (иначе итоговая картинка
 * перестала бы быть прямоугольником), (2) смещение реально ненулевое хотя
 * бы где-то (иначе тихо выродилось бы обратно в квадрат), (3) деталь
 * остаётся в пределах PAD-запаса (см. VERTEX_JITTER, подобрано
 * стресс-тестом на 800 seed). Совпадение общего угла у соседних деталей —
 * не тестируется отдельно: гарантировано АЛГЕБРАИЧЕСКИ самой формулой
 * localCorner (мировая позиция угла = PAD + vc*cell + dx*cell, (r,c) самой
 * детали в формуле полностью сокращается — см. комментарий в buildEdges). */
{
  const CELL = 100, PAD = CELL * 0.4;
  const rows = 6, cols = 6;
  const { vertices } = buildEdges(2024, rows, cols, { asymmetric: true });
  ok("ассиметричный режим: у пазла есть сетка вершин", Array.isArray(vertices) && vertices.length === rows + 1);

  let borderOk = true;
  for (let vr = 0; vr <= rows; vr++) for (let vc = 0; vc <= cols; vc++) {
    const border = vr === 0 || vr === rows || vc === 0 || vc === cols;
    if (border && (vertices[vr][vc].dx !== 0 || vertices[vr][vc].dy !== 0)) borderOk = false;
  }
  ok("ассиметричный режим: внешняя рамка пазла не тронута (dx=dy=0)", borderOk);

  const hasVisibleCornerShift = vertices.some(row => row.some(v => Math.abs(v.dx) > 0.02 || Math.abs(v.dy) > 0.02));
  ok("ассиметричный режим: углы реально смещены хотя бы где-то", hasVisibleCornerShift);

  let minV = Infinity, maxV = -Infinity;
  const edgesFull = buildEdges(2024, rows, cols, { asymmetric: true });
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const d = buildPiecePath(r, c, rows, cols, CELL, edgesFull);
    for (const n of d.match(/-?\d+(\.\d+)?/g).map(Number)) { minV = Math.min(minV, n); maxV = Math.max(maxV, n); }
  }
  const size = CELL + 2 * PAD;
  ok("ассиметричный режим: контур со смещёнными углами не вылезает за PAD-запас",
    minV >= -1e-6 && maxV <= size + 1e-6, `[${minV.toFixed(2)}, ${maxV.toFixed(2)}] of [0,${size}]`);
}

process.exit(failures ? 1 : 0);
