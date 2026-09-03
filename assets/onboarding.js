"use strict";
/**
 * Пошаговое обучение — подсветка настоящих элементов с карточкой рядом.
 * Сделано по образцу «Поездок»/«Моих финансов» (тот же assets/onboarding.js,
 * та же разметка/CSS .onb-*), чтобы у сервисов BurningHouse обучение
 * выглядело и работало одинаково.
 *
 * Туров два, тем же приёмом, что у «Поездок» (список поездок / поездка) —
 * разделение по экранам, не косметическое: библиотека и стол сборки не
 * делят почти никакой разметки, рассказывать про стол на библиотеке нечем.
 *  - library — главная страница (карточки, категории, комнаты), кнопка
 *    #libraryHelpBtn в общей шапке (см. index.html, видимость переключает
 *    route() в app.js — только на "/").
 *  - table — стол сборки (соло и комната используют один и тот же тулбар
 *    почти один в один, разница только в паре виджетов чат/присутствие —
 *    только в комнате), кнопка #tableHelpBtn в тулбаре стола (см.
 *    renderTable/renderRoomTable в app.js).
 * shown() ниже сам молча пропускает шаг, если цели нет в разметке или она
 * скрыта — например, комнатные шаги тура table просто не покажутся на
 * соло-столе, отдельный список шагов под это заводить не нужно.
 *
 * Каждый тур показывается один раз на устройство и запоминается отдельно
 * (localStorage — своей таблицы настроек тут нет, заводить её ради двух
 * флагов дороже, чем показать обучение второй раз на новом устройстве).
 * Повторно оба открываются своей кнопкой со знаком вопроса.
 *
 * t()/getLang() — из app.js (обычные global-функции, не модуль, тот же
 * приём, что и у остального обучения тут же в файле): подсказки идут через
 * общий RU→EN словарь, а не свою пару текстов — Puzzle, в отличие от
 * «Поездок», двуязычный.
 */

const TOURS = {
  library: {
    seenKey: "puzzle.tour.library",
    steps: [
      {
        title: "Библиотека пазлов",
        desc: "Готовые пазлы для сборки — выберите любой и приступайте, вход не нужен. Покажем, где что — можно пропустить в любой момент.",
        target: null,
      },
      {
        title: "Категории",
        desc: "Пазлы, сгруппированные по темам — можно смотреть по одной вместо всей библиотеки сразу.",
        target: "a[href='/categories']",
      },
      {
        title: "Карточка пазла",
        desc: "Нажмите на неё — откроется превью с рейтингом и автором (если это чьё-то фото). Кнопка «За стол» рядом сразу открывает выбор сложности.",
        target: ".puzzle-card",
      },
      {
        title: "Комнаты",
        desc: "Собирайте пазл вместе с друзьями в реальном времени — общий стол, чат и список участников.",
        target: "a[href='/rooms']",
      },
      {
        title: "Вход",
        desc: "Сохраняет прогресс между заходами. Без входа тоже можно играть — прогресс останется в этом браузере.",
        target: "#headerLoginBtn",
      },
      {
        title: "Это обучение",
        desc: "Открыть заново можно этой же кнопкой в любой момент.",
        target: "#libraryHelpBtn",
      },
    ],
  },
  table: {
    seenKey: "puzzle.tour.table",
    steps: [
      {
        title: "Стол сборки",
        desc: "Тащите детали и стыкуйте — совпавшие сами защёлкнутся в кластер. Покажем, где что на столе — можно пропустить в любой момент.",
        target: null,
      },
      {
        title: "Назад",
        desc: "Возвращает назад — прогресс сборки сохраняется, продолжить можно в любой момент.",
        target: ".board-back a",
      },
      {
        title: "Перемешать",
        desc: "Раскидывает ещё не собранные детали по столу заново — пригодится, если они слиплись в кучу.",
        target: "#shuffleBtn",
      },
      {
        title: "Показать картинку",
        desc: "Показывает исходное фото пазла для ориентира.",
        target: "#previewBtn",
      },
      {
        title: "Фон стола",
        desc: "Свой цвет фона — если деталь плохо видна на исходном фоне, замените его.",
        target: "#boardBgBtn",
      },
      {
        title: "Режим выделения",
        desc: "Рамкой выделяет сразу несколько деталей — на телефоне и планшете это замена зажатому Shift на компьютере.",
        target: "#selectModeBtn",
      },
      {
        title: "Масштаб",
        desc: "Приближает, отдаляет и одной кнопкой показывает весь стол целиком.",
        target: ".zoom-controls",
      },
      {
        title: "Чат",
        desc: "Общий чат за этим столом — сообщения не сохраняются, видны только пока открыта комната.",
        target: "#chatBtn",
      },
      {
        title: "Участники",
        desc: "Кто сейчас собирает этот пазл вместе с вами.",
        target: "#presenceBtn",
      },
      {
        title: "Это обучение",
        desc: "Открыть заново можно этой же кнопкой в любой момент.",
        target: "#tableHelpBtn",
      },
    ],
  },
};

let tourName = null, tourIndex = 0, tourActive = false, tourTarget = null;

const byId = id => document.getElementById(id);

/** Элемент есть в разметке, но может быть скрыт — тогда подсвечивать нечего. */
const shown = el => !!el && !!el.offsetParent && el.getBoundingClientRect().width > 0;

const tourSeen = key => {
  try { return !!localStorage.getItem(key); } catch { return true; }   // нет доступа — не навязываемся
};
const markSeen = key => {
  try { localStorage.setItem(key, "1"); } catch { /* приватный режим — переживём */ }
};

