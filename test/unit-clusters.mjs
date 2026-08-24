/**
 * Юнит-тест геометрии кластеров: чистые функции assets/puzzle-clusters.js,
 * без сервера/сокетов/DOM — единственный способ изолированно проверить
 * самое рискованное место (стыковку stitchGroup) до того, как оно
 * прогоняется через WS/браузер.
 *
 * Запуск: node test/unit-clusters.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { tolerance, buildClusters, largestClusterSize, stitchGroup } = require("../assets/puzzle-clusters.js");

const CELL = 100;
const TOL = tolerance(CELL); // 28

let failures = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "  OK  " : " FAIL "} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/* ── tolerance() ── */
ok("tolerance(100) === 28", near(TOL, 28));

/* ── buildClusters: базовая сборка кластеров по сетке ── */
{
  // Квадрат 2×2, все четыре детали идеально состыкованы.
  const pieces = [
    { r: 0, c: 0, x: 0, y: 0 },
    { r: 0, c: 1, x: 100, y: 0 },
    { r: 1, c: 0, x: 0, y: 100 },
    { r: 1, c: 1, x: 100, y: 100 },
  ];
  const { members } = buildClusters(pieces, CELL, TOL);
  ok("buildClusters: собранный квадрат — один кластер из 4", largestClusterSize(members) === 4);
}
{
  // Та же сетка, но одна деталь далеко — два кластера.
  const pieces = [
    { r: 0, c: 0, x: 0, y: 0 },
    { r: 0, c: 1, x: 100, y: 0 },
    { r: 1, c: 0, x: 0, y: 100 },
    { r: 1, c: 1, x: 9999, y: 9999 },
  ];
  const { members } = buildClusters(pieces, CELL, TOL);
  ok("buildClusters: оторванная деталь не входит в основной кластер", largestClusterSize(members) === 3);
  ok("buildClusters: всего кластеров — 2", members.size === 2);
}

/* ── stitchGroup: одиночная стыковка ── */
{
  // Тащим одну деталь (0,0) рядом с неподвижным соседом (0,1), но не точно —
  // в пределах допуска (offset 10 < TOL=28).
  const pieces = new Map([
    ["0,0", { r: 0, c: 0, x: 0, y: 0 }],
    ["0,1", { r: 0, c: 1, x: 90, y: 3 }],
  ]);
  stitchGroup(pieces, new Set(["0,0"]), CELL, TOL);
  const a = pieces.get("0,0"), b = pieces.get("0,1");
  ok("stitchGroup: одиночная стыковка — точная стыковка по X", near(b.x - a.x, CELL));
  ok("stitchGroup: одиночная стыковка — точная стыковка по Y", near(b.y - a.y, 0));
  const { members } = buildClusters([...pieces.values()], CELL, TOL);
  ok("stitchGroup: после стыковки buildClusters видит один кластер из 2", largestClusterSize(members) === 2);
}

/* ── stitchGroup: деталь ВНЕ допуска не стыкуется ── */
{
  const pieces = new Map([
    ["0,0", { r: 0, c: 0, x: 0, y: 0 }],
    ["0,1", { r: 0, c: 1, x: 50, y: 0 }], // offset 50 от идеала (100) — вне допуска 28
  ]);
  stitchGroup(pieces, new Set(["0,0"]), CELL, TOL);
  const a = pieces.get("0,0"), b = pieces.get("0,1");
  ok("stitchGroup: деталь вне допуска не двигается", a.x === 0 && a.y === 0);
  ok("stitchGroup: сосед вне допуска остаётся несостыкованным", !near(b.x - a.x, CELL));
}

/* ── stitchGroup: цепная реакция — стыковка с двух сторон за один жест ──
 * Тащим жёсткую пару (1,0)+(1,1) (внутреннее взаимное расстояние уже верное:
 * ровно CELL по X) рядом с двумя неподвижными соседями сразу: (0,0) сверху
 * от (1,0) и (0,1) сверху от (1,1). Группа целиком смещена от идеала на
 * один и тот же (errX,errY) относительно обоих неподвижных соседей — стыковка
 * с одним автоматически выравнивает и второй за счёт жёсткости группы, что
 * stitchGroup обязан поймать за один вызов (перезапуск скана после каждого
 * успешного ребра).
 */
{
  const pieces = new Map([
    ["0,0", { r: 0, c: 0, x: 0, y: 0 }],       // неподвижный, стационарный
    ["0,1", { r: 0, c: 1, x: 100, y: 0 }],     // неподвижный, стационарный
    ["1,0", { r: 1, c: 0, x: 12, y: 108 }],    // тащим: сдвинуто от идеала (0,100) на (12,8)
    ["1,1", { r: 1, c: 1, x: 112, y: 108 }],   // тащим: та же жёсткая пара, сдвиг идентичен
  ]);
  const dragging = new Set(["1,0", "1,1"]);
  stitchGroup(pieces, dragging, CELL, TOL);
  const a00 = pieces.get("0,0"), a01 = pieces.get("0,1");
  const b10 = pieces.get("1,0"), b11 = pieces.get("1,1");
  ok("stitchGroup: цепная стыковка — левая пара точно под (0,0)", near(b10.x - a00.x, 0) && near(b10.y - a00.y, CELL));
  ok("stitchGroup: цепная стыковка — правая пара точно под (0,1)", near(b11.x - a01.x, 0) && near(b11.y - a01.y, CELL));
  ok("stitchGroup: внутренняя жёсткость пары сохранена", near(b11.x - b10.x, CELL) && near(b11.y - b10.y, 0));
  const { members } = buildClusters([...pieces.values()], CELL, TOL);
  ok("stitchGroup: после цепной стыковки — один кластер из 4", largestClusterSize(members) === 4);
}

process.exit(failures ? 1 : 0);