/** Показать тур, если его ещё не видели. Вызывается после отрисовки стола. */
function maybeStartTour(name) {
  const tour = TOURS[name];
  if (!tour || tourActive || tourSeen(tour.seenKey)) return;
  // Поверх открытого диалога подсветка выглядит поломкой — подождём.
  if (document.querySelector(".modal-backdrop:not(.hidden)")) return;
  startTour(name);
}

function startTour(name) {
  if (!TOURS[name]) return;
  tourName = name;
  tourActive = true;
  byId("onbScrim").classList.add("show");
  addEventListener("resize", repositionTour);
  addEventListener("keydown", tourKeys);
  showTourStep(0);
}

function endTour() {
  if (!tourActive) return;
  tourActive = false;
  if (tourTarget) { tourTarget.classList.remove("onb-target"); tourTarget = null; }
  byId("onbScrim").classList.remove("show");
  removeEventListener("resize", repositionTour);
  removeEventListener("keydown", tourKeys);
  markSeen(TOURS[tourName].seenKey);
}

function tourKeys(e) {
  if (!tourActive) return;
  if (e.key === "Escape") endTour();
  if (e.key === "ArrowRight" || e.key === "Enter") nextTourStep();
  if (e.key === "ArrowLeft") prevTourStep();
}

function nextTourStep() {
  const steps = TOURS[tourName].steps;
  if (tourIndex < steps.length - 1) showTourStep(tourIndex + 1); else endTour();
}
function prevTourStep() { if (tourIndex > 0) showTourStep(tourIndex - 1); }

function showTourStep(i) {
  tourIndex = i;
  const steps = TOURS[tourName].steps;
  const step = steps[i];
  const target = step.target ? document.querySelector(step.target) : null;

  // Элемента нет или он скрыт — например, чат/присутствие есть только в
  // комнате, на соло-столе их в разметке вовсе нет. Такой шаг пропускаем
  // молча: рассказ про невидимое только путает.
  if (step.target && !shown(target)) {
    return i < steps.length - 1 ? showTourStep(i + 1) : endTour();
  }
  if (target) target.scrollIntoView({ block: "center", behavior: "instant" });
  requestAnimationFrame(() => renderTourStep(step, target, i));
}

function renderTourStep(step, target, i) {
  const steps = TOURS[tourName].steps;
  const spot = byId("onbSpotlight");
  const card = byId("onbCard");

  if (tourTarget && tourTarget !== target) tourTarget.classList.remove("onb-target");
  tourTarget = target;
  if (target) target.classList.add("onb-target");
  card.innerHTML =
    `<div class="onb-dots">${steps.map((_, k) => `<i class="${k === i ? "on" : ""}"></i>`).join("")}</div>` +
    `<h3>${t(step.title)}</h3><p>${t(step.desc)}</p>` +
    `<div class="onb-actions">` +
      (i > 0 ? `<button class="btn text" data-tour="back">${t("Назад")}</button>`
             : `<button class="btn text" data-tour="skip">${t("Пропустить")}</button>`) +
      `<div class="spacer"></div>` +
      `<button class="btn filled" data-tour="next">${i < steps.length - 1 ? t("Дальше") : t("Готово")}</button>` +
    `</div>`;

  if (target) {
    const r = target.getBoundingClientRect();
    const pad = 6;
    spot.style.display = "block";
    spot.style.top = (r.top - pad) + "px";
    spot.style.left = (r.left - pad) + "px";
    spot.style.width = (r.width + pad * 2) + "px";
    spot.style.height = (r.height + pad * 2) + "px";
    card.classList.remove("center");
    positionTourCard(card, r);
  } else {
    spot.style.display = "none";
    card.classList.add("center");
    card.style.top = "";
    card.style.left = "";
  }
}

/** Карточка встаёт под целью, если влезает; иначе над ней; иначе по центру. */
function positionTourCard(card, rect) {
  card.style.visibility = "hidden";
  card.style.top = "0px";
  card.style.left = "0px";
  const cw = card.offsetWidth, ch = card.offsetHeight, margin = 14;
  const vw = innerWidth, vh = innerHeight;
  let top;
  if (rect.bottom + margin + ch <= vh) top = rect.bottom + margin;
  else if (rect.top - margin - ch >= 0) top = rect.top - margin - ch;
  else top = Math.max(margin, Math.min(vh - ch - margin, (vh - ch) / 2));
  const left = Math.max(margin, Math.min(vw - cw - margin, rect.left + rect.width / 2 - cw / 2));
  card.style.top = top + "px";
  card.style.left = left + "px";
  card.style.visibility = "";
}

/** Пересчёт при повороте экрана и изменении размера, пока тур открыт. */
function repositionTour() {
  if (!tourActive) return;
  const step = TOURS[tourName].steps[tourIndex];
  const target = step.target ? document.querySelector(step.target) : null;
  renderTourStep(step, target, tourIndex);
}

// Кнопки карточки живут в разметке, которую мы же и перерисовываем, поэтому
// слушаем один раз на контейнере, а не вешаем обработчики каждый раз заново.
byId("onbScrim").addEventListener("click", e => {
  const action = e.target.closest("[data-tour]")?.dataset.tour;
  if (action === "next") nextTourStep();
  else if (action === "back") prevTourStep();
  else if (action === "skip") endTour();
});

/** Знак вопроса — #tableHelpBtn/#libraryHelpBtn запускают свой тур заново;
 *  аргумент по умолчанию "table" — исторически первый тур этого файла,
 *  вызов без аргумента (если где-то остался) не должен ломаться. */
function openTour(name = "table") {
  startTour(name);
}
